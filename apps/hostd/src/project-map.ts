import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseHumanReviewPaths, redactSecrets, unreadableHumanReviewLines } from '@openadlc/shared';
import { withMirrorLock, type Worktrees } from './worktree.js';

/**
 * A generated summary of a managed repository's default branch — its areas and
 * packages, key ADRs and Human-review paths — kept at
 * `<workRoot>/maps/<owner>__<name>.md` and never committed
 * (docs/adr/0087-a-project-map-is-generated-by-hostd-from-its-mirror-and-kept-under-the-work-root.md).
 *
 * It is read from the tasks' own mirror with `ls-tree` and `cat-file`, never a
 * checkout: nothing of the repository runs, and no branch but the default one
 * is read, so only merged text — written by people with access — reaches it.
 */

const run = promisify(execFile);

/** Bumped when the layout changes, so every map is rebuilt once on the new format. */
export const PROJECT_MAP_FORMAT = 1;
const MARKER = `<!-- openadlc-project-map v${PROJECT_MAP_FORMAT} -->`;

/** A blob bigger than this is not read: a map wants a README's first paragraph, not a generated file. */
export const MAX_BLOB_BYTES = 256 * 1024;
export const MAX_AREAS = 200;
export const MAX_ADRS = 100;
const MAX_TEXT = 400;
const MAX_AREA_DEPTH = 3;

const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'] as const;
const SKIPPED_SEGMENTS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'fixtures', 'testdata', '__pycache__']);
const ADR_DIRS = ['docs/adr', 'docs/adrs', 'docs/decisions', 'doc/adr', 'adr'];
const ADR_FILE = /^(\d{4})-[^/]*\.md$/;
const ENTRY_FILES = ['src/main.ts', 'src/index.ts', 'src/main.tsx', 'index.ts', 'index.js', 'main.go', 'src/main.rs', 'src/lib.rs', '__main__.py'];

/** Sorted by UTF-16 code unit, never by locale, so two hosts write the same bytes. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function isReadme(name: string): boolean {
  return /^readme(\.md)?$/i.test(name);
}

function skippedPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.') || SKIPPED_SEGMENTS.has(segment));
}

/**
 * Text taken from a file, made safe to put in the map: no credential, no HTML
 * comment — so no `openadlc:` marker reaches the session context #380 builds
 * from it — one line, and at most 400 characters, cut at a sentence's end
 * where there is one.
 */
export function sanitise(text: string): string {
  let out = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Removing one opener can join the pieces of another: `<!<!---->--`.
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(/<!--|-->/g, '');
  }
  out = redactSecrets(out)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length <= MAX_TEXT) return out;
  const cut = out.slice(0, MAX_TEXT);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= MAX_TEXT / 4) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A path or name inside a code span: sanitised, and with no backtick to end the span early. */
function code(text: string): string {
  return `\`${sanitise(text).replace(/`/g, "'")}\``;
}

/** The first paragraph of a README that is prose: not a heading, a badge, HTML, a table, a fence or a rule. */
export function firstParagraph(markdown: string): string | null {
  for (const block of markdown.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const first = block.trim();
    if (!first) continue;
    if (/^(#|<|!\[|\[!\[|```|~~~|\||---|===|\*\*\*)/.test(first)) continue;
    const cleaned = sanitise(first);
    if (cleaned) return cleaned;
  }
  return null;
}

/** The value of `key = "…"` in a TOML table, read simply: enough for a manifest's name and description. */
function tomlValue(text: string, table: string, key: string): string | null {
  let inTable = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inTable = header[1]!.trim() === table;
      continue;
    }
    if (!inTable) continue;
    const pair = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(line);
    if (pair) return pair[1] ?? pair[2] ?? null;
  }
  return null;
}

interface Manifest {
  name: string | null;
  description: string | null;
  entry: string | null;
  testScript: string | null;
}

