import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deliverableUrl, readAppWebhook, setAppWebhook } from './app-hook.js';
import type { AppApi } from './app-auth.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CREDENTIALS = { clientId: 'Iv23liTEST', privateKey };

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** GitHub's own shape: `********` for a secret it holds, absent for none. */
function fakeGitHub(stored: { url?: string; secret?: string } = {}): {
  api: AppApi;
  calls: Call[];
} {
  const calls: Call[] = [];
  const state = { url: stored.url ?? '', secret: stored.secret };

  return {
    calls,
    api: {
      request: async <T>(method: string, path: string, _token: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, body });
        if (method === 'PATCH') {
          const sent = body as { url?: string; secret?: string };
          if (sent.url !== undefined) state.url = sent.url;
          if (sent.secret !== undefined) state.secret = sent.secret;
        }
        return {
          url: state.url,
          content_type: 'json',
          insecure_ssl: '0',
          ...(state.secret ? { secret: '********' } : {}),
        } as T;
      },
    },
  };
}

describe('reading what GitHub believes', () => {
  it('reports a hook that has no secret as having none', async () => {
    const { api } = fakeGitHub({ url: 'https://example.invalid/webhooks/github' });
    expect(await readAppWebhook(api, CREDENTIALS)).toEqual({
      url: 'https://example.invalid/webhooks/github',
      secretSet: false,
    });
  });

  it('never returns the secret, only that there is one', async () => {
    const { api } = fakeGitHub({ url: 'https://x.example/webhooks/github', secret: 'abc123' });
    const hook = await readAppWebhook(api, CREDENTIALS);

    expect(hook.secretSet).toBe(true);
    // The masked value must not be mistaken for the real one and stored.
    expect(JSON.stringify(hook)).not.toContain('*');
    expect(JSON.stringify(hook)).not.toContain('abc123');
  });
});

