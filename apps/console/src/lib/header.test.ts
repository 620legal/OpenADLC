import { describe, expect, it } from 'vitest';
import type { AttentionItem } from './api';
import { headerData, navFor, PAGES, pinnedNav, spendLevel, unpinnedNav } from './header';
import { NAV_PIN_DEFAULTS } from './nav-pins';

const header = (budget: { spentUsd: number; capUsd: number; state: string }) =>
  headerData({ repos: [], crew: [], budget, needsYou: 0 });

describe('the header’s spend and the subscription estimate', () => {
  it('carries the estimate beside billed spend only when there is one', () => {
    expect(headerData({ repos: [], crew: [], budget: { spentUsd: 10, capUsd: 100, estimateUsd: 140 }, needsYou: 0 }).spend).toEqual({
      spentUsd: 10,
      capUsd: 100,
      estimateUsd: 140,
    });
    expect(headerData({ repos: [], crew: [], budget: { spentUsd: 10, capUsd: 100, estimateUsd: 0 }, needsYou: 0 }).spend).toEqual({
      spentUsd: 10,
      capUsd: 100,
    });
  });

  it('colours the bar from billed spend alone', () => {
    const spend = headerData({ repos: [], crew: [], budget: { spentUsd: 10, capUsd: 100, estimateUsd: 5000 }, needsYou: 0 }).spend!;
    expect(spendLevel(spend)).toMatchObject({ width: 10, tone: 'signal' });
  });
});

describe('the header’s spend colour', () => {
  it('follows the bridge’s state, whatever warningAt is set to', () => {
    // warningAt 0.75: the bridge already warns at 80 percent.
    expect(spendLevel(header({ spentUsd: 800, capUsd: 1000, state: 'warning' }).spend!).tone).toBe('attention');
    // warningAt 0.95: at 92 percent the bridge still says ok.
    expect(spendLevel(header({ spentUsd: 920, capUsd: 1000, state: 'ok' }).spend!).tone).toBe('signal');
    expect(spendLevel(header({ spentUsd: 1000, capUsd: 1000, state: 'stopped' }).spend!).tone).toBe('alarm');
  });

  it('says an overrun as it is, and holds only the bar to the cap', () => {
    expect(spendLevel({ spentUsd: 2000, capUsd: 1500, state: 'stopped' })).toMatchObject({ width: 100 });
    expect(spendLevel({ spentUsd: 2000, capUsd: 1500, state: 'stopped' }).percent.toFixed(1)).toBe('133.3');
  });

  it('goes by the percentage for a figure that came without a state', () => {
    expect(spendLevel({ spentUsd: 950, capUsd: 1000 }).tone).toBe('attention');
    expect(spendLevel({ spentUsd: 100, capUsd: 1000 }).tone).toBe('signal');
  });
});

describe('the work the tab’s alerts watch', () => {
  const item = (id: string, kind: AttentionItem['kind'], extra: Partial<AttentionItem> = {}): AttentionItem => ({
    id,
    kind,
    headline: 'The builder has a question',
    subject: { repo: 'OpenADLC', number: 42, title: 'Add a health endpoint', ref: 'OpenADLC#42', url: null, item: 'OpenADLC#42' },
    bot: null,
    since: '2026-11-02T00:00:00.000Z',
    detail: '',
    actions: [],
    ...extra,
  });

  it('holds the waiting work, in order, and no system item or fixed check', () => {
    const data = headerData({
      repos: ['OpenADLC'],
      crew: [],
      budget: null,
      needsYou: 3,
      attention: [
        item('gate:1', 'question'),
        item('check:x', 'check_failed', { headline: 'GitHub cannot reach the bridge' }),
        item('fixed:x', 'check_fixed'),
        item('task:2', 'task_failed', { headline: 'The builder could not finish', subject: { repo: 'OpenADLC', number: 7, title: null, ref: 'OpenADLC#7', url: null } }),
        item('gate:3', 'question', { group: 'system' }),
      ],
    });
    expect(data.needsItems).toEqual([
      { id: 'gate:1', text: 'The builder has a question about #42', item: 'OpenADLC#42' },
      { id: 'task:2', text: 'The builder could not finish about #7', item: null },
    ]);
  });

  it('is null when the page read no items', () => {
    expect(headerData({ repos: [], crew: [], budget: null, needsYou: 2 }).needsItems).toBeNull();
    expect(headerData({ repos: [], crew: [], budget: null, needsYou: null, attention: null }).needsItems).toBeNull();
  });
});

