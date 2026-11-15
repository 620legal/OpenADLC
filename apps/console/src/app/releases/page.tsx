import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { RunStateWord } from '@/components/cut-release';
import { api } from '@/lib/api';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Releases (#345): the repositories set to release, each with its latest
 * run. Each opens its own page, where the changes since the last release are
 * compared and a person with Approves on cuts the next one.
 */
export default async function ReleasesPage() {
  let read;
  try {
    const [repos, header] = await Promise.all([api.releases(), readHeader()]);
    read = { repos, header };
  } catch (error) {
    return <BridgeDown error={error} />;
  }
  const { repos, header } = read;

  return (
    <AppShell page="releases" data={header}>
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <h1 className="text-[16px] font-semibold text-body">Releases</h1>
        {repos.length === 0 ? (
          <p className="text-[12.5px] text-muted">
            No repository is set to release. An admin sets a repository’s release recipe in Settings → the repository → Release.
          </p>
        ) : (
          <ul data-releases className="flex flex-col gap-2">
            {repos.map((repo) => (
              <li key={repo.fullName} data-release-repo={repo.name} className="flex flex-wrap items-center gap-2 rounded-md border border-edge px-3 py-2 text-[12.5px]">
                <a href={`/releases/${encodeURIComponent(repo.name)}`} className="font-medium text-link hover:underline">
                  {repo.fullName}
                </a>
                {repo.releaseRepo && <span className="text-dim">publishes to {repo.releaseRepo}</span>}
                {repo.latest ? (
                  <span className="text-soft">
                    <RunStateWord state={repo.latest.state} />
                    {repo.latest.version ? ` ${repo.latest.version}` : ''} · {repo.latest.sha.slice(0, 7)}
                  </span>
                ) : (
                  <span className="text-muted">no release cut yet</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </AppShell>
  );
}
