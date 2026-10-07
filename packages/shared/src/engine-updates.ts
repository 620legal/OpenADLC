/**
 * The weekly engine update, as hostd and the bridge both speak of it.
 *
 * hostd owns Docker and the bot image, so it does the work: reads which
 * engine CLIs the image carries, asks npm for newer ones, builds a candidate,
 * proves it, and swaps it in. The bridge owns the clock and the record: it
 * decides when, and writes what happened into the audit log. These are the
 * shapes that pass between them.
 */

/** The engine CLIs the bot image carries, by the command a session runs. */
export const ENGINE_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  grok: '@xai-official/grok',
} as const;

export type EngineCli = keyof typeof ENGINE_PACKAGES;
export type EnginePackage = (typeof ENGINE_PACKAGES)[EngineCli];

/**
 * What Settings → System can update in the bots' image.
 *
 * The three engine CLIs, the GitHub CLI and Node. pnpm, the Debian packages,
 * uv, a repository's own toolchain and OpenADLC itself are not here: a schedule
 * must not move those under a bot. `key` is what the image label and the
 * update plan call the tool — the npm package for an engine, the command for
 * the other two.
 */
export const SYSTEM_TOOLS = [
  {
    id: 'claude',
    key: ENGINE_PACKAGES.claude,
    name: 'Claude Code',
    purpose: 'The engine a bot on Claude thinks with',
    source: 'npm',
  },
  {
    id: 'codex',
    key: ENGINE_PACKAGES.codex,
    name: 'Codex',
    purpose: 'The engine a bot on Codex thinks with',
    source: 'npm',
  },
  {
    id: 'grok',
    key: ENGINE_PACKAGES.grok,
    name: 'Grok',
    purpose: 'The engine a bot on Grok thinks with',
    source: 'npm',
  },
  {
    id: 'gh',
    key: 'gh',
    name: 'GitHub CLI',
    purpose: 'How a bot calls GitHub',
    source: 'github',
  },
  {
    id: 'node',
    key: 'node',
    name: 'Node.js',
    purpose: 'What the engines and a repository’s scripts run on',
    source: 'nodejs',
  },
] as const;

export type SystemToolId = (typeof SYSTEM_TOOLS)[number]['id'];
export type SystemToolSource = (typeof SYSTEM_TOOLS)[number]['source'];

export function systemToolById(id: string): (typeof SYSTEM_TOOLS)[number] | undefined {
  return SYSTEM_TOOLS.find((tool) => tool.id === id);
}

/**
 * How many whole days an engine CLI release must have been on npm before the
 * engine update takes it. The update took any newer version however recently
 * it was published, and the candidate's `npm install -g` runs the package's
 * own scripts, then is called with the bots' credentials: a malicious or
 * compromised release reached every bot within a week, or minutes when it
 * landed just before the slot. A few days give the ecosystem time to notice
 * and pull one. 0 takes the newest at once. Only the three npm engine CLIs:
 * Node and gh keep their own lookup.
 */
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;
export const MAX_MIN_RELEASE_AGE_DAYS = 90;

/** Whether a value is a minimum release age the install accepts: a whole number of days, 0 to 90. */
export function isMinReleaseAgeDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MIN_RELEASE_AGE_DAYS;
}

/** The minimum release age a stored or sent value means: the default when it is absent or not one. */
export function minReleaseAgeDaysFrom(value: unknown): number {
  const days = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return isMinReleaseAgeDays(days) ? days : DEFAULT_MIN_RELEASE_AGE_DAYS;
}

/** Package → version. A version that could not be told is null. */
export type EngineVersions = Partial<Record<string, string | null>>;

/** One thing a candidate was asked to prove before it could be swapped in. */
export interface EngineUpdateCheck {
  /** `cli`: the command is on a session's PATH and is the version built. `model`: one real call. */
  kind: 'cli' | 'model';
  state: 'passed' | 'failed' | 'skipped';
  /** What was found, or why it failed or was skipped, in words a person reads. Never a credential. */
  detail: string;
  /** The command: an engine CLI, `gh` or `node`. */
  cli?: EngineCli | 'gh' | 'node';
  /** For a model check: the id called, resolved as a task resolves it. */
  model?: string;
  /** What the bots are set to: `newest:opus`, or a pinned id. */
  configured?: string[];
  /** The account whose credential it called with; null for a bot still on its own key. */
  account?: { id: string; label: string; provider: string; kind: string } | null;
  /** The bots this call stands for. */
  bots?: string[];
}

export type EngineUpdateState = 'updated' | 'current' | 'failed' | 'skipped' | 'rolled-back';

/** What one run did. */
export interface EngineUpdateResult {
  state: EngineUpdateState;
  /** What asked for it: `schedule`, `console` or `rollback`. */
  trigger: string;
  /** The person or job the bridge said it was acting for. */
  requestedBy: string | null;
  /** The versions in use when the run started. */
  from: EngineVersions;
  /**
   * The versions in use afterwards when it `updated` or `rolled-back`; what the
   * candidate carried when it `failed`; null when nothing was built.
   */
  to: EngineVersions | null;
  /** What npm said is newest, when it was asked. */
  latest: EngineVersions | null;
  checks: EngineUpdateCheck[];
  /** Why it failed or was skipped; what changed otherwise. */
  reason: string;
  startedAt: string;
  finishedAt: string;
  /** Bots whose computer is on the new image now. */
  refreshed?: string[];
  /** Bots that were working, and take the new image at their next task start. */
  deferred?: string[];
}

/** What hostd says about the engines it runs, and the update it may be running. */
export interface EngineUpdateStatus {
  driver: 'docker' | 'local';
  /** Whether this hostd can update the bot image at all, and why not when it cannot. */
  applicable: boolean;
  reason: string;
  /** The image every bot runs: `fleetadlc-bot:latest`. */
  image: string;
  inUse: EngineVersions;
  /** Where `inUse` came from: the image's label, the CLIs themselves, or nowhere. */
  inUseSource: 'label' | 'cli' | 'none';
  /** What the image a rollback would return to carries, or null when there is none. */
  previous: EngineVersions | null;
  running: { startedAt: string; trigger: string } | null;
  last: EngineUpdateResult | null;
}

/** hostd's answer to being asked to update: the run it started or joined, or what it decided at once. */
export interface EngineUpdateStart {
  running: boolean;
  startedAt: string | null;
  /** True when a run was already going and this request joined it. */
  joined: boolean;
  /** Set when there was nothing to run — a local driver, an image this install does not build. */
  last: EngineUpdateResult | null;
}
