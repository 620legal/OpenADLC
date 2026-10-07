import Link from 'next/link';
import type { InsightSummary, InsightsView } from '@/lib/api';
import { cn } from '@/lib/cn';
import { stageOf } from '@/lib/stages';

/**
 * How fast work moves, and what holds it up: merged per day, time from a
 * request to its merge and in each stage, waiting on overlap with the files
 * behind it, conflicts resolved at merge, send-backs, and builds at once.
 *
 * It is here to show whether a change to the overlap rule helped. A Makefile
 * or a README every change touches made a repository build one thing at a
 * time, and the only evidence was a line in the bridge's log per wait.
 */
export function InsightsBody({ insights, repos, repo }: { insights: InsightsView; repos: readonly string[]; repo: string | null }) {
  const summary: InsightSummary = repo ? (insights.repos.find((one) => one.repo === repo) ?? insights.overall) : insights.overall;
  const period = insights.days === 7 ? 'the last 7 days' : 'the last 30 days';
  const stageRows: { key: keyof InsightSummary['stages']; label: string }[] = [
    { key: 'intake', label: 'Intake' },
    { key: 'design', label: 'Design' },
    { key: 'build', label: 'Build' },
    { key: 'review', label: 'Review' },
    { key: 'mergeLine', label: 'Merge line' },
  ];
  const longest = Math.max(1, ...stageRows.map((row) => summary.stages[row.key] ?? 0));
  const suggestions = insights.suggestions.filter((one) => !repo || one.repo === repo);
  const sendBacks = Object.entries(summary.sendBacks).sort((a, b) => b[1] - a[1]);
  const conflicts = summary.conflicts.resolvedLeadOnly + summary.conflicts.resolvedFull + summary.conflicts.sentBack;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2" data-insights-filters>
        <Filter label="Repository">
          <Choice href={hrefFor(null, insights.days)} on={!repo}>
            All
          </Choice>
          {repos.map((name) => (
            <Choice key={name} href={hrefFor(name, insights.days)} on={repo === name}>
              {name}
            </Choice>
          ))}
        </Filter>
        <Filter label="Period">
          <Choice href={hrefFor(repo, 7)} on={insights.days === 7}>
            7 days
          </Choice>
          <Choice href={hrefFor(repo, 30)} on={insights.days === 30}>
            30 days
          </Choice>
        </Filter>
      </div>

      <section aria-label="At a glance" className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Tile label="Merged" value={String(summary.merged)} note={`${summary.perDay} a day`} />
        <Tile label="Request to merge" value={duration(summary.cycleMs)} note="median" />
        <Tile label="Waiting on overlap" value={duration(summary.overlap.totalWaitMs || null)} note={`${summary.overlap.waits} ${summary.overlap.waits === 1 ? 'wait' : 'waits'}`} />
        <Tile label="Builds at once" value={String(summary.parallel.max)} note={`most; ${summary.parallel.average} on average while building`} />
      </section>

      {suggestions.length > 0 && (
        <ul aria-label="Suggestions" className="flex flex-col gap-1.5">
          {suggestions.map((one) => (
            <li key={`${one.repo}:${one.path}`} className="rounded-md border border-attention/40 bg-attention/10 px-3 py-2 text-[12.5px] text-body">
              {!repo && <span className="font-medium">{one.repo}: </span>}
              {one.text}
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Files work waited on" className="rounded-lg border border-edge bg-panel/40 p-4">
        <h2 className="text-[11px] uppercase tracking-wider text-muted">What work waited on</h2>
        {summary.overlap.hotFiles.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-dim">No waiting on overlap in {period}.</p>
        ) : (
          <>
            <ul className="mt-2 flex flex-col gap-1">
              {summary.overlap.hotFiles.map((file) => (
                <li key={file.path} className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-body">{file.path}</span>
                  <span className="shrink-0 text-soft">
                    blocked {file.waits} {file.waits === 1 ? 'build' : 'builds'}
                    {file.waitedMs > 0 ? `, ${duration(file.waitedMs)} waiting` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11.5px] text-dim">
              {summary.overlap.byKind.exclusive} {summary.overlap.byKind.exclusive === 1 ? 'wait' : 'waits'} on files only one change may
              touch at a time, {summary.overlap.byKind.building} on files being built
              {summary.overlap.medianWaitMs !== null ? `; a wait took ${duration(summary.overlap.medianWaitMs)} at the median` : ''}.
            </p>
          </>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Time in each stage" className="rounded-lg border border-edge bg-panel/40 p-4">
          <h2 className="text-[11px] uppercase tracking-wider text-muted">Time in each stage (median)</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {stageRows.map((row) => {
              const ms = summary.stages[row.key];
              return (
                <li key={row.key} className="flex items-center gap-2 text-[12.5px]">
                  <span className="w-24 shrink-0 text-soft">{row.label}</span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-well">
                    {ms !== null && <span className="block h-full rounded-full bg-link" style={{ width: `${Math.max(2, (ms / longest) * 100)}%` }} />}
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-soft">{duration(ms)}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Conflicts and send-backs" className="rounded-lg border border-edge bg-panel/40 p-4">
          <h2 className="text-[11px] uppercase tracking-wider text-muted">Conflicts and send-backs</h2>
          <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-y-1 text-[12.5px]">
            <dt className="text-soft">Conflicts at merge</dt>
            <dd className="text-right tabular-nums text-body">{conflicts}</dd>
            {conflicts > 0 && (
              <>
                <dt className="pl-3 text-dim">resolved, the lead re-checked</dt>
                <dd className="text-right tabular-nums text-soft">{summary.conflicts.resolvedLeadOnly}</dd>
                <dt className="pl-3 text-dim">resolved, reviewed again in full</dt>
                <dd className="text-right tabular-nums text-soft">{summary.conflicts.resolvedFull}</dd>
                <dt className="pl-3 text-dim">sent back to build</dt>
                <dd className="text-right tabular-nums text-soft">{summary.conflicts.sentBack}</dd>
              </>
            )}
            <dt className="text-soft">Send-backs</dt>
            <dd className="text-right tabular-nums text-body">{sendBacks.reduce((total, [, count]) => total + count, 0)}</dd>
            {sendBacks.map(([stage, count]) => (
              <span key={stage} className="contents">
                <dt className="pl-3 text-dim">{sentBackFrom(stage)}</dt>
                <dd className="text-right tabular-nums text-soft">{count}</dd>
              </span>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}

/**
 * Where a send-back came from, by the board's name for the stage: a key read
 * as "from merged" where the board says Ship, and a move with no stage
 * recorded as "from unknown".
 */
export function sentBackFrom(stage: string): string {
  if (stage === 'unknown') return 'from a stage not recorded';
  return `from ${(stageOf(stage)?.title ?? stage).toLowerCase()}`;
}

function hrefFor(repo: string | null, days: number): string {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (days !== 7) params.set('days', String(days));
  const query = params.toString();
  return query ? `/insights?${query}` : '/insights';
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1 rounded-md border border-edge bg-panel p-0.5">
      {children}
    </div>
  );
}

function Choice({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? 'true' : undefined}
      className={cn('rounded px-2 py-0.5 text-[12px]', on ? 'bg-body font-medium text-panel' : 'text-soft hover:text-body')}
    >
      {children}
    </Link>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-edge bg-panel/40 px-3.5 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-body">{value}</p>
      <p className="mt-0.5 text-[11.5px] text-dim">{note}</p>
    </div>
  );
}

/** A length of time as a person reads it: "45s", "12m", "2h 10m", "3d 4h", or "—" for none. */
export function duration(ms: number | null): string {
  if (ms === null || ms <= 0) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
