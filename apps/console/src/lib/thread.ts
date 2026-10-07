import type { CrewMember, Gate, ModelAccountRef, TaskSummary, ThreadMessage, ThreadTopic, ThreadView } from './api';
import { botLabel, type BotFacts } from './bot-label';
import { withoutComments } from './comments';
import { taskRepo, thinksWithNothing } from './crew';
import { modelName } from './model-onboarding';
import { repoOfRef } from './repo-colors';
import { ago, duration, money } from './when';

/**
 * A bot's thread as the panel shows it: what each subject is called, what the
 * bot is doing now, where a message goes, and the conversation in sentences.
 *
 * Everything here is from live state — the bot's task, the question open on
 * it, the thread itself — and never from `bots.status`, which nothing updates
 * and which says "stopped" for every bot.
 */

// ---------------------------------------------------------------- subjects

/** The first few words of what somebody asked for: "Create html hello world and a…". */
export function firstWords(text: string, count = 6): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= count) return words.join(' ');
  return `${words.slice(0, count).join(' ')}…`;
}

/**
 * What a subject is when the bridge has not said: an older bridge sends only
 * the addresses, and the thread is not read yet when the panel first draws.
 * The bot's task knows which issue its subject is about, and a subject whose
 * number is not that issue's is the issue's pull request.
 */
function guessed(ref: string, task?: Pick<TaskSummary, 'subjectRef' | 'issue'> | null): ThreadTopic {
  const number = /#(\d+)$/.exec(ref);
  const kind = number ? 'issue' : ref.startsWith('request:') ? 'request' : 'other';
  const issue = task?.subjectRef === ref ? task.issue : null;
  if (number && issue && issue.number !== Number(number[1])) {
    return {
      ref,
      kind: 'pull_request',
      title: issue.title,
      issue: { number: issue.number, url: null },
      pullRequest: { number: Number(number[1]), url: null },
      request: null,
    };
  }
  return {
    ref,
    kind,
    title: issue?.title ?? null,
    issue: number ? { number: Number(number[1]), url: null } : null,
    pullRequest: null,
    request: null,
  };
}

/** Every subject the bot's thread is about, newest first, each once. */
export function topicsOf(thread: Pick<ThreadView, 'subjects' | 'topics'> | null | undefined): ThreadTopic[] {
  if (!thread) return [];
  const all = thread.topics ?? thread.subjects.map((ref) => guessed(ref));
  const seen = new Set<string>();
  return all.filter((topic) => {
    if (seen.has(topic.ref)) return false;
    seen.add(topic.ref);
    return true;
  });
}

export function topicFor(
  topics: readonly ThreadTopic[],
  ref: string | null | undefined,
  task?: Pick<TaskSummary, 'subjectRef' | 'issue'> | null,
): ThreadTopic | null {
  if (ref === null || ref === undefined) return null;
  return topics.find((topic) => topic.ref === ref) ?? guessed(ref, task);
}

/** A commit a deploy is about: `fleetadlc-testbed@3f2a1b0c` is commit 3f2a1b0. */
function commitOf(ref: string): string | null {
  const match = /@([0-9a-f]{7,})$/i.exec(ref);
  return match ? match[1]!.slice(0, 7) : null;
}

/** The repository a subject is in: what the bridge says, or what its address does. */
export function topicRepo(topic: Pick<ThreadTopic, 'repo' | 'ref'>): string | null {
  return topic.repo ?? repoOfRef(topic.ref);
}

/** Subjects in one repository, or in none. */
export interface TopicGroup {
  repo: string | null;
  topics: ThreadTopic[];
}

/**
 * The Show list's subjects by repository, when they are in more than one: a
 * bot works in any of them, and "#12" twice in one list is two issues. Each
 * group is where its newest subject puts it, and subjects in no repository —
 * a request nobody named one for — come last. Null when there is only one
 * repository to speak of, which the list would only repeat.
 */
