// @vitest-environment happy-dom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSettingsView } from '@/lib/api';

/**
 * Settings → Notifications' switches in a browser: what Save sends the
 * bridge, and what it says back. There is nothing else to set: push to the
 * console app is the only channel (ADR 0049).
 */

const calls = vi.hoisted(() => ({
  saved: [] as unknown[],
  answer: null as null | { ok: boolean; error?: string },
}));
vi.mock('@/app/actions', () => ({
  saveNotifications: vi.fn(async (update: { switches: Record<string, boolean> }) => {
    calls.saved.push(update);
    return calls.answer ?? { ok: true, view: { switches: { ...SWITCHES, ...update.switches } } };
  }),
}));

const SWITCHES = { gate_opened: true, merge_waiting: true, review_stalled: true, cap_warning: true, promote_waiting: true, check_failing: true };
const SAVED: NotificationSettingsView = { switches: SWITCHES };

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.saved = [];
  calls.answer = null;
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

const button = (text: string) => [...container.querySelectorAll('button')].find((one) => one.textContent === text) as HTMLButtonElement | undefined;

describe('Settings → Notifications in a browser', () => {
  it('has the switches and Save, and no kind, server, target or test', async () => {
    await draw();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(6);
    expect(container.querySelectorAll('input:not([type="checkbox"])')).toHaveLength(0);
    expect(button('Save')).toBeDefined();
    expect(button('Send a test')).toBeUndefined();
    expect(container.textContent).not.toMatch(/ntfy|slack|webhook/i);
  });

  it('sends the switches alone, with one turned off', async () => {
    await draw();
    const box = [...container.querySelectorAll('label')].find((label) => label.textContent === 'A review stopped')!.querySelector('input')!;
    await act(async () => box.click());
    await act(async () => button('Save')!.click());
    expect(calls.saved).toEqual([{ switches: { ...SWITCHES, review_stalled: false } }]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved.');
  });

  it('says what the bridge refused', async () => {
    calls.answer = { ok: false, error: 'switches is an object of kinds, each true or false' };
    await draw();
    await act(async () => button('Save')!.click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe('switches is an object of kinds, each true or false');
  });
});

describe('the card Settings shows', () => {
  it('says push, how many devices the signed-in person has, and how many kinds are off, and names no transport', async () => {
    const { notificationsLine, NotificationsSummary } = await import('./notification-settings');
    expect(notificationsLine(SAVED, 2)).toBe('Push to the console app · on your 2 devices');
    expect(notificationsLine(SAVED, 1)).toBe('Push to the console app · on your device');
    expect(notificationsLine(SAVED, 0)).toBe('Push to the console app · not on any of your devices yet');
    expect(notificationsLine({ switches: { ...SWITCHES, cap_warning: false } }, null)).toBe('Push to the console app · 1 kind off');
    expect(notificationsLine(null, null)).toBe('Push to the console app');
    const html = renderToStaticMarkup(<NotificationsSummary view={SAVED} devices={1} />);
    expect(html).not.toMatch(/ntfy|slack|webhook|OPENADLC_NOTIFY_WEBHOOK/i);
  });
});
