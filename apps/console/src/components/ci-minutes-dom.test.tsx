// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiMinutesView } from '@/lib/api';
import { RoleProvider } from './app-header';

const saved: (number | null)[] = [];
const answer = { next: { ok: true } as { ok: boolean; error?: string } };
vi.mock('@/app/actions', () => ({
  setCiCap: vi.fn(async (minutes: number | null) => {
    saved.push(minutes);
    return answer.next;
  }),
}));

const { CiMinutes } = await import('./ci-minutes');

const CI: CiMinutesView = {
  since: '2026-10-01T00:00:00.000Z',
  minutes: 1_270,
  billedMinutes: 1_240,
  estimatedUsd: 9.92,
  runs: 140,
  byRepo: [
    { repo: 'api', minutes: 1_000, billedMinutes: 1_000, runs: 100 },
    { repo: 'site', minutes: 270, billedMinutes: 240, runs: 40 },
  ],
  byPullRequest: [{ repo: 'api', prNumber: 7, minutes: 60, runs: 6 }],
  cap: null,
  capReached: null,
};

afterEach(() => {
  saved.length = 0;
  answer.next = { ok: true };
  document.body.innerHTML = '';
});

async function mount(ci: CiMinutesView, role: 'admin' | 'user' = 'admin') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <RoleProvider role={role}>
        <CiMinutes ci={ci} />
      </RoleProvider>,
    );
  });
  return host;
}

async function setCap(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Monthly cap on GitHub Actions minutes"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click();
  });
}

describe('GitHub Actions minutes on the Costs page', () => {
  it('says the month’s billed minutes and their estimate, the free ones apart, by repository and pull request', async () => {
    const host = await mount(CI);
    const text = host.textContent ?? '';
    expect(text).toContain('1,240billed minutes · about $9.92');
    expect(text).toContain('140 runs this month · 30 more minutes free, on public repositories');
    expect(text).toContain('api');
    expect(text).toContain('#7');
  });

  it('says why no more CI is asked for at the cap', async () => {
    const host = await mount({ ...CI, cap: 1_000, capReached: 'GitHub Actions minutes this month reached the cap of 1,000 (1,240 used): no more CI is asked for until it is raised in Costs, or the month turns' });
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/reached the cap of 1,000/);
    expect(host.textContent).toContain('billed minutes of 1,000');
  });

  it('draws a cap of 0 as reached, a full bar, not an empty green one', async () => {
    const host = await mount({ ...CI, cap: 0, capReached: 'GitHub Actions minutes this month reached the cap of 0' });
    const bar = host.querySelector<HTMLElement>('.bg-alarm');
    expect(bar?.style.width).toBe('100%');
    expect(host.querySelector('.bg-signal[style]')).toBeNull();
  });

  it('lets an admin set the cap, or clear it, and only an admin', async () => {
    expect((await mount(CI, 'user')).querySelector('input')).toBeNull();
    document.body.innerHTML = '';

    const host = await mount(CI);
    await setCap(host, '3000');
    await setCap(host, '');
    expect(saved).toEqual([3000, null]);
  });

  it('refuses what is not a whole number, and says the bridge’s refusal', async () => {
    const host = await mount(CI);
    await setCap(host, '2.5');
    expect(saved).toEqual([]);
    expect(host.textContent).toContain('a whole number of minutes, or empty for no cap');

    answer.next = { ok: false, error: 'only an admin can change that' };
    await setCap(host, '100');
    expect(host.textContent).toContain('only an admin can change that');
  });
});
