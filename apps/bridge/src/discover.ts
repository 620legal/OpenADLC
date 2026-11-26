import { audit, bots, discover, repos, tasks, type DiscoverRun, type StoredProposal } from '@openadlc/db';
import { GitHubApiError } from '@openadlc/github';
import {
  checkProposals,
  DISCOVER_LENSES,
  DISCOVER_SKILL,
  discoverNote,
  discoverRunPrefixOf,
  discoverSubject,
  MAX_DISCOVER_DESCRIPTION,
  MAX_DISCOVER_EVIDENCE,
  MAX_DISCOVER_NOTE,
  MAX_DISCOVER_PROPOSALS,
  MAX_DISCOVER_TITLE,
  proposalFingerprint,
  type ContextDocument,
} from '@openadlc/shared';
import { HttpFailure, WithStatus, type Router } from './router.js';
import { BotBusyError, busyWords, type TaskService } from './task-service.js';

/**
 * Discover runs (#370,
 * docs/adr/0089-a-discover-run-is-an-intake-task-whose-proposals-hostd-checks-against-its-snapshot.md).
 *
 * A person starts one on a managed repository (`POST /v1/repos/:name/discover`,
 * `openadlc discover owner/name`). It is an ordinary intake-seat task with no
 * issue, on the subject `discover:<id8>`, opened through `TaskService.open`, so
 * the spending caps, the per-task cap, the ledger and the busy checks apply as
 * they do to any task. hostd gives a task with no branch a clone detached at
 * the default branch; the skill's tools.yaml lets it read and nothing more.
 *
 * Its proposals reach the bridge only from the session's own
 * `discover_proposals` marker, which hostd's runner reads, checks against the
 * snapshot's commit and posts to `/internal/tasks/:id/discover` with the
 * task's token (`record`). This file checks them again — hostd is not trusted
 * to have done it — and stores them. Nothing here writes to GitHub: the one
 * GitHub call is a read of the default branch's commit, to tell an empty
 * repository from one with something to read.
 */

/** The run's note when the default branch has no commit to read. */
export const EMPTY_REPOSITORY_NOTE = 'the default branch has no commits';

/** How many of the last run's proposals the next run is given, to reuse their keys. */
export const EARLIER_PROPOSALS_GIVEN = 100;

/** What Try again on a Discover task says: the run it was for has ended, and a new one is a new run. */
export function discoverRetryRefusal(repoFullName: string | null): string {
  return `a Discover run is not run again; start a new one: openadlc discover ${repoFullName ?? 'owner/name'}`;
}

