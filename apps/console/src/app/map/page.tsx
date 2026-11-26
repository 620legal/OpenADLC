import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Map (#380): the managed repositories, each opening its project map. It
 * reads no map itself, so it costs no request per repository.
 */
export default async function MapsPage() {
  let header;
  try {
    header = await readHeader();
  } catch (error) {
    return <BridgeDown error={error} />;
  }

  return (
    <AppShell page="map" data={header}>
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <h1 className="text-[16px] font-semibold text-body">Map</h1>
        <p className="text-[12.5px] text-soft">
          A summary of each repository’s default branch — its areas and packages, key ADRs and Human-review paths — that OpenADLC builds and gives to design and build tasks.
        </p>
        {header.repos.length === 0 ? (
          <p className="text-[12.5px] text-muted">No repository is managed yet.</p>
        ) : (
          <ul data-maps className="flex flex-col gap-2">
            {header.repos.map((repo) => (
              <li key={repo} data-map-repo={repo} className="rounded-md border border-edge px-3 py-2 text-[12.5px]">
                <a href={`/map/${encodeURIComponent(repo)}`} className="font-medium text-link hover:underline">
                  {repo}
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </AppShell>
  );
}
