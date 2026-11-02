import Link from 'next/link';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { HostsList } from '@/components/hosts-list';
import { ChevronLeftIcon } from '@/components/icons';
import { AdminsOnly } from '@/components/not-a-user';
import { api, readMe } from '@/lib/api';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * The machines that run tasks, read-only: each one's heartbeat, its tasks
 * against its capacity, its CPUs and memory, and for a silent one what its
 * silence cost. So a stopped hostd shows in the console, not only in
 * `openadlc doctor`. Its content is `GET /v1/hosts` and nothing else.
 */
export default async function HostsSettingsPage() {
  // Settings are an admin's, and so is this page (roles.ts).
  const me = await readMe();
  if (me?.known && me.role !== 'admin')
    return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Hosts need" doing="shows the machines that run tasks" />;

  try {
    const [repos, crew, costs, hosts] = await Promise.all([api.repos(), api.crew(), api.costs().catch(() => null), api.hosts()]);
    const header = await readHeader({
      repos: repos.repos.map((repo) => repo.name),
      colors: colorMapOf(repos.repos),
      crew: crew.bots,
      costs,
    });

    return (
      <AppShell page="settings" data={header}>
        <main className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
          <Link
            href="/settings#hosts"
            className="inline-flex h-11 items-center gap-1 self-start text-[12.5px] text-link hover:underline md:h-auto"
          >
            <ChevronLeftIcon size={12} />
            Settings
          </Link>
          <HostsList view={hosts} />
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
