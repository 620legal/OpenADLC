// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignMemoryEntry } from '@/lib/api';

/**
 * Correcting a repository's design memory in a DOM: the form starts from what
 * is saved, and a supersede is two writes, each one waited for and its
 * refusal said.
 */

const bridge = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  /** The answer for each write, in turn; past the end, the write is taken. */
  answers: [] as ({ ok: false; error: string } | 'reject')[],
}));
vi.mock('@/app/actions', () => ({
  updateDesignMemory: vi.fn(async (_repo: string, patch: Record<string, unknown>) => {
    bridge.sent.push(patch);
    const next = bridge.answers.shift();
    if (next === 'reject') throw new Error('Failed to find Server Action');
    if (next) return next;
    return { ok: true, entry: { ...ENTRY, ...patch } };
  }),
}));

const ENTRY: DesignMemoryEntry = {
  id: 'a',
  repoId: 'repo-1',
  kind: 'decision',
  title: 'Costs per round',
  body: 'Each review round records its own cost.',
  state: 'accepted',
  supersedes: null,
  sourceSubject: null,
  sourceUrl: null,
  adrPath: null,
  proposedBy: 'acme-crew',
  decidedBy: null,
  decidedAt: null,
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
};
const OTHER: DesignMemoryEntry = { ...ENTRY, id: 'b', title: 'Costs per task' };

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  bridge.sent.length = 0;
  bridge.answers.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLElement> {
  const { DesignMemorySection } = await import('./design-memory');
  await act(async () => root.render(<DesignMemorySection repo="api" entries={[ENTRY, OTHER]} />));
  return container.querySelector<HTMLElement>('[data-memory="a"]')!;
}

function button(label: string, within: ParentNode): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}`);
  return found;
}

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe('editing an entry', () => {
  it('starts from what is saved after a cancelled edit, so Save never stores it', async () => {
    const entry = await mount();
    await act(async () => button('Edit', entry).click());
    const title = entry.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Something abandoned');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Cancel', entry).click());

    await act(async () => button('Edit', entry).click());
    expect(entry.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.value).toBe('Costs per round');
    await act(async () => button('Save', entry).click());
    await settle();
    expect(bridge.sent).toEqual([{ id: 'a', title: 'Costs per round', body: 'Each review round records its own cost.' }]);
  });
});

describe('superseding an entry', () => {
  async function supersede(entry: HTMLElement, by: string): Promise<void> {
    const select = entry.querySelector('select')!;
    await act(async () => {
      select.value = by;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  }

  it('waits for each write, sends the next only once the last was taken, and says a refusal of either', async () => {
    let entry = await mount();
    // The first write fails outright: the second is not sent, and the failure is said.
    bridge.answers.push('reject');
    await supersede(entry, 'b');
    expect(bridge.sent).toEqual([{ id: 'b', supersedes: 'a' }]);
    expect(entry.querySelector('[role="alert"]')?.textContent).toContain('the console did not take that');

    // The second is refused: said beside the entry, which is still in effect.
    bridge.sent.length = 0;
    bridge.answers.push({ ok: true, entry: { ...OTHER, supersedes: 'a' } } as never, { ok: false, error: 'this needs an admin' });
    entry = container.querySelector<HTMLElement>('[data-memory="a"]')!;
    await supersede(entry, 'b');
    expect(bridge.sent).toEqual([
      { id: 'b', supersedes: 'a' },
      { id: 'a', state: 'superseded' },
    ]);
    expect(container.querySelector('[data-memory="a"] [role="alert"]')?.textContent).toBe('this needs an admin');
  });
});
