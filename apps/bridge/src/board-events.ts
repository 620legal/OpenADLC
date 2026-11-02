import { createHash } from 'node:crypto';
import {
  boardEvents,
  issues,
  mergeLines,
  repos,
  requests,
  type AskedRow,
  type HeldAuditRow,
  type LiveTaskRow,
  type MergedRow,
  type StartedRow,
} from '@openadlc/db';
import { heldForPerson } from './merge-line.js';
import { requestPrefixOf } from './request-context.js';
import { STREAMING, type Router } from './router.js';
import { describeSubject } from './thread-view.js';
import { ignoredSubjects, parseRef, type IssueFacts } from './work.js';

/**
 * What the crew is doing, as it happens: the feed behind `GET /v1/board/events`,
 * which `openadlc watch` prints.
 *
 * Each event is read from the table it already happens in — a task's
 * `started_at`, a gate's `created_at`, a stage move into Merged, the merge
 * line's holds and the `pull.held` audit row — by one poller for the install.
 * Nothing is emitted by the writers: tasks start in the dispatcher and the
 * task service, gates open from several routes, and merges land through the
 * merge line or through a person on GitHub, and a writer that forgets to emit
 * is a feed that quietly stops covering it (`thread-stream.ts` says the same).
 * docs/adr/0021-board-events-are-read-from-the-tables-they-happen-in.md.
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

/**
 * One board event, the contract `openadlc watch --json` prints unchanged.
 * `type` is open: a client ignores one it does not know, so types can be
 * added without breaking it.
 */
export interface BoardEvent {
  id: string;
  type: string;
  at: string;
  /** The seat that did it; null when none did (a merge-line hold, a merge by a person or by OpenADLC). */
  bot: string | null;
  item: BoardItem;
  /** One line, at most 200 characters. */
  text: string;
}

