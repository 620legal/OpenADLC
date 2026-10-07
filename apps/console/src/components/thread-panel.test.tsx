import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CrewMember, ThreadTopic } from '@/lib/api';
import { RoleProvider } from './app-header';
import { RepoColorsProvider } from './repo-badge';
import { QuestionCard, ShowList, ThreadPanel } from './thread-panel';

const NOW = '2026-09-24T10:53:00.000Z';

function crewMember(partial: Partial<CrewMember> & Pick<CrewMember, 'name' | 'role'>): CrewMember {
  return {
    slot: null,
    displayName: partial.name,
    engine: 'grok',
    model: 'newest:grok',
    // The column nothing updates, which says "stopped" for every bot.
    status: 'stopped',
    container: `bot-${partial.name}`,
    githubLogin: null,
    authorization: 'active',
    tokenExpiresAt: null,
    now: 'nothing running',
    paused: false,
    sessions: [],
    task: null,
    lastTask: null,
    ...partial,
  };
}

/**
 * The panel as it is first drawn, before its thread has been read: what it is
 * called and what it is doing come from the crew, which the page hands it.
 */
function panel(member: CrewMember): string {
  return renderToStaticMarkup(<ThreadPanel bot={member.name} member={member} onClose={() => undefined} now={NOW} />).replace(
    /<!-- -->/g,
    '',
  );
}

const REVIEWER = crewMember({
  name: 'irisexampleco',
  slot: 'second-reviewer',
  role: 'review_second',
  githubLogin: 'irisexampleco',
  task: {
    kind: 'review',
    state: 'running',
    subjectRef: 'fleetadlc-testbed#31',
    issue: { repo: 'fleetadlc-testbed', number: 12, title: 'Record which model each review used' },
    startedAt: '2026-09-24T10:47:00.000Z',
    endedAt: null,
    round: 2,
    maxRounds: 3,
    waitingOnYou: false,
    approval: false,
    costUsd: 0.38,
  },
});

describe('a bot’s last task, when it could not finish', () => {
  const failed = (state: string) =>
    panel({ ...REVIEWER, task: null, lastTask: { ...REVIEWER.task!, id: 'task-31', state, endedAt: '2026-09-24T10:50:00.000Z' } });
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);

  it('offers to run it again or stop it for good, as its card on the board does', () => {
    const html = failed('failed');
    expect(html).toContain('Could not finish');
    expect(buttons(html)).toEqual(expect.arrayContaining(['Try again', 'Stop']));
  });

  it('offers both for a task stopped under the bot, as its card does, and neither once a person stopped it', () => {
    expect(buttons(failed('stopped'))).toEqual(expect.arrayContaining(['Try again', 'Stop']));
    const byAPerson = panel({
      ...REVIEWER,
      task: null,
      lastTask: { ...REVIEWER.task!, id: 'task-31', state: 'stopped', stoppedByAPerson: true, endedAt: '2026-09-24T10:50:00.000Z' },
    });
    for (const label of ['Try again', 'Stop']) expect(buttons(byAPerson)).not.toContain(label);
  });

  it('offers neither for work that finished, or for a task going now', () => {
    for (const html of [failed('done'), panel(REVIEWER)]) {
      for (const label of ['Try again', 'Stop']) expect(buttons(html)).not.toContain(label);
    }
  });

  it('offers Try again, and not Stop, for a build that finished without a pull request', () => {
    const html = panel({
      ...REVIEWER,
      task: null,
      lastTask: { ...REVIEWER.task!, kind: 'build', id: 'task-31', state: 'done', endedWithoutPullRequest: true, endedAt: '2026-09-24T10:50:00.000Z' },
    });
    expect(buttons(html)).toContain('Try again');
    expect(buttons(html)).not.toContain('Stop');
  });
});