export function topicGroups(topics: readonly ThreadTopic[]): TopicGroup[] | null {
  const groups = new Map<string | null, ThreadTopic[]>();
  for (const topic of topics) {
    const repo = topicRepo(topic);
    groups.set(repo, [...(groups.get(repo) ?? []), topic]);
  }
  const named = [...groups.keys()].filter((repo): repo is string => repo !== null);
  if (named.length < 2) return null;
  return [
    ...named.map((repo) => ({ repo, topics: groups.get(repo)! })),
    ...(groups.has(null) ? [{ repo: null, topics: groups.get(null)! }] : []),
  ];
}

/** What a bot's thread about no subject at all is filed under. */
export const NO_ITEM = 'Not about any item';

/** A bot's subjects that are one work item: a request, its issue, its pull request. */
export interface ItemGroup {
  /** The item's key, or null for the subjects that are about no item. */
  item: string | null;
  topics: ThreadTopic[];
}

/**
 * A bot's subjects by the work item each is part of, in the order the bot
 * last spoke about them, so the builder's issue and its pull request are one
 * group. A thread about nothing (an empty subject, written before messages
 * carried one) is "Not about any item", last, and nothing is rewritten to
 * put it anywhere else. An older bridge names no item: each subject is then
 * its own.
 */
export function groupByItem(topics: readonly ThreadTopic[]): ItemGroup[] {
  const groups = new Map<string | null, ThreadTopic[]>();
  for (const topic of topics) {
    const key = topic.item ?? (topic.ref === '' ? null : topic.ref);
    groups.set(key, [...(groups.get(key) ?? []), topic]);
  }
  const named = [...groups.keys()].filter((key): key is string => key !== null);
  return [
    ...named.map((item) => ({ item, topics: groups.get(item)! })),
    ...(groups.has(null) ? [{ item: null, topics: groups.get(null)! }] : []),
  ];
}

/**
 * A subject as the Show list names it: "#12 Record which model each review
 * used", "request: Create html hello world and a…". Never `request:a4b02784`,
 * which is an address.
 *
 * A pull request goes by its issue, the number the board shows — unless the
 * issue is one of the subjects too, as it is for the builder, which wrote the
 * change on the issue and fixed it on the pull request: then it says which.
 */
export function topicLabel(topic: ThreadTopic, among: readonly ThreadTopic[] = []): string {
  switch (topic.kind) {
    case 'issue':
      return topic.issue ? `#${topic.issue.number}${topic.title ? ` ${topic.title}` : ''}` : topic.ref;
    case 'pull_request': {
      const pr = topic.pullRequest?.number;
      const issue = topic.issue?.number;
      const twin = among.some((other) => other.kind === 'issue' && other.issue?.number === issue);
      if (issue !== undefined && !twin) return `#${issue}${topic.title ? ` ${topic.title}` : ''}`;
      return pr ? `Pull request #${pr}${topic.title ? ` · ${topic.title}` : ''}` : topic.ref;
    }
    case 'request':
      return topic.request ? `request: ${firstWords(topic.request.text)}` : 'a console request';
    default: {
      // A thread written before messages carried a subject. It is shown as it
      // is, under no item, rather than rewritten into one.
      if (topic.ref === '') return NO_ITEM;
      const commit = commitOf(topic.ref);
      return commit ? `commit ${commit}` : topic.ref;
    }
  }
}

/** A subject in the middle of a sentence: "#12", "pull request #31", "the request “Create html…”". */
export function topicInSentence(topic: ThreadTopic): string {
  switch (topic.kind) {
    case 'issue':
      return topic.issue ? `#${topic.issue.number}` : topic.ref;
    case 'pull_request':
      return topic.pullRequest ? `pull request #${topic.pullRequest.number}` : topic.ref;
    case 'request':
      return topic.request ? `the request “${firstWords(topic.request.text, 5)}”` : 'the request';
    default: {
      const commit = commitOf(topic.ref);
      return commit ? `commit ${commit}` : topic.ref || 'nothing in particular';
    }
  }
}

// ---------------------------------------------------------------- the header

