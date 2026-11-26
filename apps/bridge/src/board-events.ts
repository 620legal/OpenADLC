import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  boardEvents,
  bots,
  issues,
  mergeLines,
  repos,
  requests,
  type AskedRow,
  type HandsOffAuditRow,
  type HeldAuditRow,
  type LiveTaskRow,
  type MergedRow,
  type StartedRow,
} from '@openadlc/db';
import { envOr, leadReviewer, loadYamlFile, resolveBotRef, reviewRulesSchema, seatOf, whoWrote, type ReviewRules } from '@openadlc/shared';
import { DEFAULT_REVIEW } from './config.js';
import { heldForPerson } from './merge-line.js';
import { isCostCapGate } from './needs-you-audience.js';
import { requestPrefixOf } from './request-context.js';
import { HttpFailure, STREAMING, type Router } from './router.js';
import { describeSubject, requestNamed } from './thread-view.js';
import { ignoredSubjects, parseRef, type IssueFacts } from './work.js';

/**
 * What the crew is doing, as it happens and over the last thirty days: the
 * feed behind `GET /v1/board/events`, which `openadlc watch` prints and the
 * console's bell listens to, and `GET /v1/board/events/history`, which the
 * bell's panel and the Activity page list.
 *
 * Each event is read from the table it already happens in — a task's
 * `started_at`, a gate's `created_at`, a stage move into Merged, the merge
 * line's holds and the `pull.held` audit row, GitHub's deliveries of a pull
 * request opened and a review submitted, a release run's `published_at`.
 * Nothing is emitted by the writers: tasks start in the dispatcher and the
 * task service, gates open from several routes, and merges land through the
 * merge line or through a person on GitHub, and a writer that forgets to emit
 * is a feed that quietly stops covering it (`thread-stream.ts` says the same).
 * The stream and the history read through the same `SOURCES` and derive each
 * event the same way, so a type added once is in both.
 * docs/adr/0021-board-events-are-read-from-the-tables-they-happen-in.md and
 * docs/adr/0081-board-event-history-is-a-read-of-the-tables-events-happen-in.md.
 */

const PROBE_MS = 2_000;
/**
 * How far back each probe reads past where the last one got to. A row written
 * with `now()` inside a transaction can commit after a probe has moved past
 * its timestamp; read from the cursor alone, it was never sent.
 */
const OVERLAP_MS = 10_000;
/** The event ids kept to drop what the overlap reads twice: far more than ten seconds of events. */
const SENT_KEPT = 2_000;
/** A comment frame, so an idle stream is still a connection to anything in between, and the CLI can tell quiet from dead. */
const PING_MS = 25_000;
const TEXT_MAX = 200;

/** How far back the history reaches, by the database's clock. */
export const HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 200;
/** Each source's rows per read of the history: a page of fifty would otherwise read every table six times over. */
const HISTORY_BATCH_MIN = 100;

/**
 * One board event, the contract `openadlc watch --json` prints unchanged.
 * `type` is open: a client ignores one it does not know, so types can be
 * added without breaking it.
 */
export interface BoardEvent {
  id: string;
  type: string;
  at: string;
  /** The seat that did it; null when none did (a merge-line hold, a merge by a person or by OpenADLC, a release). */
  bot: string | null;
  item: BoardItem;
  /** One line, at most 200 characters. */
  text: string;
}

export interface BoardItem {
  /** The subject as the bridge writes it: `OpenADLC#227`, `request:<id8>`, `release:OpenADLC@v1.4.2`. */
  ref: string;
  /** The repository's full name; null for a request filed in no repository yet. */
  repo: string | null;
  url: string | null;
}

/** A task queued, running or paused, as `GET /v1/board/tasks` answers it and `openadlc ls` prints it. */
export interface LiveTask {
  id: string;
  bot: string | null;
  kind: string;
  item: BoardItem;
  state: LiveTaskRow['state'];
  since: string | null;
  costUsd: number;
  capUsd: number;
}

/** A merge-line entry, as much of it as a hold is read from. */
export interface LineEntry {
  id: string;
  repoName: string;
  prNumber: number;
  state: string;
  detail: string | null;
}

/** One seat, as `whoWrote` tells which of them wrote something on GitHub. */
export interface CrewFact {
  name: string;
  slot: string;
  githubLogin: string | null;
}

/** What subjects are resolved against: the issues, repositories and requests, and the crew and its lead. */
export interface BoardFacts {
  issues: (Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'title' | 'url' | 'labels'> & { repoId: string })[];
  repos: { id: string; name: string; fullName: string }[];
  requests: { id: string; text: string; repoId: string | null; issueNumber: number | null; state: string }[];
  crew: CrewFact[];
  /** The lead reviewer's seat as it is named now; null when the review rules name none. */
  leadSeat: string | null;
}

