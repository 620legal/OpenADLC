'use client';

import { useState, useTransition } from 'react';
import { pauseWork, resumeWork } from '@/app/actions';
import { RepoDot } from '@/components/repo-badge';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
import type { WorkPause, WorkPauses } from '@/lib/api';

/** Where the control is, for the board's banner and an unsigned post's steps. */
export const PAUSE_WORK = '/settings#pause';

/** "Paused by janedoe at 10:00 UTC: an account may be compromised." */
export function pauseLine(pause: WorkPause): string {
  const at = new Date(pause.at).toISOString().slice(0, 16).replace('T', ' ');
  return `Paused by ${pause.by} at ${at} UTC${pause.reason ? `: ${pause.reason}` : ''}.`;
}

/** "api", "api and web", "api, web and docs". */
export function namesLine(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

type Scope = 'all' | 'chosen';

/**
 * Settings' Pause work: stops anything new from starting, in
 * every repository or the ones chosen, until someone resumes: leases, a
 * request's triage (it waits in the queue), Try again. Work already running
 * finishes, and so does the merge line; questions can still be answered.
 * Pausing takes an optional reason, which the board's banner and the audit
 * trail repeat, and a second press to confirm. Each repository paused on its
 * own is listed with who paused it and its own Resume, under the install's
 * pause too; Resume all lets go of the ones listed, and no others. While the
 * install is paused with some repositories paused on their own as well,
 * Resume says which it does: lift the install's pause and keep theirs, or
 * resume everything.
 *
 * A bridge started without the dispatcher leases nothing, paused or not, and
 * this card said "Work runs" through a day of it. While the bridge says
 * it does not dispatch, the card says so instead, in both states: Pause and
 * Resume do not change it. A bridge that does not say is read as dispatching.
 */
export function PauseWorkCard({
  initial,
  repositories = [],
}: {
  initial: WorkPauses;
  /** The repositories OpenADLC works in, to choose from, each in its colour. */
  repositories?: readonly { name: string; color?: string | null }[];
}) {
  const [pauses, setPauses] = useState<WorkPauses>(initial);
  // The page reads the pauses again every 15 seconds; the card takes each new
  // read. It kept its first, and a repository paused since, by an incident
  // say, was not listed, so "Resume work" lifted it unseen.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setPauses(initial);
  }
  // From the page's read, not from a pause's answer: pausing and resuming
  // leave it as it was, and their answers do not carry it.
  const dispatching = initial.dispatching !== false;
  const dispatcherOff = !dispatching && (
    <p role="status" className="rounded-md border border-alarm/40 bg-alarm/5 px-2.5 py-2 text-alarm">
      Nothing new will start building: the dispatcher isn’t running, so no issue is leased to a builder. Pause and Resume do not change
      that; restart the bridge with FLEETADLC_DISPATCH_IN_BRIDGE=1. The card on the board says how.
    </p>
  );
  const [scope, setScope] = useState<Scope>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();

  const act = (work: () => Promise<{ ok: boolean; error?: string; pauses?: WorkPauses }>) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      setAsking(false);
      if (!result.ok) setError(result.error ?? 'that did not go through');
      else {
        setPauses(result.pauses ?? { paused: null, repos: {} });
        setChosen([]);
      }
    });
  };

  const colorOf = (name: string) => repositories.find((repo) => repo.name === name)?.color ?? null;
  const pausedNames = Object.keys(pauses.repos).sort();
  const choosable = repositories.filter((repo) => !pauses.repos[repo.name]);
  const naming = scope === 'chosen' ? chosen : undefined;

  // Each repository paused on its own, with who paused it and its own Resume:
  // shown under the install's pause too, which does not replace them.
  const pausedList = pausedNames.length > 0 && (
    <ul aria-label="Paused repositories" className="flex flex-col gap-1.5">
      {pausedNames.map((name) => (
        <li
          key={name}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-attention/40 bg-attention/10 px-2.5 py-2"
        >
          <RepoDot color={colorOf(name)} />
          <span className="font-medium text-body">{name}</span>
          <span className="min-w-0 flex-1 text-attention">{pauseLine(pauses.repos[name]!)}</span>
          <Button size="sm" variant="ghost" disabled={pending} aria-label={`Resume ${name}`} onClick={() => act(() => resumeWork([name]))}>
            Resume
          </Button>
        </li>
      ))}
    </ul>
  );

  return (
    <SettingsCard id="pause" title="Pause work" line="Stop the crew from starting anything new, in every repository or the ones you choose, until you resume.">
      {pauses.paused ? (
        <div className="flex flex-col gap-2 text-[12.5px]">
          {dispatcherOff}
          <p className="rounded-md border border-attention/40 bg-attention/10 px-2.5 py-2 text-attention">{pauseLine(pauses.paused)}</p>
          <p className="text-muted">
            Nothing new starts: no leases, no triage (requests wait in the queue), no Try again. Work already running finishes, and
            questions can still be answered. Merges still land. To stop one, put the{' '}
            <code className="font-mono text-[11.5px]">needs-human</code> label on the pull request: the merge line does not land a
            held pull request. Hold this PR on an unsigned post’s card does that and also turns GitHub’s auto-merge off; otherwise,
            if auto-merge is on for it, turn that off on GitHub too.
          </p>
          {pausedList && (
            <>
              <p className="text-soft">Paused on their own as well, which lifting the install’s pause leaves paused:</p>
              {pausedList}
            </>
          )}
          {pausedNames.length === 0 ? (
            <div>
              {/* The install's pause alone: a repository paused since this
                  page last read the pauses is not let go with it. */}
              <Button size="sm" variant="primary" disabled={pending} onClick={() => act(() => resumeWork(undefined, { keepRepos: true }))}>
                {pending ? 'Resuming…' : 'Resume work'}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={pending} onClick={() => act(() => resumeWork(undefined, { keepRepos: true }))}>
                {`Resume work, keep ${namesLine(pausedNames)} paused`}
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => resumeWork())}>
                Resume everything
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[12.5px]">
          {dispatcherOff}
          {pausedNames.length > 0 && (
            <div className="flex flex-col gap-2">
              {pausedList}
              <p className="text-muted">
                Nothing new starts in {pausedNames.length > 1 ? 'these repositories' : 'it'}: no leases, no triage of{' '}
                {pausedNames.length > 1 ? 'their' : 'its'} requests (they wait in the
                queue while the rest go ahead), no Try again. Work already running finishes, and merges still land.
              </p>
              {pausedNames.length > 1 && (
                <div>
                  <Button size="sm" variant="primary" disabled={pending} onClick={() => act(() => resumeWork(pausedNames))}>
                    {pending ? 'Resuming…' : 'Resume all'}
                  </Button>
                </div>
              )}
            </div>
          )}
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setAsking(true);
            }}
          >
            {pausedNames.length === 0 && (
              <p className="text-muted">
                {dispatching ? 'Work runs. ' : ''}Pausing stops anything new from starting until someone resumes; it is audited and shown on the
                board.
              </p>
            )}
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-soft">Which repositories</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {(
                  [
                    ['all', 'All repositories'],
                    ['chosen', 'Chosen repositories'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex cursor-pointer items-center gap-1.5 text-body">
                    <input
                      type="radio"
                      name="pause-scope"
                      value={value}
                      checked={scope === value}
                      onChange={() => {
                        setScope(value);
                        setAsking(false);
                      }}
                      className="size-4 accent-link"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {scope === 'chosen' &&
                (choosable.length === 0 ? (
                  <p className="text-muted">Every repository is paused already.</p>
                ) : (
                  <div role="group" aria-label="Repositories to pause" className="flex flex-col gap-1 pl-0.5">
                    {choosable.map((repo) => (
                      <label key={repo.name} className="flex cursor-pointer items-center gap-2 text-body">
                        <input
                          type="checkbox"
                          value={repo.name}
                          checked={chosen.includes(repo.name)}
                          onChange={(event) => {
                            const on = event.target.checked;
                            setChosen((was) => (on ? [...was, repo.name] : was.filter((one) => one !== repo.name)));
                            setAsking(false);
                          }}
                          className="size-4 shrink-0 accent-link"
                        />
                        <RepoDot color={repo.color} />
                        {repo.name}
                      </label>
                    ))}
                  </div>
                ))}
            </fieldset>
            <label className="flex flex-col gap-1">
              <span className="text-soft">Why (optional)</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="an account may be compromised"
                className="h-9 rounded-md border border-edge-strong bg-panel px-2.5 text-[13px] text-body"
              />
            </label>
            {asking ? (
              <div role="group" aria-label="Confirm" className="flex flex-col gap-2 rounded-md border border-alarm/40 bg-alarm/5 px-2.5 py-2">
                <p className="font-medium text-body">
                  {naming ? `Pause new work in ${namesLine(naming)}?` : 'Pause all new work across every repository?'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => act(() => pauseWork(reason, naming))}>
                    {pending ? 'Pausing…' : 'Confirm'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setAsking(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button type="submit" size="sm" variant="danger" disabled={pending || (scope === 'chosen' && chosen.length === 0)}>
                  Pause work
                </Button>
              </div>
            )}
          </form>
        </div>
      )}
      {error && <p className="mt-1 text-[12px] text-alarm">{error}</p>}
    </SettingsCard>
  );
}
