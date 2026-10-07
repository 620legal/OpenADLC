import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CrewView } from './crew-view';
import { SeatTable } from './seat-table';
import type { CrewMember, TaskSummary } from '@/lib/api';
import { headerData } from '@/lib/header';

const NOW = '2026-09-24T12:00:00.000Z';
const minutesAgo = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function member(partial: Partial<CrewMember> & Pick<CrewMember, 'name'>): CrewMember {
  return {
    slot: 'builder',
    displayName: partial.name,
    role: 'implement',
    engine: 'claude',
    model: 'newest:opus',
    // The column nothing updates. Every bot on a real install reads this.
    status: 'stopped',
    container: `bot-${partial.name}`,
    githubLogin: partial.name,
    authorization: 'active',
    tokenExpiresAt: null,
    now: 'nothing running',
    paused: false,
    sessions: [],
    modelAccountId: 'max',
    task: null,
    lastTask: null,
    ...partial,
  };
}

function task(partial: Partial<TaskSummary> & Pick<TaskSummary, 'kind' | 'state'>): TaskSummary {
  return {
    subjectRef: 'fleetadlc#16',
    issue: { repo: 'fleetadlc', number: 16, title: 'Let the board filter by label' },
    startedAt: null,
    endedAt: null,
    round: null,
    waitingOnYou: false,
    ...partial,
  };
}

