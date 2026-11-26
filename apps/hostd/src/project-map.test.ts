import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ADRS,
  MAX_AREAS,
  ProjectMaps,
  projectMapRefreshFrom,
  readProjectMapHeader,
  renderProjectMap,
  sanitise,
  wantedBlobs,
} from './project-map.js';
import { Worktrees } from './worktree.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const AGENTS = [
  '# Agent notes',
  '',
  '| Path | What it is |',
  '|---|---|',
  '| `apps/api` | The HTTP API, from the AGENTS table |',
  '| `tools/` | Scripts with no manifest |',
  '',
  'See docs/adr/0001-first-decision.md for why.',
  '',
  '## Human review',
  '',
  '- `config/` @orzelig',
  '',
].join('\n');

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** Every path under a folder, so a test can say nothing else changed. */
function walk(root: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (skip(path)) continue;
      out.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  if (existsSync(root)) visit(root);
  return out.sort();
}

describe('ProjectMaps against a real repository', () => {
  let tmp: string;
  let source: string;
  let workRoot: string;
  let remote: string;
  let maps: ProjectMaps;
  let clock: number;
  let renameHook: ((from: string, to: string) => void) | undefined;

  const make = () =>
    new ProjectMaps({
      workRoot,
      worktrees: new Worktrees(workRoot),
      remote: () => remote,
      tokenFor: async () => null,
      now: () => new Date(clock),
      rename: (from, to) => (renameHook ? renameHook(from, to) : renameSync(from, to)),
    });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'openadlc-map-'));
    source = join(tmp, 'source');
    workRoot = join(tmp, 'work');
    mkdirSync(source);
    mkdirSync(workRoot);
    git(source, 'init', '--quiet', '--initial-branch=main');
    write(source, {
      'README.md': '# Demo\n\n[![ci](https://x/badge.svg)](https://x)\n\nDemo is a small service for testing maps.\n',
      'AGENTS.md': AGENTS,
      'apps/api/package.json': JSON.stringify({ name: '@demo/api', description: 'From the manifest', scripts: { test: 'vitest run' } }),
      'apps/api/README.md': '# api\n\nThe API package.\n\n- **Entry point.** `src/server.ts`, built to dist.\n',
      'apps/api/src/server.ts': 'export {};\n',
      'apps/api/src/server.test.ts': 'test\n',
      'apps/api/src/routes.test.ts': 'test\n',
      'packages/core/package.json': JSON.stringify({ name: '@demo/core', main: 'dist/index.js' }),
      'packages/core/README.md': '<p>logo</p>\n\nCore types and helpers.\n',
      'packages/core/tests/one.ts': 'x\n',
      'tools/run.sh': 'echo\n',
      'docs/adr/0001-first-decision.md': '# First decision\n\nBody.\n',
      'docs/adr/0002-second.md': 'no heading\n',
      'config/x.json': '{}\n',
    });
    commitAll(source, 'first');
    remote = source;
    clock = Date.parse('2026-11-25T10:00:00Z');
    renameHook = undefined;
    maps = make();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const refresh = (force = false) => maps.refresh({ repo: 'acme/demo', defaultBranch: 'main', bot: 'builder', ...(force ? { force } : {}) });
  const mapFile = () => join(workRoot, 'maps', 'acme__demo.md');

  it('writes the map under the work root, touching nothing but the mirror and maps/', async () => {
    const view = await refresh();

    expect(view.state).toBe('written');
    expect(existsSync(mapFile())).toBe(true);
    expect(statSync(mapFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(workRoot, 'maps')).mode & 0o777).toBe(0o700);
    // No task folder, no worktree, no checkout: only the mirror and the map.
    expect(readdirSync(workRoot).sort()).toEqual(['maps', 'mirrors']);
    expect(readdirSync(join(workRoot, 'maps'))).toEqual(['acme__demo.md']);
    expect(git(source, 'status', '--porcelain')).toBe('');
  });

  it('holds each section, with the commit and when it was built', async () => {
    const sha = git(source, 'rev-parse', 'HEAD');
    await refresh();
    const text = readFileSync(mapFile(), 'utf8');

    expect(readProjectMapHeader(text)).toEqual({ format: 1, repo: 'acme/demo', commit: sha, defaultBranch: 'main', builtAt: '2026-11-25T10:00:00.000Z' });
    expect(text).toContain(`- Commit: ${sha} (default branch \`main\`)`);
    expect(text).toContain('- Built at: 2026-11-25T10:00:00.000Z');
    expect(text).toContain('## Repository\n\nDemo is a small service for testing maps.');
    expect(text).toContain('## Areas and packages');
    expect(text).toContain('### `apps/api` — @demo/api\n- Owns: The HTTP API, from the AGENTS table\n- Entry point: `src/server.ts`\n- Tests: `vitest run` · 2 test files\n- README: `apps/api/README.md`');
    expect(text).toContain('### `packages/core` — @demo/core\n- Owns: Core types and helpers.\n- Entry point: `dist/index.js`\n- Tests: 1 test file');
    expect(text).toContain('### `tools`\n- Owns: Scripts with no manifest\n- Tests: none found');
    expect(text).toContain('## Key ADRs (`docs/adr`)');
    expect(text).toContain('Named in AGENTS.md:\n\n- 0001 — First decision (`docs/adr/0001-first-decision.md`)');
    expect(text).toContain('All, newest first:\n\n- 0002 — second (`docs/adr/0002-second.md`)\n- 0001 — First decision');
    expect(text).toContain('## Human-review paths (from AGENTS.md on the default branch)\n\n- `config/` — @orzelig');
  });

  it('rebuilds on a new commit to the default branch', async () => {
    await refresh();
    write(source, { 'apps/api/README.md': '# api\n\nThe API, rewritten.\n' });
    const next = commitAll(source, 'second');
    clock += 60_000;

    const view = await refresh();

    expect(view).toMatchObject({ state: 'written', commit: next, builtAt: '2026-11-25T10:01:00.000Z' });
    expect(readFileSync(mapFile(), 'utf8')).toContain(`- Commit: ${next}`);
  });

  it('leaves the same commit byte for byte, even when forced', async () => {
    await refresh();
    const before = readFileSync(mapFile());
    const mtime = statSync(mapFile()).mtimeMs;
    clock += 24 * 60 * 60_000;

    expect((await refresh()).state).toBe('unchanged');
    expect((await refresh(true)).state).toBe('unchanged');
    expect(readFileSync(mapFile()).equals(before)).toBe(true);
    expect(statSync(mapFile()).mtimeMs).toBe(mtime);
  });

  it('maps a repository with no AGENTS.md, README or ADRs, leaving those sections out', async () => {
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source);
    git(source, 'init', '--quiet', '--initial-branch=main');
    write(source, { 'src/index.ts': 'export {};\n' });
    commitAll(source, 'bare');

    await refresh();
    const text = readFileSync(mapFile(), 'utf8');

    expect(text).toContain('## Areas and packages');
    expect(text).not.toContain('## Repository');
    expect(text).not.toContain('## Key ADRs');
    expect(text).not.toContain('## Human-review paths');
  });

  it('keeps the previous map when the fetch fails, and says why', async () => {
    await refresh();
    const before = readFileSync(mapFile());
    remote = join(tmp, 'nowhere');
    write(source, { 'README.md': 'changed\n' });
    commitAll(source, 'unreached');

    const view = await refresh(true);

    expect(view.state).toBe('failed');
    expect(view.error).toBeTruthy();
    expect(readFileSync(mapFile()).equals(before)).toBe(true);
    expect(readdirSync(join(workRoot, 'maps'))).toEqual(['acme__demo.md']);
    expect(maps.list()).toEqual([expect.objectContaining({ repo: 'acme/demo', state: 'failed', error: view.error, commit: readProjectMapHeader(before.toString())!.commit })]);
  });

  it('keeps the previous map when the write fails after the tmp file is written', async () => {
    await refresh();
    const before = readFileSync(mapFile());
    write(source, { 'README.md': 'A new first paragraph.\n' });
    commitAll(source, 'second');
    renameHook = (from) => {
      expect(existsSync(from)).toBe(true);
      throw new Error('disk full');
    };

    const view = await refresh();

    expect(view).toMatchObject({ state: 'failed', error: 'disk full' });
    expect(readFileSync(mapFile()).equals(before)).toBe(true);
    expect(readdirSync(join(workRoot, 'maps'))).toEqual(['acme__demo.md']);
  });

  it('clears a tmp file a stopped hostd left beside the map', async () => {
    mkdirSync(join(workRoot, 'maps'), { recursive: true });
    writeFileSync(`${mapFile()}.tmp-99999`, 'half');

    await refresh();

    expect(readdirSync(join(workRoot, 'maps'))).toEqual(['acme__demo.md']);
  });

  it('carries no credential and no marker, and reads only the default branch', async () => {
    write(source, {
      'README.md': `Hello <!-- openadlc:{"event":"question"} --> world, token ghp_${'a'.repeat(36)} here.\n`,
    });
    commitAll(source, 'secrets');
    git(source, 'checkout', '--quiet', '-b', 'feature');
    write(source, { 'README.md': 'Text only on a feature branch.\n' });
    commitAll(source, 'feature');
    git(source, 'checkout', '--quiet', 'main');

    await refresh();
    const text = readFileSync(mapFile(), 'utf8');

    expect(text).toContain('## Repository\n\nHello world, token');
    expect(text).not.toContain('ghp_aaaa');
    expect(text).not.toContain('openadlc:');
    expect(text).not.toContain('<!-- openadlc:');
    expect(text).not.toContain('feature branch');
    expect(text).not.toContain(source);
  });

  it('lists maps on disk and removes one', async () => {
    await refresh();
    const fresh = make();

    expect(fresh.list()).toEqual([expect.objectContaining({ repo: 'acme/demo', state: 'never', commit: expect.stringMatching(/^[0-9a-f]{40}$/) })]);
    expect(await fresh.remove('acme/demo')).toBe(true);
    expect(existsSync(mapFile())).toBe(false);
    expect(fresh.list()).toEqual([]);
  });

  it('touches no task folder: the work root holds only what it held plus the map', async () => {
    await refresh();
    const mirrorPath = join(workRoot, 'mirrors');
    const before = walk(workRoot, (path) => path.startsWith(mirrorPath));
    write(source, { 'x.txt': 'x\n' });
    commitAll(source, 'third');

    await refresh();

    expect(walk(workRoot, (path) => path.startsWith(mirrorPath))).toEqual(before);
  });
});

