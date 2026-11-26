import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ChecksTable } from '@/components/checks-table';
import { api, type ChecksView } from '@/lib/api';
import { BridgeAnswered } from '@/lib/bridge-answered';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * One repository's checks (#372, docs/adr/0083): what its `ci` workflow and
 * host check run, where, whether `make ci` covers each, its last result on
 * the default branch, and the flaky jobs first. Read-only: it reruns
 * nothing, starts no host check and writes nothing to GitHub.
 *
 * Whatever could not be read is said above the table, so an empty or short
 * table never passes for all being well.
 */
export default async function ChecksPage({ params }: { params: Promise<{ repo: string }> }) {
  const { repo: raw } = await params;
  const repo = decodeURIComponent(raw);
  let read;
  try {
    const [view, header, repos] = await Promise.all([
      api.checks(repo).catch((error: unknown) => {
        if (error instanceof BridgeAnswered && error.status === 404) return null;
        throw error;
      }),
      readHeader(),
      api
        .repos()
        .then((body) => body.repos.map((one) => one.name))
        .catch(() => [repo]),
    ]);
    read = { view, header, repos };
  } catch (error) {
    return <BridgeDown error={error} />;
  }
  const { view, header, repos } = read;
  if (view === null) notFound();

  return (
    <AppShell page="settings" data={header}>
      <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <h1 className="text-[16px] font-semibold text-body">Checks of {repo}</h1>
        <p className="text-[12.5px] text-soft">
          The jobs of the <code>ci</code> workflow on {view.defaultBranch}, and the host check, with each one&apos;s last result on {view.defaultBranch}.
          A job marked “differs from GitHub” never reaches <code>make ci</code>, so a builder&apos;s local pass says nothing about it. Flaky jobs,
          which failed and then passed on the same head in the last 30 runs, come first.
        </p>
        <StateLines view={view} />
        {view.localCi && (
          <p data-local-ci className="text-[12.5px] text-body">
            Local CI (<code>make ci</code>) on <span className="font-mono">{view.localCi.sha.slice(0, 7)}</span>: {view.localCi.ok ? 'passed' : 'failed'}
          </p>
        )}
        {view.rows.length > 0 ? (
          <ChecksTable repo={view.repo} rows={view.rows} repos={repos} />
        ) : (
          <p data-no-rows className="text-[12.5px] text-soft">
            No checks to show{view.workflow.detail ? `: ${view.workflow.detail}` : '.'}
          </p>
        )}
        <p className="text-[11.5px] text-soft">Read {new Date(view.readAt).toUTCString()}; read again at most once a minute.</p>
      </main>
    </AppShell>
  );
}

/** One line for each thing that could not be read, in words: never a silent gap. */
function stateLines(view: ChecksView): { key: string; text: string }[] {
  const lines: { key: string; text: string }[] = [];
  if (view.workflow.state !== 'read' && view.workflow.detail) {
    lines.push({ key: 'workflow', text: view.workflow.state === 'unreachable' ? `GitHub could not be reached: ${view.workflow.detail}` : view.workflow.detail });
  }
  if (view.makefile.state === 'missing' && view.makefile.detail) lines.push({ key: 'makefile', text: view.makefile.detail });
  if (view.makefile.state === 'unreachable' && view.workflow.state !== 'unreachable' && view.makefile.detail) {
    lines.push({ key: 'makefile', text: `The Makefile could not be read, so only \`make ci\` itself counts as covered: ${view.makefile.detail}` });
  }
  if (view.runs.state === 'unreachable' && view.workflow.state === 'read' && view.runs.detail) {
    lines.push({ key: 'runs', text: `GitHub could not be reached for the runs: ${view.runs.detail}` });
  }
  if (view.flakes.state === 'partial' && view.flakes.detail) lines.push({ key: 'flakes', text: view.flakes.detail });
  if (view.flakes.state === 'unreachable' && view.runs.state === 'read' && view.flakes.detail) {
    lines.push({ key: 'flakes', text: `Flaky jobs could not be worked out: ${view.flakes.detail}` });
  }
  return lines;
}

function StateLines({ view }: { view: ChecksView }) {
  const lines = stateLines(view);
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((line) => (
        <li key={line.key} data-state={line.key} className="rounded-md border border-attention/40 bg-attention/10 px-2.5 py-1.5 text-[12px] text-attention">
          {line.text}
        </li>
      ))}
    </ul>
  );
}
