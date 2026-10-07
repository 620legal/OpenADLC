import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PORTS, envBool, envInt, envOr, hostdDriverFromEnv } from '@fleetadlc/shared';
import { readModelPrices, type ModelPrice } from '@fleetadlc/engines';
import { fleetHome } from '@fleetadlc/github';

/** `make ci`'s limit for local CI, and `make setup`'s for a task start, when nothing says. */
export const DEFAULT_LOCAL_CI_TIMEOUT_MINUTES = 60;
export const DEFAULT_SETUP_TIMEOUT_MINUTES = 30;

export interface HostdConfig {
  hostName: string;
  zone: string | null;
  /** `docker` on a real host, `local` for a development install without Docker. */
  driver: 'docker' | 'local';
  port: number;
  bridgeUrl: string;
  /** Root for bare mirrors, worktrees and per-bot caches. */
  workRoot: string;
  /**
   * One directory per OpenAI or xAI subscription, holding that CLI's own
   * login. Mounted into the containers of the bots assigned to the account and
   * no others, so it has to be a path the Docker daemon can see — like the
   * work root, it is hostd's filesystem as the host names it.
   */
  loginRoot: string;
  skillsRoot: string;
  rolesRoot: string;
  capacityBots: number;
  /**
   * How many tasks this host runs at once, whoever's: each is a computer with
   * its seat's CPUs and memory. A start past it is refused (`HostFull`) and
   * tried again by the bridge. `FLEETADLC_HOST_CAPACITY_TASKS`, default 4.
   */
  capacityTasks: number;
  /**
   * How long a task paused on a person keeps its computer before it is given
   * back, its branch kept: long enough to take over and for a quick answer to
   * resume it cheaply. `FLEETADLC_PAUSED_KEEP_MINUTES`, default 15.
   */
  pausedKeepMinutes: number;
  /**
   * How long `make ci` may run for local CI before it is killed and the run
   * fails, so a hung suite does not hold every later run for the task.
   * `FLEETADLC_LOCAL_CI_TIMEOUT_MINUTES`, default 60.
   */
  localCiTimeoutMinutes?: number;
  /**
   * How long a task's `make setup` may run before it is killed and the start
   * goes on without it, so a hung one does not hold a place on the host.
   * `FLEETADLC_SETUP_TIMEOUT_MINUTES`, default 30.
   */
  setupTimeoutMinutes?: number;
  /**
   * Where the host's task database server is published: the Docker bridge's
   * gateway on Linux, loopback on Docker Desktop and OrbStack (see
   * `TaskDatabasesOptions.bindAddress`). `FLEETADLC_TASKDB_BIND`; null to
   * work it out. A wildcard address is refused when hostd starts
   * (`taskdbBindAddress`).
   */
  taskdbBind?: string | null;
  /**
   * Computers made ahead of their task, so a start claims one rather than
   * making one (`WarmPool`): `FLEETADLC_WARM_POOL=1`, off by default, and at
   * most `FLEETADLC_WARM_POOL_MAX` of them (three). Docker driver only.
   */
  warmPool?: boolean;
  warmPoolMax?: number;
  /** The tmux the local driver and take-over run (`FLEETADLC_TMUX_BIN`, default `tmux`). */
  tmuxBin: string;
  /** A private package registry, or null on an install that has none. */
  registryHost: string | null;
  /**
   * The bridge as a task reaches it, when that is not `bridgeUrl` made
   * reachable (`reachableFromTask`). hostd in a container knows the bridge by
   * its compose name, `http://bridge:47311`, which a task's container, on the
   * install's task network, cannot resolve; it reaches the bridge's published port
   * on the host instead. `FLEETADLC_HOSTD_TASK_BRIDGE_URL`.
   */
  taskBridgeUrl?: string | null;
  /**
   * hostd as a task reaches it, when its own port is not the one published on
   * the host: in compose hostd listens on 47312 inside its container and is
   * published on whatever `FLEETADLC_HOSTD_PORT` says. `FLEETADLC_HOSTD_TASK_HOSTD_URL`.
   */
  taskHostdUrl?: string | null;
  /**
   * The skill runner bundle and OpenADLC's `gh`, as paths the Docker daemon can
   * see. Both are bind-mounted into every bot's container, and by default they
   * are where hostd's own files are — which, for a hostd running in a
   * container, is inside it and not on the host. `FLEETADLC_RUNNER_BUNDLE`,
   * `FLEETADLC_GH_SHIM_DIR`; null for the defaults.
   */
  runnerBundle?: string | null;
  ghShimDir?: string | null;
  /**
   * What this install's bot containers, sidecars and networks are named after,
   * and the install they are labelled with. Two installs on one Docker daemon
   * need different ones; `fleetadlc up`'s keeps `bot-` and `default`, the names
   * every install had before. `FLEETADLC_BOT_PREFIX`, `FLEETADLC_INSTALL_ID`.
   */
  botPrefix?: string | null;
  installId?: string | null;
  /**
   * The install's `models.yaml` from `FLEETADLC_CONFIG_ROOT`, read once at
   * start and handed to every session (`FLEETADLC_MODEL_PRICES`): a session
   * runs in a managed repository's checkout, where no file is the install's.
   * A malformed file, or a price below 0, stops hostd here.
   */
  modelPrices?: Record<string, ModelPrice>;
}

