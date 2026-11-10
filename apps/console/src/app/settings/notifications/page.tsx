import Link from 'next/link';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ChevronLeftIcon } from '@/components/icons';
import { NotificationSettings } from '@/components/notification-settings';
import { PushDevices } from '@/components/push-devices';
import { api, readMe } from '@/lib/api';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Push to the console app, OpenADLC's only notification channel (ADR 0049):
 * everyone signed in, on a local install too, turns it on for the device they
 * are on and sees their others (ADR 0048). Below, an admin switches kinds off
 * for every device, as every setting is an admin's.
 *
 * The `notifications` health card's button lands here: its fix is an admin's
 * device that takes push.
 */
export default async function NotificationSettingsPage() {
  const me = await readMe();
  const admin = !me?.known || me.role === 'admin';
  const local = me?.known === true && me.identityMode === 'local';

  try {
    const [repos, crew, costs, notifications, devices] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      admin ? api.notifications() : Promise.resolve(null),
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
          {notifications && <NotificationSettings initial={notifications} />}
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
