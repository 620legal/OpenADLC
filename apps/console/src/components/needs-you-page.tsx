'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { ItemView } from '@/components/item-view';
import { NEEDS_YOU_PAGE, NeedsList, OthersWaitingList, type CardKeys, type OpenBot, type OpenItem } from '@/components/needs-you';
import { ThreadPanel } from '@/components/thread-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AttentionItem, CrewMember } from '@/lib/api';
import { groupCounts, groupOf, othersWaiting, waiting as waitingOf, type AttentionGroup } from '@/lib/attention-card';
import { findBot } from '@/lib/bot-label';
import type { HeaderData } from '@/lib/header';
import { needsYouKey } from '@/lib/keys';

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
  item: linked = null,
}: {
  items: readonly AttentionItem[];
  crew: CrewMember[];
  header: HeaderData;
  now: string;
  /** From `?tab=`, so a link can open on System. */
  tab: AttentionGroup;
  /**
   * From `?item=`: a work item to open as its card would, which is where a
   * desktop notification about it leads. One that is not waiting work is
   * left alone, and the lists show as they always do.
   */
  item?: string | null;
}) {
  const router = useRouter();
  const linkedWork = linked ? items.find((one) => groupOf(one) === 'work' && one.kind !== 'check_fixed' && one.subject.item === linked) : undefined;
  const [tab, setTab] = useState<AttentionGroup>(linkedWork ? 'work' : initialTab);
  // `?tab=` says which list is open: a link to it while here switches, and a
  // switch is written back, so a reload or Back opens the same one.
  useEffect(() => setTab(linkedWork ? 'work' : initialTab), [initialTab, linkedWork]);
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
  const [openItem, setOpenItem] = useState<{ subject: string; role: string | null; linked?: boolean } | null>(null);
  const openWork: OpenItem = (item, role) => setOpenItem({ subject: item, role });
  // Opened once for the link, as its card would: a new `?item=` while here opens that one.
  useEffect(() => {
    if (linkedWork?.subject.item) setOpenItem({ subject: linkedWork.subject.item, role: linkedWork.bot?.role ?? null, linked: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the link, not every refresh of the same item
  }, [linked]);
  const closeItem = () => {
    // The link is spent: a reload or Back does not open the sheet again.
    if (openItem?.linked) router.replace(`${NEEDS_YOU_PAGE}?tab=work`, { scroll: false });
    setOpenItem(null);
  };
  const counts = groupCounts(items);
  const of = (group: AttentionGroup) => items.filter((item) => groupOf(item) === group);

  // The keys: j and k select within the open tab's list, in the order it is
  // drawn, and wrap nowhere; 1–9 and Enter act through the selected card's
  // own handlers. Only this page has them, not the board's few cards.
  const [selected, setSelected] = useState<string | null>(null);
  const cards = useRef(new Map<string, CardKeys>());
  const onCards = useCallback((id: string, keys: CardKeys | null) => {
    if (keys) cards.current.set(id, keys);
    else cards.current.delete(id);
  }, []);
  // Yours first, then Waiting on others under Work, as they are drawn.
  const ids = [...waitingOf(of(tab)), ...(tab === 'work' ? othersWaiting(of('work')) : [])].map((item) => item.id);
  const idsKey = ids.join('\n');
  // Where the selection was, so a card that goes on a refresh hands it to the one now in its place.
  const lastIndex = useRef(-1);
  if (selected && ids.includes(selected)) lastIndex.current = ids.indexOf(selected);
  useEffect(() => setSelected(null), [tab]);
  useEffect(() => {
    if (selected === null || ids.includes(selected)) return;
    setSelected(ids.length === 0 ? null : ids[Math.min(lastIndex.current, ids.length - 1)]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list's ids, not the array made each render
  }, [idsKey, selected]);
  // An item's sheet and a bot's thread are not dialogs to `needsYouKey`, and the keys are not theirs either.
  const covered = openItem !== null || openBot !== null;
  useEffect(() => {
    const list = idsKey ? idsKey.split('\n') : [];
    const onKey = (event: KeyboardEvent) => {
      if (covered) return;
      const key = needsYouKey(event);
      if (!key || list.length === 0) return;
      const at = selected ? list.indexOf(selected) : -1;
      if (key.kind === 'next') setSelected(at < 0 ? list[0]! : list[Math.min(at + 1, list.length - 1)]!);
      else if (key.kind === 'prev') setSelected(at < 0 ? list[0]! : list[Math.max(at - 1, 0)]!);
      else if (!selected) return;
      // A held number key repeats; one press is one answer.
      else if (key.kind === 'choose' && event.repeat) return;
      else if (key.kind === 'choose') cards.current.get(selected)?.choose(key.n);
      else cards.current.get(selected)?.open();
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idsKey, selected, covered]);

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
            <NeedsList
              items={of('work')}
              now={now}
              onOpenBot={openThread}
              onOpenItem={openWork}
              empty="Nothing from the crew waits on you."
              selected={tab === 'work' ? selected : null}
              onCards={onCards}
            />
            {/* Held approvals that are someone else's: shown, and counted nowhere (ADR 0058). */}
            <div className="pt-5 empty:hidden">
              <OthersWaitingList items={of('work')} now={now} onOpenBot={openThread} onOpenItem={openWork} selected={tab === 'work' ? selected : null} onCards={onCards} />
            </div>
          </TabsContent>
          <TabsContent value="system" className="pt-4">
            <NeedsList
              items={of('system')}
              now={now}
              onOpenBot={openThread}
              empty="Nothing about the install needs you."
              selected={tab === 'system' ? selected : null}
              onCards={onCards}
            />
          </TabsContent>
        </Tabs>
      </main>

      {openItem && (
        <ItemView key={openItem.subject} subject={openItem.subject} initialRole={openItem.role} variant="sheet" onClose={closeItem} now={now} />
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
