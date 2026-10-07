// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, ModelAccountRef } from '@/lib/api';
import { RoleProvider } from './app-header';

/**
 * A seat's controls in a DOM: they follow the page's own reads, and a call
 * that fails outright is said rather than left on "Saving…" or taking the
 * page down.
 */

const actions = vi.hoisted(() => ({
  tasks: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  pause: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
}));
vi.mock('@/app/actions', () => ({
  pauseSeat: actions.pause,
  resumeSeat: vi.fn(),
  setCrewAvatar: vi.fn(),
  setCrewTasksAtOnce: actions.tasks,
  setCrewColor: vi.fn(),
  updateRepoSettings: vi.fn(),
}));

const { PauseControl, TasksAtOnce } = await import('./seat-controls');

const SUBSCRIPTION: ModelAccountRef = { id: 'acct-1', provider: 'openai', kind: 'subscription', label: 'ChatGPT' };
const SEAT = {
  name: 'builder',
  slot: 'builder',
  displayName: 'Builder',
  role: 'implement',
  engine: 'codex',
  model: 'newest:codex',
  githubLogin: 'fleetadlc-atlas-janedoe',
  authorization: 'active',
  modelAccountId: 'acct-1',
  maxTasks: 1,
} as unknown as CrewMember;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  actions.tasks.mockReset();
  actions.pause.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function draw(bot: CrewMember): Promise<void> {
  await act(async () =>
    root.render(
      <RoleProvider role="admin">
        <TasksAtOnce bot={bot} accounts={[SUBSCRIPTION]} />
        <PauseControl bot={bot} now="2026-10-04T12:00:00.000Z" />
      </RoleProvider>,
    ),
  );
}

const select = () => container.querySelector<HTMLSelectElement>('select')!;

describe('tasks at once', () => {
  it('follows the page’s next read, and says to keep a shared sign-in at 1', async () => {
    await draw(SEAT);
    expect(select().value).toBe('1');
    // The panel or another admin set 3; the page's read says so.
    await draw({ ...SEAT, maxTasks: 3 } as CrewMember);
    expect(select().value).toBe('3');
    expect(container.textContent).toContain('Keep this at 1');
  });

  it('paints the stored value back and says so when the call fails outright', async () => {
    actions.tasks.mockRejectedValueOnce(new Error('Failed to find Server Action'));
    await draw(SEAT);
    await act(async () => {
      select().value = '2';
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    // It stayed on "Saving…" with the unsaved value, for good.
    expect(select().value).toBe('1');
    expect(container.textContent).toContain('Not saved: the console did not take that');
  });
});

describe('pausing a seat', () => {
  it('says the console did not answer, rather than taking the page down', async () => {
    actions.pause.mockRejectedValueOnce(new Error('Failed to find Server Action'));
    await draw(SEAT);
    const open = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Pause this seat')!;
    await act(async () => open.click());
    const pause = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Pause')!;
    await act(async () => pause.click());
    await settle();
    expect(container.textContent).toContain('the console did not take that');
  });
});