describe('a bot’s thread panel', () => {
  it('is headed with the handle, the role and what it thinks with', () => {
    const html = panel(REVIEWER);
    expect(html).toMatch(/<h2[^>]*>irisexampleco<\/h2><span[^>]*>Second reviewer · Newest Grok<\/span>/);
    expect(html).toContain('aria-label="irisexampleco’s thread"');
  });

  it('says what the bot is doing from its task, never from the status column', () => {
    const html = panel(REVIEWER);
    expect(html).toContain('Reviewing · 6 min');
    expect(html).toContain('round 2 of 3');
    expect(html).toMatch(/<span class="font-normal text-dim">#12 <\/span>Record which model each review used/);
    expect(html).toContain('$0.38 on this task');
    expect(html).not.toMatch(/stopped/i);
  });

  it('offers the conversation, its computer and its terminal, and shows the subject the task is about', () => {
    const html = panel(REVIEWER);
    expect([...html.matchAll(/role="tab"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/button>/g)].map((match) => match[1])).toEqual([
      'Conversation',
      'Its computer',
      'Terminal',
    ]);
    expect(html).toMatch(/<option value="fleetadlc-testbed#31" selected="">#12 Record which model each…<\/option><option value="\*">Everything<\/option>/);
    // Never the address, `request:a4b02784` or otherwise, as a chip to press.
    expect(html).not.toContain('aria-pressed');
  });

  it('offers a user the conversation only: a bot’s computer and its terminal are an admin’s', () => {
    const html = renderToStaticMarkup(
      <RoleProvider role="user">
        <ThreadPanel bot={REVIEWER.name} member={REVIEWER} onClose={() => undefined} now={NOW} />
      </RoleProvider>,
    ).replace(/<!-- -->/g, '');
    expect([...html.matchAll(/role="tab"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(['Conversation']);
    expect(html).toContain('Message the second reviewer');
  });

  it('says where a message goes before it is sent', () => {
    const html = panel(REVIEWER);
    expect(html).toMatch(/<label[^>]*>Message the second reviewer \(irisexampleco\)<\/label>/);
    expect(html).toContain('Posted on pull request #31 as a comment');
    expect(html).not.toContain('every message is a comment on github first');
  });

  it('is headed with the role of a bot that has no account yet, and never with its seat', () => {
    const html = panel(
      crewMember({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', engine: 'codex', model: 'newest:codex', authorization: 'unauthorized' }),
    );

    expect(html).toMatch(/<h2[^>]*>Lead reviewer<\/h2><span[^>]*>Not connected yet · Newest Codex<\/span>/);
    expect(html).toContain('Cannot work until its account is connected');
    expect(html).toMatch(/<label[^>]*>Message the lead reviewer<\/label>/);
    expect(html).not.toContain('lead-reviewer');
  });
});

describe('a bot’s thread when OpenADLC works in several repositories', () => {
  const COLORS = { 'fleetadlc-testbed': 'blue', api: 'teal' };

  it('says which repository the task pinned at the top is in', () => {
    const html = renderToStaticMarkup(
      <RepoColorsProvider colors={COLORS}>
        <ThreadPanel bot={REVIEWER.name} member={{ ...REVIEWER, task: { ...REVIEWER.task!, repo: 'fleetadlc-testbed' } }} onClose={() => undefined} now={NOW} />
      </RepoColorsProvider>,
    ).replace(/<!-- -->/g, '');
    expect(html).toMatch(/round 2 of 3<\/span><span title="fleetadlc-testbed"[^>]*><span aria-hidden="true" class="[^"]*bg-repo-blue[^"]*"><\/span><span class="truncate">fleetadlc-testbed<\/span>/);
  });

  it('says nothing of it with one repository, where every task is in it', () => {
    expect(panel(REVIEWER)).not.toContain('bg-repo-');
  });

  it('groups the Show list’s subjects by repository', () => {
    const topic = (ref: string, number: number, title: string): ThreadTopic => ({
      ref,
      kind: 'issue',
      title,
      issue: { number, url: null },
      pullRequest: null,
      request: null,
    });
    const shown = [topic('api#15', 15, 'Page the runs'), topic('fleetadlc-testbed#12', 12, 'Record the model'), topic('api#9', 9, 'Say the cost')];
    const html = renderToStaticMarkup(<ShowList shown={shown} selected="api#15" title="#15 Page the runs" onChoose={() => undefined} />);
    const groups = [...html.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)].map((match) => [
      match[1],
      [...match[2]!.matchAll(/<option value="([^"]+)"/g)].map((option) => option[1]),
    ]);
    expect(groups).toEqual([
      ['api', ['api#15', 'api#9']],
      ['fleetadlc-testbed', ['fleetadlc-testbed#12']],
    ]);
    expect(html).toMatch(/<\/optgroup><option value="\*">Everything<\/option><\/select>/);
  });

  it('groups a bot’s subjects by work item, with a thread about nothing under no item', () => {
    // The builder wrote #12 and fixed it on #31: one piece of work, one group.
    const topic = (ref: string, item: string | null, title: string | null, number: number | null): ThreadTopic => ({
      ref,
      kind: ref === '' ? 'other' : 'issue',
      repo: 'api',
      title,
      issue: number ? { number, url: null } : null,
      pullRequest: null,
      request: null,
      item,
    });
    const shown = [topic('api#31', 'api#12', 'Record the model', 12), topic('api#12', 'api#12', 'Record the model', 12), topic('api#15', 'api#15', 'Page the runs', 15), topic('', null, null, null)];
    const html = renderToStaticMarkup(<ShowList shown={shown} selected={null} title="Everything" onChoose={() => undefined} />);
    const groups = [...html.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)].map((match) => [
      match[1],
      [...match[2]!.matchAll(/<option value="([^"]*)"/g)].map((option) => option[1]),
    ]);
    expect(groups).toEqual([
      ['#12 Record the model', ['api#31', 'api#12']],
      ['#15 Page the runs', ['api#15']],
      ['Not about any item', ['']],
    ]);
  });
});

type Pressable = ReactElement<{ onClick?: () => void; children?: ReactNode }>;

/** What an element says, as text. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/**
 * The buttons a component draws, read from the elements it returns. The card
 * keeps no state, so it can be called like the function it is and its buttons
 * pressed, without a browser to render it in.
 */
function buttonsOf(node: ReactNode): Pressable[] {
  if (Array.isArray(node)) return node.flatMap(buttonsOf);
  if (!isValidElement(node)) return [];
  const own = node.type === 'button' ? [node as Pressable] : [];
  return [...own, ...buttonsOf((node.props as { children?: ReactNode }).children)];
}

/**
 * One question at a time, offered as choices where it can be, always with room
 * to answer in your own words instead.
 */
describe('the question a bot is waiting on', () => {
  const QUESTION = 'Where should the page go?';
  const CHOICES = ['index.html at the repository root', 'A different path'];

  function card(options: string[]): string {
    return renderToStaticMarkup(
      <QuestionCard question={QUESTION} options={options} githubUrl={null} pending={false} onAnswer={() => undefined} onOwnWords={() => undefined} />,
    ).replace(/<!-- -->/g, '');
  }

  it('stands out, offers its choices as buttons in the order the bot gave them, and takes the person’s own words too', () => {
    const html = card(CHOICES);

    expect(html).toMatch(/font-semibold[^"]*"><p><span>Where should the page go\?<\/span><\/p>/);
    expect([...html.matchAll(/<button type="button" class="[^"]*">([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(CHOICES);
    expect(html).toMatch(/<button type="button" class="[^"]*">Or answer in your own words<svg/);
  });

  it('is answered by the choice pressed, and sends the person to the box for their own words', () => {
    const answered: string[] = [];
    let ownWords = 0;
    const buttons = buttonsOf(
      QuestionCard({
        question: QUESTION,
        options: CHOICES,
        githubUrl: null,
        pending: false,
        onAnswer: (answer) => answered.push(answer),
        onOwnWords: () => (ownWords += 1),
      }),
    );

    buttons.find((button) => textOf(button) === 'A different path')?.props.onClick?.();
    expect(answered).toEqual(['A different path']);

    buttons.find((button) => textOf(button) === 'Or answer in your own words')?.props.onClick?.();
    expect(ownWords).toBe(1);
    expect(answered).toEqual(['A different path']);
  });

  it('is the question and nothing else when it is open: the box below is the answer', () => {
    const html = card([]);

    expect(html).toContain('Where should the page go?');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('own words');
  });

  it('says where else it was asked', () => {
    const html = renderToStaticMarkup(
      <QuestionCard
        question={QUESTION}
        options={CHOICES}
        githubUrl="https://github.com/janedoe/fleetadlc-testbed/issues/15#issuecomment-1"
        pending={false}
        onAnswer={() => undefined}
        onOwnWords={() => undefined}
      />,
    );
    expect(html).toMatch(/<a href="https:\/\/github.com\/janedoe\/fleetadlc-testbed\/issues\/15#issuecomment-1"[^>]*>Also asked on GitHub/);
  });
});
