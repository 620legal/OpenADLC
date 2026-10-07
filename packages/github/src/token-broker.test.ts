import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshTokenRef, type SecretStore } from './secrets.js';
import { refusedByGitHub, TASK_TOKEN_MIN_LIFETIME_MS, TokenBroker } from './token-broker.js';

function memoryStore(seed: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(seed));
  return {
    get: async (ref) => values.get(ref) ?? null,
    set: async (ref, value) => {
      values.set(ref, value);
    },
    delete: async (ref) => {
      values.delete(ref);
    },
    list: async (prefix = '') => [...values.keys()].filter((key) => key.startsWith(prefix)),
  };
}

/**
 * GitHub answers a refresh with a new access token and a rotated refresh token,
 * and invalidates the one that was used. `issued` counts how many times that
 * happened, because every refresh past the first is one that could have raced.
 */
function mockGitHub(lifetimeSeconds = 28_800): { issued: () => number } {
  let issued = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      issued += 1;
      return new Response(
        JSON.stringify({
          access_token: `ghu_${issued}`,
          expires_in: lifetimeSeconds,
          refresh_token: `ghr_${issued}`,
          refresh_token_expires_in: 15_897_600,
        }),
        { status: 200 },
      );
    }),
  );
  return { issued: () => issued };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('token broker', () => {
  it('refreshes once when several callers ask at the same moment', async () => {
    const github = mockGitHub();
    const broker = new TokenBroker({
      clientId: 'Iv1.client',
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
    });

    const tokens = await Promise.all([
      broker.tokenFor('atlas'),
      broker.tokenFor('atlas'),
      broker.tokenFor('atlas'),
    ]);

    // A second refresh would have invalidated the first one's token.
    expect(github.issued()).toBe(1);
    expect(new Set(tokens.map((entry) => entry.token)).size).toBe(1);
  });

  it('persists the rotated refresh token, so the next refresh has one that works', async () => {
    mockGitHub();
    const store = memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' });
    const broker = new TokenBroker({ clientId: 'Iv1.client', store });

    await broker.tokenFor('atlas');

    expect(await store.get(refreshTokenRef('atlas'))).toBe('ghr_1');
  });

  it('hands a task a token that will outlast it', async () => {
    // Three hours left: fine for one API call, not for a task that may run four.
    const github = mockGitHub(3 * 60 * 60);
    const broker = new TokenBroker({
      clientId: 'Iv1.client',
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
    });

    await broker.tokenFor('atlas');
    expect(github.issued()).toBe(1);

    await broker.tokenFor('atlas');
    expect(github.issued()).toBe(1);

    await broker.tokenFor('atlas', 'atlas', { minLifetimeMs: TASK_TOKEN_MIN_LIFETIME_MS });
    expect(github.issued()).toBe(2);
  });

  it('reuses a token that already outlasts the longest task', async () => {
    const github = mockGitHub();
    const broker = new TokenBroker({
      clientId: 'Iv1.client',
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
    });

    await broker.tokenFor('atlas', 'atlas', { minLifetimeMs: TASK_TOKEN_MIN_LIFETIME_MS });
    await broker.tokenFor('atlas', 'atlas', { minLifetimeMs: TASK_TOKEN_MIN_LIFETIME_MS });

    expect(github.issued()).toBe(1);
  });

  it('says which bot needs the device flow when nothing is stored', async () => {
    mockGitHub();
    const broker = new TokenBroker({ clientId: 'Iv1.client', store: memoryStore() });

    await expect(broker.tokenFor('atlas')).rejects.toThrow(/fleetadlc auth login --bot atlas/);
  });
});

