'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { ItemView } from '@/components/item-view';
import { NEEDS_YOU_PAGE, NeedsList, type OpenBot, type OpenItem } from '@/components/needs-you';
import { ThreadPanel } from '@/components/thread-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AttentionItem, CrewMember } from '@/lib/api';
import { groupCounts, groupOf, type AttentionGroup } from '@/lib/attention-card';
import { findBot } from '@/lib/bot-label';
import type { HeaderData } from '@/lib/header';

/**
 * Everything waiting on the person, in two lists: **Work**, what the
 * crew needs from them to go on with the issues, and **System**, what the
 * install needs — a health check, a permission, a sign-in, an engine update.
 * Each is the board's compact cards, with Show more for the rest of a card.
 *
 * They were one list above the board. A dozen system cards buried the one
 * question a bot was waiting on, and the header's count added the two
 * together.
 */
export function NeedsYouPage({
  items,
  crew,
  header,
  now,
  tab: initialTab,
}: {
  items: readonly AttentionItem[];
  crew: CrewMember[];
  header: HeaderData;
  now: string;
  /** From `?tab=`, so a link can open on System. */
  tab: AttentionGroup;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<AttentionGroup>(initialTab);
  // `?tab=` says which list is open: a link to it while here switches, and a
  // switch is written back, so a reload or Back opens the same one.
  useEffect(() => setTab(initialTab), [initialTab]);
  const switchTo = (next: AttentionGroup) => {
    setTab(next);
    router.replace(`${NEEDS_YOU_PAGE}?tab=${next}`, { scroll: false });
  };
  const [openBot, setOpenBot] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const openThread: OpenBot = (bot, how) => {
    setOpenBot(bot);
    setCompose(Boolean(how?.compose));
  };
  // A work card opens its own item, on the tab of the role that asked.
  const [openItem, setOpenItem] = useState<{ subject: string; role: string | null } | null>(null);
  const openWork: OpenItem = (item, role) => setOpenItem({ subject: item, role });
  const counts = groupCounts(items);
  const of = (group: AttentionGroup) => items.filter((item) => groupOf(item) === group);

  return (
    <AppShell page="needs-you" data={header}>
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 px-4 py-6 md:px-6">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h1 className="text-[17px] font-semibold text-body">Needs you</h1>
          <span className="text-[12.5px] text-muted">Once there is an issue, the bot that asked posts your answer on it, with your name.</span>
        </div>
        <Tabs value={tab} onValueChange={(value) => switchTo(value === 'system' ? 'system' : 'work')}>
          <div className="border-b border-edge">
            <TabsList aria-label="Which list">
              <TabsTrigger value="work">
                Work <Count n={counts.work} />
              </TabsTrigger>
              <TabsTrigger value="system">
                System <Count n={counts.system} />
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="work" className="pt-4">
            <NeedsList items={of('work')} now={now} onOpenBot={openThread} onOpenItem={openWork} empty="Nothing from the crew waits on you." />
          </TabsContent>
          <TabsContent value="system" className="pt-4">
            <NeedsList items={of('system')} now={now} onOpenBot={openThread} empty="Nothing about the install needs you." />
          </TabsContent>
        </Tabs>
      </main>

      {openItem && (
        <ItemView key={openItem.subject} subject={openItem.subject} initialRole={openItem.role} variant="sheet" onClose={() => setOpenItem(null)} now={now} />
      )}

      {openBot && (
        <ThreadPanel bot={openBot} member={findBot(crew, openBot)} onClose={() => setOpenBot(null)} now={now} focusComposer={compose} />
      )}
    </AppShell>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span
      data-count
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-well px-1.5 text-[11.5px] font-semibold text-soft"
    >
      {n}
    </span>
  );
}
