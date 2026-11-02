// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSettingsView } from '@/lib/api';

/**
 * Settings → Notifications in a browser: what Save and Send a test send to
 * the bridge, and what they say back.
 */

const calls = vi.hoisted(() => ({
  saved: [] as unknown[],
  test: { ok: true, result: { ok: true, status: 200, error: null } } as { ok: boolean; error?: string; result?: { ok: boolean; status: number | null; error: string | null } },
}));
vi.mock('@/app/actions', () => ({
  saveNotifications: vi.fn(async (update: unknown) => {
    calls.saved.push(update);
    return { ok: true, view: SAVED };
  }),
  testNotifications: vi.fn(async () => calls.test),
}));

const SWITCHES = { gate_opened: true, merge_waiting: true, review_stalled: true, cap_warning: true, promote_waiting: true, check_failing: true };
const SAVED: NotificationSettingsView = {
  source: 'settings',
  kind: 'ntfy',
  server: 'https://ntfy.sh',
  target: '…a1b2',
  switches: SWITCHES,
  last: null,
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.saved = [];
  calls.test = { ok: true, result: { ok: true, status: 200, error: null } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function draw(initial: NotificationSettingsView = SAVED) {
  const { NotificationSettings } = await import('./notification-settings');
  await act(async () => root.render(<NotificationSettings initial={initial} />));
}

const button = (text: string) => [...container.querySelectorAll('button')].find((one) => one.textContent === text) as HTMLButtonElement;

function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Settings → Notifications in a browser', () => {
  it('sends no target when the field is left empty, so the saved one is kept', async () => {
    await draw();
    await act(async () => button('Save').click());
    expect(calls.saved).toHaveLength(1);
    expect(calls.saved[0]).not.toHaveProperty('target');
    expect(calls.saved[0]).toMatchObject({ kind: 'ntfy', switches: SWITCHES });
  });

  it('sends what was typed, and a switch turned off', async () => {
    await draw();
    await act(async () => type('Topic', ' my-private-topic-9z8y '));
    const box = [...container.querySelectorAll('label')].find((label) => label.textContent === 'A review stopped')!.querySelector('input')!;
    await act(async () => box.click());
    await act(async () => button('Save').click());
    expect(calls.saved[0]).toEqual({ kind: 'ntfy', server: 'https://ntfy.sh', target: 'my-private-topic-9z8y', switches: { ...SWITCHES, review_stalled: false } });
    expect(container.textContent).toContain('Saved. Send a test to make sure it reaches you.');
  });

  it('says the test was delivered, with the status', async () => {
    await draw();
    await act(async () => button('Send a test').click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Delivered (200)');
  });

  it('says the status and error when the test was not delivered', async () => {
    calls.test = { ok: true, result: { ok: false, status: 404, error: 'Not Found' } };
    await draw();
    await act(async () => button('Send a test').click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Not delivered: 404 Not Found');
  });

  it('offers no test before there is anywhere to send one', async () => {
    await draw({ ...SAVED, source: 'none', kind: null, server: null, target: null });
    expect(button('Send a test').disabled).toBe(true);
  });

  it('says when the environment’s webhook is in use', async () => {
    await draw({ ...SAVED, source: 'env', kind: 'webhook', server: null, target: 'https://hooks.example.com/…9z8y' });
    expect(container.textContent).toContain('Using OPENADLC_NOTIFY_WEBHOOK. Saving here takes precedence.');
  });
});

describe('the line Settings shows', () => {
  it('says where they go and how the last send went', async () => {
    const { notificationsLine } = await import('./notification-settings');
    const now = '2026-11-02T12:00:00.000Z';
    expect(notificationsLine({ ...SAVED, source: 'none', kind: null, target: null }, now)).toBe('Not set');
    expect(notificationsLine({ ...SAVED, last: { at: '2026-11-02T10:00:00.000Z', event: 'test', ok: true, status: 200, error: null } }, now)).toBe(
      'ntfy · …a1b2 · last sent ok 2 hours ago',
    );
    expect(notificationsLine({ ...SAVED, last: { at: now, event: 'gate_opened', ok: false, status: 404, error: null } }, now)).toBe('ntfy · …a1b2 · Last send failed');
  });
});
