// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, ModelAccountRef } from '@/lib/api';

/**
 * Settings → Crew in a DOM: what each model account offers is listed once
 * per set of accounts, not on every read of the page, and adding a builder
 * when the console does not answer is said, not a broken page.
 */

const seats = vi.hoisted(() => ({ add: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/app/actions', () => ({ addSeat: seats.add, removeSeat: vi.fn() }));

const { CrewTable } = await import('./github-accounts');

const BUILDER: CrewMember = {
  name: 'openadlc-atlas-janedoe',
  slot: 'builder',
  displayName: 'Builder',
  role: 'implement',
  engine: 'claude',
  model: 'claude-sonnet-5',
  status: 'running',
  container: 'bot-builder',
  githubLogin: null,
  authorization: 'unauthorized',
  tokenExpiresAt: null,
  now: 'nothing running',
  paused: false,
  sessions: [],
};

const account = (id: string): ModelAccountRef => ({ id, provider: 'anthropic', kind: 'key', label: id });

let root: Root;
let container: HTMLElement;
let asked: string[];
let sent: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        return Response.json({ error: 'a2 does not offer that model to this bot' }, { status: 409 });
      }
      asked.push(url);
      return Response.json({ error: 'the provider refused the key' }, { status: 502 });
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function draw(accounts: ModelAccountRef[]): Promise<void> {
  await act(async () => root.render(<CrewTable crew={[BUILDER]} accounts={accounts} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe('the crew table’s model accounts', () => {
  it('lists them again only when the set of accounts changes, not on each read of the page', async () => {
    await draw([account('a1')]);
    expect(asked).toHaveLength(1);
    // The page's fifteen-second read: the same accounts, a new array.
    await draw([account('a1')]);
    await draw([account('a1')]);
    expect(asked).toHaveLength(1);
    await draw([account('a1'), account('a2')]);
    expect(asked).toHaveLength(3);
  });
});

describe('the crew table’s one model select', () => {
  async function choose(value: string): Promise<void> {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Model for the builder"]')!;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  it('saves the account and the model of one choice in one request, and shows the bridge’s refusal', async () => {
    await act(async () => root.render(<CrewTable crew={[{ ...BUILDER, modelAccountId: 'a1' }]} accounts={[account('a1'), account('a2')]} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    const other = container.querySelector<HTMLOptGroupElement>('optgroup[label="a2"]')!.querySelector('option')!;
    await choose(other.value);

    expect(sent).toEqual([
      { url: '/api/bots/openadlc-atlas-janedoe/assignment', method: 'PATCH', body: { model: 'claude-sonnet-5', modelAccountId: 'a2' } },
    ]);
    expect(container.textContent).toContain('a2 does not offer that model to this bot');
  });

  it('sends nothing for the choice already saved', async () => {
    await act(async () => root.render(<CrewTable crew={[{ ...BUILDER, modelAccountId: 'a1' }]} accounts={[account('a1'), account('a2')]} />));
    await choose(JSON.stringify(['a1', 'claude-sonnet-5']));
    expect(sent).toEqual([]);
  });
});

describe('adding a builder', () => {
  it('says the console did not answer, rather than taking the page down', async () => {
    seats.add.mockRejectedValueOnce(new Error('Failed to find Server Action'));
    await draw([]);
    const add = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Add a builder')!;
    await act(async () => add.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain('the console did not take that');
  });
});
