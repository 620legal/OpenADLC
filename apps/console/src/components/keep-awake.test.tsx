// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallSettings } from './install-settings';

/**
 * Settings → System's keep-awake row in a browser: drawn only where the
 * bridge's host can be held awake, saying what it does now, and saving the
 * switch through PATCH /api/install.
 */

const INSTALL: InstallSettings = {
  organization: 'janedoe',
  githubClientId: 'Iv23client',
  automationBot: 'janedoe-openadlc-flow',
  humans: 'janedoe',
  publicUrl: '',
  operatorEmail: '',
  webhookSecretConfigured: true,
  appPrivateKeyConfigured: true,
  storedKeys: [],
  webhookUrl: '',
};

let root: Root;
let container: HTMLElement;
let sent: unknown[];
let answer: InstallSettings;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ written: ['keepAwake'] }), { status: 200 });
      }
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function draw(keepAwake: InstallSettings['keepAwake']): Promise<HTMLButtonElement | undefined> {
  const { KeepAwake } = await import('./keep-awake');
  // A page drawn afresh: the row keeps what it read until it saves.
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ul><KeepAwake install={{ ...INSTALL, keepAwake }} /></ul>));
  return [...container.querySelectorAll('button')][0];
}

describe('keep-awake in Settings → System', () => {
  it('is not drawn where the host cannot be held awake, or the bridge does not say', async () => {
    expect(await draw({ available: false, on: true, holding: false })).toBeUndefined();
    expect(container.querySelector('#keep-awake')).toBeNull();
    expect(await draw(undefined)).toBeUndefined();
    expect(container.querySelector('#keep-awake')).toBeNull();
  });

  it('says what it does now', async () => {
    await draw({ available: true, on: true, holding: true });
    expect(container.textContent).toContain('Holding the Mac awake now');
    await draw({ available: true, on: true, holding: false });
    expect(container.textContent).toContain('Not holding: nothing in flight');
    await draw({ available: true, on: false, holding: false });
    expect(container.textContent).toContain('Off');
    expect(container.textContent).toContain('Keeps this Mac from sleeping while the crew has work in flight, and lets it sleep a minute after.');
  });

  it('turns it off, and says so once the bridge answers', async () => {
    answer = { ...INSTALL, keepAwake: { available: true, on: false, holding: false } };
    const button = await draw({ available: true, on: true, holding: true });
    expect(button?.textContent).toBe('Turn off');
    await act(async () => button!.click());
    expect(sent).toEqual([{ keepAwake: 'off' }]);
    expect(container.textContent).toContain('Off');
    expect(container.querySelector('button')?.textContent).toBe('Turn on');
  });

  it('turns it on', async () => {
    answer = { ...INSTALL, keepAwake: { available: true, on: true, holding: false } };
    const button = await draw({ available: true, on: false, holding: false });
    await act(async () => button!.click());
    expect(sent).toEqual([{ keepAwake: 'on' }]);
    expect(container.textContent).toContain('Not holding: nothing in flight');
  });
});