const CREW = [
  member({ name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', engine: 'none', model: 'none', modelAccountId: null }),
  member({
    name: 'irisexampleco',
    slot: 'second-reviewer',
    role: 'review_second',
    engine: 'grok',
    model: 'newest:grok',
    modelAccountId: 'xai',
    task: task({ kind: 'review', state: 'running', subjectRef: 'fleetadlc#31', issue: { repo: 'fleetadlc', number: 12, title: 'x' }, round: 2 }),
  }),
  member({ name: 'fleetadlc-atlas-janedoe', task: task({ kind: 'implement', state: 'running', startedAt: minutesAgo(12) }) }),
  member({
    name: 'ottoexampleco',
    slot: 'intake',
    role: 'intake',
    task: task({ kind: 'intake', state: 'paused', subjectRef: 'fleetadlc#15', issue: { repo: 'fleetadlc', number: 15, title: 'x' }, waitingOnYou: true }),
  }),
  member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' }),
  member({
    name: 'fleetadlc-cipher-janedoe',
    slot: 'security-reviewer',
    role: 'review_security',
    lastTask: task({ kind: 'review', state: 'done', issue: { repo: 'fleetadlc', number: 12, title: 'x' }, endedAt: minutesAgo(120) }),
  }),
];

const ACCOUNTS = [
  { id: 'max', provider: 'anthropic', kind: 'subscription', label: 'Anthropic — Max' },
  { id: 'xai', provider: 'xai', kind: 'subscription', label: 'xAI — subscription' },
];

function page(crew: CrewMember[] = CREW, repos: string[] = ['fleetadlc']): string {
  return renderToStaticMarkup(
    <CrewView
      crew={crew}
      accounts={ACCOUNTS}
      byBot={[
        { bot: 'fleetadlc-atlas-janedoe', costUsd: 3.12 },
        { bot: 'irisexampleco', costUsd: 0.38 },
      ]}
      header={headerData({ repos, repoColors: { fleetadlc: 'blue', api: 'teal' }, crew, budget: null, needsYou: 1 })}
      now={NOW}
    />,
  ).replace(/<!-- -->/g, '');
}

/** One bot's card, by the name it shows: to the next card, since a card has lists of its own. */
function cardOf(html: string, name: string): string {
  const start = html.indexOf(`>${name}</span>`);
  if (start === -1) throw new Error(`no card for ${name}`);
  const next = html.indexOf('data-seat-card=', start);
  return html.slice(start, next === -1 ? undefined : next);
}

describe('how many tasks each seat runs at once', () => {
  it('is a choice from 1 to 16 on each seat that thinks, showing what it is now', () => {
    const html = page([member({ name: 'fleetadlc-atlas-janedoe', maxTasks: 3 }), member({ name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', engine: 'none', model: 'none' })]);

    const card = cardOf(html, 'fleetadlc-atlas-janedoe');
    expect(card).toContain('>Tasks at once<');
    expect(card).toContain('aria-label="fleetadlc-atlas-janedoe tasks at once"');
    expect(card).toContain('<option value="3" selected="">3</option>');
    expect(card).toContain('<option value="16">16</option>');
    // The automation account thinks with nothing, and runs no tasks of its own.
    expect(cardOf(html, 'janedoe-fleetadlc-flow')).not.toContain('Tasks at once');
  });

  it('reads as one from a bridge that does not say', () => {
    expect(cardOf(page([member({ name: 'fleetadlc-atlas-janedoe' })]), 'fleetadlc-atlas-janedoe')).toContain('<option value="1" selected="">1</option>');
  });

  it('says to keep a seat on an OpenAI or xAI subscription at one, and only above one', () => {
    // Its CLI refreshes one sign-in for every task on it; two at once may race.
    const above = page([member({ name: 'irisexampleco', engine: 'grok', modelAccountId: 'xai', maxTasks: 2 })]);
    const atOne = page([member({ name: 'irisexampleco', engine: 'grok', modelAccountId: 'xai', maxTasks: 1 })]);
    const claude = page([member({ name: 'fleetadlc-atlas-janedoe', modelAccountId: 'max', maxTasks: 2 })]);

    expect(above).toContain('Keep this at 1');
    expect(atOne).not.toContain('Keep this at 1');
    expect(claude).not.toContain('Keep this at 1');
  });
});

describe('the crew page', () => {
  it('lists the bots in the order a request meets them', () => {
    const html = page();
    const names = [...html.matchAll(/<span class="block truncate text-sm font-semibold text-body"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(names).toEqual(['ottoexampleco', 'fleetadlc-atlas-janedoe', 'Lead reviewer', 'irisexampleco', 'fleetadlc-cipher-janedoe', 'janedoe-fleetadlc-flow']);
    expect(html).toContain(
      'Six bots, one per seat. They pick up work by role, and several can share one GitHub account: each keeps its own work and conversations. Each works across your repositories, with a separate copy of each. One is not connected yet.',
    );
  });

  it('says what each is doing from its tasks, never from the status column', () => {
    const html = page();
    expect(cardOf(html, 'fleetadlc-atlas-janedoe')).toContain('>Working<');
    expect(cardOf(html, 'fleetadlc-atlas-janedoe')).toContain('Writing #16 · 12 min');
    expect(cardOf(html, 'irisexampleco')).toContain('Reviewing #12 · round 2');
    expect(cardOf(html, 'ottoexampleco')).toContain('>Waiting for you<');
    expect(cardOf(html, 'ottoexampleco')).toContain('Asked you about #15');
    expect(cardOf(html, 'fleetadlc-cipher-janedoe')).toContain('>Idle<');
    expect(cardOf(html, 'fleetadlc-cipher-janedoe')).toContain('Reviewed #12 2 hours ago');
    expect(html).not.toContain('stopped');
  });

  it('says what each thinks with and what it cost this month', () => {
    const html = page();
    expect(cardOf(html, 'fleetadlc-atlas-janedoe')).toContain('Newest Opus · Anthropic — Max');
    expect(cardOf(html, 'fleetadlc-atlas-janedoe')).toContain('$3.12');
    expect(cardOf(html, 'irisexampleco')).toContain('Newest Grok · xAI — subscription');
    expect(cardOf(html, 'janedoe-fleetadlc-flow')).toContain('No model, by design');
    expect(cardOf(html, 'janedoe-fleetadlc-flow')).toContain('Free');
    expect(cardOf(html, 'janedoe-fleetadlc-flow')).toContain('>On duty<');
  });

  it('names a bot with no account by its role, and offers to connect it', () => {
    const card = cardOf(page(), 'Lead reviewer');
    expect(card).toContain('not connected yet');
    expect(card).toContain('>Not connected<');
    expect(card).toContain('href="/onboarding?step=github-accounts"');
    expect(page()).not.toContain('>lead-reviewer<');
  });

  it('offers each bot’s thread, and the model change, but no model for the automation bot', () => {
    const html = page();
    expect(cardOf(html, 'fleetadlc-atlas-janedoe')).toMatch(/<button[^>]*>Watch it work<\/button>/);
    expect(cardOf(html, 'fleetadlc-cipher-janedoe')).toMatch(/<button[^>]*>Open thread<\/button>/);
    // Changing the model opens the seat's own settings, not the walkthrough.
    expect(cardOf(html, 'fleetadlc-cipher-janedoe')).toMatch(/<button[^>]*>Change model<\/button>/);
    expect(cardOf(html, 'janedoe-fleetadlc-flow')).toMatch(/<button[^>]*>See what it did<\/button>/);
    expect(cardOf(html, 'janedoe-fleetadlc-flow')).not.toContain('Change model');
  });

  it('is under the same header as the board, with Crew marked', () => {
    expect(page()).toMatch(/<a aria-current="page"[^>]*href="\/crew"/);
  });
});

describe('the crew by role', () => {
  // Two reviewers on one reviewer account and two seats on one crew account:
  // a page of identical handles said nothing about who does what.
  const SHARED = [
    member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'acme-reviewer' }),
    member({ name: 'builder', slot: 'builder', role: 'implement', githubLogin: 'acme-crew', task: task({ kind: 'implement', state: 'running', subjectRef: 'api#40', issue: { repo: 'api', number: 16, title: 'x' } }) }),
    member({ name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'acme-reviewer' }),
    member({ name: 'intake', slot: 'intake', role: 'intake', githubLogin: 'acme-crew', task: task({ kind: 'intake', state: 'paused', subjectRef: 'request:a4b02784', issue: null, waitingOnYou: true }) }),
    member({ name: 'janebot', slot: 'security-reviewer', role: 'review_security', githubLogin: 'janebot' }),
  ];

  it('is one grid in the order a request meets them, each card saying its role', () => {
    // A section per role held one card each, and three-across became one long column.
    const html = page(SHARED);
    expect(html.match(/data-crew-grid/g)).toHaveLength(1);
    expect([...html.matchAll(/data-seat-card="([^"]+)"/g)].map((match) => match[1])).toEqual(['intake', 'builder', 'lead-reviewer', 'second-reviewer', 'janebot']);
    expect(cardOf(html, 'janebot')).toContain('>Security reviewer<');
  });

  it('says whom a seat shares its account with, and nothing for one with its own', () => {
    const html = page(SHARED);
    expect(cardOf(html, 'acme-reviewer')).toContain('shares @acme-reviewer with 1 other seat');
    expect(html.match(/shares @acme-crew with 1 other seat/g)).toHaveLength(2);
    expect(cardOf(html, 'janebot')).not.toContain('shares @');
  });

  it('opens the current task’s work item, on the seat’s role', () => {
    const html = page(SHARED);
    expect(html).toContain(`href="/?item=${encodeURIComponent('api#16')}&amp;role=implement"`);
    // A request's task opens the request's own item.
    expect(html).toContain(`href="/?item=${encodeURIComponent('request:a4b02784')}&amp;role=intake"`);
  });
});

describe('the crew across several repositories', () => {
  /** "Now", as its badge and its words say it. */
  function now(html: string, name: string): string {
    const card = cardOf(html, name);
    const row = /<dt class="text-dim">Now<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/.exec(card)?.[1] ?? '';
    const badge = /<span title="([^"]+)"[^>]*><span aria-hidden="true" class="[^"]*bg-repo-([a-z]+)/.exec(row);
    const words = /<(?:span|a)[^>]*>([^<]+)<\/(?:span|a)>$/.exec(row)?.[1];
    return `${badge ? `[${badge[1]} ${badge[2]}] ` : ''}${words}`;
  }

  it('names the repository each bot is working in, beside what it is doing', () => {
    const crew = CREW.map((bot) =>
      bot.name === 'fleetadlc-atlas-janedoe'
        ? { ...bot, task: task({ kind: 'implement', state: 'running', startedAt: minutesAgo(12), subjectRef: 'api#16', repo: 'api', issue: { repo: 'api', number: 16, title: 'x' } }) }
        : bot,
    );
    const html = page(crew, ['api', 'fleetadlc']);
    expect(now(html, 'fleetadlc-atlas-janedoe')).toBe('[api teal] Writing #16 · 12 min');
    expect(now(html, 'irisexampleco')).toBe('[fleetadlc blue] Reviewing #12 · round 2');
    // What it last did, when nothing is going, and where.
    expect(now(html, 'fleetadlc-cipher-janedoe')).toBe('[fleetadlc blue] Reviewed #12 2 hours ago');
    // A line about no task names no repository.
    expect(now(html, 'janedoe-fleetadlc-flow')).toBe('Labels issues and sets the review gate');
  });

  it('names none with only one repository, where every task is in it', () => {
    expect(now(page(), 'irisexampleco')).toBe('Reviewing #12 · round 2');
  });
});

describe('what a card says beyond what it is doing', () => {
  const BUSY = member({
    name: 'fleetadlc-atlas-janedoe',
    task: task({ kind: 'implement', state: 'running', startedAt: minutesAgo(12) }),
    queue: { running: 1, waiting: 1, queued: 2, next: { ref: 'fleetadlc#20', title: 'Retry the webhook' } },
    recent: [
      { ref: 'fleetadlc#9', title: 'Add a snake game', kind: 'implement', outcome: 'done', at: minutesAgo(30), item: 'fleetadlc#9' },
      { ref: 'fleetadlc#8', title: 'A banner', kind: 'patch', outcome: 'sent_back', at: minutesAgo(90), item: 'fleetadlc#8' },
      { ref: 'fleetadlc#7', title: 'A page', kind: 'implement', outcome: 'failed', at: minutesAgo(200), item: 'fleetadlc#7' },
      { ref: 'fleetadlc#6', title: 'Fourth', kind: 'implement', outcome: 'stopped', at: minutesAgo(300), item: 'fleetadlc#6' },
    ],
    health: { state: 'ok', reasons: [] },
  });

  it('says what it has on and the next thing it will take', () => {
    expect(cardOf(page([BUSY]), 'fleetadlc-atlas-janedoe')).toContain('1 running · 1 waiting for you · 2 queued · next: #20 Retry the webhook');
  });

  it('lists the last three it finished, each marked and opening its item on the seat’s role', () => {
    const card = cardOf(page([BUSY]), 'fleetadlc-atlas-janedoe');
    expect(card).toContain('aria-label="done"');
    expect(card).toContain('aria-label="sent back"');
    expect(card).toContain('aria-label="failed"');
    expect(card).not.toContain('Fourth');
    expect(card).toContain(`href="/?item=${encodeURIComponent('fleetadlc#9')}&amp;role=implement"`);
  });

  it('marks a seat that cannot work, says why, and offers the fix', () => {
    const failing = member({
      name: 'fleetadlc-atlas-janedoe',
      health: { state: 'failing', reasons: [{ title: 'It cannot sign in to GitHub', action: { label: 'Reconnect', href: '/onboarding?step=github-accounts' } }] },
    });
    const card = cardOf(page([failing]), 'fleetadlc-atlas-janedoe');
    expect(card).toContain('data-health="failing"');
    expect(card).toContain('It cannot sign in to GitHub');
    expect(card).toMatch(/<a[^>]*href="\/onboarding\?step=github-accounts"[^>]*>Reconnect<\/a>/);
  });

  it('names the fix the way its check does, not as reconnecting an account that works', () => {
    const outside = member({
      name: 'fleetadlc-atlas-janedoe',
      health: { state: 'failing', reasons: [{ title: 'It cannot push to exampleco/api', action: { label: 'Let the crew in', href: '/onboarding?step=access' } }] },
    });
    const card = cardOf(page([outside]), 'fleetadlc-atlas-janedoe');
    expect(card).toMatch(/<a[^>]*href="\/onboarding\?step=access"[^>]*>Let the crew in<\/a>/);
    expect(card).not.toContain('Reconnect account');
  });

  it('works its health out from its checks on a bridge that does not say', () => {
    const checked = member({ name: 'fleetadlc-atlas-janedoe', checks: [{ id: 'bot-sign-in', title: 'The builder cannot sign in', severity: 'blocking' }] });
    expect(cardOf(page([checked]), 'fleetadlc-atlas-janedoe')).toContain('data-health="failing"');
    expect(cardOf(page([member({ name: 'fleetadlc-atlas-janedoe' })]), 'fleetadlc-atlas-janedoe')).toContain('data-health="ok"');
  });

  it('says a paused seat is paused, by whom and why, dims it, and offers Resume', () => {
    const paused = member({ name: 'fleetadlc-atlas-janedoe', seatPaused: { by: 'janedoe', at: minutesAgo(5), why: 'changing its model' } });
    const html = page([paused]);
    expect(html).toMatch(/data-seat-card="fleetadlc-atlas-janedoe"[^>]*class="[^"]*opacity-70/);
    expect(cardOf(html, 'fleetadlc-atlas-janedoe')).toContain('title="Paused by janedoe 5 min ago: changing its model"');
    expect(cardOf(html, 'fleetadlc-atlas-janedoe')).toMatch(/<button[^>]*>Resume<\/button>/);
  });

  it('keeps the avatar choice off the card: it is in the seat’s settings', () => {
    expect(page()).not.toContain('avatar"');
    expect(page()).not.toContain('>Avatar<');
  });

  it('draws from a bridge that sends none of it', () => {
    const card = cardOf(page([member({ name: 'fleetadlc-atlas-janedoe' })]), 'fleetadlc-atlas-janedoe');
    expect(card).not.toContain('Has on');
    expect(card).toMatch(/<button[^>]*>Pause this seat<\/button>/);
  });
});

describe('the crew as a table', () => {
  function table(crew: CrewMember[] = CREW): string {
    return renderToStaticMarkup(
      <SeatTable crew={crew} accounts={ACCOUNTS} listings={null} byBot={[{ bot: 'fleetadlc-atlas-janedoe', costUsd: 3.12 }]} now={NOW} showRepo={false} onOpen={() => undefined} />,
    ).replace(/<!-- -->/g, '');
  }

  it('has a row per seat in pipeline order, under the columns a person compares them by', () => {
    const html = table();
    expect([...html.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1])).toEqual([
      'Seat',
      'Status',
      'Now',
      'Model',
      'Tasks at once',
      'GitHub account',
      'Cost · last result',
      'Health',
      'Actions',
    ]);
    expect([...html.matchAll(/data-seat-row="([^"]+)"/g)].map((match) => match[1])).toEqual([
      'ottoexampleco',
      'fleetadlc-atlas-janedoe',
      'lead-reviewer',
      'irisexampleco',
      'fleetadlc-cipher-janedoe',
      'janedoe-fleetadlc-flow',
    ]);
  });

  it('changes the model and the tasks at once in the row, and says what it thinks with before the accounts are read', () => {
    const row = rowOf(table(), 'fleetadlc-atlas-janedoe');
    expect(row).toContain('aria-label="fleetadlc-atlas-janedoe model"');
    expect(row).toContain('<option value="max|newest:opus" selected="">Newest Opus · Anthropic — Max</option>');
    expect(row).toContain('aria-label="fleetadlc-atlas-janedoe tasks at once"');
    expect(rowOf(table(), 'janedoe-fleetadlc-flow')).toContain('No model, by design');
  });

  it('says the account it acts as, and how many seats share it', () => {
    const shared = [member({ name: 'builder', githubLogin: 'acme-crew' }), member({ name: 'intake', slot: 'intake', role: 'intake', githubLogin: 'acme-crew' })];
    expect(rowOf(table(shared), 'builder')).toContain('@acme-crew');
    expect(rowOf(table(shared), 'builder')).toContain('shared with 1');
  });

  function rowOf(html: string, name: string): string {
    const start = html.indexOf(`data-seat-row="${name}"`);
    if (start === -1) throw new Error(`no row for ${name}`);
    return html.slice(start, html.indexOf('</tr>', start));
  }
});