/** An account as a sentence says it: "xAI subscription", "Anthropic Max", "OpenAI API key". */
export function accountWords(account: Pick<ModelAccountRef, 'label'>): string {
  return account.label.replace(/\s+[—–-]\s+/g, ' ').trim();
}

/**
 * What a bot thinks with, in words: "Newest Grok on your xAI subscription".
 * The automation bot thinks with nothing, on purpose.
 */
export function modelInWords(
  bot: Pick<CrewMember, 'engine' | 'role' | 'model'> & { modelAccountId?: string | null },
  accounts: readonly ModelAccountRef[],
): string {
  if (thinksWithNothing(bot)) return 'No model, by design';
  if (!bot.model) return 'No model chosen yet';
  const account = bot.modelAccountId ? accounts.find((one) => one.id === bot.modelAccountId) : undefined;
  return account ? `${modelName(bot.model)} on your ${accountWords(account)}` : modelName(bot.model);
}

// ---------------------------------------------------------------- what it is doing

export interface StatusLine {
  text: string;
  tone: 'signal' | 'attention' | 'muted';
  /** A task running now, which the dot says by pulsing. */
  working: boolean;
}

/** What a task is doing, with no subject: the pinned task below the line says which. */
const DOING: Record<string, string> = {
  intake: 'Shaping the issue',
  request: 'Reading the request',
  spec: 'Writing the design',
  implement: 'Writing the change',
  patch: 'Fixing what the reviewers found',
  review: 'Reviewing',
  deploy: 'Deploying',
  qa: 'Checking it on testing',
};

function doing(task: TaskSummary): string {
  // A console request's triage is intake's, on a request rather than an issue.
  if (task.kind === 'intake' && task.subjectRef.startsWith('request:')) return 'Reading the request';
  return DOING[task.kind] ?? 'Working';
}

/**
 * The status line: "Reviewing · 6 min", "Waiting for your answer", "Idle".
 * A question open in the thread counts even before the crew has been read
 * again, because it is the one thing the person has to act on.
 */
export function statusOf(
  bot: BotFacts & { task?: TaskSummary | null; engine?: string | null },
  openGate: Pick<Gate, 'id'> | null,
  now: string | null,
): StatusLine {
  if (!botLabel(bot).handle) {
    return { text: 'Cannot work until its account is connected', tone: 'muted', working: false };
  }
  const task = bot.task ?? null;
  if (task?.waitingOnYou || openGate) {
    return { text: 'Waiting for your answer', tone: 'attention', working: false };
  }
  if (task?.state === 'running') {
    const took = now ? duration(task.startedAt, now) : null;
    return { text: took ? `${doing(task)} · ${took}` : doing(task), tone: 'signal', working: true };
  }
  if (task?.state === 'queued') return { text: 'About to start', tone: 'muted', working: false };
  if (task?.state === 'paused') return { text: 'Paused', tone: 'muted', working: false };
  if (thinksWithNothing({ engine: bot.engine ?? '', role: bot.role ?? '' })) {
    return { text: 'On duty', tone: 'muted', working: false };
  }
  return { text: 'Idle', tone: 'muted', working: false };
}

/** "round 2 of 3", while a review is in its loop. */
export function roundOf(task: TaskSummary | null | undefined): string | null {
  if (!task || task.kind !== 'review' || !task.round) return null;
  return task.maxRounds ? `round ${task.round} of ${task.maxRounds}` : `round ${task.round}`;
}

const DID: Record<string, string> = {
  intake: 'Shaped',
  request: 'Read',
  spec: 'Designed',
  implement: 'Wrote the change for',
  patch: 'Fixed',
  review: 'Reviewed',
  deploy: 'Deployed',
  qa: 'Checked',
};

export interface PinnedTask {
  /** The subject, as the thread files it. */
  ref: string;
  /** Whether this is the task going now, or the last thing the bot did. */
  current: boolean;
  /** For the last task: what it did, "Reviewed", "Could not finish"; with when, "2 hours ago". */
  did: string | null;
  when: string | null;
  /** "#12", or null for a request or a commit. */
  number: string | null;
  /** The repository it is in; "#12" alone does not say which. */
  repo: string | null;
  title: string;
  links: { label: string; url: string }[];
  /** "$0.38 on this task", once it has cost anything. */
  cost: string | null;
}