export type PullOpenedRow = boardEvents.PullOpenedRow;
export type ApprovalRow = boardEvents.ApprovalRow;
export type ReleasePublishedRow = boardEvents.ReleasePublishedRow;
export type HeldLineRow = boardEvents.HeldLineRow;
export type EventWindow = boardEvents.EventWindow;

export interface BoardEventStore {
  dbNow(): Promise<Date>;
  startedIn(window: EventWindow): Promise<StartedRow[]>;
  askedIn(window: EventWindow): Promise<AskedRow[]>;
  mergedIn(window: EventWindow): Promise<MergedRow[]>;
  heldAuditIn(window: EventWindow): Promise<HeldAuditRow[]>;
  /** Pull requests opened by one of the crew's accounts. */
  pullsOpenedIn(window: EventWindow): Promise<PullOpenedRow[]>;
  /** Approving reviews by one of the crew's accounts; whether the lead's is decided against `BoardFacts`. */
  approvalsIn(window: EventWindow): Promise<ApprovalRow[]>;
  releasesPublishedIn(window: EventWindow): Promise<ReleasePublishedRow[]>;
  /** Merge-line entries in `merging` changed in the window: the history's holds. */
  heldLineIn(window: EventWindow): Promise<HeldLineRow[]>;
  /** Hands-off windows turned on and off, and the gates they answered (#383). */
  handsOffAuditIn(window: EventWindow): Promise<HandsOffAuditRow[]>;
  liveTasks(): Promise<LiveTaskRow[]>;
  mergeLine(): Promise<LineEntry[]>;
  facts(): Promise<BoardFacts>;
  /** A request older than the newest `facts` lists, by the prefix a subject carries; null when none, or more than one, has it. */
  requestByPrefix(prefix: string): Promise<BoardFacts['requests'][number] | null>;
}

let reviewRulesRead: ReviewRules | undefined;

/**
 * The review rules as the bridge started with them, read here because the
 * route is registered with no config in reach: config/review.yaml, or the
 * shipped rules without it (`loadBridgeConfig`). Read once: the bridge reads
 * the file once at start too, so a change to it takes a restart either way.
 */
function reviewRulesNow(): ReviewRules {
  if (reviewRulesRead) return reviewRulesRead;
  const path = join(envOr('OPENADLC_CONFIG_ROOT', join(process.cwd(), 'config')), 'review.yaml');
  try {
    reviewRulesRead = existsSync(path) ? loadYamlFile(path, reviewRulesSchema) : DEFAULT_REVIEW;
  } catch {
    // The bridge refuses to start on a malformed file; a display feed falls back rather than throwing every read.
    reviewRulesRead = DEFAULT_REVIEW;
  }
  return reviewRulesRead;
}

/** The lead reviewer's seat, named as the crew names it now; null when the rules name no lead. */
export function leadSeatOf(rules: Pick<ReviewRules, 'reviewers'>, crew: readonly CrewFact[]): string | null {
  try {
    const seat = leadReviewer(rules).seat;
    return resolveBotRef(crew, seat)?.name ?? seat;
  } catch {
    return null;
  }
}

/**
 * The store as the bridge reads it. Each read is looked up when it is called,
 * not when this is built: `roles.test.ts` and the route tests register every
 * route against a mock of `@openadlc/db` that has no `boardEvents`.
 */
export function liveBoardEventStore(): BoardEventStore {
  const crewLogins = async (): Promise<string[]> =>
    (await bots.listBots()).map((bot) => bot.githubLogin).filter((login): login is string => Boolean(login));
  return {
    dbNow: () => boardEvents.dbNow(),
    startedIn: (window) => boardEvents.startedIn(window),
    askedIn: (window) => boardEvents.askedIn(window),
    mergedIn: (window) => boardEvents.mergedIn(window),
    heldAuditIn: (window) => boardEvents.heldAuditIn(window),
    pullsOpenedIn: async (window) => boardEvents.pullsOpenedIn(window, await crewLogins()),
    approvalsIn: async (window) => boardEvents.approvalsIn(window, await crewLogins()),
    releasesPublishedIn: (window) => boardEvents.releasesPublishedIn(window),
    heldLineIn: (window) => boardEvents.heldLineIn(window),
    handsOffAuditIn: (window) => boardEvents.handsOffAuditIn(window),
    liveTasks: () => boardEvents.liveTasks(),
    mergeLine: () => mergeLines.line(),
    facts: async () => {
      const [issueList, repoList, requestList, crewList] = await Promise.all([
        issues.listIssues(),
        // A task's repository may since have been removed: it still names it.
        repos.listRepos({ includeRemoved: true }),
        requests.listRequests(200),
        bots.listBots(),
      ]);
      const crew = crewList.map((bot) => ({ name: bot.name, slot: bot.slot, githubLogin: bot.githubLogin }));
      return {
        issues: issueList,
        repos: repoList,
        requests: requestList.map((one) => ({ ...one, issueNumber: one.issueNumber ?? null })),
        crew,
        leadSeat: leadSeatOf(reviewRulesNow(), crew),
      };
    },
    requestByPrefix: async (prefix) => {
      const found = await requests.findRequestByPrefix(prefix).catch(() => null);
      return found ? { ...found, issueNumber: found.issueNumber ?? null } : null;
    },
  };
}

