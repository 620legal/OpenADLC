import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ENGINE_PROVIDER, type AvailableModel } from '@fleetadlc/engines';
import type { SecretStore } from '@fleetadlc/github';
import {
  DEFAULT_MIN_RELEASE_AGE_DAYS,
  ENGINE_PACKAGES,
  SYSTEM_TOOLS,
  type AccountCheck,
  type EngineCli,
  type EngineName,
  type EngineUpdateCheck,
  type EngineUpdateResult,
  type EngineUpdateStart,
  type EngineUpdateStatus,
  type EngineVersions,
} from '@fleetadlc/shared';
import { containerBaseEnv, CONTAINER_TOOL_DIRS } from './drivers/base-env.js';
import { probeNetworkArgs } from './drivers/docker.js';
import type { ObservedSession } from './drivers/types.js';
import { ensureLoginDir, hasLogin, lastWords, type LoginAccount, type PresentedCredential } from './logins.js';
import type { SessionModel, TaskModelAccount } from './model-resolution.js';
import { keyEnv } from './key-env.js';
import { readEngineCredential, type EngineCredential, type LoginLocator } from './session-env.js';
import { taskModelChooser } from './task-runner.js';

/**
 * The engine CLIs, kept current once a week without anybody bumping a pin.
 *
 * The bot image pins `claude`, `codex` and `grok` for a reason
 * `build-bot-image.sh` states: a bot whose engine changed under it is a change
 * nobody made and nobody can bisect. The cost of the pins showed on the day a
 * new model arrived — "Newest Opus" moved to an id Claude Code 2.1.278
 * refused ("version 2.1.280 or newer is required"), and every bot on that
 * family failed until a person rebuilt the image.
 *
 * So the update is automatic and still a change somebody can see: recorded,
 * proved before it takes effect, and reversible.
 *
 * 1. Which versions the image carries now: its `fleetadlc.engines` label, which
 *    the build script stamps, or — for an image built before the label — each
 *    CLI's own `--version`, asked in a throwaway container.
 * 2. Which versions npm calls newest, and of those the newest that has been
 *    published for the install's minimum release age (`newestOldEnough`).
 *    None newer that is old enough: the run is `current`.
 * 3. A candidate, built by the same script under the `candidate` tag.
 * 4. The candidate proved the way a task uses it: each CLI resolves on the
 *    PATH a session gets and says the version it was built with, and every
 *    model the crew is assigned is called once, from the candidate, with the
 *    credential a task on it would present. Any failure discards it.
 * 5. The swap: the image in use becomes `previous`, the candidate `latest`.
 *    A task's computer is made from the image when the task starts, so the
 *    next task runs on it and a running one finishes on the image it started
 *    with; warm computers on the old image are drained, and images nothing
 *    uses any more are pruned (`DockerDriver.refreshComputers`).
 *
 * One run at a time: asking again while one runs joins it. Rolling back swaps
 * `previous` and `latest`, so it can be undone the same way.
 */

/** The label `build-bot-image.sh` stamps: package → version, as JSON. */
export const ENGINES_LABEL = 'fleetadlc.engines';

const CLIS = Object.keys(ENGINE_PACKAGES) as EngineCli[];
const PACKAGES: string[] = CLIS.map((cli) => ENGINE_PACKAGES[cli]);
/** `node` and `gh` live in the same label as the engines, and are probed with them. */
const IMAGE_TOOLS = ['node', 'gh'] as const;
type ImageTool = EngineCli | (typeof IMAGE_TOOLS)[number];

/** Which command each engine runs, for the ones that run one. */
const ENGINE_CLI: Partial<Record<EngineName, EngineCli>> = { claude: 'claude', codex: 'codex', grok: 'grok' };

// ------------------------------------------------------------------ versions

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** The first version in what a CLI or npm printed: `codex-cli 0.155.1` is `0.155.1`. */
export function parseVersion(text: string): string | null {
  return VERSION.exec(text)?.[0] ?? null;
}

function versionParts(version: string): { main: number[]; pre: string[] } {
  const dash = version.indexOf('-');
  const core = dash < 0 ? version : version.slice(0, dash);
  const pre = dash < 0 ? '' : version.slice(dash + 1);
  return { main: core.split('.').map((part) => Number(part)), pre: pre ? pre.split('.') : [] };
}