/** A Docker name prefix: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
const NAME_PREFIX = /^[a-z0-9][a-z0-9_.-]*$/;

function namePart(variable: string): string | null {
  const value = process.env[variable]?.trim();
  if (!value) return null;
  if (!NAME_PREFIX.test(value)) {
    throw new Error(`${variable} must be lowercase letters, digits, ".", "_" or "-", starting with a letter or digit; it is ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Where subscription logins live. Its own function because the session
 * environment needs the same answer as the config, and a second copy of the
 * default is how the two would come to disagree.
 *
 * Always absolute. It becomes the source of a bind mount, and Docker reads a
 * relative source as the name of a volume — a different, empty place that
 * nothing ever signs in to.
 */
export function loginRootFromEnv(): string {
  return resolve(envOr('FLEETADLC_LOGIN_ROOT', join(fleetHome(), 'logins')));
}

/**
 * The prefix and the install id, set together or not at all.
 *
 * One without the other names another install's containers with this one's
 * label, or this install's containers with the default label: a prefix left
 * at `bot-` under a new id reaches `fleetadlc up`'s bots by name, and only the
 * label guard stops it. Refused here instead, before any container is named.
 */
function botNames(): { botPrefix: string | null; installId: string | null } {
  const botPrefix = namePart('FLEETADLC_BOT_PREFIX');
  const installId = namePart('FLEETADLC_INSTALL_ID');
  if ((botPrefix === null) !== (installId === null)) {
    const set = botPrefix === null ? 'FLEETADLC_INSTALL_ID' : 'FLEETADLC_BOT_PREFIX';
    const unset = botPrefix === null ? 'FLEETADLC_BOT_PREFIX' : 'FLEETADLC_INSTALL_ID';
    throw new Error(`${set} is set and ${unset} is not; another install on this Docker daemon needs both, and the default install neither`);
  }
  return { botPrefix, installId };
}

export function loadHostdConfig(): HostdConfig {
  return {
    hostName: envOr('FLEETADLC_HOST_NAME', hostname()),
    zone: process.env.FLEETADLC_HOST_ZONE ?? null,
    driver: hostdDriverFromEnv(),
    port: envInt('FLEETADLC_HOSTD_PORT', DEFAULT_PORTS.hostd),
    bridgeUrl: envOr('FLEETADLC_BRIDGE_URL', `http://127.0.0.1:${DEFAULT_PORTS.bridge}`),
    workRoot: envOr('FLEETADLC_WORK_ROOT', join(fleetHome(), 'work')),
    loginRoot: loginRootFromEnv(),
    skillsRoot: envOr('FLEETADLC_SKILLS_ROOT', join(process.cwd(), 'crew', 'skills')),
    rolesRoot: envOr('FLEETADLC_ROLES_ROOT', join(process.cwd(), 'crew', 'roles')),
    capacityBots: envInt('FLEETADLC_HOST_CAPACITY', 8),
    capacityTasks: Math.max(1, envInt('FLEETADLC_HOST_CAPACITY_TASKS', 4)),
    pausedKeepMinutes: Math.max(0, envInt('FLEETADLC_PAUSED_KEEP_MINUTES', 15)),
    localCiTimeoutMinutes: Math.max(1, envInt('FLEETADLC_LOCAL_CI_TIMEOUT_MINUTES', DEFAULT_LOCAL_CI_TIMEOUT_MINUTES)),
    setupTimeoutMinutes: Math.max(1, envInt('FLEETADLC_SETUP_TIMEOUT_MINUTES', DEFAULT_SETUP_TIMEOUT_MINUTES)),
    taskdbBind: process.env.FLEETADLC_TASKDB_BIND || null,
    warmPool: envBool('FLEETADLC_WARM_POOL', false),
    warmPoolMax: Math.max(0, envInt('FLEETADLC_WARM_POOL_MAX', 3)),
    tmuxBin: envOr('FLEETADLC_TMUX_BIN', 'tmux'),
    // Empty is none. The cloud host's hostd.env writes the line whether or not
    // the module names a registry, and "" kept as a host would read as a
    // registry with no token stored rather than as no registry at all.
    registryHost: process.env.FLEETADLC_REGISTRY_HOST?.trim() || null,
    taskBridgeUrl: process.env.FLEETADLC_HOSTD_TASK_BRIDGE_URL || null,
    taskHostdUrl: process.env.FLEETADLC_HOSTD_TASK_HOSTD_URL || null,
    runnerBundle: process.env.FLEETADLC_RUNNER_BUNDLE || null,
    ghShimDir: process.env.FLEETADLC_GH_SHIM_DIR || null,
    ...botNames(),
    modelPrices: readModelPrices(envOr('FLEETADLC_CONFIG_ROOT', join(process.cwd(), 'config'))),
  };
}
