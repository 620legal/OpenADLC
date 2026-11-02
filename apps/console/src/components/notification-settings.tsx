'use client';

import Link from 'next/link';
import { useState } from 'react';
import { saveNotifications, testNotifications } from '@/app/actions';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
import {
  NOTIFY_SWITCHES,
  type NotificationSettingsUpdate,
  type NotificationSettingsView,
  type NotificationTestResult,
  type NotifySwitch,
  type NotifyTransportKind,
} from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/when';

/**
 * Settings → Notifications: where the bridge tells a person something needs
 * them — an ntfy topic, a Slack incoming webhook or a webhook of their own —
 * which kinds it tells them about, and Send a test, which is what proves it.
 *
 * The target is a credential (a Slack or webhook URL lets anyone post as the
 * install; anyone who knows an ntfy topic can read it), so the bridge shows it
 * back masked, and the field is sent only when something is typed in it: left
 * empty, the one saved is kept.
 */

const KINDS: { kind: NotifyTransportKind; label: string }[] = [
  { kind: 'ntfy', label: 'ntfy' },
  { kind: 'slack', label: 'Slack' },
  { kind: 'webhook', label: 'Webhook' },
];

const TARGET_LABEL: Record<NotifyTransportKind, string> = {
  ntfy: 'Topic',
  slack: 'Incoming-webhook URL',
  webhook: 'URL',
};

const TARGET_HINT: Record<NotifyTransportKind, string> = {
  ntfy: 'Subscribe to the same topic in the ntfy app. Anyone who knows it can read it, so make it hard to guess.',
  slack: 'From the Slack app’s Incoming Webhooks page: https://hooks.slack.com/services/…',
  webhook: 'OpenADLC posts JSON to it: {text, link, event}.',
};

/** What each switch sends, in a person's words. */
export const SWITCH_LABEL: Record<NotifySwitch, string> = {
  gate_opened: 'A bot asks you a question',
  merge_waiting: 'A pull request waits for you to merge or approve it',
  review_stalled: 'A review stopped',
  cap_warning: 'Spending reaches its monthly warning',
  promote_waiting: 'A deploy to production waits for approval',
  check_failing: 'Something only you can do stops work, and when it is fixed',
};

const WHERE: Record<NotifyTransportKind, string> = { ntfy: 'ntfy', slack: 'Slack', webhook: 'Webhook' };

const INPUT =
  'w-full rounded-md border border-edge-strong bg-surface px-2.5 py-1.5 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link';

/** "Delivered (200)", or "Not delivered: 404 Not Found". */
export function testOutcome(result: NotificationTestResult): string {
  if (result.ok) return `Delivered${result.status === null ? '' : ` (${result.status})`}`;
  return `Not delivered: ${[result.status, result.error].filter((part) => part !== null && part !== '').join(' ')}`.trim();
}

/** The line Settings shows for it: where they go, and how the last send went. */
export function notificationsLine(view: NotificationSettingsView | null, now: string | number | Date): string {
  if (!view) return 'The bridge did not say where notifications go.';
  if (view.source === 'none' || !view.kind) return 'Not set';
  const where = [view.source === 'env' ? 'OPENADLC_NOTIFY_WEBHOOK' : WHERE[view.kind], view.target].filter(Boolean).join(' · ');
  if (!view.last) return `${where} · nothing sent yet`;
  if (!view.last.ok) return `${where} · Last send failed`;
  return `${where} · last sent ok ${ago(view.last.at, now)}`;
}

/** Settings' card for it, linking to the page that changes it. */
export function NotificationsSummary({ view, now }: { view: NotificationSettingsView | null; now: string }) {
  return (
    <SettingsCard
      id="notifications"
      title="Notifications"
      line="Where OpenADLC tells you something needs you."
      action={
        <Link href="/settings/notifications" className="text-[12.5px] text-link hover:underline">
          Set up notifications
        </Link>
      }
    >
      <p className={cn('text-[12.5px]', view?.last && !view.last.ok ? 'text-alarm' : 'text-muted')}>{notificationsLine(view, now)}</p>
    </SettingsCard>
  );
}

