// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CrewStep } from './crew-step';
import type { GitHubAccountsView } from '@/lib/api';
import type { AccountRef, CrewBot } from '@/lib/model-onboarding';

const VIEW: GitHubAccountsView = {
  accounts: [
    { login: 'fleetadlc-builder-acme', url: '', group: null, signIn: 'signed-in', seats: [], connectedAt: '2026-10-01T10:00:00Z' },
    { login: 'fleetadlc-lead-reviewer-acme', url: '', group: null, signIn: 'signed-in', seats: [], connectedAt: '2026-10-01T10:05:00Z' },
  ],
  bots: [
    { name: 'builder', slot: 'builder', role: 'implement', roleLabel: 'builder', group: 'crew', login: null, choices: [] },
    { name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', roleLabel: 'lead reviewer', group: 'reviewers', login: null, choices: [] },
  ],
};
VIEW.bots.forEach((one) => (one.choices = VIEW.accounts.map((account) => ({ login: account.login, refusal: null }))));

const MAX: AccountRef = { id: 'max', provider: 'anthropic', kind: 'subscription', label: 'Max', verifiedAt: '2026-10-01T00:00:00Z', verifyError: null };
const CREW: CrewBot[] = [
  { bot: 'builder', slot: 'builder', role: 'implement', roleLabel: 'builder', engine: 'claude', model: 'claude-sonnet-5', modelAccountId: 'max', readiness: null },
  { bot: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', roleLabel: 'lead reviewer', engine: 'claude', model: 'claude-opus-5', modelAccountId: 'max', readiness: null },
];

async function mount(assign: (body: { bot: string; login: string }) => Response) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url === '/api/github/identities') return new Response(JSON.stringify(VIEW));
      if (url === '/api/github/accounts/assign') return assign(body);
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [], aliases: [] }));
      return new Response('{}');
    }),
  );
  const onContinue = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<CrewStep crew={CREW} accounts={[MAX]} onCrew={() => undefined} onSaved={() => undefined} onContinue={onContinue} />);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const save = async () =>
    act(async () => {
      [...container.querySelectorAll('button')].find((el) => el.textContent === 'Save crew and continue')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const done = () => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  };
  return { container, calls, onContinue, save, done };
}

describe('saving the crew', () => {
  it('opens on the crew worked out, saves each seat’s account with one button, and goes on', async () => {
    const { container, calls, onContinue, save, done } = await mount(() => new Response('{}'));
    expect(container.textContent).toContain('Your crew is ready.');
    expect(container.textContent).toContain('Does the work');
    await save();
    expect(calls.filter((call) => call.url === '/api/github/accounts/assign').map((call) => call.body)).toEqual([
      { bot: 'builder', login: 'fleetadlc-builder-acme' },
      { bot: 'lead-reviewer', login: 'fleetadlc-lead-reviewer-acme' },
    ]);
    expect(onContinue).toHaveBeenCalledOnce();
    done();
  });

  it('stays, with the table open and the reason by its seat, when a seat is refused', async () => {
    const { container, onContinue, save, done } = await mount((body) =>
      body.bot === 'lead-reviewer'
        ? new Response(JSON.stringify({ error: 'that account cannot approve the builder’s work' }), { status: 409 })
        : new Response('{}'),
    );
    await save();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).toContain('lead reviewer: that account cannot approve the builder’s work');
    done();
  });
});

