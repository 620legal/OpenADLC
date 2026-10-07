import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSecretStore, type SecretStore } from '@fleetadlc/github';

const setTokenExpiry = vi.fn(async () => undefined);

vi.mock('@fleetadlc/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/db')>();
  return {
    ...actual,
    // The broker refreshes under a Postgres advisory lock; there is no database
    // here, and the lock's own behaviour is the database's, not this test's.
    withAdvisoryLock: async <T,>(_key: string, fn: () => Promise<T>) => fn(),
    bots: {
      getBotByName: vi.fn(async (name: string) =>
        name === 'builder'
          ? { id: 'b1', name: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' }
          : name === 'intake' || name === 'lead-reviewer'
            ? { id: `id-${name}`, name, githubLogin: 'fleetadlc-example' }
            : null,
      ),
    },
    // `builder` has an account of its own and no identity recorded; `intake`
    // and `lead-reviewer` share one, filed under `fleetadlc-example`.
    identities: {
      identityOfBot: vi.fn(async (botId: string) =>
        botId === 'id-intake' || botId === 'id-lead-reviewer'
          ? { id: 'shared', login: 'fleetadlc-example', githubUserId: null, secretNs: 'fleetadlc-example' }
          : null,
      ),
      botsOnSecretNs: vi.fn(async (ns: string) => (ns === 'fleetadlc-example' ? ['intake', 'lead-reviewer'] : [])),
    },
    credentials: { setTokenExpiry, setCredentialStatus: vi.fn(async () => undefined) },
  };
});

const { Actors } = await import('./actors.js');

function memoryStore(values: Record<string, string>): SecretStore {
  const data = new Map(Object.entries(values));
  return {
    get: async (ref) => data.get(ref) ?? null,
    set: async (ref, value) => void data.set(ref, value),
    delete: async (ref) => void data.delete(ref),
    list: async () => [...data.keys()],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setTokenExpiry.mockClear();
});

/**
 * GitHub gives each refresh token its own six months, so the expiry recorded
 * at authorization says less every time a bot is refreshed. A restore reads
 * the recorded one to tell a sign-in that expired from one that did not.
 */
describe('a refresh', () => {
  it('records when the new refresh token expires, as well as the token it minted', async () => {
    setSecretStore(memoryStore({ 'github-refresh-builder': 'ghr_zzz-old-zzz' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'ghu_zzz-new-zzz',
            expires_in: 28_800,
            refresh_token: 'ghr_zzz-new-zzz',
            refresh_token_expires_in: 15_897_600,
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const minted = await new Actors('Iv1.zzz-client-zzz').tokenFor('builder');

    expect(minted?.token).toBe('ghu_zzz-new-zzz');
    const [botId, tokenExpiresAt, refreshExpiresAt] = setTokenExpiry.mock.calls[0] as unknown as [string, Date, Date];
    expect(botId).toBe('b1');
    expect(tokenExpiresAt).toBeInstanceOf(Date);
    expect(refreshExpiresAt).toBeInstanceOf(Date);
    // Six months on, give or take the moment it ran.
    expect(refreshExpiresAt.getTime() - Date.now()).toBeGreaterThan(15_897_000 * 1000);
  });
});

describe('seats that share one account', () => {
  it('refresh it once between them, so neither is left holding a token GitHub has rotated away', async () => {
    setSecretStore(memoryStore({ 'github-refresh-fleetadlc-example': 'ghr_zzz-old-zzz' }));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: 'ghu_zzz-shared-zzz',
          expires_in: 28_800,
          refresh_token: 'ghr_zzz-next-zzz',
          refresh_token_expires_in: 15_897_600,
          token_type: 'bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const actors = new Actors('Iv1.zzz-client-zzz');
    const [intake, reviewer] = await Promise.all([actors.tokenFor('intake'), actors.tokenFor('lead-reviewer')]);

    expect(intake?.token).toBe('ghu_zzz-shared-zzz');
    expect(reviewer?.token).toBe('ghu_zzz-shared-zzz');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Both seats show the refreshed expiry.
    expect(setTokenExpiry.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['id-intake', 'id-lead-reviewer']);
  });
});

describe('a task’s token', () => {
  /** GitHub refreshing the builder's sign-in, and narrowing a token to the repository it is asked for. */
  function github() {
    const scoped: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/token/scoped')) {
          const body = JSON.parse(String(init?.body)) as { repositories: string[] };
          scoped.push(body.repositories);
          return new Response(JSON.stringify({ token: `ghu_zzz-${body.repositories[0]}-zzz`, expires_at: null }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ access_token: 'ghu_zzz-account-zzz', expires_in: 28_800, refresh_token: 'ghr_zzz-new-zzz', refresh_token_expires_in: 15_897_600 }),
          { status: 200 },
        );
      }),
    );
    return { scoped };
  }

  it('reaches only its repository when the install has the app’s client secret, and the bridge keeps the account’s', async () => {
    setSecretStore(memoryStore({ 'github-refresh-builder': 'ghr_zzz-old-zzz', 'github-app-client-secret': 'zzz-secret-zzz' }));
    const { scoped } = github();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const actors = new Actors('Iv1.zzz-client-zzz');

    const widgets = await actors.tokenFor('builder', { repository: 'exampleco/widgets' });
    const gadgets = await actors.tokenFor('builder', { repository: 'exampleco/gadgets' });

    expect(widgets).toMatchObject({ token: 'ghu_zzz-widgets-zzz', scoped: true });
    expect(gadgets).toMatchObject({ token: 'ghu_zzz-gadgets-zzz', scoped: true });
    expect(scoped).toEqual([['widgets'], ['gadgets']]);
    expect((await actors.tokenFor('builder'))?.token).toBe('ghu_zzz-account-zzz');
    expect(actors.lastScoped()).toEqual({ ok: true });
  });

  it('is the account’s, said to be unscoped, when the install has no client secret', async () => {
    setSecretStore(memoryStore({ 'github-refresh-builder': 'ghr_zzz-old-zzz' }));
    const { scoped } = github();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const actors = new Actors('Iv1.zzz-client-zzz');

    expect(await actors.tokenFor('builder', { repository: 'exampleco/widgets' })).toMatchObject({ token: 'ghu_zzz-account-zzz', scoped: false });
    expect(scoped).toEqual([]);
    expect(actors.lastScoped()).toMatchObject({ ok: false, secretRefused: false });
  });
});

