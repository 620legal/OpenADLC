// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@/lib/activity';
import { ActivityFeed } from './activity-feed';

/**
 * The Activity page's list in a browser, against a history that pages the
 * way the bridge's does: Load more appends the next page with nothing twice,
 * the end is said once there is no next, and a filter with nothing in it
 * says so.
 */

const T = (seconds: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString();

function event(id: string, at: string, overrides: Partial<BoardEvent> = {}): BoardEvent {
  return { id, type: 'task.started', at, bot: 'builder', item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC', url: null }, text: `builder did ${id}`, ...overrides };
}

let root: Root;
let container: HTMLElement;
let asked: URLSearchParams[];
let all: BoardEvent[];
let failing: { status: number; error: string } | null;

/** The history: newest first, filtered, two at a time, with an `<at>~<id>` cursor as the bridge sends it. */
const fetcher = (async (input: string) => {
  const params = new URL(input, 'http://console.test').searchParams;
  asked.push(params);
  if (failing) return Response.json({ error: failing.error }, { status: failing.status });
  const repo = params.get('repo');
  const bot = params.get('bot');
  const before = params.get('before');
  const limit = 2;
  const matching = all.filter(
    (one) => (!repo || one.item.repo?.endsWith(`/${repo}`)) && (!bot || one.bot === bot) && (!before || `${one.at}~${one.id}` < before),
  );
  const page = matching.slice(0, limit);
  const next = matching.length > limit ? `${page.at(-1)!.at}~${page.at(-1)!.id}` : null;
  return Response.json({ events: page, next, floor: T(0) });
}) as unknown as typeof fetch;

const settle = () =>
  act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function draw(props: { initialRepo?: string; initialBot?: string } = {}): Promise<void> {
  await act(async () => root.render(<ActivityFeed repos={['OpenADLC', 'website']} crew={[{ name: 'builder' }, { name: 'lead-reviewer' }]} fetcher={fetcher} {...props} />));
  await settle();
}

const listed = () => [...container.querySelectorAll('[data-activity-event]')].map((row) => row.getAttribute('data-activity-event'));
const more = () => container.querySelector<HTMLButtonElement>('[data-activity-more]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  failing = null;
  all = [event('e', T(5)), event('d', T(4)), event('c', T(4), { bot: 'lead-reviewer' }), event('b', T(2)), event('a', T(1), { item: { ref: 'website#1', repo: '620legal/website', url: null } })];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.replaceState(null, '', '/activity');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the Activity page’s list', () => {
  it('appends the next page on Load more, nothing twice, and says when it has everything', async () => {
    await draw();
    expect(listed()).toEqual(['e', 'd']);
    expect(container.querySelector('[data-activity-end]')).toBeNull();
    await act(async () => more()!.click());
    await settle();
    expect(asked.at(-1)!.get('before')).toBe(`${T(4)}~d`);
    expect(listed()).toEqual(['e', 'd', 'c', 'b']);
    await act(async () => more()!.click());
    await settle();
    expect(listed()).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(more()).toBeNull();
    expect(container.querySelector('[data-activity-end]')?.textContent).toBe('That’s everything from the last 30 days.');
  });

  it('starts from the filters the address names', async () => {
    await draw({ initialRepo: 'OpenADLC', initialBot: 'builder' });
    expect(asked[0]!.get('repo')).toBe('OpenADLC');
    expect(asked[0]!.get('bot')).toBe('builder');
    expect(container.querySelector<HTMLSelectElement>('[data-activity-filter="repo"]')!.value).toBe('OpenADLC');
    expect(container.querySelector<HTMLSelectElement>('[data-activity-filter="bot"]')!.value).toBe('builder');
    expect(listed()).toEqual(['e', 'd']);
  });

  it('reads again for a filter, puts it in the address, and says when nothing matches', async () => {
    await draw();
    const repo = container.querySelector<HTMLSelectElement>('[data-activity-filter="repo"]')!;
    await act(async () => {
      repo.value = 'website';
      repo.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(listed()).toEqual(['a']);
    expect(window.location.search).toBe('?repo=website');

    const bot = container.querySelector<HTMLSelectElement>('[data-activity-filter="bot"]')!;
    await act(async () => {
      bot.value = 'lead-reviewer';
      bot.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(listed()).toEqual([]);
    expect(container.querySelector('[data-activity-empty]')?.textContent).toBe('Nothing matches these filters in the last 30 days.');
    expect(container.querySelector('[data-activity-end]')).toBeNull();
    expect(window.location.search).toBe('?repo=website&bot=lead-reviewer');
  });

  it('says so when nothing at all happened', async () => {
    all = [];
    await draw();
    expect(container.querySelector('[data-activity-empty]')?.textContent).toBe('Nothing has happened in the last 30 days.');
  });

  it('says the bridge’s words when the history cannot be read', async () => {
    failing = { status: 401, error: 'sign in to the console' };
    await draw();
    expect(container.querySelector('[data-activity-error]')?.textContent).toBe('Activity can’t be read: sign in to the console');
    expect(container.querySelector('[data-activity-empty]')).toBeNull();
  });
});