describe('the console’s pages', () => {
  it('are one list, Needs you among them, in the palette’s order (ADR 0080)', () => {
    expect(PAGES.map((item) => `${item.label} ${item.href('all')}`)).toEqual([
      'Board /?board=1',
      'Needs you /needs-you',
      'Crew /crew',
      'Costs /costs',
      'Insights /insights',
      'Security /security',
      'Releases /releases',
      'Map /map',
      'Activity /activity',
      'Settings /settings',
    ]);
    expect(PAGES.find((item) => item.page === 'board')?.href('api')).toBe('/?board=1&repo=api');
  });

  it('are all there for everyone signed in, Settings too: a user’s Settings is Notifications (ADR 0053)', () => {
    for (const role of ['admin', 'user'] as const) {
      expect(navFor(role).map((item) => item.page), role).toEqual(['board', 'needs-you', 'crew', 'costs', 'insights', 'security', 'releases', 'map', 'activity', 'settings']);
      expect(navFor(role)).toBe(PAGES);
    }
    expect(navFor('user').find((item) => item.page === 'settings')?.href('all')).toBe('/settings');
  });

  it('has Security for everyone, under More rather than pinned (#377)', () => {
    for (const role of ['admin', 'user'] as const) {
      expect(navFor(role).find((item) => item.page === 'security')?.href('all'), role).toBe('/security');
    }
  });

  it('has Releases for everyone, since anyone may watch a release (#345)', () => {
    expect(navFor('user').find((item) => item.page === 'releases')).toMatchObject({ label: 'Releases' });
    expect(navFor('user').find((item) => item.page === 'releases')?.href('all')).toBe('/releases');
  });

  it('has Map after Releases, opening the chosen repository’s map or the list of them (#380)', () => {
    const pages = navFor('user').map((item) => item.page);
    expect(pages.indexOf('map')).toBe(pages.indexOf('releases') + 1);
    const map = navFor('user').find((item) => item.page === 'map');
    expect(map).toMatchObject({ label: 'Map' });
    expect(map?.href('acme/widgets')).toBe('/map/acme%2Fwidgets');
    expect(map?.href('all')).toBe('/map');
    expect(map?.href('')).toBe('/map');
  });

  it('has Activity after Map, for everyone, and not pinned by default (#374)', () => {
    const pages = navFor('user').map((item) => item.page);
    expect(pages.indexOf('activity')).toBe(pages.indexOf('map') + 1);
    expect(navFor('user').find((item) => item.page === 'activity')).toMatchObject({ label: 'Activity' });
    expect(navFor('admin').find((item) => item.page === 'activity')?.href('api')).toBe('/activity');
    expect(NAV_PIN_DEFAULTS).not.toContain('activity');
  });
});

describe('the pinned pages and the rest', () => {
  const pages = (list: readonly { page: string }[]) => list.map((item) => item.page);

  it('shows the pinned pages in the order they were pinned, and the rest in the list’s order', () => {
    const pins = ['releases', 'board', 'costs'] as const;
    expect(pages(pinnedNav(PAGES, pins))).toEqual(['releases', 'board', 'costs']);
    expect(pages(unpinnedNav(PAGES, pins))).toEqual(['needs-you', 'crew', 'insights', 'security', 'map', 'activity', 'settings']);
  });

  it('shows nothing but More when nothing is pinned', () => {
    expect(pinnedNav(PAGES, [])).toEqual([]);
    expect(unpinnedNav(PAGES, [])).toEqual([...PAGES]);
  });

  it('never shows a page the person may not see, however it came to be pinned', () => {
    const withoutSettings = PAGES.filter((item) => item.page !== 'settings');
    const pins = ['settings', 'crew'] as const;
    expect(pages(pinnedNav(withoutSettings, pins))).toEqual(['crew']);
    expect(pages(unpinnedNav(withoutSettings, pins))).not.toContain('settings');
  });

  it('draws a page once, whatever the pins repeat', () => {
    expect(pages(pinnedNav(PAGES, ['crew', 'crew']))).toEqual(['crew']);
  });
});
