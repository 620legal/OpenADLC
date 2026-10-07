import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ChevronLeftIcon } from '@/components/icons';
import { AdminsOnly } from '@/components/not-a-user';
import { RepoSettings } from '@/components/repo-settings';
import { api, readMe, type DesignMemoryEntry, type WorkPauses } from '@/lib/api';
import { findBot } from '@/lib/bot-label';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';
import { buildersOf } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * One repository's settings, on a page of its own: who builds it, how many
 * tasks at once, what each stage may do without asking, its colour, and
 * taking it out of OpenADLC. They were all on the settings page, one repository
 * after another, which made that page as long as the list of repositories;
 * settings now lists them and links here.
 */
export default async function RepositorySettingsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const wanted = decodeURIComponent(name);
  // A repository's settings are an admin's, as Settings is: a user who types
  // the address is told so, rather than shown controls whose every save, and
  // the design memory's read, the bridge refuses.
  const me = await readMe();
  if (me?.known && me.role !== 'admin')
    return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Repository settings need" doing="changes a repository’s settings" />;
  let read;
  try {
    const [repos, crew, costs, pauses, memory] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      api.workPauses().catch((): WorkPauses => ({ paused: null, repos: {} })),
      // A bridge a release behind has no design memory: the page still draws.
      (async () => api.designMemory(wanted))().catch((): DesignMemoryEntry[] => []),
    ]);
    const header = await readHeader({
      repos: repos.repos.map((one) => one.name),
      colors: colorMapOf(repos.repos),
      crew: crew.bots,
      costs,
    });
    read = { repos, crew, header, pauses, memory };
  } catch (error) {
    return <BridgeDown error={error} />;
  }

  const { repos, crew, header, pauses, memory } = read;
  const repo = repos.repos.find((one) => one.name === wanted);
  // A repository taken out of OpenADLC, or a link with a name that never was one.
  if (!repo) notFound();
  const owner = repo.owner ? (findBot(crew.bots, repo.owner) ?? null) : null;
  const reviewers = crew.bots.filter((bot) => bot.role.startsWith('review')).length;

  return (
    <AppShell page="settings" data={header}>
      <main className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <Link
          href="/settings#repository"
          className="inline-flex h-11 items-center gap-1 self-start text-[12.5px] text-link hover:underline md:h-auto"
        >
          <ChevronLeftIcon size={12} />
          Settings
        </Link>
        <section aria-label={`${repo.name} settings`} className="rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
          <RepoSettings
            repo={repo}
            owner={owner}
            builders={buildersOf(owner, crew.bots)}
            reviewers={reviewers}
            maxReviewRounds={repos.maxReviewRounds ?? null}
            pause={pauses.repos[repo.name] ?? null}
            installPaused={Boolean(pauses.paused)}
            designMemory={memory}
          />
          {/* The seed writes what config/repos.yaml sets at every start, over a change made here. */}
          <p className="mt-2.5 text-[12.5px] text-muted">
            A setting written for this repository in config/repos.yaml is put back at the next start. One the file leaves out
            stays as you set it here.
          </p>
        </section>
      </main>
    </AppShell>
  );
}
