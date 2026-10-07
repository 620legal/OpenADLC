import type { CrewMember, ModelAccountRef, SeatHealth, SeatOutcome, SeatQueue, SeatResult, TaskSummary } from './api';
import { botLabel, type BotFacts } from './bot-label';
import { modelName } from './model-onboarding';
import { repoOfRef } from './repo-colors';
import { ago, duration, money } from './when';

/**
 * The crew as the header, the board's columns and the crew page show it: who
 * is working, who is waiting on the person, what each is doing and what it
 * thinks with — from live state, never from `bots.status`, which nothing
 * updates and which says "stopped" for every bot.
 */

/** The roles in the order a request meets them. */
export const PIPELINE: readonly string[] = [
  'intake',
  'spec',
  'implement',
  'review_lead',
  'review_second',
  'review_security',
  'deploy',
  'qa',
  'automation',
];

/** The most tasks a seat may run at once; the bridge refuses more. */
export const MAX_TASKS_AT_ONCE = 16;

/** How many tasks a seat runs at once; one for a bot from a bridge that does not say. */
export function tasksAtOnce(bot: Pick<CrewMember, 'maxTasks'>): number {
  const value = bot.maxTasks ?? 1;
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_TASKS_AT_ONCE) : 1;
}

/**
 * Whether the seat thinks on an OpenAI or xAI subscription, whose CLI keeps
 * one login and refreshes it as it works. Several tasks at once on one login
 * may refresh it at the same moment, which nothing has shown to be safe, so
 * the console says to keep such a seat at one.
 */
export function sharesARefreshingLogin(bot: Pick<CrewMember, 'modelAccountId'>, accounts: readonly ModelAccountRef[]): boolean {
  const account = accounts.find((one) => one.id === bot.modelAccountId);
  return account?.kind === 'subscription' && (account.provider === 'openai' || account.provider === 'xai');
}

/** The crew in pipeline order; two bots in one role keep the order the bridge gave them. */
export function inPipelineOrder<T extends { role: string }>(crew: readonly T[]): T[] {
  const rank = (role: string): number => {
    const at = PIPELINE.indexOf(role);
    return at === -1 ? PIPELINE.length : at;
  };
  return crew
    .map((bot, index) => ({ bot, index }))
    .sort((a, b) => rank(a.bot.role) - rank(b.bot.role) || a.index - b.index)
    .map(({ bot }) => bot);
}

/**
 * The crew by role, in the order a request meets them, each role once with
 * its seats. Seats sharing one GitHub account are told apart here by role,
 * which is how the work is split, and not by the handle they all post as.
 */
export function byRole<T extends { role: string }>(crew: readonly T[]): { role: string; seats: T[] }[] {
  const sections: { role: string; seats: T[] }[] = [];
  for (const bot of inPipelineOrder(crew)) {
    const section = sections.find((one) => one.role === bot.role);
    if (section) section.seats.push(bot);
    else sections.push({ role: bot.role, seats: [bot] });
  }
  return sections;
}

/**
 * How many other seats post as the same GitHub account as this one: the crew
 * account intake, design, build and ship share, the reviewer account the
 * three reviewers share. Zero for a seat with an account of its own, or none.
 */
export function sharesAccountWith(bot: Pick<CrewMember, 'name' | 'githubLogin'>, crew: readonly Pick<CrewMember, 'name' | 'githubLogin'>[]): number {
  const login = bot.githubLogin?.toLowerCase();
  if (!login) return 0;
  return crew.filter((other) => other.name !== bot.name && other.githubLogin?.toLowerCase() === login).length;
}

/**
 * The work item a task is part of, as the board opens it: the issue when the
 * task knows it, else its own subject (a request, a deploy of a commit), which
 * the bridge resolves to the same item. Null for a task about nothing.
 */
export function taskItem(task: Pick<TaskSummary, 'subjectRef' | 'issue'> | null | undefined): string | null {
  if (!task) return null;
  if (task.issue) return `${task.issue.repo}#${task.issue.number}`;
  return task.subjectRef || null;
}

/**
 * The two accounts a crew needs at the least, as the bridge has them
 * (`ACCOUNT_GROUPS` in @fleetadlc/shared): the reviewers approve what the crew
 * account opens, and GitHub won't let an account approve its own pull request.
 */
export type AccountGroup = 'crew' | 'reviewers';

export const ACCOUNT_GROUP_TEXT: Record<AccountGroup, { label: string; blurb: string }> = {
  crew: { label: 'Crew account', blurb: 'Intake, design, build, QA, ship and automation post and push as this account.' },
  reviewers: {
    label: 'Reviewer account',
    blurb:
      'The three reviewers approve as this account. GitHub won’t let the account that opened a pull request approve it, so it has to be a different one.',
  },
};

