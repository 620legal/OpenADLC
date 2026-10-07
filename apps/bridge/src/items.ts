import { attachments as attachmentStore, designMemory as designMemoryStore, bots as botStore, issues as issueStore, repos as repoStore, requests as requestStore, tasks as taskStore, threads as threadStore } from '@fleetadlc/db';
import { BOT_ROLES, hasNextLabel, hasPausedLabel, roleLabel, type BotRole, type Gate, type Message, type StageKey, type TaskKind, type TaskState } from '@fleetadlc/shared';
import { requestPrefixOf } from './request-context.js';
import { readHolds } from './item-hold.js';
import { isActive, issueForSubject, parseRef, subjectsOf, type IssueFacts } from './work.js';

/**
 * A work item: one request, the issue it became, and that issue's pull
 * request, read as one conversation.
 *
 * The database already kept a thread per bot and subject, but the console
 * opened a card as the bot's panel with every subject the bot had ever worked
 * on in it, so a person answering intake about one request read the questions
 * of three others beside it, and a reviewer's remarks about a pull request
 * were under the reviewer, not under the work. An item is what a person means
 * by "this piece of work": everything said about any of its subjects, by
 * whichever seat said it, labelled by role.
 *
 * Identity: `<repo>#<issue>` once the issue exists; `request:<id8>` before it
 * does; otherwise the subject itself (a deploy of a commit, `api@3f2c1a9`, or
 * the testing environment, stands alone). These are plain functions over rows,
 * as `work.ts` is, and `readItem` is the one read.
 */

/** A request's subject, as its triage runs on it. */
export function requestSubject(id: string): string {
  return `request:${id.slice(0, 8).toLowerCase()}`;
}

type IssueRow = Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'title' | 'stage' | 'url'> & { repoId: string };

interface RequestRow {
  id: string;
  text: string;
  context?: string | null;
  repoId: string | null;
  issueNumber: number | null;
  state: string;
  requestedBy?: string;
  createdAt?: string;
}

interface RepoRow {
  id: string;
  name: string;
  fullName: string;
}

export interface Item<I extends IssueRow = IssueRow, R extends RequestRow = RequestRow> {
  /** The canonical subject every member resolves to. */
  key: string;
  /** Every subject the item's work is filed under: the request's, the issue's, the pull request's. */
  subjects: string[];
  /** The request it started as, the newest when several were filed as one issue. */
  request: R | null;
  /** Every request filed as it, oldest first. */
  requests: R[];
  issue: I | null;
  /** The pull request's number, once there is one. */
  pr: number | null;
  /** The repository it is in, by name, or null for a request nobody named one for. */
  repo: string | null;
  /** Each member's subject, for routing a message to the one a role works on. */
  refs: { request: string | null; issue: string | null; pullRequest: string | null };
}

/**
 * The item a subject belongs to. Any member resolves to the same item: the
 * request, the issue, or its pull request. A request prefix two requests
 * share names no item, rather than guessing which one was meant, and so does
 * a request this install has never seen.
 */
