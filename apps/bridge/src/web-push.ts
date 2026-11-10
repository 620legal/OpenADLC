import { createCipheriv, createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type JsonWebKey } from 'node:crypto';

/**
 * Web Push, as RFC 8030 sends it, RFC 8291 encrypts it and RFC 8292 (VAPID)
 * signs it: the protocol only, with no store and no network, so each shape is
 * checked without either (ADR 0048).
 *
 * Built on `node:crypto` alone. The `web-push` package does the same in about
 * the same length, but brings a dependency tree into the bridge for what
 * RFC 8291's own test vectors pin exactly (`web-push.test.ts`).
 */

// ------------------------------------------------------------------ base64url

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

// ------------------------------------------------------------------ which endpoints

/**
 * The push services the bridge sends to. A subscription's endpoint is a URL a
 * signed-in person gave the bridge to POST to from inside the install, the
 * same reach `PERSONAL_KINDS` guards: without a list it could be aimed at a
 * metadata endpoint or a service on the bridge's network. Every browser that
 * takes Web Push uses one of these: Chrome and Edge's FCM, Firefox's
 * autopush, Safari's Apple service, and Windows' WNS for Edge on Windows.
 */
export const PUSH_SERVICES = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'] as const;
export const PUSH_SERVICE_SUFFIX = '.notify.windows.com';

/** The push service's host, when the endpoint is one the bridge sends to; null otherwise. */
export function pushServiceOf(endpoint: string): string | null {
  return pushServiceRefusal(endpoint) === null ? new URL(endpoint).hostname : null;
}

/** Why the bridge would not send to this endpoint, in words a person can act on; null when it would. */
export function pushServiceRefusal(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'This browser’s push subscription has no endpoint OpenADLC can read: turn notifications on again';
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password) {
    return `This browser’s push service (${host || 'unknown'}) is not one OpenADLC sends to: use Chrome, Edge, Firefox or Safari`;
  }
  const known = (PUSH_SERVICES as readonly string[]).includes(host) || (host.endsWith(PUSH_SERVICE_SUFFIX) && host.length > PUSH_SERVICE_SUFFIX.length);
  return known ? null : `This browser’s push service (${host}) is not one OpenADLC sends to: use Chrome, Edge, Firefox or Safari`;
}

// ------------------------------------------------------------------ VAPID (RFC 8292)

export interface VapidKeys {
  /** The P-256 private key, as a JWK. A credential: never logged or returned. */
  privateJwk: JsonWebKey;
  /** The uncompressed public point, base64url: the browser's `applicationServerKey`. */
  publicKey: string;
}

/** Where the install's key is kept, and how its first making is held to one. */
export interface VapidKeyStore {
  vapidKey(): Promise<string | null>;
  setVapidKey(value: string): Promise<void>;
  lockVapid<T>(fn: () => Promise<T>): Promise<T>;
}

export function newVapidKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return JSON.stringify(privateKey.export({ format: 'jwk' }));
}

/** The keys from what is stored, or null for something that is not a P-256 private JWK. */
export function parseVapidKey(stored: string | null): VapidKeys | null {
  if (!stored) return null;
  try {
    const jwk = JSON.parse(stored) as JsonWebKey;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) return null;
    createPrivateKey({ key: jwk, format: 'jwk' });
    return { privateJwk: jwk, publicKey: b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)])) };
  } catch {
    return null;
  }
}

/**
 * The install's VAPID key, made the first time it is asked for. Under a lock,
 * and read again inside it: two bridges starting at once would each make one,
 * and the devices subscribed with the loser's key would be refused for good.
 */
export async function vapidKeys(store: VapidKeyStore): Promise<VapidKeys> {
  const existing = parseVapidKey(await store.vapidKey());
  if (existing) return existing;
  return store.lockVapid(async () => {
    const again = parseVapidKey(await store.vapidKey());
    if (again) return again;
    const made = newVapidKey();
    await store.setVapidKey(made);
    const keys = parseVapidKey(made);
    if (!keys) throw new Error('the VAPID key just made could not be read back');
    return keys;
  });
}

/** How long a signature is good for: RFC 8292 allows at most 24 hours. */
export const VAPID_LIFETIME_S = 12 * 60 * 60;

/**
 * The `Authorization` header: `vapid t=<JWT>, k=<public key>`. The JWT's
 * audience is the push service's origin. Its subject is how the service
 * reaches whoever runs the install: the console's https URL, or a mailto;
 * Apple refuses a localhost one.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, sub: string, now: Date = new Date()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + VAPID_LIFETIME_S, sub })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey({ key: keys.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * The VAPID subject: the console's URL when it is https, otherwise a mailto
 * to whoever runs the install. Apple's service refuses a subject naming
 * localhost, which a local install's console URL does.
 */