function readManifest(dir: string, blobs: ReadonlyMap<string, string>): Manifest {
  const at = (name: string): string | undefined => blobs.get(dir ? `${dir}/${name}` : name);
  const pkg = at('package.json');
  if (pkg !== undefined) {
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(pkg) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      // A manifest that does not parse names nothing; the path stands in.
    }
    const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
    let entry: string | null = null;
    const bin = parsed.bin;
    if (str(bin)) entry = str(bin);
    else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
      const first = Object.keys(bin).sort(byCodeUnit)[0];
      entry = first ? str((bin as Record<string, unknown>)[first]) : null;
    }
    entry ??= str(parsed.main);
    if (!entry) {
      const exports = parsed.exports;
      const dot = exports && typeof exports === 'object' && !Array.isArray(exports) ? (exports as Record<string, unknown>)['.'] : str(exports);
      if (str(dot)) entry = str(dot);
      else if (dot && typeof dot === 'object' && !Array.isArray(dot)) {
        const conditions = dot as Record<string, unknown>;
        entry = str(conditions.import) ?? str(conditions.default);
      }
    }
    const scripts = parsed.scripts;
    const testScript = scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? str((scripts as Record<string, unknown>).test) : null;
    return { name: str(parsed.name), description: str(parsed.description), entry: entry?.replace(/^\.\//, '') ?? null, testScript };
  }
  const pyproject = at('pyproject.toml');
  if (pyproject !== undefined) {
    return { name: tomlValue(pyproject, 'project', 'name'), description: tomlValue(pyproject, 'project', 'description'), entry: null, testScript: null };
  }
  const cargo = at('Cargo.toml');
  if (cargo !== undefined) {
    return { name: tomlValue(cargo, 'package', 'name'), description: tomlValue(cargo, 'package', 'description'), entry: null, testScript: null };
  }
  const gomod = at('go.mod');
  if (gomod !== undefined) {
    return { name: /^module\s+(\S+)/m.exec(gomod)?.[1] ?? null, description: null, entry: null, testScript: null };
  }
  return { name: null, description: null, entry: null, testScript: null };
}