/** The repository a run is about, as the routes and the context read it. */
export interface DiscoverRepo {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/** The task a session's report comes from, as the bridge's row has it. */
export interface DiscoverTask {
  id: string;
  skill: string | null;
  subjectRef: string;
  state?: string;
}

/** What a run is, as the routes answer it. */
export interface DiscoverRunView {
  id: string;
  repo: string;
  state: DiscoverRun['state'];
  lenses: string[];
  commit: string | null;
  proposalCount: number;
  droppedCount: number;
  note: string | null;
  reason: string | null;
  startedBy: string;
  taskId: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface DiscoverProposalView {
  lens: string;
  key: string;
  fingerprint: string;
  title: string;
  description: string;
  status: string;
  evidence: { file: string; line: number }[];
}

type Store = Pick<
  typeof discover,
  'startRun' | 'recordEmpty' | 'attachTask' | 'record' | 'finish' | 'getRun' | 'runByPrefix' | 'runOfTask' | 'proposalsOf' | 'latestDoneProposals' | 'removeRun'
>;

export interface DiscoverDeps {
  store: Store;
  /** A repository the install manages, by its name or full name; null for any other. */
  repo(name: string): Promise<DiscoverRepo | null>;
  repoById(id: string): Promise<DiscoverRepo | null>;
  /** The intake seat, which runs Discover as it runs a console request's triage (`request-queue.ts`); null when the crew has none. */
  intakeSeat(): Promise<{ id: string; name: string } | null>;
  open: TaskService['open'];
  /**
   * Whether the default branch has a commit to read: `empty` when GitHub
   * answers 409 for it, which is what it says of a repository with none;
   * `unknown` when GitHub could not be asked, and the run goes ahead.
   */
  defaultBranchState(repo: DiscoverRepo): Promise<'present' | 'empty' | 'unknown'>;
  /** What a busy seat is doing, in the words a refusal ends with. */
  busyWords(error: BotBusyError, botId: string, on: { repoId: string; subjectRef: string }): Promise<string>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  /** The task a session reports for, as the bridge's row has it. */
  task(id: string): Promise<DiscoverTask | null>;
}

/** The lenses a start names: every lens when it names none, refused when it names an empty list or one that does not exist. */
export function lensesFrom(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [...DISCOVER_LENSES];
  const known = DISCOVER_LENSES.join(', ');
  if (!Array.isArray(raw) || raw.some((lens) => typeof lens !== 'string')) throw new HttpFailure(400, `lenses is a list of lens names: ${known}`);
  const lenses = [...new Set((raw as string[]).map((lens) => lens.trim().toLowerCase()).filter(Boolean))];
  if (lenses.length === 0) throw new HttpFailure(400, `name at least one lens: ${known}`);
  const unknown = lenses.filter((lens) => !(DISCOVER_LENSES as readonly string[]).includes(lens));
  if (unknown.length > 0) throw new HttpFailure(400, `there is no lens ${unknown.join(', ')}; the lenses are: ${known}`);
  return lenses;
}

function viewOf(run: DiscoverRun, repo: { fullName: string }): DiscoverRunView {
  return {
    id: run.id,
    repo: repo.fullName,
    state: run.state,
    lenses: run.lenses,
    commit: run.commit,
    proposalCount: run.proposalCount,
    droppedCount: run.droppedCount,
    note: run.note,
    reason: run.reason,
    startedBy: run.startedBy,
    taskId: run.taskId,
    createdAt: run.createdAt,
    endedAt: run.endedAt,
  };
}

function proposalView(row: StoredProposal): DiscoverProposalView {
  return { lens: row.lens, key: row.key, fingerprint: row.fingerprint, title: row.title, description: row.description, status: row.status, evidence: row.evidence };
}

/** `discover-run.md`: what the session runs on, and the one marker it ends with. */
export function runDocument(repo: DiscoverRepo, run: DiscoverRun): ContextDocument {
  return {
    name: 'discover-run.md',
    title: 'The Discover run you are on',
    content: [
      `Repository: ${repo.fullName}, on a detached snapshot of its default branch (${repo.defaultBranch}).`,
      `Lenses switched on: ${run.lenses.join(', ')}.`,
      '',
      'Limits:',
      `- at most ${MAX_DISCOVER_PROPOSALS} proposals; any past that are dropped`,
      `- title at most ${MAX_DISCOVER_TITLE} characters, description at most ${MAX_DISCOVER_DESCRIPTION}, note at most ${MAX_DISCOVER_NOTE}`,
      `- key: lowercase letters and digits in words joined by "-", at most 80 characters`,
      `- status: missing, partial or already there`,
      `- evidence: 1 to ${MAX_DISCOVER_EVIDENCE} "path:line" strings, each a line at this snapshot's commit`,
      '- no field may contain "-->" or "<!--"',
      '',
      'End your last message with one marker, on its own line:',
      '',
      '<!-- openadlc:{"event":"discover_proposals","proposals":[{"lens":"improve","key":"…","title":"…","description":"…","status":"partial","evidence":["path/to/file.ts:12"]}],"note":"…"} -->',
      '',
      'With nothing to propose, give "proposals":[] and a note saying why.',
    ].join('\n'),
  };
}

/** `earlier-proposals.md`: the last done run's proposals, so the same thing keeps its key. */
export function earlierDocument(proposals: readonly StoredProposal[]): ContextDocument {
  return {
    name: 'earlier-proposals.md',
    title: 'What the last Discover run on this repository proposed',
    content:
      proposals.length === 0
        ? 'No earlier run on this repository stored a proposal. Choose each key yourself.'
        : [
            'Reuse the key of a proposal here when you propose the same thing, even with another title.',
            '',
            ...proposals.map((one) => `- \`${one.key}\` (${one.lens}, ${one.status}): ${one.title}`),
          ].join('\n'),
  };
}

export class DiscoverService {
  constructor(private readonly deps: DiscoverDeps) {}

