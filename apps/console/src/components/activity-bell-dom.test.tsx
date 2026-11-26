// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_SEEN_KEY, type BoardEvent } from '@/lib/activity';
import { ActivityBell } from './activity-bell';

/**
 * The activity button in a browser: what it counts, what opening it marks
 * seen, what the stream adds, and what it says when the history cannot be
 * read. The stream is a fake the test drives; the history is the fetcher.
 */

class FakeEventSource {
  static made: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  private listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const T = (seconds: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString();

function event(id: string, at: string, overrides: Partial<BoardEvent> = {}): BoardEvent {
  return { id, type: 'task.started', at, bot: 'builder', item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC', url: null }, text: `builder did ${id}`, ...overrides };
}

let root: Root;
let container: HTMLElement;
let history: { status: number; body: unknown };
let reads: string[];

const fetcher = (async (input: string) => {
  reads.push(input);
  return Response.json(history.body, { status: history.status });
}) as unknown as typeof fetch;

/** Lets every pending timer, promise and render run. */
const settle = () =>
  act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function draw(): Promise<void> {
  await act(async () => root.render(<ActivityBell repos={['OpenADLC', 'website']} crew={[{ name: 'builder', slot: 'builder' }, { name: 'lead-reviewer', slot: 'lead-reviewer' }]} fetcher={fetcher} />));
  await settle();
}

/** Draws the button and opens its stream, which reads the newest page. */
async function connected(): Promise<FakeEventSource> {
  await draw();
  const stream = FakeEventSource.made.at(-1)!;
  await act(async () => stream.emit('open'));
  await settle();
  return stream;
}

const badge = () => container.querySelector('[data-activity-badge]')?.textContent ?? null;
const button = () => container.querySelector<HTMLButtonElement>('[data-activity-bell] > button')!;
const panel = () => container.querySelector<HTMLElement>('[data-activity-panel]')!;
const listed = () => [...container.querySelectorAll('[data-activity-event]')].map((row) => row.getAttribute('data-activity-event'));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.made = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  localStorage.clear();
  history = { status: 200, body: { events: [], next: null, floor: T(0) } };
  reads = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the count', () => {
  it('starts at zero in a browser that has stored no time, and stores the newest event’s', async () => {
    history.body = { events: [event('b', T(2)), event('a', T(1))], next: null, floor: T(0) };
    await connected();
    expect(reads).toEqual(['/api/board/events?limit=100']);
    expect(badge()).toBeNull();
    expect(localStorage.getItem(ACTIVITY_SEEN_KEY)).toBe(T(2));
  });

  it('counts the events newer than the time seen, to 99+', async () => {
    localStorage.setItem(ACTIVITY_SEEN_KEY, T(0));
    history.body = { events: Array.from({ length: 7 }, (_, index) => event(`e${index}`, T(index + 1))), next: null, floor: T(0) };
    await connected();
    expect(badge()).toBe('7');
    expect(button().getAttribute('aria-label')).toBe('Activity, 7 new');

    act(() => root.unmount());
    root = createRoot(container);
    history.body = { events: Array.from({ length: 100 }, (_, index) => event(`e${index}`, T(index + 1))), next: null, floor: T(0) };
    await connected();
    expect(badge()).toBe('99+');
  });

  it('goes to zero when the panel opens, which stores the newest time shown', async () => {
    localStorage.setItem(ACTIVITY_SEEN_KEY, T(0));
    history.body = { events: [event('b', T(2)), event('a', T(1))], next: null, floor: T(0) };
    await connected();
    expect(badge()).toBe('2');
    await act(async () => button().click());
    expect(panel().hidden).toBe(false);
    expect(badge()).toBeNull();
    expect(localStorage.getItem(ACTIVITY_SEEN_KEY)).toBe(T(2));
    expect(listed()).toEqual(['b', 'a']);
  });

  it('stays at zero after a reload until something newer arrives', async () => {
    localStorage.setItem(ACTIVITY_SEEN_KEY, T(2));
    history.body = { events: [event('b', T(2)), event('a', T(1))], next: null, floor: T(0) };
    const stream = await connected();
    expect(badge()).toBeNull();
    await act(async () => stream.emit('board', JSON.stringify(event('c', T(3)))));
    expect(badge()).toBe('1');
  });

  it('adds nothing for a pushed event already listed', async () => {
    localStorage.setItem(ACTIVITY_SEEN_KEY, T(0));
    history.body = { events: [event('a', T(1))], next: null, floor: T(0) };
    const stream = await connected();
    expect(badge()).toBe('1');
    await act(async () => stream.emit('board', JSON.stringify(event('a', T(1)))));
    expect(badge()).toBe('1');
    await act(async () => button().click());
    expect(listed()).toEqual(['a']);
  });

  it('reads the newest page again when the stream comes back, without listing anything twice', async () => {
    localStorage.setItem(ACTIVITY_SEEN_KEY, T(0));
    history.body = { events: [event('a', T(1))], next: null, floor: T(0) };
    const stream = await connected();
    history.body = { events: [event('b', T(2)), event('a', T(1))], next: null, floor: T(0) };
    await act(async () => stream.emit('open'));
    await settle();
    expect(reads).toHaveLength(2);
    expect(badge()).toBe('2');
  });

  it('shows no count, and no error, where storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      clear: () => undefined,
    });
    history.body = { events: [event('a', T(1))], next: null, floor: T(0) };
    await connected();
    expect(badge()).toBeNull();
    expect(container.querySelector('[data-activity-error]')).toBeNull();
  });
});

