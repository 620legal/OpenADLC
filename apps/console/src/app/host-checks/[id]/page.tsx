import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { api, type HostCheckRun } from '@/lib/api';
import { BridgeAnswered } from '@/lib/bridge-answered';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/** What each state is called on the page. */
const STATE: Record<HostCheckRun['state'], string> = {
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refused: 'Not run',
  lost: 'Lost when hostd restarted',
  carried: 'Passed on an earlier head with the same changes',
};

function minutes(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 60_000 ? 'under a minute' : `${Math.round(ms / 60_000)} min`;
}

/**
 * One host check run (#327): what ran, on which head, how it ended and the end
 * of what it printed. The `host-check` status on GitHub and the held
 * approval's card link here, so a person reads why it failed without the
 * machine it ran on.
 */
export default async function HostCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let read;
  try {
    const [run, header] = await Promise.all([
      api.hostCheck(decodeURIComponent(id)).catch((error: unknown) => {
        // A run the bridge does not know is the page's 404, not the bridge being down.
        if (error instanceof BridgeAnswered && error.status === 404) return null;
        throw error;
      }),
      readHeader(),
    ]);
    read = { run, header };
  } catch (error) {
    return <BridgeDown error={error} />;
  }
  const { run, header } = read;
  if (!run) notFound();

  const facts: [string, string][] = [
    ['Pull request', `${run.repoFullName}#${run.prNumber}`],
    ['Head', run.headSha.slice(0, 7)],
    ['State', STATE[run.state]],
    ['Command', run.command],
    ['Time limit', `${run.timeoutMinutes} min`],
  ];
  if (run.carriedFrom) facts.push(['Passed on', run.carriedFrom.slice(0, 7)]);
  const took = minutes(run.durationMs);
  if (took) facts.push(['Took', took]);
  if (run.exitCode !== null) facts.push(['Exit code', String(run.exitCode)]);
  facts.push(['Started', run.startedAt]);
  if (run.finishedAt) facts.push(['Finished', run.finishedAt]);

  return (
    <AppShell page="board" data={header}>
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <h1 className="text-[16px] font-semibold text-body">
          Host check on {run.repoName}#{run.prNumber}
        </h1>
        <dl data-host-check-facts className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12.5px]">
          {facts.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted">{term}</dt>
              <dd className="break-words font-mono text-body">{value}</dd>
            </div>
          ))}
        </dl>
        {run.reason && (
          <p data-reason className="text-[12.5px] text-soft">
            {run.reason}
          </p>
        )}
        {run.logTail ? (
          <pre
            data-log
            className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-surface px-3 py-2 font-mono text-[11px] leading-snug text-muted"
          >
            {run.logTail}
          </pre>
        ) : (
          <p className="text-[12.5px] text-muted">{run.state === 'running' ? 'Its log is kept once it ends.' : 'It printed nothing that was kept.'}</p>
        )}
      </main>
    </AppShell>
  );
}