  /** Starts a run, or says why not; answered 202 with the run. */
  async start(input: { name: string; lenses: unknown; actor: string }): Promise<WithStatus> {
    const repo = await this.deps.repo(input.name);
    if (!repo) throw new HttpFailure(404, `${input.name || 'that'} is not a repository this install manages; add it in Settings → Repositories first`);
    const lenses = lensesFrom(input.lenses);
    const busy = (live: DiscoverRun) => new HttpFailure(409, `a Discover run is already running on ${repo.fullName}: run ${live.id}`, { run: live.id });

    // An empty repository has nothing to read, and hostd could not clone a
    // default branch with no commit: the run is done with its note, and no
    // task starts.
    if ((await this.deps.defaultBranchState(repo)) === 'empty') {
      const recorded = await this.deps.store.recordEmpty({ repoId: repo.id, lenses, startedBy: input.actor, note: EMPTY_REPOSITORY_NOTE });
      if ('conflict' in recorded) throw busy(recorded.conflict);
      await this.audited(input.actor, repo, recorded.run, lenses);
      return new WithStatus(202, { run: viewOf(recorded.run, repo) });
    }

    const seat = await this.deps.intakeSeat();
    if (!seat) throw new HttpFailure(409, 'this install has no intake seat to run Discover; add one on the Crew page');

    const started = await this.deps.store.startRun({ repoId: repo.id, lenses, startedBy: input.actor });
    if ('conflict' in started) throw busy(started.conflict);
    const run = started.run;
    const subjectRef = discoverSubject(run.id);

    // Named as soon as its row exists, before hostd starts the session: the
    // session's report is matched to the run by this.
    let attached: Promise<void> = Promise.resolve();
    let opened: Awaited<ReturnType<TaskService['open']>>;
    try {
      opened = await this.deps.open({
        bot: seat.name,
        botId: seat.id,
        repo: repo.name,
        kind: 'intake',
        subjectType: 'request',
        subjectRef,
        skill: DISCOVER_SKILL,
        whenBlocked: 'refuse',
        recorded: ({ taskId }) => {
          attached = this.deps.store.attachTask(run.id, taskId);
        },
      });
    } catch (error) {
      // A start that never became a task leaves no run behind to hold the
      // repository's one live run.
      await attached.catch(() => undefined);
      await this.deps.store.removeRun(run.id).catch(() => undefined);
      await this.deps.store.finish(run.id, 'failed', error instanceof Error ? error.message : String(error)).catch(() => undefined);
      if (error instanceof BotBusyError) {
        const words = await this.deps.busyWords(error, seat.id, { repoId: repo.id, subjectRef }).catch(() => 'running all it may at once');
        throw new HttpFailure(409, `${seat.name}, the intake seat, is ${words}; start the Discover run again once it is free`);
      }
      throw error;
    }
    await attached;
    if (opened.error) {
      // hostd refused it: the task row is failed, and so is the run.
      await this.deps.store.finish(run.id, 'failed', `hostd refused: ${opened.error}`);
      throw new HttpFailure(502, `the Discover run could not start: ${opened.error}. Run: openadlc doctor`, { run: run.id });
    }
    await this.audited(input.actor, repo, run, lenses);
    const now = (await this.deps.store.getRun(run.id)) ?? run;
    return new WithStatus(202, { run: viewOf(now, repo) });
  }

  private async audited(actor: string, repo: DiscoverRepo, run: DiscoverRun, lenses: string[]): Promise<void> {
    await this.deps
      .audit({ actor, action: 'discover.started', target: repo.fullName, payload: { run: run.id, lenses } })
      .catch((error: unknown) => console.warn(`[bridge] could not audit the Discover run on ${repo.fullName}: ${error instanceof Error ? error.message : error}`));
  }

