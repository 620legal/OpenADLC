import { recordEvent, threads, type Role } from '@openadlc/db';
import type { GitHubClient } from '@openadlc/github';
import { BOT_ROLES, STAGE_COLUMN_TITLES, roleLabel, type BotRole, type ContextDocument, type StageKey } from '@openadlc/shared';
import { continuesBranch } from './build-left.js';
import { CI_FAILED, newestCiRun } from './ci-usage.js';
import type { Item, ItemLink, ItemTask, ItemView } from './items.js';
import { readSeatPauses, seatPausedWords, type SeatPause } from './seat-pause.js';
import type { SendBack } from './send-back.js';
import type { StageHandoff } from './stage-handoff.js';
import type { TaskService } from './task-service.js';
import { publicNameOf } from './thread-view.js';
import { ACTIVE_STATES, REVIEW_ASKED_AGAIN, parseRef } from './work.js';

/**
 * A person's message to a role on a work item starts that role's work there,
 * or says plainly that it will not.
 *
 * A message to a role used to post a GitHub comment and nothing else; the
 * role read it only when something else next started it. On the GCP install
 * (v0.1.11, 2026-10-24) a person asked core#5's builder to make the scope
 * check accept any heading level "in this PR"; the composer sent it to the
 * lead reviewer, the role that had last spoken, it was posted on #7, no task
 * started, and ten minutes later the merge line was still dropping #7 on
 * every pass. So now:
 *
 * - the builder, on an issue in Build or its pull request in Review: a patch
 *   round, briefed with the message (`SendBack.fromMessage`); on an issue in
 *   Build whose build ended without its pull request, or failed, that build
 *   again from its branch, as a person's comment on GitHub does;
 * - a reviewer, on a pull request in Review: its review again, with the
 *   message — the lead's only once no other seat's review is under way, since
 *   the lead decides last;
 * - design, on an issue in Design: its design pass (`StageHandoff.staffing`);
 * - intake, on a request: its triage, which reads the request's thread, the
 *   message in it; on an issue in Intake, its triage of the issue.
 *
 * Anything else starts nothing, and so does a held item, a paused seat or
 * paused work: the composer says so before the message is sent ("posted as a
 * comment; nothing starts: …", from the item's `routes`), and the item's
 * timeline says the same once it is. A task waiting on an answer is not
 * started again: the message is that answer (`routeItemMessage`).
 *
 * Only a person signed in to the console sends one (`POST
 * /v1/items/:subject/messages`, a user's route), and the brief is their own
 * words: nothing anybody wrote on GitHub starts work this way.
 */

/** What a message to a role starts on an item, before it is sent and once it is. */
export type MessageStart = { kind: 'starts'; what: string } | { kind: 'nothing'; why: string };

/** What only the bridge can read about whether a message would start work. */
export interface StartFacts {
  /** Seats a person paused from Crew, by name, each in the words a refusal uses. */
  seatPauses?: Readonly<Record<string, string>>;
  /** Why new work may not start in the item's repository (`DispatchGate.paused`); null when it may. */
  workPaused?: string | null;
  /** The pull request as GitHub has it now; null when it was not read. */
  pull?: { state: 'open' | 'closed' | 'merged'; headRef: string; headSha: string } | null;
  /** Whether CI's newest run on the pull request's head failed; null when not known. */
  ciRed?: boolean | null;
}

/** What `whatStarts` reads of an item's view. */
export interface StartView {
  stage: StageKey | null;
  tasks: readonly Pick<ItemTask, 'bot' | 'role' | 'kind' | 'state' | 'subjectRef' | 'branch' | 'exitReason'>[];
  held?: { by: string; why: string | null } | null;
  issue?: { number: number } | null;
  pullRequest?: { number: number } | null;
  request?: { id?: string; state: string } | null;
  links?: readonly Pick<ItemLink, 'kind' | 'repo' | 'number' | 'state'>[];
}

