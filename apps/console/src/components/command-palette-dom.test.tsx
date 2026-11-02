// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pauseWork, resumeWork } from '@/app/actions';
import type { JumpItem, PaletteRead, Role } from '@/lib/api';
import { headerData } from '@/lib/header';
import { RoleProvider } from './app-header';
import { CommandPalette } from './command-palette';

/**
 * The command palette in a DOM: ⌘K from anywhere, even a text field, opens it
 * and closes it again; what is typed finds an item, and Enter opens it; the
 * jump list is read each time it opens and nowhere else; and it offers only
 * what the person's role may do.
 */

vi.mock('@/app/actions', () => ({
  pauseWork: vi.fn(async () => ({ ok: true, pauses: { paused: { by: 'ada', at: '2026-11-02T10:00:00.000Z', reason: 'why' }, repos: {} } })),
  resumeWork: vi.fn(async () => ({ ok: true })),
  fileRequest: vi.fn(async () => ({ ok: true, bot: 'intake', queued: false, position: null })),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

function jump(number: number, partial: Partial<JumpItem> = {}): JumpItem {
  return { key: `acme-${number}`, number, title: `Item ${number}`, refs: [], open: true, closedAt: null, ...partial };
}

const ITEMS = [jump(2130, { title: 'Later work' }), jump(17, { title: 'Holds api#213', refs: ['api#213'] }), jump(213, { title: 'Add a command palette' })];

let answer: { status: number; body: PaletteRead | { error: string } };
let reads: string[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  answer = { status: 200, body: { items: ITEMS, numbered: true, itemsError: null, paused: false } };
  reads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      reads.push(String(url));
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  router.push.mockClear();
  vi.mocked(pauseWork).mockClear();
  vi.mocked(resumeWork).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const DATA = headerData({ repos: ['api', 'web'], repoColors: { api: 'amber', web: 'blue' }, crew: [], budget: null, needsYou: 0 });

async function mount(role: Role = 'admin'): Promise<void> {
  await act(async () =>
    root.render(
      <RoleProvider role={role}>
        <input aria-label="A field on the page" />
        <CommandPalette data={DATA} />
      </RoleProvider>,
    ),
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function key(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

const palette = () => document.querySelector('[data-command-palette]') as HTMLElement | null;
const search = () => palette()!.querySelector('[role="combobox"]') as HTMLInputElement;
const options = () => [...palette()!.querySelectorAll('[role="option"]')] as HTMLElement[];
const optionNamed = (label: string) => options().find((one) => one.textContent === label);
const groupLabels = () => [...palette()!.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label'));

async function open(): Promise<void> {
  await key({ key: 'k', metaKey: true });
  expect(palette()).not.toBeNull();
}

async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), text);
    search().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('opening and closing', () => {
  it('opens on ⌘K while a text field has focus, named for a screen reader, and closes on ⌘K again', async () => {
    await mount();
    const field = container.querySelector('input')!;
    field.focus();
    await key({ key: 'k', metaKey: true }, field);
    const dialog = palette()!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Command palette');
    expect(document.activeElement).toBe(search());

    await key({ key: 'k', metaKey: true });
    expect(palette()).toBeNull();
  });

  it('closes on Esc', async () => {
    await mount();
    await open();
    await key({ key: 'Escape' });
    expect(palette()).toBeNull();
  });

  it('is Ctrl+K off a Mac, and Ctrl+K on a Mac is left to the field', async () => {
    await mount();
    await key({ key: 'k', ctrlKey: true });
    expect(palette()).toBeNull();
    // The platform is read as the palette mounts.
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    await key({ key: 'k', ctrlKey: true });
    expect(palette()).not.toBeNull();
  });
});

describe('jumping to an item', () => {
  it('finds item 213 first from "213", and Enter opens its page', async () => {
    await mount();
    await open();
    await type('213');
    expect(options()[0]!.textContent).toContain('acme-213');
    expect(search().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    await key({ key: 'Enter' }, search());
    expect(router.push).toHaveBeenCalledWith('/items/acme-213');
    expect(palette()).toBeNull();
  });

  it('moves the active row with the arrows, Home and End, and stops at the ends', async () => {
    await mount();
    await open();
    const active = () => search().getAttribute('aria-activedescendant');
    expect(active()).toBe(options()[0]!.id);
    await key({ key: 'ArrowUp' }, search());
    expect(active()).toBe(options()[0]!.id);
    await key({ key: 'ArrowDown' }, search());
    expect(active()).toBe(options()[1]!.id);
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    await key({ key: 'End' }, search());
    expect(active()).toBe(options().at(-1)!.id);
    await key({ key: 'ArrowDown' }, search());
    expect(active()).toBe(options().at(-1)!.id);
    await key({ key: 'Home' }, search());
    expect(active()).toBe(options()[0]!.id);
  });

  it('keeps the row moved to while the items load, once they arrive above it', async () => {
    let arrive: () => void = () => undefined;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          arrive = () => resolve(new Response(JSON.stringify(answer.body), { status: 200, headers: { 'content-type': 'application/json' } }));
        }),
    );
    await mount();
    await open();
    const active = () => search().getAttribute('aria-activedescendant');
    await key({ key: 'ArrowDown' }, search());
    const moved = options()[1]!;
    expect(active()).toBe(moved.id);
    await act(async () => arrive());
    await settle();
    expect(options().length).toBeGreaterThan(ITEMS.length);
    expect(active()).toBe(moved.id);
    expect(document.getElementById(active()!)?.textContent).toBe(moved.textContent);
  });

  it('selects the first loaded item when nothing was moved while loading', async () => {
    let arrive: () => void = () => undefined;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          arrive = () => resolve(new Response(JSON.stringify(answer.body), { status: 200, headers: { 'content-type': 'application/json' } }));
        }),
    );
    await mount();
    await open();
    await act(async () => arrive());
    await settle();
    expect(options()[0]!.textContent).toContain('acme-');
    expect(search().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  });

  it('reads the jump list once each time it opens', async () => {
    await mount();
    expect(reads).toEqual([]);
    await open();
    await key({ key: 'Escape' });
    await open();
    expect(reads).toEqual(['/api/palette', '/api/palette']);
  });

  it('says when the items could not be read, and still goes places and acts', async () => {
    answer = { status: 503, body: { error: 'the bridge is not answering' } };
    await mount();
    await open();
    expect(palette()!.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load items: the bridge is not answering. Go to and Act still work.");
    expect(groupLabels()).toEqual(['Items', 'Go to', 'Act']);
    await type('costs');
    await key({ key: 'Enter' }, search());
    expect(router.push).toHaveBeenCalledWith('/costs');
  });
});

describe('what it offers', () => {
  it('lists Settings and Pause work for an admin, and not for a user', async () => {
    await mount('user');
    await open();
    expect(optionNamed('Settings')).toBeUndefined();
    expect(optionNamed('Pause work')).toBeUndefined();
    expect(optionNamed('Needs you')).toBeDefined();
    expect(optionNamed('New request')).toBeDefined();
    await key({ key: 'Escape' });

    await mount('admin');
    await open();
    expect(optionNamed('Settings')).toBeDefined();
    expect(optionNamed('Pause work')).toBeDefined();
  });

  it('lists Resume only while something is paused', async () => {
    await mount();
    await open();
    expect(optionNamed('Resume')).toBeUndefined();
    await key({ key: 'Escape' });

    answer = { status: 200, body: { items: ITEMS, numbered: true, itemsError: null, paused: true } };
    await open();
    expect(optionNamed('Resume')).toBeDefined();
  });

  it('Resume goes to Settings’ Pause work card, closes, and resumes nothing', async () => {
    answer = { status: 200, body: { items: ITEMS, numbered: true, itemsError: null, paused: true } };
    await mount();
    await open();
    await type('resume');
    await key({ key: 'Enter' }, search());
    expect(router.push).toHaveBeenCalledWith('/settings#pause');
    expect(palette()).toBeNull();
    expect(resumeWork).not.toHaveBeenCalled();
  });

  it('Pause work asks why and which repositories, and pauses the ones chosen', async () => {
    await mount();
    await open();
    await type('pause');
    await key({ key: 'Enter' }, search());
    const form = palette()!;
    const radio = [...form.querySelectorAll('input[type="radio"]')].find((one) => (one as HTMLInputElement).value === 'chosen') as HTMLInputElement;
    await act(async () => radio.click());
    const api = form.querySelector('input[type="checkbox"][value="api"]') as HTMLInputElement;
    await act(async () => api.click());
    const why = form.querySelector('input:not([type])') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(why, 'an account may be compromised');
      why.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = (label: string) => [...form.querySelectorAll('button')].find((one) => one.textContent === label)!;
    await act(async () => button('Pause work').click());
    await act(async () => button('Confirm').click());
    await settle();
    expect(pauseWork).toHaveBeenCalledWith('an account may be compromised', ['api']);
    expect(palette()).toBeNull();
  });

  it('Esc in Pause work goes back to the list', async () => {
    await mount();
    await open();
    await type('pause');
    await key({ key: 'Enter' }, search());
    expect(palette()!.querySelector('[role="combobox"]')).toBeNull();
    await key({ key: 'Escape' });
    expect(palette()).not.toBeNull();
    expect(palette()!.querySelector('[role="combobox"]')).not.toBeNull();
  });

  it('New request opens the New request dialog', async () => {
    await mount();
    await open();
    await type('new request');
    await key({ key: 'Enter' }, search());
    expect(palette()).toBeNull();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('New request');
    expect(dialog?.textContent).toContain('What do you want changed?');
  });
});
