import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { InsightsBody } from '@/components/insights-view';
import { api } from '@/lib/api';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/** How fast work moves and what holds it up; see `InsightsBody`. */
export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ repo?: string; days?: string }> }) {
  const params = await searchParams;
  const days = params.days === '30' ? 30 : 7;
  const repo = params.repo?.trim() || null;
  try {
    const [insights, crew, repos] = await Promise.all([
      api.insights({ repo, days }),
      api.crew().then((body) => body.bots).catch(() => []),
      // Every repository for the filter, whichever one is shown.
      api.repos().then((body) => body.repos.map((one) => one.name)).catch(() => [] as string[]),
    ]);
    const header = await readHeader({ crew });
    return (
      <AppShell page="insights" data={header}>
        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="mb-4">
            <h1 className="text-base font-semibold">Insights</h1>
            <p className="mt-0.5 text-[12px] text-muted">How fast work moves, and what holds it up, over the last {days} days.</p>
          </div>
          <InsightsBody insights={insights} repos={repos.length > 0 ? repos : insights.repos.map((one) => one.repo)} repo={repo} />
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
