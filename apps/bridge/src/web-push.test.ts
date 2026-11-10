import { createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encryptPayload,
  endpointHash,
  fromB64url,
  MAX_PLAINTEXT,
  newVapidKey,
  parseVapidKey,
  pushPayload,
  pushRequest,
  pushServiceOf,
  pushServiceRefusal,
  pushTag,
  subscriptionKeysRefusal,
  vapidAuthorization,
  vapidKeys,
  vapidSubject,
  type VapidKeyStore,
} from './web-push.js';

/**
 * RFC 8291, Appendix A: one message, encrypted with a fixed application
 * server key and salt, to a fixed user agent. Every byte of the body is
 * fixed, so a body that differs is a body no browser could decrypt.
 */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function memoryVapidStore(): VapidKeyStore & { value: string | null; made: number } {
  const state = { value: null as string | null, made: 0 };
  let chain: Promise<unknown> = Promise.resolve();
  return Object.assign(state, {
    vapidKey: async () => state.value,
    setVapidKey: async (value: string) => {
      state.made += 1;
      state.value = value;
    },
    lockVapid: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn);
      chain = run.catch(() => undefined);
      return run;
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the payload encryption, RFC 8291', () => {
  it('gives exactly Appendix A’s body for its keys, salt and message', () => {
    const body = encryptPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.uaPublic, auth: RFC8291.auth },
      { ephemeralPrivate: fromB64url(RFC8291.asPrivate), salt: fromB64url(RFC8291.salt) },
    );
    expect(body.toString('base64url')).toBe(RFC8291.body);
  });

  it('uses a new key and salt on every send otherwise', () => {
    const keys = { p256dh: RFC8291.uaPublic, auth: RFC8291.auth };
    const one = encryptPayload('x', keys);
    const two = encryptPayload('x', keys);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.readUInt32BE(16)).toBe(4096);
    expect(one[20]).toBe(65);
  });

  it('refuses a message that does not fit one record', () => {
    expect(() => encryptPayload('x'.repeat(MAX_PLAINTEXT + 1), { p256dh: RFC8291.uaPublic, auth: RFC8291.auth })).toThrow(/at most/);
  });
});

describe('the subscription’s keys', () => {
  it('take only a 65-byte P-256 point and a 16-byte secret', () => {
    expect(subscriptionKeysRefusal({ p256dh: RFC8291.uaPublic, auth: RFC8291.auth })).toBeNull();
    expect(subscriptionKeysRefusal({ p256dh: 'AAAA', auth: RFC8291.auth })).toMatch(/not a P-256 point/);
    expect(subscriptionKeysRefusal({ p256dh: `B${'A'.repeat(86)}`, auth: RFC8291.auth })).toMatch(/not a P-256 point/);
    expect(subscriptionKeysRefusal({ p256dh: RFC8291.uaPublic, auth: 'AAAA' })).toMatch(/16 bytes/);
    expect(subscriptionKeysRefusal(null)).toMatch(/no keys/);
  });
});

