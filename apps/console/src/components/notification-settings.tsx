'use client';

import { useState } from 'react';
import { saveNotifications } from '@/app/actions';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
// Types only: lib/api reads next/headers, which a client component cannot
// import, and next build fails on any value taken from it here.
import type { NotificationSettingsView, NotificationTestResult, NotifySwitch } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Settings → Notifications' switches: which kinds OpenADLC pushes, to every
 * device that turned notifications on. Where they go is each person's devices,
 * above these on the page; ntfy, Slack and the webhook are retired (ADR 0049).
 */

/** What each switch sends, in a person's words. */
export const SWITCH_LABEL: Record<NotifySwitch, string> = {
  gate_opened: 'A bot asks you a question',
  merge_waiting: 'A pull request waits for you to merge or approve it',
  review_stalled: 'A review stopped',
  cap_warning: 'Spending reaches its monthly warning',
  promote_waiting: 'A deploy to production waits for approval',
  check_failing: 'Something only you can do stops work, and when it is fixed',
};

/** "Delivered (201)", or "Not delivered: 410 Gone". */
export function testOutcome(result: NotificationTestResult): string {
  if (result.ok) return `Delivered${result.status === null ? '' : ` (${result.status})`}`;
  return `Not delivered: ${[result.status, result.error].filter((part) => part !== null && part !== '').join(' ')}`.trim();
}

export function NotificationSettings({ initial }: { initial: NotificationSettingsView }) {
  const [switches, setSwitches] = useState(initial.switches);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);

  async function save() {
    setBusy(true);
    setSaid(null);
    const answer = await saveNotifications({ switches });
    setBusy(false);
    if (!answer.ok || !answer.view) {
      setSaid({ text: answer.error ?? 'The notification settings were not saved', failed: true });
      return;
    }
    setSwitches(answer.view.switches);
    setSaid({ text: 'Saved.', failed: false });
  }

  return (
    <SettingsCard id="notifications" title="What to notify about" line="Which kinds OpenADLC pushes, to every device.">
      <fieldset className="flex flex-col gap-1.5 py-2.5">
        <legend className="pb-1 text-[13px] font-semibold text-body">Notify when</legend>
        {(Object.keys(SWITCH_LABEL) as NotifySwitch[]).map((name) => (
          <label key={name} className="flex items-center gap-2 text-[13px] text-body">
            <input type="checkbox" checked={switches[name]} onChange={(event) => setSwitches({ ...switches, [name]: event.target.checked })} />
            {SWITCH_LABEL[name]}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 border-t border-well pt-3">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
          Save
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