describe('pointing the app at a bridge', () => {
  it('writes the url and the secret in one call, so they cannot disagree', async () => {
    const { api, calls } = fakeGitHub({ url: 'https://example.invalid/webhooks/github' });

    const hook = await setAppWebhook(api, CREDENTIALS, {
      url: 'https://calm-badger-42.trycloudflare.com/webhooks/github',
      secret: 'deadbeef',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.path).toBe('/app/hook/config');
    expect(calls[0]?.body).toMatchObject({
      url: 'https://calm-badger-42.trycloudflare.com/webhooks/github',
      secret: 'deadbeef',
      content_type: 'json',
    });
    expect(hook).toEqual({
      url: 'https://calm-badger-42.trycloudflare.com/webhooks/github',
      secretSet: true,
    });
  });

  it('rewrites the secret of a hook that already has one', async () => {
    // The stored half and the verifying half have to be the same value. A hook
    // that already has *a* secret is not evidence that it is *our* secret — so
    // the secret goes in the call regardless, and a `secretSet` that was already
    // true must not be read as "nothing to do".
    const { api, calls } = fakeGitHub({
      url: 'https://old.example/webhooks/github',
      secret: 'somebody-elses',
    });

    await setAppWebhook(api, CREDENTIALS, { url: 'https://new.example/webhooks/github', secret: 'ours' });

    expect((calls[0]?.body as { secret?: string }).secret).toBe('ours');
  });
});

describe('an address GitHub could never deliver to', () => {
  it('refuses loopback, which is the address the bridge actually listens on', () => {
    // The likely mistake, and the one that looks configured and receives nothing.
    expect(deliverableUrl('http://127.0.0.1:47311/webhooks/github')).toMatch(/cannot reach|https/);
    expect(deliverableUrl('https://localhost:47311/webhooks/github')).toMatch(/cannot reach/);
  });

  it('refuses every loopback and private address over https, however it is written', () => {
    // Only the literal hostname `127.` used to match, so https://127.0.0.1 passed.
    for (const url of [
      'https://127.0.0.1:47311/webhooks/github',
      'https://127.0.0.2/webhooks/github',
      'https://2130706433/webhooks/github',
      'https://[::1]/webhooks/github',
      'https://[::ffff:127.0.0.1]/webhooks/github',
      'https://0.0.0.0/webhooks/github',
      'https://10.1.2.3/webhooks/github',
      'https://172.20.0.5/webhooks/github',
      'https://192.168.1.10/webhooks/github',
      'https://169.254.169.254/webhooks/github',
      'https://[fd12::1]/webhooks/github',
      'https://[fe80::1]/webhooks/github',
      'https://bridge.localhost/webhooks/github',
      'https://box.local/webhooks/github',
    ]) {
      expect(deliverableUrl(url), url).toMatch(/cannot reach/);
    }
    expect(deliverableUrl('https://172.32.0.1/webhooks/github')).toBeNull();
    expect(deliverableUrl('https://localhost.example.com/webhooks/github')).toBeNull();
  });

  it('refuses plain http, because GitHub will not send a secret over it', () => {
    expect(deliverableUrl('http://fleetadlc.example.com/webhooks/github')).toMatch(/https/);
  });

  it('accepts a public https address', () => {
    expect(deliverableUrl('https://calm-badger-42.trycloudflare.com/webhooks/github')).toBeNull();
  });

  it('is enforced by the setter, not just offered as a check', async () => {
    const { api, calls } = fakeGitHub();
    await expect(
      setAppWebhook(api, CREDENTIALS, { url: 'http://127.0.0.1:47311/webhooks/github', secret: 'x' }),
    ).rejects.toThrow();
    // Nothing was sent: GitHub never saw the undeliverable address.
    expect(calls).toEqual([]);
  });
});

describe('what GitHub last delivered to the hook', () => {
  it('reads the most recent delivery GitHub recorded, and nothing when there is none', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const { lastAppWebhookDelivery } = await import('./app-hook.js');
    const paths: string[] = [];
    const api = (answer: unknown) => ({
      request: async <T>(_method: string, path: string): Promise<T> => {
        paths.push(path);
        return answer as T;
      },
    });
    const credentials = { clientId: 'Iv23liTEST', privateKey };

    await expect(
      lastAppWebhookDelivery(
        api([{ id: 1, event: 'issue_comment', action: 'created', status_code: 200, delivered_at: '2026-09-24T17:58:00Z', redelivery: false }]),
        credentials,
      ),
    ).resolves.toEqual({ event: 'issue_comment', action: 'created', statusCode: 200, deliveredAt: '2026-09-24T17:58:00Z', redelivery: false });
    expect(paths[0]).toBe('/app/hook/deliveries?per_page=1');

    await expect(lastAppWebhookDelivery(api([]), credentials)).resolves.toBeNull();
    await expect(lastAppWebhookDelivery(api({ message: 'odd' }), credentials)).resolves.toBeNull();
  });
});

/**
 * The ping GitHub sends as it creates an app with its webhook on arrives
 * before OpenADLC holds the secret it is signed with, so the bridge refuses it.
 * Once the secret is stored, it is asked for again.
 */
describe('asking again for a first delivery the bridge refused', () => {
  function deliveries(listed: unknown[]) {
    const calls: { method: string; path: string }[] = [];
    const api: AppApi = {
      request: async <T>(method: string, path: string): Promise<T> => {
        calls.push({ method, path });
        return (method === 'GET' ? listed : {}) as T;
      },
    };
    return { api, calls };
  }

  it('asks GitHub to deliver the newest one again when it was refused', async () => {
    const { redeliverLatestFailure } = await import('./app-hook.js');
    const { api, calls } = deliveries([{ id: 90210, event: 'ping', status_code: 401, delivered_at: '2026-09-24T17:58:00Z' }]);

    expect(await redeliverLatestFailure(api, CREDENTIALS)).toBe(true);
    expect(calls).toEqual([
      { method: 'GET', path: '/app/hook/deliveries?per_page=1' },
      { method: 'POST', path: '/app/hook/deliveries/90210/attempts' },
    ]);
  });

  it('leaves alone one that went through, and asks nothing when there is none yet', async () => {
    const { redeliverLatestFailure } = await import('./app-hook.js');

    const through = deliveries([{ id: 1, event: 'ping', status_code: 200, delivered_at: '2026-09-24T17:58:00Z' }]);
    expect(await redeliverLatestFailure(through.api, CREDENTIALS)).toBe(false);
    expect(through.calls.map((call) => call.method)).toEqual(['GET']);

    // Not attempted yet: it will arrive after the secret is stored, and pass.
    const none = deliveries([]);
    expect(await redeliverLatestFailure(none.api, CREDENTIALS)).toBe(false);
    expect(none.calls.map((call) => call.method)).toEqual(['GET']);
  });
});