describe('a rotated refresh token the store fails to save', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** GitHub rotating r1 → r2 → r3, refusing any refresh token already used. */
  function rotatingGitHub(): { sent: string[] } {
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const used = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
        sent.push(used);
        if (sent.indexOf(used) !== sent.length - 1) {
          return new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 200 });
        }
        const next = Number(used.slice(1)) + 1;
        return new Response(
          JSON.stringify({ access_token: `ghu_${next}`, expires_in: 28_800, refresh_token: `r${next}`, refresh_token_expires_in: 1 }),
          { status: 200 },
        );
      }),
    );
    return { sent };
  }

  /** A store whose first `failures` writes throw, as Secret Manager timing out does. */
  function flakyStore(failures: number): SecretStore & { writes: number } {
    const inner = memoryStore({ [refreshTokenRef('atlas')]: 'r1' });
    const store = {
      writes: 0,
      ...inner,
      set: async (ref: string, value: string) => {
        store.writes += 1;
        if (store.writes <= failures) throw new Error('Secret Manager timed out');
        await inner.set(ref, value);
      },
    };
    return store;
  }

  it('still hands out the new access token, and saves it on a retry', async () => {
    const github = rotatingGitHub();
    const store = flakyStore(1);
    const broker = new TokenBroker({ clientId: 'Iv1.client', store, saveRetryMs: [1] });

    expect((await broker.tokenFor('atlas')).token).toBe('ghu_2');
    expect(store.writes).toBe(2);
    expect(await store.get(refreshTokenRef('atlas'))).toBe('r2');

    broker.forget('atlas');
    await broker.tokenFor('atlas');
    expect(github.sent).toEqual(['r1', 'r2']);
  });

  it('refreshes next from the rotated token it kept, not the dead one stored, when every save fails', async () => {
    const github = rotatingGitHub();
    const store = flakyStore(2);
    const revoked: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broker = new TokenBroker({ clientId: 'Iv1.client', store, saveRetryMs: [1], onRevoked: (bot) => void revoked.push(bot) });

    expect((await broker.tokenFor('atlas')).token).toBe('ghu_2');
    expect(await store.get(refreshTokenRef('atlas'))).toBe('r1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not save atlas's rotated GitHub refresh token"));
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/\br2\b/);

    broker.forget('atlas');
    expect((await broker.tokenFor('atlas')).token).toBe('ghu_3');
    expect(github.sent).toEqual(['r1', 'r2']);
    expect(revoked).toEqual([]);
    // Saved at last, and the copy in memory dropped: the store is read again.
    expect(await store.get(refreshTokenRef('atlas'))).toBe('r3');
    broker.forget('atlas');
    await broker.tokenFor('atlas');
    expect(github.sent).toEqual(['r1', 'r2', 'r3']);
  });

  it('is saved before a rename moves the sign-in, so the move carries the live one', async () => {
    rotatingGitHub();
    const store = flakyStore(2);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broker = new TokenBroker({ clientId: 'Iv1.client', store, saveRetryMs: [1] });
    await broker.tokenFor('atlas');

    const moved = await broker.exclusive(['atlas', 'fleetadlc-atlas'], async () => store.get(refreshTokenRef('atlas')));
    expect(moved).toBe('r2');
  });
});

describe('an install configured after the process started', () => {
  /**
   * The client id lives in the database, written by the console, and the bridge
   * reads its environment once at boot. Taking the value at construction meant
   * the broker held an empty string on exactly the installs that used the
   * console — and refreshed every token with `client_id=`, which GitHub
   * refuses. Every bot connected from the browser stopped working at the next
   * restart.
   */
  it('asks for the client id at the moment it refreshes', async () => {
    const asked: string[] = [];
    let configured = '';

    const broker = new TokenBroker({
      clientId: () => {
        asked.push(configured);
        return configured;
      },
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
    });

    // Before it is configured: a fault in the install, not in the credential.
    await expect(broker.tokenFor('atlas', 'fleetadlc-atlas')).rejects.toThrow(/no GitHub App client id/);

    configured = 'Iv23liLATER';
    mockGitHub();
    await broker.tokenFor('atlas', 'fleetadlc-atlas').catch(() => undefined);

    // The second attempt used the value set after construction.
    expect(asked.at(-1)).toBe('Iv23liLATER');
  });

  it('does not revoke a credential because this install is misconfigured', async () => {
    // The expensive half. Marking it revoked turned one missing setting into
    // nine device flows to redo, and said so in the error.
    const revoked: string[] = [];
    const broker = new TokenBroker({
      clientId: () => '',
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
      onRevoked: (bot) => {
        revoked.push(bot);
      },
    });

    await expect(broker.tokenFor('atlas', 'fleetadlc-atlas')).rejects.toThrow(/no GitHub App client id/);
    expect(revoked).toEqual([]);
  });
});