/** The roles a message starts work for. */
const STARTED_BY_A_MESSAGE: ReadonlySet<string> = new Set(['intake', 'spec', 'implement', 'review_lead', 'review_second', 'review_security']);
const REVIEWERS: ReadonlySet<string> = new Set(['review_lead', 'review_second', 'review_security']);

const starts = (what: string): MessageStart => ({ kind: 'starts', what });
const nothing = (why: string): MessageStart => ({ kind: 'nothing', why });

function roleName(role: string): string {
  return (BOT_ROLES as readonly string[]).includes(role) ? roleLabel(role as BotRole) : role.replace(/_/g, ' ');
}

/** "under way", or "paused" for one paused at its cap or by a person. */
function going(state: string): string {
  return state === 'paused' ? 'paused' : 'under way';
}

const live = (state: string): boolean => (ACTIVE_STATES as readonly string[]).includes(state);

/**
 * What a message to `role`'s seat `bot` starts on an item, from what the
 * item's view and the bridge know: the line the composer shows before it is
 * sent (`messageRoutes`), and the decision the send acts on (`MessageStarts`).
 * Pure, so the two cannot disagree.
 */
export function whatStarts(input: {
  role: string;
  bot: string;
  view: StartView;
  item: Pick<Item, 'key' | 'refs' | 'repo'>;
  facts: StartFacts;
}): MessageStart {
  const would = roleWork(input);
  if (would.kind === 'nothing') return would;
  // What it would start is held back: by the item, the work, or the seat.
  const { view, facts, item, bot } = input;
  if (view.held) {
    return nothing(`${item.key} is held by ${view.held.by}${view.held.why ? ` (${view.held.why})` : ''}; resume it on its card to let work start`);
  }
  if (facts.workPaused) return nothing(facts.workPaused);
  const pause = facts.seatPauses?.[bot];
  if (pause) return nothing(`${pause}; resume it on the Crew page`);
  return would;
}

