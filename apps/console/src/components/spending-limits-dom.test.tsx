// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpendingLimitsView } from '@/lib/api';
import { SpendingLimits, SpendingLimitsPanel } from './spending-limits';

const VIEW: SpendingLimitsView = {
  period: '2026-09',
  global: {
    monthTotal: { amountUsd: 1500, spentUsd: 7.51 },
    task: { amountUsd: 15, spentUsd: null },
    bots: [{ botId: 'bot-1', name: 'builder', amountUsd: null, spentUsd: 2 }],
    providers: [],
  },
  repos: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('spending limits with an amount that is not one', () => {
  it('refuses to save, says which field and what to write, and keeps what was typed', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const saves: unknown[] = [];
    await act(async () =>
      root.render(<SpendingLimitsPanel view={VIEW} busy={false} notice={null} error={null} onSave={(changes) => saves.push(changes)} />),
    );

    const bot = host.querySelector<HTMLInputElement>('input[aria-label="builder"]')!;
    await type(bot, '$500');
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Each task"]')!, '200');

    const save = [...host.querySelectorAll('button')].find((one) => one.textContent === 'Save')!;
    expect(save.disabled).toBe(true);
    await act(async () => save.click());
    expect(saves).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('builder: $500 is not an amount in dollars; write 500');
    expect(bot.getAttribute('aria-invalid')).toBe('true');
    expect(bot.value).toBe('$500');

    await type(bot, '500');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(save.disabled).toBe(false);
    act(() => root.unmount());
  });
});

describe('saving the limits when the answer is not the bridge’s', () => {
  it('says what came back, not a JSON SyntaxError', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html><p>Bad gateway</p>', { status: 502 })));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<SpendingLimits initial={VIEW} />));
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Each task"]')!, '200');
    const save = [...host.querySelectorAll('button')].find((one) => one.textContent === 'Save')!;
    await act(async () => save.click());
    expect(host.textContent).toContain('Bad gateway');
    expect(host.textContent).not.toMatch(/not valid JSON|Unexpected token/);
    act(() => root.unmount());
  });
});
