// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_STARTERS } from '@/lib/request-starters';

/** The New request form's starters: shown while it is empty, filling it on a click. */

const filing = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
vi.mock('@/app/actions', () => ({
  fileRequest: vi.fn(async (input: Record<string, unknown>) => {
    filing.sent.push(input);
    return { ok: true, bot: 'ottoexampleco', queued: false, position: null };
  }),
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  filing.sent.length = 0;
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function dialog(): HTMLElement {
  return document.querySelector('[role="dialog"]') as HTMLElement;
}

function button(label: string, within: ParentNode = dialog()): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${[...within.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

function starters(): HTMLElement | null {
  return dialog().querySelector('[role="group"][aria-label="Starters"]');
}

function areas(): { text: HTMLTextAreaElement; details: HTMLTextAreaElement } {
  const [text, details] = [...dialog().querySelectorAll('textarea')] as HTMLTextAreaElement[];
  return { text: text!, details: details! };
}

function selects(): { repo: HTMLSelectElement; kind: HTMLSelectElement } {
  const [repo, kind] = [...dialog().querySelectorAll('select')] as HTMLSelectElement[];
  return { repo: repo!, kind: kind! };
}

async function type(area: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function press(label: string): Promise<void> {
  await act(async () => button(label).click());
  await settle();
}

async function openDialog(): Promise<void> {
  const { IntakeDialog } = await import('./intake-dialog');
  await act(async () => root.render(<IntakeDialog repos={['api', 'web']} defaultRepo="api" />));
  await act(async () => button('+ New request', container).click());
  await settle();
}

describe('the New request form’s starters', () => {
  it('shows the four starters while the form is empty', async () => {
    await openDialog();
    const group = starters();
    expect(group).not.toBeNull();
    expect([...group!.querySelectorAll('button')].map((one) => one.textContent)).toEqual([
      'A bug, with steps',
      'A small feature',
      'A docs fix',
      'Tests for a module',
    ]);
  });

  it.each(REQUEST_STARTERS.map((starter) => [starter.label, starter] as const))(
    '%s fills the request, Details and Kind and keeps the repository',
    async (label, starter) => {
      await openDialog();
      await choose(selects().repo, 'web');
      await act(async () => button(label, starters()!).click());

      expect(areas().text.value).toBe(starter.text);
      expect(areas().details.value).toBe(starter.details);
      expect(selects().kind.value).toBe(starter.kind);
      expect(selects().repo.value).toBe('web');
      // Filled, the form is no longer empty, so the starters are gone.
      expect(starters()).toBeNull();
    },
  );

  it('hides once either box has text and comes back once both are cleared', async () => {
    await openDialog();

    await type(areas().text, 'A Tetris game');
    expect(starters()).toBeNull();
    expect(areas().text.value).toBe('A Tetris game');
    await type(areas().text, '');
    expect(starters()).not.toBeNull();

    await type(areas().details, 'For the kids');
    expect(starters()).toBeNull();
    expect(areas().details.value).toBe('For the kids');
    await type(areas().details, '');
    expect(starters()).not.toBeNull();

    // Whitespace only is still empty.
    await type(areas().text, '  ');
    await type(areas().details, '\n');
    expect(starters()).not.toBeNull();
  });

  it('shows again on the emptied form after Send & add another', async () => {
    await openDialog();
    await act(async () => button('A bug, with steps', starters()!).click());
    await press('Send & add another');

    expect(filing.sent).toEqual([expect.objectContaining({ text: REQUEST_STARTERS[0]!.text, kind: 'defect', repo: 'api' })]);
    expect(areas().text.value).toBe('');
    expect(starters()).not.toBeNull();
  });

  it('shows again on the emptied form after Send another', async () => {
    await openDialog();
    await type(areas().text, 'A Tetris game');
    await press('Send to intake');
    expect(dialog().querySelector('textarea')).toBeNull();

    await press('Send another');
    expect(areas().text.value).toBe('');
    expect(starters()).not.toBeNull();
  });
});
