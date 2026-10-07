import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAccountCache, lookUpAccount } from './github-accounts.js';

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

const ORG = { login: 'exampleco', type: 'Organization', avatar_url: 'a', html_url: 'h' };
const USER = { login: 'janedoe', type: 'User', avatar_url: 'a', html_url: 'h' };

beforeEach(() => clearAccountCache());

describe('finding the account somebody is typing', () => {
  it('reports an exact match and what kind of account it is', async () => {
    // The type is the point. A personal account grants write to every
    // collaborator and has no Triage role, so saying so while they type is the
    // difference between a decision and a regret.
    const result = await lookUpAccount('janedoe', { fetchImpl: respond(200, { items: [USER] }) });

    expect(result.exact).toMatchObject({ login: 'janedoe', type: 'User' });
  });

  it('matches whatever case was typed, because GitHub does', async () => {
    const result = await lookUpAccount('JaneDoe', { fetchImpl: respond(200, { items: [USER] }) });
    expect(result.exact?.login).toBe('janedoe');
  });

  it('offers near misses without claiming one of them is it', async () => {
    // A typo should be visible as a typo: nothing exact, but something close.
    const result = await lookUpAccount('janedeo', {
      fetchImpl: respond(200, { items: [USER, ORG] }),
    });

    expect(result.exact).toBeNull();
    expect(result.suggestions.map((account) => account.login)).toEqual(['janedoe', 'exampleco']);
  });

  it('asks nothing for one character, and asks for two: a login can be that short', async () => {
    // One character matches most of GitHub, and the budget is ten a minute.
    const fetchImpl = respond(200, { items: [USER] });
    await lookUpAccount('j', { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();

    await lookUpAccount('ja', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks once for a repeated query, because the budget is ten a minute', async () => {
    const fetchImpl = respond(200, { items: [USER] });
    await lookUpAccount('janedoe', { fetchImpl });
    await lookUpAccount('janedoe', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('says when GitHub refused, and does not remember the refusal', async () => {
    // Caching a rate-limit would keep the field broken long after the minute
    // that caused it had passed.
    const limited = respond(403, {});
    const first = await lookUpAccount('janedoe', { fetchImpl: limited });
    expect(first.rateLimited).toBe(true);

    const ok = respond(200, { items: [USER] });
    const second = await lookUpAccount('janedoe', { fetchImpl: ok });
    expect(second.exact?.login).toBe('janedoe');
  });

  it('is never the reason somebody cannot continue', async () => {
    // An unreachable GitHub is not an error the step stops on, and not
    // "nothing found" either: the Approvers field read that as nobody being
    // called the name, and would not take it. Unavailable, it offers the name
    // unchecked, as a rate limit does.
    const broken = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    await expect(lookUpAccount('janedoe', { fetchImpl: broken })).resolves.toEqual({
      exact: null,
      suggestions: [],
      rateLimited: false,
      unavailable: true,
    });
  });

  it('says GitHub is unavailable on an error that is not a rate limit, and does not remember it', async () => {
    const failing = respond(502, {});
    expect(await lookUpAccount('janedoe', { fetchImpl: failing })).toEqual({ exact: null, suggestions: [], rateLimited: false, unavailable: true });

    const second = await lookUpAccount('janedoe', { fetchImpl: respond(200, { items: [USER] }) });
    expect(second.exact?.login).toBe('janedoe');
  });
});

describe('whether a login is free to register', () => {
  function respondStatus(status: number, body: unknown = {}): typeof fetch {
    return vi.fn(async () =>
      new Response(status === 404 ? '{}' : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
  }

  it('says free when GitHub has never heard of it', async () => {
    const { loginAvailable } = await import('./github-accounts.js');
    expect(await loginAvailable('fleetadlc-atlas-janedoe', { fetchImpl: respondStatus(404) })).toBe(true);
  });

  it('says taken when somebody holds it', async () => {
    // An account name that was already taken, like the one an install once
    // pointed a bot at: a real account registered years earlier by a stranger.
    const { loginAvailable } = await import('./github-accounts.js');
    expect(
      await loginAvailable('fleetadlc-flow', { fetchImpl: respondStatus(200, { login: 'FleetADLC-Flow', type: 'User' }) }),
    ).toBe(false);
  });

  it('is asked of GitHub, whatever a search for `login:` that name left behind', async () => {
    // `login:octocat` is a qualifier GitHub's search takes, and its empty
    // answer was cached where this looks, so a taken name read as free.
    const { loginAvailable } = await import('./github-accounts.js');
    await lookUpAccount('login:fleetadlc-flow', { fetchImpl: respond(200, { items: [] }) });

    const asked = respondStatus(200, { login: 'FleetADLC-Flow', type: 'User' });
    expect(await loginAvailable('fleetadlc-flow', { fetchImpl: asked })).toBe(false);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('says it does not know, rather than free, when GitHub cannot be asked', async () => {
    // `null` and not `true`: presenting a name as available when the check
    // failed sends somebody to fill in a sign-up form that fails at the end.
    const { loginAvailable } = await import('./github-accounts.js');
    const broken = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    expect(await loginAvailable('fleetadlc-atlas', { fetchImpl: broken })).toBeNull();
    expect(await loginAvailable('fleetadlc-atlas', { fetchImpl: respondStatus(403) })).toBeNull();
  });

  it('sends one request for a login several seats ask about at once', async () => {
    // The cache fills only once an answer arrives, so nine seats on two
    // accounts sent nine requests, against an anonymous limit of sixty an hour.
    const { loginAvailable } = await import('./github-accounts.js');
    const asked = respondStatus(200, { login: 'fleetadlc-atlas', type: 'User' });
    const logins = ['fleetadlc-atlas', 'Fleetadlc-Atlas', 'fleetadlc-atlas', 'noraexampleco', 'noraexampleco'];

    const answers = await Promise.all(logins.map((login) => loginAvailable(login, { fetchImpl: asked })));

    expect(answers).toEqual([false, false, false, false, false]);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('asks again after a lookup that failed, rather than sharing its failure', async () => {
    const { loginAvailable } = await import('./github-accounts.js');
    expect(await loginAvailable('fleetadlc-atlas', { fetchImpl: respondStatus(403) })).toBeNull();
    expect(await loginAvailable('fleetadlc-atlas', { fetchImpl: respondStatus(404) })).toBe(true);
  });
});

describe('whether an account is a person or an organization', () => {
  beforeEach(() => clearAccountCache());

  const answering = (status: number, body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('is what GitHub says the exact login is', async () => {
    const { accountTypeOf } = await import('./github-accounts.js');
    expect(await accountTypeOf('exampleco', { fetchImpl: answering(200, { login: 'exampleco', type: 'Organization' }) })).toBe('Organization');
    expect(await accountTypeOf('janedoe', { fetchImpl: answering(200, { login: 'janedoe', type: 'User' }) })).toBe('User');
  });

  it('is nothing for a login nobody holds, or when GitHub cannot be asked', async () => {
    const { accountTypeOf } = await import('./github-accounts.js');
    expect(await accountTypeOf('nobody-holds-this', { fetchImpl: answering(404) })).toBeNull();
    expect(await accountTypeOf('exampleco', { fetchImpl: answering(503) })).toBeNull();
  });

  it('asks once for a login it was just asked about', async () => {
    const { accountTypeOf } = await import('./github-accounts.js');
    const fetchImpl = answering(200, { login: 'exampleco', type: 'Organization' });
    await accountTypeOf('exampleco', { fetchImpl });
    await accountTypeOf('ExampleCo', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps its numeric id, from the same answer, for the install page that skips GitHub’s account picker', async () => {
    const { accountIdOf, accountTypeOf } = await import('./github-accounts.js');
    const fetchImpl = answering(200, { login: 'exampleco', id: 98765, type: 'Organization' });
    expect(await accountTypeOf('exampleco', { fetchImpl })).toBe('Organization');
    expect(await accountIdOf('exampleco', { fetchImpl })).toBe(98765);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await accountIdOf('nobody-holds-this', { fetchImpl: answering(404) })).toBeNull();
  });
});
