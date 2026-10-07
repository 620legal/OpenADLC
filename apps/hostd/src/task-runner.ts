import { randomBytes } from 'node:crypto';
import type { LocalCiTarget } from './local-ci.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { repoKeyOf } from './drivers/base-env.js';
import { join } from 'node:path';
import { sweepTaskHomes } from '@fleetadlc/backup';
import { bots, leases, modelAccounts, repos, tasks } from '@fleetadlc/db';
import { listProviderModels, modelListCache, type AvailableModel, type ModelListCache } from '@fleetadlc/engines';
import { engineKeyRef, getSecretStore, modelAccountRef } from '@fleetadlc/github';
import { ATTACHMENTS_ENV, leaseExpiryFrom, type Bot, type BotRole, type ContextDocument, type TaskAttachment, type TaskKind } from '@fleetadlc/shared';
import { AttachmentClient, prepareAttachments, writeAttachments } from './task-attachments.js';
import { DEFAULT_SETUP_TIMEOUT_MINUTES, type HostdConfig } from './config.js';
import type { ExecDriver, TaskComputer } from './drivers/types.js';
import type { PnpmFill } from './pnpm-store.js';
import { CONTAINER_RUNNER, DEFAULT_CPUS, DEFAULT_MEMORY_GB } from './drivers/docker.js';
import { ensureLoginDir, loginFor } from './logins.js';
import { resolveTaskModel, subscriptionModels, type SessionModel, type TaskModelAccount } from './model-resolution.js';
import { reachableFromTask } from './reachable.js';
import { SessionEnvMinter } from './session-env.js';
import type { TokenClient } from './token-client.js';
import { BRANCH_GONE, BranchGoneError, setAsideBrief, stoppedForGoneBranch, Worktrees, type LegacyTask } from './worktree.js';
import { ROLES_IN_CONTAINER } from './drivers/docker.js';

/** What the bridge asks hostd to start: the task, its bot and skill, the subject and branch, and what the session is given. */
export interface StartTaskInput {
  taskId: string;
  bot: string;
  repo?: string | null;
  kind: TaskKind;
  subjectRef: string;
  branch?: string | null;
  baseRef?: string;
  skill: string;
  /** What the bridge read from GitHub for this task. */
  context?: ContextDocument[];
  declaredPaths?: string[];
  costCapUsd?: number;
  /** A patch round or verification reuses the branch instead of branching from main. */
  checkoutExistingBranch?: boolean;
  /** A resumed task whose branch was never pushed starts from the base; see `WorktreeRequest`. */
  startFromBaseIfMissing?: boolean;
  /** The header the session's own posts to GitHub start with; the `gh` shim puts it first. */
  postHeader?: string;
  /** Files its work item carries, fetched from the bridge and written beside its context; see `task-attachments.ts`. */
  attachments?: TaskAttachment[];
  /** A review task's part, which the `gh` shim holds an advisory seat to; see `ReviewMode`. */
  reviewMode?: ReviewMode;
  /** A review task's lens, from config/review.yaml, which its brief states with its part. */
  reviewLens?: string;
}

/**
 * What a review task may post. An advisory seat comments, with its verdict in
 * its marker, and the lead decides: OpenADLC's `gh` refuses it an approval or
 * a request for changes (`FLEETADLC_REVIEW_MODE`).
 */
export type ReviewMode = 'lead' | 'blocking' | 'advisory';

/** The kinds of task that write the branch they check out, and so may keep writing what it changes. */
const WRITES_THE_BRANCH: ReadonlySet<TaskKind> = new Set<TaskKind>(['implement', 'patch']);

export interface StartedTask {
  taskId: string;
  session: string;
  worktree: string;
  branch: string | null;
}

interface ActiveTask {
  cleanup: () => Promise<void>;
  /** The computer the task runs in; `release` takes it down. */
  computer: TaskComputer;
  /**
   * The computer was given back while the task was paused on a person
   * (`releasePaused`): its branch is in the mirror, and its resume starts
   * a new computer from there. Nothing of it is running.
   */
  released?: boolean;
  worktree: string;
  mirror: string;
  contextDir: string;
  bot: string;
  session: string;
  kind: TaskKind;
  /** The repository and branch its clone holds, when it has one; what `end` harvests. */
  repoFullName: string | null;
  branch: string | null;
  /**
   * What `make setup` ran with, which `make ci` runs with too (`localCiTarget`);
   * for a computer adopted after a restart, the same URL rebuilt (`adopt`).
   */
  databaseUrl: string | null;
  repoHome: string;
  /** The repository's read-only pnpm store it installs from, or null for a store of its own in its home. */
  pnpmStore: string | null;
  /** What `fleetadlc-install` needs to ask hostd for the registry credential; see `installEnv`. */
  installEnv: Record<string, string>;
}

/** Where a task's computer records which pnpm store its start chose, for a hostd that adopts it after a restart. */
const PNPM_STORE_CHOICE = 'pnpm-store';

