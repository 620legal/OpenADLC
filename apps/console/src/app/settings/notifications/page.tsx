import Link from 'next/link';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ChevronLeftIcon } from '@/components/icons';
import { AdminsOnly } from '@/components/not-a-user';
import { NotificationSettings } from '@/components/notification-settings';
import { api, readMe } from '@/lib/api';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Where notifications go, which kinds, and Send a test. The notifications
 * health card's button lands here: its fix is a send that gets through.
 */
export default async function NotificationSettingsPage() {
  // An admin's, as every setting is: a user who types the address is told so,
  // rather than shown a form whose every save is refused.
  const me = await readMe();
  if (me?.known && me.role !== 'admin')
    return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Notifications need" doing="changes where notifications go" />;

  try {
    const [repos, crew, costs, notifications] = await Promise.all([api.repos(), api.crew(), api.costs().catch(() => null), api.notifications()]);
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
          <NotificationSettings initial={notifications} />
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