export function accountGroupOf(role: string): AccountGroup {
  return role === 'review_lead' || role === 'review_second' || role === 'review_security' ? 'reviewers' : 'crew';
}

/** The crew by the account each group signs in as, the crew account first, pipeline order within. */
export function byAccountGroup<T extends { role: string }>(crew: readonly T[]): { group: AccountGroup; seats: T[] }[] {
  const ordered = inPipelineOrder(crew);
  return (['crew', 'reviewers'] as const)
    .map((group) => ({ group, seats: ordered.filter((bot) => accountGroupOf(bot.role) === group) }))
    .filter((entry) => entry.seats.length > 0);
}

export type CrewState = 'working' | 'waiting' | 'attention' | 'idle' | 'on-duty' | 'not-connected';

/**
 * Whether a bot needs the person before it can do its next piece of work: its
 * last task failed, or a health check says something about it is wrong — its
 * sign-in, its signing key, the account it thinks with. The header used to say
 * "9 ready" while two of those bots' reviews had just failed.
 */
export function needsAttention(bot: Pick<CrewMember, 'lastTask' | 'checks'>): boolean {
  if ((bot.checks ?? []).some((check) => check.severity === 'blocking')) return true;
  return bot.lastTask?.state === 'failed';
}

/** A bot with no model does its work through the bridge, not in a session: labels, statuses, the gate. */
export function thinksWithNothing(bot: Pick<CrewMember, 'engine' | 'role'>): boolean {
  return bot.engine === 'none' || bot.role === 'automation';
}

export function crewState(bot: CrewMember): CrewState {
  if (!botLabel(bot).handle) return 'not-connected';
  if (bot.task?.waitingOnYou) return 'waiting';
  if (bot.task?.state === 'running' || bot.sessions.some((session) => session.state === 'working')) return 'working';
  if (needsAttention(bot)) return 'attention';
  if (thinksWithNothing(bot)) return 'on-duty';
  return 'idle';
}

export interface CrewCounts {
  total: number;
  working: number;
  /** Connected, nothing running, and nothing wrong with it. */
  ready: number;
  connected: number;
  /** Connected, and its last task failed or a check about it fails. */
  attention: number;
  /**
   * Connected, but its GitHub sign-in no longer works: revoked or expired, or
   * the sign-in check fails. Counted among `connected`, since it has an
   * account, yet it cannot act until it connects again.
   */
  needsReconnecting: number;
}

/** Whether a bot's GitHub sign-in has stopped working, as its authorization or the sign-in check says. */
export function signInLost(bot: Pick<CrewMember, 'authorization' | 'checks'>): boolean {
  if (bot.authorization === 'expired' || bot.authorization === 'revoked') return true;
  return (bot.checks ?? []).some((check) => check.id === 'bot-sign-in');
}

export function crewCounts(crew: readonly CrewMember[]): CrewCounts {
  const states = crew.map(crewState);
  return {
    total: crew.length,
    working: states.filter((state) => state === 'working').length,
    ready: states.filter((state) => state !== 'working' && state !== 'not-connected' && state !== 'attention').length,
    connected: states.filter((state) => state !== 'not-connected').length,
    attention: states.filter((state) => state === 'attention').length,
    needsReconnecting: crew.filter((bot, index) => states[index] !== 'not-connected' && signInLost(bot)).length,
  };
}

/**
 * The header's line about the crew: "3 working · 6 idle" while anything is
 * working, "9 ready" when nothing is, "7 of 9 ready" when some of the crew
 * cannot act at all yet — and "· 2 need attention" after any of those for
 * bots whose last task failed or that a check says are broken, which are not
 * counted as ready or idle.
 */
export function crewLine(counts: CrewCounts): string {
  if (counts.total === 0) return 'No crew yet';
  const attention = counts.attention ?? 0;
  const tail = attention > 0 ? ` · ${attention} ${attention === 1 ? 'needs' : 'need'} attention` : '';
  if (counts.working > 0) return `${counts.working} working · ${counts.total - counts.working - attention} idle${tail}`;
  if (counts.connected < counts.total) return `${counts.ready} of ${counts.total} ready${tail}`;
  return `${counts.ready} ready${tail}`;
}

