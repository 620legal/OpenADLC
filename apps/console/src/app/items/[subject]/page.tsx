import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ItemView } from '@/components/item-view';
import { api, type ItemView as ItemData } from '@/lib/api';
import { itemAddress, subjectFrom } from '@/lib/item';
import { readHeader } from '@/lib/read-header';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * One work item as a page: the request, its issue and its pull request as one
 * conversation, labelled by role. The board opens the same view as a sheet
 * (`/?item=`); this is the address to keep or send.
 */
export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ subject: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  const { subject: raw } = await params;
  const { role } = await searchParams;
  const subject = subjectFrom(raw);
  // An item the bridge does not know is said on the page itself, which reads
  // again and says why; the header still draws.
  const initial = await api.item(subject).catch((): ItemData | null => null);
  // Any member's subject, an old key or another prefix opens the item at its
  // key: the one address to keep or send. Outside the try below, whose catch
  // would take the redirect for a bridge that is down.
  const to = itemAddress(subject, initial, role ?? null);
  if (to) redirect(to);
  try {
    const header = await readHeader();
    return (
      <AppShell page="board" data={header} fill>
        <h1 className="sr-only">{initial?.title ?? subject}</h1>
        <main className="flex min-h-0 flex-1 flex-col">
          <ItemView subject={subject} initial={initial} now={new Date().toISOString()} initialRole={role ?? null} />
        </main>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
