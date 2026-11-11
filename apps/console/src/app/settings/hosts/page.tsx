import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { HostsList } from '@/components/hosts-list';
import { AdminsOnly } from '@/components/not-a-user';
import { SettingsNav } from '@/components/settings-nav';
import { api, readMe } from '@/lib/api';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';
import { navOmit } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * The machines that run tasks, read-only: each one's heartbeat, its tasks
 * against its capacity, its CPUs and memory, and for a silent one what its
 * silence cost. So a stopped hostd shows in the console, not only in
 * `openadlc doctor`. Its content is `GET /v1/hosts`; beside it, Settings'
 * navigation, with Hosts marked (ADR 0053).
 */
export default async function HostsSettingsPage() {
  // Settings are an admin's, and so is this page (roles.ts).
  const me = await readMe();
  if (me?.known && me.role !== 'admin')
    return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Hosts need" doing="shows the machines that run tasks" />;

  try {
    const [repos, crew, costs, hosts, egress, personRoles] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      api.hosts(),
      // For the navigation alone, which leaves out what `/settings` leaves out.
      api.egressHosts().catch(() => null),
      api.peopleRoles().catch(() => null),
    ]);
    const header = await readHeader({
      repos: repos.repos.map((repo) => repo.name),
      colors: colorMapOf(repos.repos),
      crew: crew.bots,
      costs,
    });

    return (
      <AppShell page="settings" data={header}>
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 py-6 md:flex-row md:gap-10 md:px-6 md:py-7">
          <SettingsNav on="hosts" omit={navOmit({ egress, personRoles })} />
          <main className="flex min-w-0 max-w-[820px] flex-1 flex-col gap-4">
            <h1 className="sr-only">Hosts</h1>
            <HostsList view={hosts} />
          </main>
        </div>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