  /** A run of this repository, with its proposals; 404 for one of another repository. */
  async view(name: string, id: string): Promise<{ run: DiscoverRunView; proposals: DiscoverProposalView[] }> {
    const repo = await this.deps.repo(name);
    if (!repo) throw new HttpFailure(404, `${name || 'that'} is not a repository this install manages; add it in Settings → Repositories first`);
    const run = /^[0-9a-f-]{36}$/i.test(id) ? await this.deps.store.getRun(id) : null;
    if (!run || run.repoId !== repo.id) throw new HttpFailure(404, `${repo.fullName} has no Discover run ${id}`);
    const proposals = await this.deps.store.proposalsOf(run.id);
    return { run: viewOf(run, repo), proposals: proposals.map(proposalView) };
  }

  /** The documents a run's session is given, at its start and on a resume. */
  async context(subjectRef: string): Promise<ContextDocument[]> {
    const prefix = discoverRunPrefixOf(subjectRef);
    const run = prefix ? await this.deps.store.runByPrefix(prefix) : null;
    const repo = run ? await this.deps.repoById(run.repoId) : null;
    if (!run || !repo) return [];
    const earlier = await this.deps.store.latestDoneProposals(repo.id, EARLIER_PROPOSALS_GIVEN).catch(() => []);
    return [runDocument(repo, run), earlierDocument(earlier)];
  }

  /** The run a task is for, by its subject; null for any other task. */
  private async runOf(task: DiscoverTask): Promise<DiscoverRun | null> {
    if (task.skill !== DISCOVER_SKILL) return null;
    const prefix = discoverRunPrefixOf(task.subjectRef);
    return prefix ? this.deps.store.runByPrefix(prefix) : null;
  }

  /**
   * Stores what hostd posted for a task's run, once. Refused unless the task
   * runs the discover skill, is the run's task, and the run is still running
   * with nothing recorded. The body is checked again as the session's marker
   * was: hostd is not trusted to have done it.
   */
  async record(taskId: string, body: { commit?: unknown; proposals?: unknown; dropped?: unknown; note?: unknown }): Promise<{ stored: number; dropped: number }> {
    const task = await this.deps.task(taskId);
    if (!task) throw new HttpFailure(404, 'unknown task');
    if (task.skill !== DISCOVER_SKILL) throw new HttpFailure(409, `${task.subjectRef} is not a Discover run; only a discover task reports proposals`);
    const run = await this.runOf(task);
    if (!run || run.taskId !== task.id) throw new HttpFailure(409, `${task.subjectRef} is not this task's Discover run`);
    if (run.state !== 'running' || run.commit) throw new HttpFailure(409, `the Discover run ${run.id} has ${run.state === 'running' ? 'already recorded its proposals' : run.state === 'done' ? 'finished' : 'failed'}`);
    const commit = typeof body.commit === 'string' ? body.commit : '';
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new HttpFailure(400, 'commit is the snapshot’s 40-character commit');
    if (!Array.isArray(body.proposals)) throw new HttpFailure(400, 'proposals is a list');
    const checked = checkProposals(body.proposals);
    const reported = typeof body.dropped === 'number' && Number.isSafeInteger(body.dropped) && body.dropped > 0 ? body.dropped : 0;
    const dropped = reported + checked.dropped;
    const stored = await this.deps.store.record(run.id, {
      commit,
      proposals: checked.proposals.map((one) => ({ ...one, fingerprint: proposalFingerprint(one.lens, one.key) })),
      dropped,
      note: discoverNote(body.note),
    });
    if (!stored) throw new HttpFailure(409, `the Discover run ${run.id} has already recorded its proposals, or has ended`);
    return { stored: checked.proposals.length, dropped };
  }

  /** Why a discover task that ended `done` failed: its run has nothing recorded. Null for any other task, and for one that recorded. */
  async missing(task: DiscoverTask): Promise<string | null> {
    if (task.skill !== DISCOVER_SKILL) return null;
    const run = await this.runOf(task);
    if (!run) return 'the Discover run it was for is gone';
    return run.commit ? null : 'the Discover run ended without its proposals';
  }

