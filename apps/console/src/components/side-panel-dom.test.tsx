// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem, PanelRead, PanelRecent, PanelRunning } from '@/lib/api';
import { PANEL_EVERY_MS, PANEL_MEDIA, sidePanelKey } from '@/lib/side-panel';

/**
 * The crew panel as a person uses it: three tabs, rows that open their item,
 * a rail with the counts, a choice that stays for that person, and a poll
 * that runs only while the page is on screen and wide enough.
 */

const opened = vi.hoisted(() => ({ subjects: [] as string[] }));
vi.mock('./item-view', () => ({
  ItemView: ({ subject }: { subject: string }) => {
    opened.subjects.push(subject);
    return <div data-item-view={subject} />;
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined, prefetch: () => undefined }) }));

import { SidePanel } from './side-panel';
import { ViewerProvider } from './viewer';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function runningRow(id: string, extra: Partial<PanelRunning> = {}): PanelRunning {
  return {
    id,
    bot: 'openadlc-atlas-janedoe',
    kind: 'implement',
    skill: null,
    round: 0,
    subject: 'api#7',
    repo: 'api',
    title: 'Cache the prices',
    opens: 'api#7',
    state: 'working',
    since: minutesAgo(12),
    costUsd: 1.2,
    billed: true,
    ...extra,
  };
}

function recentRow(id: string, extra: Partial<PanelRecent> = {}): PanelRecent {
  return { id, bot: 'noraexampleco', kind: 'review', skill: null, round: 1, subject: 'api#31', repo: 'api', title: 'Review the cache', opens: 'api#31', outcome: 'done', endedAt: minutesAgo(90), costUsd: 0.5, billed: false, ...extra };
}

function attention(id: string, kind: AttentionItem['kind'], extra: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind,
    headline: `Headline ${id}`,
    subject: { repo: 'api', number: 7, title: null, ref: 'api#7', url: null, item: 'api#7' },
    bot: null,
    since: minutesAgo(5),
    detail: '',
    actions: [],
    ...extra,
  };
}

const FULL: PanelRead = {
  attention: [attention('q1', 'question'), attention('fixed', 'check_fixed'), attention('check', 'check_failed', { severity: 'warning', subject: { repo: null, number: null, title: null, ref: null, url: null } })],
  tasks: {
    running: [runningRow('t-working'), runningRow('t-waiting', { state: 'waiting', since: minutesAgo(40), costUsd: 0.4, billed: false, title: null, subject: 'request:b4378305', opens: 'request:b4378305' }), runningRow('t-deploy', { state: 'paused', subject: 'api@3f2c1a9', title: null, opens: null })],
    recent: [recentRow('r1')],
  },
};

let root: Root | null = null;
let container: HTMLElement;
let answers: PanelRead[];
let fetchMock: ReturnType<typeof vi.fn>;
let wide: { matches: boolean; listeners: Set<() => void> };
let visibility: 'visible' | 'hidden';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  opened.subjects = [];
  answers = [FULL];
  fetchMock = vi.fn(async () => Response.json(answers.length > 1 ? answers.shift() : answers[0]));
  vi.stubGlobal('fetch', fetchMock);
  wide = { matches: true, listeners: new Set() };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === PANEL_MEDIA ? wide.matches : false;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => wide.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => wide.listeners.delete(listener),
  }));
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  unmount();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(identity: string | null = 'jane@example.com') {
  unmount();
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ViewerProvider identity={identity}>
        <SidePanel />
      </ViewerProvider>,
    );
  });
  await flush();
}

function unmount() {
  if (!root) return;
  act(() => root!.unmount());
  root = null;
}

/** Lets the fetch and its JSON settle. */
async function flush() {
  for (let at = 0; at < 5; at += 1) await act(async () => Promise.resolve());
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

const aside = () => container.querySelector('aside');
const button = (name: string) => [...container.querySelectorAll('button')].find((one) => (one.getAttribute('aria-label') ?? one.textContent ?? '').includes(name)) as HTMLButtonElement | undefined;
const tab = (name: string) => [...container.querySelectorAll('[role="tab"]')].find((one) => one.textContent?.startsWith(name)) as HTMLElement | undefined;

async function choose(element: HTMLElement | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    // Radix tabs switch on mouse down, not on click.
    element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    element!.click();
  });
}