/**
 * The task at the top of the thread: the one going now, or failing that the
 * last one the bot did. Its number and title are the issue's, its links go to
 * the pull request and the issue, and its cost is its own.
 */
export function pinnedTask(
  bot: Partial<Pick<CrewMember, 'task' | 'lastTask'>>,
  topics: readonly ThreadTopic[],
  now: string | null,
): PinnedTask | null {
  const current = bot.task ?? null;
  const task = current ?? bot.lastTask ?? null;
  if (!task) return null;

  const topic = topicFor(topics, task.subjectRef, task);
  const issueNumber = task.issue?.number ?? topic?.issue?.number ?? null;
  const request = topic?.kind === 'request' ? topic.request : null;
  const title =
    task.issue?.title ??
    topic?.title ??
    (request ? request.text : null) ??
    (topic ? topicLabel(topic) : task.subjectRef);

  const links: { label: string; url: string }[] = [];
  if (topic?.pullRequest?.url) links.push({ label: `Pull request #${topic.pullRequest.number}`, url: topic.pullRequest.url });
  if (topic?.issue?.url) links.push({ label: `Issue #${topic.issue.number}`, url: topic.issue.url });

  const spent = task.costUsd ?? 0;
  const did = current
    ? null
    : task.state === 'failed'
      ? 'Could not finish'
      : task.state === 'stopped'
        ? 'Stopped work on'
        : // Done, but its pull request was never opened: not finished.
          task.endedWithoutPullRequest
          ? 'No pull request for'
          : (DID[task.kind] ?? 'Finished');

  return {
    ref: task.subjectRef,
    current: Boolean(current),
    did,
    when: current || !now ? null : ago(task.endedAt ?? task.startedAt, now) || null,
    number: request ? null : issueNumber !== null ? `#${issueNumber}` : null,
    repo: taskRepo(task) ?? (topic ? topicRepo(topic) : null),
    title: request ? `Request: ${request.text}` : title,
    links,
    cost: spent > 0 ? `${money(spent)} on this task` : null,
  };
}

// ---------------------------------------------------------------- where a message goes

export interface ComposerTarget {
  /** Answer the open question; send about `subject`; or nothing to send it to. */
  mode: 'answer' | 'send' | 'none';
  subject: string | null;
  /** The line under the box, which says where the message goes before it is sent. */
  helper: string;
}

/**
 * Where a message goes, said before it is sent.
 *
 * A question open in view is answered by it. Otherwise it is about the subject
 * on screen — or, with everything on screen, the task the bot is on, else the
 * subject it talked about last — and it goes where the bridge puts a message
 * about that: a comment on the issue or pull request, or the console request's
 * own thread, which its triage reads.
 */