export interface BoardItem {
  /** The subject as the bridge writes it: `OpenADLC#227`, `request:<id8>`. */
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

/** What subjects are resolved against: the issues, repositories and requests. */
export interface BoardFacts {
  issues: (Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'title' | 'url' | 'labels'> & { repoId: string })[];
  repos: { id: string; name: string; fullName: string }[];
  requests: { id: string; text: string; repoId: string | null; issueNumber: number | null; state: string }[];
}

export interface BoardEventStore {
  dbNow(): Promise<Date>;
  startedSince(since: Date): Promise<StartedRow[]>;
  askedSince(since: Date): Promise<AskedRow[]>;
  mergedSince(since: Date): Promise<MergedRow[]>;
  heldAuditSince(since: Date): Promise<HeldAuditRow[]>;
  liveTasks(): Promise<LiveTaskRow[]>;
  mergeLine(): Promise<LineEntry[]>;
  facts(): Promise<BoardFacts>;
}

/**
 * The store as the bridge reads it. Each read is looked up when it is called,
 * not when this is built: `roles.test.ts` and the route tests register every
 * route against a mock of `@openadlc/db` that has no `boardEvents`.
 */
export function liveBoardEventStore(): BoardEventStore {
  return {
    dbNow: () => boardEvents.dbNow(),
    startedSince: (since) => boardEvents.startedSince(since),
    askedSince: (since) => boardEvents.askedSince(since),
    mergedSince: (since) => boardEvents.mergedSince(since),
    heldAuditSince: (since) => boardEvents.heldAuditSince(since),
    liveTasks: () => boardEvents.liveTasks(),
    mergeLine: () => mergeLines.line(),
    facts: async () => {
      const [issueList, repoList, requestList] = await Promise.all([
        issues.listIssues(),
        // A task's repository may since have been removed: it still names it.
        repos.listRepos({ includeRemoved: true }),
        requests.listRequests(200),
      ]);
      return { issues: issueList, repos: repoList, requests: requestList.map((one) => ({ ...one, issueNumber: one.issueNumber ?? null })) };
    },
  };
}

/** A row read from one of the tables, before its subject is resolved. */
export type RawEvent =
  | { type: 'task.started'; row: StartedRow }
  | { type: 'question.asked'; row: AskedRow }
  | { type: 'merged'; row: MergedRow }
  | { type: 'pull_request.held'; source: 'audit'; row: HeldAuditRow }
  | { type: 'pull_request.held'; source: 'merge-line'; entry: LineEntry; reason: string; at: string };

/** The id an event is sent under and deduplicated by: `<type>:<row key>`. */
export function rawId(raw: RawEvent): string {
  switch (raw.type) {
    case 'task.started':
      return `task.started:${raw.row.taskId}`;
    case 'question.asked':
      return `question.asked:${raw.row.gateId}`;
    case 'merged':
      return `merged:${raw.row.moveId}`;
    case 'pull_request.held':
      return raw.source === 'audit'
        ? `pull_request.held:audit:${raw.row.auditId}`
        : `pull_request.held:merge-line:${raw.entry.id}:${createHash('sha256').update(raw.reason).digest('hex').slice(0, 8)}`;
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
  }
}

/** A subject as an event or a live task carries it: the ref, the repository's full name, and a link. */
export function itemFor(ref: string, facts: BoardFacts): BoardItem {
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

/** One line of at most 200 characters: a question may be paragraphs. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= TEXT_MAX ? flat : `${flat.slice(0, TEXT_MAX - 1)}…`;
}

/** A row read from its table, as the event the feed sends. Pure. */
export function toBoardEvent(raw: RawEvent, facts: BoardFacts): BoardEvent {
  const item = itemFor(subjectOf(raw, facts), facts);
  const label = labelOf(item);
  const base = { id: rawId(raw), type: raw.type, at: rawAt(raw), item };
  switch (raw.type) {
    case 'task.started':
      return { ...base, bot: raw.row.bot, text: oneLine(`${raw.row.bot ?? 'a seat'} started ${raw.row.skill ?? raw.row.kind} on ${label}`) };
    case 'question.asked':
      return { ...base, bot: raw.row.bot, text: oneLine(`${raw.row.bot ?? 'a seat'} asked: ${raw.row.question}`) };
    case 'merged': {
      const pr = raw.row.prNumber !== null && raw.row.prNumber !== raw.row.issueNumber ? ` (#${raw.row.prNumber})` : '';
      return { ...base, bot: raw.row.bot, text: oneLine(`${label} merged${pr} by ${raw.row.actor}`) };
    }
    case 'pull_request.held':
      return raw.source === 'merge-line'
        ? { ...base, bot: null, text: oneLine(`${label} held: ${raw.reason}`) }
        : { ...base, bot: null, text: oneLine(`${label} held by ${raw.row.actor}${raw.row.why ? `: ${raw.row.why}` : ''}`) };
  }
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

/**
 * One poller for the install, whoever is watching. It starts with the first
 * subscriber and stops with the last, so nothing reads the tables while
 * nobody watches.
 */
export class BoardFeed {
  private readonly subscribers = new Set<(event: BoardEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseline: Promise<void> = Promise.resolve();
  /** Where the last probe got to, by the database's clock; null before the baseline. */
  private cursor: Date | null = null;
  /** The baseline's now: a row before it was there when the feed started, and is never sent. */
  private floor = 0;
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
      this.cursor = null;
      this.sent.clear();
      this.holds = new Map();
      this.timer = setInterval(() => void this.probe(), this.probeMs);
      // `unref` so the feed never holds the process open on shutdown.
      this.timer.unref?.();
      this.baseline = this.probe();
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
    if (this.probing || !this.timer) return;
    this.probing = true;
    try {
      await this.read();
    } catch {
      // A database blip is not a reason to drop anyone's stream: the next
      // probe tries again, and the pings go on, as in `WatermarkStream`.
    } finally {
      this.probing = false;
    }
  }

  private async read(): Promise<void> {
    if (!this.cursor) {
      const now = await this.store.dbNow();
      this.holds = holdsOf(await this.store.mergeLine());
      this.cursor = now;
      this.floor = now.getTime();
      return;
    }

    const from = new Date(this.cursor.getTime() - OVERLAP_MS);
    const [started, asked, merged, heldAudit, line] = await Promise.all([
      this.store.startedSince(from),
      this.store.askedSince(from),
      this.store.mergedSince(from),
      this.store.heldAuditSince(from),
      this.store.mergeLine(),
    ]);
    const rows: RawEvent[] = [
      ...started.map((row) => ({ type: 'task.started' as const, row })),
      ...asked.map((row) => ({ type: 'question.asked' as const, row })),
      ...merged.map((row) => ({ type: 'merged' as const, row })),
      ...heldAudit.map((row) => ({ type: 'pull_request.held' as const, source: 'audit' as const, row })),
    ];
    let newest = this.cursor.getTime();
    for (const raw of rows) newest = Math.max(newest, Date.parse(rawAt(raw)));

    // A hold is a state, not a row with a time: a new or changed reason is the event, timed now.
    const holds = holdsOf(line);
    const at = new Date().toISOString();
    const changed: RawEvent[] = [];
    for (const entry of line) {
      const reason = holds.get(entry.id);
      if (reason && this.holds.get(entry.id) !== reason) changed.push({ type: 'pull_request.held', source: 'merge-line', entry, reason, at });
    }
    this.holds = holds;
    this.cursor = new Date(newest);

    const fresh = [...rows.filter((raw) => Date.parse(rawAt(raw)) >= this.floor), ...changed]
      .filter((raw) => !this.sent.has(rawId(raw)))
      .sort((a, b) => Date.parse(rawAt(a)) - Date.parse(rawAt(b)));
    if (fresh.length === 0) return;

    // Read only when there is something to say, which most probes do not have.
    const facts = await this.store.facts();
    const ignored = ignoredSubjects(facts.issues);
    for (const raw of fresh) {
      this.remember(rawId(raw));
      // An `openadlc:ignore` issue's work is a person's, left out as the board leaves it out.
      if (ignored.has(subjectOf(raw, facts))) continue;
      const event = toBoardEvent(raw, facts);
      for (const subscriber of this.subscribers) subscriber(event);
    }
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

/**
 * `GET /v1/board/events`, the feed as server-sent events, and
 * `GET /v1/board/tasks`, the tasks queued, running or paused. Called once from
 * `registerConsoleApi`; a test passes its own feed and store.
 */
export function registerBoardEventRoutes(router: Router, feed?: BoardFeed, store?: BoardEventStore): void {
  const storeOf = (): BoardEventStore => (store ??= liveBoardEventStore());
  const feedOf = (): BoardFeed => (feed ??= sharedBoardFeed());

  /**
   * Starts from now and replays nothing: `Last-Event-ID` is not read. A
   * client that reconnects has missed what happened while it was away, which
   * is what "watch" means; the board is where history is.
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