describe('saving a fresh crew, one GitHub account per seat', () => {
  /**
   * The bridge as it answers: putting a seat alone on an account renames it to
   * the account's handle, an account is assigned by the seat's name, and a
   * model by its name or its seat.
   */
  function standIn() {
    const seats = CREW.map((one) => ({ ...one, modelAccountId: null as string | null, login: null as string | null }));
    const calls: { method: string; url: string; body: unknown }[] = [];
    const answer = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? 'GET', url, body });
      if (url === '/api/github/identities') {
        return new Response(
          JSON.stringify({
            ...VIEW,
            bots: seats.map((one) => ({ ...VIEW.bots.find((gh) => gh.slot === one.slot)!, name: one.bot, login: one.login })),
          }),
        );
      }
      if (url === '/api/engines') return new Response(JSON.stringify({ bots: seats }));
      if (url === '/api/github/accounts/assign') {
        const seat = seats.find((one) => one.bot === body.bot);
        if (!seat) return new Response(JSON.stringify({ error: `no bot named ${body.bot}` }), { status: 404 });
        seat.login = body.login;
        seat.bot = body.login;
        return new Response('{}');
      }
      const assignment = /^\/api\/bots\/([^/]+)\/assignment$/.exec(url);
      if (assignment) {
        const ref = decodeURIComponent(assignment[1]!);
        const seat = seats.find((one) => one.bot === ref) ?? seats.find((one) => one.slot === ref);
        if (!seat) return new Response(JSON.stringify({ error: `no bot named ${ref}` }), { status: 404 });
        Object.assign(seat, { model: body.model, modelAccountId: body.modelAccountId });
        return new Response(JSON.stringify({ bot: { engine: seat.engine } }));
      }
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [], aliases: ['newest:opus', 'newest:sonnet'] }));
      return new Response('{}');
    };
    return { seats, calls, answer };
  }

  it('saves every seat’s account and model, though the accounts renamed the seats, and goes on', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const bridge = standIn();
    vi.stubGlobal('fetch', vi.fn(bridge.answer));
    const onContinue = vi.fn();
    // The walkthrough holds the crew, and the step hands it what it reads.
    function Walkthrough() {
      const [crew, setCrew] = useState<CrewBot[] | null>(bridge.seats.map(({ login: _login, ...one }) => ({ ...one })));
      return <CrewStep crew={crew} accounts={[MAX]} onCrew={setCrew} onSaved={() => undefined} onContinue={onContinue} />;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => root.render(<Walkthrough />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const save = async () => {
      await act(async () => {
        [...container.querySelectorAll('button')].find((el) => el.textContent === 'Save crew and continue')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    };

    await save();

    const writes = bridge.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.url}`);
    expect(writes).toEqual([
      'POST /api/github/accounts/assign',
      'POST /api/github/accounts/assign',
      'PATCH /api/bots/builder/assignment',
      'PATCH /api/bots/lead-reviewer/assignment',
    ]);
    expect(bridge.seats.map((one) => [one.bot, one.modelAccountId])).toEqual([
      ['fleetadlc-builder-acme', 'max'],
      ['fleetadlc-lead-reviewer-acme', 'max'],
    ]);
    expect(container.textContent).not.toContain('no bot named');
    expect(onContinue).toHaveBeenCalledOnce();

    // Read again after saving: a second press has nothing left to send, and no name from before to send it under.
    expect(bridge.calls.filter((call) => call.url === '/api/github/identities')).toHaveLength(2);
    bridge.calls.length = 0;
    await save();
    expect(bridge.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(onContinue).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});

describe('what the crew is worked out from', () => {
  async function render(props: { crew: CrewBot[] | null; accounts: AccountRef[] | null }, answer: (url: string, asked: number) => Response) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url);
        return answer(url, asked.filter((one) => one === url).length);
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<CrewStep crew={props.crew} accounts={props.accounts} onCrew={() => undefined} onSaved={() => undefined} onContinue={() => undefined} />);
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const done = () => {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    };
    return { container, asked, done };
  }

  it('says why when the accounts cannot be read, and reads them again on Try again', async () => {
    const { container, asked, done } = await render({ crew: CREW, accounts: [MAX] }, (url, times) => {
      if (url === '/api/github/identities' && times === 1) return new Response(JSON.stringify({ error: 'the bridge could not read the accounts' }), { status: 500 });
      if (url === '/api/github/identities') return new Response(JSON.stringify(VIEW));
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [], aliases: [] }));
      return new Response('{}');
    });
    expect(container.textContent).toContain('Could not work out the crew: the bridge could not read the accounts');
    await act(async () => [...container.querySelectorAll('button')].find((el) => el.textContent === 'Try again')!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(asked.filter((url) => url === '/api/github/identities')).toHaveLength(2);
    expect(container.textContent).toContain('Your crew is ready.');
    done();
  });

  it('reads the model accounts itself when the walkthrough had none to hand down', async () => {
    const { asked, done } = await render({ crew: CREW, accounts: null }, (url) => {
      if (url === '/api/github/identities') return new Response(JSON.stringify(VIEW));
      if (url === '/api/model-accounts') return new Response(JSON.stringify({ accounts: [MAX] }));
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [], aliases: [] }));
      return new Response('{}');
    });
    expect(asked).toContain('/api/model-accounts');
    done();
  });
});
