'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useBrand } from '@/components/app-header';
import {
  ALERT_DEFAULTS,
  ALERT_KEYS,
  ALERTS_CHANGED,
  notifyBlockedReason,
  notifyState,
  storeAlert,
  storedAlerts,
  turnOnNotifications,
  type AlertPreferences,
  type AlertSwitch,
  type NotifyState,
} from '@/lib/alert-preferences';
import { cn } from '@/lib/cn';
import type { HeaderData, NeedsItem } from '@/lib/header';
import { batchText, chime, claimAcrossTabs, consoleName, faviconSvg, newItems, titleFor, type AudioContextLike } from '@/lib/needs-you-alerts';

/**
 * What this document has already seen, kept outside any component. `AppShell`
 * is drawn again on every move between the console's pages, and a baseline
 * kept in its state started over each time: every item waiting would have
 * been new again on the next page. "Since the page loaded" is since the
 * document did.
 */
let seen: ReadonlySet<string> | null = null;

/** Forgets what this document has seen, as a reload does. For tests. */
export function forgetSeenItems(): void {
  seen = null;
}

const NEEDS_YOU = '/needs-you';

function readPreferences(): AlertPreferences {
  return storedAlerts();
}

/** The switches as stored, following a change from this tab or another; the defaults until mounted. */
function useAlertPreferences(): AlertPreferences {
  const [preferences, setPreferences] = useState<AlertPreferences>(ALERT_DEFAULTS);
  useEffect(() => {
    const follow = () => setPreferences(readPreferences());
    follow();
    const fromStorage = (event: StorageEvent) => {
      if (event.key === null || Object.values(ALERT_KEYS).includes(event.key)) follow();
    };
    window.addEventListener(ALERTS_CHANGED, follow);
    window.addEventListener('storage', fromStorage);
    return () => {
      window.removeEventListener(ALERTS_CHANGED, follow);
      window.removeEventListener('storage', fromStorage);
    };
  }, []);
  return preferences;
}

function browserNotifyState(): NotifyState {
  return notifyState(typeof window === 'undefined' ? {} : (window as unknown as Parameters<typeof notifyState>[0]));
}

/**
 * Tells a person with the console in a background tab that something waits
 * on them: the count in the tab's title and a dot for its icon, and, when
 * they switched them on, a short sound and a desktop notification for what
 * is new. It draws nothing; it is fed by the live refresh's reads, through
 * the header's data, and a bridge that did not answer (`needsYou` null)
 * changes none of it.
 *
 * Only in the browser: the title, the icon and the router it opens an item
 * with are the browser's, and a page drawn on the server has none of them.
 */
export function NeedsYouAlerts({ data }: { data: Pick<HeaderData, 'needsYou' | 'needsItems'> }) {
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);
  return inBrowser ? <Alerts data={data} /> : null;
}

function Alerts({ data }: { data: Pick<HeaderData, 'needsYou' | 'needsItems'> }) {
  const name = consoleName(useBrand());
  const preferences = useAlertPreferences();
  const router = useRouter();
  const current = useRef({ preferences, router });
  current.current = { preferences, router };
  const shown = preferences.tab && data.needsYou !== null && data.needsYou > 0;

  useEffect(() => {
    document.title = titleFor(data.needsYou, name, preferences.tab);
  }, [data.needsYou, name, preferences.tab]);

  useEffect(() => {
    if (!shown) return;
    // Its own link, put last so it wins over any other; taking it away gives
    // back whatever icon the tab had.
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = faviconSvg();
    link.setAttribute('data-needs-you', '');
    document.head.appendChild(link);
    return () => link.remove();
  }, [shown]);

  useEffect(() => {
    const read = newItems(seen, data.needsItems);
    seen = read.seen;
    const { preferences: now, router: to } = current.current;
    const notify = now.notify && browserNotifyState() === 'granted';
    if (read.fresh.length === 0 || (!now.sound && !notify)) return;
    let store: Storage | null = null;
    try {
      store = localStorage;
    } catch {
      // Site data blocked: no other tab to share with that way.
    }
    const mine = store ? new Set(claimAcrossTabs(read.fresh.map((item) => item.id), store, Date.now())) : null;
    const fresh = mine ? read.fresh.filter((item) => mine.has(item.id)) : read.fresh;
    if (fresh.length === 0) return;
    if (now.sound) chime((window as unknown as { AudioContext?: AudioContextLike }).AudioContext);
    if (notify) raise(fresh, (href) => to.push(href));
  }, [data.needsItems]);

  return null;
}

