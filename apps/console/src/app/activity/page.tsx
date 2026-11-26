import { ActivityFeed } from '@/components/activity-feed';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Activity (#374): the crew's last thirty days, across repositories, newest
 * first, a page at a time. `?repo=` and `?bot=` choose the filters, so a
 * narrowed view can be shared; the list itself is read in the browser, page
 * by page, through `/api/board/events`.
 */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ repo?: string | string[]; bot?: string | string[] }> }) {
  const { repo, bot } = await searchParams;
  let header;
  try {
    header = await readHeader();
  } catch (error) {
    return <BridgeDown error={error} />;
  }

  const one = (value: string | string[] | undefined): string => (typeof value === 'string' ? value : '');
  return (
    <AppShell page="activity" repo={one(repo) || 'all'} data={header}>
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <h1 className="text-[16px] font-semibold text-body">Activity</h1>
        <p className="text-[12.5px] text-soft">
          What the crew has done in the last 30 days: tasks started, questions asked, pull requests opened, approved, held and merged, releases published, and tasks stopped at their cap.
        </p>
        <ActivityFeed repos={header.repos} crew={header.crew} initialRepo={one(repo)} initialBot={one(bot)} />
      </main>
    </AppShell>
  );
}