describe('the panel', () => {
  it('says the bridge’s words when the history cannot be read, and the button stays without a count', async () => {
    localStorage.setItem(ACTIVITY_SEEN_KEY, T(0));
    history = { status: 502, body: { error: 'the bridge is not answering' } };
    await connected();
    expect(button()).not.toBeNull();
    expect(badge()).toBeNull();
    expect(container.querySelector('[data-activity-error]')?.textContent).toBe('Activity can’t be read: the bridge is not answering');

    history = { status: 401, body: { error: 'sign in to the console' } };
    act(() => root.unmount());
    root = createRoot(container);
    await connected();
    expect(container.querySelector('[data-activity-error]')?.textContent).toBe('Activity can’t be read: sign in to the console');
  });

  it('reads the history even when its stream never opens, to say why', async () => {
    history = { status: 502, body: { error: 'the bridge is not answering' } };
    await draw();
    await act(async () => FakeEventSource.made.at(-1)!.emit('error'));
    await settle();
    expect(container.querySelector('[data-activity-error]')?.textContent).toBe('Activity can’t be read: the bridge is not answering');
  });

  it('narrows its list by repository and by bot, leaving the count of everything', async () => {
    localStorage.setItem(ACTIVITY_SEEN_KEY, T(0));
    history.body = {
      events: [
        event('on-request', T(4), { item: { ref: 'request:ab12cd34', repo: null, url: null } }),
        event('website', T(3), { item: { ref: 'website#2', repo: '620legal/website', url: null } }),
        event('lead', T(2), { bot: 'lead-reviewer' }),
        event('builder', T(1)),
      ],
      next: null,
      floor: T(0),
    };
    await connected();
    await act(async () => button().click());
    expect(listed()).toEqual(['on-request', 'website', 'lead', 'builder']);

    const repo = container.querySelector<HTMLSelectElement>('[data-activity-filter="repo"]')!;
    const bot = container.querySelector<HTMLSelectElement>('[data-activity-filter="bot"]')!;
    await act(async () => {
      repo.value = 'OpenADLC';
      repo.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(listed()).toEqual(['lead', 'builder']);
    await act(async () => {
      bot.value = 'builder';
      bot.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(listed()).toEqual(['builder']);
    expect(container.querySelector('a[href^="/activity"]')?.getAttribute('href')).toBe('/activity?repo=OpenADLC&bot=builder');
  });

  it('links each row to its item, and says who, where and what', async () => {
    history.body = { events: [event('r', T(1), { bot: null, item: { ref: 'request:ab12cd34', repo: null, url: null }, text: 'filed' })], next: null, floor: T(0) };
    await connected();
    await act(async () => button().click());
    const row = container.querySelector('[data-activity-event="r"]')!;
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/items/request%3Aab12cd34');
    expect(row.querySelector('[data-activity-bot]')?.textContent).toBe('OpenADLC');
    expect(row.querySelector('[data-activity-repo]')?.textContent).toBe('request');
    expect(row.querySelector('[data-activity-text]')?.textContent).toBe('filed');
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(T(1));
  });

  it('closes on Escape', async () => {
    await connected();
    await act(async () => button().click());
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(panel().hidden).toBe(true);
  });
});