describe('a rename moving a bot’s refresh token', () => {
  it('waits for a refresh already in flight, and holds new ones off until the move is done', async () => {
    // The refresh that started before the move rotates the token. Were the
    // copy taken before it finished, the new name would hold the token GitHub
    // had just invalidated, and the rotated one would be deleted with the old.
    let answer!: (response: Response) => void;
    const refreshed = (refreshToken: string, accessToken: string) =>
      new Response(
        JSON.stringify({ access_token: accessToken, expires_in: 28_800, refresh_token: refreshToken, refresh_token_expires_in: 1 }),
        { status: 200 },
      );
    // The first refresh is answered when the test says so; any after it at once.
    const github = vi.fn((_url: string, _init?: { body?: string }): Promise<Response> =>
      github.mock.calls.length === 1
        ? new Promise<Response>((resolve) => (answer = resolve))
        : Promise.resolve(refreshed('ghr_after', 'ghu_2')),
    );
    vi.stubGlobal('fetch', github);
    const store = memoryStore({ [refreshTokenRef('atlas')]: 'ghr_before' });
    const broker = new TokenBroker({ clientId: 'Iv1.client', store });

    const inflight = broker.tokenFor('atlas');
    await vi.waitFor(() => expect(github).toHaveBeenCalledTimes(1));

    const moved = broker.exclusive(['atlas', 'fleetadlc-atlas-janedoe'], async () => {
      const value = await store.get(refreshTokenRef('atlas'));
      await store.set(refreshTokenRef('fleetadlc-atlas-janedoe'), value ?? '');
      await store.delete(refreshTokenRef('atlas'));
      return value;
    });
    // Asked for while the move is waiting: it must not read the old name.
    const during = broker.tokenFor('fleetadlc-atlas-janedoe');

    answer(refreshed('ghr_rotated', 'ghu_1'));
    await inflight;

    // The move copied the rotated token, not the one it replaced.
    expect(await moved).toBe('ghr_rotated');
    expect(await store.get(refreshTokenRef('atlas'))).toBeNull();

    // And the caller that waited refreshed under the new name, from that token.
    expect((await during).token).toBe('ghu_2');
    expect(github).toHaveBeenCalledTimes(2);
    expect(String(github.mock.calls[1]?.[1]?.body)).toContain('refresh_token=ghr_rotated');
    expect(await store.get(refreshTokenRef('fleetadlc-atlas-janedoe'))).toBe('ghr_after');
  });

  it('forgets a token cached under either name', async () => {
    mockGitHub();
    const store = memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' });
    const broker = new TokenBroker({ clientId: 'Iv1.client', store });
    await broker.tokenFor('atlas');

    await broker.exclusive(['atlas', 'fleetadlc-atlas-janedoe'], async () => {
      await store.delete(refreshTokenRef('atlas'));
    });

    // Cached, the old name would go on acting for a bot that no longer has it.
    await expect(broker.tokenFor('atlas')).rejects.toThrow(/not connected/);
  });
});

describe('two bridges refreshing one sign-in, as during a rollout', () => {
  /** GitHub as it behaves: a refresh token works once, and a second use is refused. */
  function strictGitHub(): { used: string[] } {
    const used: string[] = [];
    let issued = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: unknown }) => {
        const token = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '';
        if (used.includes(token)) {
          return new Response(JSON.stringify({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }), { status: 200 });
        }
        used.push(token);
        issued += 1;
        return new Response(
          JSON.stringify({ access_token: `ghu_${issued}`, expires_in: 28_800, refresh_token: `ghr_${issued}`, refresh_token_expires_in: 15_897_600 }),
          { status: 200 },
        );
      }),
    );
    return { used };
  }

  /** One lock for both, as Postgres gives every process on the database. */
  function sharedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return <T,>(_key: string, fn: () => Promise<T>) => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    };
  }

  it('never uses one refresh token twice, so neither is locked out', async () => {
    const github = strictGitHub();
    const store = memoryStore({ [refreshTokenRef('account_exampleco-review')]: 'ghr_stored' });
    const exclusive = sharedLock();
    const revoked: string[] = [];
    const old = new TokenBroker({ clientId: 'Iv1.client', store, exclusive, onRevoked: (bot) => void revoked.push(bot) });
    const fresh = new TokenBroker({ clientId: 'Iv1.client', store, exclusive, onRevoked: (bot) => void revoked.push(bot) });

    await Promise.all([old.tokenFor('account_exampleco-review'), fresh.tokenFor('account_exampleco-review')]);

    expect(revoked).toEqual([]);
    expect(github.used).toEqual(['ghr_stored', 'ghr_1']);
  });
});

