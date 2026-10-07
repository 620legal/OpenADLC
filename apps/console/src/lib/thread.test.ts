import { describe, expect, it } from 'vitest';
import type { Gate, TaskSummary, ThreadMessage, ThreadTopic } from './api';
import {
  composerPlaceholder,
  composerTarget,
  dayLabel,
  groupByItem,
  modelInWords,
  pinnedTask,
  roundOf,
  topicGroups,
  sentenceFor,
  standsOut,
  statusOf,
  timeline,
  topicLabel,
  topicsOf,
} from './thread';

const NOW = '2026-09-24T10:53:00.000Z';
const minutesAgo = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const PULL: ThreadTopic = {
  ref: 'fleetadlc-testbed#31',
  kind: 'pull_request',
  title: 'Record which model each review used',
  issue: { number: 12, url: 'https://github.com/janedoe/fleetadlc-testbed/issues/12' },
  pullRequest: { number: 31, url: 'https://github.com/janedoe/fleetadlc-testbed/pull/31' },
  request: null,
};
const ISSUE: ThreadTopic = {
  ref: 'fleetadlc-testbed#15',
  kind: 'issue',
  title: 'Show what a task has cost on its card',
  issue: { number: 15, url: 'https://github.com/janedoe/fleetadlc-testbed/issues/15' },
  pullRequest: null,
  request: null,
};
const REQUEST: ThreadTopic = {
  ref: 'request:a4b02784',
  kind: 'request',
  title: null,
  issue: null,
  pullRequest: null,
  request: { text: 'Create html hello world and a readme file.', issueNumber: null, state: 'questions' },
};

const REVIEWING: TaskSummary = {
  kind: 'review',
  state: 'running',
  subjectRef: 'fleetadlc-testbed#31',
  issue: { repo: 'fleetadlc-testbed', number: 12, title: 'Record which model each review used' },
  startedAt: minutesAgo(6),
  endedAt: null,
  round: 2,
  maxRounds: 3,
  waitingOnYou: false,
  approval: false,
  costUsd: 0.38,
};

const REVIEWER = {
  name: 'irisexampleco',
  slot: 'second-reviewer',
  role: 'review_second',
  authorization: 'active',
  githubLogin: 'irisexampleco',
  engine: 'grok',
  // The column nothing updates. Nothing here may say it.
  status: 'stopped',
};

describe('a thread’s subjects', () => {
  it('are named by what they are about, never by their address', () => {
    expect(topicLabel(ISSUE)).toBe('#15 Show what a task has cost on its card');
    // A pull request by its issue, as the board numbers it — but beside the issue itself, as the one it is.
    expect(topicLabel(PULL)).toBe('#12 Record which model each review used');
    expect(topicLabel(PULL, [PULL, { ...ISSUE, ref: 'fleetadlc-testbed#12', issue: { number: 12, url: null } }])).toBe(
      'Pull request #31 · Record which model each review used',
    );
    expect(topicLabel(REQUEST)).toBe('request: Create html hello world and a…');
    expect(topicLabel({ ...REQUEST, ref: 'fleetadlc-testbed@3f2a1b0c9d', kind: 'other', request: null })).toBe('commit 3f2a1b0');
  });

  it('are still named from an older bridge that sends only the addresses', () => {
    expect(topicsOf({ subjects: ['fleetadlc-testbed#15', 'fleetadlc-testbed#15', 'request:a4b02784'] }).map((topic) => topicLabel(topic))).toEqual([
      '#15',
      'a console request',
    ]);
  });
});

describe('what a bot thinks with, in the thread’s heading', () => {
  const accounts = [{ id: 'xai', provider: 'xai', kind: 'subscription', label: 'xAI — subscription' }];

  it('names the model and the account in words', () => {
    expect(modelInWords({ engine: 'grok', role: 'review_second', model: 'newest:grok', modelAccountId: 'xai' }, accounts)).toBe(
      'Newest Grok on your xAI subscription',
    );
    expect(modelInWords({ engine: 'grok', role: 'review_second', model: 'grok-4.7', modelAccountId: null }, accounts)).toBe('Grok 4.7');
  });

  it('says the automation bot thinks with nothing, on purpose', () => {
    expect(modelInWords({ engine: 'none', role: 'automation', model: 'none' }, accounts)).toBe('No model, by design');
  });
});

