'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { dismissBridgeGap } from '@/app/actions';
import { sinceWords } from '@/components/bridge-offline-banner';
import type { BridgeGapReport as Report, BridgeGapTask } from '@/lib/api';
import { timeOf } from '@/lib/thread';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** "about 1 minute", "about 2 hours 5 minutes", "about 3 days": how long the bridge was away. */
export function awayWords(ms: number): string {
  if (ms < MINUTE) return 'under a minute';
  if (ms < HOUR) return `about ${plural(Math.round(ms / MINUTE), 'minute')}`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);
    return minutes > 0 && minutes < 60 ? `about ${plural(hours, 'hour')} ${plural(minutes, 'minute')}` : `about ${plural(Math.round(ms / HOUR), 'hour')}`;
  }
  return `about ${plural(Math.round(ms / DAY), 'day')}`;
}

function TaskList({ title, tasks }: { title: string; tasks: BridgeGapTask[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="mt-1">
      <p className="text-[12.5px] text-soft">{title}</p>
      <ul className="ml-4 list-disc text-[12.5px] text-soft">
        {tasks.map((task) => (
          <li key={`${task.taskId}:${task.outcome}`}>
            <Link href={`/?item=${encodeURIComponent(task.subject)}`} className="text-link underline decoration-link/40 underline-offset-2">
              {task.subject}
            </Link>{' '}
            — {task.why}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the bridge's latest outage cost: how long it was away, and the tasks
 * the start after it resumed or ended as orphaned, each linking to its card.
 * Kept by the bridge for everyone until a person dismisses it (`bridge-gap.ts`
 * in the bridge); a gap merged in since this was read is refused, and the
 * page is read again to show it.
 */
export function BridgeGapReport({ gap, timeZone }: { gap: Report | null; timeZone?: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!gap) return null;
  const resumed = gap.tasks.filter((task) => task.outcome === 'resumed');
  const orphaned = gap.tasks.filter((task) => task.outcome === 'orphaned');
  const from = sinceWords(Date.parse(gap.lastUpAt), Date.parse(gap.backAt), timeZone);
  const to = timeOf(gap.backAt, timeZone);

  const dismiss = () => {
    setError(null);
    startTransition(async () => {
      const result = await dismissBridgeGap(gap.backAt);
      if (!result.ok) setError(result.error ?? 'that did not go through');
    });
  };

  return (
    <div role="status" className="shrink-0 border-b border-attention/30 bg-attention/5 px-4 py-2 md:px-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12.5px] text-soft">
            <span className="font-medium text-attention">OpenADLC was away for {awayWords(gap.awayMs)}</span>{' '}
            {/* The reader's clock: the server draws it in its own zone first. */}
            <span suppressHydrationWarning>
              ({from}–{to})
            </span>
            .{gap.tasks.length === 0 ? ' Nothing was resumed or treated as orphaned when it came back.' : ''}
          </p>
          <TaskList title="It resumed:" tasks={resumed} />
          <TaskList title="It treated as orphaned:" tasks={orphaned} />
          {error && <p className="mt-1 text-[12.5px] text-alarm">{error}</p>}
        </div>
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          className="shrink-0 rounded px-2 py-0.5 text-[12.5px] text-link underline decoration-link/40 underline-offset-2 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