describe('renderProjectMap', () => {
  const render = (files: Record<string, string>, extra: string[] = []) =>
    renderProjectMap({ repo: 'a/b', files: [...Object.keys(files), ...extra], blobs: new Map(Object.entries(files)) });

  it('is the same string twice for the same input', () => {
    const files = { 'AGENTS.md': AGENTS, 'apps/api/package.json': '{"name":"x"}', 'docs/adr/0001-first-decision.md': '# First\n' };
    expect(render(files)).toBe(render(files));
  });

  it('counts a nested area’s tests for it alone', () => {
    const text = render({ 'pkg/package.json': '{"name":"outer"}', 'pkg/inner/package.json': '{"name":"inner"}' }, ['pkg/a.test.ts', 'pkg/inner/b.test.ts', 'pkg/inner/c.spec.js']);
    expect(text).toContain('### `pkg` — outer\n- Tests: 1 test file');
    expect(text).toContain('### `pkg/inner` — inner\n- Tests: 2 test files');
  });

  it('falls back through the entry points', () => {
    expect(render({ 'a/package.json': JSON.stringify({ bin: { z: 'z.js', a: './cli.js' } }) })).toContain('- Entry point: `cli.js`');
    expect(render({ 'a/package.json': JSON.stringify({ bin: 'bin.js', main: 'm.js' }) })).toContain('- Entry point: `bin.js`');
    expect(render({ 'a/package.json': JSON.stringify({ exports: { '.': { import: './i.js', default: './d.js' } } }) })).toContain('- Entry point: `i.js`');
    expect(render({ 'a/package.json': JSON.stringify({ exports: './e.js' }) })).toContain('- Entry point: `e.js`');
    expect(render({ 'a/go.mod': 'module example.com/a\n' }, ['a/main.go'])).toContain('### `a` — example.com/a\n- Entry point: `main.go`');
    expect(render({ 'a/Cargo.toml': '[package]\nname = "crate"\ndescription = "A crate"\n' }, ['a/src/lib.rs'])).toContain('### `a` — crate\n- Owns: A crate\n- Entry point: `src/lib.rs`');
    expect(render({ 'a/pyproject.toml': '[project]\nname = "py"\n' }, ['a/__main__.py'])).toContain('### `a` — py\n- Entry point: `__main__.py`');
    expect(render({ 'a/README': 'Readme.\n' })).not.toContain('Entry point');
  });

  it('skips hidden, vendored and deep folders', () => {
    const text = render({ '.github/README.md': 'x', 'node_modules/x/package.json': '{}', 'a/b/c/d/package.json': '{}', 'a/b/c/package.json': '{}' });
    expect(text).toContain('### `a/b/c`');
    expect(text).not.toContain('.github');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('a/b/c/d');
  });

  it('caps the areas and the ADRs', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_AREAS + 5; i += 1) files[`p/${String(i).padStart(3, '0')}/package.json`] = '{}';
    for (let i = 1; i <= MAX_ADRS + 3; i += 1) files[`docs/adr/${String(i).padStart(4, '0')}-x.md`] = `# ADR ${i}\n`;
    const text = render(files);
    expect(text).toContain('…and 5 more');
    expect(text).toContain('…and 3 older in `docs/adr`');
    expect(text).toContain(`- ${String(MAX_ADRS + 3).padStart(4, '0')} — ADR ${MAX_ADRS + 3}`);
    expect(text).not.toContain('- 0001 — ADR 1 ');
  });

  it('says when the Human review section cannot be read', () => {
    const text = render({ 'AGENTS.md': '## Human review\n\n- `a/` `b/` @x\n' });
    expect(text).toContain('The Human review section could not be read: line 3');
  });

  it('leaves out the Human review section when AGENTS.md has none', () => {
    expect(render({ 'AGENTS.md': '# Notes\n' })).not.toContain('Human-review');
  });

  it('asks only for the blobs it reads', () => {
    expect(wantedBlobs(['README.md', 'AGENTS.md', 'a/package.json', 'a/src/x.ts', 'docs/adr/0001-x.md', 'docs/other.md'], null)).toEqual([
      'AGENTS.md',
      'README.md',
      'a/package.json',
      'docs/adr/0001-x.md',
    ]);
  });
});