export function composerTarget(input: {
  openGate: Pick<Gate, 'id'> | null;
  /** The subject on screen; null for everything. */
  selected: string | null;
  /** The task the bot is on now, whose subject is the one it is about when everything is on screen. */
  task: Pick<TaskSummary, 'subjectRef' | 'issue'> | null;
  /** The last task it did, for a bot with no thread to go by. */
  lastTask?: Pick<TaskSummary, 'subjectRef' | 'issue'> | null;
  topics: readonly ThreadTopic[];
  /** The bot in a sentence: its handle, or "the lead reviewer". */
  said: string;
  /** Whether it has a GitHub account to post with. Only one that does can post on an issue. */
  connected?: boolean;
}): ComposerTarget {
  if (input.openGate) return { mode: 'answer', subject: null, helper: `Answers ${input.said}’s question` };

  const subject =
    input.selected ??
    input.task?.subjectRef ??
    input.topics.find((topic) => topic.ref !== '')?.ref ??
    input.lastTask?.subjectRef ??
    null;
  if (subject === null) {
    return { mode: 'none', subject: null, helper: `Nothing to send it about yet: ${input.said} has not worked on anything.` };
  }
  if (subject === '') {
    return { mode: 'none', subject: null, helper: 'Pick what it is about first. A message about nothing reaches no bot.' };
  }

  const topic = topicFor(input.topics, subject, input.task ?? input.lastTask)!;
  if ((topic.kind === 'issue' || topic.kind === 'pull_request') && input.connected === false) {
    // The bridge posts it with the bot's own account, and there is none yet.
    return {
      mode: 'none',
      subject,
      helper: `Nothing can be posted for ${input.said} until its GitHub account is connected.`,
    };
  }
  switch (topic.kind) {
    case 'issue':
      return { mode: 'send', subject, helper: `Posted on #${topic.issue?.number ?? '?'} as a comment` };
    case 'pull_request':
      return { mode: 'send', subject, helper: `Posted on pull request #${topic.pullRequest?.number ?? '?'} as a comment` };
    case 'request': {
      const filed = topic.request?.issueNumber ?? null;
      return {
        mode: 'send',
        subject,
        helper: filed !== null ? `Added to the request’s thread. It is filed as #${filed} now.` : 'Added to the request’s thread',
      };
    }
    default:
      return { mode: 'send', subject, helper: 'Kept in this thread; it is not posted anywhere' };
  }
}

/**
 * What the empty box says. With a question open, it is the answer in the
 * person's own words, which every question takes, choices or not.
 */
export function composerPlaceholder(mode: ComposerTarget['mode']): string {
  return mode === 'answer' ? 'Your own answer…' : 'Ask a question or give direction';
}

/**
 * Whether a question is set in bold. A question asked in its marker is one
 * line, and stands out from the context said before it; a whole message asked
 * the older way is left as it was written.
 */
export function standsOut(question: string): boolean {
  const text = question.trim();
  return text.length > 0 && !text.includes('\n');
}

// ---------------------------------------------------------------- the conversation

export type Tone = 'plain' | 'fail' | 'done';

export type TimelineEntry =
  | { kind: 'day'; key: string; label: string }
  /** A run of messages about one subject, heading the bot's whole conversation; `item` is the work item it opens. */
  | { kind: 'subject'; key: string; label: string; item?: string | null }
  | { kind: 'line'; key: string; time: string; text: string; note: string | null; tone: Tone; url: string | null }
  | {
      kind: 'bubble';
      key: string;
      time: string;
      /** The bot, or a person. */
      who: 'bot' | 'person';
      author: string;
      text: string;
      note: string | null;
      url: string | null;
      /** A question the bot asked: its options, and whether it is still waiting. */
      question?: { gateId: string | null; options: string[]; open: boolean; githubUrl: string | null };
    };

/** The markers a bot's structured comment carries are for the bridge, not for reading. */
function readable(text: string): string {
  return withoutComments(text).trim();
}

