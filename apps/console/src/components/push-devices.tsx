'use client';

import { useEffect, useState } from 'react';
import { addPushDevice, removePushDevice, testAllPushDevices, testPushDevice } from '@/app/actions';
import { testOutcome } from '@/components/notification-settings';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
// Types only: '@/lib/api' reads the server's environment on import.
import type { PushDevicesView, PushTestAll } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  browserEnvironment,
  currentSubscription,
  deviceName,
  fingerprint,
  needsResave,
  pushSupport,
  readThisDevice,
  turnOn,
  writeThisDevice,
  type PushSupport,
} from '@/lib/push';

/**
 * This device, and the others: each browser or installed app where the
 * signed-in person turned notifications on (ADR 0048). Everything the bridge
 * would tell them — the items routed to them, and for an admin what the
 * install's channel carries — arrives there as a push, whether or not the
 * console is open.
 *
 * The subscription goes to the bridge once and is kept in its secret store;
 * what comes back, and what this list shows, is a name and when it was added.
 */

export const SUPPORT_WORDS: Record<Exclude<PushSupport, 'ok'>, string> = {
  'ios-add-to-home-screen': 'Add OpenADLC to your Home Screen first (Share → Add to Home Screen), then open it from there',
  insecure: 'Notifications need the console over https or on this computer’s 127.0.0.1',
  unsupported: 'This browser does not take push notifications: use Chrome, Edge, Firefox or Safari',
  denied: 'Notifications are blocked for this site: allow them in the browser’s site settings, then reload',
};

/** What Send a test notification says when there is nothing to send to: never that it was sent. */
export const NO_DEVICES_LINE = 'You have no devices yet: turn notifications on on this device first';