/** A row read from one of the tables, before its subject is resolved. */
export type RawEvent =
  | { type: 'task.started'; row: StartedRow }
  | { type: 'question.asked'; row: AskedRow }
  | { type: 'task.capped'; row: AskedRow }
  | { type: 'merged'; row: MergedRow }
  | { type: 'pull_request.held'; source: 'audit'; row: HeldAuditRow }
  | { type: 'pull_request.held'; source: 'merge-line'; entry: LineEntry; reason: string; at: string }
  | { type: 'pull_request.opened'; row: PullOpenedRow }
  | { type: 'pull_request.lead_approved'; row: ApprovalRow }
  | { type: 'release.published'; row: ReleasePublishedRow }
  | { type: 'hands_off.on' | 'hands_off.off' | 'hands_off.answered'; row: HandsOffAuditRow };

/**
 * Where every row event is read from, for a window: the live stream and the
 * history both read these, so a type added here is in both. Merge-line holds
 * are not here: the stream sees them as a change in the line, and the history
 * reads the entries held now (`HISTORY_HOLDS`).
 *
 * A gate is classified here, once: the one a task at its cost cap asks
 * (`costCapGate`) is `task.capped`, and only that. Sent as both, the bell had
 * two rows for one stop, the second repeating the first.
 */
export const SOURCES: readonly ((store: BoardEventStore, window: EventWindow) => Promise<RawEvent[]>)[] = [
  async (store, window) => (await store.startedIn(window)).map((row) => ({ type: 'task.started' as const, row })),
  async (store, window) =>
    (await store.askedIn(window)).map((row) => ({ type: isCostCapGate(row.options) ? ('task.capped' as const) : ('question.asked' as const), row })),
  async (store, window) => (await store.mergedIn(window)).map((row) => ({ type: 'merged' as const, row })),
  async (store, window) => (await store.heldAuditIn(window)).map((row) => ({ type: 'pull_request.held' as const, source: 'audit' as const, row })),
  async (store, window) => (await store.pullsOpenedIn(window)).map((row) => ({ type: 'pull_request.opened' as const, row })),
  async (store, window) => (await store.approvalsIn(window)).map((row) => ({ type: 'pull_request.lead_approved' as const, row })),
  async (store, window) => (await store.releasesPublishedIn(window)).map((row) => ({ type: 'release.published' as const, row })),
  async (store, window) =>
    (await store.handsOffAuditIn(window)).map((row) => ({
      type: row.action === 'gate.answer' ? ('hands_off.answered' as const) : row.action,
      row,
    })),
];

/** The holds the history lists: entries waiting on a person now, timed when their row last changed, under the id the stream gives them. */
async function historyHolds(store: BoardEventStore, window: EventWindow): Promise<RawEvent[]> {
  const held: RawEvent[] = [];
  for (const row of await store.heldLineIn(window)) {
    const entry: LineEntry = { id: row.id, repoName: row.repoName, prNumber: row.prNumber, state: row.state, detail: row.detail };
    const reason = heldForPerson(entry);
    if (reason) held.push({ type: 'pull_request.held', source: 'merge-line', entry, reason, at: row.at });
  }
  return held;
}

const HISTORY_SOURCES = [...SOURCES, historyHolds];

function holdId(entryId: string, reason: string): string {
  return `pull_request.held:merge-line:${entryId}:${createHash('sha256').update(reason).digest('hex').slice(0, 8)}`;
}

/** The id an event is sent under and deduplicated by: `<type>:<row key>`. */
export function rawId(raw: RawEvent): string {
  switch (raw.type) {
    case 'task.started':
      return `task.started:${raw.row.taskId}`;
    case 'question.asked':
      return `question.asked:${raw.row.gateId}`;
    case 'task.capped':
      return `task.capped:${raw.row.gateId}`;
    case 'merged':
      return `merged:${raw.row.moveId}`;
    case 'pull_request.held':
      return raw.source === 'audit' ? `pull_request.held:audit:${raw.row.auditId}` : holdId(raw.entry.id, raw.reason);
    case 'pull_request.opened':
      // By the pull request, not the delivery: GitHub redelivers, and it opened once.
      return `pull_request.opened:${raw.row.repoFullName}#${raw.row.prNumber}`;
    case 'pull_request.lead_approved':
      return `pull_request.lead_approved:${raw.row.reviewId}`;
    case 'release.published':
      return `release.published:${raw.row.runId}`;
    case 'hands_off.on':
    case 'hands_off.off':
    case 'hands_off.answered':
      return `${raw.type}:${raw.row.auditId}`;
  }
}