  /** Ends a task's run with its task: `done` once its result is recorded, `failed` with the task's reason on any other end. */
  async ended(task: DiscoverTask, state: string, reason: string | null): Promise<void> {
    const run = await this.runOf(task);
    if (!run || run.state !== 'running') return;
    if (state === 'done' && run.commit) await this.deps.store.finish(run.id, 'done');
    else await this.deps.store.finish(run.id, 'failed', reason ?? `its task ${state}`);
  }
}

/** The service as the bridge runs it: the platform database, GitHub read as the automation account, and the task service's starts. */
export function liveDiscoverDeps(input: {
  open: TaskService['open'];
  /** The automation account's client, or null when none is connected; only `commitOf` is read. */
  github: () => Promise<{ commitOf(repo: string, ref: string): Promise<{ sha: string }> } | null>;
}): DiscoverDeps {
  const asRepo = (repo: { id: string; name: string; fullName: string; defaultBranch: string }): DiscoverRepo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
  });
  return {
    // Each read when it is called, not when the routes are registered: a
    // bridge, or a test, that registers every route reads none of these.
    store: {
      startRun: (run) => discover.startRun(run),
      recordEmpty: (run) => discover.recordEmpty(run),
      attachTask: (runId, taskId) => discover.attachTask(runId, taskId),
      record: (runId, result) => discover.record(runId, result),
      finish: (runId, state, reason) => discover.finish(runId, state, reason),
      getRun: (id) => discover.getRun(id),
      runByPrefix: (prefix) => discover.runByPrefix(prefix),
      runOfTask: (taskId) => discover.runOfTask(taskId),
      proposalsOf: (runId) => discover.proposalsOf(runId),
      latestDoneProposals: (repoId, limit) => discover.latestDoneProposals(repoId, limit),
      removeRun: (id) => discover.removeRun(id),
    },
    repo: async (name) => {
      const repo = name ? await repos.getRepoByName(name) : null;
      return repo ? asRepo(repo) : null;
    },
    repoById: async (id) => {
      const repo = (await repos.listRepos()).find((one) => one.id === id);
      return repo ? asRepo(repo) : null;
    },
    intakeSeat: async () => {
      const seat = (await bots.listBots()).find((bot) => bot.role === 'intake');
      return seat ? { id: seat.id, name: seat.name } : null;
    },
    open: input.open,
    defaultBranchState: async (repo) => {
      const client = await input.github().catch(() => null);
      if (!client) return 'unknown';
      try {
        await client.commitOf(repo.fullName, repo.defaultBranch);
        return 'present';
      } catch (error) {
        // GitHub answers 409 "Git Repository is empty" for a repository with no commit.
        return error instanceof GitHubApiError && error.status === 409 ? 'empty' : 'unknown';
      }
    },
    busyWords,
    audit: async (entry) => {
      await audit(entry);
    },
    task: async (id) => {
      const task = await tasks.getTask(id);
      return task ? { id: task.id, skill: task.skill, subjectRef: task.subjectRef, state: task.state } : null;
    },
  };
}

/**
 * The context of a `discover:` subject, read from the platform database: what
 * `TaskService` gives a run's session at its start and on a resume, since
 * `extraContext` is not kept across one.
 */
export async function discoverContext(subjectRef: string): Promise<ContextDocument[]> {
  return new DiscoverService(liveDiscoverDeps({ open: async () => Promise.reject(new Error('not used')), github: async () => null })).context(subjectRef);
}

export function registerDiscoverRoutes(router: Router, service: Pick<DiscoverService, 'start' | 'view'>): void {
  /**
   * Starts a Discover run on a managed repository: an intake-seat task that
   * reads its default branch and stores proposals, writing nothing to
   * GitHub. Any console user may start one, as any may file a request.
   */
  router.post('/v1/repos/:name/discover', async ({ params, body, identity }) => {
    const input = await body<{ lenses?: unknown }>().catch(() => ({}) as { lenses?: unknown });
    return service.start({ name: params.name ?? '', lenses: (input ?? {}).lenses, actor: identity });
  });

  router.get('/v1/repos/:name/discover/runs/:id', async ({ params }) => service.view(params.name ?? '', params.id ?? ''));
}
