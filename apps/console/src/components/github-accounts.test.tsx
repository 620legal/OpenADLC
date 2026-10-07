// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, GitHubAccountsView } from '@/lib/api';
import { CrewTable } from './github-accounts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/app/actions', () => ({ addSeat: vi.fn(), removeSeat: vi.fn() }));

const member = (name: string, slot: string, role: string, displayName: string): CrewMember => ({
  name,
  slot,
  displayName,
  role,
  engine: 'claude',
  model: 'claude-sonnet-5',
  status: 'running',
  container: `bot-${name}`,
  githubLogin: null,
  authorization: 'unauthorized',
  tokenExpiresAt: null,
  now: 'nothing running',
  paused: false,
  sessions: [],
});

/** Settings → Crew, where a running install gets a second builder and loses it again. */
describe('adding and removing a builder in the crew table', () => {
  const crew = [
    member('fleetadlc-atlas-janedoe', 'builder', 'implement', 'Builder'),
    member('builder-2', 'builder-2', 'implement', 'Builder'),
    member('lead-reviewer', 'lead-reviewer', 'review_lead', 'Lead reviewer'),
  ];

  it('offers "Add a builder" with the crew account’s seats, not the reviewers’', () => {
    const html = renderToStaticMarkup(<CrewTable crew={crew} />);
    expect(html.match(/Add a builder/g)).toHaveLength(1);
    expect(html.indexOf('Add a builder')).toBeLessThan(html.indexOf('Reviewer account'));
  });

  it('names an added seat on its row, since two rows reading “Builder” say nothing, and offers to remove only that one', () => {
    const html = renderToStaticMarkup(<CrewTable crew={crew} />);
    expect(html).toContain(' · builder-2');
    expect(html.match(/>Remove</g)).toHaveLength(1);
  });
});

/**
 * Choosing another GitHub account for a seat that is on one: a misclick used
 * to post at once and take a busy bot's credential from its work.
 */
describe('moving a seat in the crew table', () => {
  let root: Root;
  let container: HTMLElement;
  let posted: { bot: string; login: string | null }[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    posted = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/github/accounts/assign') {
          posted.push(JSON.parse(String(init?.body)));
          return Response.json({ error: 'builder has a task that has not ended; stop it or let it finish, then move it' }, { status: 409 });
        }
        return Response.json({});
      }),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  const crew = [member('builder', 'builder', 'implement', 'Builder'), member('qa', 'qa', 'qa', 'QA')];
  const github: GitHubAccountsView = {
    accounts: [],
    bots: [
      {
        name: 'builder',
        slot: 'builder',
        role: 'implement',
        roleLabel: 'builder',
        group: 'crew',
        login: 'exampleco-crew',
        choices: [
          { login: 'exampleco-crew', refusal: null },
          { login: 'exampleco-spare', refusal: null },
        ],
      },
      {
        name: 'qa',
        slot: 'qa',
        role: 'qa',
        roleLabel: 'QA',
        group: 'crew',
        login: null,
        choices: [{ login: 'exampleco-crew', refusal: null }],
      },
    ],
  };

  const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="GitHub account for the ${label}"]`)!;
  const button = (text: string) => [...container.querySelectorAll('button')].find((one) => one.textContent === text);
  async function pick(label: string, value: string): Promise<void> {
    await act(async () => {
      const element = select(label);
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  async function click(text: string): Promise<void> {
    await act(async () => button(text)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  it.each([
    ['Not connected', '', 'Take it off exampleco-crew?', null],
    ['another account', 'exampleco-spare', 'Move it from exampleco-crew to exampleco-spare?', 'exampleco-spare'],
  ])('asks before taking a connected seat to %s, posts on Confirm, and shows the bridge’s refusal', async (_what, value, question, login) => {
    await act(async () => root.render(<CrewTable crew={crew} github={github} />));

    await pick('builder', value);
    expect(posted).toEqual([]);
    expect(container.textContent).toContain(question);

    await click('Confirm');
    expect(posted).toEqual([{ bot: 'builder', login }]);
    expect(container.textContent).toContain('then move it');
  });

  it('puts the select back on Cancel and posts nothing', async () => {
    await act(async () => root.render(<CrewTable crew={crew} github={github} />));

    await pick('builder', '');
    await click('Cancel');

    expect(posted).toEqual([]);
    expect(button('Confirm')).toBeUndefined();
    expect(select('builder').value).toBe('exampleco-crew');
  });

  it('puts a seat on no account onto one at once', async () => {
    await act(async () => root.render(<CrewTable crew={crew} github={github} />));

    await pick('QA', 'exampleco-crew');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(posted).toEqual([{ bot: 'qa', login: 'exampleco-crew' }]);
    expect(button('Confirm')).toBeUndefined();
  });
});