function readPnpmStoreChoice(slotDir: string): string | null {
  try {
    return readFileSync(join(slotDir, PNPM_STORE_CHOICE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * A task's tmux session name, which the console shows as `bot/<this>`: the
 * skill, then the first eight characters of the task's id.
 *
 * It was the skill alone, which was unique only while a bot ran one task at a
 * time: two reviews on one seat would both be `pr-review`, the second start
 * killed the first's session (`startSession` replaces one of the same name),
 * and `sessions` keeps one row per bot and name. The id makes it the task's.
 * tmux refuses ':' and '.' in a name, so a skill holding either has them as '-'.
 */
export function sessionNameFor(skill: string, taskId: string): string {
  return `${skill.replace(/[:.]/g, '-')}-${taskId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
}

async function storedSecret(ref: string): Promise<string | null> {
  const stored = (await getSecretStore().get(ref))?.trim() ?? '';
  return stored.length > 0 ? stored : null;
}

async function storedAccount(id: string): Promise<TaskModelAccount | null> {
  const account = await modelAccounts.get(id);
  return account ? { id: account.id, provider: account.provider, kind: account.kind } : null;
}

/**
 * How a task decides which model it will call: the bot's current row, its
 * account, and what that account can reach. The task runner's, and the weekly
 * engine update's when it asks what a task would call from a candidate image —
 * one decision, so the check and the task cannot disagree about the model.
 *
 * `cliModels` is what an xAI seat's CLI lists, which depends on the image the
 * CLI is in; everything else is asked of the provider's API.
 */
export function taskModelChooser(
  options: {
    cliModels?: (accountId: string) => Promise<AvailableModel[]>;
    cache?: ModelListCache;
    account?: (id: string) => Promise<TaskModelAccount | null>;
    secret?: (ref: string) => Promise<string | null>;
  } = {},
): (bot: Pick<Bot, 'name' | 'engine' | 'model' | 'modelAccountId'>) => Promise<SessionModel> {
  const cache = options.cache ?? modelListCache();
  const secret = options.secret ?? storedSecret;
  const { cliModels } = options;
  return (bot) =>
    resolveTaskModel(
      {
        name: bot.name,
        engine: bot.engine,
        model: bot.model,
        modelAccountId: bot.modelAccountId,
      },
      {
        account: options.account ?? storedAccount,
        keyForAccount: (accountId) => secret(modelAccountRef(accountId)),
        keyForBot: (name) => secret(engineKeyRef(name)),
        listModels: listProviderModels,
        // A subscription used to have no list here at all, so a bot on
        // one could only be pinned. A Claude seat's token lists models the
        // way a key does, and an xAI seat's CLI lists them itself.
        subscriptionModels: subscriptionModels({
          tokenFor: (accountId) => secret(modelAccountRef(accountId)),
          listWithToken: (token) => listProviderModels('anthropic', token, fetch, { auth: 'oauth' }),
          ...(cliModels ? { cliModels } : {}),
          cache,
        }),
        cache,
        scripted: process.env.FLEETADLC_SCRIPTED_ENGINES === '1',
      },
    );
}

/**
 * Where a role's playbook is: for hostd to check, and for the session to read.
 *
 * They differ in a container, which mounts the playbooks at `/roles`. The
 * host's path does not exist there, so every bot on the docker driver started
 * with its playbook missing from its prompt — no "You own", no "You never" —
 * and only a warning in a log nobody reads to say so.
 */
export function playbookPaths(
  role: string,
  config: { rolesRoot: string; driver: string },
): { onHost: string; inSession: string } {
  const onHost = join(config.rolesRoot, `${role}.md`);
  return { onHost, inSession: config.driver === 'docker' ? `${ROLES_IN_CONTAINER}/${role}.md` : onHost };
}

/**
 * A task this host cannot start: it already runs as many computers as it was
 * given (`FLEETADLC_HOST_CAPACITY_TASKS`). Each is a container with its seat's
 * CPUs and memory, so one more would take them from the tasks running. The
 * bridge tries it again as it does a busy seat; nothing is recorded as failed.
 */
export class HostFull extends Error {
  readonly status = 503;

  constructor(host: string, capacity: number) {
    super(
      `${host} is running ${capacity} task(s), all it has room for; this one starts when one ends. ` +
        'Give the host more with FLEETADLC_HOST_CAPACITY_TASKS (or a larger machine).',
    );
    this.name = 'HostFull';
  }
}

/** How many times, and how far apart, a new worktree is looked for in its computer. */
const VISIBLE_ATTEMPTS = 4;
const VISIBLE_WAIT_MS = 500;

export class TaskRunner {
  private readonly worktrees: Worktrees;
  private readonly minter: SessionEnvMinter;
  private readonly active = new Map<string, ActiveTask>();
  /** Bots a task is being started on, from the first thing `start` does until the task is held. */
  private readonly starting = new Map<string, number>();
  /**
   * The tasks whose computer is being made: from before its folder exists
   * until the task is held. The driver records a computer only once its
   * container is up and prepared, a few seconds after the folder is made, and
   * the observer's sweep — every ten seconds — took a folder in that window
   * for one nobody held and deleted it. The container kept the deleted folder
   * mounted, the clone went into a new one it could not see, and the start
   * failed with "cannot see its worktree": two of three resumed intakes did.
   * Each by the bot it is for.
   */
  private readonly startingTasks = new Map<string, string>();
  /**
   * Starts a cancel arrived for. A start takes seconds to minutes, and the
   * task is held only at its end: a cancel then found nothing to end, wrote
   * `stopped`, and the start went on to launch the session and write
   * `running` over it. The start looks here between its long steps.
   */
  private readonly cancelledStarts = new Set<string>();
  /** When each task held here was first seen paused; see `releasePausedPast`. */
  private readonly pausedSince = new Map<string, number>();
  /**
   * Paused tasks whose computer is being given back now. The release takes
   * minutes when its harvest waits on the mirror's lock, and it releases by
   * task id: a resume answered in that window started a new computer under
   * the same id, which the release then removed, with the row's host fields.
   * A start waits here first.
   */
  private readonly releasing = new Map<string, Promise<void>>();
  /** This host's row, once hostd has registered it; written on each task it starts. */
  hostId: string | null = null;
  private readonly modelCache: ModelListCache;
  private readonly chooseModel: (bot: Bot) => Promise<SessionModel>;

  constructor(
    private readonly config: HostdConfig,
    private readonly driver: ExecDriver,
    private readonly tokens: TokenClient | null,
    chooseModel?: (bot: Bot) => Promise<SessionModel>,
    /**
     * What an xAI subscription's CLI says it can call: `LoginService.models`.
     * Without it a grok seat has no list, so a pinned id is trusted and
     * `newest:grok` cannot be resolved.
     */
    cliModels?: (accountId: string) => Promise<AvailableModel[]>,
  ) {
    this.worktrees = new Worktrees(config.workRoot);
    // A subscription's login is wherever the driver puts it: a mount point in
    // the container, or the directory itself on the host. Asked of the driver
    // so the variable and the mount cannot disagree.
    this.minter = new SessionEnvMinter(
      getSecretStore(),
      undefined,
      (accountId) => driver.loginPath(accountId),
      // The agent where the sessions are: inside the task's own computer, so
      // it dies with it.
      driver.startSigningAgent
        ? async (_bot, key, taskId) => {
            const computer = driver.computerOf(taskId);
            return computer ? driver.startSigningAgent!(computer, key) : null;
          }
        : undefined,
    );
    // One cache for the life of the process. A task start reads the bot's
    // current model from the database; only the provider's catalogue is
    // remembered, and only for a few minutes.
    this.modelCache = modelListCache();
    this.chooseModel = chooseModel ?? taskModelChooser({ ...(cliModels ? { cliModels } : {}), cache: this.modelCache });
  }

  /**
   * How many computers the bot holds here: tasks held, a paused one only
   * while its computer is kept, and tasks being started.
   */
  heldBy(bot: string): number {
    const held = [...this.active.values()].filter((entry) => entry.bot === bot && !entry.released).length;
    return held + (this.starting.get(bot) ?? 0);
  }

  /** How many computers this host holds, whoever's, counting the ones being started. */
  computersHeld(): number {
    const held = [...this.active.values()].filter((entry) => !entry.released).length;
    return held + [...this.starting.values()].reduce((sum, count) => sum + count, 0);
  }

  private runnerCommand(): string[] {
    // Under `docker` the session runs inside the bot's container, where every
    // path on hostd's filesystem is meaningless. It used to be handed
    // `import.meta.dirname` regardless — an absolute host path — so the command
    // exited immediately, and the task started, took its worktree and its
    // branch, and then reported nothing for the rest of its life.
    if (this.config.driver === 'docker') return ['node', CONTAINER_RUNNER];

    // Prefer the compiled runner; fall back to tsx for a development install.
    const compiled = join(import.meta.dirname, 'skill-runner.js');
    if (existsSync(compiled)) return ['node', compiled];
    return ['npx', 'tsx', join(import.meta.dirname, 'skill-runner.ts')];
  }

  /**
   * Everything the session should read before it starts: the playbook for what
   * this bot is accountable for, the repository's own notes to agents, and the
   * subject the bridge read from GitHub. The context lives beside the worktree
   * rather than inside it, so a bot cannot commit its own briefing by accident.
   */
  private contextFilesFor(input: {
    bot: string;
    role: BotRole;
    taskId: string;
    worktree: string;
    /** In the task's own directory, beside its clone (`<slot>/context`). */
    dir: string;
    documents: ContextDocument[];
  }): { files: string[]; dir: string } {
    const dir = input.dir;
    const files: string[] = [];

    // A role resolves to `crew/roles/<role>.md`, and nothing maps one role onto
    // another's playbook. Nine roles used to share four files — a spec bot read
    // the builder's, QA read the reviewer's, and the automation account read
    // intake's — so three bots were briefed as something they are not, and
    // adding a role briefed it as whatever the map happened to say.
    const playbook = playbookPaths(input.role, this.config);
    if (existsSync(playbook.onHost)) files.push(playbook.inSession);
    else console.warn(`[hostd] no playbook at ${playbook.onHost}; ${input.bot} starts without one`);

    const agentsMd = join(input.worktree, 'AGENTS.md');
    if (existsSync(agentsMd)) files.push(agentsMd);

    if (input.documents.length > 0) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });

      for (const document of input.documents) {
        // The name comes from the bridge, so it never escapes the context directory.
        const safe = document.name.replace(/[^A-Za-z0-9._-]/g, '-');
        const path = join(dir, safe);
        writeFileSync(path, `<!-- ${document.title} -->\n\n${document.content}\n`);
        files.push(path);
      }
    }

    return { files, dir };
  }

  /**
   * The repository's own setup target, against the bot's fresh database. A
   * repository with no Makefile or no such target needs nothing done, so a
   * missing target is not a failure.
   */
  private async prepare(
    computer: TaskComputer,
    worktree: string,
    databaseUrl: string,
    repoHome: string,
    cache: Record<string, string> = {},
  ): Promise<void> {
    if (!existsSync(join(worktree, 'Makefile'))) return;

    // Bounded: a hung setup held its start in "starting", which counts
    // against the host's capacity, and a few of them filled the host.
    const minutes = this.config.setupTimeoutMinutes ?? DEFAULT_SETUP_TIMEOUT_MINUTES;
    const result = await this.driver
      .exec(computer, ['make', '-s', 'setup'], {
        cwd: worktree,
        env: { DATABASE_URL: databaseUrl, FLEETADLC_REPO_HOME: repoHome, ...cache },
        timeoutMs: minutes * 60_000,
      })
      .catch(() => null);
    if (result?.timedOut) {
      console.warn(`[hostd] ${computer.bot}: make setup did not finish within ${minutes} minutes and was stopped; the task starts without it`);
    } else if (result && result.code !== 0) {
      console.warn(`[hostd] ${computer.bot}: make setup exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`);
    }
  }

  /**
   * Where a task's directory goes when its driver has no other in mind (see
   * `TaskComputerSpec.slotDir`): a folder of its own for each start of a task,
   * never the last start's path again. A resume deleted the folder and made it
   * again at the same path a second later, and under OrbStack the containers'
   * view of the Mac's files could still hold the deleted one: the clone was
   * there on the host and "No such file or directory" in the container. A new
   * path has nothing cached. Whose a folder is, is the record beside it
   * (`writeSlotTask`).
   */
  private slotDirFor(taskId: string): string {
    return join(this.slotsRoot(), `${taskId}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`);
  }

  private async remoteFor(repoFullName: string | null): Promise<string | null> {
    if (!repoFullName) return null;
    const override = process.env[`FLEETADLC_REMOTE_${repoFullName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`];
    if (override) return override;
    if (process.env.FLEETADLC_SCRIPTED_REPO_PATH) return process.env.FLEETADLC_SCRIPTED_REPO_PATH;
    return `https://github.com/${repoFullName}.git`;
  }

  async start(input: StartTaskInput, resolved?: SessionModel): Promise<StartedTask> {
    // Its harvest has to finish before the resume can read the commits back,
    // and nothing may take down the computer this start is about to make.
    const releasing = this.releasing.get(input.taskId);
    if (releasing) await releasing;
    // Counted before anything is awaited, so two starts at once cannot both
    // find the last place free.
    if (this.computersHeld() >= this.config.capacityTasks) throw new HostFull(this.config.hostName, this.config.capacityTasks);
    this.starting.set(input.bot, (this.starting.get(input.bot) ?? 0) + 1);
    this.startingTasks.set(input.taskId, input.bot);
    try {
      return await this.begin(input, resolved);
    } catch (error) {
      // Said here too: the bridge was told, and hostd's own log said nothing,
      // so a failed resume looked like a quiet host.
      console.warn(`[hostd] ${input.bot}: task ${input.taskId} did not start: ${error instanceof Error ? error.message.slice(0, 300) : error}`);
      // A computer acquired for a start that failed is not left running: no
      // task holds it, so nothing else would take it down.
      if (!this.active.has(input.taskId)) await this.driver.release(input.taskId, 'its start failed').catch(() => undefined);
      throw error;
    } finally {
      this.startingTasks.delete(input.taskId);
      this.cancelledStarts.delete(input.taskId);
      const left = (this.starting.get(input.bot) ?? 1) - 1;
      if (left > 0) this.starting.set(input.bot, left);
      else this.starting.delete(input.bot);
    }
  }

  /** Throws when a cancel arrived while this task was starting; `start` gives its computer back. */
  private stopIfCancelled(taskId: string): void {
    if (this.cancelledStarts.has(taskId)) throw new Error(`task ${taskId} was stopped while it was starting`);
  }

  private async begin(input: StartTaskInput, resolved?: SessionModel): Promise<StartedTask> {
    const bot = await bots.getBotByName(input.bot);
    if (!bot) throw new Error(`there is no bot ${input.bot}: it was renamed or removed. Start the work again from the board`);

    // Before a worktree, a container or a session. A model the account cannot
    // call fails the task with what it does offer; substituting another would
    // put a model nobody selected into the ledger. The bot row is read here,
    // so a console change applies to this start and hostd does not restart.
    // A resumption has already resolved it, before ending the old session.
    const choice = resolved ?? (await this.chooseModel(bot));

    // Found even once it is removed from OpenADLC: nothing new is started in one,
    // so this is a paused task in it being resumed, and it resumes where it was.
    const repo = input.repo ? await repos.getRepoByName(input.repo, { includeRemoved: true }) : null;

    // The login this task's account needs, from the same resolution as its
    // model. A bot on a key or on another seat is given none, and a container
    // holding one it no longer needs is recreated without it — this is a task
    // start, so the bot has nothing running for that to interrupt.
    const login = loginFor(choice.account);
    if (login) ensureLoginDir(this.config.loginRoot, login.accountId);
    // Its GitHub token, before a computer or a worktree: a bridge that cannot
    // mint one fails the start with its reason. A bot with no GitHub login is
    // not asked, and runs with none.
    // Narrowed to the task's repository where the install can; see `TokenClient`.
    const token = this.tokens && bot.githubLogin ? (await this.tokens.tokenForTask(bot.name, repo?.fullName ?? null)).token : null;
    // The task's own computer, sized as its seat says (config/bots.yaml: it was
    // parsed and never passed, so every computer had the driver's default),
    // with its own database emptied and its own directory. Its clone goes in
    // that directory, so it is acquired first: under docker the directory is
    // a mount, fixed when the container is made.
    const computer = await this.driver.acquire({
      taskId: input.taskId,
      bot: bot.name,
      repoKey: repoKeyOf(repo?.fullName ?? null),
      slotDir: this.slotDirFor(input.taskId),
      login,
      cpus: bot.cpus ?? DEFAULT_CPUS,
      memoryGb: bot.memoryGb ?? DEFAULT_MEMORY_GB,
      database: bot.sidecarDb,
    });
    this.stopIfCancelled(input.taskId);

    let worktree = join(computer.slotDir, 'wt');
    let writable = [...(input.declaredPaths ?? [])];
    let mirror = '';
    let branch = input.branch ?? null;
    // What the task is told about its worktree beyond what the bridge sent.
    const notes: ContextDocument[] = [];

    const remote = await this.remoteFor(repo?.fullName ?? null);
    // A request sent with no repository is triaged in an empty directory. Made
    // here, on hostd's side of the mount, as a clone would be: nothing made it,
    // and its start failed the git check below and was requeued forever.
    const cloned = Boolean(remote && repo);

    if (remote && repo) {
      const request = {
        bot: bot.name,
        taskId: input.taskId,
        repoFullName: repo.fullName,
        remote,
        baseRef: input.baseRef ?? `refs/heads/${repo.defaultBranch}`,
        branch,
        token,
        path: worktree,
        keepUnpushed: WRITES_THE_BRANCH.has(input.kind),
      };
      const result =
        input.checkoutExistingBranch && branch
          ? await this.worktrees.checkoutExisting({
              ...request,
              branch,
              startFromBaseIfMissing: input.startFromBaseIfMissing ?? false,
            })
          : await this.worktrees.create(request);
      worktree = result.path;
      mirror = result.mirror;
      branch = result.branch;
      // Its own commits came off the branch because the remote moved on; it
      // has to apply them again, and must not force the branch back to them.
      if (result.setAside && branch) {
        notes.push({
          name: 'set-aside-commits.md',
          title: result.setAside.reason === 'ended' ? 'Commits an earlier task on this branch never pushed' : 'Commits set aside when this task resumed',
          content: setAsideBrief(branch, result.setAside),
        });
      }
      // A round on a branch may keep changing what the branch already changes:
      // a widening a person approved is in the diff, not the lease. Only a
      // round that writes the branch — never a review, which may write nothing
      // in the repository — gets the diff's paths. Nor does a conflict
      // resolution, which may write only the conflicted files: widened, its
      // brief told it that it could rework the whole pull request.
      if (input.checkoutExistingBranch && WRITES_THE_BRANCH.has(input.kind) && input.skill !== 'resolve-conflict') {
        const inDiff = await this.worktrees.changedFiles(worktree, request.baseRef).catch(() => []);
        writable = [...new Set([...writable, ...inDiff])];
      }
    } else {
      mkdirSync(worktree, { recursive: true });
    }

    // Its own database, emptied: a task's checks run against fixtures it owns,
    // never against what the task before it left behind.
    const databaseUrl = computer.databaseUrl;

    // Its own home, in its own directory and gone with it, and its
    // repository's npm cache. See `withRepoHome`.
    const repoHome = join(computer.slotDir, 'home');
    mkdirSync(repoHome, { recursive: true });
    // Its repository's pnpm store, filled by hostd from this worktree's
    // lockfile on every start and resume, and read-only in the computer; a
    // store of its own in its home when that cannot be. Before `make setup`,
    // which installs from it. See `PnpmStore`.
    const pnpmStore = remote && repo ? await this.fillPnpmStore(computer, worktree, repo.fullName) : null;
    writeFileSync(join(computer.slotDir, PNPM_STORE_CHOICE), pnpmStore ?? '');
    const cache: Record<string, string> = {
      ...(computer.cacheDir ? { FLEETADLC_CACHE_DIR: computer.cacheDir } : {}),
      ...(pnpmStore ? { FLEETADLC_PNPM_STORE: pnpmStore } : {}),
    };

    this.stopIfCancelled(input.taskId);
    const installEnv = await this.installEnv(input.taskId);
    // A review checks out the pull request. `make setup` is that Makefile,
    // which hostd would run outside the skill's tools, with the task token
    // and the sidecar database. A branch this task writes is its own.
    const ownTree = !input.checkoutExistingBranch || WRITES_THE_BRANCH.has(input.kind);
    if (databaseUrl && ownTree) await this.prepare(computer, worktree, databaseUrl, repoHome, { ...cache, ...installEnv });
    this.stopIfCancelled(input.taskId);

    // The files its work item carries: text as documents, every file beside
    // them for the engine to open. Fetched before the documents are written,
    // and written after, since writing the documents empties the directory.
    const attached = await prepareAttachments({
      attachments: input.attachments ?? [],
      contextDir: join(computer.slotDir, 'context'),
      bytes: (id) => this.attachmentSource().bytes(id),
    });

    const context = this.contextFilesFor({
      bot: bot.name,
      role: bot.role,
      taskId: input.taskId,
      worktree,
      dir: join(computer.slotDir, 'context'),
      documents: [...(input.context ?? []), ...notes, ...attached.documents],
    });
    writeAttachments(attached);

    const minted = await this.minter.mint({
      bot: bot.name,
      githubLogin: bot.githubLogin,
      taskId: input.taskId,
      token,
      engine: bot.engine,
      model: choice.model,
      modelAlias: choice.modelAlias,
      account: choice.account,
      skill: input.skill,
      workdir: worktree,
      // Both are addresses the *task* uses, not hostd: under the docker driver
      // the session is in a container with no route to the host's loopback.
      bridgeUrl: this.config.taskBridgeUrl ?? reachableFromTask(this.config.bridgeUrl, this.config.driver),
      hostdUrl: this.taskHostdUrl(),
      registryConfigured: Boolean(this.config.registryHost),
      costCapUsd: input.costCapUsd ?? 15,
      contextFiles: context.files,
      databaseUrl,
      declaredPaths: writable,
      repoFullName: repo?.fullName ?? null,
      subjectRef: input.subjectRef,
      postHeader: input.postHeader ?? null,
      reviewMode: input.reviewMode ?? null,
      reviewLens: input.reviewLens ?? null,
      repoHome,
      modelPrices: this.config.modelPrices,
    });

    // The session is about to be started in this directory, so the driver had
    // better be able to see it. Under `docker` this used not to hold at all —
    // the worktree was on hostd's filesystem and the container's was a
    // different, empty one — and nothing noticed, because `startSession` runs
    // `mkdir -p` on the way in and a bot in an empty directory just reports that
    // the repository is not what it expected.
    //
    // Asked of the driver rather than of hostd's own filesystem: hostd can
    // always see it, and that is exactly what made the defect invisible.
    // Asked a few times over a few seconds: a file shared into a VM can reach
    // its containers a moment after the host has it. A task with no clone is
    // looked for as a directory, which still proves the mount.
    const look = cloned ? ['git', '-C', worktree, 'rev-parse', '--git-dir'] : ['test', '-d', worktree];
    let visible = await this.driver.exec(computer, look);
    for (let attempt = 1; visible.code !== 0 && attempt < VISIBLE_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, VISIBLE_WAIT_MS * attempt));
      visible = await this.driver.exec(computer, look);
    }
    if (visible.code !== 0 || this.cancelledStarts.has(input.taskId)) {
      await minted.cleanup();
      this.stopIfCancelled(input.taskId);
      if (!cloned) {
        throw new Error(
          `${bot.name} has no directory at ${worktree} in its computer, and its task has no repository to clone there. ` +
            `The driver is ${this.config.driver}; the directory hostd made for it is missing.`,
        );
      }
      throw new Error(
        `${bot.name} cannot see its worktree at ${worktree}: ${visible.stderr.trim() || 'not a git repository'}. ` +
          `The driver is ${this.config.driver}; under docker this means the task's directory is not mounted ` +
          `into its container at the same path hostd built it.`,
      );
    }

    const session = sessionNameFor(input.skill, input.taskId);
    const handle = await this.driver.startSession({
      computer,
      name: session,
      cwd: worktree,
      command: this.runnerCommand(),
      env: {
        ...minted.env,
        ...cache,
        FLEETADLC_SKILLS_ROOT: this.config.driver === 'docker' ? '/skills' : this.config.skillsRoot,
        ...(attached.binaries.length > 0 ? { [ATTACHMENTS_ENV]: attached.binaries.join(',') } : {}),
      },
    });

    if (this.cancelledStarts.has(input.taskId)) {
      await this.driver.killSession(bot.name, session).catch(() => undefined);
      await minted.cleanup().catch(() => undefined);
      this.stopIfCancelled(input.taskId);
    }

    this.active.set(input.taskId, {
      cleanup: minted.cleanup,
      computer,
      worktree,
      mirror,
      contextDir: context.dir,
      bot: bot.name,
      session,
      kind: input.kind,
      repoFullName: repo?.fullName ?? null,
      branch,
      databaseUrl,
      repoHome,
      pnpmStore,
      installEnv,
    });

    const running = await tasks.updateTaskState(input.taskId, 'running', {
      worktree,
      tmuxSession: `${bot.name}/${session}`,
      // Where it runs, for hostd after a restart and for the terminal: a warm
      // container's labels cannot say which task it was claimed for.
      container: computer.container,
      hostId: this.hostId,
    });
    // Refused: the task ended while it was starting — stopped, or failed by
    // the bridge — and an ended task stays ended. What was just made goes.
    if (!running) {
      await this.end(input.taskId, 'its task had already ended');
      throw new Error(`task ${input.taskId} had already ended by the time its session started`);
    }

    return { taskId: input.taskId, session: `${bot.name}/${session}`, worktree, branch: handle ? branch : null };
  }

  /** Where a task's files are fetched from: the bridge, unless a test says otherwise. */
  attachmentClient: Pick<AttachmentClient, 'bytes'> | null = null;

  private attachmentSource(): Pick<AttachmentClient, 'bytes'> {
    this.attachmentClient ??= new AttachmentClient(this.config.bridgeUrl);
    return this.attachmentClient;
  }

  /**
   * Where a running task's checks run (`local-ci.ts`): its bot, its worktree,
   * and the database and repository home `make setup` was given, so `make ci`
   * runs as the session's own checks would. Null for a task not running here.
   */
  localCiTarget(taskId: string): LocalCiTarget | null {
    const entry = this.active.get(taskId);
    if (!entry || entry.released) return null;
    return {
      bot: entry.bot,
      computer: entry.computer,
      worktree: entry.worktree,
      branch: entry.branch,
      env: {
        ...(entry.databaseUrl ? { DATABASE_URL: entry.databaseUrl } : {}),
        FLEETADLC_REPO_HOME: entry.repoHome,
        ...(entry.computer.cacheDir ? { FLEETADLC_CACHE_DIR: entry.computer.cacheDir } : {}),
        ...(entry.pnpmStore ? { FLEETADLC_PNPM_STORE: entry.pnpmStore } : {}),
        ...entry.installEnv,
      },
    };
  }

  /** Where a task reaches hostd: under the docker driver its computer has no route to the host's loopback. */
  private taskHostdUrl(): string {
    return this.config.taskHostdUrl ?? reachableFromTask(`http://127.0.0.1:${this.config.port}`, this.config.driver);
  }

  /**
   * What `fleetadlc-install` reads, for the installs hostd runs itself: `make
   * setup` at the start and the `make ci` behind `fleetadlc-ci`. Without them
   * the wrapper took itself to be outside a session and installed with no
   * credential, so a private package failed to install or, unscoped, resolved
   * on the public registry. The flag comes from hostd's configuration, never
   * the repository, so the wrapper refuses rather than installing without the
   * credential when a registry is configured.
   */
  private async installEnv(taskId: string): Promise<Record<string, string>> {
    return this.installEnvWith(taskId, await this.minter.taskToken(taskId));
  }

  private installEnvWith(taskId: string, token: string | null): Record<string, string> {
    return {
      FLEETADLC_HOSTD_URL: this.taskHostdUrl(),
      FLEETADLC_TASK_ID: taskId,
      ...(token ? { FLEETADLC_TASK_TOKEN: token } : {}),
      ...(this.config.registryHost ? { FLEETADLC_REGISTRY_CONFIGURED: '1' } : {}),
    };
  }

  /** A resumption is a new session in a fresh worktree off the branch head. */
  async resume(
    taskId: string,
    context: ContextDocument[],
    postHeader?: string,
    attachments?: TaskAttachment[],
    reviewMode?: ReviewMode,
    reviewLens?: string,
  ): Promise<StartedTask> {
    const task = await tasks.getTask(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const bot = await bots.getBotById(task.botId);
    if (!bot) throw new Error('task has no bot');
    const repo = task.repoId ? (await repos.listRepos({ includeRemoved: true })).find((entry) => entry.id === task.repoId) : null;

    // Its pull request was merged or closed, as a resume before this one
    // found. Nothing on disk says so any more — that resume's fetch pruned the
    // branch and the record of its push — so without this the task started
    // from the base as one that had never pushed, and redid finished work.
    if (stoppedForGoneBranch(task)) throw new BranchGoneError(task.exitReason ?? BRANCH_GONE);

    // Before the old session is taken down. A model the account can no longer
    // call used to be found only inside `start`, after `end` had removed the
    // worktree, so the task was left paused with nothing behind it. Refused
    // here, the task is as it was and the bridge fails it with the reason.
    const choice = await this.chooseModel(bot);

    await this.end(taskId, 'resuming');

    const declaredPaths = task.leaseId ? ((await leases.getLease(task.leaseId).catch(() => null))?.declaredPaths ?? []) : [];
    return this.start(
      {
        taskId,
        bot: bot.name,
        repo: repo?.name ?? null,
        kind: task.kind,
        subjectRef: task.subjectRef,
        branch: task.branch,
        skill: task.skill ?? 'implement',
        // A stacked build is told again what it is built on, as it was when it
        // started.
        context: [...context, ...(task.baseContext ?? [])],
        costCapUsd: task.costCapUsd,
        checkoutExistingBranch: Boolean(task.branch),
        // The branch it started from. Without it a stacked build resumed on
        // the default branch: rebuilt without its dependency's code when it
        // had not pushed, or, when it had, told that every file the
        // dependency changed was its own to write.
        ...(task.baseRef ? { baseRef: task.baseRef } : {}),
        // Resumed, it writes where it could before: its lease's paths. They were
        // dropped here, so a round resumed after a question could write only
        // tests and docs.
        declaredPaths,
        // Only a build that paused before its first push has a branch that is
        // not there yet; a review or patch round on a missing branch fails.
        startFromBaseIfMissing: task.kind === 'implement',
        ...(postHeader ? { postHeader } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(reviewMode ? { reviewMode } : {}),
        ...(reviewLens ? { reviewLens } : {}),
      },
      choice,
    ).catch(async (error: unknown) => {
      // Written on the task, where the next resume looks: see above.
      if (error instanceof BranchGoneError) {
        await tasks.updateTaskState(taskId, 'failed', { exitReason: error.message }).catch(() => undefined);
      }
      throw error;
    });
  }

  /**
   * Ends a task: kill the session, keep its branch in the mirror, and give
   * its computer back — its directory, its database, and under docker its
   * container.
   *
   * A task that writes its branch has its branch's commits harvested into the
   * repository's mirror first (`Worktrees.harvest`): the clone is the only
   * place an unpushed commit is, and a resume — which is this, then `start` —
   * reads it back from the mirror.
   */
  async end(taskId: string, reason: string): Promise<void> {
    const entry = this.active.get(taskId);
    if (!entry) return;
    this.active.delete(taskId);
    this.pausedSince.delete(taskId);
    // Paused, and its computer already given back with its branch kept.
    if (entry.released) return;

    await this.driver.killSession(entry.bot, entry.session).catch(() => undefined);
    // The signing agent lives in the computer, so it is stopped before the
    // computer goes.
    await entry.cleanup().catch(() => undefined);
    if (entry.repoFullName && entry.branch && WRITES_THE_BRANCH.has(entry.kind)) {
      await this.worktrees
        .harvest({ path: entry.worktree, taskId, repoFullName: entry.repoFullName, branch: entry.branch })
        .catch((error: unknown) => {
          console.warn(`[hostd] ${entry.bot}: could not keep ${entry.branch} from task ${taskId}: ${error instanceof Error ? error.message : error}`);
        });
    }
    // The briefing is per task and in the task's directory; the next one
    // reads the subject again.
    await this.driver.release(taskId, reason).catch((error: unknown) => {
      console.warn(`[hostd] ${entry.bot}: could not release the computer of task ${taskId}: ${error instanceof Error ? error.message : error}`);
    });
  }

  async cancel(taskId: string, reason: string): Promise<void> {
    // One still starting is stopped by its start; see `cancelledStarts`.
    if (this.startingTasks.has(taskId)) this.cancelledStarts.add(taskId);
    await this.end(taskId, reason);
    const task = await tasks.updateTaskState(taskId, 'stopped', { exitReason: reason });
    // A container restart or a drain ends the task here, not through the
    // bridge's end-of-task route, and a lease a gate paused is let go by
    // nothing else (`leases.settlePausedLeases`). The reconciler sweeps what
    // this misses, so it never fails the cancel.
    if (task?.leaseId) {
      await leases
        .settlePausedLeases({
          leaseId: task.leaseId,
          actor: 'hostd',
          reason: `its task on ${task.subjectRef} stopped: ${reason}`,
          holdUntil: leaseExpiryFrom(),
        })
        .catch(() => undefined);
    }
  }

  /** What stopping hostd does to the tasks it holds: see `drainTasks`. */
  drain(reason: string): Promise<{ stopped: string[]; kept: string[]; timedOut: string[] }> {
    return drainTasks({
      active: [...this.activeTaskIds(), ...this.startingTaskIds()],
      stateOf: async (taskId) => (await tasks.getTask(taskId).catch(() => null))?.state ?? null,
      cancel: (taskId) => this.cancel(taskId, reason),
    });
  }

  /**
   * A person is killing this session: the task running in it, if any, is
   * recorded as stopped by them before the kill lands, so its ending is not
   * mistaken for a session that went away on its own — which the deploy sweep
   * starts again (`tasks.noteStoppedByPerson`). Found by the session the row
   * names, since that is what hostd recorded when it started the task.
   */
  async stoppingByPerson(bot: string, session: string, actor: string): Promise<string | null> {
    const task = await tasks.noteStoppedByPerson(`${bot}/${session}`, actor).catch(() => null);
    return task?.id ?? null;
  }

  /** The kill `stoppingByPerson` announced failed; the task was not stopped after all. */
  async notStoppedAfterAll(taskId: string): Promise<void> {
    await tasks.forgetStoppedByPerson(taskId).catch(() => undefined);
  }

  activeTaskIds(): string[] {
    return [...this.active.keys()];
  }

  /** Tasks being started here and not held yet, with the bot each is for; see `startingTasks`. */
  startingTaskIds(bot?: string): string[] {
    return [...this.startingTasks].filter(([taskId, forBot]) => (bot === undefined || forBot === bot) && !this.active.has(taskId)).map(([taskId]) => taskId);
  }

  /** Whether a task, or a warm computer named so, holds its folder here. */
  private holdsFolder(name: string): boolean {
    return (
      this.active.has(name) ||
      this.startingTasks.has(name) ||
      this.driver.computerOf(name) !== null ||
      this.driver.isWarm?.(name) === true
    );
  }

  /** Whether a task's computer is being made now; see `startingTasks`. */
  isStarting(taskId: string): boolean {
    return this.startingTasks.has(taskId);
  }

  /**
   * Clears the clones of tasks that are over, which is every task that ended
   * without `end` being called for it, keeping their branches' commits in the
   * mirror first. Run at startup, when nothing is running yet and anything on
   * disk is debris — a paused task's clone among it, whose commits its resume
   * reads back.
   */
  async pruneAbandonedWorktrees(bot: string): Promise<number> {
    const live = (taskId: string) => this.holdsFolder(taskId);
    const keptBranchOf = (taskId: string) => this.keptBranchOf(taskId);
    const removed =
      (await this.worktrees.pruneAbandoned(bot, live, keptBranchOf)) +
      (await this.worktrees.pruneSlots(join(this.config.workRoot, bot, 'slots'), live, { keptBranchOf }));
    // The home is not in the slot, so a slot removed here would leave it.
    sweepTaskHomes(this.config.loginRoot, this.slotRoots());
    return removed;
  }

  /** The same for the task directories every bot's tasks share (`<work root>/slots`). */
  async pruneAbandonedSlots(): Promise<number> {
    const live = (taskId: string) => this.holdsFolder(taskId);
    const removed = await this.worktrees.pruneSlots(this.slotsRoot(), live, { keptBranchOf: (taskId) => this.keptBranchOf(taskId) });
    sweepTaskHomes(this.config.loginRoot, this.slotRoots());
    return removed;
  }

  /** Every directory a task slot can live in: the shared one, and a bot's own from before it. */
  private slotRoots(): string[] {
    const roots = [this.slotsRoot()];
    if (!existsSync(this.config.workRoot)) return roots;
    for (const name of readdirSync(this.config.workRoot, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const slots = join(this.config.workRoot, name.name, 'slots');
      if (existsSync(slots)) roots.push(slots);
    }
    return roots;
  }

  /** Where every task's directory is made (`slotDirFor`); a computer whose directory is elsewhere is not one hostd made. */
  slotsRoot(): string {
    return join(this.config.workRoot, 'slots');
  }

  /**
   * Where a leftover clone of a task is harvested: its row's repository and
   * branch, for a task that writes its branch. See `KeptBranchOf`.
   */
  private async keptBranchOf(taskId: string): Promise<{ repoFullName: string; branch: string } | null> {
    const task = await tasks.getTask(taskId).catch(() => null);
    if (!task?.branch || !task.repoId || !WRITES_THE_BRANCH.has(task.kind)) return null;
    const repo = (await repos.listRepos({ includeRemoved: true })).find((entry) => entry.id === task.repoId);
    return repo ? { repoFullName: repo.fullName, branch: task.branch } : null;
  }

  /** Carries the per-bot mirrors' paused branches and set-asides into the per-repository ones; see `Worktrees.importLegacyMirrors`. */
  importLegacyMirrors(paused: readonly LegacyTask[]): Promise<{ tasks: number; mirrors: number }> {
    return this.worktrees.importLegacyMirrors(paused);
  }

  /** Deletes the kept branches of tasks that have ended for good, setting aside what they never pushed; see `Worktrees.dropTaskRefs`. */
  dropFinishedTaskRefs(isOver: (taskId: string) => Promise<boolean | { branch: string | null }>): Promise<number> {
    return this.worktrees.dropTaskRefs(isOver);
  }

  /**
   * Why a task has no computer here to attach to, as the terminal route
   * answers it. A paused task's computer is given back (after a while under
   * docker, at once after hostd restarts), and its work is on its branch: a
   * person who opens its terminal is told that, not handed a token for a
   * session that is not anywhere.
   */
  async whyNoComputer(taskId: string): Promise<{ status: number; error: string }> {
    const task = await tasks.getTask(taskId).catch(() => null);
    if (!task) return { status: 404, error: `no task ${taskId}` };
    if (task.state === 'paused') {
      return {
        status: 409,
        error: `computer released while paused; work is on ${task.branch ?? 'no branch yet'}. Answering its question starts it again`,
      };
    }
    return { status: 409, error: `task ${taskId} has no computer on this host: it is ${task.state}` };
  }

  sessionOf(taskId: string): { bot: string; session: string } | null {
    const entry = this.active.get(taskId);
    return entry && !entry.released ? { bot: entry.bot, session: entry.session } : null;
  }

  /**
   * Gives back the computer of a task that has been paused on a person for
   * longer than `keepMs`, keeping its branch in the mirror first.
   *
   * A paused task's computer was kept for as long as the question was open —
   * hours, sometimes days — holding a container, its memory and its database
   * while nothing ran in it. It is kept for a while (`FLEETADLC_PAUSED_KEEP_MINUTES`,
   * fifteen by default), so a person can take over and a quick answer resumes
   * it cheaply, and then given back. The resume starts a fresh computer from
   * the branch head, as every resume always has: whatever was committed is
   * kept, and anything not committed in the paused worktree is lost.
   */
  async releasePausedPast(keepMs: number, isPaused: (taskId: string) => Promise<boolean>, now = Date.now()): Promise<string[]> {
    const released: string[] = [];
    for (const [taskId, entry] of [...this.active]) {
      if (entry.released) continue;
      if (!(await isPaused(taskId).catch(() => false))) {
        this.pausedSince.delete(taskId);
        continue;
      }
      const since = this.pausedSince.get(taskId) ?? now;
      this.pausedSince.set(taskId, since);
      if (now - since < keepMs) continue;
      await this.releasePaused(taskId);
      released.push(taskId);
    }
    return released;
  }

  private async releasePaused(taskId: string): Promise<void> {
    const entry = this.active.get(taskId);
    if (!entry || entry.released) return;
    entry.released = true;
    // Recorded before the first await, so a start for this task cannot slip
    // in between; see `releasing`.
    const release = this.giveBackPaused(taskId, entry).finally(() => this.releasing.delete(taskId));
    this.releasing.set(taskId, release);
    await release;
  }

  private async giveBackPaused(taskId: string, entry: ActiveTask): Promise<void> {
    this.pausedSince.delete(taskId);
    await this.driver.killSession(entry.bot, entry.session).catch(() => undefined);
    await entry.cleanup().catch(() => undefined);
    if (entry.repoFullName && entry.branch && WRITES_THE_BRANCH.has(entry.kind)) {
      await this.worktrees
        .harvest({ path: entry.worktree, taskId, repoFullName: entry.repoFullName, branch: entry.branch })
        .catch((error: unknown) => {
          console.warn(`[hostd] ${entry.bot}: could not keep ${entry.branch} from paused task ${taskId}: ${error instanceof Error ? error.message : error}`);
        });
    }
    await this.driver.release(taskId, 'paused past the time its computer is kept').catch((error: unknown) => {
      console.warn(`[hostd] ${entry.bot}: could not release the computer of paused task ${taskId}: ${error instanceof Error ? error.message : error}`);
    });
    // On no host now: it stops counting against its seat and the hosts'
    // capacity until its answer resumes it.
    await tasks.releaseComputer(taskId).catch(() => undefined);
    console.log(`[hostd] ${entry.bot}: released the computer of paused task ${taskId}; its work is on ${entry.branch ?? 'no branch yet'}`);
  }

  /** Whether a task held here had its computer given back while paused. */
  isReleased(taskId: string): boolean {
    return this.active.get(taskId)?.released === true;
  }

  /**
   * Holds again a task whose computer outlived hostd: after a restart its
   * session is still running, and `end`, the terminal and the reaper need to
   * know whose computer it is. Its signing agent is in the computer and dies
   * with it, so there is nothing of the session's own to clean up here.
   */
  adopt(
    task: { id: string; kind: TaskKind; branch: string | null; tmuxSession: string | null },
    computer: TaskComputer,
    repoFullName: string | null,
  ): void {
    if (this.active.has(task.id)) return;
    const session = task.tmuxSession?.split('/').at(-1) ?? '';
    this.active.set(task.id, {
      cleanup: async () => undefined,
      computer,
      worktree: join(computer.slotDir, 'wt'),
      mirror: repoFullName ? this.worktrees.mirrorPath(repoFullName) : '',
      contextDir: join(computer.slotDir, 'context'),
      bot: computer.bot,
      session,
      kind: task.kind,
      repoFullName,
      branch: task.branch,
      // The URL `make setup` was given, which the driver rebuilt from the
      // install's secret and the task id (`TaskDatabases.urlFor`), so local CI
      // runs against the task's own database; null when it has none.
      databaseUrl: computer.databaseUrl,
      repoHome: join(computer.slotDir, 'home'),
      pnpmStore: readPnpmStoreChoice(computer.slotDir),
      // The token is read from the secret store, which this cannot wait for.
      // Until it lands the flag is already set, so an install that needs the
      // registry refuses rather than going without the credential.
      installEnv: this.installEnvWith(task.id, null),
    });
    void this.installEnv(task.id)
      .then((env) => {
        const entry = this.active.get(task.id);
        if (entry) entry.installEnv = env;
      })
      .catch(() => undefined);
  }

  /** The store a task installs from: the repository's, when the driver filled it; see `PnpmStore`. */
  private async fillPnpmStore(computer: TaskComputer, worktree: string, repoFullName: string): Promise<string | null> {
    if (!this.driver.fillPnpmStore) return null;
    const fill = await this.driver.fillPnpmStore(computer, worktree).catch((error: unknown) => ({
      filled: false as const,
      skipped: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (fill.filled) return fill.path;
    if (!fill.skipped) console.warn(`[hostd] ${repoFullName}: its pnpm store could not be filled, so task ${computer.taskId} installs into a store of its own: ${fill.reason}`);
    return null;
  }

  /**
   * The repository's pnpm store filled again from a running task's own
   * lockfile, when the session changed what it depends on: OpenADLC's `pnpm`
   * asks (`POST /tasks/:id/pnpm-store`). Never another task's lockfile, and
   * only for a task that installs from the shared store.
   */
  async refillPnpmStore(taskId: string): Promise<PnpmFill> {
    const entry = this.active.get(taskId);
    if (!entry || entry.released) return { filled: false, skipped: true, reason: `task ${taskId} is not running on this host` };
    if (!entry.pnpmStore || !this.driver.fillPnpmStore) {
      return { filled: false, skipped: true, reason: `task ${taskId} installs into a store of its own` };
    }
    return this.driver.fillPnpmStore(entry.computer, entry.worktree);
  }

  /**
   * Where a running task's worktree is, or null when this host is not running
   * it. The path comes from what hostd created, not from the task row: the row
   * is a record of where a worktree was, and a filesystem root read back out of
   * the database is a root somebody else can write.
   */
  worktreeOf(taskId: string): string | null {
    const entry = this.active.get(taskId);
    return entry && !entry.released ? entry.worktree : null;
  }
}

/**
 * The tasks a stopping hostd stops.
 *
 * One that is working is stopped, with the reason. One paused on a person's
 * answer is left as it is: nothing of it is running, its gate holds it, and
 * the answer starts it again under the same id. Stopping it marked a question
 * nobody had answered yet as work that had ended — every restart did it to
 * the intake bot's questions on a console request.
 *
 * All at once, each for at most `perTaskMs`. One after another, they ran past
 * the time `fleetadlc down` gives hostd, which then killed it mid-drain: the
 * tasks it had not reached kept running with nothing supervising them. A
 * cancel that runs out of time is reported in `timedOut`, not waited for; the
 * next start's reconciliation adopts or cleans up its task. Cancels in one
 * repository still take turns harvesting into its mirror (`withMirrorLock`).
 */
export const DRAIN_PER_TASK_MS = 20_000;

export async function drainTasks(input: {
  active: readonly string[];
  stateOf: (taskId: string) => Promise<string | null>;
  cancel: (taskId: string) => Promise<void>;
  perTaskMs?: number;
}): Promise<{ stopped: string[]; kept: string[]; timedOut: string[] }> {
  const limit = input.perTaskMs ?? DRAIN_PER_TASK_MS;
  const outcomes = await Promise.all(
    input.active.map(async (taskId): Promise<'stopped' | 'kept' | 'timedOut'> => {
      if ((await input.stateOf(taskId)) === 'paused') return 'kept';
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'timedOut'>((resolve) => {
        timer = setTimeout(() => resolve('timedOut'), limit);
      });
      try {
        // A cancel that throws has still been asked to stop, as before.
        return await Promise.race([input.cancel(taskId).then(() => 'stopped' as const, () => 'stopped' as const), late]);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const which = (outcome: string) => input.active.filter((_, index) => outcomes[index] === outcome);
  return { stopped: which('stopped'), kept: which('kept'), timedOut: which('timedOut') };
}