export function vapidSubject(consoleUrl: string, adminEmail: string | null): string {
  try {
    const url = new URL(consoleUrl);
    if (url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin;
  } catch {
    // Not a URL: the mailto below.
  }
  return adminEmail ? `mailto:${adminEmail}` : 'mailto:openadlc@users.noreply.github.com';
}

// ------------------------------------------------------------------ encryption (RFC 8291)

export interface SubscriptionKeys {
  /** The browser's P-256 public key, uncompressed, base64url. */
  p256dh: string;
  /** Its 16-byte authentication secret, base64url. */
  auth: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: SubscriptionKeys;
}

/** The record size the body says: the whole body is one record, under 4096 bytes. */
export const RECORD_SIZE = 4096;
/** What fits in the one record: 4096, less the header (86), the delimiter (1) and the tag (16). */
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16;

/** Whether the keys are what a browser gives: a 65-byte uncompressed point and a 16-byte secret. */
export function subscriptionKeysRefusal(keys: { p256dh?: unknown; auth?: unknown } | null | undefined): string | null {
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return 'The subscription has no keys: turn notifications on again';
  const point = fromB64url(keys.p256dh);
  if (point.length !== 65 || point[0] !== 4) return 'The subscription’s p256dh key is not a P-256 point: turn notifications on again';
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(point);
  } catch {
    return 'The subscription’s p256dh key is not a P-256 point: turn notifications on again';
  }
  if (fromB64url(keys.auth).length !== 16) return 'The subscription’s auth secret is not 16 bytes: turn notifications on again';
  return null;
}

/**
 * Encrypts one push message as RFC 8291's `aes128gcm`: one record, padded
 * with nothing but the delimiter. The ephemeral key and the salt are new on
 * every call; they are given only to check RFC 8291's Appendix A.
 */
export function encryptPayload(
  plaintext: Uint8Array | string,
  keys: SubscriptionKeys,
  fixed: { ephemeralPrivate?: Uint8Array; salt?: Uint8Array } = {},
): Buffer {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  if (data.length > MAX_PLAINTEXT) throw new Error(`a push message is at most ${MAX_PLAINTEXT} bytes`);
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed.ephemeralPrivate) ecdh.setPrivateKey(Buffer.from(fixed.ephemeralPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ? Buffer.from(fixed.salt) : randomBytes(16);

  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

// ------------------------------------------------------------------ the message

/** What the service worker is given: encrypted end to end, so the push service reads none of it. */
export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  link: string;
  tag: string;
}

/**
 * The notification's tag. An item's is the one the open console's own alert
 * gives it (`needs-you-alerts.tsx`), the item's id without its occurrence, so
 * on an open but unfocused tab one replaces the other rather than showing twice.
 */
export function pushTag(message: { event: string; link: string; item?: string }): string {
  if (message.item) return `openadlc-needs-you:${message.item.split('@')[0]}`;
  return `openadlc:${message.event}:${message.link}`;
}

/** The payload, its text cut so the whole of it fits in the one record. */
export function pushPayload(message: { event: string; text: string; link: string; item?: string }): string {
  const base: PushPayload = { v: 1, title: 'OpenADLC', body: '', link: message.link, tag: pushTag(message) };
  let body = message.text;
  for (;;) {
    const json = JSON.stringify({ ...base, body });
    if (Buffer.byteLength(json, 'utf8') <= MAX_PLAINTEXT) return json;
    // Cut by characters, not bytes, so a character is never split.
    const over = Buffer.byteLength(json, 'utf8') - MAX_PLAINTEXT;
    body = `${Array.from(body).slice(0, Math.max(0, Array.from(body).length - over - 1)).join('')}…`;
  }
}

/**
 * The POST to the push service, without sending it. `Topic` lets a newer push
 * about the same thing replace an older one the device has not taken yet: it
 * is at most 32 characters of the URL-safe alphabet, so a hash of the tag.
 */
export function pushRequest(
  subscription: PushSubscription,
  payload: string,
  options: { keys: VapidKeys; sub: string; now?: Date; tag?: string; ttl?: number },
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    ttl: String(options.ttl ?? 86_400),
    urgency: 'normal',
    authorization: vapidAuthorization(subscription.endpoint, options.keys, options.sub, options.now),
  };
  if (options.tag) headers.topic = b64url(createHash('sha256').update(options.tag).digest()).slice(0, 32);
  return {
    url: subscription.endpoint,
    init: { method: 'POST', headers, body: encryptPayload(payload, subscription.keys) },
  };
}

/** The endpoint's hash, which the table keeps to know the same browser saving again. */
export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}