/** The rows of AGENTS.md's tables: each backticked path in a row's first cell, with the row's second cell. */
export function agentsTablePaths(agents: string | null): Map<string, string> {
  const found = new Map<string, string>();
  if (!agents) return found;
  for (const raw of agents.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\||\|$/g, '').split('|');
    if (cells.length < 2) continue;
    const description = cells[1]!.trim();
    for (const match of cells[0]!.matchAll(/`([^`]+)`/g)) {
      const path = match[1]!.trim().replace(/^\.?\//, '').replace(/\/+$/, '');
      if (path && !found.has(path)) found.set(path, description);
    }
  }
  return found;
}

function isTestFile(relative: string): boolean {
  const name = basename(relative);
  if (/\.(test|spec)\.[^/]+$/.test(name) || /_test\.go$/.test(name) || /^test_.*\.py$/.test(name) || /_test\.py$/.test(name)) return true;
  return relative.split('/').slice(0, -1).some((segment) => segment === 'tests' || segment === '__tests__');
}

/** The ADR folder: the first candidate holding at least one `NNNN-*.md` directly in it. */
function adrDir(files: readonly string[]): string | null {
  for (const dir of ADR_DIRS) {
    if (files.some((file) => dirname(file) === dir && ADR_FILE.test(basename(file)))) return dir;
  }
  return null;
}

/**
 * The directories that are areas: up to three levels deep holding a manifest
 * or a README, and any AGENTS.md table names that exist in the tree.
 */
export function findAreas(files: readonly string[], agents: string | null): string[] {
  const areas = new Set<string>();
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); dir; dir = dirname(dir)) dirs.add(dir);
    const dir = dirname(file);
    if (!dir || dir.split('/').length > MAX_AREA_DEPTH || skippedPath(dir)) continue;
    const name = basename(file);
    if ((MANIFESTS as readonly string[]).includes(name) || isReadme(name)) areas.add(dir);
  }
  for (const path of agentsTablePaths(agents).keys()) {
    if (dirs.has(path) && !skippedPath(path)) areas.add(path);
  }
  return [...areas].sort(byCodeUnit);
}

/**
 * The blobs `renderProjectMap` reads, given the tree and AGENTS.md: the root
 * README and AGENTS.md, each area's manifests and README, and the ADRs. A
 * function of the tree, so the map reads nothing else.
 */
export function wantedBlobs(files: readonly string[], agents: string | null): string[] {
  const present = new Set(files);
  const wanted = new Set<string>();
  for (const file of files) if (!file.includes('/') && (isReadme(file) || file === 'AGENTS.md')) wanted.add(file);
  for (const area of findAreas(files, agents).slice(0, MAX_AREAS)) {
    for (const name of MANIFESTS) if (present.has(`${area}/${name}`)) wanted.add(`${area}/${name}`);
    const readme = readmeOf(files, area);
    if (readme) wanted.add(readme);
  }
  const adrs = adrDir(files);
  if (adrs) for (const file of files) if (dirname(file) === adrs && ADR_FILE.test(basename(file))) wanted.add(file);
  return [...wanted].sort(byCodeUnit);
}

/** An area's README: `README.md` before any other case, then a bare `README`. */
function readmeOf(files: readonly string[], dir: string): string | null {
  const candidates = files.filter((file) => dirname(file) === dir && isReadme(basename(file))).sort(byCodeUnit);
  return candidates.find((file) => basename(file) === 'README.md') ?? candidates.find((file) => /\.md$/i.test(file)) ?? candidates[0] ?? null;
}

export interface ProjectMapInput {
  repo: string;
  /** Every file path in the default branch's tree. */
  files: readonly string[];
  /** The text of the files `wantedBlobs` names, where they were read. */
  blobs: ReadonlyMap<string, string>;
}

/** The entry point an area's README names on its `**Entry point.**` line. */
function readmeEntry(readme: string | undefined): string | null {
  if (!readme) return null;
  const line = readme.split('\n').find((one) => one.includes('**Entry point.**'));
  const path = line ? /`([^`]+)`/.exec(line.slice(line.indexOf('**Entry point.**')))?.[1] : null;
  return path ? path.trim() : null;
}

/**
 * The map's body: every line a function of the tree and the blobs, so the same
 * commit always renders the same string. Pure.
 */
export function renderProjectMap(input: ProjectMapInput): string {
  const files = [...input.files].sort(byCodeUnit);
  const present = new Set(files);
  const agents = input.blobs.get('AGENTS.md') ?? null;
  const table = agentsTablePaths(agents);
  const out: string[] = [];

  const rootReadme = readmeOf(files, '');
  const intro = rootReadme ? firstParagraph(input.blobs.get(rootReadme) ?? '') : null;
  if (intro) out.push('## Repository', '', intro, '');

  out.push('## Areas and packages', '');
  const areas = findAreas(files, agents);
  // Each test file counts for the deepest area holding it, so a package
  // nested in another is not counted twice.
  const tests = new Map<string, number>();
  const byDepth = [...areas].sort((a, b) => b.length - a.length || byCodeUnit(a, b));
  for (const file of files) {
    const area = byDepth.find((dir) => file.startsWith(`${dir}/`));
    if (area && isTestFile(file.slice(area.length + 1))) tests.set(area, (tests.get(area) ?? 0) + 1);
  }
  if (areas.length === 0) out.push('No package or README was found below the root.', '');
  for (const area of areas.slice(0, MAX_AREAS)) {
    const manifest = readManifest(area, input.blobs);
    const readme = readmeOf(files, area);
    const readmeText = readme ? input.blobs.get(readme) : undefined;
    out.push(`### ${code(area)}${manifest.name ? ` — ${sanitise(manifest.name)}` : ''}`);
    const owns = [table.get(area), readmeText ? firstParagraph(readmeText) : null, manifest.description]
      .map((text) => (text ? sanitise(text) : ''))
      .find(Boolean);
    if (owns) out.push(`- Owns: ${owns}`);
    const entry = readmeEntry(readmeText) ?? manifest.entry ?? ENTRY_FILES.find((file) => present.has(`${area}/${file}`)) ?? null;
    if (entry) out.push(`- Entry point: ${code(entry)}`);
    const count = tests.get(area) ?? 0;
    const counted = count === 0 ? 'none found' : `${count} test file${count === 1 ? '' : 's'}`;
    out.push(`- Tests: ${manifest.testScript ? `${code(manifest.testScript)} · ` : ''}${counted}`);
    if (readme) out.push(`- README: ${code(readme)}`);
    out.push('');
  }
  if (areas.length > MAX_AREAS) out.push(`…and ${areas.length - MAX_AREAS} more`, '');

  const adrs = adrDir(files);
  if (adrs) {
    const all = files.filter((file) => dirname(file) === adrs && ADR_FILE.test(basename(file)));
    const line = (file: string): string => {
      const name = basename(file);
      const number = ADR_FILE.exec(name)![1]!;
      const heading = /^#\s+(.+)$/m.exec(input.blobs.get(file) ?? '')?.[1];
      const title = sanitise(heading ?? name.replace(/^\d{4}-/, '').replace(/\.md$/, '').replace(/-/g, ' ')) || number;
      return `- ${number} — ${title} (${code(file)})`;
    };
    out.push(`## Key ADRs (${code(adrs)})`, '');
    const named = new Set<string>();
    if (agents) {
      const escaped = adrs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of agents.matchAll(new RegExp(`${escaped}/(\\d{4}-[^\\s)\`'"<>]*?\\.md)`, 'g'))) {
        const file = `${adrs}/${match[1]}`;
        if (present.has(file)) named.add(file);
      }
    }
    if (named.size > 0) {
      out.push('Named in AGENTS.md:', '');
      for (const file of [...named].sort(byCodeUnit)) out.push(line(file));
      out.push('');
    }
    const newest = [...all].sort(byCodeUnit).reverse();
    out.push('All, newest first:', '');
    for (const file of newest.slice(0, MAX_ADRS)) out.push(line(file));
    if (newest.length > MAX_ADRS) out.push(`…and ${newest.length - MAX_ADRS} older in ${code(adrs)}`);
    out.push('');
  }

  if (agents !== null) {
    const rules = parseHumanReviewPaths(agents);
    const unreadable = unreadableHumanReviewLines(agents);
    if (rules) {
      out.push('## Human-review paths (from AGENTS.md on the default branch)', '');
      if (rules.length === 0) out.push('The section names no paths.');
      for (const rule of rules) out.push(`- ${code(rule.path)} — ${rule.logins.map((login) => `@${sanitise(login)}`).join(', ')}`);
      out.push('');
    } else if (unreadable[0]) {
      out.push('## Human-review paths (from AGENTS.md on the default branch)', '');
      out.push(`The Human review section could not be read: line ${unreadable[0].line}, ${code(unreadable[0].text)}: ${sanitise(unreadable[0].reason)}`, '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The whole file: a header with the commit and when it was built, then the body. */
export function composeProjectMap(input: { repo: string; commit: string; defaultBranch: string; builtAt: string; body: string }): string {
  return [MARKER, `# Project map: ${input.repo}`, '', `- Commit: ${input.commit} (default branch \`${input.defaultBranch}\`)`, `- Built at: ${input.builtAt}`, '', input.body].join('\n');
}

export interface ProjectMapHeader {
  format: number;
  repo: string;
  commit: string;
  defaultBranch: string;
  builtAt: string;
}

/** The header of a map file, or null for one that is not a map this code wrote. */
export function readProjectMapHeader(text: string): ProjectMapHeader | null {
  const lines = text.split('\n', 6);
  const format = /^<!-- openadlc-project-map v(\d+) -->$/.exec(lines[0] ?? '')?.[1];
  const repo = /^# Project map: (\S+)$/.exec(lines[1] ?? '')?.[1];
  const commit = /^- Commit: ([0-9a-f]{40}) \(default branch `([^`]+)`\)$/.exec(lines[3] ?? '');
  const builtAt = /^- Built at: (\S+)$/.exec(lines[4] ?? '')?.[1];
  if (!format || !repo || !commit || !builtAt) return null;
  return { format: Number(format), repo, commit: commit[1]!, defaultBranch: commit[2]!, builtAt };
}

export type ProjectMapState = 'written' | 'unchanged' | 'failed' | 'never';

/** What the bridge is told about one repository's map. */
export interface ProjectMapView {
  repo: string;
  path: string;
  commit: string | null;
  builtAt: string | null;
  state: ProjectMapState;
  error: string | null;
  triedAt: string | null;
}

export interface ProjectMapRefresh {
  repo: string;
  defaultBranch: string;
  bot: string;
  force?: boolean;
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const BOT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `owner/name`, and nothing that walks out of `maps/`. */
export function isProjectMapRepo(repo: string): boolean {
  const name = repo.split('/')[1];
  return REPO.test(repo) && name !== '.' && name !== '..';
}

/** A branch name git would take, and nothing that reads as an option or a range. */
function isBranch(branch: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.lock');
}

/** A refresh request from a route's body and path, or what is wrong with it. */
export function projectMapRefreshFrom(repo: string, body: Record<string, unknown>): ProjectMapRefresh | string {
  if (!isProjectMapRepo(repo)) return `${repo} is not a repository's owner/name`;
  if (typeof body.defaultBranch !== 'string' || !isBranch(body.defaultBranch)) return 'defaultBranch must be the repository’s default branch';
  if (typeof body.bot !== 'string' || !BOT.test(body.bot)) return 'bot must be the seat whose token fetches the repository';
  if (body.force !== undefined && typeof body.force !== 'boolean') return 'force must be true or false';
  return { repo, defaultBranch: body.defaultBranch, bot: body.bot, ...(body.force ? { force: true } : {}) };
}

export interface ProjectMapsDeps {
  workRoot: string;
  worktrees: Pick<Worktrees, 'ensureMirror' | 'mirrorPath'>;
  /** The repository's clone URL, as the host check reads it. */
  remote(repoFullName: string): string;
  /** The seat's token for fetching, or null where the remote needs none. */
  tokenFor(bot: string, repoFullName: string): Promise<string | null>;
  now?: () => Date;
  /** Moves the written tmp file over the map; a seam for the test of a failed write. */
  rename?: (from: string, to: string) => void;
}

/** git on the mirror, with nothing of the repository's own configuration able to run. */
async function git(mirror: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: mirror,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}

/** The blobs' contents, read in one `cat-file --batch`. */
function readBlobs(mirror: string, objects: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'], {
      cwd: mirror,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) return reject(new Error(redactSecrets(`git cat-file failed: ${stderr.trim() || `exit ${status}`}`)));
      const out = Buffer.concat(chunks);
      const found = new Map<string, string>();
      let at = 0;
      while (at < out.length) {
        const end = out.indexOf(0x0a, at);
        if (end < 0) break;
        const [object, type, size] = out.subarray(at, end).toString('utf8').split(' ');
        at = end + 1;
        if (type === 'missing' || !object || size === undefined) continue;
        const bytes = Number(size);
        found.set(object, out.subarray(at, at + bytes).toString('utf8'));
        at += bytes + 1;
      }
      resolve(found);
    });
    child.stdin.end(objects.map((object) => `${object}\n`).join(''));
  });
}

