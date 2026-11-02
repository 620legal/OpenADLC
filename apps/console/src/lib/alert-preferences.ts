/**
 * Which needs-you alerts this browser wants: the count and dot on the tab,
 * a sound, a desktop notification. Kept per browser, like the colour mode
 * (`theme.ts`), one key each, and open to every role: Settings is an admin's,
 * and these are anyone's.
 *
 * The count is on unless switched off; the sound and the notification are
 * off unless switched on, since either is an interruption a person chooses.
 */

export type AlertSwitch = 'tab' | 'sound' | 'notify';
export type AlertPreferences = Record<AlertSwitch, boolean>;

export const ALERT_KEYS: Record<AlertSwitch, string> = {
  tab: 'openadlc.alerts.tab',
  sound: 'openadlc.alerts.sound',
  notify: 'openadlc.alerts.notify',
};

export const ALERT_DEFAULTS: AlertPreferences = { tab: true, sound: false, notify: false };

/** Said in this tab when a switch changes; another tab hears the `storage` event. */
export const ALERTS_CHANGED = 'openadlc:alerts-changed';

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** What is stored, each switch at its default when nothing is, including when storage throws. */
export function storedAlerts(store: Pick<Storage, 'getItem'> | null = browserStorage()): AlertPreferences {
  const read = (key: AlertSwitch): boolean => {
    try {
      const value = store?.getItem(ALERT_KEYS[key]);
      return value === 'on' ? true : value === 'off' ? false : ALERT_DEFAULTS[key];
    } catch {
      return ALERT_DEFAULTS[key];
    }
  };
  return { tab: read('tab'), sound: read('sound'), notify: read('notify') };
}

/** Remembers a switch, and says so to this tab. Storage that throws holds it for nothing: the page goes on as it was. */
export function storeAlert(key: AlertSwitch, on: boolean, store: Pick<Storage, 'setItem'> | null = browserStorage()): void {
  try {
    store?.setItem(ALERT_KEYS[key], on ? 'on' : 'off');
  } catch {
    // A private window, or site data blocked.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ALERTS_CHANGED));
}

/** The part of the browser notifications need, so a test can hand it a stand-in. */
export interface NotifyEnv {
  Notification?: {
    readonly permission: string;
    requestPermission(): Promise<string>;
  };
}

export type NotifyState = 'unsupported' | 'denied' | 'default' | 'granted';

export function notifyState(env: NotifyEnv): NotifyState {
  const permission = env.Notification?.permission;
  if (!env.Notification || typeof env.Notification.requestPermission !== 'function') return 'unsupported';
  return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

/**
 * What a person turning notifications on gets: the browser's own question,
 * asked only from the switch and only while the browser has not been
 * answered, and whether the switch may be on. Nothing else asks: a site that
 * asks on load is one people learn to block.
 */
export async function turnOnNotifications(env: NotifyEnv): Promise<boolean> {
  const state = notifyState(env);
  if (state === 'granted') return true;
  if (state !== 'default') return false;
  try {
    return (await env.Notification!.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Why the notification switch is off when the browser is what keeps it off; null when it is not. */
export function notifyBlockedReason(state: NotifyState): string | null {
  if (state === 'denied') return 'Blocked in this browser’s site settings';
  if (state === 'unsupported') return 'This browser does not offer desktop notifications';
  return null;
}