function rawAt(raw: RawEvent): string {
  return 'at' in raw ? raw.at : raw.row.at;
}

/** The subject an event is about, as tasks and threads are filed under it. */
export function subjectOf(raw: RawEvent, facts: Pick<BoardFacts, 'repos'>): string {
  switch (raw.type) {
    case 'task.started':
      return raw.row.subjectRef;
    case 'question.asked':
    case 'task.capped':
      return raw.row.subjectRef ?? '';
    case 'merged':
      return `${raw.row.repoName}#${raw.row.issueNumber}`;
    case 'pull_request.held': {
      if (raw.source === 'merge-line') return `${raw.entry.repoName}#${raw.entry.prNumber}`;
      // The hold wrote the repository's full name; subjects carry its name.
      const match = /^(.+)#(\d+)$/.exec(raw.row.target);
      const repo = match ? facts.repos.find((one) => one.fullName === match[1]) : undefined;
      return repo && match ? `${repo.name}#${match[2]}` : raw.row.target;
    }
    case 'pull_request.opened':
    case 'pull_request.lead_approved':
      return `${raw.row.repoName}#${raw.row.prNumber}`;
    case 'release.published':
      return `release:${raw.row.repoName}@${raw.row.tag ?? raw.row.version ?? raw.row.runId}`;
    case 'hands_off.answered':
      return raw.row.subject ?? '';
    case 'hands_off.on':
    case 'hands_off.off':
      return `hands-off:${raw.row.repo ?? ''}`;
  }
}

const HANDS_OFF_DURATION_WORDS: Record<string, string> = { '1h': 'for 1 hour', '8h': 'for 8 hours', '24h': 'for 24 hours', until_off: 'until turned off' };

/** How a window's end is said: `expired`, `a cap was reached`, or `turned off by X`. */
function handsOffEnd(row: HandsOffAuditRow): string {
  if (row.why === 'expired') return 'expired';
  if (row.why === 'cap') return 'a cap was reached';
  return `turned off by ${row.by ?? row.actor}`;
}

/** A subject as an event or a live task carries it: the ref, the repository's full name, and a link. */
export function itemFor(ref: string, facts: Pick<BoardFacts, 'issues' | 'repos' | 'requests'>): BoardItem {
  const topic = describeSubject(ref, facts);
  const fullName = topic.repo ? (facts.repos.find((one) => one.name === topic.repo)?.fullName ?? topic.repo) : null;
  const url = topic.kind === 'pull_request' ? (topic.pullRequest?.url ?? null) : (topic.issue?.url ?? null);
  return { ref, repo: fullName, url };
}

/** How text names an item: `620legal/OpenADLC#227`, or `request ab12cd34`. */
function labelOf(item: BoardItem): string {
  const parsed = parseRef(item.ref);
  if (parsed) return `${item.repo ?? parsed.repo}#${parsed.number}`;
  const prefix = requestPrefixOf(item.ref);
  if (prefix) return `request ${prefix}`;
  return item.ref || 'nothing in particular';
}

/**
 * One line of at most 200 characters: a question may be paragraphs. Cut on
 * code points: a cut through a surrogate pair puts half an emoji into the
 * event's JSON.
 */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= TEXT_MAX ? flat : `${chars.slice(0, TEXT_MAX - 1).join('')}…`;
}

/** The seat a crew account's post was written by, as `whoWrote` tells it; null for a person, or a shared account the hint does not resolve. */
function seatWho(login: string, crew: readonly CrewFact[], hint: string | null): string | null {
  const author = whoWrote(login, crew, { bot: hint });
  return author.kind === 'openadlc' ? (author.bot?.name ?? null) : null;
}