function roleWork(input: { role: string; bot: string; view: StartView; item: Pick<Item, 'key' | 'refs' | 'repo'>; facts: StartFacts }): MessageStart {
  const { role, bot, view, item, facts } = input;
  const who = `the ${roleName(role)}`;
  if (!STARTED_BY_A_MESSAGE.has(role)) return nothing(`a message does not start ${who}'s work, which starts when the work reaches it`);

  const issueRef = view.issue ? `#${view.issue.number}` : item.key;
  const issueSubject = item.refs.issue;
  const pr = view.pullRequest?.number ?? null;
  const prSubject = item.refs.pullRequest;
  const linked = pr ? view.links?.find((link) => link.kind === 'pull' && link.number === pr && (!item.repo || link.repo === item.repo)) : undefined;
  const pullState = facts.pull?.state ?? linked?.state ?? 'open';
  const where = view.stage ? `${issueRef} is in ${STAGE_COLUMN_TITLES[view.stage]}` : `${item.key} is on no stage of the board`;
  const mine = view.tasks.filter((task) => task.bot === bot && live(task.state));

  if (role === 'implement') {
    // Whichever builder seat it is: the lease's builder takes the round, and
    // one round at a time goes on a pull request (`SendBack.fromMessage`).
    const building = view.tasks.find(
      (task) => live(task.state) && ((task.kind === 'patch' && task.subjectRef === prSubject) || (task.kind === 'implement' && task.subjectRef === issueSubject)),
    );
    const onWork = view.stage === 'review' || view.stage === 'build';
    if (pr && onWork) {
      if (pullState !== 'open') return nothing(`pull request #${pr} is ${pullState}`);
      if (building) return nothing(`its ${building.kind === 'patch' ? `patch round on pull request #${pr}` : `build of ${issueRef}`} is already ${going(building.state)}`);
      return starts(`a patch round on pull request #${pr}`);
    }
    if (view.stage === 'build' && view.issue) {
      if (building) return nothing(`its build of ${issueRef} is already ${going(building.state)}`);
      // The view's tasks are newest first.
      const last = view.tasks.find((task) => task.kind === 'implement' && task.subjectRef === issueSubject);
      if (last && (continuesBranch(last) || last.state === 'failed')) {
        return starts(`its build of ${issueRef} again${last.branch && continuesBranch(last) ? `, from ${last.branch}` : ''}`);
      }
      return nothing(`${issueRef} waits for the dispatcher to lease it to a builder, and its build reads this on the issue when it starts`);
    }
    return nothing(`the builder works on an issue in Build or its pull request in Review, and ${where}`);
  }

  if (role === 'spec') {
    if (view.stage === 'spec' && view.issue) {
      const designing = view.tasks.find((task) => task.subjectRef === issueSubject && live(task.state));
      if (designing) return nothing(`${designing.kind === 'spec' ? 'its design pass' : 'work'} on ${issueRef} is already ${going(designing.state)}`);
      return starts(`its design pass on ${issueRef}`);
    }
    return nothing(`${who} designs an issue in Design, and ${where}`);
  }

  if (role === 'intake') {
    if (!view.issue && view.request && item.refs.request) {
      if (view.request.state === 'filed') return nothing('the request has been filed as an issue already');
      if (view.request.state === 'abandoned') return nothing('the request was abandoned');
      const triaging = view.tasks.find((task) => task.subjectRef === item.refs.request && live(task.state));
      if (triaging) return nothing(`its triage of the request is already ${going(triaging.state)}`);
      return starts('its triage of the request');
    }
    if (view.stage === 'intake' && view.issue) {
      const triaging = view.tasks.find((task) => task.subjectRef === issueSubject && live(task.state));
      if (triaging) return nothing(`${triaging.kind === 'intake' ? 'its triage' : 'work'} of ${issueRef} is already ${going(triaging.state)}`);
      return starts(`its triage of ${issueRef}`);
    }
    return nothing(`intake triages a request or an issue in Intake, and ${where}`);
  }

  // A reviewer.
  if (!pr || !prSubject) return nothing(`${who} reviews a pull request, and ${issueRef} has none yet`);
  if (pullState !== 'open') return nothing(`pull request #${pr} is ${pullState}`);
  if (view.stage !== 'review') return nothing(`${who} reviews a pull request in Review, and ${where}`);
  const reviewing = mine.find((task) => task.kind === 'review' && task.subjectRef === prSubject);
  if (reviewing) return nothing(`its review of pull request #${pr} is already ${going(reviewing.state)}`);
  if (role === 'review_lead') {
    // The lead decides last, from every other seat's review of this round:
    // started beside one, it would decide without it, and its review would
    // stand as this diff's.
    const other = view.tasks.find((task) => task.kind === 'review' && task.subjectRef === prSubject && task.bot !== bot && live(task.state) && task.role !== 'review_lead');
    if (other) {
      return nothing(
        `the lead reviews last, and the ${roleName(other.role ?? 'reviewer')}’s review of pull request #${pr} is ${going(other.state)}; the lead reads this on the pull request when its turn comes`,
      );
    }
  }
  const before = view.tasks.some((task) => task.bot === bot && task.kind === 'review' && task.subjectRef === prSubject);
  return starts(`its review of pull request #${pr}${before ? ' again' : ''}`);
}

/** Where the message itself went, as the timeline's line begins. */
function placeWords(subject: string): string {
  if (parseRef(subject)) return 'posted as a comment';
  if (subject.startsWith('request:')) return 'added to the request’s thread';
  return 'kept in OpenADLC';
}

/**
 * `message.md`: the person's message, as the task's brief. A task on GitHub
 * is briefed from its conversation, where the message is too, posted as the
 * seat; this says it is why the task started, which the conversation cannot.
 */
export function messageBrief(input: { identity: string; text: string; role: string; where: string | null }): ContextDocument {
  const name = publicNameOf(input.identity);
  return {
    name: 'message.md',
    title: `What ${name} asked of you in the OpenADLC console, which this task started from`,
    content: [
      `# ${name} wrote to the ${roleName(input.role)} in the OpenADLC console`,
      '',
      'This task started from this message: it is your brief, beside everything your skill reads. Do what it asks within your skill’s rules and the paths you hold, and where they do not allow it, say so rather than working around them.',
      ...(input.where ? ['', `It is on ${input.where} as well, posted as you.`] : []),
      '',
      input.text.trim(),
    ].join('\n'),
  };
}

/** How long a pull request's head and CI, read for an item's view, are used for: the view is read on every change. */
const CHECKS_KEPT_MS = 60_000;
const CHECKS_KEPT = 500;

export interface MessageStartDeps {
  /** The automation account's client, which reads the pull request and its CI; null when none is connected. */
  client(): Promise<Pick<GitHubClient, 'getPullRequest' | 'request'> | null>;
  taskService: Pick<TaskService, 'open'>;
  sendBack: Pick<SendBack, 'fromMessage'>;
  stages: Pick<StageHandoff, 'staffing'>;
  /** A request's triage, as Try again starts it (`startTriage`): queued, and where, when intake is busy. Throws when it is refused. */
  triage(requestId: string): Promise<{ queued: boolean; position?: number | null }>;
  /** A build run again from its branch, as Try again and a person's comment do (`retryTask`). Throws when it is refused. */
  rebuild(taskId: string, actor: string): Promise<unknown>;
  /** Why new work may not start, in a repository or the install (`DispatchGate.paused`); null when it may. */
  paused(repo: string | null): string | null;
  seatPauses?: () => Promise<Record<string, SeatPause>>;
  /** What the route leaves running once it has answered (`Afterwards`); absent, the start is made before it answers. */
  afterwards?: { run(where: { subjectRef?: string | null }, what: string, work: () => Promise<unknown>): void };
  now?: () => number;
}

/** An item as the item routes read it (`readItem`). */
export interface ReadItem {
  item: Item;
  view: ItemView;
  repo: { id: string; name: string; fullName: string } | null;
  facts?: StartFacts;
}

type Outcome = { started: true; what?: string } | { started: false; why: string };

export class MessageStarts {
  constructor(private readonly deps: MessageStartDeps) {}

  private readonly checked = new Map<string, { at: number; read: Promise<Pick<StartFacts, 'pull' | 'ciRed'>> }>();

  /**
   * What `whatStarts` needs that only the bridge can read: the seats paused,
   * whether work is paused, and for a pull request in Build or Review its
   * state, and in Review whether CI's newest run on its head failed — which
   * also makes the builder the role a message on it goes to by default
   * (`routeItemMessage`). GitHub's answers are kept a minute: the view is read
   * on every change to the item.
   */
  async facts(read: Pick<ReadItem, 'item' | 'view' | 'repo'>): Promise<StartFacts> {
    const pauses = await (this.deps.seatPauses ?? readSeatPauses)().catch(() => ({}) as Record<string, SeatPause>);
    const seatPauses = Object.fromEntries(Object.entries(pauses).map(([seat, pause]) => [seat, seatPausedWords(seat, pause)]));
    const workPaused = this.deps.paused(read.repo?.name ?? read.item.repo ?? null);
    const pr = read.view.pullRequest?.number ?? null;
    const stage = read.view.stage;
    const checks = pr && read.repo && (stage === 'review' || stage === 'build') ? await this.checks(read.repo.fullName, pr, stage === 'review') : {};
    return { seatPauses, workPaused, ...checks };
  }

  private checks(repoFullName: string, pr: number, withCi: boolean): Promise<Pick<StartFacts, 'pull' | 'ciRed'>> {
    const key = `${repoFullName.toLowerCase()}#${pr}:${withCi ? 'ci' : 'pull'}`;
    const now = this.deps.now?.() ?? Date.now();
    const kept = this.checked.get(key);
    if (kept && now - kept.at < CHECKS_KEPT_MS) return kept.read;
    const read = (async (): Promise<Pick<StartFacts, 'pull' | 'ciRed'>> => {
      const client = await this.deps.client().catch(() => null);
      const got = client ? await client.getPullRequest(repoFullName, pr).catch(() => null) : null;
      if (!client || !got) return { pull: null, ciRed: null };
      const pull = { state: got.merged ? ('merged' as const) : got.state, headRef: got.headRef, headSha: got.headSha };
      if (!withCi || pull.state !== 'open') return { pull, ciRed: null };
      // No run on the head is not red: a crew branch's CI waits for the lead.
      const ciRed = await newestCiRun(client, repoFullName, got.headSha).then(
        (run) => Boolean(run && run.status === 'completed' && CI_FAILED.has(run.conclusion ?? '')),
        () => null,
      );
      return { pull, ciRed };
    })();
    this.checked.delete(key);
    this.checked.set(key, { at: now, read });
    const oldest = this.checked.keys().next().value;
    if (this.checked.size > CHECKS_KEPT && oldest !== undefined) this.checked.delete(oldest);
    return read;
  }

  /** What a message to this route's seat would start, as the composer says it. */
  preview(input: { role: string; bot: string; read: Pick<ReadItem, 'item' | 'view'>; facts: StartFacts }): MessageStart {
    return whatStarts({ role: input.role, bot: input.bot, view: input.read.view, item: input.read.item, facts: input.facts });
  }

  /**
   * Starts what the message's role has to do on the item, once the message
   * is posted, with the message as its brief; or says on the item's timeline,
   * in the seat's thread about where it went, why nothing starts. With
   * `afterwards`, the start is made once the route has answered, as an
   * answer's resume is, and one that is then refused is said the same way.
   */
  async start(input: {
    route: { bot: string; botId: string; role: string; subject: string };
    read: ReadItem;
    text: string;
    identity: string;
    /** The sender's console role, which the router checked: only a person with one starts anything. */
    access?: Role;
    message: { id: string; githubUrl: string | null };
  }): Promise<MessageStart> {
    const { route, read } = input;
    const place = placeWords(route.subject);
    const say = async (text: string): Promise<void> => {
      const thread = await threads.ensureThread({ botId: route.botId, repoId: read.repo?.id ?? null, subjectRef: route.subject });
      await threads.addMessage({ threadId: thread.id, kind: 'sys', author: 'openadlc', text, payload: { messageId: input.message.id } });
    };
    const refuse = async (why: string, verb = 'starts'): Promise<MessageStart> => {
      await say(`${place}; nothing ${verb}: ${why}`).catch((error: unknown) =>
        console.warn(`[bridge] ${route.subject}: could not say why the message started nothing: ${error instanceof Error ? error.message : error}`),
      );
      return nothing(why);
    };
    if (input.access !== 'admin' && input.access !== 'user') return refuse('only a person signed in to the console starts work with a message');

    const facts = read.facts ?? (await this.facts(read));
    const decided = this.preview({ role: route.role, bot: route.bot, read, facts });
    if (decided.kind === 'nothing') return refuse(decided.why);

    const brief = messageBrief({ identity: input.identity, text: input.text, role: route.role, where: input.message.githubUrl });
    const run = async (): Promise<MessageStart> => {
      const outcome = await this.run({ ...input, facts, brief }).catch((error: unknown) => ({
        started: false as const,
        why: error instanceof Error ? error.message : String(error),
      }));
      if (outcome.started) return starts(outcome.what ?? decided.what);
      console.warn(`[bridge] ${route.subject}: a message to the ${roleName(route.role)} started nothing: ${outcome.why}`);
      return refuse(outcome.why, 'started');
    };
    if (!this.deps.afterwards) return run();
    this.deps.afterwards.run({ subjectRef: route.subject }, `Starting ${decided.what}`, run);
    return decided;
  }

  private async run(input: {
    route: { bot: string; botId: string; role: string; subject: string };
    read: ReadItem;
    text: string;
    identity: string;
    message: { id: string; githubUrl: string | null };
    facts: StartFacts;
    brief: ContextDocument;
  }): Promise<Outcome> {
    const { route, read, brief } = input;
    const { view, item, repo } = read;
    const no = (why: string): Outcome => ({ started: false, why });
    const pr = view.pullRequest?.number ?? null;
    const issue = view.issue?.number ?? null;

    if (route.role === 'implement') {
      if (!repo) return no(`${item.key} is in no repository OpenADLC works in`);
      if (pr && (view.stage === 'review' || view.stage === 'build')) {
        const sent = await this.deps.sendBack.fromMessage({
          repoName: repo.name,
          prNumber: pr,
          actor: input.identity,
          reason: input.text,
          brief,
          commentUrl: input.message.githubUrl,
        });
        return sent.started ? { started: true, what: `patch round ${sent.round} on pull request #${pr}` } : no(sent.why);
      }
      const last = view.tasks.find((task) => task.kind === 'implement' && task.subjectRef === item.refs.issue);
      if (!last) return no(`${item.key} has no build to run again`);
      await this.deps.rebuild(last.id, input.identity);
      return { started: true };
    }

    if (route.role === 'spec' || (route.role === 'intake' && issue)) {
      if (!repo || !issue) return no(`${item.key} has no issue in a repository OpenADLC works in`);
      const staffed = await this.deps.stages.staffing({ repoName: repo.name, issueNumber: issue, stage: route.role === 'spec' ? 'spec' : 'intake', brief: [brief] });
      if (staffed.started) return { started: true };
      // Turned away by a seat running all it may at once: the issue waits on
      // that seat and starts when it has room (`StageRunner`), and its task
      // reads the message on the issue then.
      if (staffed.later) return { started: true, what: `${route.role === 'spec' ? 'its design pass' : 'its triage'} of #${issue} once ${route.bot} has room` };
      return no(staffed.why ?? 'it did not start');
    }

    if (route.role === 'intake') {
      const requestId = view.request?.id ?? item.request?.id;
      if (!requestId) return no('there is no request to triage');
      // Its triage reads the request's thread, where the message now is (`request.md`).
      const triage = await this.deps.triage(requestId);
      if (!triage.queued) return { started: true };
      return { started: true, what: `its triage of the request when its turn in line comes${triage.position ? ` (it is number ${triage.position})` : ''}` };
    }

    // A reviewer: its review of the pull request again, briefed with the message.
    if (!repo || !pr) return no(`${item.key} has no pull request to review`);
    const subjectRef = `${repo.name}#${pr}`;
    const client = await this.deps.client().catch(() => null);
    const pull = client ? await client.getPullRequest(repo.fullName, pr).catch(() => null) : null;
    if (!pull) return no(`GitHub did not answer for pull request #${pr}`);
    if (pull.state !== 'open') return no(`pull request #${pr} is ${pull.merged ? 'merged' : 'closed'}`);
    // The seat's reviews before this are no answer to what the person asked:
    // a start turned away below leaves it to the gate sweep to ask again
    // (`lastAskedAgain`), and one that starts is this diff's review.
    await (async () => recordEvent({ source: 'platform', type: REVIEW_ASKED_AGAIN, payload: { subjectRef, seat: route.bot, messageId: input.message.id } }))().catch((error: unknown) =>
      console.warn(`[bridge] ${subjectRef}: ${route.bot} was not recorded as asked again: ${error instanceof Error ? error.message : error}`),
    );
    try {
      const opened = await this.deps.taskService.open({
        bot: route.bot,
        botId: route.botId,
        repo: repo.name,
        kind: 'review',
        subjectType: 'pr',
        subjectRef,
        skill: 'pr-review',
        branch: pull.headRef,
        issueNumber: issue,
        checkoutExistingBranch: true,
        extraContext: [brief],
      });
      return opened.error ? no(opened.error) : { started: true };
    } catch (error) {
      // A seat running all it may at once is not asked later by anything
      // that carries the message, so the person hears it now.
      if (error instanceof Error && error.name === 'BotBusyError') {
        return no(`${route.bot} is running all the tasks it may at once; write again once one of them ends`);
      }
      throw error;
    }
  }
}
