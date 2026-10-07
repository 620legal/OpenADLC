import { execFile, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { forgetTaskLogin } from '@fleetadlc/backup';
import { CONTAINER_AUTH, CONTAINER_LOGIN, ensureLoginDir, isAccountId, taskLoginMounts, type DeviceProvider } from '../logins.js';
import { retireSeatContainers } from '../legacy.js';
import { readSlotTask, removeSlot, writeSlotTask } from '../worktree.js';
import type { WarmComputer, WarmKey, WarmPool } from '../warm-pool.js';
import { CONTAINER_GH_SHIM_DIR, containerBaseEnv, egressProxyEnv, GH_SHIM_DIR, withRepoHome } from './base-env.js';
import { FROM_ENV_FILE, isCredentialEnv, sessionEnvFile } from './credential-env.js';
import { Tmux } from './tmux.js';
import type {
  ExecDriver,
  ExecOptions,
  ExecResult,
  FoundComputer,
  ObservedSession,
  SessionHandle,
  SigningAgent,
  TaskComputer,
  TaskComputerSpec,
} from './types.js';
import { KILL_AFTER_MS } from './types.js';
import { stateFromPane } from './local.js';
import { CONTAINER_PNPM_STORE, PnpmStore, pnpmStoreVolume, type PnpmFill } from '../pnpm-store.js';

/** Where a task's container sees the role playbooks, mounted read-only. */
export const ROLES_IN_CONTAINER = '/roles';

const run = promisify(execFile);

/**
 * Where the bundled runner appears inside a task's container.
 *
 * Fixed rather than derived from the host path: this one is the platform's own
 * code, not the bot's work, so there is no `.git` recording an absolute path and
 * nothing that has to match hostd's filesystem.
 */
export const CONTAINER_RUNNER = '/usr/local/lib/fleetadlc/skill-runner.mjs';

/** Where a task's container has its repository's cache volume. */
export const CONTAINER_CACHE = '/cache';

export type DockerResult = { code: number; stdout: string; stderr: string };

/**
 * What a container was made with, recorded for a person inspecting it
 * (`docker inspect`). hostd does not read these: what a container is made with
 * is fixed when it is made, so a warm container a hostd before this one made
 * is discarded whatever its labels say (`SessionObserver.reapComputers`), and
 * the pool compares a warm one's image through `docker inspect`'s `.Image`.
 */
export const LOGIN_LABEL = 'fleetadlc.login';
export const IMAGE_LABEL = 'fleetadlc.image';
/** How the container reaches the internet: `none`, or the proxy and the version of what is passed with it. */
export const EGRESS_LABEL = 'fleetadlc.egress';
/** Which of OpenADLC's own tools are mounted into the container — now, its `gh` (see GH_SHIM_DIR). */
export const TOOLS_LABEL = 'fleetadlc.tools';
/** Where on the host the skills, the role playbooks, the runner and `gh` were mounted from. */
export const MOUNTS_LABEL = 'fleetadlc.mounts';
/** The limits that `docker update` cannot add later: its process limit and `no-new-privileges`. */
export const HARDENING_LABEL = 'fleetadlc.hardening';
/**
 * Which install a container belongs to. Container and network names are
 * global on a Docker daemon, and two installs on one machine — `fleetadlc up`
 * and the compose stack, say — both run tasks. Without this, one install's
 * hostd reused or removed the other's, with the other's work, logins and
 * hostd address. A container with no label is from before installs were
 * named, and belongs to the default install.
 */
export const INSTALL_LABEL = 'fleetadlc.install';
/** What a container is to hostd: `computer` for a task's, warm or claimed. */
export const KIND_LABEL = 'fleetadlc.kind';
/** The repository a computer was made for (`repoKeyOf`), or `none`: its cache volume. */
export const REPO_LABEL = 'fleetadlc.repo';
/** The task directory a computer mounts at its own path, where its slot file says whose it is. */
export const SLOT_LABEL = 'fleetadlc.slot';
/** The install `fleetadlc up` runs, which keeps the names every install had before. */
export const DEFAULT_INSTALL = 'default';

/** A container is not this install's, and is left exactly as it is. */
export class NotThisInstall extends Error {
  constructor(name: string, owner: string, mine: string) {
    super(
      `${name} belongs to install ${owner}, and this hostd is install ${mine}: it will not reuse or remove it. ` +
        `Give this install names of its own with FLEETADLC_BOT_PREFIX (and FLEETADLC_INSTALL_ID).`,
    );
    this.name = 'NotThisInstall';
  }
}
const TOOLS = 'gh-shim-1';
/**
 * How many processes one task's container may run. The engine CLIs' own
 * sandboxes are off inside a container (FLEETADLC_CONTAINED), so a runaway or
 * prompt-injected task could fork until hostd and every other task on the host
 * had no process slots left. High enough for parallel builds and test runners.
 */
export const TASK_PIDS_LIMIT = 4096;
/** What HARDENING_LABEL says; changed whenever the flags `runComputer` adds for it are. */
const HARDENING = `pids-${TASK_PIDS_LIMIT}+no-new-privileges`;
const EGRESS_VERSION = 2;
/** What a computer is given when its seat says nothing: the sizes every container had before seats said. */
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY_GB = 4;

function egressLabel(proxy: string | undefined): string {
  return proxy ? `${proxy}#${EGRESS_VERSION}` : 'none';
}

/**
 * `docker` with something written to its stdin — a signing key for `ssh-add -`,
 * which is how the key reaches the container without touching its disk.
 */
function dockerWithInput(args: string[], input: string, env: NodeJS.ProcessEnv | undefined): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * How long a docker call that should answer at once — a listing, an inspect, a
 * `tmux` command in a container, a removal — may take. Docker Desktop after a
 * Mac wakes can stop answering without refusing, and with no limit every
 * observer tick parked on its first call while the next one started: hung
 * docker processes piled up by the hundred. Never given to `make setup`, a
 * clone, `docker run` or image work, which take as long as they take.
 */
export const DOCKER_QUICK_TIMEOUT_MS = 30_000;

export interface DockerCallOptions {
  /** Kill the docker client after this long; see DOCKER_QUICK_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** A docker call that should answer at once. */
const QUICK: DockerCallOptions = { timeoutMs: DOCKER_QUICK_TIMEOUT_MS };

export type DockerRunner = (
  args: string[],
  input?: string,
  secrets?: Record<string, string>,
  options?: DockerCallOptions,
) => Promise<DockerResult>;

/**
 * Asks Docker. `secrets` are added to the docker client's own environment, for
 * an argument that names a variable with `-e NAME` and leaves its value out:
 * a value on the command line is in the host's process list for anyone to read.
 */
export async function docker(
  args: string[],
  input?: string,
  secrets?: Record<string, string>,
  options: DockerCallOptions = {},
): Promise<DockerResult> {
  const env = secrets ? { ...process.env, ...secrets } : undefined;
  if (input !== undefined) return dockerWithInput(args, input, env);
  const timeout = options.timeoutMs ? { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const } : {};
  try {
    const { stdout, stderr } = await run('docker', args, { maxBuffer: 16 * 1024 * 1024, ...timeout, ...(env ? { env } : {}) });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };
    if (options.timeoutMs && failure.killed && failure.signal === 'SIGKILL') {
      return {
        code: 1,
        stdout: failure.stdout ?? '',
        stderr: `docker did not answer within ${options.timeoutMs / 1000} s; is the Docker daemon running?`,
      };
    }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

/**
 * Both spellings, because the tools inside disagree: curl and git read the
 * lowercase names, most Node and Rust clients the uppercase ones.
 */
export function proxyEnv(proxy: string | undefined): string[] {
  return Object.entries(egressProxyEnv(proxy ?? '')).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

/**
 * For a container hostd starts for a moment rather than a task's own — a
 * sign-in, a model check, an engine update. It sits on Docker's default
 * network with no route out on the cloud host but the proxy, so it gets the
 * proxy and the name that reaches it. Without these the first cloud install's
 * xAI sign-in timed out: the check's every connection was refused at the
 * firewall.
 */
export function probeNetworkArgs(proxy: string | undefined = process.env.FLEETADLC_BOT_EGRESS_PROXY || undefined): string[] {
  if (!proxy) return [];
  return ['--add-host', 'host.docker.internal:host-gateway', ...proxyEnv(proxy)];
}

/** What a task's database is made and dropped with; see `TaskDatabases`. */
export interface TaskDatabaseServer {
  create(taskId: string): Promise<string>;
  drop(taskId: string): Promise<void>;
  /** The URL `create` returned for the task, rebuilt; null when it has no database. See `TaskDatabases.urlFor`. */
  urlFor(taskId: string): Promise<string | null>;
}

export interface DockerDriverOptions {
  image: string;
  /**
   * The forward proxy a task's traffic leaves through, as the container sees
   * it (`http://host.docker.internal:3128`). On the cloud host the firewall
   * rejects everything a container sends that is not to a private address, so
   * without this a task there reaches neither GitHub nor its engine. Unset
   * locally.
   */
  egressProxy?: string;
  /** Where OpenADLC's `gh` is on the host; GH_SHIM_DIR unless a test says otherwise. */
  ghShimDir?: string;
  /**
   * What seat containers and networks were named after, before a task had
   * its own: only to retire them (`retireSeatContainers`).
   */
  networkPrefix?: string;
  /**
   * What this install's containers are named after: nothing for the default
   * install (`task-<id8>`), `FLEETADLC_BOT_PREFIX` for another install on the
   * same daemon (`<prefix>task-<id8>`); without one, a second install would
   * give its tasks the names the first already uses. Seat containers were `<prefix><bot>`, `bot-` by
   * default.
   */
  botPrefix?: string;
  /** This install's name on its containers (`INSTALL_LABEL`); the default install when absent. */
  installId?: string;
  /**
   * The bundled skill runner, mounted read-only into every task's container at
   * `CONTAINER_RUNNER`. One self-contained file, so the task gets the runner
   * and nothing else — not the workspace, and not `config/`.
   */
  runnerBundle: string;
  /**
   * Where hostd keeps mirrors, task directories and caches. A task's own
   * directory under it (`TaskComputer.slotDir`) is mounted into its container
   * at the same absolute path, so every path hostd hands a session — its
   * working directory, its briefing — is one the session can open.
   */
  workRoot: string;
  skillsRoot: string;
  rolesRoot: string;
  hostdUrl: string;
  /**
   * Where each OpenAI or xAI subscription's login directory lives. One of
   * them is mounted into a task's container at `CONTAINER_LOGIN` when its
   * account is that subscription, and none otherwise.
   */
  loginRoot: string;
  /** The host's task database server; without one no task gets a database. */
  databases?: TaskDatabaseServer;
  /** The install's private registry and its token, for filling a repository's pnpm store; see `PnpmStore`. */
  registry?: () => Promise<{ host: string; token: string } | null>;
  /** How Docker is asked. A test answers for it; everything else uses the CLI. */
  docker?: DockerRunner;
}

/** A task's computer as hostd holds it, with the sessions seen in it. */
interface Held {
  computer: TaskComputer;
  sessions: Set<string>;
}

/** What `docker container inspect` says, as far as a computer goes. */
interface Inspected {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  image: string | null;
}

/**
 * This task's home, not the account's login directory. See `taskLoginMounts`.
 */
export function loginMounts(loginDir: string, slotDir: string, provider: DeviceProvider): string[] {
  return taskLoginMounts(loginDir, slotDir, provider);
}

/**
 * A container per task, made when the task starts and removed when it ends
 * (and, for a task paused on a person, a while after it pauses). The seat is
 * the task's GitHub identity, never its computer: two tasks of one seat run in
 * two containers, and no task's container outlives its task.
 *
 * Every computer sits on one network per install, `fleetadlc-tasks`, made with
 * inter-container traffic off, so one task cannot reach another's processes;
 * a network per task would exhaust the address pools Docker has (about 31 by
 * default) at the first busy afternoon. Each mounts its own task directory at
 * the same path as on the host, its repository's cache volume at `/cache`,
 * its repository's pnpm store at `/pnpm-store` read-only, the skills,
 * playbooks, runner and `gh` read-only, and its account's login
 * when it needs one. Its database is a database of its own on the host's
 * task database server (`TaskDatabases`).
 */
export class DockerDriver implements ExecDriver {
  readonly kind = 'docker' as const;
  private readonly docker: DockerRunner;
  /** Each task's computer, and the sessions seen in it. */
  private readonly held = new Map<string, Held>();
  private network: Promise<void> | null = null;
  /** Computers made ahead of their task; see `WarmPool`. None unless `usePool` was called. */
  private pool: WarmPool | null = null;
  private pnpmStore: PnpmStore | null = null;

  constructor(private readonly options: DockerDriverOptions) {
    this.docker = options.docker ?? docker;
  }

  /**
   * Where the container sees its home: the same path for every task, and no
   * path of the host's. Each task mounts its own directory here, so this is
   * what `CODEX_HOME` or `GROK_HOME` says inside the container. The sign-in
   * file is not in that directory; Codex's mount and `GROK_AUTH_PATH` name it.
   */
  loginPath(accountId: string): string {
    if (!isAccountId(accountId)) throw new Error(`${JSON.stringify(accountId)} is not a model account id`);
    return CONTAINER_LOGIN;
  }

  private get install(): string {
    return this.options.installId ?? DEFAULT_INSTALL;
  }

  /** `task-` for the default install, `<prefix>task-` for another. */
  get taskPrefix(): string {
    return this.options.botPrefix ? `${this.options.botPrefix}task-` : 'task-';
  }

  /** `warm-` for the default install, `<prefix>warm-` for another. */
  get warmPrefix(): string {
    return this.options.botPrefix ? `${this.options.botPrefix}warm-` : 'warm-';
  }

  /** The install's one network for task computers. */
  get networkName(): string {
    return this.options.botPrefix ? `${this.options.botPrefix}tasks` : 'fleetadlc-tasks';
  }

  /** A repository's cache volume, shared by its tasks on this host and no other repository's. */
  cacheVolume(repoKey: string): string {
    return `fleetadlc-cache-${this.install}-${repoKey}`;
  }

  /**
   * The repository's pnpm store, filled by hostd from the task's lockfile; its
   * computers mount it read-only. See `PnpmStore`.
   */
  fillPnpmStore(computer: TaskComputer, worktree: string): Promise<PnpmFill> {
    if (!computer.repoKey) return Promise.resolve({ filled: false, skipped: true, reason: 'the task is on no repository' });
    this.pnpmStore ??= new PnpmStore({
      docker: this.docker,
      image: this.options.image,
      install: this.install,
      workRoot: this.options.workRoot,
      cacheVolume: (repoKey) => this.cacheVolume(repoKey),
      networkArgs: probeNetworkArgs(this.options.egressProxy),
      labels: [`${INSTALL_LABEL}=${this.install}`, `${KIND_LABEL}=pnpm-fill`],
      ...(this.options.registry ? { registry: this.options.registry } : {}),
    });
    return this.pnpmStore.fill({ repoKey: computer.repoKey, worktree });
  }

  /** The sources of the read-only mounts, as one label value; see MOUNTS_LABEL. */
  private mountsLabel(): string {
    return [this.options.skillsRoot, this.options.rolesRoot, this.options.runnerBundle, this.options.ghShimDir ?? GH_SHIM_DIR].join(':');
  }

  /**
   * Refuses a container another install made. Asked before one is reused or
   * removed: the name is only a name, and on a daemon two installs share, it
   * can be the other install's.
   */
  private async assertOurs(name: string, quick: DockerCallOptions = {}): Promise<Inspected | null> {
    const found = await this.inspect(name, quick);
    if (!found) return null;
    const owner = found.labels[INSTALL_LABEL] ?? DEFAULT_INSTALL;
    if (owner !== this.install) throw new NotThisInstall(name, owner, this.install);
    return found;
  }

  private async inspect(name: string, quick: DockerCallOptions = {}): Promise<Inspected | null> {
    const result = await this.docker(['container', 'inspect', name], undefined, undefined, quick);
    if (result.code !== 0) return null;
    try {
      const [entry] = JSON.parse(result.stdout) as Array<{
        Name?: string;
        State?: { Status?: string };
        Config?: { Labels?: Record<string, string> | null };
        Image?: string;
      }>;
      return {
        name: (entry?.Name ?? name).replace(/^\//, ''),
        running: entry?.State?.Status === 'running',
        labels: entry?.Config?.Labels ?? {},
        image: entry?.Image ?? null,
      };
    } catch {
      // Unreadable is not ours to touch either.
      throw new NotThisInstall(name, 'unknown', this.install);
    }
  }

  /** The id an image reference resolves to now, or null when it is not on this host yet. */
  async imageId(image: string = this.options.image): Promise<string | null> {
    const result = await this.docker(['image', 'inspect', '-f', '{{.Id}}', image]);
    const id = result.stdout.trim();
    return result.code === 0 && id ? id : null;
  }

  /**
   * The install's network for task computers, made once with
   * inter-container traffic off. One that exists is used as it is: its
   * options cannot be changed while anything is attached, so one made
   * without the setting is said once rather than recreated under running
   * tasks.
   */
  ensureNetwork(): Promise<void> {
    this.network ??= (async () => {
      const name = this.networkName;
      const found = await this.docker(['network', 'inspect', name]);
      if (found.code !== 0) {
        const made = await this.docker([
          'network',
          'create',
          '--driver',
          'bridge',
          '--opt',
          'com.docker.network.bridge.enable_icc=false',
          '--label',
          `${INSTALL_LABEL}=${this.install}`,
          name,
        ]);
        if (made.code !== 0) throw new Error(`could not create the ${name} network: ${made.stderr.trim().slice(0, 200)}`);
        return;
      }
      let entry: { Options?: Record<string, string> | null; Labels?: Record<string, string> | null } | undefined;
      try {
        [entry] = JSON.parse(found.stdout) as Array<typeof entry>;
      } catch {
        entry = undefined;
      }
      const owner = entry?.Labels?.[INSTALL_LABEL] ?? DEFAULT_INSTALL;
      if (owner !== this.install) throw new NotThisInstall(name, owner, this.install);
      if (entry?.Options?.['com.docker.network.bridge.enable_icc'] !== 'false') {
        console.warn(
          `[hostd] ${name} lets its containers reach each other; remove it (docker network rm ${name}) while no task runs, and hostd makes it again without that`,
        );
      }
    })().catch((error: unknown) => {
      this.network = null;
      throw error;
    });
    return this.network;
  }

  /**
   * The name a task's container gets: `task-<id8>`, or more of the id when
   * another task already has that — two ids that share eight characters are
   * rare, and one container taking the other's would be a disaster. A
   * container of the same task, left by a computer that was never released, is
   * taken down first: the task's directory, and so its work, stays.
   */
  private async nameFor(taskId: string): Promise<string> {
    const id = taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const length of [8, 12, id.length]) {
      const name = `${this.taskPrefix}${id.slice(0, length)}`;
      const found = await this.assertOurs(name);
      if (!found) return name;
      const slot = found.labels[SLOT_LABEL];
      // Only by the record hostd wrote beside its directory: one inside it is
      // the task's to write, and could name any task.
      const record = slot ? readSlotTask(slot) : null;
      if (record && !record.inDirectory && record.taskId === taskId) {
        await this.docker(['rm', '-f', '-v', name]);
        return name;
      }
    }
    throw new Error(`task ${taskId} has no container name left that is not another task's`);
  }

  /**
   * A task's computer, made cold: a container with the task's own
   * directory, its repository's cache, its account's login if it needs one,
   * and its seat's size; and a database of its own when its seat runs checks.
   *
   * The record beside its directory says whose it is (`writeSlotTask`), so
   * hostd finds the task again after a restart: a container's labels are
   * fixed when it is made, and a warm one is made before its task is known.
   * Beside it, not in it: the directory is mounted, and the task could write
   * a record there.
   */
  async acquire(spec: TaskComputerSpec): Promise<TaskComputer> {
    await this.ensureNetwork();
    const name = await this.nameFor(spec.taskId);
    const claimed = await this.claimWarm(spec, name);
    if (claimed) return claimed;

    // Docker creates a missing bind-mount source as root, which then refuses
    // the `bot` user inside. hostd owns this directory, so hostd makes it.
    mkdirSync(spec.slotDir, { recursive: true });
    writeSlotTask(spec.slotDir, { taskId: spec.taskId, bot: spec.bot });
    await this.runComputer({
      name,
      slotDir: spec.slotDir,
      repoKey: spec.repoKey,
      login: spec.login?.accountId.toLowerCase() ?? 'none',
      // Read, never defaulted: a Grok task that fell back to OpenAI got no
      // sign-in directory and no GROK_AUTH_PATH. `runComputer` refuses a
      // login without one.
      provider: spec.login?.provider ?? null,
      cpus: spec.cpus,
      memoryGb: spec.memoryGb,
      why: `task ${spec.taskId}`,
    });

    const computer = await this.prepare(spec, name);
    this.held.set(spec.taskId, { computer, sessions: new Set() });
    return computer;
  }

  /** Lets acquire claim computers made ahead of their task. */
  usePool(pool: WarmPool): void {
    this.pool = pool;
  }

  /** Whether a container is a warm computer nobody has claimed. */
  isWarm(name: string): boolean {
    return this.pool?.holds(name) ?? false;
  }

  /** Brings the warm pool to its targets, when there is one. */
  async refreshWarm(): Promise<void> {
    await this.pool?.fill();
  }

  /**
   * A warm computer made for this task's repository, claimed: sized to the
   * seat with `docker update`, named the task's with `docker rename`, and told
   * whose it is in its folder — the three things about a container that can
   * change once it exists. Its folder is the one it was made with, which is
   * why the computer says where its folder is. Null when the pool has none for
   * this repository, or for a task whose account needs a login, which no warm
   * computer holds; anything that goes wrong in the claim discards it and the
   * task starts cold.
   */
  private async claimWarm(spec: TaskComputerSpec, name: string): Promise<TaskComputer | null> {
    if (!this.pool?.enabled || spec.login) return null;
    const warm = this.pool.take({ repoKey: spec.repoKey }, await this.imageId());
    if (!warm) return null;
    const memory = Math.round(spec.memoryGb * 1024 ** 3);
    const steps: string[][] = [
      ['update', '--cpus', String(spec.cpus), '--memory', String(memory), '--memory-swap', String(memory * 2), warm.name],
      ['rename', warm.name, name],
    ];
    for (const step of steps) {
      const result = await this.docker(step);
      if (result.code !== 0) {
        console.warn(`[hostd] could not claim ${warm.name} for task ${spec.taskId}; starting it cold: ${result.stderr.trim().slice(0, 200)}`);
        // Still under its warm name whichever step failed: rename is the last.
        await this.discard(warm.name).catch(() => undefined);
        void this.pool.fill();
        return null;
      }
    }
    writeSlotTask(warm.slotDir, { taskId: spec.taskId, bot: spec.bot });
    const computer = await this.prepare({ ...spec, slotDir: warm.slotDir }, name);
    this.held.set(spec.taskId, { computer, sessions: new Set() });
    // Its place in the pool is made again for the next task, not awaited.
    void this.pool.fill();
    return computer;
  }

  /**
   * A computer for the pool: the image in use, the repository's cache, no
   * login, and the driver's default size until a claim gives it its seat's.
   * Its folder is `slots/<its name>`, mounted at its own path like any task's.
   */
  async makeWarm(key: WarmKey): Promise<WarmComputer> {
    await this.ensureNetwork();
    const name = `${this.warmPrefix}${randomBytes(4).toString('hex')}`;
    const slotDir = resolve(this.options.workRoot, 'slots', name);
    mkdirSync(slotDir, { recursive: true });
    await this.runComputer({ name, slotDir, repoKey: key.repoKey, login: 'none', provider: null, cpus: DEFAULT_CPUS, memoryGb: DEFAULT_MEMORY_GB, why: 'the warm pool' });
    // npm's cache only; the pnpm store is mounted read-only and only hostd's filler writes it.
    if (key.repoKey) await this.docker(['exec', '-u', '0', name, 'chown', 'bot:bot', CONTAINER_CACHE]);
    return { name, repoKey: key.repoKey, slotDir, image: await this.imageId(), madeAt: Date.now() };
  }

  /**
   * One computer's container: on the install's network, its folder at its own
   * path, its repository's cache and its login if it has one, the read-only
   * mounts, and labels saying what it was made with.
   */
  private async runComputer(input: {
    name: string;
    slotDir: string;
    repoKey: string | null;
    login: string;
    provider: DeviceProvider | null;
    cpus: number;
    memoryGb: number;
    why: string;
  }): Promise<void> {
    const image = await this.imageId();
    // A home of this computer's own. The account's sign-in directory is
    // mounted only at CONTAINER_AUTH, for a Grok task's rename of auth.json,
    // and only when that file is a regular file. A Codex task file-mounts
    // auth.json and gets no directory. Nothing at all for a key or another seat.
    if (input.login !== 'none' && !input.provider) {
      throw new Error(`${input.why}: its seat's subscription names no provider, so hostd cannot tell how to mount its sign-in`);
    }
    const loginMount =
      input.login !== 'none' && input.provider ? loginMounts(ensureLoginDir(this.options.loginRoot, input.login), input.slotDir, input.provider) : [];
    const authEnv = loginMount.some((arg) => arg.endsWith(`:${CONTAINER_AUTH}`)) ? ['-e', `GROK_AUTH_PATH=${CONTAINER_AUTH}/auth.json`] : [];
    // The cache is npm's, read-write. The pnpm store is read-only: pnpm trusts
    // its own index for a package it holds, so one task writing it could plant
    // code the next one runs. Only hostd fills it (`PnpmStore`).
    const cacheMount = input.repoKey
      ? ['-v', `${this.cacheVolume(input.repoKey)}:${CONTAINER_CACHE}`, '-v', `${pnpmStoreVolume(this.install, input.repoKey)}:${CONTAINER_PNPM_STORE}:ro`]
      : [];

    const made = await this.docker([
      'run',
      '-d',
      '--name',
      input.name,
      '--network',
      this.networkName,
      // Everything the session reports — state, usage, gates, and the
      // registry credential it installs with — goes to hostd or the bridge on
      // the host, and its database is published on the host's gateway.
      // Docker Desktop resolves this alias on its own; Linux does not, and
      // without it the session's first call is refused and the task looks
      // like it did nothing.
      '--add-host',
      'host.docker.internal:host-gateway',
      // The seat's own size (config/bots.yaml, stored on its row).
      '--cpus',
      String(input.cpus),
      '--memory',
      `${Math.round(input.memoryGb * 1024 ** 3)}`,
      // A fork bomb hits this container's limit, not the host's. And setuid
      // binaries in the image (su, mount, passwd) no longer raise privileges;
      // hostd's own `docker exec -u 0` is not affected, so it still owns the
      // cache. Not `--cap-drop ALL`: that chown needs CHOWN.
      '--pids-limit',
      String(TASK_PIDS_LIMIT),
      '--security-opt',
      'no-new-privileges:true',
      '--label',
      `${INSTALL_LABEL}=${this.install}`,
      '--label',
      `${KIND_LABEL}=computer`,
      '--label',
      `${LOGIN_LABEL}=${input.login}`,
      '--label',
      `${REPO_LABEL}=${input.repoKey ?? 'none'}`,
      '--label',
      `${SLOT_LABEL}=${input.slotDir}`,
      '--label',
      `${EGRESS_LABEL}=${egressLabel(this.options.egressProxy)}`,
      '--label',
      `${TOOLS_LABEL}=${TOOLS}`,
      '--label',
      `${MOUNTS_LABEL}=${this.mountsLabel()}`,
      '--label',
      `${HARDENING_LABEL}=${HARDENING}`,
      ...(image ? ['--label', `${IMAGE_LABEL}=${image}`] : []),
      // The task's own directory at the path it has on the host: its clone,
      // its briefing and its home. Nothing else of the work root, so a task
      // sees no other task's files and no mirror.
      '-v',
      `${input.slotDir}:${input.slotDir}`,
      ...cacheMount,
      ...loginMount,
      '-v',
      `${this.options.skillsRoot}:/skills:ro`,
      '-v',
      `${this.options.rolesRoot}:${ROLES_IN_CONTAINER}:ro`,
      // The runner itself. Read live rather than copied, so rebuilding it is
      // picked up by the next task.
      '-v',
      `${this.options.runnerBundle}:${CONTAINER_RUNNER}:ro`,
      // OpenADLC's own `gh`, first on the session's PATH; see GH_SHIM_DIR.
      '-v',
      `${this.options.ghShimDir ?? GH_SHIM_DIR}:${CONTAINER_GH_SHIM_DIR}:ro`,
      '-e',
      `HOSTD_URL=${this.options.hostdUrl}`,
      ...authEnv,
      ...proxyEnv(this.options.egressProxy),
      this.options.image,
    ]);
    if (made.code !== 0) {
      throw new Error(`could not start a computer for ${input.why}: ${made.stderr.trim().slice(0, 300)}`);
    }
  }

  /**
   * What a computer needs before its task: its cache volume made writable by
   * the bot (Docker creates a new volume's mount point as root, and the image
   * has no `/cache` to copy the owner from), and its database.
   */
  protected async prepare(spec: TaskComputerSpec, name: string): Promise<TaskComputer> {
    if (spec.repoKey) await this.docker(['exec', '-u', '0', name, 'chown', 'bot:bot', CONTAINER_CACHE]);
    let databaseUrl: string | null = null;
    if (spec.database && this.options.databases) {
      // A task whose database could not be made runs without one: its checks
      // say so.
      databaseUrl = await this.options.databases.create(spec.taskId).catch((error: unknown) => {
        console.warn(`[hostd] task ${spec.taskId} gets no database: ${error instanceof Error ? error.message : error}`);
        return null;
      });
    }
    return {
      taskId: spec.taskId,
      bot: spec.bot,
      container: name,
      databaseUrl,
      slotDir: spec.slotDir,
      cacheDir: spec.repoKey ? CONTAINER_CACHE : null,
      repoKey: spec.repoKey,
    };
  }

  /**
   * The task's container removed — its sessions, its signing agent and
   * whatever it ran go with it — its database dropped, and its directory
   * removed, once. Only a directory under the work root is ever removed.
   */
  async release(taskId: string, reason?: string): Promise<void> {
    void reason;
    const held = this.held.get(taskId);
    await this.options.databases?.drop(taskId).catch(() => undefined);
    if (!held) return;
    const slotDir = held.computer.slotDir;
    if (held.computer.container) {
      await this.assertOurs(held.computer.container);
      // `-v`: the image declares /work a volume, and a container removed
      // without it leaves an anonymous volume behind for every task.
      const removed = await this.docker(['rm', '-f', '-v', held.computer.container]);
      if (removed.code !== 0 && (await this.inspect(held.computer.container))) {
        throw new Error(`docker would not remove ${held.computer.container}: ${removed.stderr.trim().slice(0, 200)}`);
      }
    }
    this.held.delete(taskId);
    // After the container is gone, and it must not throw: a home replaced
    // with a file used to throw here, the container was still running, and
    // the reaper skipped it because it was still held.
    forgetTaskLogin(this.options.loginRoot, slotDir);
    const root = resolve(this.options.workRoot);
    const dir = resolve(held.computer.slotDir);
    if (dir.startsWith(`${root}${sep}`)) removeSlot(dir);
  }

  computerOf(taskId: string): TaskComputer | null {
    return this.held.get(taskId)?.computer ?? null;
  }

  /**
   * This install's computers on the daemon, for the reaper: every container
   * labelled as one, with the task its slot's record names. That is a claim
   * the reaper checks against the task's row (`reapComputers`): a computer
   * started before records moved out of its directory has only the one the
   * task could write.
   */
  async computers(): Promise<FoundComputer[]> {
    const listed = await this.docker(
      ['ps', '-a', '--filter', `label=${INSTALL_LABEL}=${this.install}`, '--filter', `label=${KIND_LABEL}=computer`, '--format', '{{.Names}}'],
      undefined,
      undefined,
      QUICK,
    );
    if (listed.code !== 0) return [];
    const found: FoundComputer[] = [];
    for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const container = await this.inspect(name, QUICK).catch(() => null);
      if (!container) continue;
      const slotDir = container.labels[SLOT_LABEL] ?? null;
      const record = slotDir ? readSlotTask(slotDir) : null;
      found.push({
        name: container.name,
        kind: container.name.startsWith(this.warmPrefix) && !record ? 'warm' : 'task',
        taskId: record?.taskId ?? null,
        bot: record?.bot ?? null,
        slotDir,
        running: container.running,
        image: container.image,
        repoKey: container.labels[REPO_LABEL] && container.labels[REPO_LABEL] !== 'none' ? container.labels[REPO_LABEL] : null,
      });
    }
    return found;
  }

  /**
   * A computer found running with nothing held for it — hostd restarted, and
   * its task's session never stopped — taken back, so the task's sessions are
   * listed, attachable and released as if hostd had never gone.
   */
  async adopt(found: FoundComputer): Promise<TaskComputer | null> {
    if (!found.taskId || !found.bot || !found.slotDir) return null;
    const existing = this.held.get(found.taskId);
    if (existing) return existing.computer;
    const computer: TaskComputer = {
      taskId: found.taskId,
      bot: found.bot,
      container: found.name,
      // The session has its database in its environment, but local CI runs
      // through `docker exec`, which does not inherit it: rebuilt from the
      // install's secret and the task id, as `create` made it. Null with no
      // task database server, or for a task started without a database.
      databaseUrl: (await this.options.databases?.urlFor(found.taskId).catch(() => null)) ?? null,
      slotDir: found.slotDir,
      cacheDir: found.repoKey ? CONTAINER_CACHE : null,
      repoKey: found.repoKey,
    };
    const sessions = new Set<string>();
    if (found.running) {
      const listed = await this.tmuxIn(found.name).listSessions().catch(() => []);
      for (const session of listed) if (session.name !== IDLE_SHELL) sessions.add(session.name);
    }
    this.held.set(found.taskId, { computer, sessions });
    return computer;
  }

  /**
   * Removes a container the reaper found that holds nothing a task needs: one
   * whose task is over, or that no task row names.
   */
  async discard(name: string): Promise<void> {
    if (!name.startsWith(this.taskPrefix) && !name.startsWith(this.warmPrefix)) return;
    await this.assertOurs(name, QUICK);
    const slotDir = (await this.inspect(name, QUICK).catch(() => null))?.labels[SLOT_LABEL];
    await this.docker(['rm', '-f', '-v', name], undefined, undefined, QUICK);
    // The home is not in the slot, so the leftover-slot sweep does not reach
    // it. An earlier build also left a copy of the token under `.running`.
    if (slotDir) forgetTaskLogin(this.options.loginRoot, slotDir);
    // A warm computer's folder is named after it, and nothing else removes it.
    if (name.startsWith(this.warmPrefix)) removeSlot(resolve(this.options.workRoot, 'slots', name));
  }

  /**
   * After the engine update swaps the image: a computer is made from the
   * image at its task's start, so new tasks run on the new one and a running
   * task finishes on the one it started with. What is left is the images
   * nothing uses any more.
   */
  async refreshComputers(): Promise<{ refreshed: string[]; deferred: string[] }> {
    const current = await this.imageId();
    // Warm computers on the old image are drained and made again on the new.
    const before = new Set(this.pool?.list().map((warm) => warm.name) ?? []);
    await this.pool?.fill();
    const drained = [...before].filter((name) => !this.pool?.holds(name));
    const deferred = new Set<string>();
    for (const held of this.held.values()) {
      const found = held.computer.container ? await this.inspect(held.computer.container).catch(() => null) : null;
      if (found && current && found.image && found.image !== current) deferred.add(held.computer.bot);
    }
    await this.docker(['image', 'prune', '-f']);
    return { refreshed: drained, deferred: [...deferred] };
  }

  /**
   * Seat containers from before a task had its own, retired at hostd's start
   * for each seat with nothing running in it; see `retireSeatContainers`.
   */
  retireSeats(seats: readonly { name: string; busy: boolean }[]): ReturnType<typeof retireSeatContainers> {
    return retireSeatContainers({
      docker: (args) => this.docker(args),
      install: this.install,
      botPrefix: this.options.botPrefix ?? 'bot-',
      networkPrefix: this.options.networkPrefix ?? 'fleetadlc-bot',
      seats,
      log: (line) => console.log(line),
    });
  }

  /**
   * The agent inside the task's container, where its sessions are.
   *
   * hostd used to start it on the host and hand the session a socket path the
   * container had never heard of — and Docker Desktop cannot share a host
   * socket into a container anyway. So `git commit` in the container found no
   * key, a branch protected by required signatures could take nothing, and a
   * builder that had finished its work stopped at the commit. The key goes in
   * through `ssh-add -` on stdin, so it is never written to the container's
   * disk; the agent runs as the bot, like the sessions that use it, and dies
   * with the container. Until then it is stopped by the PID it printed:
   * `ssh-agent -k` with only the socket set refused, and stopped nothing.
   */
  async startSigningAgent(computer: TaskComputer, privateKey: string): Promise<SigningAgent | null> {
    const bot = computer.bot;
    const container = computer.container;
    if (!container) return null;
    const dir = `/tmp/fleetadlc-agent-${randomBytes(8).toString('hex')}`;
    const socket = `${dir}/agent.sock`;
    const withAgent = ['-e', `SSH_AUTH_SOCK=${socket}`];

    const started = await this.docker(['exec', container, 'sh', '-c', `umask 077 && mkdir -p ${dir} && ssh-agent -s -a ${socket}`]);
    if (started.code !== 0) {
      console.warn(`[hostd] ${bot}: could not start a signing agent in ${container}: ${started.stderr.trim().slice(0, 200)}`);
      return null;
    }
    const pid = /SSH_AGENT_PID=(\d+)/.exec(started.stdout)?.[1] ?? null;
    const stop = async (): Promise<void> => {
      // By its PID, or, if it did not print one, by its socket, which is this task's alone.
      await this.docker(
        pid
          ? ['exec', ...withAgent, '-e', `SSH_AGENT_PID=${pid}`, container, 'ssh-agent', '-k']
          : ['exec', container, 'pkill', '-f', `ssh-agent -s -a ${socket}`],
      );
      await this.docker(['exec', container, 'rm', '-rf', dir]);
    };

    const added = await this.docker(
      ['exec', '-i', ...withAgent, container, 'ssh-add', '-'],
      privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`,
    );
    const listed = added.code === 0 ? await this.docker(['exec', ...withAgent, container, 'ssh-add', '-L']) : added;
    const publicKey = listed.code === 0 ? (listed.stdout.trim().split('\n')[0] ?? '') : '';
    if (!publicKey) {
      console.warn(`[hostd] ${bot}: the signing key did not load into its agent: ${listed.stderr.trim().slice(0, 200)}`);
      await stop();
      return null;
    }
    const keygen = await this.docker(['exec', container, 'sh', '-c', 'command -v ssh-keygen']);
    return { socket, publicKey, signer: keygen.code === 0 ? keygen.stdout.trim() || null : null, stop };
  }

  private tmuxIn(container: string): Tmux {
    return new Tmux(
      'tmux',
      (args) => ({ command: 'docker', args: ['exec', container, 'tmux', ...args] }),
      (_command, args) => this.docker(args, undefined, undefined, QUICK),
    );
  }

  /** The computers a bot holds here. */
  private heldBy(bot: string): Held[] {
    return [...this.held.values()].filter((held) => held.computer.bot === bot);
  }

  /** The container a bot's session is in, from what has been seen of each computer. */
  private containerOf(bot: string, session: string): string | null {
    return this.heldBy(bot).find((held) => held.sessions.has(session))?.computer.container ?? null;
  }

  /**
   * Nothing under docker: a bot has no computer of its own between tasks, so
   * there is nothing to bring up. A task's computer is made by `acquire`.
   */
  async ensureBot(bot: string): Promise<void> {
    void bot;
  }

  /**
   * Every task computer the bot holds, and the container it had as a seat
   * when there still is one — used when a bot is renamed, since sessions are
   * named after it. Its work folder is left where it is.
   */
  async removeBot(bot: string): Promise<void> {
    for (const held of this.heldBy(bot)) await this.release(held.computer.taskId, `${bot} is being renamed`);
    await this.retireSeats([{ name: bot, busy: false }]);
  }

  async startSession(input: {
    computer: TaskComputer;
    name: string;
    cwd: string;
    command: string[];
    env: Record<string, string>;
  }): Promise<SessionHandle> {
    const bot = input.computer.bot;
    const container = input.computer.container;
    if (!container) throw new Error(`task ${input.computer.taskId} has no container to start a session in`);
    const tmux = this.tmuxIn(container);
    this.held.get(input.computer.taskId)?.sessions.add(input.name);
    if (await tmux.hasSession(input.name)) await tmux.killSession(input.name);
    await this.docker(['exec', container, 'mkdir', '-p', input.cwd]);
    // The session's environment holds its GitHub token and its database's
    // password. On the `tmux new-session … env -i K=V` command line they were
    // in the host's process list, so it goes on stdin into a file only the bot
    // can read, in the container's memory, which the session's shell reads,
    // removes, and then runs the command with nothing else.
    const envFile = `/dev/shm/fleetadlc-env-${randomBytes(8).toString('hex')}`;
    const wrote = await this.docker(
      ['exec', '-i', container, 'sh', '-c', `umask 077 && cat > ${envFile}`],
      sessionEnvFile(withRepoHome(containerBaseEnv(), input.env)),
    );
    if (wrote.code !== 0) throw new Error(`could not hand session ${input.name} its environment: ${wrote.stderr.trim().slice(0, 200)}`);
    await tmux.newSession({
      name: input.name,
      cwd: input.cwd,
      command: [...FROM_ENV_FILE, envFile, ...input.command],
      env: {},
    });
    const info = await tmux.paneInfo(input.name);
    return { bot, name: input.name, pid: info?.pid ?? null, cmd: input.command.join(' ') };
  }

  /**
   * Every session in every computer the bot holds. The image's own idle shell
   * is left out: each computer has one, and they would all be `shell`.
   *
   * It throws rather than answer for a computer it could not read. A failed
   * `docker exec` read as no sessions, and the observer stopped the task and
   * removed its container with its uncommitted work. A listing without the
   * idle shell is doubtful the same way: a live computer always has one
   * (infra/local/bot-init starts it).
   */
  async listSessions(bot: string): Promise<ObservedSession[]> {
    const observed: ObservedSession[] = [];
    for (const held of this.heldBy(bot)) {
      if (!held.computer.container) continue;
      const container = held.computer.container;
      const tmux = this.tmuxIn(container);
      const listed = await tmux.listSessions().catch((error: unknown) => {
        throw new Error(`could not read sessions in ${container}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!listed.some((session) => session.name === IDLE_SHELL)) {
        throw new Error(`could not read sessions in ${container}: its idle ${IDLE_SHELL} session is missing from the listing`);
      }
      for (const session of listed) {
        if (session.name === IDLE_SHELL) continue;
        held.sessions.add(session.name);
        const info = await tmux.paneInfo(session.name);
        const pane = (await tmux.capturePane(session.name, 200)).filter((line) => line.trim().length > 0);
        const lastLine = pane.at(-1) ?? null;
        observed.push({
          bot,
          name: session.name,
          pid: info?.pid ?? null,
          cmd: info?.cmd ?? '',
          state: stateFromPane(info?.cmd ?? '', lastLine, info?.dead ?? false),
          lastLine,
          pane,
        });
      }
    }
    return observed;
  }

  async capturePane(bot: string, session: string, lines: number): Promise<string[]> {
    const container = this.containerOf(bot, session);
    if (!container) return [];
    return (await this.tmuxIn(container).capturePane(session, lines)).filter((line) => line.trim().length > 0);
  }

  /** A session no computer of the bot's has is already gone, as killing a missing tmux session always was. */
  async killSession(bot: string, session: string): Promise<void> {
    const container = this.containerOf(bot, session);
    if (!container) return;
    await this.tmuxIn(container).killSession(session);
  }

  attachCommand(bot: string, session: string): string[] {
    const container = this.containerOf(bot, session);
    if (!container) throw new Error(`no computer of ${bot}'s has a session ${session}; it may have ended`);
    // The gateway needs no network route into the container: it execs into it.
    return ['docker', 'exec', '-it', container, 'tmux', 'attach', '-t', `=${session}`];
  }

  async exec(target: TaskComputer | { bot: string }, command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const container = 'container' in target ? target.container : null;
    if (!container) {
      return { code: 1, stdout: '', stderr: `${target.bot} has no computer between tasks under the docker driver` };
    }
    const args = ['exec'];
    if (options.cwd) args.push('-w', options.cwd);
    // A command run for a repository (`make setup`) runs in its home too.
    const env = options.env?.FLEETADLC_REPO_HOME ? withRepoHome(containerBaseEnv(), options.env) : (options.env ?? {});
    // A credential (the database URL with its password, the task's token) is
    // named here and valued in the docker client's own environment, so `make
    // setup` and `make ci` do not show it in the host's process list while
    // they run (`credential-env.ts`). The rest stay on the command line: PATH
    // and HOME are the container's, and in the client's environment they
    // would be the docker client's own.
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (isCredentialEnv(key)) {
        secrets[key] = value;
        args.push('-e', key);
      } else {
        args.push('-e', `${key}=${value}`);
      }
    }
    // The deadline is kept inside the container: killing the `docker exec`
    // client here leaves the command running in there. coreutils `timeout`
    // asks it to stop, then kills it, and answers 124 or 137 when it did.
    const limit = options.timeoutMs
      ? ['timeout', `--kill-after=${Math.ceil(KILL_AFTER_MS / 1000)}s`, `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`]
      : [];
    args.push(container, ...limit, ...command);
    const result = Object.keys(secrets).length > 0 ? await this.docker(args, undefined, secrets) : await this.docker(args);
    return options.timeoutMs && (result.code === 124 || result.code === 137) ? { ...result, timedOut: true } : result;
  }
}

export { sessionEnvFile };

/** The tmux session the bot image starts in every container (`bot-init`), which no task runs in. */
export const IDLE_SHELL = 'shell';