interface Attempt {
  state: Exclude<ProjectMapState, 'never'>;
  error: string | null;
  triedAt: string;
}

/**
 * Builds and keeps each managed repository's map. A failed build keeps the
 * previous file and is remembered here, until the next attempt, for the
 * bridge's health card; nothing is stored in a table.
 */
export class ProjectMaps {
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly deps: ProjectMapsDeps) {}

  private get dir(): string {
    return join(this.deps.workRoot, 'maps');
  }

  /** Where a repository's map is. */
  pathOf(repo: string): string {
    return join(this.dir, `${repo.replace('/', '__')}.md`);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private readExisting(path: string): string | null {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  async refresh(request: ProjectMapRefresh): Promise<ProjectMapView> {
    if (!isProjectMapRepo(request.repo)) throw new Error(`${request.repo} is not a repository's owner/name`);
    const file = this.pathOf(request.repo);
    const mirror = this.deps.worktrees.mirrorPath(request.repo);
    const triedAt = this.now().toISOString();
    return withMirrorLock(mirror, async () => {
      let tmp: string | null = null;
      try {
        this.clearTmp(file);
        const remote = this.deps.remote(request.repo);
        // Only an https remote takes a token (`gitAuthEnv`); a scripted
        // install's path needs none, and asks the token service for nothing.
        const token = remote.startsWith('https://') ? await this.deps.tokenFor(request.bot, request.repo) : null;
        await this.deps.worktrees.ensureMirror({
          bot: request.bot,
          taskId: 'project-map',
          repoFullName: request.repo,
          remote,
          baseRef: request.defaultBranch,
          branch: null,
          token,
        });
        const commit = (await git(mirror, ['rev-parse', '--verify', '--quiet', `refs/heads/${request.defaultBranch}^{commit}`])).trim();
        if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${request.repo} has no branch ${request.defaultBranch}`);

        const existing = this.readExisting(file);
        const header = existing ? readProjectMapHeader(existing) : null;
        const same = header && header.format === PROJECT_MAP_FORMAT && header.commit === commit && header.defaultBranch === request.defaultBranch;
        // An unforced pass trusts the header and reads no tree, so a change to
        // what renderProjectMap writes reaches existing maps only through a
        // PROJECT_MAP_FORMAT bump or the bridge's daily forced pass.
        if (same && !request.force) return this.settle(request.repo, { state: 'unchanged', error: null, triedAt });

        const body = renderProjectMap(await this.readTree(mirror, request.repo, commit));
        if (existing && header && same && composeProjectMap({ ...request, commit, builtAt: header.builtAt, body }) === existing) {
          return this.settle(request.repo, { state: 'unchanged', error: null, triedAt });
        }
        const text = composeProjectMap({ repo: request.repo, commit, defaultBranch: request.defaultBranch, builtAt: this.now().toISOString(), body });
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        chmodSync(this.dir, 0o700);
        tmp = `${file}.tmp-${process.pid}`;
        const fd = openSync(tmp, 'w', 0o600);
        try {
          writeSync(fd, text);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        (this.deps.rename ?? renameSync)(tmp, file);
        tmp = null;
        return this.settle(request.repo, { state: 'written', error: null, triedAt });
      } catch (error) {
        if (tmp) rmSync(tmp, { force: true });
        return this.settle(request.repo, { state: 'failed', error: redactSecrets(error instanceof Error ? error.message : String(error)), triedAt });
      }
    });
  }

  /** The tree at the commit, and the blobs the map is built from. */
  private async readTree(mirror: string, repo: string, commit: string): Promise<ProjectMapInput> {
    const listed = await git(mirror, ['ls-tree', '-r', '-z', '--long', commit]);
    const entries = new Map<string, { object: string; size: number }>();
    for (const record of listed.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, object, size] = record.slice(0, tab).split(/ +/);
      if (type !== 'blob' || !object) continue;
      const path = record.slice(tab + 1);
      // A path git can hold and Markdown cannot: left out rather than escaped.
      if (/[\u0000-\u001f\u007f]/.test(path)) continue;
      // A symbolic link's blob is its target, not text the map should read.
      entries.set(path, { object, size: mode === '120000' ? Number.POSITIVE_INFINITY : Number(size) });
    }
    const files = [...entries.keys()];
    const readable = (path: string): string | undefined => {
      const entry = entries.get(path);
      return entry && entry.size <= MAX_BLOB_BYTES ? entry.object : undefined;
    };
    const fetchBlobs = async (paths: string[]): Promise<Map<string, string>> => {
      const wanted = paths.map((path) => [path, readable(path)] as const).filter((pair): pair is readonly [string, string] => Boolean(pair[1]));
      const contents = await readBlobs(mirror, [...new Set(wanted.map(([, object]) => object))]);
      const blobs = new Map<string, string>();
      for (const [path, object] of wanted) {
        const text = contents.get(object);
        if (text !== undefined) blobs.set(path, text);
      }
      return blobs;
    };
    // AGENTS.md first: its tables name areas, which say which READMEs to read.
    const agents = (await fetchBlobs(['AGENTS.md'])).get('AGENTS.md') ?? null;
    const blobs = await fetchBlobs(wantedBlobs(files, agents));
    return { repo, files, blobs };
  }

  /** A tmp file a hostd stopped mid-write left beside this repository's map. */
  private clearTmp(file: string): void {
    const prefix = `${file.slice(this.dir.length + 1)}.tmp-`;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) if (name.startsWith(prefix)) rmSync(join(this.dir, name), { force: true });
  }

  private settle(repo: string, attempt: Attempt): ProjectMapView {
    this.attempts.set(repo, attempt);
    return this.view(repo);
  }

  private view(repo: string): ProjectMapView {
    const path = this.pathOf(repo);
    const existing = this.readExisting(path);
    const header = existing ? readProjectMapHeader(existing) : null;
    const attempt = this.attempts.get(repo);
    return {
      repo,
      path,
      commit: header?.commit ?? null,
      builtAt: header?.builtAt ?? null,
      state: attempt?.state ?? 'never',
      error: attempt?.error ?? null,
      triedAt: attempt?.triedAt ?? null,
    };
  }

  /**
   * One repository's map as it is on disk, whole, with its view; `content` is
   * null where there is none. The file is written by rename, so it is never
   * read half-written, and the mirror is not fetched: a read waits on nothing.
   */
  read(repo: string): { view: ProjectMapView; content: string | null } {
    if (!isProjectMapRepo(repo)) throw new Error(`${repo} is not a repository's owner/name`);
    return { view: this.view(repo), content: this.readExisting(this.pathOf(repo)) };
  }

  /** Every map on disk, and every repository whose only attempt since hostd started failed. */
  list(): ProjectMapView[] {
    const repos = new Set(this.attempts.keys());
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      // No map yet.
    }
    for (const name of names) {
      const match = /^([A-Za-z0-9-]+)__(.+)\.md$/.exec(name);
      const repo = match ? `${match[1]}/${match[2]}` : null;
      if (repo && isProjectMapRepo(repo)) repos.add(repo);
    }
    return [...repos].sort(byCodeUnit).map((repo) => this.view(repo));
  }

  /** Deletes the map of a repository OpenADLC no longer manages. */
  async remove(repo: string): Promise<boolean> {
    if (!isProjectMapRepo(repo)) throw new Error(`${repo} is not a repository's owner/name`);
    return withMirrorLock(this.deps.worktrees.mirrorPath(repo), async () => {
      const path = this.pathOf(repo);
      const existed = this.readExisting(path) !== null;
      rmSync(path, { force: true });
      this.clearTmp(path);
      this.attempts.delete(repo);
      return existed;
    });
  }
}
