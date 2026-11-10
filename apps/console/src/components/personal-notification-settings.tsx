'use client';

import { useState } from 'react';
import { savePersonalNotifications, testPersonalNotifications } from '@/app/actions';
import { testOutcome } from '@/components/notification-settings';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
// Types only: '@/lib/api' reads the server's environment on import.
import type { NotifyTransportKind, PersonalNotificationUpdate, PersonalNotificationView } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Your channel: where OpenADLC tells you, and only you, about the Needs-you
 * items routed to you (ADR 0035): a question for a role you hold, a pull
 * request waiting on your approval. Items for everyone still go to the
 * install's channel. With none set, the bridge sends you nothing, and you have
 * the console's badge, its desktop alerts, and GitHub's own mention.
 *
 * The target is a credential, as the install's is: shown back masked, and
 * sent only when something is typed in the field.
 */

const KINDS: { kind: NotifyTransportKind; label: string }[] = [
  { kind: 'ntfy', label: 'ntfy' },
  { kind: 'slack', label: 'Slack' },
  { kind: 'webhook', label: 'Webhook' },
];

const TARGET_LABEL: Record<NotifyTransportKind, string> = { ntfy: 'Topic', slack: 'Incoming-webhook URL', webhook: 'URL' };

const INPUT =
  'w-full rounded-md border border-edge-strong bg-surface px-2.5 py-1.5 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link';

export function PersonalNotificationSettings({ initial }: { initial: PersonalNotificationView }) {
  const [view, setView] = useState(initial);
  const [kind, setKind] = useState<NotifyTransportKind>(initial.kind ?? 'ntfy');
  const [server, setServer] = useState(initial.kind === 'ntfy' ? (initial.server ?? '') : '');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState<'save' | 'stop' | 'test' | null>(null);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  const savedHere = view.kind === kind;

  async function save(update: PersonalNotificationUpdate, doing: 'save' | 'stop') {
    setBusy(doing);
    setSaid(null);
    const answer = await savePersonalNotifications(update);
    setBusy(null);
    if (!answer.ok || !answer.view) {
      setSaid({ text: answer.error ?? 'Your channel was not saved', failed: true });
      return;
    }
    setView(answer.view);
    setTarget('');
    setSaid({ text: doing === 'stop' ? 'Stopped. OpenADLC sends you nothing of your own now.' : 'Saved. Send a test to make sure it reaches you.', failed: false });
  }

  function saveChannel() {
    const update: PersonalNotificationUpdate = { kind };
    if (kind === 'ntfy') update.server = server.trim() || 'https://ntfy.sh';
    if (target.trim()) update.target = target.trim();
    void save(update, 'save');
  }

  async function test() {
    setBusy('test');
    setSaid(null);
    const answer = await testPersonalNotifications();
    setBusy(null);
    if (!answer.ok || !answer.result) {
      setSaid({ text: answer.error ?? 'The test was not sent', failed: true });
      return;
    }
    setSaid({ text: testOutcome(answer.result), failed: !answer.result.ok });
  }

  return (
    <SettingsCard id="your-channel" title="Your channel" line="Where OpenADLC tells you, and only you, about what is routed to you.">
      <p className="text-[12.5px] text-muted">
        Questions for a role you hold, and pull requests waiting on your approval, come here instead of the install’s channel. With none set, OpenADLC sends you
        nothing of your own: you still have the badge, desktop alerts and GitHub’s mention.
      </p>

      <div role="radiogroup" aria-label="Where to notify you" className="flex flex-wrap gap-2 py-2">
        {KINDS.map((one) => (
          <label
            key={one.kind}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px]',
              kind === one.kind ? 'border-link text-body' : 'border-edge-strong text-soft',
            )}
          >
            <input type="radio" name="personal-notify-kind" value={one.kind} checked={kind === one.kind} onChange={() => setKind(one.kind)} />
            {one.label}
          </label>
        ))}
      </div>

      {kind === 'ntfy' && (
        <label className="flex flex-col gap-1 border-t border-well py-2.5">
          <span className="text-[13px] font-semibold text-body">Server</span>
          <input aria-label="Your server" value={server} placeholder="https://ntfy.sh" onChange={(event) => setServer(event.target.value)} className={INPUT} />
        </label>
      )}

      <label className="flex flex-col gap-1 border-t border-well py-2.5">
        <span className="text-[13px] font-semibold text-body">{TARGET_LABEL[kind]}</span>
        <input
          aria-label={`Your ${TARGET_LABEL[kind]}`}
          value={target}
          autoComplete="off"
          placeholder={savedHere && view.target ? `${view.target} (saved; type to replace)` : ''}
          onChange={(event) => setTarget(event.target.value)}
          className={INPUT}
        />
      </label>

      <div className="flex flex-wrap items-center gap-2 border-t border-well pt-3">
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={saveChannel}>
          Save
        </Button>
        <Button size="sm" disabled={busy !== null || view.kind === null} onClick={() => void test()}>
          Send a test
        </Button>
        {view.kind !== null && (
          <Button size="sm" disabled={busy !== null} onClick={() => void save({ kind: null }, 'stop')}>
            Stop
          </Button>
        )}
        {said && (
          <span role="status" className={cn('text-[12.5px]', said.failed ? 'text-alarm' : 'text-muted')}>
            {said.text}
          </span>
        )}
      </div>
    </SettingsCard>
  );
}
