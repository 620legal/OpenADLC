/**
 * This browser's side of push (ADR 0048): whether it can take push at all,
 * turning it on from a tap, and what to call it in the person's list of
 * devices. Browser-only; the server never imports it.
 */

export type PushSupport = 'ok' | 'ios-add-to-home-screen' | 'insecure' | 'unsupported' | 'denied';

/** The parts of the browser `pushSupport` reads, so a test can give it any. */
export interface PushEnvironment {
  isSecureContext: boolean;
  userAgent: string;
  maxTouchPoints?: number;
  /** iOS's own flag: opened from the Home Screen. */
  standalone?: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  /** `Notification.permission`, or undefined with no Notification at all. */
  permission?: NotificationPermission;
}

export function isIos(userAgent: string, maxTouchPoints = 0): boolean {
  // An iPad asks for the desktop site, and says it is a Mac with a touch screen.
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/**
 * Whether turning notifications on can work here, and if not, why. Safari on
 * iOS gives push only to a page opened from the Home Screen, and has no
 * PushManager until then. Every browser gives it only to a secure page: https,
 * or this computer's own 127.0.0.1, so a console opened on a LAN address
 * cannot have it.
 */
export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.isSecureContext) return 'insecure';
  if (isIos(env.userAgent, env.maxTouchPoints) && !env.standalone && !env.hasPushManager) return 'ios-add-to-home-screen';
  if (!env.hasServiceWorker || !env.hasPushManager || env.permission === undefined) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ok';
}

/** This browser, as `pushSupport` reads it. */
export function browserEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    isSecureContext: window.isSecureContext,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in window,
    permission: typeof Notification === 'undefined' ? undefined : Notification.permission,
  };
}

/** What a person sees a device called: "iPhone · Safari", "Mac · Chrome". */
export function deviceName(userAgent: string, maxTouchPoints = 0): string {
  const platform = /iPhone|iPod/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /CrOS/.test(userAgent)
          ? 'Chromebook'
          : /Macintosh|Mac OS X/.test(userAgent)
            ? 'Mac'
            : /Windows/.test(userAgent)
              ? 'Windows'
              : /Linux/.test(userAgent)
                ? 'Linux'
                : 'Computer';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox|FxiOS/.test(userAgent)
      ? 'Firefox'
      : /Chrome|CriOS|Chromium/.test(userAgent)
        ? 'Chrome'
        : /Safari/.test(userAgent)
          ? 'Safari'
          : 'Browser';
  return `${platform} · ${browser}`;
}

/** The VAPID key the bridge gives, base64url, as `applicationServerKey` takes it. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const binary = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface SubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function asJson(subscription: PushSubscription): SubscriptionJson | null {
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const had = subscription.options?.applicationServerKey;
  if (!had) return true;
  const bytes = new Uint8Array(had);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

/**
 * Turns push on in this browser: the permission, the service worker, the
 * subscription, in that order. It must be called from the tap itself: Safari
 * and Firefox refuse a permission asked for any other way. A subscription
 * made with another key, an install's before it was restored, is replaced.
 */
export async function turnOn(key: string): Promise<{ ok: true; subscription: SubscriptionJson } | { ok: false; error: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, error: permission === 'denied' ? 'Notifications are blocked for this site: allow them in the browser’s site settings, then try again' : 'Notifications were not allowed' };
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const applicationServerKey = keyBytes(key);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, applicationServerKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    const json = asJson(subscription);
    return json ? { ok: true, subscription: json } : { ok: false, error: 'This browser gave no push subscription OpenADLC can use' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'This browser could not turn notifications on' };
  }
}

/** This browser's subscription, when it has one, without asking for anything. */
export async function currentSubscription(): Promise<SubscriptionJson | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager?.getSubscription();
  return subscription ? asJson(subscription) : null;
}

/**
 * Where this browser remembers which of the person's devices it is, and a
 * fingerprint of the endpoint it saved: not the endpoint, which is the
 * credential, so storage holds nothing a push could be sent with.
 */
export const THIS_DEVICE_KEY = 'openadlc-push-device';

export interface ThisDevice {
  id: string;
  fingerprint: string;
}

/** The endpoint's SHA-256, hex. */
export async function fingerprint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readThisDevice(storage: Pick<Storage, 'getItem'>): ThisDevice | null {
  try {
    const parsed = JSON.parse(storage.getItem(THIS_DEVICE_KEY) ?? 'null') as Partial<ThisDevice> | null;
    return parsed && typeof parsed.id === 'string' && typeof parsed.fingerprint === 'string' ? { id: parsed.id, fingerprint: parsed.fingerprint } : null;
  } catch {
    return null;
  }
}

export function writeThisDevice(storage: Pick<Storage, 'setItem' | 'removeItem'>, device: ThisDevice | null): void {
  try {
    if (device) storage.setItem(THIS_DEVICE_KEY, JSON.stringify(device));
    else storage.removeItem(THIS_DEVICE_KEY);
  } catch {
    // Storage refused (a private window): the page only cannot say which is this one.
  }
}

/**
 * Whether this browser's subscription should be saved again on load, given
 * its endpoint's fingerprint: the browser renewed it, or the bridge no longer
 * has the device this browser saved it as. A browser that never saved one
 * here is left alone: it may be someone else's sign-in on a shared computer.
 */
export function needsResave(current: string | null, saved: ThisDevice | null, known: readonly string[]): boolean {
  if (!current || !saved) return false;
  return saved.fingerprint !== current || !known.includes(saved.id);
}
