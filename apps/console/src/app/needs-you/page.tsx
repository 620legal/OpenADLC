import { BridgeDown } from '@/components/bridge-down';
import { NeedsYouPage } from '@/components/needs-you-page';
import { api } from '@/lib/api';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/** Every item waiting on the person, work and system apart; see `NeedsYouPage`. */
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  try {
    const [attention, crew] = await Promise.all([api.attention().then((body) => body.items), api.crew()]);
    const header = await readHeader({ crew: crew.bots, attention });
    return (
      <NeedsYouPage
        items={attention}
        crew={crew.bots}
        header={header}
        now={new Date().toISOString()}
        tab={tab === 'system' ? 'system' : 'work'}
      />
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