describe('the status line', () => {
  it('is what the bot’s task is doing now, whatever the status column says', () => {
    expect(statusOf({ ...REVIEWER, task: REVIEWING }, null, NOW)).toEqual({ text: 'Reviewing · 6 min', tone: 'signal', working: true });
    expect(roundOf(REVIEWING)).toBe('round 2 of 3');
  });

  it('says a question or an OK is waiting on the person', () => {
    const asking = { ...REVIEWING, state: 'paused', waitingOnYou: true };
    expect(statusOf({ ...REVIEWER, task: asking }, null, NOW).text).toBe('Waiting for your answer');
    expect(statusOf({ ...REVIEWER, task: { ...asking, approval: true } }, null, NOW).text).toBe('Waiting for your answer');
    // A question in the thread counts before the crew is read again.
    expect(statusOf({ ...REVIEWER, task: null }, { id: 'gate-1' }, NOW).tone).toBe('attention');
  });

  it('is Idle with nothing going, and says a bot with no account cannot work', () => {
    expect(statusOf({ ...REVIEWER, task: null }, null, NOW).text).toBe('Idle');
    expect(
      statusOf({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', authorization: 'unauthorized' }, null, NOW).text,
    ).toBe('Cannot work until its account is connected');
  });
});

describe('the task pinned at the top', () => {
  it('is the issue the task is about, with its links and what the task has cost', () => {
    expect(pinnedTask({ task: REVIEWING }, [PULL], NOW)).toEqual({
      ref: 'fleetadlc-testbed#31',
      current: true,
      did: null,
      when: null,
      number: '#12',
      repo: 'fleetadlc-testbed',
      title: 'Record which model each review used',
      links: [
        { label: 'Pull request #31', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/31' },
        { label: 'Issue #12', url: 'https://github.com/janedoe/fleetadlc-testbed/issues/12' },
      ],
      cost: '$0.38 on this task',
    });
  });

  it('is what a console request asked for, when that is what the task is about', () => {
    const triage: TaskSummary = { ...REVIEWING, kind: 'intake', subjectRef: 'request:a4b02784', issue: null, round: null, maxRounds: null, costUsd: 0 };
    expect(pinnedTask({ task: triage }, [REQUEST], NOW)).toMatchObject({
      number: null,
      title: 'Request: Create html hello world and a readme file.',
      cost: null,
    });
  });

  it('is the last thing the bot did, when nothing is going', () => {
    const done = { ...REVIEWING, state: 'done', startedAt: minutesAgo(130), endedAt: minutesAgo(120) };
    expect(pinnedTask({ task: null, lastTask: done }, [PULL], NOW)).toMatchObject({ current: false, did: 'Reviewed', when: '2 hours ago' });
    expect(pinnedTask({ task: null, lastTask: { ...done, state: 'failed' } }, [PULL], NOW)?.did).toBe('Could not finish');
    // A build that ended without opening its pull request is not finished.
    expect(pinnedTask({ task: null, lastTask: { ...done, kind: 'implement', endedWithoutPullRequest: true } }, [PULL], NOW)?.did).toBe('No pull request for');
    expect(pinnedTask({ task: null, lastTask: null }, [], NOW)).toBeNull();
  });
});

describe('where a message goes', () => {
  const said = 'irisexampleco';

  it('answers the question the thread is waiting on', () => {
    expect(composerTarget({ openGate: { id: 'gate-1' }, selected: 'fleetadlc-testbed#31', task: REVIEWING, topics: [PULL], said })).toEqual({
      mode: 'answer',
      subject: null,
      helper: 'Answers irisexampleco’s question',
    });
  });

  it('is posted on the issue or pull request it is about', () => {
    expect(composerTarget({ openGate: null, selected: 'fleetadlc-testbed#15', task: null, topics: [ISSUE], said })).toEqual({
      mode: 'send',
      subject: 'fleetadlc-testbed#15',
      helper: 'Posted on #15 as a comment',
    });
    expect(composerTarget({ openGate: null, selected: 'fleetadlc-testbed#31', task: REVIEWING, topics: [PULL], said }).helper).toBe(
      'Posted on pull request #31 as a comment',
    );
  });

  it('goes to a console request’s own thread, which its triage reads', () => {
    expect(composerTarget({ openGate: null, selected: 'request:a4b02784', task: null, topics: [REQUEST], said })).toEqual({
      mode: 'send',
      subject: 'request:a4b02784',
      helper: 'Added to the request’s thread',
    });
    const filed = { ...REQUEST, request: { ...REQUEST.request!, issueNumber: 16, state: 'filed' } };
    expect(composerTarget({ openGate: null, selected: 'request:a4b02784', task: null, topics: [filed], said }).helper).toBe(
      'Added to the request’s thread. It is filed as #16 now.',
    );
  });

  it('with everything on screen, is about the task the bot is on, and says so before the thread is read', () => {
    // No topics yet: the task says its subject is the pull request of #12.
    expect(composerTarget({ openGate: null, selected: null, task: REVIEWING, topics: [], said })).toEqual({
      mode: 'send',
      subject: 'fleetadlc-testbed#31',
      helper: 'Posted on pull request #31 as a comment',
    });
    // No task: the subject it talked about last.
    expect(composerTarget({ openGate: null, selected: null, task: null, topics: [ISSUE, PULL], said }).subject).toBe('fleetadlc-testbed#15');
  });

  it('with no thread to go by, is about the last thing the bot did', () => {
    const done = { ...REVIEWING, state: 'done' };
    expect(composerTarget({ openGate: null, selected: null, task: null, lastTask: done, topics: [], said }).subject).toBe('fleetadlc-testbed#31');
  });

  it('is not promised to GitHub for a bot with no account to post it with', () => {
    expect(
      composerTarget({ openGate: null, selected: 'fleetadlc-testbed#31', task: null, topics: [PULL], said: 'the lead reviewer', connected: false }),
    ).toEqual({
      mode: 'none',
      subject: 'fleetadlc-testbed#31',
      helper: 'Nothing can be posted for the lead reviewer until its GitHub account is connected.',
    });
    // A console request's thread needs no account.
    expect(
      composerTarget({ openGate: null, selected: 'request:a4b02784', task: null, topics: [REQUEST], said: 'the intake bot', connected: false }).mode,
    ).toBe('send');
  });

  it('is nowhere, and says so, when there is nothing it could be about', () => {
    expect(composerTarget({ openGate: null, selected: null, task: null, topics: [], said }).mode).toBe('none');
    expect(composerTarget({ openGate: null, selected: '', task: null, topics: [], said }).mode).toBe('none');
  });
});

describe('the bridge’s lines, as sentences', () => {
  const say = (ref: string) =>
    ({ 'request:a4b02784': 'the request “Create html hello world and…”', 'fleetadlc-testbed#31': 'pull request #31' })[ref] ?? ref;

  it('reads a task that could not finish as a failure, with its reason', () => {
    expect(
      sentenceFor(
        { text: 'ottoexampleco could not finish request:a4b02784', note: 'engine claude is not installed on this host', payload: { state: 'failed' } },
        say,
      ),
    ).toEqual({
      text: 'Could not finish the request “Create html hello world and…”',
      note: 'engine claude is not installed on this host',
      tone: 'fail',
    });
    expect(sentenceFor({ text: 'could not start triage: hostd is not answering', note: null, payload: null }, say)).toEqual({
      text: 'Could not start triage',
      note: 'hostd is not answering',
      tone: 'fail',
    });
  });

  it('says a start in words, without the bot’s own name or the engine’s', () => {
    expect(
      sentenceFor({ text: 'irisexampleco started pr-review on fleetadlc-testbed#31', note: 'engine grok · model grok-4.7 · cap $15', payload: null }, say),
    ).toEqual({ text: 'Started reviewing pull request #31', note: 'Thinking with Grok 4.7; stops at $15', tone: 'plain' });
  });

  it('says a merge conflict round, and a skill waiting for room, in words rather than slugs', () => {
    expect(sentenceFor({ text: 'irisexampleco started resolve-conflict on fleetadlc-testbed#31', note: null, payload: null }, say).text).toBe(
      'Started resolving the merge conflict on pull request #31',
    );
    expect(sentenceFor({ text: 'could not start resolve-conflict: the bot is busy', note: null, payload: null }, say).text).toBe(
      'Could not start the conflict resolution',
    );
    expect(sentenceFor({ text: 'pr-review waits: every host is running all it has room for', note: null, payload: null }, say)).toEqual({
      text: 'The review waits: every host is running all it has room for',
      note: null,
      tone: 'plain',
    });
  });

  it('says what a filed request became', () => {
    expect(sentenceFor({ text: 'Filed as fleetadlc-testbed#16', note: 'Hello world page', payload: null }, say)).toEqual({
      text: 'Filed it as #16',
      note: 'Hello world page',
      tone: 'done',
    });
  });
});

describe('the conversation', () => {
  const message = (partial: Partial<ThreadMessage> & Pick<ThreadMessage, 'id' | 'kind' | 'text' | 'at'>): ThreadMessage => ({
    author: 'fleetadlc',
    note: null,
    payload: null,
    githubUrl: null,
    subjectRef: 'fleetadlc-testbed#31',
    ...partial,
  });
  const gate: Gate = { id: 'gate-1', question: 'Store the model per round or per call?', options: ['per round', 'per call'], addressedTo: null, githubCommentUrl: null };

  it('heads each day, times each line, and keeps a question it is waiting on answerable', () => {
    const entries = timeline(
      [
        message({ id: 'm1', kind: 'sys', text: 'irisexampleco started pr-review on fleetadlc-testbed#31', at: '2026-09-23T16:00:00.000Z' }),
        message({ id: 'm2', kind: 'bot', author: 'irisexampleco', text: 'The review record keeps only the last model.', note: 'requested changes', at: '2026-09-24T10:47:00.000Z' }),
        message({ id: 'm3', kind: 'you', author: 'janedoe@example.test', text: 'Agreed.', at: '2026-09-24T10:49:00.000Z' }),
        message({ id: 'm4', kind: 'gate', author: 'irisexampleco', text: gate.question, payload: { gateId: 'gate-1', options: gate.options }, at: '2026-09-24T10:52:00.000Z' }),
      ],
      { now: NOW, openGate: gate, topics: [PULL], botName: 'irisexampleco', showSubjects: false, timeZone: 'UTC' },
    );

    expect(entries.map((entry) => (entry.kind === 'day' ? `— ${entry.label} —` : entry.kind === 'line' ? `${entry.time} ${entry.text}` : entry.kind === 'bubble' ? `${entry.author} ${entry.time}: ${entry.text}` : entry.label))).toEqual([
      '— Yesterday —',
      '16:00 Started reviewing pull request #31',
      '— Today —',
      'irisexampleco 10:47: The review record keeps only the last model.',
      'janedoe 10:49: Agreed.',
      'irisexampleco 10:52: Store the model per round or per call?',
    ]);
    const asked = entries.at(-1);
    expect(asked?.kind === 'bubble' && asked.question).toEqual({ gateId: 'gate-1', options: ['per round', 'per call'], open: true, githubUrl: null });
  });

  it('still offers a question it is waiting on whose own line is not in the thread', () => {
    const entries = timeline([], { now: NOW, openGate: gate, topics: [], botName: 'ottoexampleco', showSubjects: false, timeZone: 'UTC' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'bubble', text: gate.question, question: { open: true, options: ['per round', 'per call'] } });
  });

  it('says which subject a run of messages is about, with everything on screen', () => {
    const entries = timeline(
      [
        message({ id: 'm1', kind: 'bot', text: 'On the review.', at: minutesAgo(10) }),
        message({ id: 'm2', kind: 'bot', text: 'On the card.', at: minutesAgo(5), subjectRef: 'fleetadlc-testbed#15' }),
      ],
      { now: NOW, openGate: null, topics: [PULL, ISSUE], botName: 'irisexampleco', showSubjects: true, timeZone: 'UTC' },
    );
    expect(entries.filter((entry) => entry.kind === 'subject').map((entry) => entry.kind === 'subject' && entry.label)).toEqual([
      '#12 Record which model each review used',
      '#15 Show what a task has cost on its card',
    ]);
  });

  it('heads each run with the work item it opens, and a thread about nothing with no item', () => {
    // The bot's panel is its own view; the whole conversation about a piece
    // of work, every role's, is that work's item.
    const entries = timeline(
      [
        message({ id: 'm1', kind: 'bot', text: 'On the review.', at: minutesAgo(10) }),
        message({ id: 'm2', kind: 'bot', text: 'Before subjects.', at: minutesAgo(5), subjectRef: '' }),
      ],
      {
        now: NOW,
        openGate: null,
        topics: [{ ...PULL, item: 'fleetadlc-testbed#12' }, { ref: '', kind: 'other', title: null, issue: null, pullRequest: null, request: null, item: null }],
        botName: 'irisexampleco',
        showSubjects: true,
        timeZone: 'UTC',
      },
    );
    expect(entries.filter((entry) => entry.kind === 'subject').map((entry) => entry.kind === 'subject' && [entry.label, entry.item])).toEqual([
      ['#12 Record which model each review used', 'fleetadlc-testbed#12'],
      ['Not about any item', null],
    ]);
  });

  it('says a closed question was asked of the person only when they answered it', () => {
    const asked = message({ id: 'm1', kind: 'gate', author: 'irisexampleco', text: gate.question, payload: { gateId: 'gate-1' }, at: minutesAgo(10) });
    const note = (messages: ThreadMessage[]) =>
      timeline(messages, { now: NOW, openGate: null, topics: [], botName: 'irisexampleco', showSubjects: false, timeZone: 'UTC' })
        .filter((entry) => entry.kind === 'bubble' && entry.key === 'm1')
        .map((entry) => entry.kind === 'bubble' && entry.note);
    expect(note([asked])).toEqual(['asked']);
    expect(note([asked, message({ id: 'm2', kind: 'you', text: 'per round', payload: { gateId: 'gate-1' }, at: minutesAgo(5) })])).toEqual(['asked you']);
    expect(note([asked, message({ id: 'm2', kind: 'sys', text: 'the question was closed', payload: { gateId: 'gate-1' }, at: minutesAgo(5) })])).toEqual(['asked']);
  });

  it('names a day more than a week back by its date', () => {
    expect(dayLabel('2026-09-14T09:00:00.000Z', NOW, 'UTC')).toBe('Monday 14 September');
    expect(dayLabel('2026-09-21T09:00:00.000Z', NOW, 'UTC')).toBe('Monday');
  });
});

describe('the Show list, when a bot’s subjects are in several repositories', () => {
  const inApi: ThreadTopic = { ...ISSUE, ref: 'api#15', repo: 'api', issue: { number: 15, url: null } };
  const inWebsite: ThreadTopic = { ...PULL, ref: 'website@3f2c1a9', kind: 'other', repo: null, issue: null, pullRequest: null };

  it('groups them by repository, each where its newest subject puts it, and the ones in none last', () => {
    const groups = topicGroups([PULL, REQUEST, inApi, ISSUE, inWebsite]);
    expect(groups?.map((group) => [group.repo, group.topics.map((topic) => topic.ref)])).toEqual([
      ['fleetadlc-testbed', ['fleetadlc-testbed#31', 'fleetadlc-testbed#15']],
      ['api', ['api#15']],
      // Named from its address when the bridge said nothing: a deploy of a commit.
      ['website', ['website@3f2c1a9']],
      [null, ['request:a4b02784']],
    ]);
  });

  it('leaves them ungrouped when they are all in one, which a heading would only repeat', () => {
    expect(topicGroups([PULL, ISSUE, REQUEST])).toBeNull();
  });
});

describe('answering a question', () => {
  it('is asked for in the person’s own words while one is open', () => {
    expect(composerPlaceholder('answer')).toBe('Your own answer…');
    expect(composerPlaceholder('send')).toBe('Ask a question or give direction');
    expect(composerPlaceholder('none')).toBe('Ask a question or give direction');
  });

  it('sets a question of one line in bold, and leaves a whole message asked the older way as it was', () => {
    expect(standsOut('Where should the page go?')).toBe(true);
    expect(standsOut('Two things are missing:\n\n1. Hello, world or Hello?\n2. Setup steps?')).toBe(false);
    expect(standsOut('   ')).toBe(false);
  });
});

describe('a bot’s subjects by work item', () => {
  const topic = (ref: string, item: string | null): ThreadTopic => ({ ref, kind: 'issue', title: null, issue: null, pullRequest: null, request: null, item });

  it('puts an issue, its pull request and the request it came from in one group, and nothing in another', () => {
    const groups = groupByItem([topic('api#31', 'api#12'), topic('request:c0ffee00', 'request:c0ffee00'), topic('api#12', 'api#12'), topic('request:a4b02784', 'api#12')]);
    expect(groups.map((group) => [group.item, group.topics.map((one) => one.ref)])).toEqual([
      ['api#12', ['api#31', 'api#12', 'request:a4b02784']],
      ['request:c0ffee00', ['request:c0ffee00']],
    ]);
  });

  it('keeps a thread about nothing under no item, last, and an older bridge’s subjects each their own', () => {
    const groups = groupByItem([topic('', null), topic('api#15', null)]);
    expect(groups.map((group) => group.item)).toEqual(['api#15', null]);
  });
});
