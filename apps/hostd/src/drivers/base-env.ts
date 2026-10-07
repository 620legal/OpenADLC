import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * What a session needs before it needs anything of ours: enough to find a
 * binary, a home to write caches into, and a terminal that renders.
 *
 * Sessions run under `env -i`, so this is the whole of the environment a task
 * gets apart from what hostd mints for it. That is the point — hostd's own
 * environment holds the platform's database URL, and a bot that inherited it
 * could read and rewrite the ledger and the audit trail that hold it to account.
 */
const PASSED_THROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'TMPDIR'] as const;

/**
 * Where OpenADLC's own `gh` is (`bin/gh` in this package): in hostd's checkout,
 * and at `/opt/fleetadlc/bin` inside a bot's container, where the docker driver
 * mounts it. First on a session's PATH, so what the session posts to GitHub
 * carries its header (FLEETADLC_POST_HEADER); it runs the real `gh` after.
 */
export const GH_SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');
export const CONTAINER_GH_SHIM_DIR = '/opt/fleetadlc/bin';

/**
 * The engine vendors' switches for telemetry, error reporting and other
 * traffic a session does not need, every one turned off. Claude Code otherwise
 * posts usage events, with account and organization ids, a host fingerprint
 * and a hash of the repository's remote, to Anthropic and Datadog, and pulls
 * remote feature flags that change the pinned CLI's behaviour; grok sends
 * analytics to Mixpanel and crash reports to Sentry. A session starts under
 * `env -i` with a fresh HOME, so an operator could not set these themselves.
 * Model calls are essential traffic and are unaffected. Codex has no variable
 * for it; `CodexEngine` passes its config switches instead.
 */
export const TELEMETRY_OPT_OUTS: Readonly<Record<string, string>> = Object.freeze({
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DO_NOT_TRACK: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  GROK_TELEMETRY_ENABLED: '0',
  GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
  GROK_TELEMETRY_TRACE_UPLOAD: '0',
  GROK_FEEDBACK_ENABLED: '0',
  NEXT_TELEMETRY_DISABLED: '1',
});

/**
 * The opt-outs, unless hostd's `FLEETADLC_ENGINE_TELEMETRY` is `on`: then
 * none of them, and the setting itself, so `CodexEngine` leaves Codex's own
 * switches alone too. Read the way `egressProxyEnv` reads its proxy.
 */
export function telemetryEnv(setting: string | undefined = process.env.FLEETADLC_ENGINE_TELEMETRY): Record<string, string> {
  return setting === 'on' ? { FLEETADLC_ENGINE_TELEMETRY: 'on' } : { ...TELEMETRY_OPT_OUTS };
}

/** The host's own values, for the development driver that runs beside hostd. */
export function hostBaseEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of PASSED_THROUGH) {
    const value = process.env[key];
    if (value) base[key] = value;
  }
  // A session with no PATH cannot start the thing it was opened to run.
  base.PATH ??= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  base.PATH = `${GH_SHIM_DIR}:${base.PATH}`;
  base.TERM ??= 'xterm-256color';
  return { ...base, ...telemetryEnv() };
}

/**
 * Where the bot image puts what a session runs, ahead of the system's own.
 *
 * The image installs the engine CLIs — `claude`, `codex`, `grok` — with npm
 * under the bot's own prefix, and pnpm's shims beside them, and says so in its
 * `ENV PATH`. A session starts under `env -i`, so that line never reaches it:
 * this is the PATH it gets instead. Without these two directories every
 * engine was "not available on this host" in a container that had all three,
 * and every task failed before it began. `base-env.test.ts` reads the
 * Dockerfile, so the two cannot drift apart again unnoticed.
 */
export const CONTAINER_TOOL_DIRS = ['/home/bot/.local/share/pnpm', '/home/bot/.local/bin'] as const;

/**
 * How a process in a bot's container reaches the internet on a host whose
 * firewall allows nothing else: the proxy, in both spellings (curl and git read
 * the lowercase names, most Node and Rust clients the uppercase), with hostd
 * itself bypassed — and `NODE_USE_ENV_PROXY`, without which Node's own fetch
 * ignores all of it. Empty where there is no proxy.
 */
export function egressProxyEnv(proxy: string | undefined = process.env.FLEETADLC_BOT_EGRESS_PROXY || undefined): Record<string, string> {
  if (!proxy) return {};
  const bypass = 'host.docker.internal,localhost,127.0.0.1';
  return {
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: bypass,
    no_proxy: bypass,
  };
}

/**
 * The container's values, which are not the host's: a bot image has its own
 * paths and its own non-root user, so passing hostd's through would point a
 * session at binaries and a home that do not exist inside it.
 */
