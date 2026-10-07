import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RoleProvider } from './app-header';
import { BoardView, peopleLine } from './board-view';
import type { AttentionItem, Board, BoardCard, CrewMember } from '@/lib/api';
import { labelIn } from '@/lib/bot-label';
import { headerData } from '@/lib/header';
import { colorMapOf } from '@/lib/repo-colors';

const NOW = '2026-09-24T12:00:00.000Z';
const minutesAgo = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function member(partial: Partial<CrewMember> & Pick<CrewMember, 'name'>): CrewMember {
  return {
    displayName: partial.name,
    role: 'review_lead',
    engine: 'claude',
    model: 'claude-opus-5',
    status: 'stopped',
    container: `bot-${partial.name}`,
    githubLogin: partial.name,
    authorization: 'active',
    tokenExpiresAt: null,
    now: 'nothing running',
    paused: false,
    sessions: [],
    ...partial,
  };
}

const CREW = [
  member({ name: 'ottoexampleco', slot: 'intake', role: 'intake' }),
  member({ name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement' }),
  member({ name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second' }),
  member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' }),
  member({ name: 'tessexampleco', slot: 'sre', role: 'deploy' }),
];

function card(partial: Partial<BoardCard> & Pick<BoardCard, 'ref' | 'stage' | 'title'>): BoardCard {
  return {
    repo: 'fleetadlc',
    assignees: [],
    gateOpen: false,
    url: `https://github.com/janedoe/fleetadlc/issues/${partial.ref.split('#')[1]}`,
    labels: [],
    updatedAt: minutesAgo(30),
    number: Number(partial.ref.split('#')[1]),
    prNumber: null,
    costUsd: 0,
    active: [],
    last: null,
    reviewRound: null,
    stalledAfterRounds: null,
    approval: false,
    shippedAt: null,
    ...partial,
  };
}

const MODES = { intake: 'autonomous', spec: 'conditional', build: 'autonomous', review: 'autonomous', merged: 'assist', done: 'autonomous' };

function columns(cards: BoardCard[]): Board['columns'] {
  const titles: Record<string, string> = { intake: 'Intake', spec: 'Design', build: 'Build', review: 'Review', merged: 'Ship', done: 'Done' };
  const staff: Record<string, Board['columns'][number]['bots']> = {
    intake: [{ name: 'ottoexampleco', displayName: 'intake', working: false, waiting: true }],
    spec: [],
    build: [{ name: 'fleetadlc-atlas-janedoe', displayName: 'builder', working: true, waiting: false }],
    review: [
      { name: 'lead-reviewer', displayName: 'lead reviewer', working: false, waiting: false },
      { name: 'irisexampleco', displayName: 'second reviewer', working: true, waiting: false },
    ],
    merged: [{ name: 'tessexampleco', displayName: 'SRE', working: false, waiting: false }],
    done: [],
  };
  return Object.keys(titles).map((stage) => ({
    stage,
    title: titles[stage]!,
    mode: MODES[stage as keyof typeof MODES],
    bots: staff[stage]!,
    cards: cards.filter((one) => one.stage === stage),
  }));
}

const WORKING: BoardCard[] = [
  card({ ref: 'fleetadlc#15', stage: 'intake', title: 'Show what a task has cost on its card', gateOpen: true, costUsd: 0.12, active: [{ bot: 'ottoexampleco', kind: 'intake', state: 'paused', round: 0, startedAt: minutesAgo(5), endedAt: null, exitReason: null }] }),
  card({
    ref: 'fleetadlc#16',
    stage: 'build',
    title: 'Let the board filter by label',
    labels: ['adlc:build', 'start:now'],
    costUsd: 0.84,
    active: [{ bot: 'fleetadlc-atlas-janedoe', kind: 'implement', state: 'running', round: 0, startedAt: minutesAgo(12), endedAt: null, exitReason: null }],
  }),
  card({ ref: 'fleetadlc#17', stage: 'build', title: 'Show each bot’s model on its card', labels: ['adlc:build', 'start:now'] }),
  card({ ref: 'fleetadlc#12', stage: 'review', title: 'Record which model each review used', prNumber: 31, reviewRound: 2, costUsd: 1.36, active: [{ bot: 'irisexampleco', kind: 'review', state: 'running', round: 0, startedAt: minutesAgo(6), endedAt: null, exitReason: null }] }),
  card({ ref: 'fleetadlc#11', stage: 'review', title: 'Rate-limit the webhook route', prNumber: 29, stalledAfterRounds: 3, costUsd: 2.02 }),
  card({ ref: 'fleetadlc#10', stage: 'done', title: 'Pin the Node version in CI', costUsd: 1.12, shippedAt: minutesAgo(120) }),
  card({ ref: 'fleetadlc#4', stage: 'done', title: 'Something from last month', shippedAt: '2026-08-20T10:00:00.000Z' }),
];

const BOARD: Board = {
  repo: 'all',
  repos: ['fleetadlc'],
  columns: columns(WORKING),
  mergeLine: [],
  waitingOnYou: 1,
  working: 2,
  idle: 3,
};

const ATTENTION: AttentionItem[] = [
  {
    id: 'gate:gate-1',
    kind: 'question',
    headline: 'ottoexampleco has a question',
    subject: { repo: 'fleetadlc', number: 15, title: 'Show what a task has cost on its card', ref: 'fleetadlc#15', url: null },
    bot: { name: 'ottoexampleco', slot: 'intake', role: 'intake', roleLabel: 'intake', githubLogin: 'ottoexampleco' },
    since: minutesAgo(2),
    detail: 'Should the cost include review rounds, or only the build?',
    actions: [{ kind: 'answer', label: 'Answer', bot: 'ottoexampleco' }],
  },
];

function render(
  board: Board = BOARD,
  attention: AttentionItem[] = ATTENTION,
  openBotOnLoad: string | null = null,
  repo = 'all',
  role: 'admin' | 'user' = 'admin',
  more: { dispatching?: boolean; pausedRepos?: Record<string, { by: string; at: string; reason: string | null }> } = {},
): string {
  const header = headerData({
    repos: board.repos,
    repoColors: colorMapOf(board.repositories ?? []),
    crew: CREW,
    budget: { spentUsd: 7.51, capUsd: 1500 },
    needsYou: attention.length,
  });
  return renderToStaticMarkup(
    <RoleProvider role={role}>
      <BoardView
        board={board}
        crew={CREW}
        repo={repo}
        header={header}
        attention={attention}
        now={NOW}
        repoFullName="janedoe/fleetadlc"
        openBotOnLoad={openBotOnLoad}
        {...more}
      />
    </RoleProvider>,
  ).replace(/<!-- -->/g, '');
}

/** One desktop column's markup, by its heading. */
function column(html: string, title: string): string {
  const at = html.indexOf('aria-label="Board"');
  if (at === -1) throw new Error('no board on the page');
  const board = html.slice(at);
  const start = board.indexOf(`>${title}</h2>`);
  if (start === -1) throw new Error(`no column called ${title}`);
  const end = board.indexOf('</section>', start);
  return board.slice(start, end);
}

describe('the board’s columns', () => {
  it('are named for what happens in them, each with a line saying what that is', () => {
    const html = render();
    const board = html.slice(html.indexOf('aria-label="Board"'));
    const titles = [...board.matchAll(/<h2 id="column-[a-z]+"[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1]);
    expect(titles).toEqual(['Intake', 'Design', 'Build', 'Review', 'Ship', 'Done']);
    expect(column(html, 'Design')).toContain('Designs what needs one, remembering what was decided');
    expect(column(html, 'Build')).toContain('Builds it, runs CI locally, opens the pull request');
  });

  it('promise no person in the loop that nothing puts there, and do not read a mode back', () => {
    // A column in assist said "waits for you" over a stage that never waited.
    const html = render();
    for (const title of ['Intake', 'Design', 'Build', 'Review', 'Ship', 'Done']) expect(column(html, title)).not.toContain('waits for you');
    expect(html).not.toMatch(/>(autonomous|conditional|assist)</);
  });

  it('say Ship is skipped where merging ships it, instead of what a deploy would do', () => {
    // fleetadlc-testbed deploys nothing: its Ship said "Deploys what was approved ·
    // waits for you" over a stage that never happens there.
    const shipping = {
      ...BOARD,
      columns: BOARD.columns.map((one) => (one.stage === 'merged' ? { ...one, shipsByMerging: true } : one)),
    };
    const ship = column(render(shipping), 'Ship');
    // Said for one repository or several, capitalised as the other columns are.
    expect(ship).toContain('No testing deploy: merging ships it');
    expect(ship).not.toContain('for this repository');
    expect(ship).not.toContain('Deploys what was approved');
    expect(ship).not.toContain('waits for you');
  });

  it('show who staffs them as faces, with a dot for working or waiting on you', () => {
    const html = render();
    expect(column(html, 'Build')).toContain('title="builder (fleetadlc-atlas-janedoe) · working"');
    expect(column(html, 'Intake')).toContain('title="intake (ottoexampleco) · waiting for you"');
    // Named by role until an account connects, never by its seat.
    expect(column(html, 'Review')).toContain('title="lead reviewer — not connected yet · idle"');
    // Each face is its engine's mark, and a board of them stays still
    // even while one works: only a single large avatar moves.
    expect(column(html, 'Review')).toContain('data-avatar="petals"');
    expect(column(html, 'Build')).not.toContain('avatar-moving');
    expect(html).not.toContain('>lead-reviewer<');
  });

  it('list Done newest first, whatever order the bridge sent', () => {
    // On the live install #7, shipped just now, showed between #5 and #1,
    // shipped hours before: the bridge lists cards in the dispatcher's order.
    const done = [
      card({ ref: 'fleetadlc#3', stage: 'done', title: 'Shipped six hours ago', shippedAt: minutesAgo(360) }),
      card({ ref: 'fleetadlc#5', stage: 'done', title: 'Shipped three hours ago', shippedAt: minutesAgo(180) }),
      card({ ref: 'fleetadlc#7', stage: 'done', title: 'Shipped just now', shippedAt: minutesAgo(1) }),
      card({ ref: 'fleetadlc#1', stage: 'done', title: 'Shipped seven hours ago', shippedAt: minutesAgo(420) }),
    ];
    const html = column(render({ ...BOARD, columns: columns(done) }), 'Done');
    const order = ['#7<', '#5<', '#3<', '#1<'].map((ref) => html.indexOf(ref));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keep a week of Done, and say how many shipped before it', () => {
    const done = column(render(), 'Done');
    expect(done).toContain('1 this week');
    expect(done).toContain('Pin the Node version in CI');
    expect(done).not.toContain('Something from last month');
    expect(done).toContain('and 1 shipped before this week');
  });
});

describe('a card', () => {
  it('says its number, what it has cost, who is on it and what is happening, in words', () => {
    const build = column(render(), 'Build');
    const writing = build.slice(build.indexOf('#16<'), build.indexOf('#17<'));
    expect(writing).toContain('$0.84 so far');
    expect(writing).toContain('Let the board filter by label');
    expect(writing).toContain('>fleetadlc-atlas-janedoe</span>');
    expect(writing).toContain('Writing the change · 12 min');

    const next = build.slice(build.indexOf('#17<'));
    expect(next).toContain('Next up, when the builder (fleetadlc-atlas-janedoe) is free');
  });

  it('ready to build on a bridge without the dispatcher, says nothing is dispatching rather than next up', () => {
    const build = column(render(BOARD, ATTENTION, null, 'all', 'admin', { dispatching: false }), 'Build');
    const ready = build.slice(build.indexOf('#17<'));
    expect(ready).toContain('Waiting: the dispatcher isn’t running');
    expect(ready).not.toContain('Next up');
    // What is being worked on says so still.
    expect(build.slice(build.indexOf('#16<'), build.indexOf('#17<'))).toContain('Writing the change · 12 min');

    const paused = column(
      render(BOARD, ATTENTION, null, 'all', 'admin', { dispatching: false, pausedRepos: { fleetadlc: { by: 'janedoe', at: NOW, reason: null } } }),
      'Build',
    );
    expect(paused.slice(paused.indexOf('#17<'))).toContain('Waiting until fleetadlc is resumed');
  });

  it('puts what needs the person on the card, in the card’s tone', () => {
    const html = render();
    expect(column(html, 'Intake')).toContain('Waiting for your answer');
    expect(column(html, 'Review')).toContain('Stopped after 3 rounds · needs you');
    expect(column(html, 'Review')).toContain('Reviewing · round 2');
    expect(column(html, 'Done')).toContain('Shipped 2 hours ago');
  });

  it('keeps a way to move it that a keyboard can use', () => {
    const intake = column(render(), 'Intake');
    expect(intake).toContain('Move fleetadlc#15 out of Intake');
    expect(intake).toMatch(/<option value="spec">Design<\/option>/);
  });

  it('offers a user no way to move it, by drag or by list: moving a card is an admin’s', () => {
    const html = render(BOARD, ATTENTION, null, 'all', 'user');
    expect(column(html, 'Intake')).toContain('Waiting for your answer');
    expect(html).not.toContain('Move fleetadlc#15 out of Intake');
    expect(html).not.toContain('draggable="true"');
    expect(render()).toContain('draggable="true"');
  });
});

describe('a request intake is working on', () => {
  // On the live install Intake said 0, "Nothing waiting for intake", while
  // the intake bot asked three questions and wrote the snake game up.
  const asking = card({
    ref: 'request:57796b82',
    stage: 'intake',
    title: 'Add a keyboard-controlled snake game at snake.html',
    request: true,
    url: null,
    number: undefined,
    gateOpen: true,
    costUsd: 0.41,
    active: [{ bot: 'ottoexampleco', kind: 'intake', state: 'paused', round: 0, startedAt: minutesAgo(3), endedAt: null, exitReason: null }],
  });
  const board = (cards: BoardCard[]): Board => ({ ...BOARD, columns: columns(cards) });

  it('is counted in Intake, says it is a request and what it waits on, and has nothing to move', () => {
    const intake = column(render(board([asking])), 'Intake');

    expect(intake).toMatch(/>Intake<\/h2><span[^>]*>1<\/span>/);
    expect(intake).toContain('>Request<');
    expect(intake).toContain('Add a keyboard-controlled snake game at snake.html');
    expect(intake).toContain('Waiting for your answer');
    expect(intake).toContain('$0.41<');
    expect(intake).not.toContain('NaN');
    expect(intake).not.toContain('Move request:57796b82');
    expect(intake).not.toContain('draggable="true"');
  });

  it('says it is being written up while intake works on it', () => {
    const writing = { ...asking, gateOpen: false, active: [{ ...asking.active![0]!, state: 'running' as const }] };
    expect(column(render(board([writing])), 'Intake')).toContain('Shaping the issue · 3 min');
  });

  it('keeps the board from reading as a first run, since the first request is under way', () => {
    const html = render(board([asking]), []);
    expect(html).toContain('aria-label="Board"');
  });
});

describe('what needs you', () => {
  it('sits above the board with each thing and what to do about it', () => {
    const html = render();
    const needs = html.slice(html.indexOf('id="needs"'), html.indexOf('aria-label="Board"'));
    expect(needs).toContain('Needs you');
    expect(needs).toContain('ottoexampleco has a question');
    // Two lines of it on the card; the whole of it, formatted, is in its sheet.
    expect(needs).toMatch(/<p data-clamp="detail" class="[^"]*line-clamp-2[^"]*">Should the cost include review rounds, or only the build\?<\/p>/);
    expect(needs).toMatch(/<button[^>]*>Answer<\/button>/);
  });

  it('is absent when nothing is waiting, and the header says so', () => {
    const html = render(BOARD, []);
    expect(html).not.toContain('id="needs"');
    expect(html).toContain('Nothing needs you');
  });
});

describe('the first run', () => {
  const EMPTY: Board = { ...BOARD, columns: columns([]) };

  it('offers the first request instead of six empty columns', () => {
    const html = render(EMPTY, []);
    expect(html).not.toContain('aria-label="Board"');
    expect(html).toContain('File your first request');
    expect(html).toContain('href="https://github.com/janedoe/fleetadlc/issues/new"');
    expect(html).toContain('How a request moves');
  });

  it('says the crew is ready only when every bot can act, and which ones cannot', () => {
    const html = render(EMPTY, []);
    expect(html).toContain('Finish setting up your crew');
    expect(html).toContain('4 of 5 bots connected');
    expect(html).toContain('href="/onboarding?step=github-accounts"');

    const connected = CREW.map((bot) => ({ ...bot, githubLogin: bot.name === 'lead-reviewer' ? 'noraexampleco' : bot.githubLogin, name: bot.name === 'lead-reviewer' ? 'noraexampleco' : bot.name, authorization: 'active' }));
    const ready = renderToStaticMarkup(
      <BoardView
        board={EMPTY}
        crew={connected}
        repo="all"
        header={headerData({ repos: ['fleetadlc'], crew: connected, budget: null, needsYou: 0 })}
        now={NOW}
      />,
    ).replace(/<!-- -->/g, '');
    expect(ready).toContain('Your crew is ready');
    expect(ready).toContain('5 bots connected to GitHub');
  });

  it('shows each stage with who does it', () => {
    const html = render(EMPTY, []);
    const flow = html.slice(html.indexOf('How a request moves'));
    expect(flow).not.toContain('waits for your OK');
    expect(flow).toContain('2 reviewers');
    expect(flow).toContain('Nobody needed');
  });

  it('still says what needs you, when the first request is what failed', () => {
    const failed: AttentionItem = {
      id: 'request:r-1',
      kind: 'triage_failed',
      headline: 'ottoexampleco could not triage your request',
      subject: { repo: 'fleetadlc', number: null, title: 'Create html hello world', ref: null, url: null },
      bot: null,
      since: minutesAgo(3),
      detail: 'Engine claude is not available on this host, so triage cannot run.',
      actions: [{ kind: 'retry_triage', label: 'Try again', requestId: 'r-1' }],
    };
    const html = render(EMPTY, [failed]);
    expect(html).toContain('id="needs"');
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toContain('File your first request');
  });
});

describe('the board on a phone', () => {
  it('switches stages with a row of pills and their counts, instead of scrolling sideways', () => {
    const html = render();
    const phone = html.slice(html.indexOf('aria-label="Stage"'));
    const pills = [...phone.matchAll(/aria-pressed="(true|false)"[^>]*>([A-Za-z]+)<span[^>]*>(\d+)<\/span>/g)].map(
      (match) => `${match[2]} ${match[3]}${match[1] === 'true' ? ' *' : ''}`,
    );
    expect(pills).toEqual(['Intake 1 *', 'Design 0', 'Build 2', 'Review 2', 'Ship 0', 'Done 1']);
  });

  it('has its navigation at the bottom, in reach of a thumb', () => {
    const html = render();
    const nav = html.slice(html.lastIndexOf('<nav aria-label="Console"'));
    expect(nav).toMatch(/^<nav aria-label="Console" class="[^"]*md:hidden/);
    for (const label of ['Board', 'Crew', 'Costs', 'Settings']) expect(nav).toContain(`${label}</a>`);
  });
});

describe('the board’s place on the page', () => {
  it('puts nothing in a fixed position while no thread is open', () => {
    // A fixed element sits over whatever scrolls under it. The thread panel is
    // the one that is allowed to, and it is only there when it is opened.
    expect(render()).not.toMatch(/class="[^"]*\bfixed\b/);
    const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/\bfixed\b/);
  });

  it('has no strip of bots along the bottom: the Crew page is where the crew is', () => {
    expect(render()).not.toContain('<footer');
  });

  it('opens a thread a link names by the seat the bot has since left, under the name it has now', () => {
    const renamed = CREW.map((bot) => (bot.slot === 'second-reviewer' ? { ...bot, name: 'irisexampleco-2' } : bot));
    const html = renderToStaticMarkup(
      <BoardView
        board={BOARD}
        crew={renamed}
        repo="all"
        header={headerData({ repos: ['fleetadlc'], crew: renamed, budget: null, needsYou: null })}
        now={NOW}
        openBotOnLoad="second-reviewer"
      />,
    ).replace(/<!-- -->/g, '');
    const panel = html.slice(html.lastIndexOf('<h2'));
    expect(panel).toMatch(/^<h2[^>]*>irisexampleco-2<\/h2>/);
    expect(panel).toContain('Second reviewer');
  });

  it('opens a thread for a bot a link names by its current name', () => {
    const html = render(BOARD, ATTENTION, CREW[0]!.name);
    expect(html).toMatch(/class="[^"]*\bfixed\b/);
    expect(html.slice(html.lastIndexOf('<h2'))).toMatch(new RegExp(`^<h2[^>]*>${CREW[0]!.name}</h2>`));
  });

  it('opens no thread for a name that is no bot, so it never reaches a bridge path', () => {
    // A crafted `?bot=` was once opened as it stood, and the panel's "stop all
    // its work" sent POST /v1/repos/web/remove as the admin who pressed it.
    const html = render(BOARD, ATTENTION, 'x/../../repos/web/remove?');
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
    expect(html).not.toContain('repos/web/remove');
  });
});

describe('every repository at once', () => {
  const REPOSITORIES = [
    { name: 'fleetadlc', fullName: 'janedoe/fleetadlc', color: 'blue' },
    { name: 'api', fullName: 'janedoe/api', color: 'amber' },
    { name: 'website', fullName: 'janedoe/website', color: 'pink' },
  ];
  const CARDS: BoardCard[] = [
    ...WORKING,
    card({ ref: 'api#3', repo: 'api', stage: 'build', title: 'Page the list of runs' }),
    card({ ref: 'website#8', repo: 'website', stage: 'review', title: 'Say what a plan costs', prNumber: 9 }),
  ];
  const ALL: Board = { ...BOARD, repos: REPOSITORIES.map((one) => one.name), repositories: REPOSITORIES, columns: columns(CARDS) };
  const FROM_API: AttentionItem = {
    ...ATTENTION[0]!,
    id: 'gate:gate-2',
    headline: 'fleetadlc-atlas-janedoe has a question',
    subject: { repo: 'api', number: 3, title: 'Page the list of runs', ref: 'api#3', url: null },
  };

  /** Each desktop card's repository, as its edge and its badge say it, and its number. */
  function cards(html: string): string[] {
    const board = html.slice(html.indexOf('aria-label="Board"'), html.indexOf('aria-label="Stage"'));
    return [...board.matchAll(/<article[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/article>/g)].map((match) => {
      const edge = /border-l-repo-([a-z]+)/.exec(match[1]!)?.[1] ?? 'no edge';
      const badge = /<span title="([^"]+)" class="[^"]*rounded-full[^"]*"><span aria-hidden="true" class="[^"]*bg-repo-([a-z]+)[^"]*"><\/span><span class="truncate">([^<]+)<\/span><\/span>/.exec(
        match[2]!,
      );
      const number = /(#\d+)</.exec(match[2]!)?.[1];
      return `${edge} ${badge ? `${badge[3]}(${badge[2]})` : 'no badge'} ${number}`;
    });
  }

  it('gives each card its repository’s colour down its edge, and its name and colour as a badge', () => {
    const shown = cards(render(ALL));
    expect(shown).toContain('amber api(amber) #3');
    expect(shown).toContain('pink website(pink) #8');
    expect(shown).toContain('blue fleetadlc(blue) #16');
    // The badge says the repository, so the number no longer does.
    expect(render(ALL)).not.toMatch(/>fleetadlc#16</);
  });

  it('leaves the badge its room, with the move list over the end of the row while it shows', () => {
    // A column is 12.5rem: a badge, the number, the move list and the cost do
    // not fit in one row of it, and the move list only shows on hover.
    const moveList = (html: string) => /<label [^>]*class="([^"]*)"><span class="sr-only">Move fleetadlc#16 /.exec(html)?.[1] ?? '';
    expect(moveList(render(ALL))).toContain('reveal-over');
    expect(moveList(render(ALL))).not.toContain('ml-auto');
    expect(moveList(render())).toContain('ml-auto');
    expect(moveList(render())).not.toContain('reveal-over');
  });

  it('says which colour is which above the board, each a link to that repository alone', () => {
    const html = render(ALL);
    const legend = /<ul aria-label="Repositories on the board"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    const entries = [...legend.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, entry]) => {
      const href = /href="([^"]+)"/.exec(entry!)?.[1]?.replace(/&amp;/g, '&');
      const title = /title="Show only ([^"]+)"/.exec(entry!)?.[1];
      const [, color, name] = /bg-repo-([a-z]+)[^"]*"><\/span>([^<]+)</.exec(entry!) ?? [];
      return `${name} ${color} ${href} (${title})`;
    });
    expect(entries).toEqual([
      'fleetadlc blue /?board=1&repo=fleetadlc (janedoe/fleetadlc)',
      'api amber /?board=1&repo=api (janedoe/api)',
      'website pink /?board=1&repo=website (janedoe/website)',
    ]);
    expect(html.indexOf('aria-label="Repositories on the board"')).toBeLessThan(html.indexOf('aria-label="Board"'));
  });

  it('marks what needs you with the repository it is in', () => {
    const html = render(ALL, [FROM_API]);
    const needs = html.slice(html.indexOf('id="needs"'), html.indexOf('aria-label="Board"'));
    expect(needs).toMatch(/<h3[^>]*>fleetadlc-atlas-janedoe has a question<\/h3><span title="api"[^>]*><span aria-hidden="true" class="[^"]*bg-repo-amber/);
  });

  it('keeps the badge on a phone’s cards, where there is no room for the legend', () => {
    const html = render(ALL);
    const phone = html.slice(html.indexOf('aria-label="Stage"'));
    // The phone opens on Intake, where fleetadlc#15 is.
    expect(phone).toMatch(/<span title="fleetadlc"[^>]*><span aria-hidden="true" class="[^"]*bg-repo-blue[^"]*"><\/span><span class="truncate">fleetadlc<\/span>/);
    expect(html).toMatch(/<div class="hidden [^"]*md:flex"><span class="text-\[12px\] text-dim">Every repository:/);
  });

  it('names the repository of what needs you from another one, when the board shows one', () => {
    // What needs you is everything, whichever board is on screen; #15 alone
    // would read as this repository's.
    const one: Board = { ...ALL, repo: 'api', columns: columns(CARDS.filter((entry) => entry.repo === 'api')) };
    const needs = (html: string) => html.slice(html.indexOf('id="needs"'), html.indexOf('aria-label="Board"'));
    const html = render(one, [FROM_API, ATTENTION[0]!], null, 'api');
    const badges = [...needs(html).matchAll(/<\/h3><span title="([^"]+)"/g)].map((match) => match[1]);
    expect(badges).toEqual(['fleetadlc']);
  });

  it('says none of it when the board shows one repository, whatever else OpenADLC works in', () => {
    const one: Board = { ...ALL, repo: 'api', columns: columns(CARDS.filter((entry) => entry.repo === 'api')) };
    const html = render(one, [FROM_API], null, 'api');
    expect(cards(html)).toEqual(['no edge no badge #3']);
    expect(html).not.toContain('Repositories on the board');
    // The header still says which repository this is; nothing below it has to.
    const page = html.slice(html.indexOf('<main'));
    expect(page).not.toMatch(/bg-repo-[a-z]+[^"]*"><\/span><span class="truncate">/);
  });

  it('says none of it with only one repository to show', () => {
    const html = render();
    expect(cards(html).every((entry) => entry.startsWith('no edge no badge'))).toBe(true);
    expect(html).not.toContain('Repositories on the board');
  });

  it('offers the first request with a way to file it on GitHub in each repository', () => {
    // No one repository is the page's, so there is no one to file in.
    const empty: Board = { ...ALL, columns: columns([]) };
    const html = renderToStaticMarkup(
      <BoardView
        board={empty}
        crew={CREW}
        repo="all"
        header={headerData({ repos: empty.repos, repoColors: colorMapOf(REPOSITORIES), crew: CREW, budget: null, needsYou: 0 })}
        now={NOW}
        repoFullName={null}
      />,
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('File your first request');
    const links = [
      ...html.matchAll(/href="https:\/\/github.com\/([^"]+)\/issues\/new"[^>]*><span aria-hidden="true" class="[^"]*bg-repo-([a-z]+)/g),
    ].map((match) => `${match[1]} ${match[2]}`);
    expect(links).toEqual(['janedoe/fleetadlc blue', 'janedoe/api amber', 'janedoe/website pink']);
  });
});

