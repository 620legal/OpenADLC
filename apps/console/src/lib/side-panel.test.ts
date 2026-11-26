// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem, PanelRead, PanelRunning } from './api';
import { groupCounts, waiting } from './attention-card';
import { REFRESH_EVERY_MS } from './live-refresh';
import {
  badge,
  needsYouRows,
  PANEL_EVERY_MS,
  PANEL_MEDIA,
  panelCounts,
  SIDE_PANEL_CHANGED,
  sidePanelKey,
  storedSidePanelOpen,
  storeSidePanelOpen,
} from './side-panel';

function item(id: string, kind: AttentionItem['kind'], extra: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind,
    headline: `Item ${id}`,
    subject: { repo: 'api', number: 7, title: null, ref: 'api#7', url: null, item: 'item-7' },
    bot: null,
    since: '2026-11-25T10:00:00.000Z',
    detail: '',
    actions: [],
    ...extra,
  };
}

/** One of each that the Needs you page counts and leaves out. */
const ITEMS: AttentionItem[] = [
  item('question', 'question', { since: '2026-11-25T09:00:00.000Z' }),
  item('failed', 'task_failed', { since: '2026-11-25T08:00:00.000Z' }),
  item('check', 'check_failed', { severity: 'warning', since: '2026-11-25T11:00:00.000Z' }),
  // A notice that something was fixed waits on nobody.
  item('fixed', 'check_fixed'),
  // A held approval that is someone else's is under Waiting on others, counted nowhere.
  item('theirs', 'merge_waiting', { decision: { waitsOnOther: true } as AttentionItem['decision'] }),
];

function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
}

describe('the side panel’s open state, per person (#376)', () => {
  it('is keyed by the encoded identity', () => {
    expect(sidePanelKey('jane.doe@example.com')).toBe('openadlc.sidePanel.jane.doe%40example.com');
    expect(sidePanelKey('a:b')).toBe('openadlc.sidePanel.a%3Ab');
  });

  it('is open until this person collapses it, and one person’s collapse leaves another open', () => {
    const store = memoryStore();
    expect(storedSidePanelOpen('jane@example.com', store)).toBe(true);
    storeSidePanelOpen('jane@example.com', false, store);
    expect(store.map.get('openadlc.sidePanel.jane%40example.com')).toBe('closed');
    expect(storedSidePanelOpen('jane@example.com', store)).toBe(false);
    expect(storedSidePanelOpen('alex@example.com', store)).toBe(true);
    storeSidePanelOpen('jane@example.com', true, store);
    expect(storedSidePanelOpen('jane@example.com', store)).toBe(true);
  });

  it('reads open for an unknown value, and for a store that throws', () => {
    expect(storedSidePanelOpen('jane', memoryStore({ 'openadlc.sidePanel.jane': 'sideways' }))).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(storedSidePanelOpen('jane', throwing)).toBe(true);
  });

  it('never stores anything, or says it changed, without an identity', () => {
    const store = memoryStore();
    const heard = vi.fn();
    window.addEventListener(SIDE_PANEL_CHANGED, heard);
    try {
      storeSidePanelOpen(null, false, store);
      expect(store.map.size).toBe(0);
      expect(heard).not.toHaveBeenCalled();
      expect(storedSidePanelOpen(null, memoryStore({ 'openadlc.sidePanel.null': 'closed' }))).toBe(true);
    } finally {
      window.removeEventListener(SIDE_PANEL_CHANGED, heard);
    }
  });

  it('says the change with its state, even when the write throws, so the collapse holds for the page', () => {
    const heard: unknown[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener(SIDE_PANEL_CHANGED, listener);
    try {
      storeSidePanelOpen('jane', false, {
        setItem: () => {
          throw new Error('quota');
        },
      });
      expect(heard).toEqual([{ identity: 'jane', open: false }]);
    } finally {
      window.removeEventListener(SIDE_PANEL_CHANGED, listener);
    }
  });
});

describe('the side panel’s counts (#376)', () => {
  const panel: PanelRead = {
    attention: ITEMS,
    tasks: {
      running: [
        { id: 't1', state: 'working' },
        { id: 't2', state: 'waiting' },
        { id: 't3', state: 'paused' },
      ] as PanelRunning[],
      recent: [],
    },
  };

  it('counts Needs you as the Needs you page does', () => {
    const page = groupCounts(ITEMS);
    expect(panelCounts(panel).needsYou).toBe(page.work + page.system);
    expect(panelCounts(panel).needsYou).toBe(3);
  });

  it('lists the same items the page counts, what stops work first, with no limit', () => {
    const rows = needsYouRows(ITEMS);
    expect(new Set(rows.map((one) => one.id))).toEqual(new Set(waiting(ITEMS).map((one) => one.id)));
    expect(rows.map((one) => one.id)).toEqual(['failed', 'question', 'check']);
    const many = Array.from({ length: 30 }, (_, at) => item(`q${at}`, 'question'));
    expect(needsYouRows(many)).toHaveLength(30);
  });

  it('counts every row of Running: working, waiting and paused', () => {
    expect(panelCounts(panel).running).toBe(3);
  });

  it('counts nothing from a part that could not be read', () => {
    expect(panelCounts({ attention: null, tasks: null })).toEqual({ needsYou: 0, running: 0 });
  });

  it('says a count as a badge: none at zero, 99+ past 99', () => {
    expect([badge(0), badge(4), badge(99), badge(100)]).toEqual([null, '4', '99', '99+']);
  });

  it('polls as often as the board reads itself, and only from Tailwind’s md up', () => {
    expect(PANEL_EVERY_MS).toBe(REFRESH_EVERY_MS);
    expect(PANEL_MEDIA).toBe('(min-width: 768px)');
  });
});
