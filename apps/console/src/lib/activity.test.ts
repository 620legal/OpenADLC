import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_SEEN_CHANGED,
  ACTIVITY_SEEN_KEY,
  badgeText,
  eventHref,
  historyQuery,
  matchesFilters,
  mergeEvents,
  newestAt,
  readActivity,
  readSeen,
  repoName,
  unreadCount,
  writeSeen,
  type BoardEvent,
} from './activity';

/** The crew's events as the console counts, merges, links and asks for them. */

function event(id: string, at: string, overrides: Partial<BoardEvent> = {}): BoardEvent {
  return { id, type: 'task.started', at, bot: 'builder', item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC', url: null }, text: `builder ${id}`, ...overrides };
}

const T = (seconds: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString();

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the time seen', () => {
  it('is kept under openadlc.activity.seen, and read back', () => {
    const store = memory();
    writeSeen(T(5), store);
    expect(store.values.get(ACTIVITY_SEEN_KEY)).toBe(T(5));
    expect(readSeen(store)).toBe(T(5));
  });

  it('is none when nothing, or nothing that is a time, is stored', () => {
    expect(readSeen(memory())).toBeNull();
    expect(readSeen(memory({ [ACTIVITY_SEEN_KEY]: 'yesterday-ish' }))).toBeNull();
    expect(readSeen(null)).toBeNull();
  });

  it('never throws, whatever storage does', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readSeen(throwing)).toBeNull();
    expect(() => writeSeen(T(1), throwing)).not.toThrow();
  });

  it('is announced in the tab when written, so every button follows', () => {
    const heard = vi.fn();
    const target = new EventTarget();
    target.addEventListener(ACTIVITY_SEEN_CHANGED, heard);
    vi.stubGlobal('window', target);
    writeSeen(T(1), memory());
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('the count', () => {
  const events = [event('a', T(1)), event('b', T(2)), event('c', T(3))];

  it('is the events newer than the time seen', () => {
    expect(unreadCount(events, T(1))).toBe(2);
    expect(unreadCount(events, T(3))).toBe(0);
  });

  it('is zero before any time is stored: a browser starts at zero, not at the backlog', () => {
    expect(unreadCount(events, null)).toBe(0);
  });

  it('is hidden at zero, said up to 99, and 99+ past it', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('two lists as one', () => {
  it('has each event once by id, newest first and then by id, the one listed first kept', () => {
    const fromHistory = [event('b', T(2)), event('a', T(1))];
    const pushed = [event('c', T(3)), event('b', T(9), { text: 'a later copy' }), event('d', T(2))];
    const merged = mergeEvents(fromHistory, pushed);
    expect(merged.map((one) => one.id)).toEqual(['c', 'd', 'b', 'a']);
    expect(merged.find((one) => one.id === 'b')!.text).toBe('builder b');
  });

  it('knows the newest time', () => {
    expect(newestAt([event('a', T(1)), event('b', T(4)), event('c', T(2))])).toBe(T(4));
    expect(newestAt([])).toBeNull();
  });
});

describe('where a row goes', () => {
  it('opens a request filed nowhere yet as its work item', () => {
    expect(eventHref(event('r', T(1), { item: { ref: 'request:ab12cd34', repo: null, url: null } }))).toBe('/items/request%3Aab12cd34');
  });

  it('opens an issue or pull request as its work item', () => {
    expect(eventHref(event('i', T(1)))).toBe('/items/OpenADLC%23227');
  });

  it('opens a published release on its repository’s releases', () => {
    expect(eventHref(event('rel', T(1), { type: 'release.published', item: { ref: 'release:OpenADLC@v1.4.2', repo: '620legal/OpenADLC', url: 'https://x' } }))).toBe('/releases/OpenADLC');
  });
});

describe('the filters', () => {
  it('match a repository by its name or full name, and hide an event on no repository', () => {
    const onRequest = event('r', T(1), { item: { ref: 'request:ab12cd34', repo: null, url: null } });
    expect(matchesFilters(event('a', T(1)), { repo: 'OpenADLC' })).toBe(true);
    expect(matchesFilters(event('a', T(1)), { repo: '620legal/OpenADLC' })).toBe(true);
    expect(matchesFilters(event('a', T(1)), { repo: 'website' })).toBe(false);
    expect(matchesFilters(onRequest, { repo: 'OpenADLC' })).toBe(false);
    expect(matchesFilters(onRequest, {})).toBe(true);
  });

  it('match a seat, and hide an event no seat did', () => {
    expect(matchesFilters(event('a', T(1)), { bot: 'builder' })).toBe(true);
    expect(matchesFilters(event('a', T(1), { bot: null }), { bot: 'builder' })).toBe(false);
    expect(matchesFilters(event('a', T(1), { bot: 'lead-reviewer' }), { bot: 'builder' })).toBe(false);
  });

  it('name a repository by its name', () => {
    expect(repoName('620legal/OpenADLC')).toBe('OpenADLC');
    expect(repoName(null)).toBeNull();
  });
});

describe('asking for a page', () => {
  it('says only what is set', () => {
    expect(historyQuery({})).toBe('');
    expect(historyQuery({ repo: 'my web', bot: '', before: '2026-11-02T00:00:00.000Z~task.started:t1', limit: 100 })).toBe(
      '?repo=my+web&before=2026-11-02T00%3A00%3A00.000Z%7Etask.started%3At1&limit=100',
    );
  });

  it('reads a page through the console’s proxy', async () => {
    const fetcher = vi.fn(async () => Response.json({ events: [event('a', T(1))], next: null, floor: T(0) }));
    const page = await readActivity({ repo: 'OpenADLC', limit: 100 }, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith('/api/board/events?repo=OpenADLC&limit=100', { cache: 'no-store' });
    expect(page).toEqual({ events: [event('a', T(1))], next: null, floor: T(0) });
  });

  it('throws the bridge’s words when it refuses, and the status when it says nothing', async () => {
    const refusing = vi.fn(async () => Response.json({ error: 'sign in to the console' }, { status: 401 }));
    await expect(readActivity({}, refusing as unknown as typeof fetch)).rejects.toThrow('sign in to the console');
    const silent = vi.fn(async () => new Response('<html>', { status: 502 }));
    await expect(readActivity({}, silent as unknown as typeof fetch)).rejects.toThrow('the bridge answered 502');
  });
});