function capitalised(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

/** How a person is named in the thread. The console's own fallback is not a name. */
export function personName(author: string): string {
  const name = author.replace(/^accounts\.google\.com:/, '').split('@')[0]?.trim() ?? '';
  return !name || name === 'console' || name === 'local operator' ? 'You' : name;
}

const STARTED: Record<string, (subject: string) => string> = {
  triage: (subject) => `Started triaging ${subject}`,
  spec: (subject) => `Started the design for ${subject}`,
  implement: (subject) => `Started writing the change for ${subject}`,
  'pr-review': (subject) => `Started reviewing ${subject}`,
  deploy: (subject) => `Started deploying ${subject}`,
  qa: (subject) => `Started checking ${subject} on testing`,
  'resolve-conflict': (subject) => `Started resolving the merge conflict on ${subject}`,
};

const SKILL_NAMES: Record<string, string> = {
  triage: 'triage',
  spec: 'the design',
  implement: 'the change',
  'pr-review': 'the review',
  deploy: 'the deploy',
  qa: 'the check on testing',
  'resolve-conflict': 'the conflict resolution',
};

/** "engine claude · model claude-opus-5 · cap $15", as the bridge notes a start. */
function startNote(note: string | null): string | null {
  if (!note) return null;
  const match = /^engine (\S+) · model (\S+) · cap \$([\d.]+)$/.exec(note.trim());
  if (!match) return note;
  const [, engine, model, cap] = match as unknown as [string, string, string, string];
  if (engine === 'none' || model === 'none') return `Stops at $${cap}`;
  return `Thinking with ${modelName(model)}; stops at $${cap}`;
}

/**
 * A line the bridge wrote, as a sentence. The bridge writes them for its own
 * log — "irisexampleco started pr-review on fleetadlc-testbed#31", "ottoexampleco
 * could not finish request:a4b02784" — and the thread is the bot's own, so the
 * bot's name goes and the subject is said the way a person says it. A line
 * that says a task failed reads as a failure, with its reason under it.
 */
export function sentenceFor(
  message: Pick<ThreadMessage, 'text' | 'note' | 'payload'>,
  say: (ref: string) => string,
): { text: string; note: string | null; tone: Tone } {
  const text = readable(message.text);
  const payload = message.payload ?? {};

  // A bot's own event, recorded from its comment: the headline says what happened.
  if (typeof payload.event === 'string' && message.note) {
    if (payload.event === 'stopped') return { text: 'Stopped', note: text || null, tone: 'plain' };
    return { text: capitalised(message.note), note: null, tone: 'plain' };
  }

  let match = /^.+? started (\S+) on (\S+)$/.exec(text);
  if (match) {
    const [, skill, ref] = match as unknown as [string, string, string];
    const started = STARTED[skill]?.(say(ref)) ?? `Started ${skill} on ${say(ref)}`;
    return { text: started, note: startNote(message.note), tone: 'plain' };
  }

  match = /^.+? could not finish (\S+)$/.exec(text);
  if (match) return { text: `Could not finish ${say(match[1]!)}`, note: message.note, tone: 'fail' };

  match = /^.+? stopped work on (\S+)$/.exec(text);
  if (match) return { text: `Stopped work on ${say(match[1]!)}`, note: message.note, tone: 'plain' };

  match = /^could not (start|resume) (\S+): ([\s\S]+)$/.exec(text);
  if (match) {
    const [, verb, skill, reason] = match as unknown as [string, string, string, string];
    return { text: `Could not ${verb} ${SKILL_NAMES[skill] ?? skill}`, note: reason, tone: 'fail' };
  }

  // "pr-review waits: every host is running all it has room for".
  match = /^(\S+) waits: ([\s\S]+)$/.exec(text);
  if (match) {
    const [, skill, why] = match as unknown as [string, string, string];
    return { text: `${capitalised(SKILL_NAMES[skill] ?? skill)} waits: ${why}`, note: message.note, tone: 'plain' };
  }

  match = /^Triage of (\S+) ended without filing anything$/.exec(text);
  if (match) return { text: `Triage of ${say(match[1]!)} ended without filing anything`, note: message.note, tone: 'fail' };

  match = /^Filed as (\S+)$/.exec(text);
  if (match) {
    const number = /#(\d+)$/.exec(match[1]!)?.[1];
    return { text: number ? `Filed it as #${number}` : `Filed it as ${match[1]}`, note: message.note, tone: 'done' };
  }

  return { text: capitalised(text), note: message.note, tone: payload.state === 'failed' ? 'fail' : 'plain' };
}

const DAY_MS = 86_400_000;

/** A day as the conversation heads it: "Today", "Yesterday", "Monday", "Monday, 14 September". */
export function dayLabel(at: string, now: string, timeZone?: string): string {
  const day = (moment: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(moment));
  const then = day(at);
  const today = day(now);
  if (then === today) return 'Today';
  if (then === day(new Date(Date.parse(now) - DAY_MS).toISOString())) return 'Yesterday';
  const within = Date.parse(now) - Date.parse(at) < 6 * DAY_MS;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    ...(within ? {} : { day: 'numeric', month: 'long' }),
  }).format(new Date(at));
}

