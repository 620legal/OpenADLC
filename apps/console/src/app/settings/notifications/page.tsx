import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { NotificationSettings } from '@/components/notification-settings';
import { PushDevices } from '@/components/push-devices';
import { SettingsNav } from '@/components/settings-nav';
import { api, readMe } from '@/lib/api';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';
import { navOmit } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * Push to the console app, OpenADLC's only notification channel (ADR 0049):
 * everyone signed in, on a local install too, turns it on for the device they
 * are on and sees their others (ADR 0048). Below, an admin switches kinds off
 * for every device, as every setting is an admin's.
 *
 * The `notifications` health card's button lands here: its fix is an admin's
 * device that takes push.
 *
 * It is the one part of Settings a non-admin has, and the header's Settings
 * link lands them here (ADR 0053): their navigation is Notifications alone.
 */
export default async function NotificationSettingsPage() {
  const me = await readMe();
  const admin = !me?.known || me.role === 'admin';
  const local = me?.known === true && me.identityMode === 'local';

  try {
    const [repos, crew, costs, notifications, devices, egress, personRoles] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      admin ? api.notifications() : Promise.resolve(null),
      api.pushDevices().catch(() => null),
      // For an admin's navigation alone; a user's is Notifications and nothing to leave out.
      admin ? api.egressHosts().catch(() => null) : Promise.resolve(null),
      admin ? api.peopleRoles().catch(() => null) : Promise.resolve(null),
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
          <SettingsNav on="notifications" admin={admin} omit={admin ? navOmit({ egress, personRoles }) : []} />
          <main className="flex min-w-0 max-w-[820px] flex-1 flex-col gap-4">
            <h1 className="sr-only">Notifications</h1>
            {devices && <PushDevices initial={devices} local={local} />}
            {notifications && <NotificationSettings initial={notifications} />}
          </main>
        </div>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
