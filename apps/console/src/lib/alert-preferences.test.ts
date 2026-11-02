import { describe, expect, it, vi } from 'vitest';
import { ALERT_KEYS, notifyBlockedReason, notifyState, storeAlert, storedAlerts, turnOnNotifications } from './alert-preferences';

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

describe('the alert switches', () => {
  it('have the count on and the sound and notification off until switched', () => {
    expect(storedAlerts(memory())).toEqual({ tab: true, sound: false, notify: false });
    expect(storedAlerts(null)).toEqual({ tab: true, sound: false, notify: false });
  });

  it('each keep their own key', () => {
    const store = memory();
    storeAlert('tab', false, store);
    storeAlert('sound', true, store);
    storeAlert('notify', true, store);
    expect(storedAlerts(store)).toEqual({ tab: false, sound: true, notify: true });
    expect(store.values.get(ALERT_KEYS.tab)).toBe('off');
    expect([...store.values.keys()].sort()).toEqual(['openadlc.alerts.notify', 'openadlc.alerts.sound', 'openadlc.alerts.tab']);
  });

  it('hold their defaults where storage throws', () => {
    expect(storedAlerts(throwing)).toEqual({ tab: true, sound: false, notify: false });
    expect(() => storeAlert('sound', true, throwing)).not.toThrow();
  });
});

function browser(permission: string, answer = 'granted') {
  const requestPermission = vi.fn(async () => answer);
  return { env: { Notification: { permission, requestPermission } }, requestPermission };
}

describe('desktop notifications', () => {
  it('say what the browser allows', () => {
    expect(notifyState({})).toBe('unsupported');
    expect(notifyState(browser('granted').env)).toBe('granted');
    expect(notifyState(browser('denied').env)).toBe('denied');
    expect(notifyState(browser('default').env)).toBe('default');
  });

  it('ask the browser only while it has not been answered', async () => {
    const asked = browser('default');
    expect(await turnOnNotifications(asked.env)).toBe(true);
    expect(asked.requestPermission).toHaveBeenCalledTimes(1);

    const refusedNow = browser('default', 'denied');
    expect(await turnOnNotifications(refusedNow.env)).toBe(false);

    const denied = browser('denied');
    expect(await turnOnNotifications(denied.env)).toBe(false);
    expect(denied.requestPermission).not.toHaveBeenCalled();

    const granted = browser('granted');
    expect(await turnOnNotifications(granted.env)).toBe(true);
    expect(granted.requestPermission).not.toHaveBeenCalled();

    expect(await turnOnNotifications({})).toBe(false);
  });

  it('say why the switch stays off', () => {
    expect(notifyBlockedReason('denied')).toBe('Blocked in this browser’s site settings');
    expect(notifyBlockedReason('unsupported')).toBe('This browser does not offer desktop notifications');
    expect(notifyBlockedReason('default')).toBeNull();
    expect(notifyBlockedReason('granted')).toBeNull();
  });
});
