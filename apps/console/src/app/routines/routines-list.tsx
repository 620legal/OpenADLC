'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cadenceWords, RoutineForm } from '@/components/routine-form';
import { Button } from '@/components/ui/button';
import type { RoutinesView, RoutineView } from '@/lib/api';

/** A time in the reader's own zone; the server draws it in its own first. */
export function localTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function outcomeWords(routine: RoutineView): string | null {
  if (!routine.lastOutcome) return null;
  return routine.lastOutcome === 'filed' ? 'filed' : routine.lastOutcome === 'skipped' ? 'skipped' : 'failed';
}

/**
 * The Routines page's list (#369): each routine's repository, cadence, next
 * run, last run linking to the request it filed, and why it last skipped,
 * with pause, resume, edit and delete for a viewer who may change them.
 */
export function RoutinesList({ view, repos }: { view: RoutinesView; repos: readonly string[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const act = (routine: RoutineView, action: 'pause' | 'resume' | 'delete') => {
    if (action === 'delete' && !window.confirm(`Delete the routine “${routine.text}”? The requests it already filed stay.`)) return;
    setError(null);
    startTransition(async () => {
      const response = await fetch(action === 'delete' ? `/api/routines/${encodeURIComponent(routine.id)}` : `/api/routines/${encodeURIComponent(routine.id)}/${action}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
      }).catch(() => null);
      if (!response?.ok) {
        const body = response ? ((await response.json().catch(() => ({}))) as { error?: string }) : {};
        setError(body.error ?? 'The console could not reach the bridge. Try again.');
        return;
      }
      router.refresh();
    });
  };
  const saved = () => {
    setEditing(null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {view.mayEdit ? (
        editing === 'new' ? (
          <RoutineForm repos={repos} templates={view.templates} onSaved={saved} onCancel={() => setEditing(null)} />
        ) : (
          <div>
            <Button size="sm" variant="primary" data-routine-new onClick={() => setEditing('new')} disabled={repos.length === 0}>
              New routine
            </Button>
          </div>
        )
      ) : (
        view.why && (
          <p data-routines-readonly className="text-[12px] text-muted">
            {view.why}{' '}
            {view.url && (
              <a href={view.url} className="text-link hover:underline">
                Open settings
              </a>
            )}
          </p>
        )
      )}
      {error && (
        <p role="alert" className="text-[12px] text-alarm">
          {error}
        </p>
      )}

      {view.routines.length === 0 ? (
        <p className="text-[12.5px] text-muted">No routines yet.{view.mayEdit ? ' Create one from a template, or from Blank.' : ''}</p>
      ) : (
        <ul data-routines className="flex flex-col gap-2">
          {view.routines.map((routine) =>
            editing === routine.id ? (
              <li key={routine.id}>
                <RoutineForm repos={repos} templates={view.templates} routine={routine} onSaved={saved} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={routine.id} data-routine={routine.id} className="flex flex-col gap-1 rounded-md border border-edge px-3 py-2 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-body">{routine.text}</span>
                  <span className="text-dim">{routine.repoFullName}</span>
                  {routine.paused && <span className="rounded bg-well px-1.5 text-[11px] text-soft">paused</span>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-soft">
                  <span data-cadence>
                    {cadenceWords(routine.cadence, routine.time)} ({routine.timeZone})
                  </span>
                  <span data-next-run>
                    Next run: <span suppressHydrationWarning>{routine.nextRunAt ? localTime(routine.nextRunAt) : '—'}</span>
                  </span>
                  <span data-last-run>
                    Last run:{' '}
                    {routine.lastRunAt ? (
                      <>
                        <span suppressHydrationWarning>{localTime(routine.lastRunAt)}</span> {outcomeWords(routine)}
                        {routine.lastRequestId && (
                          <>
                            {' · '}
                            <a href={`/?item=${encodeURIComponent(`request:${routine.lastRequestId.slice(0, 8)}`)}`} className="text-link hover:underline">
                              request:{routine.lastRequestId.slice(0, 8)}
                            </a>
                          </>
                        )}
                      </>
                    ) : (
                      'never'
                    )}
                  </span>
                  <span className="text-dim">files as @{routine.owner.login}</span>
                </div>
                {routine.lastSkipReason && (
                  <p data-skip-reason className="text-[12px] text-attention">
                    {routine.lastSkipReason}
                  </p>
                )}
                {view.mayEdit && (
                  <div data-routine-actions className="flex flex-wrap gap-1.5 pt-1">
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(routine.id)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(routine, routine.paused ? 'resume' : 'pause')}>
                      {routine.paused ? 'Resume' : 'Pause'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(routine, 'delete')}>
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