describe('the crew panel (#376)', () => {
  it('has three tabs, Needs you counted as the Needs you page counts it', async () => {
    await mount();
    expect(aside()?.getAttribute('aria-label')).toBe('Crew panel');
    const names = [...container.querySelectorAll('[role="tab"]')].map((one) => one.textContent);
    // The fixed check is a notice, not counted; the question and the failing check are.
    expect(names).toEqual(['Needs you (2)', 'Running (3)', 'Recent']);
    expect(fetchMock).toHaveBeenCalledWith('/api/panel', expect.objectContaining({ cache: 'no-store' }));
  });

  it('lists Needs you, opening a work item in the sheet and linking a system one to the page', async () => {
    await mount();
    const rows = [...container.querySelectorAll('[data-attention]')];
    expect(rows.map((one) => one.getAttribute('data-attention'))).toEqual(['q1', 'check']);
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('/needs-you?tab=system');
    await act(async () => (rows[0]?.querySelector('button') as HTMLButtonElement).click());
    expect(container.querySelector('[data-item-view]')?.getAttribute('data-item-view')).toBe('api#7');
  });

  it('says each running row’s bot, title, repository, state, minutes and spend, and opens its item', async () => {
    await mount();
    await choose(tab('Running'));
    const text = (id: string) => container.querySelector(`[data-task="${id}"]`)?.textContent ?? '';
    expect(text('t-working')).toContain('openadlc-atlas-janedoe');
    expect(text('t-working')).toContain('Cache the prices');
    expect(text('t-working')).toContain('api');
    expect(text('t-working')).toContain('working · 12 min · $1.20');
    expect(text('t-waiting')).toContain('request:b4378305');
    expect(text('t-waiting')).toContain('waiting on a person · 40 min · $0.40 est.');
    expect(text('t-deploy')).toContain('paused · 12 min');
    // A row with nothing to open is not a button.
    expect(container.querySelector('[data-task="t-deploy"] button')).toBeNull();
    await act(async () => (container.querySelector('[data-task="t-working"] button') as HTMLButtonElement).click());
    expect(container.querySelector('[data-item-view]')?.getAttribute('data-item-view')).toBe('api#7');
  });

  it('lists Recent with its outcome, when it ended and its spend, and opens its item', async () => {
    await mount();
    await choose(tab('Recent'));
    expect(container.querySelector('[data-task="r1"]')?.textContent).toContain('finished · an hour ago · $0.50 est.');
    await act(async () => (container.querySelector('[data-task="r1"] button') as HTMLButtonElement).click());
    expect(opened.subjects.at(-1)).toBe('api#31');
  });

  it('says so in a tab with nothing in it', async () => {
    answers = [{ attention: [], tasks: { running: [], recent: [] } }];
    await mount();
    expect(container.textContent).toContain('Nothing needs you');
    await choose(tab('Running'));
    expect(container.textContent).toContain('Nothing running');
    await choose(tab('Recent'));
    expect(container.textContent).toContain('Nothing finished in the last 24 hours');
  });

  it('draws nothing when the bridge sent no panel data, from an older bridge or none at all', async () => {
    answers = [{ attention: null, tasks: null }];
    await mount();
    expect(container.innerHTML).toBe('');
  });

  it('collapses to a rail with the two counts, and a badge opens the panel on its tab', async () => {
    await mount();
    await act(async () => button('Collapse the crew panel')!.click());
    expect(aside()?.getAttribute('data-side-panel')).toBe('collapsed');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect([...container.querySelectorAll('[data-badge]')].map((one) => one.textContent)).toEqual(['2', '3']);
    await act(async () => button('Running: 3')!.click());
    expect(aside()?.getAttribute('data-side-panel')).toBe('open');
    expect(tab('Running')?.getAttribute('aria-selected')).toBe('true');
  });

  it('stays collapsed for that person after a reload, and open for another on the same browser', async () => {
    await mount('jane@example.com');
    await act(async () => button('Collapse the crew panel')!.click());
    expect(localStorage.getItem(sidePanelKey('jane@example.com'))).toBe('closed');
    await mount('jane@example.com');
    expect(aside()?.getAttribute('data-side-panel')).toBe('collapsed');
    await mount('alex@example.com');
    expect(aside()?.getAttribute('data-side-panel')).toBe('open');
  });

  it('reads again within the board’s poll interval, so a task that ends leaves Running', async () => {
    answers = [FULL, { ...FULL, tasks: { running: [runningRow('t-working')], recent: FULL.tasks!.recent } }];
    await mount();
    expect(tab('Running')?.textContent).toBe('Running (3)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(PANEL_EVERY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tab('Running')?.textContent).toBe('Running (1)');
  });

  it('keeps what it drew when a later read fails', async () => {
    await mount();
    fetchMock.mockImplementation(async () => Promise.reject(new TypeError('offline')));
    await advance(PANEL_EVERY_MS);
    expect(tab('Running')?.textContent).toBe('Running (3)');
    fetchMock.mockImplementation(async () => Response.json({ tasks: null, attention: null }));
    await advance(PANEL_EVERY_MS);
    expect(tab('Running')?.textContent).toBe('Running (3)');
  });

  it('does not read while the page is hidden', async () => {
    await mount();
    visibility = 'hidden';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(PANEL_EVERY_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never reads at a phone’s width, and starts when the window widens', async () => {
    wide.matches = false;
    await mount();
    await advance(PANEL_EVERY_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
    wide.matches = true;
    await act(async () => wide.listeners.forEach((listener) => listener()));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    wide.matches = false;
    await act(async () => wide.listeners.forEach((listener) => listener()));
    await advance(PANEL_EVERY_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
