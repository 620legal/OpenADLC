// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningTask } from '@/lib/api';
import { RunningTasks } from './running-tasks';

/**
 * The count above the board's columns, opened into the tasks it counts: "1
 * task running" over empty columns, while intake triaged a console request,
 * named nothing a person could find.
 */

const NOW = '2026-10-26T12:00:00.000Z';
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const TRIAGE: RunningTask = {
  id: 'task-triage',
  bot: 'intake',
  kind: 'intake',
  skill: null,
  round: 0,
  subject: 'request:b4378305',
  repo: 'api',
  title: 'Open the running count into a list',
  opens: 'request:b4378305',
  since: minutesAgo(12),
};
const DEPLOY: RunningTask = { ...TRIAGE, id: 'task-deploy', bot: 'sre', kind: 'deploy', subject: 'api@3f2c1a9', title: null, opens: null, since: minutesAgo(3) };

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const who = (bot: string) => `${bot.charAt(0).toUpperCase()}${bot.slice(1)}`;

function draw(props: { count: number; tasks?: RunningTask[]; onOpen?: (subject: string) => void; onOpenChange?: (open: boolean) => void }): void {
  act(() =>
    root.render(<RunningTasks everyRepository={false} showRepo={false} now={NOW} who={who} onOpen={props.onOpen ?? (() => undefined)} {...props} />),
  );
}

const status = () => container.querySelector('[role="status"][data-running]');
const button = () => status()?.querySelector('button') ?? null;
const rows = () => [...container.querySelectorAll('[aria-label="Tasks running"] > li')];
const key = (target: Element, name: string) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));

describe('the running count, opened', () => {
  it('is a button inside the unchanged status that opens the tasks it counts, each opening its work', () => {
    const onOpen = vi.fn();
    const onOpenChange = vi.fn();
    draw({ count: 1, tasks: [TRIAGE], onOpen, onOpenChange });
    expect(status()?.textContent).toBe('1 task running');
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    expect(rows()).toEqual([]);

    act(() => button()!.click());
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
    expect(button()?.getAttribute('aria-controls')).toBe(container.querySelector('[aria-label="Tasks running"]')?.id);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(rows().map((row) => row.textContent)).toEqual(['Intaketriage' + TRIAGE.title + 'request:b437830512 min']);
    const link = rows()[0]!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/?item=request%3Ab4378305');

    act(() => link.click());
    expect(onOpen).toHaveBeenCalledWith('request:b4378305');
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes on Escape, with the focus back on the count', () => {
    draw({ count: 1, tasks: [TRIAGE] });
    act(() => button()!.click());
    const link = rows()[0]!.querySelector('a')!;
    link.focus();
    key(link, 'Escape');
    expect(rows()).toEqual([]);
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button());
  });

  it('lists a task that opens nothing as plain text, and says what it counts past the list', () => {
    draw({ count: 3, tasks: [TRIAGE, DEPLOY] });
    act(() => button()!.click());
    expect(rows()).toHaveLength(3);
    expect(rows()[1]!.querySelector('a')).toBeNull();
    expect(rows()[1]!.textContent).toBe('Sredeployapi@3f2c1a93 min');
    expect(rows()[2]!.textContent).toBe('and 1 more running');
  });

  it('says the kind of work in a person’s words', () => {
    draw({ count: 2, tasks: [{ ...TRIAGE, kind: 'implement' }, { ...TRIAGE, id: 'task-conflict', kind: 'patch', skill: 'resolve-conflict' }] });
    act(() => button()!.click());
    expect(rows().map((row) => row.querySelectorAll('span')[1]?.textContent)).toEqual(['build', 'conflict']);
  });

  it('opens nothing with nothing running, and closes when the count falls to it', () => {
    const onOpenChange = vi.fn();
    draw({ count: 1, tasks: [TRIAGE], onOpenChange });
    act(() => button()!.click());
    draw({ count: 0, tasks: [], onOpenChange });
    expect(status()?.textContent).toBe('Nothing running');
    expect(button()).toBeNull();
    expect(rows()).toEqual([]);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('is the count alone from a bridge that sends no list', () => {
    draw({ count: 2 });
    expect(status()?.textContent).toBe('2 tasks running');
    expect(button()).toBeNull();
  });
});
