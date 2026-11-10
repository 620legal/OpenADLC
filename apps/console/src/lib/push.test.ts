import { describe, expect, it } from 'vitest';
import { deviceName, fingerprint, isIos, keyBytes, needsResave, pushSupport, readThisDevice, THIS_DEVICE_KEY, writeThisDevice, type PushEnvironment } from './push';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

const desktop: PushEnvironment = { isSecureContext: true, userAgent: MAC_CHROME, hasServiceWorker: true, hasPushManager: true, permission: 'default' };

describe('whether this browser can take push', () => {
  it('can, on a secure page with a service worker, a push manager and notifications', () => {
    expect(pushSupport(desktop)).toBe('ok');
    expect(pushSupport({ ...desktop, permission: 'granted' })).toBe('ok');
  });

  it('cannot on a page that is not secure: a LAN address over http', () => {
    expect(pushSupport({ ...desktop, isSecureContext: false })).toBe('insecure');
  });

  it('on iOS, only once opened from the Home Screen', () => {
    const safari: PushEnvironment = { isSecureContext: true, userAgent: IPHONE, hasServiceWorker: true, hasPushManager: false, permission: undefined };
    expect(pushSupport(safari)).toBe('ios-add-to-home-screen');
    expect(pushSupport({ ...safari, userAgent: IPAD_DESKTOP, maxTouchPoints: 5 })).toBe('ios-add-to-home-screen');
    expect(pushSupport({ ...safari, standalone: true, hasPushManager: true, permission: 'default' })).toBe('ok');
  });

  it('says so when notifications are blocked, or the browser has none', () => {
    expect(pushSupport({ ...desktop, permission: 'denied' })).toBe('denied');
    expect(pushSupport({ ...desktop, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...desktop, permission: undefined })).toBe('unsupported');
  });

  it('tells an iPad asking for the desktop site from a Mac', () => {
    expect(isIos(IPAD_DESKTOP, 5)).toBe(true);
    expect(isIos(IPAD_DESKTOP, 0)).toBe(false);
  });
});

describe('what a device is called', () => {
  it('names the platform and the browser', () => {
    expect(deviceName(IPHONE)).toBe('iPhone · Safari');
    expect(deviceName(IPAD_DESKTOP, 5)).toBe('iPad · Safari');
    expect(deviceName(MAC_CHROME)).toBe('Mac · Chrome');
    expect(deviceName(ANDROID_CHROME)).toBe('Android · Chrome');
    expect(deviceName(WINDOWS_EDGE)).toBe('Windows · Edge');
    expect(deviceName(LINUX_FIREFOX)).toBe('Linux · Firefox');
  });
});

describe('the install’s key', () => {
  it('is read from base64url into the 65 bytes a browser subscribes with', () => {
    const key = `BP${'A'.repeat(85)}`;
    const bytes = keyBytes(key);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });
});

describe('saving this browser again on load', () => {
  it('saves a renewed subscription, or one the bridge no longer has, and leaves a browser that never saved one alone', async () => {
    const first = await fingerprint('https://fcm.googleapis.com/fcm/send/one');
    const renewed = await fingerprint('https://fcm.googleapis.com/fcm/send/two');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const saved = { id: 'd1', fingerprint: first };
    expect(needsResave(first, saved, ['d1'])).toBe(false);
    expect(needsResave(renewed, saved, ['d1'])).toBe(true);
    expect(needsResave(first, saved, [])).toBe(true);
    expect(needsResave(first, null, [])).toBe(false);
    expect(needsResave(null, saved, [])).toBe(false);
  });

  it('remembers which device it is, and keeps no endpoint', () => {
    const items: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => items[key] ?? null,
      setItem: (key: string, value: string) => {
        items[key] = value;
      },
      removeItem: (key: string) => {
        delete items[key];
      },
    };
    writeThisDevice(storage, { id: 'd1', fingerprint: 'ab' });
    expect(readThisDevice(storage)).toEqual({ id: 'd1', fingerprint: 'ab' });
    expect(items[THIS_DEVICE_KEY]).not.toContain('https://');
    writeThisDevice(storage, null);
    expect(readThisDevice(storage)).toBeNull();
  });
});