/**
 * Semver order: negative when `a` is older. A prerelease is older than its
 * release, and prerelease identifiers compare as semver says — numbers by
 * value, below words, which compare as text.
 */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.main[index] ?? 0) - (right.main[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return Math.sign(difference);
      continue;
    }
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `npm view <pkg> dist-tags time --json` printed, or null when it is not JSON. */
function npmView(stdout: string): { 'dist-tags'?: { latest?: unknown }; time?: unknown } | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as { 'dist-tags'?: { latest?: unknown }; time?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * The newest release npm has had for at least `minAgeDays`: not a
 * prerelease, no newer than `dist-tags.latest`, and published at least that
 * long before `now`. `times` is npm's `time`, which also holds `created` and
 * `modified`. 0 days is `latest` itself, as the update took before. Null when
 * no version is old enough.
 */
export function newestOldEnough(times: Record<string, string>, latestTag: string, minAgeDays: number, now: Date): string | null {
  if (minAgeDays <= 0) return latestTag;
  const cutoff = now.getTime() - minAgeDays * DAY_MS;
  let best: string | null = null;
  for (const [version, published] of Object.entries(times)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (compareVersions(version, latestTag) > 0) continue;
    const at = Date.parse(published);
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (!best || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** The versions an image's label says it carries, or null when it has none worth reading. */
export function readEnginesLabel(labels: Record<string, string> | null | undefined): EngineVersions | null {
  const raw = labels?.[ENGINES_LABEL];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const versions: EngineVersions = {};
  let found = false;
  for (const pkg of PACKAGES) {
    const value = (parsed as Record<string, unknown>)[pkg];
    const version = typeof value === 'string' ? parseVersion(value) : null;
    versions[pkg] = version && version === value ? version : null;
    found ||= versions[pkg] !== null;
  }
  // Node and gh are stamped beside the engines. An image built before that
  // has neither key; leaving them out is not the same as a version of null,
  // which for an engine means "could not be told, so take the newest".
  for (const pkg of IMAGE_TOOLS) {
    const value = (parsed as Record<string, unknown>)[pkg];
    const version = typeof value === 'string' ? parseVersion(value) : null;
    if (version && version === value) {
      versions[pkg] = version;
      found = true;
    }
  }
  return found ? versions : null;
}

export interface UpdatePlan {
  /** Whether any CLI has a version newer than the one in use. */
  newer: boolean;
  /** What a candidate pins, per package: the newer version where there is one, the one in use otherwise. */
  targets: Record<string, string>;
  changes: { pkg: string; from: string | null; to: string }[];
  /** A newest version a rollback undid, and so is not taken again. */
  held: { pkg: string; version: string }[];
  /** A pin held a newer version. Reported, not taken, and not a downgrade. */
  pinned: { pkg: string; installed: string; latest: string }[];
}

/** Which tools a run may move. Absent `only` is the three engine CLIs, as a run used to be. */
export interface UpdateSelection {
  /**
   * Package keys that may change. Anything else stays at the version in use.
   * An empty list changes nothing — a schedule whose only due tool is pinned
   * still asks what is newest, and builds nothing.
   */
  only?: readonly string[];
  /** Versions a pin holds. A newer one is reported and not applied. */
  pins?: EngineVersions;
}

/**
 * The update decision. A package takes npm's newest when it is newer than the
 * one in use, or when the version in use could not be told — except the one
 * version a rollback undid, which stays undone until something newer ships.
 * Nothing is ever downgraded: an image ahead of npm's `latest` keeps what it
 * has.
 */
export function planUpdate(
  inUse: EngineVersions,
  latest: Record<string, string>,
  hold: EngineVersions = {},
  selection: UpdateSelection = {},
): UpdatePlan {
  const targets: Record<string, string> = {};
  const changes: UpdatePlan['changes'] = [];
  const held: UpdatePlan['held'] = [];
  const pinned: UpdatePlan['pinned'] = [];
  const keys = selection.only ?? PACKAGES;

  for (const pkg of keys) {
    // Node and gh are left out of a label from before they were stamped. That
    // is not a version of null, which for an engine means the version could
    // not be read, so the newest is taken. An absent tool is left as it is.
    if (!PACKAGES.includes(pkg) && !Object.hasOwn(inUse, pkg)) continue;
    const current = inUse[pkg] ?? null;
    const newest = latest[pkg] ?? null;
    if (!newest) {
      if (current) targets[pkg] = current;
      continue;
    }
    const isNewer = current === null || compareVersions(newest, current) > 0;
    // A pinned tool stays at the version in use: a newer release is reported in
    // `pinned` and not taken, and the pin's value never pulls the image back.
    if (isNewer && current !== null && selection.pins?.[pkg]) {
      pinned.push({ pkg, installed: current, latest: newest });
      targets[pkg] = current;
      continue;
    }
    if (isNewer && current !== null && hold[pkg] === newest) {
      held.push({ pkg, version: newest });
      targets[pkg] = current;
      continue;
    }
    if (isNewer) {
      targets[pkg] = newest;
      changes.push({ pkg, from: current, to: newest });
      continue;
    }
    targets[pkg] = current;
  }

  // Tools this run is not changing stay at the version the running image has,
  // so the candidate is not a rebuild that floats them to whatever is newest today.
  for (const pkg of [...PACKAGES, ...IMAGE_TOOLS]) {
    if (keys.includes(pkg) || targets[pkg]) continue;
    const current = inUse[pkg];
    if (current) targets[pkg] = current;
  }

  return { newer: changes.length > 0, targets, changes, held, pinned };
}

/**
 * What a run asks a registry for. No `only` and no pins is the three engines,
 * which is what a run asked before tools could be chosen. A pin is asked so
 * the newer version can be reported, and is not in the list of what may change
 * unless it was also named there.
 */
function packagesToAsk(selection: UpdateSelection): string[] {
  if (selection.only === undefined && !selection.pins) return [...PACKAGES];
  const wanted = new Set([...(selection.only ?? []), ...Object.keys(selection.pins ?? {})]);
  return [...PACKAGES, ...IMAGE_TOOLS].filter((pkg) => wanted.has(pkg));
}

/**
 * What a run with nothing newer found says it checked. A run for Node or gh
 * alone said every engine was the newest, when no engine had been asked about.
 */
function alreadyNewest(asked: readonly string[]): string {
  if (asked.length === 0) return 'the run named no tool, so nothing was checked';
  if (asked.length === PACKAGES.length && PACKAGES.every((pkg) => asked.includes(pkg))) return 'every engine is already the newest version';
  return `${asked.map(shortName).join(', ')} ${asked.length === 1 ? 'is' : 'are'} already the newest version`;
}

/** `@openai/codex` is `codex`, `@anthropic-ai/claude-code` is `claude-code`: what a person calls them. */
export function shortName(pkg: string): string {
  return pkg.slice(pkg.lastIndexOf('/') + 1);
}

/** `codex 0.155.1 → 0.156.1; grok 1.0.41 → 1.0.42`. */
export function describeChanges(from: EngineVersions, to: EngineVersions): string {
  const order = [...PACKAGES, ...IMAGE_TOOLS];
  const lines = order
    .filter((pkg) => (from[pkg] ?? null) !== (to[pkg] ?? null))
    .map((pkg) => `${shortName(pkg)} ${from[pkg] ?? 'unknown'} → ${to[pkg] ?? 'unknown'}`);
  return lines.join('; ');
}

/**
 * The newest stable Node of the major already in the image. The index is
 * newest first, and the first stable entry is Current: Node 25 and later
 * ship no corepack, and `corepack enable` in the bot image then fails, so
 * every Node update fails with it. No version in use yet: an LTS line, which
 * is what a fresh image's `NODE_MAJOR` is.
 */
export function newestNodeVersion(body: string, installed?: string | null): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const stable: { version: string; major: number; lts: boolean }[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || !('version' in entry)) continue;
    const version = String((entry as { version: unknown }).version).replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const major = Number(version.split('.')[0]);
    const lts = 'lts' in entry && Boolean((entry as { lts: unknown }).lts);
    stable.push({ version, major, lts });
  }
  const wanted = installed?.split('.')[0];
  const major = wanted && /^\d+$/.test(wanted) ? Number(wanted) : null;
  if (major !== null) return stable.find((one) => one.major === major)?.version ?? null;
  return stable.find((one) => one.lts)?.version ?? null;
}

/**
 * The newest `gh` in the apt repository's package index for one architecture.
 *
 * That repository is where the bot image installs gh from, and it lists only
 * its newest package: `apt-get install gh=<version>` finds nothing else. So
 * the newest is read from the same index rather than from GitHub's releases,
 * which can name a release the repository has not published yet — a candidate
 * pinned to it would fail to build.
 */
export function newestGhVersion(packages: string): string | null {
  let newest: string | null = null;
  for (const stanza of packages.split(/\n\s*\n/)) {
    if (!/^Package:\s*gh\s*$/m.test(stanza)) continue;
    const said = /^Version:\s*(\S+)\s*$/m.exec(stanza)?.[1] ?? '';
    const version = parseVersion(said);
    if (!version || version !== said) continue;
    if (!newest || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

/** Debian's name for the architecture hostd, and so the bot image it builds, runs on. */
export function debianArch(arch: string = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch;
}

/** The gh apt repository's package index, which `newestGhVersion` reads. */
export function ghPackagesUrl(arch: string = process.arch): string {
  return `https://cli.github.com/packages/dists/stable/main/binary-${debianArch(arch)}/Packages`;
}

/**
 * The three tags an update moves, from the image the bots run. Only a
 * `:latest` image is this install's to move — one pinned to another tag or a
 * digest was built somewhere else, and that is where it is updated.
 */
export function imageTags(image: string): { latest: string; candidate: string; previous: string } | null {
  if (image.includes('@')) return null;
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  const tagged = colon > slash;
  const repo = tagged ? image.slice(0, colon) : image;
  const tag = tagged ? image.slice(colon + 1) : 'latest';
  if (!repo || tag !== 'latest') return null;
  return { latest: `${repo}:latest`, candidate: `${repo}:candidate`, previous: `${repo}:previous` };
}

// ------------------------------------------------------------------ processes

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { env?: Record<string, string>; cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

/** How much of a command's output is kept, from the end: a build's log runs to megabytes. */
const KEPT = 256 * 1024;

/**
 * Runs a command and keeps the end of what it says. Never throws: a command
 * that could not start, or ran out of time, is a result like any other.
 */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? (process.env as Record<string, string>),
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-KEPT);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-KEPT);
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : null;
    timer?.unref?.();
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${command} could not be started: ${error.message}\n` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const said = timedOut ? `${stderr}${command} did not finish within ${Math.round((options.timeoutMs ?? 0) / 1000)} s\n` : stderr;
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr: said });
    });
  });

// ------------------------------------------------------------------ the crew

export interface CrewBot {
  name: string;
  engine: EngineName;
  model: string;
  modelAccountId: string | null;
  sidecarDb: boolean;
  /** The seat's computer size; absent leaves a container's own. */
  cpus?: number;
  memoryGb?: number;
}

export interface AccountRow {
  id: string;
  provider: LoginAccount['provider'];
  kind: LoginAccount['kind'];
  label: string;
}

/** How a task's credential is handed to a candidate's CLI — or why there is nothing to hand it. */
export type CandidateCredential = { presented: PresentedCredential } | { skip: string } | { refuse: string };

const PROVIDER_ARTICLE: Record<string, string> = { anthropic: 'an Anthropic', openai: 'an OpenAI', xai: 'an xAI' };

/**
 * The credential `session-env.ts` would put in a task's environment, in the
 * form a throwaway container takes it: a key or token valued only in the
 * docker client's environment, a subscription's login mounted where a bot has
 * it. A bot with nothing stored is skipped — no task on it can call a model
 * with either image, so it proves nothing about this one — and one whose own
 * key is another provider's is refused, as its task would be.
 */
export function presentCredential(found: EngineCredential, loginRoot: string): CandidateCredential {
  if (found.foreignKey) {
    return { refuse: `its own key is ${PROVIDER_ARTICLE[found.foreignKey] ?? 'another provider’s'} key, so a task on it refuses to start` };
  }
  if (found.login && found.accountId) {
    if (!hasLogin(loginRoot, found.accountId)) return { skip: 'the subscription is not signed in' };
    return {
      presented: {
        env: { [found.login.envVar]: found.login.path },
        mount: ensureLoginDir(loginRoot, found.accountId),
        secret: null,
      },
    };
  }
  if (found.envVar && found.key) {
    return { presented: { env: keyEnv(found.envVar, found.key), mount: null, secret: found.key } };
  }
  return { skip: 'no credential is stored for it' };
}

/** `presentCredential` over what a task on this bot would read, from the store a task reads. */
export function candidateCredential(input: {
  store: SecretStore;
  loginRoot: string;
  locate: LoginLocator;
}): (bot: CrewBot, account: TaskModelAccount | null) => Promise<CandidateCredential> {
  return async (bot, account) =>
    presentCredential(
      await readEngineCredential({ bot: bot.name, engine: bot.engine, account }, input.store, undefined, input.locate),
      input.loginRoot,
    );
}

/**
 * How a task would resolve its model if it ran on `image`: the task runner's
 * own decision, with an xAI seat's list asked of that image's grok, once per
 * seat per run. A chooser per run, so nothing a candidate listed outlives it.
 */
export function candidateModels(
  modelsIn: (accountId: string, image: string, name: string) => Promise<AvailableModel[]>,
  containerPrefix: string,
): (image: string) => (bot: CrewBot) => Promise<SessionModel> {
  return (image) => {
    const listed = new Map<string, Promise<AvailableModel[]>>();
    return taskModelChooser({
      cliModels: (accountId) => {
        let list = listed.get(accountId);
        if (!list) {
          list = modelsIn(accountId, image, `${containerPrefix}-models`);
          listed.set(accountId, list);
        }
        return list;
      },
    });
  };
}


/**
 * Whether a candidate keeps the gh the bots run now. It does when the running
 * image's gh is known and the plan leaves it where it is: that binary is
 * copied across, which needs no network and cannot drift from the version the
 * label says.
 */
export function keptGh(inUse: EngineVersions, plan: Pick<UpdatePlan, 'targets' | 'changes'>): boolean {
  const current = inUse.gh ?? null;
  return current !== null && plan.targets.gh === current && !plan.changes.some((change) => change.pkg === 'gh');
}

// ------------------------------------------------------------------ the updater

/** A request hostd will not act on, with the status the route answers. */
export class EngineUpdateRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EngineUpdateRefused';
  }
}

export interface EngineUpdaterOptions {
  driver: 'docker' | 'local';
  /** The image every bot runs, `fleetadlc-bot:latest`. Its repository names the candidate and the previous image. */
  image: string;
  /** `infra/local/build-bot-image.sh`, which builds the candidate exactly as a person would. */
  buildScript: string;
  /**
   * The proxy the build's steps leave through, as the bots see it
   * (`http://host.docker.internal:3128`), handed to the script as
   * `BUILD_PROXY`. Unset locally. On the cloud host a build step is a
   * container like any other, and the firewall refuses it everything else.
   */
  buildProxy?: string;
  /** Names every throwaway container a run makes. */
  containerPrefix?: string;
  /** Runs docker, npm and the build script. A test answers for all three. */
  run?: CommandRunner;
  crew: () => Promise<CrewBot[]>;
  account: (id: string) => Promise<AccountRow | null>;
  /** How a task would resolve its model on this image; see `candidateModels`. */
  chooseModelFor: (image: string) => (bot: CrewBot) => Promise<SessionModel>;
  /** The credential a task on this bot would present; see `candidateCredential`. */
  credential: (bot: CrewBot, account: TaskModelAccount | null) => Promise<CandidateCredential>;
  /** One real call, judged: `LoginService.callModel`. */
  callModel: (input: {
    provider: LoginAccount['provider'];
    model: string;
    image: string;
    name: string;
    credential: PresentedCredential;
    env?: Record<string, string>;
  }) => Promise<AccountCheck>;
  /** Drains what still runs the old image and nothing needs; see `DockerDriver.refreshComputers`. */
  refresh: () => Promise<{ refreshed: string[]; deferred: string[] }>;
  now?: () => Date;
  /** How long a candidate may take to build. The npm layer alone is minutes. */
  buildTimeoutMs?: number;
  log?: (line: string) => void;
}

interface InUse {
  versions: EngineVersions;
  source: 'label' | 'cli' | 'none';
  id: string | null;
}

/** What the CLIs in an image say for themselves, under a session's PATH. */
interface Probed {
  path: string | null;
  said: string;
  version: string | null;
}

const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
/** What the build is given only when the run has a value for it; never hostd's own. */
const BUILD_PINS = ['NODE_VERSION', 'GH_VERSION', 'GH_FROM', 'BUILD_PROXY'] as const;

export class EngineUpdater {
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  private readonly prefix: string;
  private readonly log: (line: string) => void;
  private current: { startedAt: string; trigger: string; done: Promise<EngineUpdateResult> } | null = null;
  private rolling: Promise<EngineUpdateResult> | null = null;
  private last: EngineUpdateResult | null = null;
  /** What an unlabelled image's CLIs said, per image id: an image does not change under its id. */
  private readonly probed = new Map<string, Promise<InUse>>();

  constructor(private readonly options: EngineUpdaterOptions) {
    this.run = options.run ?? runCommand;
    this.now = options.now ?? (() => new Date());
    this.prefix = options.containerPrefix ?? 'fleetadlc-engines';
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Why this hostd cannot update the bot image, or null when it can. */
  private cannotUpdate(): string | null {
    if (this.options.driver === 'local') return 'not applicable: the local driver runs the host’s own CLIs';
    if (!imageTags(this.options.image)) {
      return `the bots run ${this.options.image}, which is pinned to a tag this install does not build — update it where it is built`;
    }
    if (!existsSync(this.options.buildScript)) {
      return `this hostd cannot build the bot image: ${this.options.buildScript} is not here`;
    }
    return null;
  }

  async status(): Promise<EngineUpdateStatus> {
    const reason = this.cannotUpdate();
    const running = this.current ? { startedAt: this.current.startedAt, trigger: this.current.trigger } : null;
    const base = {
      driver: this.options.driver,
      applicable: reason === null,
      reason: reason ?? '',
      image: this.options.image,
      running,
      last: this.last,
    };
    if (this.options.driver === 'local') return { ...base, inUse: {}, inUseSource: 'none', previous: null };

    const tags = imageTags(this.options.image);
    // A status that cannot say what an image carries still says the rest.
    const unknown: InUse = { versions: {}, source: 'none', id: null };
    const inUse = await this.versionsOf(tags?.latest ?? this.options.image).catch(() => unknown);
    const previous = tags ? await this.versionsOf(tags.previous).catch(() => unknown) : null;
    return {
      ...base,
      inUse: inUse.versions,
      inUseSource: inUse.source,
      previous: previous && previous.id ? previous.versions : null,
    };
  }

  /**
   * Starts a run, or joins the one already going, and answers at once: a
   * build takes minutes, longer than a caller should hold a request open, so
   * the caller follows `status()` for the result. A hostd that cannot update
   * answers with that straight away, as the run's result.
   */
  update(input: {
    trigger: string;
    requestedBy?: string | null;
    hold?: EngineVersions;
    /** Package keys that may change. Absent: the three engine CLIs. */
    only?: readonly string[];
    /** Versions a pin holds. A schedule passes these; an explicit update does not. */
    pins?: EngineVersions;
    /** Days an engine CLI release must have been on npm; `DEFAULT_MIN_RELEASE_AGE_DAYS` when absent. */
    minReleaseAgeDays?: number;
  }): EngineUpdateStart {
    if (this.current) return { running: true, startedAt: this.current.startedAt, joined: true, last: null };
    if (this.rolling) throw new EngineUpdateRefused(409, 'a rollback is running; update once it has finished');

    const startedAt = this.now().toISOString();
    const base = { trigger: input.trigger, requestedBy: input.requestedBy ?? null, startedAt };
    const reason = this.cannotUpdate();
    if (reason) {
      const result = this.result(base, { state: 'skipped', from: {}, to: null, latest: null, checks: [], reason });
      this.last = result;
      return { running: false, startedAt, joined: false, last: result };
    }

    const done = this.execute(base, input.hold ?? {}, { only: input.only, pins: input.pins }, input.minReleaseAgeDays ?? DEFAULT_MIN_RELEASE_AGE_DAYS)
      .catch((error: unknown) =>
        this.result(base, {
          state: 'failed',
          from: {},
          to: null,
          latest: null,
          checks: [],
          reason: `the update stopped: ${error instanceof Error ? error.message : String(error)}`,
        }),
      )
      .then((result) => {
        // Before `current` is cleared, so nobody sees the run over with a
        // result that is not its own.
        this.last = result;
        this.log(`[hostd] engine update ${result.state}: ${result.reason}`);
        return result;
      })
      .finally(() => {
        this.current = null;
      });
    this.current = { startedAt, trigger: input.trigger, done };
    return { running: true, startedAt, joined: false, last: null };
  }

  /** `update`, waited for. Kept for the tests: hostd's routes call `update` and read `status`. */
  async updateAndWait(input: {
    trigger: string;
    requestedBy?: string | null;
    hold?: EngineVersions;
    only?: readonly string[];
    pins?: EngineVersions;
    minReleaseAgeDays?: number;
  }): Promise<EngineUpdateResult> {
    const started = this.update(input);
    if (!started.running) return started.last as EngineUpdateResult;
    return (this.current?.done ?? Promise.resolve(this.last)) as Promise<EngineUpdateResult>;
  }

  private result(
    base: { trigger: string; requestedBy: string | null; startedAt: string },
    outcome: Pick<EngineUpdateResult, 'state' | 'from' | 'to' | 'latest' | 'checks' | 'reason'> &
      Partial<Pick<EngineUpdateResult, 'refreshed' | 'deferred'>>,
  ): EngineUpdateResult {
    return { ...base, ...outcome, finishedAt: this.now().toISOString() };
  }

  private async execute(
    base: { trigger: string; requestedBy: string | null; startedAt: string },
    hold: EngineVersions,
    selection: UpdateSelection = {},
    minReleaseAgeDays: number = DEFAULT_MIN_RELEASE_AGE_DAYS,
  ): Promise<EngineUpdateResult> {
    const tags = imageTags(this.options.image);
    if (!tags) throw new Error(`${this.options.image} is not an image this install builds`);

    const inUse = await this.versionsOf(tags.latest);
    const from = inUse.versions;
    const ask = packagesToAsk(selection);

    // Two answers per package: what npm calls newest, which the result reports
    // so Settings shows a newer version is out, and what is old enough to
    // take, which is all the plan, and a rollback's hold, ever see.
    const latest: Record<string, string> = {};
    const eligible: Record<string, string> = {};
    const tooYoung: { pkg: string; version: string; published: string }[] = [];
    for (const pkg of ask) {
      const found = await this.newest(pkg, from[pkg] ?? null, minReleaseAgeDays);
      if (!found.version) {
        return this.result(base, {
          state: 'failed',
          from,
          to: null,
          latest: null,
          checks: [],
          reason: found.reason,
        });
      }
      latest[pkg] = found.version;
      if (found.eligible) eligible[pkg] = found.eligible;
      if (found.eligible !== found.version && found.published) tooYoung.push({ pkg, version: found.version, published: found.published });
    }

    const plan = planUpdate(from, eligible, hold, selection);
    if (!plan.newer) {
      const waiting = tooYoung
        .filter((one) => {
          const inUse = from[one.pkg] ?? null;
          return inUse === null || compareVersions(one.version, inUse) > 0;
        })
        .map((one) => {
          const after = new Date(Date.parse(one.published) + minReleaseAgeDays * DAY_MS);
          return `${shortName(one.pkg)} ${one.version} was published ${one.published.slice(0, 10)}, and is taken once it is ${minReleaseAgeDays} day${minReleaseAgeDays === 1 ? '' : 's'} old (${after.toISOString().slice(0, 10)})`;
        })
        .join('; ');
      const holding = plan.held.map((one) => `${shortName(one.pkg)} ${one.version}`).join(', ');
      const pinned = plan.pinned
        .map((one) => `${shortName(one.pkg)} is pinned at ${one.installed}; newest is ${one.latest}`)
        .join('; ');
      return this.result(base, {
        state: 'current',
        from,
        to: null,
        latest,
        checks: [],
        reason: holding
          ? `nothing newer to take: ${holding} is held back after a rollback`
          : pinned
            ? `nothing newer to take: ${pinned}`
            : waiting
              ? `nothing old enough to take: ${waiting}`
              : alreadyNewest(ask),
      });
    }

    const to: EngineVersions = { ...plan.targets };
    const failed = (reason: string, checks: EngineUpdateCheck[] = []): EngineUpdateResult =>
      this.result(base, { state: 'failed', from, to, latest, checks, reason });

    this.log(
      `[hostd] engine update: building ${tags.candidate} with ${plan.changes.map((one) => `${one.pkg}@${one.to}`).join(', ')}`,
    );
    // A candidate a stopped run left behind is not this one.
    await this.untag(tags.candidate);
    const checks: EngineUpdateCheck[] = [];
    let swapped = false;
    try {
      const built = await this.build(tags.candidate, plan.targets, keptGh(from, plan) ? tags.latest : null);
      if (built.code !== 0) {
        return failed(`the candidate did not build: ${lastWords(`${built.stdout}\n${built.stderr}`) || `the script exited ${built.code}`}`);
      }

      checks.push(...(await this.checkClis(tags.candidate, plan.targets)));
      if (checks.every((check) => check.state === 'passed')) checks.push(...(await this.checkModels(tags.candidate)));
      const refused = checks.filter((check) => check.state === 'failed');
      if (refused.length > 0) return failed(refused.map((check) => check.detail).join('; '), checks);

      try {
        await this.swap(tags);
        swapped = true;
      } catch (error) {
        return failed(`the candidate passed, and could not be swapped in: ${error instanceof Error ? error.message : error}`, checks);
      }
    } catch (error) {
      return failed(`the candidate could not be checked: ${error instanceof Error ? error.message : error}`, checks);
    } finally {
      // Discarded however the run ended short of the swap: the image in use
      // is untouched, and a failed candidate is not left for anything to run.
      if (!swapped) await this.untag(tags.candidate);
    }

    const moved = await this.options.refresh().catch((error: unknown) => {
      this.log(`[hostd] engine update: could not drain the computers on the old image: ${error instanceof Error ? error.message : error}`);
      return { refreshed: [], deferred: [] };
    });
    return this.result(base, {
      state: 'updated',
      from,
      to,
      latest,
      checks,
      reason: describeChanges(from, to),
      refreshed: moved.refreshed,
      deferred: moved.deferred,
    });
  }

  /**
   * `build-bot-image.sh`, with every pin given, into the candidate tag.
   * `ghFrom` is the running image when gh is not moving: its gh is copied into
   * the candidate, so an update of something else downloads no gh.
   */
  private build(candidate: string, targets: Record<string, string>, ghFrom: string | null = null): Promise<CommandResult> {
    const pin = (cli: EngineCli): string => `${ENGINE_PACKAGES[cli]}@${targets[ENGINE_PACKAGES[cli]] ?? ''}`;
    // The script reads each of these as a pin, and they are set below only
    // when this run has one. hostd's own would be taken instead: every
    // node:* image exports NODE_VERSION, hostd's service image among them.
    const inherited = { ...(process.env as Record<string, string>) };
    for (const name of BUILD_PINS) delete inherited[name];
    return this.run('bash', [this.options.buildScript], {
      env: {
        ...inherited,
        CLAUDE_CLI: pin('claude'),
        CODEX_CLI: pin('codex'),
        GROK_CLI: pin('grok'),
        // Only when the running image's version is known. Omitting them leaves
        // the script's own pins, which is a fresh install, not a candidate
        // that should invent a Node or gh the bots are not already on.
        ...(targets.node ? { NODE_VERSION: targets.node } : {}),
        ...(targets.gh ? { GH_VERSION: targets.gh } : {}),
        ...(ghFrom ? { GH_FROM: ghFrom } : {}),
        IMAGE: candidate,
        ...(this.options.buildProxy ? { BUILD_PROXY: this.options.buildProxy } : {}),
      },
      timeoutMs: this.options.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
    });
  }

  /**
   * Newest version of one tool, from npm, nodejs.org or the GitHub CLI's apt
   * repository; and `eligible`, the one a run may take. For an npm engine CLI
   * that is the newest one old enough (`newestOldEnough`), with `published`
   * the newest's publish time; for Node and gh it is the newest.
   */
  private async newest(
    pkg: string,
    installed: string | null,
    minReleaseAgeDays: number = DEFAULT_MIN_RELEASE_AGE_DAYS,
  ): Promise<{ version: string | null; eligible?: string | null; published?: string; reason: string }> {
    const tool = SYSTEM_TOOLS.find((one) => one.key === pkg);
    if (tool?.source === 'nodejs') {
      const asked = await this.run('curl', ['-fsSL', 'https://nodejs.org/dist/index.json'], { timeoutMs: 60_000 });
      const version = asked.code === 0 ? newestNodeVersion(asked.stdout, installed) : null;
      if (!version) {
        const said = lastWords(`${asked.stderr}\n${asked.stdout}`) || `curl exited ${asked.code}`;
        return { version: null, reason: `could not ask nodejs.org which Node is newest: ${said}` };
      }
      return { version, eligible: version, reason: '' };
    }
    if (tool?.source === 'github') {
      const asked = await this.run('curl', ['-fsSL', ghPackagesUrl()], { timeoutMs: 60_000 });
      const version = asked.code === 0 ? newestGhVersion(asked.stdout) : null;
      if (!version) {
        const said = lastWords(`${asked.stderr}\n${asked.stdout}`) || `curl exited ${asked.code}`;
        return { version: null, reason: `could not ask the GitHub CLI's apt repository which gh is newest: ${said}` };
      }
      return { version, eligible: version, reason: '' };
    }
    const asked = await this.run('npm', ['view', pkg, 'dist-tags', 'time', '--json'], { timeoutMs: 60_000 });
    const answer = asked.code === 0 ? npmView(asked.stdout) : null;
    const tag = answer?.['dist-tags']?.latest;
    const version = typeof tag === 'string' ? parseVersion(tag) : null;
    if (!version) {
      const said = lastWords(`${asked.stderr}\n${asked.stdout}`) || `npm exited ${asked.code}`;
      return { version: null, reason: `could not ask npm which ${pkg} is newest: ${said}` };
    }
    // Never the newest unchecked: a run that cannot tell how old a release is
    // takes nothing.
    const time = answer?.time;
    const times = time && typeof time === 'object' && !Array.isArray(time) ? (time as Record<string, string>) : null;
    const published = times?.[version];
    if (minReleaseAgeDays > 0 && (!times || typeof published !== 'string' || !Number.isFinite(Date.parse(published)))) {
      return { version: null, reason: `could not read when npm published ${pkg} ${version}, so nothing is taken without its minimum release age` };
    }
    const eligible = newestOldEnough(times ?? {}, version, minReleaseAgeDays, this.now());
    return { version, eligible, ...(typeof published === 'string' ? { published } : {}), reason: '' };
  }

  /**
   * Each CLI, found the way a session finds it — under `env -i` with the
   * PATH hostd gives a session, which is not the image's — and asked its
   * version. A CLI the image has but a session cannot find fails every task
   * on it, which is exactly what `base-env.ts` records happening once.
   */
  private async checkClis(image: string, targets: Record<string, string>): Promise<EngineUpdateCheck[]> {
    const probed = await this.probe(image, 'candidate');
    const engines = CLIS.map((cli): EngineUpdateCheck => {
      const expected = targets[ENGINE_PACKAGES[cli]] ?? null;
      const found = probed[cli];
      if (!found?.path) {
        return {
          kind: 'cli',
          cli,
          state: 'failed',
          detail: `${cli} is not on the PATH a session gets in the candidate (${CONTAINER_TOOL_DIRS.join(', ')} and the system’s)`,
        };
      }
      if (!found.version || (expected && found.version !== expected)) {
        return {
          kind: 'cli',
          cli,
          state: 'failed',
          detail: `${cli} in the candidate says "${found.said || 'nothing'}", not ${expected ?? 'a version'}`,
        };
      }
      return { kind: 'cli', cli, state: 'passed', detail: `${cli} ${found.version} at ${found.path}` };
    });
    const extras = IMAGE_TOOLS.filter((cli) => targets[cli]).map((cli): EngineUpdateCheck => {
      const expected = targets[cli] ?? null;
      const found = probed[cli];
      if (!found?.path) {
        return { kind: 'cli', cli, state: 'failed', detail: `${cli} is not on the PATH a session gets in the candidate` };
      }
      if (!found.version || (expected && found.version !== expected)) {
        return {
          kind: 'cli',
          cli,
          state: 'failed',
          detail: `${cli} in the candidate says "${found.said || 'nothing'}", not ${expected ?? 'a version'}`,
        };
      }
      return { kind: 'cli', cli, state: 'passed', detail: `${cli} ${found.version} at ${found.path}` };
    });
    return [...engines, ...extras];
  }

  /**
   * One real call per distinct engine, account and model the crew is
   * assigned, from the candidate, with the credential a task on it presents.
   * The model is the one a task would resolve — `newest:opus` is whatever it
   * names today — because a model a CLI version refuses is the failure this
   * exists to catch before a task does.
   */
  private async checkModels(image: string): Promise<EngineUpdateCheck[]> {
    const choose = this.options.chooseModelFor(image);
    const checks: EngineUpdateCheck[] = [];
    const groups = new Map<
      string,
      { cli: EngineCli; model: string; account: TaskModelAccount | null; bots: CrewBot[]; configured: Set<string> }
    >();

    for (const bot of await this.options.crew()) {
      const cli = ENGINE_CLI[bot.engine];
      if (!cli) continue;
      let choice: SessionModel;
      try {
        choice = await choose(bot);
      } catch (error) {
        checks.push({
          kind: 'model',
          cli,
          state: 'failed',
          configured: [bot.model],
          bots: [bot.name],
          account: null,
          detail: `could not tell which model ${bot.name} would call: ${error instanceof Error ? error.message : error}`,
        });
        continue;
      }
      const key = `${cli}|${choice.account?.id ?? `bot:${bot.name}`}|${choice.model}`;
      const group = groups.get(key) ?? { cli, model: choice.model, account: choice.account, bots: [], configured: new Set() };
      group.bots.push(bot);
      group.configured.add(bot.model);
      groups.set(key, group);
    }

    let index = 0;
    for (const group of groups.values()) {
      index += 1;
      const first = group.bots[0] as CrewBot;
      const row = group.account ? await this.options.account(group.account.id).catch(() => null) : null;
      const account = group.account
        ? { id: group.account.id, label: row?.label ?? group.account.id, provider: group.account.provider, kind: group.account.kind }
        : null;
      const configured = [...group.configured];
      const named = configured.some((one) => one !== group.model) ? `${group.model} (${configured.join(', ')})` : group.model;
      const where = account ? `on ${account.label}` : `on ${first.name}’s own key`;
      const about = `${named} ${where}`;
      const check = {
        kind: 'model' as const,
        cli: group.cli,
        model: group.model,
        configured,
        account,
        bots: group.bots.map((bot) => bot.name),
      };

      const credential = await this.options.credential(first, group.account);
      if ('skip' in credential) {
        checks.push({ ...check, state: 'skipped', detail: `${about}: not called — ${credential.skip}` });
        continue;
      }
      if ('refuse' in credential) {
        checks.push({ ...check, state: 'failed', detail: `${about}: ${credential.refuse}` });
        continue;
      }

      const provider = group.account?.provider ?? ENGINE_PROVIDER[first.engine];
      if (!provider) continue;
      const verdict = await this.options.callModel({
        provider,
        model: group.model,
        image,
        name: `${this.prefix}-call-${index}`,
        credential: credential.presented,
        env: containerBaseEnv(),
      });
      checks.push({ ...check, state: verdict.ok ? 'passed' : 'failed', detail: `${about}: ${verdict.message}` });
    }
    return checks;
  }

  /**
   * The image in use becomes `previous` and the candidate `latest`, by id so
   * nothing between the two moves can change what either means. What
   * `previous` held before is then tagged nowhere, and is removed when
   * nothing runs it: two images are kept, not one a week.
   */
  private async swap(tags: { latest: string; candidate: string; previous: string }): Promise<void> {
    const candidate = await this.imageId(tags.candidate);
    if (!candidate) throw new Error(`${tags.candidate} is not there to swap in`);
    const latest = await this.imageId(tags.latest);
    const previous = await this.imageId(tags.previous);

    if (latest) await this.must(['tag', latest, tags.previous]);
    await this.must(['tag', candidate, tags.latest]);
    await this.docker(['image', 'rm', tags.candidate]);
    if (previous && previous !== latest && previous !== candidate) await this.docker(['image', 'rm', previous]);
    this.log(`[hostd] engine update: ${tags.latest} is now ${short(candidate)}${latest ? `, and ${tags.previous} ${short(latest)}` : ''}`);
  }

  /**
   * Back to the image in use before the last update: `previous` and `latest`
   * change places, so a rollback is undone by rolling back again. Nothing is
   * built and nothing is called — the previous image is one the crew ran on.
   */
  async rollback(requestedBy: string | null = null): Promise<EngineUpdateResult> {
    if (this.current) throw new EngineUpdateRefused(409, 'an engine update is running; roll back once it has finished');
    if (this.rolling) throw new EngineUpdateRefused(409, 'a rollback is already running');
    if (this.options.driver === 'local') {
      throw new EngineUpdateRefused(409, 'not applicable: the local driver runs the host’s own CLIs');
    }
    const tags = imageTags(this.options.image);
    if (!tags) {
      throw new EngineUpdateRefused(409, `the bots run ${this.options.image}, which this install does not build or roll back`);
    }

    const rolling = this.rollBack(tags, requestedBy);
    this.rolling = rolling;
    try {
      const result = await rolling;
      this.last = result;
      return result;
    } finally {
      this.rolling = null;
    }
  }

  private async rollBack(
    tags: { latest: string; candidate: string; previous: string },
    requestedBy: string | null,
  ): Promise<EngineUpdateResult> {
    const startedAt = this.now().toISOString();
    const previous = await this.imageId(tags.previous);
    if (!previous) {
      throw new EngineUpdateRefused(404, `there is no ${tags.previous} to roll back to: nothing has been updated here yet`);
    }
    const latest = await this.imageId(tags.latest);
    const from = (await this.versionsOf(tags.latest)).versions;
    const to = (await this.versionsOf(tags.previous)).versions;

    await this.must(['tag', previous, tags.latest]);
    if (latest && latest !== previous) await this.must(['tag', latest, tags.previous]);
    this.log(`[hostd] engine rollback: ${tags.latest} is now ${short(previous)}${latest ? `, and ${tags.previous} ${short(latest)}` : ''}`);

    const moved = await this.options.refresh().catch(() => ({ refreshed: [], deferred: [] }));
    return this.result(
      { trigger: 'rollback', requestedBy, startedAt },
      {
        state: 'rolled-back',
        from,
        to,
        latest: null,
        checks: [],
        reason: describeChanges(from, to) || 'the previous image carries the same versions',
        refreshed: moved.refreshed,
        deferred: moved.deferred,
      },
    );
  }

  // ---------------------------------------------------------------- docker

  private docker(args: string[], timeoutMs = 60_000): Promise<CommandResult> {
    return this.run('docker', args, { timeoutMs });
  }

  private async must(args: string[]): Promise<void> {
    const done = await this.docker(args);
    if (done.code !== 0) throw new Error(`docker ${args.join(' ')}: ${lastWords(done.stderr) || `exited ${done.code}`}`);
  }

  private async untag(ref: string): Promise<void> {
    await this.docker(['image', 'rm', ref]);
  }

  private async imageId(ref: string): Promise<string | null> {
    const found = await this.docker(['image', 'inspect', '--format', '{{.Id}}', ref]);
    const id = found.stdout.trim();
    return found.code === 0 && id ? id : null;
  }

  /** The versions an image carries: its label, or what its CLIs say, remembered per image id. */
  private async versionsOf(ref: string): Promise<InUse> {
    const found = await this.docker(['image', 'inspect', ref]);
    if (found.code !== 0) return { versions: {}, source: 'none', id: null };
    let id: string | null = null;
    let labels: Record<string, string> | null = null;
    try {
      const [entry] = JSON.parse(found.stdout) as Array<{ Id?: string; Config?: { Labels?: Record<string, string> | null } }>;
      id = entry?.Id ?? null;
      labels = entry?.Config?.Labels ?? null;
    } catch {
      return { versions: {}, source: 'none', id: null };
    }
    const labelled = readEnginesLabel(labels);
    // A label that names Node and gh answers without a container. One that
    // predates those keys does not: a schedule cannot pin a version it has
    // not read, and asking once per image id is what the page's poll may do.
    if (labelled?.node && labelled.gh) return { versions: labelled, source: 'label', id };
    if (!id) return labelled ? { versions: labelled, source: 'label', id: null } : { versions: {}, source: 'none', id: null };

    const known = this.probed.get(id);
    if (known) return known;
    const asked = this.probe(ref, 'in-use').then((probed): InUse =>
      labelled
        ? { versions: withProbedTools(labelled, probed), source: 'label', id }
        : { versions: versionsFromProbe(probed), source: 'cli', id },
    );
    this.probed.set(id, asked);
    // A probe that failed is not an answer to keep.
    asked.catch(() => this.probed.delete(id as string));
    return asked;
  }

  /**
   * Asks each CLI in `image` where it is and what version it is, in one
   * throwaway container started the way a session starts: `env -i`, the
   * session's PATH and home, and grok's self-updater off as the grok engine
   * sets it. The image's entrypoint (`tini -- bot-init`) ignores a command,
   * so the entrypoint is replaced.
   */
  private async probe(image: string, purpose: 'in-use' | 'candidate'): Promise<Partial<Record<ImageTool, Probed>>> {
    const name = `${this.prefix}-versions-${purpose}`;
    const env = { ...containerBaseEnv(), GROK_DISABLE_AUTOUPDATER: '1', DISABLE_AUTOUPDATER: '1' };
    const commands: readonly ImageTool[] = [...CLIS, ...IMAGE_TOOLS];
    const script = commands
      .map(
        (cli) =>
          `printf '%s\\t%s\\t%s\\n' ${cli} "$(command -v ${cli} 2>/dev/null)" "$(${cli} --version 2>/dev/null | tr '\\n' ' ')"`,
      )
      .join('; ');
    await this.docker(['rm', '-f', name]);
    const answered = await this.docker(
      [
        'run',
        '--rm',
        '--name',
        name,
        ...probeNetworkArgs(),
        '--entrypoint',
        '/usr/bin/env',
        image,
        '-i',
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        'sh',
        '-c',
        script,
      ],
      120_000,
    );
    if (answered.code !== 0) {
      await this.docker(['rm', '-f', name]);
      throw new Error(`could not ask the CLIs in ${image}: ${lastWords(answered.stderr) || `docker exited ${answered.code}`}`);
    }

    const probed: Partial<Record<ImageTool, Probed>> = {};
    for (const line of answered.stdout.split('\n')) {
      const [cli, path = '', said = ''] = line.split('\t');
      if (!cli || !commands.includes(cli as ImageTool)) continue;
      probed[cli as ImageTool] = { path: path.trim() || null, said: said.trim(), version: parseVersion(said) };
    }
    return probed;
  }
}

/** Engine versions from a probe, and Node and gh when the probe could read them. */
function versionsFromProbe(probed: Partial<Record<ImageTool, Probed>>): EngineVersions {
  const versions: EngineVersions = {};
  for (const cli of CLIS) versions[ENGINE_PACKAGES[cli]] = probed[cli]?.version ?? null;
  return withProbedTools(versions, probed);
}

/** Fills Node and gh from a probe when the label did not carry them. */
function withProbedTools(labelled: EngineVersions, probed: Partial<Record<ImageTool, Probed>>): EngineVersions {
  const versions: EngineVersions = { ...labelled };
  for (const tool of IMAGE_TOOLS) {
    if (versions[tool]) continue;
    const version = probed[tool]?.version;
    if (version) versions[tool] = version;
  }
  return versions;
}

/** An image id short enough to read in a log line. */
function short(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}