/**
 * GitHub does not send a failed delivery again by itself. A gate answered on
 * GitHub while the bridge was down reached it only as such a delivery, and
 * was lost; the bridge now asks GitHub to send those again.
 */
describe('sending again what GitHub could not deliver', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z');
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

  function deliveries(pages: Record<string, unknown>[][]) {
    const posted: string[] = [];
    const read: string[] = [];
    const api: AppApi = {
      request: async <T>(method: string, path: string): Promise<T> => {
        if (method === 'POST') posted.push(path);
        return {} as T;
      },
      page: async <T>(path: string): Promise<{ items: T; next: string | null }> => {
        read.push(path);
        const index = read.length - 1;
        return { items: (pages[index] ?? []) as T, next: index + 1 < pages.length ? `/app/hook/deliveries?per_page=100&cursor=c${index + 1}` : null };
      },
    };
    return { api, posted, read };
  }
  const delivery = (id: number, guid: string, status_code: number, minutesAgo: number, redelivery = false) => ({
    id,
    guid,
    status_code,
    delivered_at: at(minutesAgo),
    redelivery,
    event: 'issue_comment',
  });

  it('redelivers a 502 and a delivery that got no answer, and not a 401 or one that went through on a second try', async () => {
    const { redeliverFailedSince } = await import('./app-hook.js');
    const { api, posted } = deliveries([
      [
        delivery(5, 'guid-retried', 200, 1, true),
        delivery(4, 'guid-401', 401, 2),
        delivery(3, 'guid-0', 0, 3),
        delivery(2, 'guid-502', 502, 4),
        delivery(1, 'guid-retried', 503, 5),
      ],
    ]);

    expect(await redeliverFailedSince(api, CREDENTIALS, NOW - 60 * 60_000, NOW)).toEqual([3, 2]);
    expect(posted).toEqual(['/app/hook/deliveries/3/attempts', '/app/hook/deliveries/2/attempts']);
  });

  it('reads the next page until it passes the time it was given', async () => {
    const { redeliverFailedSince } = await import('./app-hook.js');
    const { api, posted, read } = deliveries([
      [delivery(4, 'guid-a', 200, 1), delivery(3, 'guid-b', 0, 10)],
      [delivery(2, 'guid-c', 502, 20), delivery(1, 'guid-d', 502, 90)],
      [delivery(0, 'guid-e', 502, 100)],
    ]);

    expect(await redeliverFailedSince(api, CREDENTIALS, NOW - 60 * 60_000, NOW)).toEqual([3, 2]);
    expect(read).toEqual(['/app/hook/deliveries?per_page=100', '/app/hook/deliveries?per_page=100&cursor=c1']);
    expect(posted).not.toContain('/app/hook/deliveries/1/attempts');
  });

  it('never looks back past GitHub’s three days, whatever it is asked', async () => {
    const { redeliverFailedSince } = await import('./app-hook.js');
    const { api, posted } = deliveries([[delivery(2, 'guid-new', 502, 60), delivery(1, 'guid-old', 502, 3 * 24 * 60 + 5)]]);

    expect(await redeliverFailedSince(api, CREDENTIALS, 0, NOW)).toEqual([2]);
    expect(posted).toEqual(['/app/hook/deliveries/2/attempts']);
  });

  it('leaves alone a delivery it has already sent again three times', async () => {
    const { redeliverFailedSince } = await import('./app-hook.js');
    const { api, posted } = deliveries([
      [
        delivery(4, 'guid-stuck', 500, 1, true),
        delivery(3, 'guid-stuck', 500, 2, true),
        delivery(2, 'guid-stuck', 500, 3, true),
        delivery(1, 'guid-stuck', 500, 4),
      ],
    ]);

    expect(await redeliverFailedSince(api, CREDENTIALS, NOW - 60 * 60_000, NOW)).toEqual([]);
    expect(posted).toEqual([]);
  });
});
