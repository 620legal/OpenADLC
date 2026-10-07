import Link from 'next/link';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ChevronLeftIcon } from '@/components/icons';
import { AdminsOnly } from '@/components/not-a-user';
import { SpendingLimits } from '@/components/spending-limits';
import { api, readMe } from '@/lib/api';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Where the caps are changed. Settings shows the global month total and the
 * per-task cap and links here; this page is Global (the month, the task, each
 * bot, each provider) and Repositories (blank uses the global cap, or lower).
 */
export default async function SpendingSettingsPage() {
  // The caps are an admin's, as Settings is: a user who types the address is
  // told so, rather than shown an editor whose every save is refused.
  const me = await readMe();
  if (me?.known && me.role !== 'admin')
    return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Spending limits need" doing="changes the spending caps" />;

  try {
    const [repos, crew, costs, spending] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      api.spendingLimits().catch(() => null),
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
          <Link
            href="/settings#spending-limits"
            className="inline-flex h-11 items-center gap-1 self-start text-[12.5px] text-link hover:underline md:h-auto"
          >
            <ChevronLeftIcon size={12} />
            Settings
          </Link>
          <SpendingLimits initial={spending} />
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
