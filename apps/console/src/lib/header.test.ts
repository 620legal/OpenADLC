import { describe, expect, it } from 'vitest';
import type { AttentionItem } from './api';
import { headerData, spendLevel } from './header';

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
    expect(spendLevel({ spentUsd: 10, capUsd: 100, estimateUsd: 5000 })).toMatchObject({ width: 10, tone: 'signal' });
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
