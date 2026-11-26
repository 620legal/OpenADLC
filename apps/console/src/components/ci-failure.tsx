'use client';

import { useEffect, useState } from 'react';
import type { CiFailure } from '@/lib/api';

/**
 * Why an item's pull request is red, on its item page (#372): each failing
 * job of its head's newest `ci` run, the step it failed at, and the first
 * lines of the error, redacted by the bridge. Finding that out meant opening
 * GitHub Actions. It renders nothing unless `ci` is red, and only reads.
 */

export function ciFailurePath(subject: string): string {
  return `/api/item/${encodeURIComponent(subject)}/ci-failure`;
}

const MISSING: Record<string, string> = {
  expired: 'GitHub no longer keeps it',
  too_large: 'it is too large to read here',
  unreachable: 'GitHub could not be reached',
  no_lines: 'the step wrote nothing',
};

/**
 * Read once on mount, and again when `refreshKey` changes: the item view
 * passes its pull request and timeline, which move when a new head is pushed
 * or CI reports. A job log is read on each fetch, so not on every stream tick.
 */
export function CiFailureSection({ subject, repo, refreshKey }: { subject: string; repo: string | null; refreshKey: string }) {
  const [failure, setFailure] = useState<CiFailure | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(ciFailurePath(subject), { cache: 'no-store' })
      .then(async (response) => {
        if (!live) return;
        // An older bridge has no such route: say nothing rather than guess.
        if (!response.ok) return setFailure(null);
        const body = (await response.json().catch(() => null)) as CiFailure | null;
        setFailure(body && typeof body.state === 'string' ? body : null);
      })
      .catch(() => live && setFailure(null));
    return () => {
      live = false;
    };
  }, [subject, refreshKey]);
  return <CiFailureView failure={failure} repo={repo} />;
}

export function CiFailureView({ failure, repo }: { failure: CiFailure | null; repo: string | null }) {
  if (!failure || failure.state !== 'red') return null;
  return (
    <section data-ci-failure className="flex flex-col gap-2 rounded-lg border border-edge bg-surface px-3 py-2.5">
      <h2 className="text-[13px] font-semibold text-body">Why ci is red</h2>
      {failure.jobs.length === 0 && <p className="text-[12.5px] text-soft">The run failed, but GitHub names no failed job.</p>}
      {failure.jobs.map((job) => (
        <div key={job.name} data-failing-job className="flex flex-col gap-1">
          <p className="text-[12.5px] text-body">
            The <code>{job.name}</code> job
            {job.step ? (
              <>
                {' '}
                failed at its step “<span data-failing-step>{job.step}</span>”.
              </>
            ) : (
              ' failed.'
            )}
          </p>
          {job.excerpt ? (
            <pre data-excerpt className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded border border-edge p-2 font-mono text-[11.5px] text-body">
              {job.excerpt.join('\n')}
            </pre>
          ) : (
            <p data-excerpt-missing className="text-[12px] text-soft">
              The log is not available ({MISSING[job.excerptMissing ?? 'unreachable'] ?? job.excerptMissing}).{' '}
              {job.url && (
                <a href={job.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                  Open the job on GitHub
                </a>
              )}
            </p>
          )}
          {job.excerpt && job.url && (
            <a href={job.url} target="_blank" rel="noreferrer" className="text-[12px] text-link hover:underline">
              Open the job on GitHub
            </a>
          )}
        </div>
      ))}
      <div className="flex gap-3 text-[12px]">
        <a data-run-link href={failure.runUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
          Open the run on GitHub
        </a>
        {repo && (
          <a data-checks-link href={`/checks/${encodeURIComponent(repo)}`} className="text-link hover:underline">
            Checks of {repo}
          </a>
        )}
      </div>
    </section>
  );
}