export const LOCAL_LINE = 'A phone cannot reach this install at http://127.0.0.1, so notifications here are for this computer. A phone needs a cloud install.';

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function PushDevices({ initial, local, support: given }: { initial: PushDevicesView; local: boolean; support?: PushSupport }) {
  const [view, setView] = useState(initial);
  // Unknown until the page is in a browser: the server cannot say what this one can do.
  const [support, setSupport] = useState<PushSupport | null>(given ?? null);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  const [tested, setTested] = useState<PushTestAll['devices'] | null>(null);

  useEffect(() => {
    if (given === undefined) setSupport(pushSupport(browserEnvironment()));
    const kept = storage();
    const saved = kept ? readThisDevice(kept) : null;
    setThisDevice(saved?.id ?? null);
    // A browser renews its subscription when it likes; saved again here, the
    // device keeps working without its person turning it on again.
    void (async () => {
      const subscription = await currentSubscription().catch(() => null);
      if (!subscription || !kept) return;
      const current = await fingerprint(subscription.endpoint);
      if (!needsResave(current, saved, initial.devices.map((device) => device.id))) return;
      const answer = await addPushDevice(subscription, deviceName(navigator.userAgent, navigator.maxTouchPoints));
      if (!answer.ok || !answer.device) return;
      const device = answer.device;
      writeThisDevice(kept, { id: device.id, fingerprint: current });
      setThisDevice(device.id);
      setView((before) => ({ ...before, devices: [...before.devices.filter((one) => one.id !== device.id), { ...device, last: null }] }));
    })();
  }, [given, initial.devices]);

  async function turnOnHere() {
    setBusy('on');
    setSaid(null);
    setTested(null);
    // Inside the tap: Safari and Firefox ask for the permission only from one.
    const subscribed = await turnOn(view.key);
    if (!subscribed.ok) {
      setBusy(null);
      setSaid({ text: subscribed.error, failed: true });
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') setSupport('denied');
      return;
    }
    const answer = await addPushDevice(subscribed.subscription, deviceName(navigator.userAgent, navigator.maxTouchPoints));
    setBusy(null);
    if (!answer.ok || !answer.device) {
      setSaid({ text: answer.error ?? 'Notifications were not turned on for this device', failed: true });
      return;
    }
    const device = answer.device;
    const kept = storage();
    if (kept) writeThisDevice(kept, { id: device.id, fingerprint: await fingerprint(subscribed.subscription.endpoint) });
    setThisDevice(device.id);
    setView((before) => ({ ...before, devices: [...before.devices.filter((one) => one.id !== device.id), { ...device, last: null }] }));
    setSaid({ text: 'Notifications are on for this device. Send a test to make sure they arrive.', failed: false });
  }

  async function test(id: string) {
    setBusy(`test:${id}`);
    setSaid(null);
    setTested(null);
    const answer = await testPushDevice(id);
    setBusy(null);
    if (!answer.ok || !answer.result) {
      setSaid({ text: answer.error ?? 'The test was not sent', failed: true });
      return;
    }
    setSaid({ text: testOutcome(answer.result), failed: !answer.result.ok });
  }

  // Every device at once, through the bridge's own send: one answer, a line
  // for each device, rather than one round trip per device from here.
  async function testAll() {
    setBusy('test-all');
    setSaid(null);
    setTested(null);
    const answer = await testAllPushDevices();
    setBusy(null);
    if (!answer.ok || !answer.result) {
      setSaid({ text: answer.error ?? 'The test was not sent', failed: true });
      return;
    }
    if (answer.result.devices.length === 0) {
      setSaid({ text: NO_DEVICES_LINE, failed: true });
      return;
    }
    setTested(answer.result.devices);
    // A gone device was dropped by the bridge, as any send drops it.
    const gone = new Set(answer.result.devices.filter((device) => device.status === 404 || device.status === 410).map((device) => device.id));
    setView((before) => ({ ...before, devices: before.devices.filter((device) => !gone.has(device.id)) }));
  }

  async function remove(id: string) {
    setBusy(`remove:${id}`);
    setSaid(null);
    setTested(null);
    const answer = await removePushDevice(id);
    setBusy(null);
    if (!answer.ok) {
      setSaid({ text: answer.error ?? 'The device was not removed', failed: true });
      return;
    }
    if (id === thisDevice) {
      const kept = storage();
      if (kept) writeThisDevice(kept, null);
      setThisDevice(null);
    }
    setView((before) => ({ ...before, devices: before.devices.filter((one) => one.id !== id) }));
    setSaid({ text: 'Removed. That device gets no more notifications.', failed: false });
  }

  const here = thisDevice !== null && view.devices.some((device) => device.id === thisDevice);

  return (
    <SettingsCard id="this-device" title="Notifications on your devices" line="Push to your phone and computer, whether or not the console is open.">
      <div className="flex flex-wrap items-center gap-2 pb-2.5">
        <Button size="sm" disabled={busy !== null || view.devices.length === 0} onClick={() => void testAll()}>
          Send a test notification
        </Button>
        {view.devices.length === 0 && <p className="text-[12.5px] text-muted">{NO_DEVICES_LINE}</p>}
      </div>
      {tested && (
        <ul aria-label="Test results" role="status" className="flex flex-col gap-0.5 pb-2.5">
          {tested.map((device) => (
            <li key={device.id} className={cn('text-[12.5px]', device.ok ? 'text-muted' : 'text-alarm')}>
              {device.name}: {testOutcome(device)}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12.5px] text-muted">
        Turn notifications on in each browser, or in the console installed as an app, where you want them. What OpenADLC would tell you arrives there.
      </p>
      {local && <p className="pt-2 text-[12.5px] text-muted">{LOCAL_LINE}</p>}

      <div className="flex flex-wrap items-center gap-2 py-2.5">
        {support === 'ok' && !here && (
          <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void turnOnHere()}>
            Turn on notifications on this device
          </Button>
        )}
        {support !== null && support !== 'ok' && <p className="text-[12.5px] text-attention">{SUPPORT_WORDS[support]}</p>}
        {here && <p className="text-[12.5px] text-muted">Notifications are on for this device.</p>}
      </div>

      {view.allFailing && (
        <p role="alert" className="border-t border-well py-2.5 text-[12.5px] text-alarm">
          None of your devices took the last notification: {view.devices.find((device) => device.last?.error)?.last?.error ?? 'each push service refused it'}.
          Send a test to one, or turn notifications on again there.
        </p>
      )}
      {view.dropped.map((drop) => (
        <p key={`${drop.name}-${drop.at}`} className="border-t border-well py-2.5 text-[12.5px] text-attention">
          Removed {drop.name} on {when(drop.at)}: its browser stopped taking notifications. Turn notifications on there again.
        </p>
      ))}

      {view.devices.length > 0 && (
        <ul aria-label="Your devices" className="flex flex-col border-t border-well">
          {view.devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center gap-2 border-b border-well py-2 last:border-b-0">
              <span className="min-w-0 flex-1 text-[13px] text-body">
                {device.name}
                {device.id === thisDevice && <span className="text-muted"> (this device)</span>}
                <span className="block text-[12px] text-muted">
                  Added {when(device.addedAt)}
                  {device.last && (
                    <span className={cn(device.last.ok ? 'text-muted' : 'text-alarm')}>
                      {' · '}
                      {device.last.ok ? `last took one ${when(device.last.at)}` : `last failed ${when(device.last.at)}`}
                    </span>
                  )}
                </span>
              </span>
              <Button size="sm" disabled={busy !== null} onClick={() => void test(device.id)}>
                Send a test
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={() => void remove(device.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {said && (
        <p role="status" className={cn('pt-2 text-[12.5px]', said.failed ? 'text-alarm' : 'text-muted')}>
          {said.text}
        </p>
      )}
    </SettingsCard>
  );
}
