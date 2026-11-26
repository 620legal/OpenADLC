import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { SecurityBody } from '@/components/security-view';
import { api } from '@/lib/api';
import { readHeader } from '@/lib/read-header';
import { filtersFrom } from '@/lib/security';

export const dynamic = 'force-dynamic';

/** Each managed repository's open GitHub security alerts; see `SecurityBody`. */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ repo?: string; severity?: string }> }) {
  const filters = filtersFrom(await searchParams);
  try {
    const [view, crew, repos] = await Promise.all([
      api.securityAlerts({ repo: filters.repo }),
      api.crew().then((body) => body.bots).catch(() => []),
      // Every repository for the filter, whichever one is shown.
      api.repos().then((body) => body.repos.map((one) => one.name)).catch(() => [] as string[]),
    ]);
    const header = await readHeader({ crew });
    return (
      <AppShell page="security" data={header}>
        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="mb-4">
            <h1 className="text-base font-semibold">Security</h1>
            <p className="mt-0.5 text-[12px] text-muted">
              Open Dependabot, code-scanning and secret-scanning alerts on each repository, read from GitHub as the app.
            </p>
          </div>
          <SecurityBody view={view} repos={repos.length > 0 ? repos : view.repos.map((one) => one.repo)} filters={filters} />
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
