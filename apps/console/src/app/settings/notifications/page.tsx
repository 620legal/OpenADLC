import Link from 'next/link';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ChevronLeftIcon } from '@/components/icons';
import { AdminsOnly } from '@/components/not-a-user';
import { NotificationSettings } from '@/components/notification-settings';
import { PersonalNotificationSettings } from '@/components/personal-notification-settings';
import { PushDevices } from '@/components/push-devices';
import { api, readMe } from '@/lib/api';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Where notifications go, which kinds, and Send a test. The notifications
 * health card's button lands here: its fix is a send that gets through.
 *
 * Everyone signed in to a cloud install also sets their own channel here,
 * where the items routed to them go (ADR 0035). The install's channel is an
 * admin's, as every setting is: a user sees only theirs. A local install has
 * one person, whose channel is the install's.
 *
 * Above both, everyone signed in, on a local install too, turns push on for
 * the device they are on and sees their others (ADR 0048).
 */
export default async function NotificationSettingsPage() {
  const me = await readMe();
  const admin = !me?.known || me.role === 'admin';
  const personal = me?.known === true && me.identityMode !== 'local';
  const local = me?.known === true && me.identityMode === 'local';
  if (!admin && !personal)
    return <AdminsOnly email={me?.email ?? ''} identityMode={me?.identityMode} what="Notifications need" doing="changes where notifications go" />;

  try {
    const [repos, crew, costs, notifications, mine, devices] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      admin ? api.notifications() : Promise.resolve(null),
      personal ? api.myNotifications().catch(() => null) : Promise.resolve(null),
      api.pushDevices().catch(() => null),
    ]);
    const header = await readHeader({
      repos: repos.repos.map((repo) => repo.name),
      colors: colorMapOf(repos.repos),
      crew: crew.bots,
      costs,
    });

    return (
      <AppShell page="settings" data={header}>
        <main className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
          <Link href="/settings#notifications" className="inline-flex h-11 items-center gap-1 self-start text-[12.5px] text-link hover:underline md:h-auto">
            <ChevronLeftIcon size={12} />
            Settings
          </Link>
          {devices && <PushDevices initial={devices} local={local} />}
          {mine && <PersonalNotificationSettings initial={mine} />}
          {notifications && <NotificationSettings initial={notifications} />}
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