export function NotificationSettings({ initial }: { initial: NotificationSettingsView }) {
  const [view, setView] = useState(initial);
  const [kind, setKind] = useState<NotifyTransportKind>(initial.kind ?? 'ntfy');
  const [server, setServer] = useState(initial.kind === 'ntfy' ? (initial.server ?? '') : '');
  const [target, setTarget] = useState('');
  const [switches, setSwitches] = useState(initial.switches);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);

  // The saved target is shown masked as the field's placeholder, only while
  // the kind is the one it was saved for: it is kept only then.
  const savedHere = view.source === 'settings' && view.kind === kind;

  async function save() {
    setBusy('save');
    setSaid(null);
    const update: NotificationSettingsUpdate = { kind, switches };
    if (kind === 'ntfy' && server.trim()) update.server = server.trim();
    if (target.trim()) update.target = target.trim();
    const answer = await saveNotifications(update);
    setBusy(null);
    if (!answer.ok || !answer.view) {
      setSaid({ text: answer.error ?? 'The notification settings were not saved', failed: true });
      return;
    }
    setView(answer.view);
    setTarget('');
    setSaid({ text: 'Saved. Send a test to make sure it reaches you.', failed: false });
  }

  async function test() {
    setBusy('test');
    setSaid(null);
    const answer = await testNotifications();
    setBusy(null);
    if (!answer.ok || !answer.result) {
      setSaid({ text: answer.error ?? 'The test was not sent', failed: true });
      return;
    }
    setSaid({ text: testOutcome(answer.result), failed: !answer.result.ok });
  }

  return (
    <SettingsCard id="notifications" title="Notifications" line="Where OpenADLC tells you something needs you, and about what.">
      {view.source === 'env' && (
        <p className="text-[12.5px] text-muted">Using OPENADLC_NOTIFY_WEBHOOK. Saving here takes precedence.</p>
      )}

      <div role="radiogroup" aria-label="Where to notify you" className="flex flex-wrap gap-2 py-2">
        {KINDS.map((one) => (
          <label
            key={one.kind}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px]',
              kind === one.kind ? 'border-link text-body' : 'border-edge-strong text-soft',
            )}
          >
            <input type="radio" name="notify-kind" value={one.kind} checked={kind === one.kind} onChange={() => setKind(one.kind)} />
            {one.label}
          </label>
        ))}
      </div>

      {kind === 'ntfy' && (
        <label className="flex flex-col gap-1 border-t border-well py-2.5">
          <span className="text-[13px] font-semibold text-body">Server</span>
          <input aria-label="Server" value={server} placeholder="https://ntfy.sh" onChange={(event) => setServer(event.target.value)} className={INPUT} />
        </label>
      )}

      <label className="flex flex-col gap-1 border-t border-well py-2.5">
        <span className="text-[13px] font-semibold text-body">{TARGET_LABEL[kind]}</span>
        <input
          aria-label={TARGET_LABEL[kind]}
          value={target}
          autoComplete="off"
          placeholder={savedHere && view.target ? `${view.target} (saved; type to replace)` : ''}
          onChange={(event) => setTarget(event.target.value)}
          className={INPUT}
        />
        <span className="text-[12px] text-muted">{TARGET_HINT[kind]}</span>
      </label>

      <fieldset className="flex flex-col gap-1.5 border-t border-well py-2.5">
        <legend className="pb-1 text-[13px] font-semibold text-body">Notify me when</legend>
        {NOTIFY_SWITCHES.map((name) => (
          <label key={name} className="flex items-center gap-2 text-[13px] text-body">
            <input type="checkbox" checked={switches[name]} onChange={(event) => setSwitches({ ...switches, [name]: event.target.checked })} />
            {SWITCH_LABEL[name]}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 border-t border-well pt-3">
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" disabled={busy !== null || view.source === 'none'} onClick={() => void test()}>
          Send a test
        </Button>
        {said && (
          <span role="status" className={cn('text-[12.5px]', said.failed ? 'text-alarm' : 'text-muted')}>
            {said.text}
          </span>
        )}
      </div>
    </SettingsCard>
  );
}