/** "3 need you", "1 needs you", "Nothing needs you". */
export function needsYouLine(count: number): string {
  if (count <= 0) return 'Nothing needs you';
  return count === 1 ? '1 needs you' : `${count} need you`;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

/** "Nine bots", for a sentence's start. */
export function countWords(count: number, noun: string): string {
  const number = WORDS[count] ?? String(count);
  return `${number} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Two letters for a bot's avatar, from its handle: `ottoexampleco` is AB,
 * `fleetadlc-atlas` is FA, and a handle of three parts or more takes its last two,
 * so `fleetadlc-atlas-janedoe` is AJ rather than the FA it would share. A bot with
 * no account yet takes its role's: the lead reviewer is LR.
 */
export function initials(bot: BotFacts): string {
  const label = botLabel(bot);
  const source = label.handle ?? label.role ?? label.name;
  const words = source
    .split(/[-_\s.]+/)
    .map((word) => word.replace(/[^a-z0-9]/gi, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const letters = words[0]!.replace(/[^a-z]/gi, '') || words[0]!;
    return letters.slice(0, 2).toUpperCase();
  }
  const pair = words.length >= 3 ? words.slice(-2) : words.slice(0, 2);
  return pair.map((word) => word[0]).join('').toUpperCase();
}

/** The role in words, capitalised as a line of its own: "Lead reviewer", "SRE", "QA". */
export function roleTitle(bot: BotFacts): string {
  const role = botLabel(bot).role;
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
}

/** "Newest Opus · Anthropic — Max"; the automation bot thinks with nothing, on purpose. */
export function thinksWith(bot: CrewMember, accounts: readonly ModelAccountRef[]): string {
  if (thinksWithNothing(bot)) return 'No model, by design';
  const model = bot.model ? modelName(bot.model) : 'No model chosen yet';
  const account = bot.modelAccountId ? accounts.find((one) => one.id === bot.modelAccountId) : undefined;
  return account ? `${model} · ${account.label}` : model;
}

const DOING: Record<string, string> = {
  intake: 'Shaping',
  request: 'Reading',
  spec: 'Designing',
  implement: 'Writing',
  patch: 'Fixing',
  review: 'Reviewing',
  deploy: 'Deploying',
  qa: 'Checking',
};

const DID: Record<string, string> = {
  intake: 'Shaped',
  request: 'Read',
  spec: 'Designed',
  implement: 'Wrote',
  patch: 'Fixed',
  review: 'Reviewed',
  deploy: 'Deployed',
  qa: 'Checked',
};

/** What a task is about, as a person refers to it: "#16", or "a request". */
function about(task: TaskSummary): string {
  if (task.issue) return `#${task.issue.number}`;
  if (task.subjectRef.startsWith('request:')) return 'a request';
  const commit = /@([0-9a-f]{7,})$/.exec(task.subjectRef);
  if (commit) return `commit ${commit[1]!.slice(0, 7)}`;
  return task.subjectRef;
}

/**
 * The crew page's "Now": what the bot is doing, from its task. "Writing #16 ·
 * 12 min", "Reviewing #12 · round 2", "Asked you about #15", or what it last
 * did when nothing is running: "Reviewed #12 2 hours ago".
 */
export function nowLine(bot: CrewMember, now: string): string {
  if (thinksWithNothing(bot)) return 'Labels issues and sets the review gate';
  if (!botLabel(bot).handle) return 'Cannot work until its account is connected';

  const task = bot.task;
  if (task) {
    const what = about(task);
    if (task.waitingOnYou) return `Asked you about ${what}`;
    if (task.state === 'paused') return `Paused on ${what}`;
    if (task.state === 'queued') return `About to start on ${what}`;
    const verb = DOING[task.kind] ?? 'Working on';
    const doing = task.kind === 'qa' ? `Checking ${what} on testing` : `${verb} ${what}`;
    if (task.kind === 'review' && task.round) return `${doing} · round ${task.round}`;
    const took = duration(task.startedAt, now);
    return took ? `${doing} · ${took}` : doing;
  }

  const last = bot.lastTask;
  if (last) {
    const what = about(last);
    const when = ago(last.endedAt ?? last.startedAt, now);
    const tail = when ? ` ${when}` : '';
    if (last.state === 'failed') return `Could not finish ${what}${tail}`;
    if (last.state === 'stopped') return `Stopped work on ${what}${tail}`;
    return `${DID[last.kind] ?? 'Finished'} ${what}${tail}`;
  }
  return 'Nothing yet';
}

/**
 * The repository a task is in: what the bridge says, or failing that what its
 * subject says. Null for a request no repository was named for.
 */
export function taskRepo(task: Pick<TaskSummary, 'repo' | 'issue' | 'subjectRef'> | null | undefined): string | null {
  if (!task) return null;
  return task.repo ?? task.issue?.repo ?? repoOfRef(task.subjectRef);
}

/**
 * The repository "Now" is about: the task it names, the one going or else the
 * last, and none for a bot whose line names no task.
 */
export function nowRepo(bot: CrewMember): string | null {
  if (thinksWithNothing(bot) || !botLabel(bot).handle) return null;
  return taskRepo(bot.task ?? bot.lastTask);
}

/** "This month": what the ledger attributes to the bot, or "Free" for one with no model. */
export function monthLine(bot: CrewMember, byBot: readonly { bot: string; costUsd: number }[]): string {
  if (thinksWithNothing(bot)) return 'Free';
  const spent = byBot.find((row) => row.bot === bot.name)?.costUsd ?? 0;
  return money(spent);
}

/** How the crew page lays the crew out: a grid of cards to glance at, or a table to compare and change. */
export type CrewLayout = 'cards' | 'table';

/** Where each person's choice of layout is kept, in their own browser. */
export const CREW_LAYOUT_KEY = 'fleetadlc.crew.layout';

/** The layout this browser last chose, or cards. Storage can throw in a private window; then it is cards. */
export function storedCrewLayout(): CrewLayout {
  try {
    return globalThis.localStorage?.getItem(CREW_LAYOUT_KEY) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

export function storeCrewLayout(layout: CrewLayout): void {
  try {
    globalThis.localStorage?.setItem(CREW_LAYOUT_KEY, layout);
  } catch {
    // Kept for this visit only.
  }
}

/** Where an account that cannot sign in is connected again. */
export const RECONNECT_GITHUB = '/onboarding?step=github-accounts';

/**
 * Whether a seat can work, as one dot: what the bridge says, or — from a
 * bridge that does not say — what its checks and its account say. A seat with
 * no account cannot work at all, and that is the first thing to fix.
 */
export function seatHealth(bot: CrewMember): SeatHealth {
  if (bot.health) return bot.health;
  if (!botLabel(bot).handle && !thinksWithNothing(bot)) {
    return { state: 'failing', reasons: [{ title: 'Its GitHub account is not connected', action: { label: 'Reconnect account', href: RECONNECT_GITHUB } }] };
  }
  const checks = bot.checks ?? [];
  if (checks.length === 0) return { state: 'ok', reasons: [] };
  return {
    state: checks.some((check) => check.severity === 'blocking') ? 'failing' : 'warning',
    // Each check's fix is on its card on the board, where it has its button.
    reasons: checks.map((check) => ({ title: check.title, action: { label: 'See the fix', href: '/?board=1#needs' } })),
  };
}

/** "#12" for an issue, "a request" for one, the ref as it is otherwise. */
function refWords(ref: string): string {
  const issue = /#(\d+)$/.exec(ref);
  if (issue) return `#${issue[1]}`;
  if (ref.startsWith('request:')) return 'a request';
  return ref;
}

/** "1 running · 2 queued · next: #12 Retry the webhook", or null from a bridge that does not say. */
export function queueLine(queue: SeatQueue | undefined): string | null {
  if (!queue) return null;
  const parts = [
    queue.running > 0 ? `${queue.running} running` : null,
    queue.waiting > 0 ? `${queue.waiting} waiting for you` : null,
    queue.queued > 0 ? `${queue.queued} queued` : null,
  ].filter((part): part is string => Boolean(part));
  if (queue.next) parts.push(`next: ${queue.next.title ? `${refWords(queue.next.ref)} ${queue.next.title}` : refWords(queue.next.ref)}`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing on';
}

/** How each outcome is marked: done ticked, sent back, failed, stopped. */
export const OUTCOME: Record<SeatOutcome, { mark: string; words: string; tone: string }> = {
  done: { mark: '✓', words: 'done', tone: 'text-signal' },
  sent_back: { mark: '↩', words: 'sent back', tone: 'text-attention' },
  failed: { mark: '✕', words: 'failed', tone: 'text-alarm' },
  stopped: { mark: '■', words: 'stopped', tone: 'text-dim' },
};

/**
 * What it finished lately, newest first: the bridge's list, or — from a
 * bridge that does not keep one — its last task alone.
 */
export function recentResults(bot: CrewMember, count = 3): SeatResult[] {
  if (bot.recent) return bot.recent.slice(0, count);
  const last = bot.lastTask;
  if (!last || last.state === 'running' || last.state === 'queued' || last.state === 'paused') return [];
  const outcome: SeatOutcome = last.state === 'failed' ? 'failed' : last.state === 'stopped' ? 'stopped' : 'done';
  // Named by its issue: a review's subject is its pull request, and "#31" beside the issue it links to said the wrong number.
  const ref = last.issue ? `${last.issue.repo}#${last.issue.number}` : last.subjectRef;
  return [{ ref, title: last.issue?.title ?? null, kind: last.kind, outcome, at: last.endedAt ?? last.startedAt ?? '', item: taskItem(last) }];
}

/** A result as a line: "#12 Rate-limit the webhook route", or what it was about. */
export function resultWords(result: Pick<SeatResult, 'ref' | 'title'>): string {
  const what = refWords(result.ref);
  return result.title ? `${what} ${result.title}` : what;
}

/** "Paused by janedoe 5 min ago: changing its model". */
export function pausedLine(pause: NonNullable<CrewMember['seatPaused']>, now: string): string {
  const when = ago(pause.at, now);
  return `Paused by ${pause.by}${when ? ` ${when}` : ''}${pause.why ? `: ${pause.why}` : ''}`;
}
