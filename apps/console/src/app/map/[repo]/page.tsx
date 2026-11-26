import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { Markdown } from '@/components/markdown';
import { api, type ProjectMapRead } from '@/lib/api';
import { BridgeAnswered } from '@/lib/bridge-answered';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/** The line hostd opens every map with, which says its format to hostd and nothing to a reader. */
const FORMAT_LINE = /^<!-- openadlc-project-map v\d+ -->\r?\n/;

/** A UTC instant as `2026-11-25 at 10:00 UTC`: the server draws the page, and its zone is nobody's. */
function onAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toISOString();
  return `${text.slice(0, 10)} at ${text.slice(11, 16)} UTC`;
}

/**
 * One repository's project map (#380, docs/adr/0088): the summary of its
 * default branch that hostd builds under its work root, the commit it was
 * built from and when. Spec and implement tasks are given the same map, cut
 * at 48 KiB; this page always shows it whole. Read-only.
 */
export default async function MapPage({ params }: { params: Promise<{ repo: string }> }) {
  const { repo: raw } = await params;
  const repo = decodeURIComponent(raw);
  let read;
  try {
    const [map, header] = await Promise.all([
      api.projectMap(repo).catch((error: unknown) => {
        if (error instanceof BridgeAnswered && error.status === 404) return null;
        throw error;
      }),
      readHeader(),
    ]);
    read = { map, header };
  } catch (error) {
    return <BridgeDown error={error} />;
  }
  const { map, header } = read;
  if (map === null) notFound();

  return (
    <AppShell page="map" data={header}>
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <header className="flex flex-col gap-1">
          <h1 className="text-[16px] font-semibold text-body">Map of {map.repo}</h1>
          {map.content && map.commit && <Built map={map} commit={map.commit} />}
        </header>
        {map.content ? (
          <>
            {map.state === 'failed' && (
              <p data-map-failed className="text-[12.5px] text-soft">
                The last rebuild failed ({map.error ?? 'no reason given'}); this is the map built from {map.commit?.slice(0, 7) ?? 'an earlier commit'}.
              </p>
            )}
            <article data-map className="text-[13px] text-body">
              <Markdown text={map.content.replace(FORMAT_LINE, '')} />
            </article>
          </>
        ) : (
          <section data-map-none className="flex flex-col gap-1 text-[12.5px] text-soft">
            <p>{map.repo} has no project map yet. It is built within 15 minutes of the repository being added, by the maps job.</p>
            {map.state === 'failed' && <p data-map-failed>The last attempt failed: {map.error ?? 'no reason given'}</p>}
          </section>
        )}
      </main>
    </AppShell>
  );
}

function Built({ map, commit }: { map: ProjectMapRead; commit: string }) {
  return (
    <p data-map-built className="text-[12.5px] text-muted">
      Built from{' '}
      <a href={`https://github.com/${map.repo}/commit/${commit}`} target="_blank" rel="noreferrer" className="font-mono text-link hover:underline" title={commit}>
        {commit.slice(0, 7)}
      </a>
      {map.builtAt ? ` on ${onAt(map.builtAt)}` : ''}
    </p>
  );
}
