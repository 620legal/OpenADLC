'use client';

import { useState, useTransition } from 'react';
import { setCiCap } from '@/app/actions';
import { useRole } from '@/components/app-header';
import type { CiMinutesView } from '@/lib/api';

/**
 * GitHub Actions minutes this month, beside the model's spend: what the crew's
 * work cost the repositories' own Actions bills, and a cap a person can set.
 *
 * The minutes are GitHub's own way of counting (each job rounded up, times its
 * runner's rate); the dollars are an estimate at the Linux list price, before
 * whatever a plan includes for free, and say so.
 */
export function CiMinutes({ ci }: { ci: CiMinutesView }) {
  const admin = useRole() === 'admin';
  // A cap of 0 is reached at once, as the bridge counts it: a full bar, not an empty one.
  const used = ci.cap === null ? 0 : ci.cap === 0 ? 100 : Math.min(100, (ci.billedMinutes / ci.cap) * 100);
  const most = Math.max(...ci.byRepo.map((row) => row.minutes), 1);

  return (
    <section data-ci-minutes className="mt-4 rounded-lg border border-edge bg-panel/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">GitHub Actions minutes</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {ci.billedMinutes.toLocaleString('en-US')}
            <span className="ml-1.5 text-sm font-normal text-muted">
              billed minutes{ci.cap !== null ? ` of ${ci.cap.toLocaleString('en-US')}` : ''} · about ${ci.estimatedUsd.toFixed(2)}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            {ci.runs.toLocaleString('en-US')} runs this month
            {ci.minutes > ci.billedMinutes ? ` · ${(ci.minutes - ci.billedMinutes).toLocaleString('en-US')} more minutes free, on public repositories` : ''}
          </p>
        </div>
        {admin && <CapField cap={ci.cap} />}
      </div>

      {ci.cap !== null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-well">
          <div className={used >= 100 ? 'h-full bg-alarm' : used >= 90 ? 'h-full bg-attention' : 'h-full bg-signal'} style={{ width: `${used}%` }} />
        </div>
      )}
      {ci.capReached && (
        <p role="status" className="mt-2 text-[12px] text-attention">
          {ci.capReached}
        </p>
      )}

      {ci.byRepo.length === 0 ? (
        <p className="mt-3 text-[11px] text-dim">no workflow runs counted this month</p>
      ) : (
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div className="space-y-1">
            {ci.byRepo.map((row) => (
              <div key={row.repo} className="flex items-center gap-2 text-[12px]">
                <span className="w-40 shrink-0 truncate text-soft">{row.repo}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-well">
                  <div className="h-full bg-link" style={{ width: `${(row.minutes / most) * 100}%` }} />
                </div>
                <span className="w-16 text-right tabular-nums text-body">{row.minutes.toLocaleString('en-US')} m</span>
                <span className="w-12 text-right text-[10.5px] text-dim">{row.runs} runs</span>
              </div>
            ))}
          </div>
          {ci.byPullRequest.length > 0 && (
            <ul className="space-y-1 text-[12px] text-soft">
              {ci.byPullRequest.slice(0, 5).map((row) => (
                <li key={`${row.repo}#${row.prNumber}`} className="flex justify-between gap-3">
                  <span className="truncate">
                    {row.repo} <span className="text-dim">#{row.prNumber}</span>
                  </span>
                  <span className="tabular-nums">
                    {row.minutes.toLocaleString('en-US')} m <span className="text-dim">· {row.runs} runs</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted">
        Each job rounded up to a minute, as GitHub bills them; a Windows minute counts as two and a macOS minute as ten. Dollars at
        GitHub’s Linux list price, before the minutes your plan includes. At the cap, the merge line asks for no more CI runs until the cap is raised or the month turns.
      </p>
    </section>
  );
}

function CapField({ cap }: { cap: number | null }) {
  const [value, setValue] = useState(cap === null ? '' : String(cap));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    const trimmed = value.trim();
    const minutes = trimmed === '' ? null : Number(trimmed);
    if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 0)) {
      setError('a whole number of minutes, or empty for no cap');
      return;
    }
    setError(null);
    start(async () => {
      const result = await setCiCap(minutes);
      if (!result.ok) setError(result.error ?? 'the cap was not saved');
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex items-center gap-2 text-[12px] text-muted">
        Monthly cap
        <input
          aria-label="Monthly cap on GitHub Actions minutes"
          inputMode="numeric"
          placeholder="no cap"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="w-24 rounded-md border border-edge bg-panel px-2 py-1 text-right tabular-nums text-body"
        />
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-body hover:bg-well disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </label>
      {error && (
        <span role="status" className="text-[11.5px] text-alarm">
          {error}
        </span>
      )}
    </div>
  );
}