export function itemOf<I extends IssueRow, R extends RequestRow>(
  subject: string,
  facts: { issues: readonly I[]; requests: readonly R[]; repos: readonly RepoRow[] },
): Item<I, R> | null {
  const trimmed = subject.trim();
  const prefix = requestPrefixOf(trimmed);
  if (prefix) {
    const matches = facts.requests.filter((request) => request.id.toLowerCase().startsWith(prefix));
    if (matches.length !== 1) return null;
    const request = matches[0]!;
    const repo = facts.repos.find((one) => one.id === request.repoId);
    if (request.issueNumber !== null && repo) return itemOf(`${repo.name}#${request.issueNumber}`, facts);
    const ref = requestSubject(request.id);
    return {
      key: ref,
      subjects: [ref],
      request,
      requests: [request],
      issue: null,
      pr: null,
      repo: repo?.name ?? null,
      refs: { request: ref, issue: null, pullRequest: null },
    };
  }

  const parsed = parseRef(trimmed);
  if (parsed) {
    const issue = issueForSubject(trimmed, facts.issues);
    const repoName = issue?.repoName ?? parsed.repo;
    const number = issue?.number ?? parsed.number;
    const repo = facts.repos.find((one) => one.name === repoName);
    // The join the board makes (`board-work.ts`): a request belongs to the
    // issue it was filed as, by repository and number.
    const filed = repo
      ? facts.requests.filter((request) => request.repoId === repo.id && request.issueNumber === number)
      : [];
    const issueRef = `${repoName}#${number}`;
    const prRef = issue?.prNumber ? `${repoName}#${issue.prNumber}` : null;
    const requestRefs = filed.map((request) => requestSubject(request.id));
    return {
      key: issueRef,
      subjects: [...new Set([...requestRefs, ...(issue ? subjectsOf(issue) : [issueRef])])],
      request: filed.at(-1) ?? null,
      requests: [...filed],
      issue: issue ?? null,
      pr: issue?.prNumber ?? null,
      repo: repoName,
      refs: { request: requestRefs.at(-1) ?? null, issue: issueRef, pullRequest: prRef },
    };
  }

  if (!trimmed) return null;
  return {
    key: trimmed,
    subjects: [trimmed],
    request: null,
    requests: [],
    issue: null,
    pr: null,
    repo: /^([^@#:\s]+)[@#]\S+$/.exec(trimmed)?.[1] ?? null,
    refs: { request: null, issue: null, pullRequest: null },
  };
}

/** A bot as an item reads it. */
export interface ItemBot {
  id: string;
  name: string;
  slot: string;
  role: BotRole;
  githubLogin: string | null;
}

/** A thread as an item reads it: whose, about which subject, in which role. */
export interface ItemThread {
  id: string;
  bot_id: string;
  subject_ref: string;
  role?: string | null;
  seat?: string | null;
}

/** A task as an item reads it. */
export interface ItemTaskRow {
  id: string;
  botId: string;
  kind: TaskKind;
  subjectRef: string;
  state: TaskState;
  round: number;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
  tmuxSession: string | null;
  branch: string | null;
  costUsd: number;
  createdAt: string;
}

export interface ItemSeat {
  bot: string;
  slot: string;
  githubLogin: string | null;
  /** Whether other seats post as the same GitHub account: then the role, not the handle, says who spoke. */
  sharedAccount: boolean;
}

export interface ItemRole {
  role: string;
  label: string;
  seats: ItemSeat[];
}

export type ItemMessage = Message & { subjectRef: string; role: string | null; seat: string | null; bot: string | null };
export type ItemGate = Gate & { subjectRef: string | null; role: string | null; bot: string | null; seat: string | null };

export interface ItemTask {
  id: string;
  bot: string;
  seat: string | null;
  role: string | null;
  kind: TaskKind;
  state: TaskState;
  round: number;
  subjectRef: string;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
  /** The session a person watches or takes over: the task's own, not the bot's newest. */
  tmuxSession: string | null;
  branch: string | null;
  costUsd: number;
}

export interface ItemView {
  key: string;
  subjects: string[];
  title: string;
  repo: string | null;
  stage: StageKey | null;
  costUsd: number;
  request: {
    id: string;
    subject: string;
    text: string;
    context: string | null;
    requestedBy: string | null;
    state: string;
    createdAt: string | null;
  } | null;
  issue: { number: number; title: string; url: string | null; stage: StageKey } | null;
  pullRequest: { number: number; url: string | null } | null;
  roles: ItemRole[];
  timeline: ItemMessage[];
  openGates: ItemGate[];
  tasks: ItemTask[];
  attachments: unknown[];
  /** What the design on this item proposed the repository remember, and whether it was accepted. */
  designMemory: unknown[];
  /** Who holds it from the board, and why (`item-hold.ts`); null when nobody does. Absent before it was read. */
  held?: { by: string; at: string; why: string | null } | null;
  /** Whether it is the one its repository builds next (`fleetadlc:next`). */
  next?: boolean;
  /**
   * Where a message written on it would go, by tab: `''` for the
   * conversation, and each of `roles` by its role (`messageRoutes`).
   */
  routes?: Record<string, ItemRoutePreview>;
}

export interface ItemRows {
  item: Item;
  repo: RepoRow | null;
  bots: readonly ItemBot[];
  threads: readonly ItemThread[];
  messages: readonly Message[];
  /** Open gates anywhere; only the item's are kept. */
  gates: readonly Gate[];
  tasks: readonly ItemTaskRow[];
  attachments?: readonly unknown[];
  designMemory?: readonly unknown[];
}

const ROLE_ORDER: readonly string[] = BOT_ROLES;

function labelOf(role: string): string {
  return (BOT_ROLES as readonly string[]).includes(role) ? roleLabel(role as BotRole) : role.replace(/_/g, ' ');
}

function firstLine(text: string): string {
  const line = text.split('\n').map((one) => one.trim()).find(Boolean) ?? 'A request';
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}

function pullUrl(repo: RepoRow | null, issueUrl: string | null, number: number): string | null {
  const fromIssue = issueUrl?.replace(/\/issues\/\d+$/, `/pull/${number}`);
  if (fromIssue && fromIssue !== issueUrl) return fromIssue;
  return repo ? `https://github.com/${repo.fullName}/pull/${number}` : null;
}

/**
 * The item as the console shows it: the whole conversation in order, each
 * entry labelled by the role and seat that said it, the questions still open
 * on any of its subjects, and every task that worked on it.
 *
 * A role comes from the thread (0028), which kept it when the thread was
 * opened, and from the bot only for a thread written before that: seats on one
 * account are one handle, and the role is how a person tells them apart.
 */
export function itemView(rows: ItemRows): ItemView {
  const { item } = rows;
  const botById = new Map(rows.bots.map((bot) => [bot.id, bot]));
  const threads = rows.threads.filter((thread) => item.subjects.includes(thread.subject_ref));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const tasks = rows.tasks.filter((task) => item.subjects.includes(task.subjectRef));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const roleOfThread = (thread: ItemThread): string | null => thread.role ?? botById.get(thread.bot_id)?.role ?? null;
  const seatOfThread = (thread: ItemThread): string | null => thread.seat ?? botById.get(thread.bot_id)?.slot ?? null;

  const sharers = new Map<string, number>();
  for (const bot of rows.bots) {
    if (bot.githubLogin) sharers.set(bot.githubLogin.toLowerCase(), (sharers.get(bot.githubLogin.toLowerCase()) ?? 0) + 1);
  }
  const roles = new Map<string, Map<string, ItemSeat>>();
  const addSeat = (role: string | null, botId: string, slot: string | null): void => {
    const bot = botById.get(botId);
    if (!role || !bot) return;
    const seats = roles.get(role) ?? new Map<string, ItemSeat>();
    const seat = slot ?? bot.slot;
    if (!seats.has(seat)) {
      seats.set(seat, {
        bot: bot.name,
        slot: seat,
        githubLogin: bot.githubLogin,
        sharedAccount: Boolean(bot.githubLogin && (sharers.get(bot.githubLogin.toLowerCase()) ?? 0) > 1),
      });
    }
    roles.set(role, seats);
  };
  for (const thread of threads) addSeat(roleOfThread(thread), thread.bot_id, seatOfThread(thread));
  for (const task of tasks) addSeat(botById.get(task.botId)?.role ?? null, task.botId, null);

  const timeline: ItemMessage[] = rows.messages
    .filter((message) => threadById.has(message.threadId))
    .map((message) => {
      const thread = threadById.get(message.threadId)!;
      return {
        ...message,
        subjectRef: thread.subject_ref,
        role: roleOfThread(thread),
        seat: seatOfThread(thread),
        bot: botById.get(thread.bot_id)?.name ?? null,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));

  const openGates: ItemGate[] = rows.gates
    .filter((gate) => gate.state === 'open')
    .flatMap((gate) => {
      const thread = gate.threadId ? threadById.get(gate.threadId) : undefined;
      const task = gate.taskId ? taskById.get(gate.taskId) : undefined;
      if (!thread && !task) return [];
      const botId = thread?.bot_id ?? task?.botId ?? '';
      return [
        {
          ...gate,
          subjectRef: task?.subjectRef ?? thread?.subject_ref ?? null,
          role: thread ? roleOfThread(thread) : (botById.get(botId)?.role ?? null),
          seat: thread ? seatOfThread(thread) : (botById.get(botId)?.slot ?? null),
          bot: botById.get(botId)?.name ?? null,
        },
      ];
    });

  const itemTasks: ItemTask[] = [...tasks]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((task) => {
      const bot = botById.get(task.botId);
      return {
        id: task.id,
        bot: bot?.name ?? 'a bot',
        seat: bot?.slot ?? null,
        role: bot?.role ?? null,
        kind: task.kind,
        state: task.state,
        round: task.round,
        subjectRef: task.subjectRef,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        exitReason: task.exitReason,
        tmuxSession: task.tmuxSession,
        branch: task.branch,
        costUsd: Math.round(task.costUsd * 10_000) / 10_000,
      };
    });

  const request = item.request;
  const issue = item.issue;
  return {
    key: item.key,
    subjects: item.subjects,
    title: issue?.title ?? (request ? firstLine(request.text) : item.key),
    repo: item.repo,
    stage: issue?.stage ?? (request ? 'intake' : null),
    costUsd: Math.round(tasks.reduce((total, task) => total + task.costUsd, 0) * 10_000) / 10_000,
    request: request
      ? {
          id: request.id,
          subject: requestSubject(request.id),
          text: request.text,
          context: request.context ?? null,
          requestedBy: request.requestedBy ?? null,
          state: request.state,
          createdAt: request.createdAt ?? null,
        }
      : null,
    issue: issue
      ? {
          number: issue.number,
          title: issue.title,
          url: issue.url ?? (rows.repo ? `https://github.com/${rows.repo.fullName}/issues/${issue.number}` : null),
          stage: issue.stage,
        }
      : item.refs.issue && rows.repo
        ? (() => {
            const number = parseRef(item.refs.issue)!.number;
            return { number, title: request ? firstLine(request.text) : item.key, url: `https://github.com/${rows.repo.fullName}/issues/${number}`, stage: 'intake' as StageKey };
          })()
        : null,
    pullRequest: item.pr ? { number: item.pr, url: pullUrl(rows.repo, issue?.url ?? null, item.pr) } : null,
    roles: [...roles.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([role, seats]) => ({ role, label: labelOf(role), seats: [...seats.values()] })),
    timeline,
    openGates,
    tasks: itemTasks,
    attachments: [...(rows.attachments ?? [])],
    designMemory: [...(rows.designMemory ?? [])],
  };
}

function rank(role: string): number {
  const at = ROLE_ORDER.indexOf(role);
  return at === -1 ? ROLE_ORDER.length : at;
}

/** Roles that work on the pull request rather than the issue. */
const ON_THE_PULL_REQUEST = new Set(['review_lead', 'review_second', 'review_security']);

/** Who works a stage, for an item nobody has spoken on yet. */
const STAGE_ROLE: Partial<Record<StageKey, BotRole>> = {
  intake: 'intake',
  spec: 'spec',
  build: 'implement',
  review: 'review_lead',
  merged: 'deploy',
};

/** Where a person's message on an item goes. */
export type ItemRoute =
  | { kind: 'gate'; gate: ItemGate }
  | { kind: 'post'; bot: string; botId: string; role: string; subject: string }
  | { kind: 'refused'; status: number; error: string };

/**
 * Where a message would go, as the item's box says it before it is sent:
 * the seat, by role and the GitHub account it posts as, and the place —
 * the issue or the pull request on GitHub, the request's thread, or a
 * thread kept in OpenADLC alone for a subject GitHub has no page for (a
 * deploy of a commit, `api@3f2c1a9`). Or why it would be refused.
 */
export type ItemRoutePreview =
  | {
      kind: 'post';
      bot: string;
      role: string;
      handle: string | null;
      subject: string;
      on: 'issue' | 'pull_request' | 'request' | 'fleetadlc';
      number: number | null;
    }
  | { kind: 'refused'; error: string };

/**
 * Where a message written on an item goes, decided from the view the person
 * was looking at.
 *
 * - With `gateId`: that question, which must be open on one of the item's
 *   subjects. A question on another item is refused, never answered here: the
 *   person was looking at this one.
 * - Otherwise, the one question open on the item (or the role's, with
 *   `role`) is answered. Two or more is refused: guessing which of two
 *   questions a reply answers resumed the wrong task.
 * - Otherwise it is posted to the role's seat that last spoke on the item,
 *   else the seat whose task is on it, else the seat that staffs its stage;
 *   about the pull request for a reviewer, the issue for anyone else, and
 *   the request before the issue exists.
 */
export function routeItemMessage(
  view: Pick<ItemView, 'openGates' | 'timeline' | 'tasks' | 'stage'>,
  item: Pick<Item, 'key' | 'refs' | 'subjects'>,
  bots: readonly ItemBot[],
  input: { gateId?: string | null; role?: string | null; gate?: ItemGate | null },
): ItemRoute {
  const role = input.role?.trim() || null;
  if (input.gateId) {
    const gate = view.openGates.find((one) => one.id === input.gateId) ?? input.gate ?? null;
    if (!gate || !gate.subjectRef || !item.subjects.includes(gate.subjectRef)) {
      return { kind: 'refused', status: 409, error: 'that question is not about this work item, or it was answered already; open the item it is on and answer it there' };
    }
    if (gate.state !== 'open') return { kind: 'refused', status: 409, error: 'that question was answered already' };
    return { kind: 'gate', gate };
  }

  const open = view.openGates.filter((gate) => !role || gate.role === role);
  if (open.length === 1) return { kind: 'gate', gate: open[0]! };
  if (open.length > 1) {
    return { kind: 'refused', status: 409, error: "pick the question you're answering: more than one is open on this item" };
  }

  const byName = new Map(bots.map((bot) => [bot.name, bot]));
  const spoke = [...view.timeline]
    .reverse()
    .find((message) => (message.kind === 'bot' || message.kind === 'gate') && message.bot && (!role || message.role === role));
  const working = view.tasks.find((task) => isActive(task) && (!role || task.role === role));
  const staffing = role ?? (view.stage ? STAGE_ROLE[view.stage] : undefined) ?? null;
  const bot =
    (spoke?.bot ? byName.get(spoke.bot) : undefined) ??
    (working ? byName.get(working.bot) : undefined) ??
    (staffing ? bots.find((one) => one.role === staffing) : undefined);
  if (!bot) {
    return {
      kind: 'refused',
      status: 409,
      error: role
        ? `no ${labelOf(role)} is in the crew to send it to; add one in Settings → Crew`
        : 'nobody has worked on this item yet, so there is no one to send it to; pick a role to write to',
    };
  }

  const actingRole = role ?? bot.role;
  const subject =
    (ON_THE_PULL_REQUEST.has(actingRole) ? item.refs.pullRequest : null) ?? item.refs.issue ?? item.refs.request ?? item.key;
  return { kind: 'post', bot: bot.name, botId: bot.id, role: actingRole, subject };
}

/**
 * Where a message written on each of the item's tabs would go, by the same
 * `routeItemMessage` the send takes, so the line above the box and the send
 * cannot disagree. The console said "to whoever is working on it, on the
 * issue" while the bridge posted on the pull request as the lead reviewer.
 *
 * Open questions are left out: the console answers the one open, or asks
 * which, from `openGates` itself, and says so in its own words.
 */
export function messageRoutes(
  view: Pick<ItemView, 'openGates' | 'timeline' | 'tasks' | 'stage' | 'roles'>,
  item: Pick<Item, 'key' | 'refs' | 'subjects'>,
  bots: readonly ItemBot[],
): Record<string, ItemRoutePreview> {
  const quiet = { ...view, openGates: [] };
  const routes: Record<string, ItemRoutePreview> = {};
  for (const role of ['', ...view.roles.map((one) => one.role)]) {
    const route = routeItemMessage(quiet, item, bots, { role: role || null });
    if (route.kind === 'refused') {
      routes[role] = { kind: 'refused', error: route.error };
    } else if (route.kind === 'post') {
      const onGitHub = parseRef(route.subject);
      routes[role] = {
        kind: 'post',
        bot: route.bot,
        role: route.role,
        handle: bots.find((one) => one.id === route.botId)?.githubLogin ?? null,
        subject: route.subject,
        on: onGitHub
          ? route.subject === item.refs.pullRequest
            ? 'pull_request'
            : 'issue'
          : route.subject.startsWith('request:')
            ? 'request'
            : 'fleetadlc',
        number: onGitHub?.number ?? null,
      };
    }
  }
  return routes;
}

/**
 * Resolves a subject to its item from the database: the request by its
 * prefix, the issue by its repository and number (or the pull request's),
 * and every request filed as that issue. Null when it names nothing this
 * install knows, or a request prefix two requests share.
 */
export async function resolveItem(subject: string): Promise<{ item: Item; repo: RepoRow | null } | null> {
  const trimmed = subject.trim();
  const repoList = await repoStore.listRepos({ includeRemoved: true });
  let requestRows: requestStore.RequestRecord[] = [];
  let ref = trimmed;

  const prefix = requestPrefixOf(trimmed);
  if (prefix) {
    const request = await requestStore.findRequestByPrefix(prefix).catch(() => null);
    if (!request) return null;
    requestRows = [request];
    const repo = repoList.find((one) => one.id === request.repoId);
    if (request.issueNumber !== null && repo) ref = `${repo.name}#${request.issueNumber}`;
  }

  const parsed = parseRef(ref);
  let issueRows: issueStore.IssueRecord[] = [];
  if (parsed) {
    issueRows = (await issueStore.listIssues(parsed.repo)).filter(
      (issue) => issue.number === parsed.number || issue.prNumber === parsed.number,
    );
    const repo = repoList.find((one) => one.name === parsed.repo);
    const number = issueForSubject(ref, issueRows)?.number ?? parsed.number;
    if (repo) {
      const filed = await requestStore.listRequestsForIssue(repo.id, number);
      const seen = new Set(filed.map((one) => one.id));
      requestRows = [...filed, ...requestRows.filter((one) => !seen.has(one.id))];
    }
  }

  const item = itemOf(ref, { issues: issueRows, requests: requestRows, repos: repoList });
  if (!item) return null;
  return { item, repo: repoList.find((one) => one.name === item.repo) ?? null };
}

/** Reads an item's view, or null when the subject names no item. */
export async function readItem(subject: string): Promise<{ item: Item; view: ItemView; repo: RepoRow | null } | null> {
  const resolved = await resolveItem(subject);
  if (!resolved) return null;
  const { item, repo } = resolved;
  const [crew, threadRows, gates, taskRows, files] = await Promise.all([
    botStore.listBots(),
    threadStore.listThreadsForSubjects(item.subjects),
    threadStore.listOpenGates(),
    taskStore.listTasksOnSubjects(item.subjects),
    // A database a release behind has no table yet; the item is still read.
    attachmentStore.listForSubjects(item.subjects).catch(() => []),
  ]);
  const memory = await (async () => designMemoryStore.listForSubjects(item.subjects))().catch(() => []);
  const messages = await threadStore.listMessages(
    threadRows.map((thread) => thread.id),
    500,
  );
  const view = itemView({ item, repo, bots: crew, threads: threadRows, messages, gates, tasks: taskRows, attachments: files, designMemory: memory });
  // The hold and the place in line, as its card says them.
  const labels = (item.issue as { labels?: string[] } | null)?.labels ?? [];
  const holdKey = item.issue && item.repo ? `${item.repo}#${item.issue.number}` : null;
  const holds = holdKey && hasPausedLabel(labels) ? await readHolds() : {};
  view.held = holdKey && hasPausedLabel(labels) ? (holds[holdKey] ?? { by: 'a person on GitHub', at: '', why: null }) : null;
  view.next = hasNextLabel(labels);
  view.routes = messageRoutes(view, item, crew);
  return { item, view, repo };
}