export function containerBaseEnv(): Record<string, string> {
  return {
    // A session starts under `env -i`, so the container's own proxy variables
    // never reached it: on the first cloud host the skill runner's every report
    // to the bridge went straight at the firewall, and the task was killed.
    ...egressProxyEnv(),
    // In the image's own order: its directories, then the system's.
    PATH: [CONTAINER_GH_SHIM_DIR, ...CONTAINER_TOOL_DIRS, '/usr/local/bin', '/usr/local/sbin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(':'),
    HOME: '/home/bot',
    USER: 'bot',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    // The container is the session's sandbox. An engine that would sandbox
    // each command itself cannot in here — Codex's bubblewrap needs a user
    // namespace an unprivileged container cannot make — and need not.
    FLEETADLC_CONTAINED: '1',
    ...telemetryEnv(),
  };
}

/**
 * The sanitiser behind `repoKeyOf`: anything but letters, digits, `.`, `_` and
 * `-` becomes `-`, and a task on no repository is `_no-repository`.
 */
export function repoHomeKey(repo: string | null | undefined): string {
  const key = (repo ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return key || '_no-repository';
}

/**
 * What a repository is called in the names of things hostd keeps for it on a
 * host — its database, its cache volume, its warm computers: the full name
 * with `/` as `__` (no owner can hold an underscore, so two repositories
 * cannot meet in one key), lowercased, safe as a Docker name. Null for a task
 * on no repository.
 */
export function repoKeyOf(repoFullName: string | null | undefined): string | null {
  if (!repoFullName) return null;
  const key = repoHomeKey(repoFullName.replace('/', '__'));
  return key === '_no-repository' ? null : key;
}

/**
 * A session's environment with the task's own home in place of the bot's,
 * when `FLEETADLC_REPO_HOME` names one, its repository's npm cache when
 * `FLEETADLC_CACHE_DIR` names one, and its repository's pnpm store when
 * `FLEETADLC_PNPM_STORE` names one.
 *
 * A bot's home held everything a tool keeps between runs — package caches,
 * globally installed CLIs, whatever a tool writes under `~` — so what one task
 * installed was there for the next, whichever repository it was in. The home
 * is now the task's own, in its directory (`<slot>/home`), and goes with it:
 * HOME is it, npm and pnpm install globally into it, and its tools come right
 * after OpenADLC's `gh` on the PATH, ahead of the image's. Git keeps the base
 * home's settings file, where the image's own configuration is.
 *
 * What a repository's tasks share and write is only npm's cache, which keeps
 * every package under the hash its lockfile names and verifies it on the way
 * out, so a task that wrote something else there would hand the next one a
 * failed install, not a different package. pnpm's store does not: for a
 * package it already holds, pnpm trusts its own index, which a task could
 * rewrite along with the files, so a writable shared store would let one task
 * plant code the next one runs. The shared store is read-only in every task,
 * and hostd alone fills it (`PnpmStore`); without it — the local driver, a
 * fill that failed — the store is the task's own, in its home, and goes with
 * it. Global installs and `~/.cache` are not shared: nothing checks them, and
 * they run.
 */
export function withRepoHome(base: Record<string, string>, env: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...base, ...env };
  const home = env.FLEETADLC_REPO_HOME;
  if (!home) return merged;

  if (base.HOME && !env.GIT_CONFIG_GLOBAL) merged.GIT_CONFIG_GLOBAL = `${base.HOME}/.gitconfig`;
  merged.HOME = home;
  merged.NPM_CONFIG_PREFIX = `${home}/.local`;
  merged.PNPM_HOME = `${home}/.local/share/pnpm`;
  const cache = env.FLEETADLC_CACHE_DIR;
  if (cache) merged.npm_config_cache = `${cache}/npm`;
  // pnpm reads the first; the second is what its documentation names. The
  // same for `make setup`, the session and local CI, or pnpm stops on a
  // node_modules another store built.
  const store = env.FLEETADLC_PNPM_STORE || `${home}/.pnpm-store`;
  merged.npm_config_store_dir = store;
  merged.PNPM_STORE_DIR = store;
  // A read-only store takes no build's side effects.
  if (env.FLEETADLC_PNPM_STORE) merged.npm_config_side_effects_cache = 'false';
  const own = [`${home}/.local/bin`, `${home}/.local/share/pnpm`];
  const path = (base.PATH ?? '').split(':').filter(Boolean);
  const shimFirst = path[0] === CONTAINER_GH_SHIM_DIR || path[0] === GH_SHIM_DIR;
  merged.PATH = (shimFirst ? [path[0]!, ...own, ...path.slice(1)] : [...own, ...path]).join(':');
  return merged;
}
