'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useInstallSettings, type InstallSettings } from '@/components/install-settings';

/** What the row says the bridge is doing now. */
export function keepAwakeState(keepAwake: NonNullable<InstallSettings['keepAwake']>): string {
  if (!keepAwake.on) return 'Off';
  return keepAwake.holding ? 'Holding the Mac awake now' : 'Not holding: nothing in flight';
}

/**
 * Keeping this Mac awake, as one row of Settings → System beside OpenADLC's
 * own updates.
 *
 * The bridge holds a `caffeinate -i` on its own host while the crew has work
 * in flight and lets go a minute after (the bridge's `keep-awake.ts`). The
 * row is drawn only where the bridge says its host can be held awake: on
 * Linux, or a Mac without `caffeinate`, there is nothing to switch. The
 * sleep card's Open Settings lands here (`#keep-awake`, the System section).
 */
export function KeepAwake({ install }: { install: InstallSettings | null }) {
  const { settings, save } = useInstallSettings(install);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keepAwake = settings?.keepAwake;
  if (!keepAwake?.available) return null;

  async function toggle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await save('keepAwake', keepAwake!.on ? 'off' : 'on');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li id="keep-awake" className="space-y-1.5 px-3.5 py-2.5 text-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-soft">Keep awake</span>
        <span className="text-[11.5px] text-body">{keepAwakeState(keepAwake)}</span>
        <span className="ml-auto">
          <Button variant="secondary" size="sm" aria-label={keepAwake.on ? 'Turn keep-awake off' : 'Turn keep-awake on'} disabled={busy} onClick={() => void toggle()}>
            {keepAwake.on ? 'Turn off' : 'Turn on'}
          </Button>
        </span>
      </div>
      <p className="text-muted">Keeps this Mac from sleeping while the crew has work in flight, and lets it sleep a minute after.</p>
      {error && (
        <p role="alert" className="text-alarm">
          {error}
        </p>
      )}
    </li>
  );
}
