// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeGapReport as Report } from '@/lib/api';

const dismissBridgeGap = vi.hoisted(() => vi.fn(async (_backAt: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true })));
vi.mock('@/app/actions', () => ({ dismissBridgeGap }));

import { awayWords, BridgeGapReport } from './bridge-gap-report';

const GAP: Report = {
  lastUpAt: '2026-11-02T14:02:00.000Z',
  backAt: '2026-11-02T14:03:10.000Z',
  awayMs: 70_000,
  tasks: [
    { taskId: 'task-1', subject: 'openadlc#7', outcome: 'resumed', why: 'resumed implement on openadlc#7', backAt: '2026-11-02T14:03:10.000Z' },
    { taskId: 'task-2', subject: 'openadlc#9', outcome: 'orphaned', why: 'the task was marked running but its host has stopped reporting', backAt: '2026-11-02T14:03:10.000Z' },
  ],
  filling: false,
};
// Read the same afternoon.
const NOW = Date.parse('2026-11-02T15:00:00.000Z');

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

describe('the report of how long the bridge was away', () => {
  it('says how long, when, and each task with why, linking to its card', () => {
    const html = renderToStaticMarkup(<BridgeGapReport gap={GAP} now={NOW} timeZone="UTC" />);
    expect(text(html)).toContain('OpenADLC was away for about 1 minute (14:02–14:03).');
    expect(text(html)).toContain('It resumed:openadlc#7 — resumed implement on openadlc#7');
    expect(text(html)).toContain('It treated as orphaned:openadlc#9 — the task was marked running but its host has stopped reporting');
    expect(html).toContain('href="/?item=openadlc%237"');
    expect(html).toContain('href="/?item=openadlc%239"');
    expect(text(html)).toContain('Dismiss');
  });

  it('still says how long when nothing was resumed or orphaned', () => {
    const html = renderToStaticMarkup(<BridgeGapReport gap={{ ...GAP, tasks: [] }} now={NOW} timeZone="UTC" />);
    expect(text(html)).toContain('OpenADLC was away for about 1 minute (14:02–14:03). Nothing was resumed or treated as orphaned when it came back.');
    expect(text(html)).not.toContain('It resumed:');
  });

  it('says the list is still being filled, not that nothing was resumed, and cannot be dismissed yet', () => {
    const empty = renderToStaticMarkup(<BridgeGapReport gap={{ ...GAP, tasks: [], filling: true }} now={NOW} timeZone="UTC" />);
    expect(text(empty)).toContain('OpenADLC was away for about 1 minute (14:02–14:03). Still listing what it resumed and treated as orphaned when it came back.');
    expect(text(empty)).not.toContain('Nothing was resumed');
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Dismiss<\/button>/);

    // The resumed tasks are in, the orphans not yet: shown, but not as complete.
    const part = renderToStaticMarkup(<BridgeGapReport gap={{ ...GAP, tasks: [GAP.tasks[0]!], filling: true }} now={NOW} timeZone="UTC" />);
    expect(text(part)).toContain('Still listing what it resumed and treated as orphaned');
    expect(text(part)).toContain('It resumed:openadlc#7');

    const done = renderToStaticMarkup(<BridgeGapReport gap={GAP} now={NOW} timeZone="UTC" />);
    expect(done).not.toMatch(/disabled=""/);
  });

  it('dates the range when it was not today, and both ends when it spans days', () => {
    const nextDay = Date.parse('2026-11-03T09:00:00.000Z');
    expect(text(renderToStaticMarkup(<BridgeGapReport gap={GAP} now={nextDay} timeZone="UTC" />))).toContain('(2 Nov, 14:02–14:03)');

    // A restore reports a gap from when the backup was taken.
    const restored = { ...GAP, lastUpAt: '2026-10-30T14:02:00.000Z', awayMs: Date.parse(GAP.backAt) - Date.parse('2026-10-30T14:02:00.000Z') };
    expect(text(renderToStaticMarkup(<BridgeGapReport gap={restored} now={NOW} timeZone="UTC" />))).toContain(
      'OpenADLC was away for about 3 days (30 Oct, 14:02 – 2 Nov, 14:03).',
    );
  });

  it('says when a task an earlier gap kept was resumed or orphaned', () => {
    const earlier = { taskId: 'task-3', subject: 'openadlc#11', outcome: 'resumed' as const, why: 'resumed implement on openadlc#11', backAt: '2026-11-02T12:40:00.000Z' };
    const html = renderToStaticMarkup(<BridgeGapReport gap={{ ...GAP, tasks: [...GAP.tasks, earlier] }} now={NOW} timeZone="UTC" />);
    expect(text(html)).toContain('openadlc#11 — resumed implement on openadlc#11 (when it came back at 12:40)');
    // The latest gap's own tasks need no time of their own.
    expect(text(html)).toContain('openadlc#7 — resumed implement on openadlc#7');
    expect(text(html)).not.toContain('openadlc#7 (when it came back');
  });

  it('is nothing when no report is open', () => {
    expect(renderToStaticMarkup(<BridgeGapReport gap={null} />)).toBe('');
  });

  it('says a long gap in hours and days', () => {
    expect(awayWords(20_000)).toBe('under a minute');
    expect(awayWords(5 * 60_000)).toBe('about 5 minutes');
    expect(awayWords(65 * 60_000)).toBe('about 1 hour 5 minutes');
    expect(awayWords(2 * 3_600_000)).toBe('about 2 hours');
    expect(awayWords(3 * 86_400_000)).toBe('about 3 days');
  });
});

describe('dismissing the report', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    dismissBridgeGap.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const press = async () => {
    const button = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Dismiss')!;
    await act(async () => button.click());
  };

  it('dismisses the gap the person read', async () => {
    await act(async () => root.render(<BridgeGapReport gap={GAP} />));
    await press();
    expect(dismissBridgeGap).toHaveBeenCalledWith(GAP.backAt);
  });

  it('says why when a newer gap was merged in since', async () => {
    dismissBridgeGap.mockResolvedValueOnce({ ok: false, error: 'A newer gap was added to this report since you read it. Read it again and dismiss that.' });
    await act(async () => root.render(<BridgeGapReport gap={GAP} />));
    await press();
    expect(container.textContent).toContain('A newer gap was added to this report since you read it.');
  });
});
