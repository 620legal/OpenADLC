import { describe, expect, it } from 'vitest';
import { GcpSecretStore } from './gcp-secrets.js';

/** Secret Manager's REST surface, as much of it as the store touches. */
function fakeSecretManager() {
  const secrets = new Map<string, { versions: { name: string; data: string; state: string }[] }>();
  let serial = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname === 'metadata.google.internal') {
      expect(new Headers(init?.headers).get('metadata-flavor')).toBe('Google');
      if (url.pathname.endsWith('/token')) return json(200, { access_token: 'ya29.test', expires_in: 3600 });
      return new Response('example-project');
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ya29.test');
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\//, ''));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    let match = path.match(/^projects\/[^/]+\/secrets\/([^/:]+)\/versions\/latest:access$/);
    if (match) {
      const live = secrets.get(match[1]!)?.versions.filter((v) => v.state === 'ENABLED').at(-1);
      if (!secrets.has(match[1]!)) return json(404, {});
      if (!live) return json(400, {});
      return json(200, { payload: { data: live.data } });
    }
    match = path.match(/^projects\/[^/]+\/secrets\/([^/:]+):addVersion$/);
    if (match) {
      const secret = secrets.get(match[1]!);
      if (!secret) return json(404, {});
      const name = `projects/p/secrets/${match[1]!}/versions/${++serial}`;
      secret.versions.push({ name, data: body.payload.data, state: 'ENABLED' });
      return json(200, { name });
    }
    match = path.match(/^projects\/[^/]+\/secrets\/([^/:]+)\/versions$/);
    if (match) return json(200, { versions: secrets.get(match[1]!)?.versions.filter((v) => v.state === 'ENABLED') });
    match = path.match(/^(projects\/p\/secrets\/[^/]+\/versions\/\d+):destroy$/);
    if (match) {
      for (const secret of secrets.values())
        for (const version of secret.versions) if (version.name === match[1]!) version.state = 'DESTROYED';
      return json(200, {});
    }
    match = path.match(/^projects\/[^/]+\/secrets\/([^/:]+)$/);
    if (match && method === 'DELETE') return json(secrets.delete(match[1]!) ? 200 : 404, {});
    if (/^projects\/[^/]+\/secrets$/.test(path) && method === 'POST') {
      secrets.set(url.searchParams.get('secretId') ?? '', { versions: [] });
      return json(200, {});
    }
    if (/^projects\/[^/]+\/secrets$/.test(path)) {
      return json(200, { secrets: [...secrets.keys()].map((id) => ({ name: `projects/p/secrets/${id}` })) });
    }
    return json(500, { path, method });
  }) as typeof fetch;

  return { fetchImpl, secrets };
}

describe('the Secret Manager store', () => {
  it('reads back what it wrote, and nothing for a ref it never wrote', async () => {
    const { fetchImpl } = fakeSecretManager();
    const store = new GcpSecretStore({ fetch: fetchImpl });
    expect(await store.get('github-refresh-atlas')).toBeNull();
    await store.set('github-refresh-atlas', 'ghr_first');
    expect(await store.get('github-refresh-atlas')).toBe('ghr_first');
  });

  it('destroys the rotated-out version, so an old refresh token is not left readable', async () => {
    const { fetchImpl, secrets } = fakeSecretManager();
    const store = new GcpSecretStore({ fetch: fetchImpl });
    await store.set('github-refresh-atlas', 'ghr_first');
    await store.set('github-refresh-atlas', 'ghr_second');
    expect(await store.get('github-refresh-atlas')).toBe('ghr_second');
    const states = secrets.get('fleet-github-refresh-atlas')?.versions.map((v) => v.state);
    expect(states).toEqual(['DESTROYED', 'ENABLED']);
  });

  it('keeps a value written alongside another, rather than both writes destroying each other', async () => {
    // Two writes to one ref that overlap: both add, then both list. Each used to
    // destroy every version but its own, and nothing was left enabled.
    const { fetchImpl, secrets } = fakeSecretManager();
    const store = new GcpSecretStore({ fetch: fetchImpl });
    await store.set('github-refresh-atlas', 'ghr_first');

    let release: () => void = () => undefined;
    const listing = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    const held = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/versions?')) {
        // Neither write lists until both have added.
        if (++waiting === 2) release();
        await listing;
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const overlapping = new GcpSecretStore({ fetch: held });

    await Promise.all([overlapping.set('github-refresh-atlas', 'ghr_second'), overlapping.set('github-refresh-atlas', 'ghr_third')]);

    expect(await store.get('github-refresh-atlas')).toBe('ghr_third');
    expect(secrets.get('fleet-github-refresh-atlas')?.versions.map((v) => v.state)).toEqual(['DESTROYED', 'DESTROYED', 'ENABLED']);
  });

  it('lists refs by prefix, with `:` surviving the round trip, and deletes', async () => {
    const { fetchImpl } = fakeSecretManager();
    const store = new GcpSecretStore({ fetch: fetchImpl });
    await store.set('ssh-signing-atlas', 'key');
    await store.set('github-refresh-atlas', 'ghr');
    await store.set('scope:thing', 'x');
    expect(await store.list('github-')).toEqual(['github-refresh-atlas']);
    expect(await store.list()).toContain('scope:thing');
    await store.delete('ssh-signing-atlas');
    expect(await store.get('ssh-signing-atlas')).toBeNull();
  });

  it('refuses a ref it could not list back as itself', async () => {
    const store = new GcpSecretStore({ fetch: fakeSecretManager().fetchImpl });
    await expect(store.set('has.a.dot', 'x')).rejects.toThrow(/invalid secret ref/);
  });
});