/** The seat a crew branch names, `agent/<seat>/…`. */
function seatOfBranch(ref: string | null): string | null {
  return ref ? (/^agent\/([^/]+)\//.exec(ref)?.[1] ?? null) : null;
}

const CAP_QUESTION = /^Stopped at the \$(\d+(?:\.\d+)?) cap on .+ after \$(\d+(?:\.\d+)?)/;

/**
 * Whether a row is an event at all once the crew is known: an approval is the
 * lead's only when its author is the lead seat, by `whoWrote`'s rule — the
 * account, or on a shared account the review's own marker, which is only its
 * word. Good enough for a display feed; the merge decision never reads this.
 */
function counts(raw: RawEvent, facts: BoardFacts): boolean {
  if (raw.type === 'pull_request.lead_approved') {
    return facts.leadSeat !== null && seatWho(raw.row.login, facts.crew, seatOf(raw.row.body)) === facts.leadSeat;
  }
  if (raw.type === 'pull_request.opened') return whoWrote(raw.row.login, facts.crew).kind === 'openadlc';
  return true;
}

/** A row read from its table, as the event the feed sends. Pure. */
export function toBoardEvent(raw: RawEvent, facts: BoardFacts): BoardEvent {
  const ref = subjectOf(raw, facts);
  if (raw.type === 'release.published') {
    const item = { ref, repo: raw.row.repoFullName, url: raw.row.url };
    const name = raw.row.tag ?? raw.row.version ?? 'a release';
    return { id: rawId(raw), type: raw.type, at: rawAt(raw), bot: null, item, text: oneLine(`${raw.row.repoFullName} ${name} published, cut by @${raw.row.cutBy}`) };
  }
  if (raw.type === 'hands_off.on' || raw.type === 'hands_off.off') {
    const repo = raw.row.repo;
    const item = { ref, repo, url: null };
    const base = { id: rawId(raw), type: raw.type, at: rawAt(raw), bot: null, item };
    if (raw.type === 'hands_off.on') {
      const how = HANDS_OFF_DURATION_WORDS[raw.row.duration ?? ''] ?? '';
      return { ...base, text: oneLine(`hands-off on for ${repo ?? 'a repository'}${how ? ` ${how}` : ''}, set by ${raw.row.setByLogin ?? raw.row.actor}`) };
    }
    return { ...base, text: oneLine(`hands-off off for ${repo ?? 'a repository'}: ${handsOffEnd(raw.row)}`) };
  }
  const resolved = itemFor(ref, facts);
  // The pull request's own page: a subject the issues do not list resolves to an issue's address.
  const item = (raw.type === 'pull_request.opened' || raw.type === 'pull_request.lead_approved') && raw.row.url ? { ...resolved, url: raw.row.url } : resolved;
  const label = labelOf(item);
  const base = { id: rawId(raw), type: raw.type, at: rawAt(raw), item };
  switch (raw.type) {
    case 'task.started':
      return { ...base, bot: raw.row.bot, text: oneLine(`${raw.row.bot ?? 'a seat'} started ${raw.row.skill ?? raw.row.kind} on ${label}`) };
    case 'question.asked':
      return { ...base, bot: raw.row.bot, text: oneLine(`${raw.row.bot ?? 'a seat'} asked: ${raw.row.question}`) };
    case 'task.capped': {
      const cap = CAP_QUESTION.exec(raw.row.question);
      const said = cap ? `stopped at the $${cap[1]} cap on ${label} after $${cap[2]}` : `stopped at its cost cap on ${label}`;
      return { ...base, bot: raw.row.bot, text: oneLine(`${raw.row.bot ?? 'a seat'} ${said}`) };
    }
    case 'merged': {
      const pr = raw.row.prNumber !== null && raw.row.prNumber !== raw.row.issueNumber ? ` (#${raw.row.prNumber})` : '';
      return { ...base, bot: raw.row.bot, text: oneLine(`${label} merged${pr} by ${raw.row.actor}`) };
    }
    case 'pull_request.held':
      return raw.source === 'merge-line'
        ? { ...base, bot: null, text: oneLine(`${label} held: ${raw.reason}`) }
        : { ...base, bot: null, text: oneLine(`${label} held by ${raw.row.actor}${raw.row.why ? `: ${raw.row.why}` : ''}`) };
    case 'pull_request.opened': {
      const bot = seatWho(raw.row.login, facts.crew, seatOfBranch(raw.row.headRef));
      return { ...base, bot, text: oneLine(`${bot ?? raw.row.login} opened #${raw.row.prNumber}: ${raw.row.title}`) };
    }
    case 'pull_request.lead_approved':
      return { ...base, bot: facts.leadSeat, text: oneLine(`${facts.leadSeat ?? 'the lead'} approved #${raw.row.prNumber}`) };
    case 'hands_off.answered':
      return { ...base, bot: null, text: oneLine(`hands-off mode answered ${raw.row.question ?? 'a question'} on ${label}: ${raw.row.answer ?? ''}`) };
  }
}

/**
 * Rows as the events they are, for the stream and the history alike: an
 * `openadlc:ignore` issue's work left out as the board leaves it out, a row
 * that is no event once the crew is known (`counts`) dropped, and each id
 * once. Pure.
 */
export function deriveEvents(raws: readonly RawEvent[], facts: BoardFacts): BoardEvent[] {
  const ignored = ignoredSubjects(facts.issues);
  const seen = new Set<string>();
  const events: BoardEvent[] = [];
  for (const raw of raws) {
    if (ignored.has(subjectOf(raw, facts)) || !counts(raw, facts)) continue;
    const id = rawId(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    events.push(toBoardEvent(raw, facts));
  }
  return events;
}

/** A live task as `GET /v1/board/tasks` answers it. Pure. */
export function liveTaskView(row: LiveTaskRow, facts: BoardFacts): LiveTask {
  return {
    id: row.id,
    bot: row.bot,
    kind: row.kind,
    item: itemFor(row.subjectRef, facts),
    state: row.state,
    since: row.since,
    costUsd: row.costUsd,
    capUsd: row.capUsd,
  };
}

/** Each held entry's reason by id: what a hold is a change of. */
function holdsOf(line: readonly LineEntry[]): Map<string, string> {
  const held = new Map<string, string>();
  for (const entry of line) {
    const reason = heldForPerson(entry);
    if (reason) held.set(entry.id, reason);
  }
  return held;
}

/** Reads every source for a window. */
async function readSources(
  sources: readonly ((store: BoardEventStore, window: EventWindow) => Promise<RawEvent[]>)[],
  store: BoardEventStore,
  window: EventWindow,
): Promise<RawEvent[][]> {
  return Promise.all(sources.map((source) => source(store, window)));
}

/**
 * One poller for the install, whoever is watching. It starts with the first
 * subscriber and stops with the last, so nothing reads the tables while
 * nobody watches.
 */
export class BoardFeed {
  private readonly subscribers = new Set<(event: BoardEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseline: Promise<void> = Promise.resolve();
  /**
   * Which start of the poller this is. A read begun before the last
   * subscriber left can still be awaiting the database when the next one
   * arrives; it must neither set that one's state nor hand it events from
   * before it subscribed, so each read checks this after every await.
   */
  private generation = 0;
  /** The baseline being taken, and for which start, so a new start never waits on, or is answered by, an old one's. */
  private establishing: { generation: number; done: Promise<void> } | null = null;
  /** Where the last probe got to, by the database's clock; null before the baseline. */
  private cursor: Date | null = null;
  /** The baseline's now: a row before it was there when the feed started, and is never sent. */
  private floor = 0;
  /** Row events already sent. Merge-line holds are not kept here: they are a diff, and a hold that clears and comes back is news again. */
  private readonly sent = new Set<string>();
  private holds = new Map<string, string>();
  private probing = false;

  constructor(
    private readonly store: BoardEventStore = liveBoardEventStore(),
    private readonly probeMs = PROBE_MS,
  ) {}

  /** Calls back with each event from now on. The returned function unsubscribes. */
  subscribe(onEvent: (event: BoardEvent) => void): () => void {
    this.subscribers.add(onEvent);
    if (!this.timer) {
      this.generation += 1;
      this.cursor = null;
      this.sent.clear();
      this.holds = new Map();
      this.timer = setInterval(() => void this.probe(), this.probeMs);
      // `unref` so the feed never holds the process open on shutdown.
      this.timer.unref?.();
      this.baseline = this.establish();
    }
    return () => this.unsubscribe(onEvent);
  }

  /** Resolves once the feed knows where now is. The route answers 200 after it, so nothing between is lost. */
  ready(): Promise<void> {
    return this.baseline;
  }

  /** Whether anyone is subscribed, and so whether the poller runs. For tests. */
  get watching(): boolean {
    return this.timer !== null;
  }

  private unsubscribe(onEvent: (event: BoardEvent) => void): void {
    this.subscribers.delete(onEvent);
    if (this.subscribers.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One read of every table. Exposed for tests, which drive it without a timer. */
  async probe(): Promise<void> {
    if (!this.timer) return;
    if (!this.cursor) return this.establish();
    if (this.probing) return;
    this.probing = true;
    try {
      await this.read(this.generation, this.cursor);
    } catch {
      // A database blip is not a reason to drop anyone's stream: the next
      // probe tries again, and the pings go on, as in `WatermarkStream`.
    } finally {
      this.probing = false;
    }
  }

  /** Where now is, by the database's clock, and which pull requests are already held: nothing before it is sent. */
  private establish(): Promise<void> {
    const generation = this.generation;
    if (this.establishing?.generation === generation) return this.establishing.done;
    const done = (async () => {
      try {
        const now = await this.store.dbNow();
        const holds = holdsOf(await this.store.mergeLine());
        if (generation !== this.generation) return;
        this.holds = holds;
        this.cursor = now;
        this.floor = now.getTime();
      } catch {
        // As a probe's: the next one takes the baseline again.
      } finally {
        if (this.establishing?.generation === generation) this.establishing = null;
      }
    })();
    this.establishing = { generation, done };
    return done;
  }

  /**
   * One read from `cursor`. Nothing is kept — the cursor, the holds, the ids
   * sent — until every fresh event has been handed over: a read that throws
   * part way leaves the last probe's state, so the next one finds the same
   * news. A hold read and then lost to a throw was otherwise gone for good,
   * since the next diff saw it unchanged.
   */
  private async read(generation: number, cursor: Date): Promise<void> {
    const from = new Date(cursor.getTime() - OVERLAP_MS);
    const [reads, line] = await Promise.all([readSources(SOURCES, this.store, { from }), this.store.mergeLine()]);
    const rows = reads.flat();
    if (generation !== this.generation) return;
    let newest = cursor.getTime();
    for (const raw of rows) newest = Math.max(newest, Date.parse(rawAt(raw)));

    // A hold is a state, not a row with a time: a new or changed reason is the event, timed now.
    const holds = holdsOf(line);
    const at = new Date().toISOString();
    const changed: RawEvent[] = [];
    for (const entry of line) {
      const reason = holds.get(entry.id);
      if (reason && this.holds.get(entry.id) !== reason) changed.push({ type: 'pull_request.held', source: 'merge-line', entry, reason, at });
    }

    const fresh = [...rows.filter((raw) => Date.parse(rawAt(raw)) >= this.floor && !this.sent.has(rawId(raw))), ...changed].sort(
      (a, b) => Date.parse(rawAt(a)) - Date.parse(rawAt(b)),
    );
    let events: BoardEvent[] = [];
    if (fresh.length > 0) {
      // Read only when there is something to say, which most probes do not have.
      const facts = await this.store.facts();
      if (generation !== this.generation) return;
      events = deriveEvents(fresh, facts);
    }

    for (const event of events) for (const subscriber of this.subscribers) subscriber(event);
    for (const raw of fresh) if (!('entry' in raw)) this.remember(rawId(raw));
    this.holds = holds;
    this.cursor = new Date(newest);
  }

  private remember(id: string): void {
    this.sent.add(id);
    // A Set iterates oldest first, so the first is the one to let go of.
    while (this.sent.size > SENT_KEPT) this.sent.delete(this.sent.values().next().value as string);
  }
}

let shared: BoardFeed | undefined;

/** The install's one feed, built when it is first asked for. */
export function sharedBoardFeed(): BoardFeed {
  shared ??= new BoardFeed();
  return shared;
}

/** Where a page of the history ends: the last event's time and id. */
export interface HistoryCursor {
  at: string;
  id: string;
}

/** A cursor as `next` and `before` carry it: `<at ISO>~<id>`. Opaque to a client. */
export function cursorText(event: Pick<BoardEvent, 'at' | 'id'>): string {
  return `${event.at}~${event.id}`;
}

/** `before` read back, or a 400 saying what to send. */
export function parseCursor(text: string | null): HistoryCursor | null {
  if (text === null || text === '') return null;
  const cut = text.indexOf('~');
  const at = cut > 0 ? text.slice(0, cut) : '';
  const id = cut > 0 ? text.slice(cut + 1) : '';
  const time = Date.parse(at);
  if (!id || Number.isNaN(time) || new Date(time).toISOString() !== at) {
    throw new HttpFailure(400, 'before must be the next value a page of the history answered, as it was sent');
  }
  return { at, id };
}

/** `limit` read, or a 400 saying what to send. */
export function parseLimit(text: string | null): number {
  if (text === null || text === '') return HISTORY_LIMIT_DEFAULT;
  const limit = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) {
    throw new HttpFailure(400, `limit must be a whole number from 1 to ${HISTORY_LIMIT_MAX}`);
  }
  return limit;
}

/** Newest first, by time and then id, as the history and every client order events. */
export function newestFirst(a: Pick<BoardEvent, 'at' | 'id'>, b: Pick<BoardEvent, 'at' | 'id'>): number {
  const byTime = Date.parse(b.at) - Date.parse(a.at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether an event is past a cursor, strictly: older, or as old and with a lower id. */
function beyond(event: BoardEvent, cursor: HistoryCursor | null): boolean {
  return !cursor || newestFirst({ at: cursor.at, id: cursor.id }, event) < 0;
}

export interface HistoryPage {
  events: BoardEvent[];
  /** The `before` for the next page; null once the page reached the floor. */
  next: string | null;
  /** The oldest time the history reaches, by the database's clock. */
  floor: string;
}

/**
 * Requests the page names that are older than the newest `facts` reads, so
 * an old request still resolves to its repository.
 */
async function withRequestsNamed(store: BoardEventStore, facts: BoardFacts, raws: readonly RawEvent[]): Promise<BoardFacts> {
  const missing = new Set<string>();
  for (const raw of raws) {
    const prefix = requestPrefixOf(subjectOf(raw, facts));
    if (prefix && !requestNamed(`request:${prefix}`, facts.requests)) missing.add(prefix);
  }
  if (missing.size === 0) return facts;
  const found = (await Promise.all([...missing].map((prefix) => store.requestByPrefix(prefix)))).filter(
    (one): one is BoardFacts['requests'][number] => one !== null && !facts.requests.some((known) => known.id === one.id),
  );
  return found.length > 0 ? { ...facts, requests: [...facts.requests, ...found] } : facts;
}

/**
 * One page of the history: the events before `before`, or before now, back
 * to thirty days by the database's clock, newest first and filtered as the
 * events they are, so a filter means what the row shows.
 *
 * Each source is read in batches with the tie rule (`EventWindow`). A source
 * that filled its batch is known only down to its oldest row's time, so a
 * batch's events are kept down to the newest such time and the next batch
 * reads from just below it: every event since the floor comes exactly once,
 * however the pages fall.
 */
export async function readHistory(
  store: BoardEventStore,
  options: { limit?: number; before?: HistoryCursor | null; repo?: string | null; bot?: string | null } = {},
): Promise<HistoryPage> {
  const limit = options.limit ?? HISTORY_LIMIT_DEFAULT;
  const cursor = options.before ?? null;
  const now = await store.dbNow();
  const floor = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const page: HistoryPage = { events: [], next: null, floor: floor.toISOString() };
  let to = cursor ? new Date(cursor.at) : now;
  if (to.getTime() < floor.getTime()) return page;

  let facts = await store.facts();
  const repoFilter = options.repo ? (facts.repos.find((one) => one.name === options.repo || one.fullName === options.repo)?.fullName ?? options.repo) : null;
  const matches = (event: BoardEvent): boolean => (!repoFilter || event.item.repo === repoFilter) && (!options.bot || event.bot === options.bot);

  const batch = Math.max(limit, HISTORY_BATCH_MIN);
  const found: BoardEvent[] = [];
  let reachedFloor = false;
  for (;;) {
    const reads = await readSources(HISTORY_SOURCES, store, { from: floor, to, limit: batch });
    let known = floor.getTime();
    let cut = false;
    for (const rows of reads) {
      if (rows.length < batch) continue;
      cut = true;
      known = Math.max(known, Math.min(...rows.map((raw) => Date.parse(rawAt(raw)))));
    }
    const raws = reads.flat().filter((raw) => Date.parse(rawAt(raw)) >= known);
    facts = await withRequestsNamed(store, facts, raws);
    found.push(...deriveEvents(raws, facts).filter((event) => beyond(event, cursor) && matches(event)));
    if (!cut) {
      reachedFloor = true;
      break;
    }
    if (found.length >= limit) break;
    to = new Date(known - 1);
    if (to.getTime() < floor.getTime()) {
      reachedFloor = true;
      break;
    }
  }

  found.sort(newestFirst);
  page.events = found.slice(0, limit);
  const last = page.events.at(-1);
  page.next = last && (!reachedFloor || found.length > limit) ? cursorText(last) : null;
  return page;
}

/**
 * `GET /v1/board/events`, the feed as server-sent events,
 * `GET /v1/board/events/history`, its last thirty days a page at a time, and
 * `GET /v1/board/tasks`, the tasks queued, running or paused. Called once from
 * `registerConsoleApi`; a test passes its own feed and store.
 */
export function registerBoardEventRoutes(router: Router, feed?: BoardFeed, store?: BoardEventStore): void {
  const storeOf = (): BoardEventStore => (store ??= liveBoardEventStore());
  const feedOf = (): BoardFeed => (feed ??= sharedBoardFeed());

  /**
   * Starts from now and replays nothing: `Last-Event-ID` is not read. A
   * client that reconnects has missed what happened while it was away, which
   * is what "watch" means; the history below is where it reads what it
   * missed.
   */
  router.get('/v1/board/events', async ({ res }) => {
    const events = feedOf();
    const stop = events.subscribe((event) => {
      res.write(`event: board\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), PING_MS);
    keepAlive.unref?.();
    const close = (): void => {
      clearInterval(keepAlive);
      stop();
    };
    res.on('close', close);
    res.on('error', close);

    await events.ready();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    return STREAMING;
  });

  /**
   * Read when a console tab opens, its bell's panel opens, its stream comes
   * back, or someone asks for more: never on a timer per tab, which the one
   * shared poller above is for.
   */
  router.get('/v1/board/events/history', async ({ query }) => {
    const limit = parseLimit(query.get('limit'));
    const before = parseCursor(query.get('before'));
    return readHistory(storeOf(), { limit, before, repo: query.get('repo') || null, bot: query.get('bot') || null });
  });

  /**
   * `/v1/tasks` is the newest fifty in any state, so a live task falls off
   * behind finished ones, and it names no seat or repository. This is the
   * live ones alone, as `openadlc ls` lists them.
   */
  router.get('/v1/board/tasks', async () => {
    const reads = storeOf();
    const [rows, facts] = await Promise.all([reads.liveTasks(), reads.facts()]);
    const ignored = ignoredSubjects(facts.issues);
    return { tasks: rows.filter((row) => !ignored.has(row.subjectRef)).map((row) => liveTaskView(row, facts)) };
  });
}