describe('a board while work is paused', () => {
  it('says so above everything, who paused it and why, with where to resume', () => {
    const header = headerData({ repos: BOARD.repos, crew: CREW, budget: null, needsYou: 0 });
    const html = renderToStaticMarkup(
      <BoardView
        board={BOARD}
        crew={CREW}
        repo="all"
        header={header}
        attention={[]}
        now={NOW}
        paused={{ by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'an account may be compromised' }}
      />,
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('Work is paused.');
    expect(html).toContain('Paused by janedoe at 2026-09-29 10:00 UTC: an account may be compromised.');
    expect(html).toMatch(/<a [^>]*href="\/settings#pause"[^>]*>Resume in Settings<\/a>/);
    expect(render()).not.toContain('Work is paused.');
  });
});

describe('a board while some repositories are paused', () => {
  const PAUSE = { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'a migration is running' };
  const header = () => headerData({ repos: BOARD.repos, crew: CREW, budget: null, needsYou: 0 });
  const html = (repo: string, pausedRepos: Record<string, typeof PAUSE>) =>
    renderToStaticMarkup(
      <BoardView board={BOARD} crew={CREW} repo={repo} header={header()} attention={[]} now={NOW} pausedRepos={pausedRepos} />,
    ).replace(/<!-- -->/g, '');

  it('names them above the board, with where to resume, and says who paused one alone', () => {
    const both = html('all', { api: PAUSE, web: PAUSE });
    expect(both).toContain('Work is paused in api and web.');
    expect(both).not.toContain('Work is paused.');
    expect(both).toMatch(/Work is paused in api and web\.<\/span> Nothing new starts there[^<]*<a [^>]*href="\/settings#pause"[^>]*>Resume in Settings<\/a>/);

    expect(html('all', { api: PAUSE })).toContain('Work is paused in api.</span> Paused by janedoe at 2026-09-29 10:00 UTC: a migration is running.');
  });

  it('tells a user an admin resumes it, with no link to the Settings they cannot open', () => {
    const asUser = renderToStaticMarkup(
      <RoleProvider role="user">
        <BoardView board={BOARD} crew={CREW} repo="all" header={header()} attention={[]} now={NOW} pausedRepos={{ api: PAUSE }} />
      </RoleProvider>,
    ).replace(/<!-- -->/g, '');
    expect(asUser).toContain('Work is paused in api.');
    expect(asUser).toContain('An admin resumes it in Settings.');
    expect(asUser).not.toContain('href="/settings#pause"');

    const asAdmin = renderToStaticMarkup(
      <RoleProvider role="admin">
        <BoardView board={BOARD} crew={CREW} repo="all" header={header()} attention={[]} now={NOW} pausedRepos={{ api: PAUSE }} />
      </RoleProvider>,
    );
    expect(asAdmin).toMatch(/<a [^>]*href="\/settings#pause"[^>]*>Resume in Settings<\/a>/);
  });

  it('says so on a board filtered to one repository only when that one is paused', () => {
    expect(html('api', { api: PAUSE })).toContain('Work is paused in api.');
    expect(html('web', { api: PAUSE })).not.toContain('Work is paused');
  });

  it('marks each paused repository where the board names it', () => {
    const two = { ...BOARD, repos: ['fleetadlc', 'web'], repositories: [{ name: 'fleetadlc', color: 'blue' }, { name: 'web', color: null }] } as Board;
    const render = (pausedRepos: Record<string, typeof PAUSE>) =>
      renderToStaticMarkup(<BoardView board={two} crew={CREW} repo="all" header={header()} attention={[]} now={NOW} pausedRepos={pausedRepos} />);
    const legend = (markup: string) => markup.slice(markup.indexOf('aria-label="Repositories on the board"'));
    expect(legend(render({ web: PAUSE }))).toMatch(/web<span[^>]*>paused<\/span>/);
    expect(legend(render({ web: PAUSE }))).not.toMatch(/fleetadlc<span[^>]*>paused<\/span>/);
    expect(render({})).not.toMatch(/>paused<\/span>/);
  });
});

describe('an issue’s own controls on its card', () => {
  const REQUEST = card({ ref: 'request:abcd1234', stage: 'intake', title: 'Make a sound recorder', request: true, requestState: 'working', url: null });
  const one = (cards: BoardCard[]) => ({ ...BOARD, columns: columns(cards) });

  it('offers an admin pause, play next and cancel on each issue, and nothing on a request', () => {
    const html = render(one([card({ ref: 'fleetadlc#17', stage: 'build', title: 'Show each bot’s model on its card' }), REQUEST]));
    expect(html).toContain('aria-label="Pause #17"');
    expect(html).toContain('aria-label="Do #17 next"');
    expect(html).toContain('aria-label="Cancel #17"');
    // A request has no issue to hold, queue or close until intake files it.
    expect(html.match(/data-issue-controls/g)).toHaveLength(1);
  });

  it('shows its controls always, on their own row beside its status, as line icons rather than emoji', () => {
    // On hover in the top row they crowded the repository, number and cost.
    const html = render(one([card({ ref: 'fleetadlc#17', stage: 'build', title: 'Show each bot’s model' })]));
    expect(html).not.toMatch(/⏯|⏭|✕/);
    expect(html).toMatch(/data-status[\s\S]*data-issue-controls/);
    expect(html).not.toMatch(/class="[^"]*reveal[^"]*"[^>]*>\s*<span data-issue-controls/);
  });

  it('offers nothing on finished work', () => {
    // On a Done card there is nothing left to pause, put next or cancel.
    const html = render(one([card({ ref: 'fleetadlc#18', stage: 'done', title: 'Shipped' }), card({ ref: 'fleetadlc#19', stage: 'merged', title: 'Merged' })]));
    expect(html).not.toContain('data-issue-controls');
  });

  it('offers nothing to someone who is not an admin', () => {
    const html = render(one([card({ ref: 'fleetadlc#17', stage: 'build', title: 'Show each bot’s model on its card' })]), [], null, 'all', 'user');
    expect(html).not.toContain('data-issue-controls');
  });

  it('says who paused a card, and why on hover, and offers to resume it', () => {
    const held = card({ ref: 'fleetadlc#17', stage: 'build', title: 'Held', held: { by: 'janedoe', at: minutesAgo(3), why: 'waiting on the design' } });
    const html = render(one([held]));
    expect(html).toContain('title="Paused by janedoe: waiting on the design"');
    expect(html).toContain('Paused · janedoe');
    expect(html).toContain('aria-label="Resume #17"');
  });

  it('says a card put first is next up', () => {
    const html = render(one([card({ ref: 'fleetadlc#17', stage: 'build', title: 'First', next: true })]));
    expect(html).toMatch(/data-next[^>]*>.*Next up<\/span>/);
    expect(html).toMatch(/aria-label="Take #17 out of the front of the queue"[^>]*aria-pressed="true"/);
  });
});

describe('who is on a card', () => {
  it('names the roles once where seats share one account, and the handle once', () => {
    // Two reviewers on one account were "fleet-cipher-janedoe, fleet-cipher-janedoe".
    const crew = [
      member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'fleet-cipher-janedoe' }),
      member({ name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'fleet-cipher-janedoe' }),
    ];
    const labels = ['lead-reviewer', 'second-reviewer'].map((name) => labelIn(crew, name));
    expect(peopleLine(labels)).toBe('lead reviewer, second reviewer · fleet-cipher-janedoe');
  });

  it('says so on the card', () => {
    // Seats on one account keep their seats' names; the handle is the account's.
    const crew = [
      member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'fleet-cipher-janedoe' }),
      member({ name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'fleet-cipher-janedoe' }),
    ];
    const running = (bot: string) => ({ bot, kind: 'review', state: 'running', round: 1, startedAt: minutesAgo(3), endedAt: null, exitReason: null });
    const board: Board = {
      ...BOARD,
      columns: columns([card({ ref: 'fleetadlc#40', stage: 'review', title: 'Two reviewers on one account', active: [running('lead-reviewer'), running('second-reviewer')] })]),
    };
    const header = headerData({ repos: board.repos, crew, budget: null, needsYou: 0 });
    const html = renderToStaticMarkup(
      <RoleProvider role="admin">
        <BoardView board={board} crew={crew} repo="all" header={header} attention={[]} now={NOW} />
      </RoleProvider>,
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('lead reviewer, second reviewer · fleet-cipher-janedoe');
    expect(html).not.toContain('fleet-cipher-janedoe, fleet-cipher-janedoe');
  });

  it('keeps each handle where every seat has its own', () => {
    const labels = ['fleetadlc-atlas-janedoe', 'irisexampleco'].map((name) => labelIn(CREW, name));
    expect(peopleLine(labels)).toBe('fleetadlc-atlas-janedoe, irisexampleco');
  });
});