describe('telling a refused sign-in from GitHub not answering', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function refreshFails(answer: () => Promise<Response>): Promise<unknown> {
    vi.stubGlobal('fetch', vi.fn(answer));
    const broker = new TokenBroker({ clientId: 'Iv1.client', store: memoryStore({ [refreshTokenRef('builder')]: 'ghr_old' }) });
    return broker.tokenFor('builder').then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('counts an OAuth error GitHub gave, and a 401, as refused', async () => {
    const bad = await refreshFails(async () =>
      new Response(JSON.stringify({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }), { status: 200 }),
    );
    const unauthorized = await refreshFails(async () => new Response('Unauthorized', { status: 401 }));
    expect(refusedByGitHub(bad)).toBe(true);
    expect(refusedByGitHub(unauthorized)).toBe(true);
  });

  it('does not count a network error or a 5xx as refused', async () => {
    const offline = await refreshFails(async () => {
      throw new TypeError('fetch failed');
    });
    const outage = await refreshFails(async () => new Response('<html>Unicorn</html>', { status: 503 }));
    const jsonOutage = await refreshFails(async () => new Response(JSON.stringify({ message: 'Server Error' }), { status: 502 }));
    expect(offline).toBeInstanceOf(Error);
    expect(refusedByGitHub(offline)).toBe(false);
    expect(refusedByGitHub(outage)).toBe(false);
    expect(refusedByGitHub(jsonOutage)).toBe(false);
  });

  it('does not count GitHub’s busy or failing OAuth codes, or an OAuth error sent with a 5xx, as refused', async () => {
    const answers = [
      new Response(JSON.stringify({ error: 'server_error' }), { status: 200 }),
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 200 }),
      new Response(JSON.stringify({ error: 'slow_down' }), { status: 200 }),
      new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 503 }),
    ];
    for (const answer of answers) {
      expect(refusedByGitHub(await refreshFails(async () => answer))).toBe(false);
    }
  });

  it('counts an OAuth code it does not know as refused, and keeps the status', async () => {
    const odd = await refreshFails(async () => new Response(JSON.stringify({ error: 'some_new_refusal' }), { status: 400 }));
    expect(refusedByGitHub(odd)).toBe(true);
    expect((odd as Error).cause).toMatchObject({ code: 'some_new_refusal', status: 400 });
  });
});

