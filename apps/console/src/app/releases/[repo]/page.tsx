import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { CutRelease } from '@/components/cut-release';
import { api, type ReleaseView } from '@/lib/api';
import { BridgeAnswered } from '@/lib/bridge-answered';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * One repository's releases (#345, docs/adr/0072): the changes since the last
 * release, as GitHub compares them with the default branch's head, the
 * version at that head, Cut release, and the runs.
 *
 * Opening the page pins a view in the bridge: the head is read once, and a
 * cut from this page builds that commit, whatever the branch does next.
 * Reloading pins a new one.
 */
export default async function ReleasePage({ params }: { params: Promise<{ repo: string }> }) {
  const { repo: raw } = await params;
  const repo = decodeURIComponent(raw);
  let read;
  try {
    const [view, runs, header] = await Promise.all([
      api.releaseView(repo).catch((error: unknown) => {
        // A refusal the bridge explained — no recipe, the last release unreadable — is said on the page.
        if (error instanceof BridgeAnswered && error.status !== 500) return { refused: error.said || error.message, status: error.status };
        throw error;
      }),
      api.releaseRuns(repo).catch((error: unknown) => {
        if (error instanceof BridgeAnswered && error.status === 404) return null;
        throw error;
      }),
      readHeader(),
    ]);
    read = { view, runs, header };
  } catch (error) {
    return <BridgeDown error={error} />;
  }
  const { view, runs, header } = read;
  if (runs === null) notFound();

  return (
    <AppShell page="releases" data={header}>
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-5 px-4 py-6 md:px-6 md:py-7">
        <h1 className="text-[16px] font-semibold text-body">Releases of {repo}</h1>
        {'refused' in view ? (
          <section className="flex flex-col gap-3">
            <p data-refused className="text-[12.5px] text-soft">
              {view.refused}
            </p>
            <CutReleaseRunsOnly repo={repo} runs={runs} />
          </section>
        ) : (
          <>
            <Pinned view={view} />
            <section className="flex flex-col gap-2">
              <h2 className="text-[13px] font-semibold text-body">Cut release</h2>
              <CutRelease repo={repo} viewId={view.viewId} mayCut={view.mayCut} why={view.why ?? null} url={view.url ?? null} runs={runs} />
            </section>
          </>
        )}
      </main>
    </AppShell>
  );
}

/** The runs, with no view to cut from. */
function CutReleaseRunsOnly({ repo, runs }: { repo: string; runs: NonNullable<Awaited<ReturnType<typeof api.releaseRuns>>> }) {
  return <CutRelease repo={repo} viewId="" mayCut={false} why="Nothing can be cut until that is fixed; reload once it is." runs={runs} />;
}

/** What the pinned view shows: the last release, the head, the compare and the version. */
function Pinned({ view }: { view: ReleaseView }) {
  const compare = view.compare;
  return (
    <section data-view className="flex flex-col gap-3 text-[12.5px]">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">Last release</dt>
        <dd data-last className="text-body">
          {view.last ? (
            view.last.url ? (
              <a href={view.last.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                {view.last.tag}
              </a>
            ) : (
              view.last.tag
            )
          ) : (
            'none yet'
          )}
          {view.releaseRepo !== view.fullName && <span className="text-dim"> in {view.releaseRepo}</span>}
        </dd>
        <dt className="text-muted">Would cut</dt>
        <dd data-head className="text-body">
          {view.defaultBranch} at <span className="font-mono" title={view.sha}>{view.sha.slice(0, 7)}</span>
          <span className="ml-2 break-all font-mono text-[11px] text-dim">{view.sha}</span>
        </dd>
        <dt className="text-muted">Version</dt>
        <dd data-version className="text-body">
          {view.version ? (view.version.after ? `${view.version.text}, after ${view.version.after}` : `${view.version.text}, the first release`) : 'could not be read'}
        </dd>
      </dl>
      {compare === null ? null : compare.first ? (
        <p data-compare className="text-soft">
          No release yet; this cuts the first one from {view.sha.slice(0, 7)}.
        </p>
      ) : (
        <div data-compare className="flex flex-col gap-1.5">
          <p className="text-soft">
            {compare.totalCommits} commit{compare.totalCommits === 1 ? '' : 's'} and {compare.files} file{compare.files === 1 ? '' : 's'} changed since {view.last?.tag}.
            {compare.htmlUrl && (
              <>
                {' '}
                <a href={compare.htmlUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
                  Open the compare on GitHub
                </a>
              </>
            )}
          </p>
          <ul className="flex flex-col gap-0.5">
            {compare.commits.map((commit) => (
              <li key={commit.sha7} className="flex gap-2">
                <span className="font-mono text-muted">{commit.sha7}</span>
                <span className="text-body">{commit.title}</span>
                {commit.author && <span className="text-dim">@{commit.author}</span>}
              </li>
            ))}
          </ul>
          {compare.totalCommits > compare.commits.length && <p className="text-dim">and {compare.totalCommits - compare.commits.length} more</p>}
        </div>
      )}
    </section>
  );
}
