// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember } from '@/lib/api';
import { headerData } from '@/lib/header';
import { CREW_LAYOUT_KEY } from '@/lib/crew';

const actions = vi.hoisted(() => ({
  pauseSeat: vi.fn(async () => ({ ok: true })),
  resumeSeat: vi.fn(async () => ({ ok: true })),
  setCrewTasksAtOnce: vi.fn(async () => ({ ok: true })),
  setCrewAvatar: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/app/actions', () => actions);

// The panel itself is tested where it lives; here, only which seat and tab it opens on.
vi.mock('@/components/thread-panel', () => ({
  ThreadPanel: ({ bot, initialTab, extraTabs }: { bot: string; initialTab: string; extraTabs: { label: string }[] }) => (
    <aside data-panel={bot} data-tab={initialTab}>
      {extraTabs.map((tab) => tab.label).join(',')}
    </aside>
  ),
}));

// The header reads the install; the page is what is under test.
vi.mock('@/components/app-header', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useRole: () => 'admin',
}));

const NOW = '2026-09-24T12:00:00.000Z';

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
    modelAccountId: 'max',
    task: null,
    lastTask: null,
    ...partial,
  };
}

const CREW = [
  member({ name: 'builder-acme' }),
  member({
    name: 'intake-acme',
    slot: 'intake',
    role: 'intake',
    task: { subjectRef: 'request:a4b02784', issue: null, kind: 'intake', state: 'running', startedAt: NOW, endedAt: null, round: null, waitingOnYou: false },
  }),
];

/** A browser's storage, kept in memory: Node 25's own `localStorage` global shadows happy-dom's and has no file to keep it in. */
function memoryStorage(): Storage {
  const kept = new Map<string, string>();
  return {
    get length() {
      return kept.size;
    },
    clear: () => kept.clear(),
    getItem: (key) => kept.get(key) ?? null,
    key: (index) => [...kept.keys()][index] ?? null,
    removeItem: (key) => void kept.delete(key),
    setItem: (key, value) => void kept.set(key, String(value)),
  };
}

let host: HTMLDivElement;
let root: Root;
const calls: { url: string; init?: RequestInit }[] = [];

async function mount(crew: CrewMember[] = CREW) {
  const { CrewView } = await import('./crew-view');
  await act(async () => {
    root.render(
      <CrewView
        crew={crew}
        accounts={[{ id: 'max', provider: 'anthropic', kind: 'key', label: 'Anthropic — key' }]}
        byBot={[]}
        header={headerData({ repos: ['acme'], repoColors: {}, crew, budget: null, needsYou: 0 })}
        now={NOW}
      />,
    );
  });
}

const button = (text: string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === text) as HTMLButtonElement;
const click = async (element: Element) => act(async () => void (element as HTMLElement).click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', memoryStorage());
  calls.length = 0;
  for (const fn of Object.values(actions)) fn.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [], aliases: ['newest:opus', 'newest:sonnet'] }));
      return new Response('{}');
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the crew page’s two layouts', () => {
  it('starts as cards, turns into the table, and keeps that choice for the next visit', async () => {
    await mount();
    expect(host.querySelector('[data-crew-grid]')).not.toBeNull();
    expect(button('Cards').getAttribute('aria-pressed')).toBe('true');

    await click(button('Table'));
    expect(host.querySelector('[data-seat-table]')).not.toBeNull();
    expect(localStorage.getItem(CREW_LAYOUT_KEY)).toBe('table');

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(host.querySelector('[data-seat-table]')).not.toBeNull();
  });

  it('is cards when the browser will not say', async () => {
    vi.stubGlobal('localStorage', {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('blocked');
      },
    });
    await mount();
    expect(host.querySelector('[data-crew-grid]')).not.toBeNull();
  });
});

describe('pressing a seat', () => {
  it('opens its panel, with History and Settings, on its conversation — or on its computer while it works', async () => {
    await mount();
    await click(host.querySelector('[data-seat-card="builder-acme"]')!);
    expect(host.querySelector('[data-panel="builder-acme"]')?.getAttribute('data-tab')).toBe('chat');
    expect(host.querySelector('[data-panel]')?.textContent).toBe('History,Settings');

    await click(host.querySelector('[data-seat-card="intake-acme"]')!);
    expect(host.querySelector('[data-panel="intake-acme"]')?.getAttribute('data-tab')).toBe('computer');
  });

  it('does not open it from a control on the card, and Change model opens its settings', async () => {
    await mount();
    const card = host.querySelector('[data-seat-card="builder-acme"]')!;
    await click(card.querySelector('select')!);
    expect(host.querySelector('[data-panel]')).toBeNull();

    await click(button('Change model', card));
    expect(host.querySelector('[data-panel="builder-acme"]')?.getAttribute('data-tab')).toBe('settings');
  });

  it('opens it from a table row too, and not from the row’s selects', async () => {
    localStorage.setItem(CREW_LAYOUT_KEY, 'table');
    await mount();
    const row = host.querySelector('[data-seat-row="builder-acme"]')!;
    await click(row.querySelector('select')!);
    expect(host.querySelector('[data-panel]')).toBeNull();
    await click(row.querySelector('td:nth-child(3)')!);
    expect(host.querySelector('[data-panel="builder-acme"]')).not.toBeNull();
  });
});

describe('changing a seat in its row', () => {
  it('saves how many tasks it runs at once as it is chosen', async () => {
    localStorage.setItem(CREW_LAYOUT_KEY, 'table');
    await mount();
    const select = host.querySelector('select[aria-label="builder-acme tasks at once"]') as HTMLSelectElement;
    await act(async () => {
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(actions.setCrewTasksAtOnce).toHaveBeenCalledWith('builder-acme', 3);
  });

  it('offers the newest of each family once the account has said, and saves the one chosen', async () => {
    localStorage.setItem(CREW_LAYOUT_KEY, 'table');
    await mount();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const select = host.querySelector('select[aria-label="builder-acme model"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['max|newest:opus', 'max|newest:sonnet']);
    await act(async () => {
      select.value = 'max|newest:sonnet';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const saved = calls.find((call) => call.url === '/api/bots/builder-acme/assignment');
    expect(saved?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(saved?.init?.body))).toEqual({ model: 'newest:sonnet', modelAccountId: 'max' });
  });
});

describe('pausing a seat', () => {
  it('asks why, then pauses it with the reason', async () => {
    await mount();
    const card = host.querySelector('[data-seat-card="builder-acme"]')!;
    await click(button('Pause this seat', card));
    const input = card.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'changing its model');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Pause', card));
    expect(actions.pauseSeat).toHaveBeenCalledWith('builder-acme', 'changing its model');
    // Asking was on the card, and did not open the panel.
    expect(host.querySelector('[data-panel]')).toBeNull();
  });

  it('resumes a paused seat', async () => {
    await mount([member({ name: 'builder-acme', seatPaused: { by: 'janedoe', at: NOW, why: null } })]);
    await click(button('Resume'));
    expect(actions.resumeSeat).toHaveBeenCalledWith('builder-acme');
  });
});
