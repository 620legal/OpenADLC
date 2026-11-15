'use client';

import { useEffect, useState } from 'react';
import { DeviceCode } from '@/components/device-code';
import type { ReleaseRunState, ReleaseRunView } from '@/lib/api';

/**
 * Cut release (#345, docs/adr/0072): the button under a pinned compare view,
 * and the repository's runs below it.
 *
 * The press sends the view's id and Clean build, never a commit: the bridge
 * builds the head the view showed, whatever the branch did since. It answers
 * with a device code to approve as the person's own GitHub account; the
 * sign-in is read every 2 s, and once the run starts it is followed every 5 s
 * until it ends.
 */

interface Flow {
  flowId: string;
  userCode: string;
  verificationUri: string;
}

/** The states a release is in flight in (`RELEASE_IN_FLIGHT` in the bridge's store), which the page follows. */
export const IN_FLIGHT: readonly ReleaseRunState[] = ['running', 'built', 'publishing'];

/** How often the sign-in and the run are read. */
export const FLOW_READ_MS = 2_000;
export const RUN_READ_MS = 5_000;

/** Each state in words. */
export const RUN_STATE: Record<ReleaseRunState, string> = {
  running: 'Building',
  built: 'Built, waiting to publish',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  refused: 'Refused',
  cancelled: 'Cancelled',
  lost: 'Lost when hostd restarted',
  publish_failed: 'Publish failed',
};

/**
 * A state in words, for a server page: a value exported from this client
 * module reaches a server component as a reference, not as the object, so the
 * words cross as a component.
 */
export function RunStateWord({ state }: { state: ReleaseRunState }) {
  return <>{RUN_STATE[state]}</>;
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `the console answered ${response.status}`;
}

export function CutRelease({
  repo,
  viewId,
  mayCut,
  why,
  url,
  runs: initialRuns,
}: {
  repo: string;
  viewId: string;
  mayCut: boolean;
  why?: string | null;
  url?: string | null;
  runs: ReleaseRunView[];
}) {
  const [clean, setClean] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [runs, setRuns] = useState<ReleaseRunView[]>(initialRuns);
  /** The run this page started, which it follows. */
  const [started, setStarted] = useState<string | null>(null);
  const [spent, setSpent] = useState(false);
  const base = `/api/releases/${encodeURIComponent(repo)}`;

  const following = started !== null || runs.some((run) => IN_FLIGHT.includes(run.state));
  const startedRun = started ? runs.find((run) => run.id === started) : undefined;
  const ended = started !== null && startedRun !== undefined && !IN_FLIGHT.includes(startedRun.state);

  useEffect(() => {
    if (!flow) return;
    const timer = setInterval(() => {
      void fetch(`${base}/flows/${encodeURIComponent(flow.flowId)}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((said: { state: string; id?: string; error?: string }) => {
          if (said.state === 'waiting') return;
          setFlow(null);
          if (said.state === 'done' && said.id) {
            setStarted(said.id);
            setSpent(true);
          } else {
            setError(said.error ?? 'The sign-in ended before a release was started. Press Cut release to try again.');
          }
        })
        .catch(() => undefined);
    }, FLOW_READ_MS);
    return () => clearInterval(timer);
  }, [flow, base]);

  useEffect(() => {
    if (!following || ended) return;
    const read = () =>
      void fetch(`${base}/runs`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { runs?: ReleaseRunView[] } | null) => {
          if (body?.runs) setRuns(body.runs);
        })
        .catch(() => undefined);
    read();
    const timer = setInterval(read, RUN_READ_MS);
    return () => clearInterval(timer);
  }, [following, ended, base]);

  const cut = () => {
    setPending(true);
    setError(null);
    // The view's id, never its SHA: the bridge builds the head it pinned.
    void fetch(`${base}/cut`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewId, clean }) })
      .then(async (response) => {
        if (!response.ok) {
          const said = await errorOf(response);
          if (response.status === 409 && /expired/.test(said)) setSpent(true);
          return setError(said);
        }
        setFlow(((await response.json()) as { flow: Flow }).flow);
      })
      .catch(() => setError('The console is not answering.'))
      .finally(() => setPending(false));
  };

  return (
    <div data-cut-release className="flex flex-col gap-4">
      {mayCut ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-cut
              onClick={cut}
              disabled={pending || flow !== null || spent}
              className="h-8 rounded-md border border-edge-strong bg-panel px-3 text-[12.5px] font-medium text-body hover:border-dim disabled:opacity-60"
            >
              Cut release
            </button>
            <label className="flex items-center gap-1.5 text-[12.5px] text-soft">
              <input type="checkbox" data-clean checked={clean} onChange={(event) => setClean(event.target.checked)} disabled={flow !== null || spent} />
              Clean build
            </label>
          </div>
          {spent && !flow && (
            <p className="text-[12px] text-muted">
              This view is used. <a href={`/releases/${encodeURIComponent(repo)}`} className="text-link hover:underline">Reload</a> to see the default branch’s head again.
            </p>
          )}
        </div>
      ) : (
        <p data-why className="text-[12.5px] text-soft">
          {why ?? 'This view cannot be cut.'}
          {url && (
            <>
              {' '}
              <a href={url} className="text-link hover:underline">
                Go there
              </a>
            </>
          )}
        </p>
      )}
      {flow && (
        <div data-flow className="flex flex-col gap-1.5">
          <p className="text-[12px] text-soft">Approve this code on GitHub as your own account to cut the release. OpenADLC uses the sign-in only to ask who approved it, then revokes it.</p>
          <DeviceCode code={flow.userCode} url={flow.verificationUri} />
        </div>
      )}
      {error && (
        <p role="status" data-error className="text-[12px] text-alarm">
          {error}
        </p>
      )}
      <ReleaseRuns runs={runs} highlight={started} />
    </div>
  );
}

/** A repository's runs, newest first: each one's state, its reason and log, and a published one's release. */
export function ReleaseRuns({ runs, highlight = null }: { runs: ReleaseRunView[]; highlight?: string | null }) {
  if (runs.length === 0) return <p className="text-[12.5px] text-muted">No release has been cut here yet.</p>;
  return (
    <ul data-runs className="flex flex-col gap-2">
      {runs.map((run) => (
        <li
          key={run.id}
          id={`run-${run.id}`}
          data-run={run.state}
          className={`flex flex-col gap-1 rounded-md border px-3 py-2 text-[12.5px] ${run.id === highlight ? 'border-attention/60' : 'border-edge'}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-body">{RUN_STATE[run.state]}</span>
            <span className="font-mono text-muted">{run.sha.slice(0, 7)}</span>
            {run.version && <span className="text-soft">{run.version}</span>}
            {run.previousVersion && <span className="text-dim">after {run.previousVersion}</span>}
            {run.clean && <span className="text-dim">clean build</span>}
            <span className="text-dim">by @{run.requestedBy}</span>
            {run.state === 'published' && run.releaseUrl && (
              <a data-release-link href={run.releaseUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
                {run.tag ?? 'The release'} on GitHub
              </a>
            )}
          </div>
          {run.reason && <p data-reason className="text-soft">{run.reason}</p>}
          {run.logTail && !IN_FLIGHT.includes(run.state) && run.state !== 'published' && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-edge bg-surface px-2 py-1 font-mono text-[11px] leading-snug text-muted">
              {run.logTail}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}
