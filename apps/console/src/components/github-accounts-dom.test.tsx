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

const account = (id: string, label = id): ModelAccountRef => ({ id, provider: 'anthropic', kind: 'key', label });

let root: Root;
let container: HTMLElement;
let asked: string[];
let sent: { url: string; method: string; body: unknown }[];
/** What each account lists, by id; an account not here fails to list. */
let lists: Record<string, string[]>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  sent = [];
  lists = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        return Response.json({ error: 'a2 does not offer that model to this bot' }, { status: 409 });
      }
      asked.push(url);
      const id = decodeURIComponent(/^\/api\/model-accounts\/([^/]+)\/models$/.exec(url)?.[1] ?? '');
      const models = lists[id];
      if (models) return Response.json({ models: models.map((model) => ({ id: model, createdAt: null })) });
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

  async function drawSaved(accounts: ModelAccountRef[]): Promise<void> {
    await act(async () => root.render(<CrewTable crew={[{ ...BUILDER, modelAccountId: 'a1' }]} accounts={accounts} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  const options = (group: Element) => [...group.querySelectorAll('option')].map((option) => option.value);

  it('saves the account and the model of one choice in one request, and shows the bridge’s refusal', async () => {
    lists = { a2: ['claude-opus-5-5', 'claude-haiku-5'] };
    await drawSaved([account('a1'), account('a2')]);

    // Not the bot's own model and not what a move to a2 would propose, so a
    // request carrying either of those in place of the choice fails here.
    const chosen = JSON.stringify(['a2', 'claude-haiku-5']);
    expect(options(container.querySelector('optgroup[label="a2"]')!)).toContain(chosen);
    await choose(chosen);

    expect(sent).toEqual([
      { url: '/api/bots/openadlc-atlas-janedoe/assignment', method: 'PATCH', body: { model: 'claude-haiku-5', modelAccountId: 'a2' } },
    ]);
    expect(container.textContent).toContain('a2 does not offer that model to this bot');
  });

  it('sends nothing for the choice already saved', async () => {
    await drawSaved([account('a1'), account('a2')]);
    await choose(JSON.stringify(['a1', 'claude-sonnet-5']));
    expect(sent).toEqual([]);
  });

  it('keeps both groups of two accounts that share a label once their lists arrive', async () => {
    lists = { a1: ['claude-opus-5-5'], a2: ['claude-haiku-5'] };
    // React keeps one child per key and says so; what it keeps of two groups
    // under one key is not defined, so the warning is the failure.
    const warned = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await drawSaved([account('a1', 'Anthropic — API key'), account('a2', 'Anthropic — API key')]);
    expect(warned.mock.calls.map((call) => String(call[0]))).not.toContainEqual(expect.stringContaining('same key'));
    warned.mockRestore();

    const groups = [...container.querySelectorAll('select[aria-label="Model for the builder"] optgroup')];
    expect(groups.map((group) => group.getAttribute('label'))).toEqual(['Anthropic — API key', 'Anthropic — API key']);
    expect(options(groups[0]!)).toContain(JSON.stringify(['a1', 'claude-opus-5-5']));
    expect(options(groups[1]!)).toEqual([JSON.stringify(['a2', 'claude-haiku-5'])]);
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