/** "10:42", on the reader's clock. */
export function timeOf(at: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

/**
 * The conversation in the order it happened: a heading for each day, the
 * bridge's lines as sentences with their times, and what the bot and people
 * said as messages. A question the bot asked carries its options, and is open
 * while it is the question the thread is waiting on.
 */
export function timeline(
  messages: readonly ThreadMessage[],
  input: {
    now: string;
    openGate: Gate | null;
    topics: readonly ThreadTopic[];
    /** What the bot is called now, which heads everything it said. */
    botName: string;
    /** Head each run of messages with its subject: everything is on screen, not one subject. */
    showSubjects: boolean;
    timeZone?: string;
  },
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const say = (ref: string) => {
    const topic = topicFor(input.topics, ref);
    return topic ? topicInSentence(topic) : ref;
  };
  // From the person's answers alone: the question carries its own id, and
  // counting it said "asked you" of every question closed by anything.
  const answered = new Set(
    messages
      .filter((message) => message.kind === 'you')
      .map((message) => message.payload?.gateId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  let lastDay: string | null = null;
  let lastSubject: string | undefined;
  let openShown = false;

  for (const message of messages) {
    const day = dayLabel(message.at, input.now, input.timeZone);
    if (day !== lastDay) {
      entries.push({ kind: 'day', key: `day-${message.id}`, label: day });
      lastDay = day;
      lastSubject = undefined;
    }
    if (input.showSubjects && message.subjectRef !== undefined && message.subjectRef !== lastSubject) {
      const topic = topicFor(input.topics, message.subjectRef);
      entries.push({
        kind: 'subject',
        key: `subject-${message.id}`,
        label: topic ? topicLabel(topic, input.topics) : message.subjectRef,
        item: topic?.item ?? null,
      });
      lastSubject = message.subjectRef;
    }

    const time = timeOf(message.at, input.timeZone);

    if (message.kind === 'sys' || message.kind === 'procs') {
      const sentence = sentenceFor(message, say);
      entries.push({ kind: 'line', key: message.id, time, ...sentence, url: message.githubUrl });
      continue;
    }

    if (message.kind === 'you') {
      entries.push({
        kind: 'bubble',
        key: message.id,
        time,
        who: 'person',
        author: personName(message.author),
        text: readable(message.text),
        note: message.payload?.gateId ? 'answered' : message.note,
        url: message.githubUrl,
      });
      continue;
    }

    if (message.kind === 'gate') {
      const gateId = typeof message.payload?.gateId === 'string' ? message.payload.gateId : null;
      const open = Boolean(input.openGate && gateId === input.openGate.id);
      if (open) openShown = true;
      const options = Array.isArray(message.payload?.options) ? (message.payload.options as unknown[]).map(String) : [];
      entries.push({
        kind: 'bubble',
        key: message.id,
        time,
        who: 'bot',
        author: input.botName,
        text: readable(message.text),
        note: open ? 'waiting for your answer' : gateId && answered.has(gateId) ? 'asked you' : 'asked',
        url: message.githubUrl,
        question: {
          gateId,
          options: open ? (input.openGate?.options ?? options) : options,
          open,
          githubUrl: open ? (input.openGate?.githubCommentUrl ?? message.githubUrl) : message.githubUrl,
        },
      });
      continue;
    }

    entries.push({
      kind: 'bubble',
      key: message.id,
      time,
      who: 'bot',
      author: input.botName,
      text: readable(message.text),
      note: message.note,
      url: message.githubUrl,
    });
  }

  // A question the thread is waiting on whose own line is not here — asked
  // before the thread recorded one — is still the one thing to answer.
  if (input.openGate && !openShown) {
    entries.push({
      kind: 'bubble',
      key: `gate-${input.openGate.id}`,
      time: '',
      who: 'bot',
      author: input.botName,
      text: input.openGate.question,
      note: 'waiting for your answer',
      url: null,
      question: { gateId: input.openGate.id, options: input.openGate.options, open: true, githubUrl: input.openGate.githubCommentUrl },
    });
  }

  return entries;
}
