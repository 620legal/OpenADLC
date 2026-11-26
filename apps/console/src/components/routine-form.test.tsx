// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutineTemplateView, RoutineView } from '@/lib/api';
import { bodyOf, cadenceWords, RoutineForm, type RoutineDraft } from './routine-form';

/** The templates as the bridge lists them (`ROUTINE_TEMPLATES` in @openadlc/shared). */
const TEMPLATES: RoutineTemplateView[] = [
  { id: 'dependency-review', label: 'Weekly dependency review', text: 'Review this repository’s dependencies', details: 'One change per pull request.', kind: 'chore', cadence: { every: 'week', weekday: 1 }, time: '09:00' },
  { id: 'docs-drift', label: 'Nightly docs-drift check', text: 'Find docs that no longer match the code', details: 'Fix what drifted.', kind: 'chore', cadence: { every: 'day' }, time: '02:00' },
  { id: 'project-health', label: 'Monday project-health report', text: 'Write this week’s project-health report', details: null, kind: 'chore', cadence: { every: 'week', weekday: 1 }, time: '08:00' },
  { id: 'blank', label: 'Blank', text: '', details: null, kind: 'chore', cadence: { every: 'week', weekday: 1 }, time: '09:00' },
];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const field = <T extends HTMLElement>(name: string) => host.querySelector<T>(`[name="${name}"]`)!;
const button = (text: string) => [...host.querySelectorAll('button')].find((one) => one.textContent === text)!;

async function draw(props: Partial<Parameters<typeof RoutineForm>[0]> = {}) {
  const save = vi.fn(async (_draft: RoutineDraft, _id: string | null): Promise<string | null> => null);
  const onSaved = vi.fn();
  await act(async () => {
    root.render(<RoutineForm repos={['app', 'api']} templates={TEMPLATES} timeZone="Europe/Berlin" onSaved={onSaved} onCancel={() => undefined} save={save} {...props} />);
  });
  return { save, onSaved };
}

describe('a new routine', () => {
  it('offers the templates and Blank, and starts from Blank', async () => {
    await draw();
    const offered = [...host.querySelectorAll('[data-template]')].map((one) => one.getAttribute('data-template'));
    expect(offered).toEqual(['dependency-review', 'docs-drift', 'project-health', 'blank']);
    expect(host.querySelector('[data-template="blank"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(field<HTMLTextAreaElement>('text').value).toBe('');
    // Nothing to file yet.
    expect(button('Create routine').disabled).toBe(true);
  });

  it('is filled by a template, its text, kind and cadence, keeping the repository and zone', async () => {
    const { save, onSaved } = await draw();
    await act(async () => button('Nightly docs-drift check').click());

    expect(field<HTMLTextAreaElement>('text').value).toBe('Find docs that no longer match the code');
    expect(field<HTMLTextAreaElement>('details').value).toBe('Fix what drifted.');
    expect(field<HTMLSelectElement>('every').value).toBe('day');
    expect(field<HTMLInputElement>('time').value).toBe('02:00');
    expect(field<HTMLInputElement>('timeZone').value).toBe('Europe/Berlin');
    expect(host.querySelector('[name="weekday"]')).toBeNull();

    await act(async () => button('Weekly dependency review').click());
    expect(field<HTMLSelectElement>('every').value).toBe('week');
    expect(field<HTMLSelectElement>('weekday').value).toBe('1');

    await act(async () => button('Create routine').click());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'app', text: 'Review this repository’s dependencies', kind: 'chore', every: 'week', weekday: 1, time: '09:00', timeZone: 'Europe/Berlin' }),
      null,
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('shows the bridge’s words when it refuses, and stays open', async () => {
    const save = vi.fn(async () => 'Time zone "Mars/Base" is not an IANA zone: pick one like Europe/Paris or America/New_York');
    const onSaved = vi.fn();
    await draw({ save, onSaved });
    await act(async () => button('Monday project-health report').click());
    await act(async () => button('Create routine').click());
    expect(host.querySelector('[data-routine-error]')?.textContent).toContain('"Mars/Base" is not an IANA zone');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('editing a routine', () => {
  const routine: RoutineView = {
    id: '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10',
    repo: 'api',
    repoFullName: 'acme/api',
    text: 'Check the docs',
    details: null,
    kind: 'defect',
    cadence: { every: 'month', day: 31 },
    time: '10:15',
    timeZone: 'America/New_York',
    paused: false,
    owner: { identity: 'ada@example.com', login: 'ada', githubId: 1 },
    nextRunAt: '2026-11-30T15:15:00.000Z',
    lastRunAt: null,
    lastRequestId: null,
    lastRequestState: null,
    lastOutcome: null,
    lastSkipReason: null,
  };

  it('starts from what it says, with no template picker, and saves to its id', async () => {
    const { save } = await draw({ routine });
    expect(host.querySelector('[data-routine-templates]')).toBeNull();
    expect(field<HTMLSelectElement>('repo').value).toBe('api');
    expect(field<HTMLSelectElement>('every').value).toBe('month');
    expect(field<HTMLSelectElement>('day').value).toBe('31');
    expect(host.textContent).toContain('A month without day 31 runs it on its last day.');
    await act(async () => button('Save').click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ repo: 'api', every: 'month', day: 31, timeZone: 'America/New_York' }), routine.id);
  });
});

describe('what the form sends', () => {
  it('is the body the bridge takes, with the cadence the repeat chose', () => {
    const draft: RoutineDraft = { repo: 'app', text: 'x', details: '', kind: 'chore', every: 'month', weekday: 3, day: 30, time: '09:00', timeZone: 'UTC' };
    expect(bodyOf(draft)).toEqual({ repo: 'app', text: 'x', details: '', kind: 'chore', cadence: { every: 'month', day: 30 }, time: '09:00', timeZone: 'UTC' });
    expect(bodyOf({ ...draft, every: 'week' }).cadence).toEqual({ every: 'week', weekday: 3 });
    expect(bodyOf({ ...draft, every: 'day' }).cadence).toEqual({ every: 'day' });
  });

  it('says a cadence in words', () => {
    expect(cadenceWords({ every: 'week', weekday: 1 }, '09:00')).toBe('Every Monday at 09:00');
    expect(cadenceWords({ every: 'day' }, '02:00')).toBe('Every day at 02:00');
    expect(cadenceWords({ every: 'month', day: 31 }, '09:00')).toBe('Monthly on day 31 (or the month’s last day) at 09:00');
  });
});