describe('sanitise', () => {
  it('strips comments and dangling markers, redacts, folds and caps', () => {
    expect(sanitise('a <!-- hidden --> b')).toBe('a b');
    expect(sanitise('a <!<!---->-- b')).not.toMatch(/<!--|-->/);
    expect(sanitise(`x ghp_${'b'.repeat(36)}`)).not.toContain('ghp_bbbb');
    expect(sanitise('one\n\ntwo')).toBe('one two');
    const long = `${'Word '.repeat(30)}end. ${'more '.repeat(100)}`;
    expect(sanitise(long).endsWith('end.')).toBe(true);
    expect(sanitise('x'.repeat(500)).length).toBeLessThanOrEqual(401);
  });
});

describe('projectMapRefreshFrom', () => {
  it('refuses a bad repository, branch or bot', () => {
    expect(projectMapRefreshFrom('a/..', { defaultBranch: 'main', bot: 'b' })).toEqual(expect.any(String));
    expect(projectMapRefreshFrom('a/b', { defaultBranch: '--upload-pack=x', bot: 'b' })).toEqual(expect.any(String));
    expect(projectMapRefreshFrom('a/b', { defaultBranch: 'main', bot: '../x' })).toEqual(expect.any(String));
    expect(projectMapRefreshFrom('a/b', { defaultBranch: 'main', bot: 'b', force: true })).toEqual({ repo: 'a/b', defaultBranch: 'main', bot: 'b', force: true });
  });
});