/** One notification: the item's own, or one for several. A click brings the tab forward and opens it. */
function raise(fresh: readonly NeedsItem[], go: (href: string) => void): void {
  const one = fresh.length === 1 ? fresh[0]! : null;
  const href = one?.item ? `${NEEDS_YOU}?item=${encodeURIComponent(one.item)}` : NEEDS_YOU;
  try {
    const notification = new Notification(one ? one.text : batchText(fresh.length), {
      tag: `openadlc-needs-you:${one ? one.id : 'batch'}`,
    });
    notification.onclick = () => {
      window.focus();
      go(href);
      notification.close();
    };
  } catch {
    // Chrome on Android takes notifications only from a service worker; the title still says it.
  }
}

const SWITCHES: readonly { key: AlertSwitch; label: string }[] = [
  { key: 'tab', label: 'Count in the tab title' },
  { key: 'sound', label: 'Sound' },
  { key: 'notify', label: 'Desktop notifications' },
];

/**
 * The bell beside the needs-you chip: three switches for how this browser
 * says something waits. Every role has it, unlike Settings, which is an
 * admin's; the switches are kept in this browser alone.
 *
 * Desktop notifications show as on only while they are stored on and the
 * browser allows them, so permission taken back in the site's settings reads
 * as off, with the reason under it. The browser's own question is asked from
 * the switch and nowhere else.
 */
export function AlertsMenu({ compact = false }: { compact?: boolean }) {
  const preferences = useAlertPreferences();
  const [permission, setPermission] = useState<NotifyState>('default');
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();

  useEffect(() => setPermission(browserNotifyState()), [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const isOn = (key: AlertSwitch) => (key === 'notify' ? preferences.notify && permission === 'granted' : preferences[key]);

  const flip = async (key: AlertSwitch) => {
    const on = !isOn(key);
    if (key === 'notify' && on) {
      const allowed = await turnOnNotifications(window as unknown as Parameters<typeof turnOnNotifications>[0]);
      setPermission(browserNotifyState());
      storeAlert('notify', allowed);
      return;
    }
    storeAlert(key, on);
  };

  const reason = notifyBlockedReason(permission);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label="Alerts"
        onClick={() => setOpen((shown) => !shown)}
        className={cn(
          'flex items-center justify-center rounded-md text-muted hover:text-body focus-visible:outline-2 focus-visible:outline-link',
          compact ? 'size-11' : 'size-8',
        )}
      >
        <BellIcon />
      </button>
      <div
        id={panel}
        hidden={!open}
        data-alerts-menu
        className="absolute right-0 top-full z-40 mt-1 w-max min-w-[15rem] max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal rounded-lg border border-edge-strong bg-panel p-1 shadow-xl"
      >
        <div className="px-2.5 pb-1 pt-1.5 text-[11.5px] text-muted">How this browser tells you</div>
        {SWITCHES.map(({ key, label }) => (
          <div key={key}>
            <button
              type="button"
              role="switch"
              aria-checked={isOn(key)}
              data-alert={key}
              onClick={() => void flip(key)}
              className="flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-soft hover:bg-well hover:text-body focus-visible:outline-2 focus-visible:outline-link md:h-8 md:text-[12.5px]"
            >
              <span className="min-w-0 flex-1">{label}</span>
              <span aria-hidden className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors', isOn(key) ? 'bg-signal' : 'bg-edge-strong')}>
                <span className={cn('absolute top-0.5 size-3 rounded-full bg-panel transition-[left]', isOn(key) ? 'left-3.5' : 'left-0.5')} />
              </span>
            </button>
            {key === 'notify' && reason && (
              <div data-alert-reason className="px-2.5 pb-1.5 text-[11.5px] text-muted">
                {reason}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A bell, drawn like the console's other line icons: Lucide's (ISC License; THIRD_PARTY_NOTICES at the repository's root). */
function BellIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
