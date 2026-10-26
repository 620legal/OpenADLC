// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressHostsView } from '@/lib/api';

/**
 * Settings → Egress in a browser: what Allow and Enter send to the bridge.
 */

const saved = vi.hoisted(() => ({ calls: [] as string[][], answer: null as Promise<{ ok: boolean; hosts?: string[]; error?: string }> | null }));
vi.mock('@/app/actions', () => ({
  saveEgressHosts: vi.fn(async (hosts: string[]) => {
    saved.calls.push(hosts);
    return saved.answer ?? { ok: true, hosts };
  }),
}));

const CLOUD: EgressHostsView = { hosts: ['acme.example'], proxied: true, settingsList: true, reason: null };

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  saved.calls = [];
  saved.answer = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function draw(offered: string, hosts = CLOUD.hosts): Promise<{ field: HTMLInputElement; allow: HTMLButtonElement }> {
  const { EgressHosts } = await import('./egress-hosts');
  await act(async () => root.render(<EgressHosts initial={{ ...CLOUD, hosts }} offered={offered} />));
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Host name to allow"]')!;
  const allow = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Allow') as HTMLButtonElement;
  return { field, allow };
}

const enter = (field: HTMLInputElement) => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

describe('Settings → Egress in a browser', () => {
  it('saves the list as it is when the offered host is one it already lets through, so hostd puts it on the proxy again', async () => {
    for (const hosts of [['testing.acme.example'], ['acme.example']]) {
      saved.calls = [];
      const { allow } = await draw('testing.acme.example', hosts);
      await act(async () => allow.click());
      expect(saved.calls).toEqual([hosts]);
      expect(container.textContent).toContain(`The list is saved again, and hostd put ${hosts[0]} on the egress proxy`);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('makes one save of a host pressed Enter on twice, and takes nothing in the field until that save is done', async () => {
    let done!: (answer: { ok: boolean; hosts: string[] }) => void;
    saved.answer = new Promise((resolve) => (done = resolve));
    const { field } = await draw('web-1234-uc.a.run.app');
    await act(async () => enter(field));
    expect(field.disabled).toBe(true);
    await act(async () => enter(field));
    expect(saved.calls).toEqual([['acme.example', 'web-1234-uc.a.run.app']]);

    await act(async () => done({ ok: true, hosts: ['acme.example', 'web-1234-uc.a.run.app'] }));
    expect(field.disabled).toBe(false);
    expect(container.textContent).toContain('web-1234-uc.a.run.app is allowed, and on the egress proxy now');
  });
});