describe('the endpoints the bridge sends to', () => {
  it('are the four push services, over https with no port or user', () => {
    expect(pushServiceRefusal('https://fcm.googleapis.com/fcm/send/abc')).toBeNull();
    expect(pushServiceRefusal('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBeNull();
    expect(pushServiceRefusal('https://web.push.apple.com/QH8')).toBeNull();
    expect(pushServiceOf('https://wns2-by3p.notify.windows.com/w/?token=abc')).toBe('wns2-by3p.notify.windows.com');
  });

  it('refuse anything else in words a person can act on', () => {
    const words = 'is not one OpenADLC sends to: use Chrome, Edge, Firefox or Safari';
    expect(pushServiceRefusal('https://169.254.169.254/computeMetadata')).toContain(words);
    expect(pushServiceRefusal('http://fcm.googleapis.com/fcm/send/abc')).toContain(words);
    expect(pushServiceRefusal('https://fcm.googleapis.com:8443/fcm/send/abc')).toContain(words);
    expect(pushServiceRefusal('https://me:pw@fcm.googleapis.com/fcm/send/abc')).toContain(words);
    expect(pushServiceRefusal('https://notify.windows.com.evil.example/x')).toContain(words);
    expect(pushServiceRefusal('https://.notify.windows.com/x')).not.toBeNull();
    expect(pushServiceRefusal('not a url')).toMatch(/turn notifications on again/);
  });
});

describe('the install’s VAPID key, RFC 8292', () => {
  it('is made once: a second call, and two at once, read the same key', async () => {
    const store = memoryVapidStore();
    const [a, b] = await Promise.all([vapidKeys(store), vapidKeys(store)]);
    const c = await vapidKeys(store);
    expect(store.made).toBe(1);
    expect(a.publicKey).toBe(b.publicKey);
    expect(c.publicKey).toBe(a.publicKey);
    expect(fromB64url(a.publicKey)).toHaveLength(65);
  });

  it('is replaced only when what is stored is not a key at all', () => {
    expect(parseVapidKey('not json')).toBeNull();
    expect(parseVapidKey(JSON.stringify({ kty: 'EC', crv: 'P-384' }))).toBeNull();
    expect(parseVapidKey(newVapidKey())).not.toBeNull();
  });

  it('signs a JWT the public key verifies, for the push service’s origin, for under a day', () => {
    const keys = parseVapidKey(newVapidKey())!;
    const now = new Date('2026-11-10T12:00:00Z');
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://console.example.com', now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    const point = fromB64url(k!);
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, fromB64url(signature!))).toBe(true);
    expect(JSON.parse(fromB64url(head!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const body = JSON.parse(fromB64url(claims!).toString()) as { aud: string; exp: number; sub: string };
    expect(body.aud).toBe('https://fcm.googleapis.com');
    expect(body.sub).toBe('https://console.example.com');
    expect(body.exp).toBeGreaterThan(now.getTime() / 1000);
    expect(body.exp).toBeLessThanOrEqual(now.getTime() / 1000 + 24 * 3600);
  });

  it('names the console as its subject only over https off this computer: Apple refuses localhost', () => {
    expect(vapidSubject('https://openadlc.example.com/', 'a@example.com')).toBe('https://openadlc.example.com');
    expect(vapidSubject('http://127.0.0.1:3000', 'a@example.com')).toBe('mailto:a@example.com');
    expect(vapidSubject('https://localhost:3000', 'a@example.com')).toBe('mailto:a@example.com');
    expect(vapidSubject('http://127.0.0.1:3000', null)).toMatch(/^mailto:/);
  });

  it('never prints the private key', async () => {
    const said: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        said.push(args.map(String).join(' '));
      });
    }
    const store = memoryVapidStore();
    const keys = await vapidKeys(store);
    pushRequest({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.auth } }, '{}', { keys, sub: 'mailto:a@example.com' });
    expect(said.join('\n')).not.toContain(keys.privateJwk.d!);
  });
});

describe('the request a push is', () => {
  it('is an encrypted POST to the endpoint, kept a day, with a topic from the tag', () => {
    const keys = parseVapidKey(newVapidKey())!;
    const { url, init } = pushRequest(
      { endpoint: 'https://web.push.apple.com/QH8', keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.auth } },
      pushPayload({ event: 'gate_opened', text: 'hi', link: 'https://c.example.com/?item=x' }),
      { keys, sub: 'mailto:a@example.com', tag: 'openadlc-needs-you:task:2' },
    );
    expect(url).toBe('https://web.push.apple.com/QH8');
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.ttl).toBe('86400');
    expect(headers.urgency).toBe('normal');
    expect(headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(headers.authorization).toMatch(/^vapid t=/);
    expect(Buffer.from(init.body as Uint8Array).toString('utf8')).not.toContain('hi');
  });

  it('tags an item as the open console’s alert does, without its occurrence', () => {
    expect(pushTag({ event: 'merge_waiting', link: 'x', item: 'task:2@2026-11-10T10:00:00Z' })).toBe('openadlc-needs-you:task:2');
    expect(pushTag({ event: 'cap_warning', link: 'https://c/x' })).toBe('openadlc:cap_warning:https://c/x');
  });

  it('cuts a long text so the payload fits the one record', () => {
    const payload = pushPayload({ event: 'gate_opened', text: 'é'.repeat(5000), link: 'https://c.example.com' });
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_PLAINTEXT);
    expect(JSON.parse(payload).body.endsWith('…')).toBe(true);
  });

  it('hashes the endpoint, and keeps nothing of it readable', () => {
    expect(endpointHash('https://fcm.googleapis.com/fcm/send/abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
