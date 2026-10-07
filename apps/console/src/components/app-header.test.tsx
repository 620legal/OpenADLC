import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader, AppShell } from './app-header';

// What keeps a page current runs only in a browser; here it only has to be there.
vi.mock('@/components/live-refresh', () => ({ LiveRefresh: () => <meta name="live-refresh" /> }));
import type { CrewMember } from '@/lib/api';
import { headerData, type Page } from '@/lib/header';

function member(partial: Partial<CrewMember> & Pick<CrewMember, 'name'>): CrewMember {
  return {
    slot: 'builder',
    displayName: partial.name,
    role: 'implement',
    engine: 'claude',
    model: 'newest:opus',
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
  member({ name: 'fleetadlc-atlas-janedoe', task: { kind: 'implement', state: 'running', subjectRef: 'fleetadlc#16', issue: null, startedAt: null, endedAt: null, round: null, waitingOnYou: false } }),
  member({ name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second' }),
  member({ name: 'ottoexampleco', slot: 'intake', role: 'intake' }),
];

function header(page: Page, overrides: Partial<Parameters<typeof headerData>[0]> = {}): string {
  const data = headerData({ repos: ['fleetadlc-testbed'], crew: CREW, budget: { spentUsd: 7.51, capUsd: 1500 }, needsYou: 3, ...overrides });
  return renderToStaticMarkup(<AppHeader page={page} data={data} />).replace(/<!-- -->/g, '');
}

/** The wide header, which is the first of the two. */
function wide(html: string): string {
  return html.slice(0, html.indexOf('</header>'));
}

describe('the header', () => {
  it('names the four places, and marks the one you are on', () => {
    for (const page of ['board', 'crew', 'costs', 'settings'] as const) {
      const html = wide(header(page));
      const links = [...html.matchAll(/<a ([^>]*)>(Board|Crew|Costs|Settings)<\/a>/g)].map(
        (match) => `${match[2]} ${/href="([^"]+)"/.exec(match[1]!)?.[1]}${match[1]!.includes('aria-current="page"') ? ' *' : ''}`,
      );
      expect(links).toEqual([
        `Board /?board=1${page === 'board' ? ' *' : ''}`,
        `Crew /crew${page === 'crew' ? ' *' : ''}`,
        `Costs /costs${page === 'costs' ? ' *' : ''}`,
        `Settings /settings${page === 'settings' ? ' *' : ''}`,
      ]);
    }
  });

  it('says who is working, what the month has cost against its cap, and what needs you', () => {
    const html = wide(header('crew'));
    expect(html).toContain('1 working · 2 idle');
    expect(html).toContain('$7.51 of $1,500');
    // From every page, the count leads to the page that lists them all.
    expect(html).toMatch(/<a [^>]*href="\/needs-you"[^>]*>3 need you<\/a>/);
    expect(wide(header('board'))).toMatch(/<a [^>]*href="\/needs-you"[^>]*>3 need you<\/a>/);
    expect(html).toMatch(/<button[^>]*>.*New request<\/button>/);
  });

  it('says the crew is ready when nothing is working, and that nothing needs you when nothing does', () => {
    const resting = CREW.map((bot) => ({ ...bot, task: null }));
    const html = wide(header('board', { crew: resting, needsYou: 0 }));
    expect(html).toContain('3 ready');
    expect(html).toContain('Nothing needs you');
    expect(html).not.toContain('need you</a>');
    // Still the way to the Needs you page, where what recovered is listed.
    expect(html).toMatch(/<a[^>]*href="\/needs-you"[^>]*>Nothing needs you<\/a>/);
  });

  it('says a month with nothing spent as $0, not $0.00', () => {
    expect(wide(header('board', { budget: { spentUsd: 0, capUsd: 1500 } }))).toContain('$0 of $1,500');
  });

  it('leaves out what it could not read, rather than guessing', () => {
    const html = wide(header('board', { budget: null, needsYou: null }));
    expect(html).not.toContain(' of $');
    expect(html).not.toContain('needs you');
  });

  it('says nothing of the platform’s internals, and keeps the colour mode in settings', () => {
    const html = header('board');
    for (const internal of ['system of record', 'host local', 'running unattended', 'docker']) expect(html).not.toContain(internal);
    expect(html).not.toContain('aria-label="Color mode"');
  });

  it('gives a phone two rows with touch-sized controls', () => {
    const html = header('board');
    const phone = html.slice(html.indexOf('</header>'));
    expect(phone).toMatch(/<header class="[^"]*md:hidden/);
    expect(phone).toMatch(/<button[^>]*class="[^"]*h-11[^"]*"[^>]*>.*New<\/button>/);
    expect(phone).toContain('1 working · 2 idle');
  });
});

describe('every page under the header', () => {
  it('is kept current while it is on screen, so what needs you shows without a reload', () => {
    const data = headerData({ repos: ['fleetadlc-testbed'], crew: CREW, budget: null, needsYou: 1 });
    for (const page of ['board', 'crew', 'costs', 'settings'] as const) {
      const html = renderToStaticMarkup(
        <AppShell page={page} data={data}>
          <p>page</p>
        </AppShell>,
      );
      expect(html).toContain('<meta name="live-refresh"/>');
    }
  });
});

describe('the repository switcher', () => {
  const COLORS = { api: 'amber', 'fleetadlc-testbed': 'blue', website: 'pink' };

  function switcher(repo: string, repos = ['api', 'fleetadlc-testbed', 'website']): string {
    const data = headerData({ repos, repoColors: COLORS, crew: CREW, budget: null, needsYou: null });
    return wide(renderToStaticMarkup(<AppHeader page="board" repo={repo} data={data} />).replace(/<!-- -->/g, ''));
  }

  /** The list it opens: each entry's colour, name and whether it is the board on screen. */
  function entries(html: string): string[] {
    const list = /<ul[^>]*aria-label="Repositories"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, entry]) => {
      const colours = [...entry!.matchAll(/bg-repo-([a-z]+)/g)].map((match) => match[1]).join('+');
      const label = /<span class="min-w-0 flex-1 truncate">([^<]+)<\/span>/.exec(entry!)?.[1];
      return `${colours} ${label}${entry!.includes('aria-current="page"') ? ' *' : ''}`;
    });
  }

  it('offers every repository at once whenever there is more than one, each with its colour', () => {
    expect(entries(switcher('all'))).toEqual(['amber+blue+pink All repositories *', 'amber api', 'blue fleetadlc-testbed', 'pink website']);
  });

  it('says the repository on screen, by its colour and its name', () => {
    const html = switcher('website');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*><span class="sr-only">Repository: <\/span><span aria-hidden="true" class="[^"]*bg-repo-pink[^"]*"><\/span><span class="truncate">website<\/span>/);
    expect(entries(html)).toContain('pink website *');
  });

  it('is closed until it is opened, and links to each board', () => {
    const html = switcher('all');
    expect(html).toMatch(/<ul id="[^"]+" hidden=""/);
    expect(html).toContain('href="/?board=1&amp;repo=api"');
    expect(html).not.toContain('<select');
  });

  it('is just the name when there is only one repository', () => {
    const html = switcher('all', ['fleetadlc-testbed']);
    expect(html).not.toContain('All repositories');
    expect(html).toMatch(/<span class="[^"]*">fleetadlc-testbed<\/span>/);
  });
});

describe('the header’s count of what needs you', () => {
  it('says work and system apart, so a dozen health checks do not read as questions', async () => {
    const { needsLine } = await import('./app-header');
    expect(needsLine(13, { work: 3, system: 10 })).toBe('3 need you · 10 system');
    expect(needsLine(10, { work: 0, system: 10 })).toBe('10 system');
    expect(needsLine(3, { work: 3, system: 0 })).toBe('3 need you');
    expect(needsLine(3, null)).toBe('3 need you');
  });
});