describe('marking a sign-in revoked', () => {
  afterEach(() => vi.unstubAllGlobals());

  function broker(revoked: string[]) {
    return new TokenBroker({
      clientId: 'Iv1.client',
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
      onRevoked: (bot) => {
        revoked.push(bot);
      },
    });
  }

  it('marks it revoked when GitHub refuses the refresh token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'bad_refresh_token', error_description: 'expired' }), { status: 200 })),
    );
    const revoked: string[] = [];

    // Says what to do, by the account's login, which `--bot` resolves whichever seat it is.
    await expect(broker(revoked).tokenFor('atlas', 'fleetadlc-atlas')).rejects.toThrow(
      /atlas's GitHub authorization is no longer valid \(expired\)\. Reconnect it: fleetadlc auth login --bot fleetadlc-atlas$/,
    );
    expect(revoked).toEqual(['atlas']);
  });

  it('does not mark it revoked when GitHub cannot be reached or has an outage, and asks again next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        if (calls === 2) return new Response('<html>Unicorn</html>', { status: 503 });
        return new Response(JSON.stringify({ access_token: 'ghu_ok', expires_in: 28_800, refresh_token: 'ghr_new' }), { status: 200 });
      }),
    );
    const revoked: string[] = [];
    const one = broker(revoked);

    await expect(one.tokenFor('atlas', 'fleetadlc-atlas')).rejects.not.toThrow(/no longer valid/);
    await expect(one.tokenFor('atlas', 'fleetadlc-atlas')).rejects.not.toThrow(/no longer valid/);
    await expect(one.tokenFor('atlas', 'fleetadlc-atlas')).resolves.toMatchObject({ token: 'ghu_ok' });

    expect(revoked).toEqual([]);
    expect(calls).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('a token for a task in one repository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** GitHub: the device flow's refresh, and the scoped-token call, which answers a token named for its repository. */
  function scopingGitHub(options: { scopedStatus?: number } = {}) {
    const refreshes: string[] = [];
    const scoped: { repositories: string[]; target: string; accessToken: string; auth: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/token/scoped')) {
        const body = JSON.parse(String(init?.body)) as { repositories: string[]; target: string; access_token: string };
        scoped.push({
          repositories: body.repositories,
          target: body.target,
          accessToken: body.access_token,
          auth: (init?.headers as Record<string, string>).authorization ?? '',
        });
        if (options.scopedStatus) return new Response('{"message":"no"}', { status: options.scopedStatus });
        return new Response(JSON.stringify({ token: `ghu_for_${body.repositories.join(',')}_${scoped.length}`, expires_at: null }), { status: 200 });
      }
      refreshes.push(String(init?.body));
      return new Response(
        JSON.stringify({ access_token: `ghu_account_${refreshes.length}`, expires_in: 28_800, refresh_token: `ghr_${refreshes.length}`, refresh_token_expires_in: 1 }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchImpl);
    return { refreshes, scoped };
  }

  it('is narrowed to that repository, one per repository, from the account’s one refreshed token', async () => {
    const github = scopingGitHub();
    const outcomes: unknown[] = [];
    const broker = new TokenBroker({
      clientId: 'Iv1.client',
      clientSecret: () => 'shh',
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
      onScoped: (outcome) => void outcomes.push(outcome),
    });

    const widgets = await broker.tokenForRepository('atlas', 'atlas', 'exampleco/widgets', { minLifetimeMs: TASK_TOKEN_MIN_LIFETIME_MS });
    const gadgets = await broker.tokenForRepository('atlas', 'atlas', 'exampleco/gadgets', { minLifetimeMs: TASK_TOKEN_MIN_LIFETIME_MS });

    expect(widgets).toMatchObject({ token: 'ghu_for_widgets_1', scoped: true, login: 'atlas' });
    expect(gadgets).toMatchObject({ token: 'ghu_for_gadgets_2', scoped: true });
    expect(widgets.token).not.toBe(gadgets.token);
    // Each call carried its own repository, and nothing else.
    expect(github.scoped.map((call) => call.repositories)).toEqual([['widgets'], ['gadgets']]);
    expect(github.scoped.every((call) => call.target === 'exampleco' && call.accessToken === 'ghu_account_1')).toBe(true);
    expect(github.scoped[0]?.auth).toBe(`Basic ${Buffer.from('Iv1.client:shh').toString('base64')}`);
    // The account was refreshed once, and its own token is still the bridge's.
    expect(github.refreshes).toHaveLength(1);
    expect((await broker.tokenFor('atlas')).token).toBe('ghu_account_1');
    // Asked again, each repository's comes from the cache, not another's.
    expect((await broker.tokenForRepository('atlas', 'atlas', 'exampleco/widgets')).token).toBe('ghu_for_widgets_1');
    expect(github.scoped).toHaveLength(2);
    expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
  });

  it('is the account’s own token, said to be unscoped, when the install has no client secret', async () => {
    const github = scopingGitHub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broker = new TokenBroker({ clientId: 'Iv1.client', clientSecret: () => null, store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }) });

    const token = await broker.tokenForRepository('atlas', 'atlas', 'exampleco/widgets');

    expect(token).toMatchObject({ token: 'ghu_account_1', scoped: false });
    expect(github.scoped).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("atlas's token for exampleco/widgets is not scoped to it"));
  });

  it('falls back to the account’s token, and says the secret was refused, when GitHub refuses the client secret', async () => {
    scopingGitHub({ scopedStatus: 401 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcomes: unknown[] = [];
    const broker = new TokenBroker({
      clientId: 'Iv1.client',
      clientSecret: () => 'stale',
      store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }),
      onScoped: (outcome) => void outcomes.push(outcome),
    });

    expect(await broker.tokenForRepository('atlas', 'atlas', 'exampleco/widgets')).toMatchObject({ token: 'ghu_account_1', scoped: false });
    expect(outcomes).toEqual([{ ok: false, secretRefused: true, reason: 'GitHub refused the app’s client secret' }]);
  });

  it('is made again once the account’s token is refreshed', async () => {
    const github = scopingGitHub();
    const broker = new TokenBroker({ clientId: 'Iv1.client', clientSecret: () => 'shh', store: memoryStore({ [refreshTokenRef('atlas')]: 'ghr_stored' }) });

    await broker.tokenForRepository('atlas', 'atlas', 'exampleco/widgets');
    broker.forget('atlas');
    const again = await broker.tokenForRepository('atlas', 'atlas', 'exampleco/widgets');

    expect(github.refreshes).toHaveLength(2);
    expect(github.scoped.map((call) => call.accessToken)).toEqual(['ghu_account_1', 'ghu_account_2']);
    expect(again.token).toBe('ghu_for_widgets_2');
  });
});

