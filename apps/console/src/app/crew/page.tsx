import { BridgeDown } from '@/components/bridge-down';
import { CrewView } from '@/components/crew-view';
import { api, waitingCount } from '@/lib/api';
import { headerData } from '@/lib/header';
import { colorMapOf } from '@/lib/repo-colors';

export const dynamic = 'force-dynamic';

export default async function CrewPage() {
  try {
    // The crew is the page; the rest are parts of it a bridge that cannot
    // answer them leaves out rather than failing the page over.
    const [crew, costs, accounts, attention, repos] = await Promise.all([
      api.crew(),
      api.costs().catch(() => null),
      api.modelAccounts().then((body) => body.accounts).catch(() => []),
      api.attention().then((body) => body.items).catch(() => null),
      api.repos().then((body) => body.repos).catch(() => []),
    ]);

    return (
      <CrewView
        crew={crew.bots}
        accounts={accounts}
        byBot={costs?.byBot ?? []}
        header={headerData({
          repos: repos.map((repo) => repo.name),
          repoColors: colorMapOf(repos),
          crew: crew.bots,
          budget: costs?.budget ?? null,
          needsYou: attention ? waitingCount(attention) : null,
          attention,
        })}
        now={new Date().toISOString()}
      />
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
