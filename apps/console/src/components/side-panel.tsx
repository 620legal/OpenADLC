'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, NeedsYouIcon, PlayIcon } from '@/components/icons';
import { ItemView } from '@/components/item-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useViewerIdentity } from '@/components/viewer';
import type { AttentionItem, PanelRead, PanelRecent, PanelRunning } from '@/lib/api';
import { groupOf } from '@/lib/attention-card';
import { cn } from '@/lib/cn';
import { refreshWhileVisible } from '@/lib/live-refresh';
import {
  badge,
  needsYouRows,
  PANEL_EVERY_MS,
  PANEL_MEDIA,
  panelCounts,
  SIDE_PANEL_CHANGED,
  sidePanelKey,
  storedSidePanelOpen,
  storeSidePanelOpen,
  type SidePanelChange,
} from '@/lib/side-panel';
import { ago, duration, money } from '@/lib/when';

export type PanelTab = 'needs-you' | 'running' | 'recent';

const STATE_WORDS: Record<PanelRunning['state'], string> = {
  working: 'working',
  waiting: 'waiting on a person',
  paused: 'paused',
};

const OUTCOME_WORDS: Record<PanelRecent['outcome'], string> = {
  done: 'finished',
  failed: 'failed',
  stopped: 'stopped',
};

/** Spend as a row says it: "est." on a subscription seat's, which is an estimate (ADR 0050). */
function spend(costUsd: number, billed: boolean): string {
  return billed ? money(costUsd) : `${money(costUsd)} est.`;
}

/** Whether the panel's width is on screen; a browser with no `matchMedia` is taken as wide. */
function wideQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PANEL_MEDIA) : null;
}

/**
 * The crew panel beside every page (ADR 0085): Needs you, Running and Recent,
 * or, collapsed, a rail with the Needs you and Running counts. The root
 * layout draws it, so it keeps its tab, its sheet and what it read from page
 * to page.
 *
 * Below `md` it is hidden by its class alone, so the server's drawing and the
 * browser's agree and the phone layout and the installed app are unchanged,
 * and it does not poll there. Until its first answer, and whenever the bridge
 * sent no panel data (it did not answer, or is older than the panel), it
 * draws nothing: the page is as it was, with no error. A later poll that
 * fails keeps what it last drew.
 */
export function SidePanel({ initial = null }: { /** What was already read; the layout passes none, and the panel draws nothing until its first poll. */ initial?: PanelRead | null } = {}) {
  const identity = useViewerIdentity();
  const [read, setRead] = useState<PanelRead | null>(initial);
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>('needs-you');
  const [sheet, setSheet] = useState<{ subject: string; role: string | null } | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const reading = useRef(false);

  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const response = await fetch('/api/panel', { cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json().catch(() => null)) as Partial<PanelRead> | null;
      if (!body) return;
      setNow(new Date().toISOString());
      // A part that could not be read this time keeps what was last read of it.
      setRead((previous) => ({ tasks: body.tasks ?? previous?.tasks ?? null, attention: body.attention ?? previous?.attention ?? null }));
    } catch {
      // The console's own server not answering: the panel keeps what it drew.
    } finally {
      reading.current = false;
    }
  }, []);

  // Polled only while the page is on screen and wide enough to show the panel.
  useEffect(() => {
    const query = wideQuery();
    let stop: (() => void) | null = null;
    const follow = () => {
      const wide = query?.matches ?? true;
      if (wide && !stop) {
        void load();
        stop = refreshWhileVisible(() => void load(), document, { every: PANEL_EVERY_MS });
      } else if (!wide && stop) {
        stop();
        stop = null;
      }
    };
    follow();
    query?.addEventListener('change', follow);
    return () => {
      query?.removeEventListener('change', follow);
      stop?.();
    };
  }, [load]);

  // Open or collapsed, this person's choice in this browser: read after mount, since the server cannot know it.
  useEffect(() => {
    setOpen(storedSidePanelOpen(identity));
    if (identity === null) return;
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<SidePanelChange>).detail;
      if (change && change.identity === identity) setOpen(change.open);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === sidePanelKey(identity)) setOpen(storedSidePanelOpen(identity));
    };
    window.addEventListener(SIDE_PANEL_CHANGED, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SIDE_PANEL_CHANGED, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [identity]);

  const choose = (next: boolean) => {
    setOpen(next);
    storeSidePanelOpen(identity, next);
  };

  if (!read?.tasks) return null;
  const tasks = read.tasks;
  const counts = panelCounts(read);
  const needsYou = read.attention ? needsYouRows(read.attention) : [];
  const openSubject = (subject: string, role: string | null = null) => setSheet({ subject, role });

  return (
    <>
      <aside
        aria-label="Crew panel"
        data-side-panel={open ? 'open' : 'collapsed'}
        className={cn('sticky top-0 hidden h-dvh shrink-0 flex-col border-l border-edge bg-panel md:flex', open ? 'w-80' : 'w-12')}
      >
        {open ? (
          <Tabs value={tab} onValueChange={(value) => setTab(value as PanelTab)} className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3">
              <TabsList aria-label="Crew panel" className="min-w-0 flex-1 gap-3">
                <TabsTrigger value="needs-you">Needs you ({counts.needsYou})</TabsTrigger>
                <TabsTrigger value="running">Running ({counts.running})</TabsTrigger>
                <TabsTrigger value="recent">Recent</TabsTrigger>
              </TabsList>
              <button
                type="button"
                aria-expanded
                aria-label="Collapse the crew panel"
                onClick={() => choose(false)}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-well hover:text-body focus-visible:outline-2 focus-visible:outline-link"
              >
                <ChevronRightIcon className="size-4" />
              </button>
            </div>
            <TabsContent value="needs-you" className="min-h-0 flex-1 overflow-y-auto">
              <Rows empty="Nothing needs you">
                {needsYou.map((item) => (
                  <NeedsYouRow key={item.id} item={item} onOpen={openSubject} />
                ))}
              </Rows>
            </TabsContent>
            <TabsContent value="running" className="min-h-0 flex-1 overflow-y-auto">
              <Rows empty="Nothing running">
                {tasks.running.map((row) => (
                  <TaskRow
                    key={row.id}
                    row={row}
                    onOpen={openSubject}
                    status={[STATE_WORDS[row.state], duration(row.since, now), spend(row.costUsd, row.billed)]}
                  />
                ))}
              </Rows>
            </TabsContent>
            <TabsContent value="recent" className="min-h-0 flex-1 overflow-y-auto">
              <Rows empty="Nothing finished in the last 24 hours">
                {tasks.recent.map((row) => (
                  <TaskRow key={row.id} row={row} onOpen={openSubject} status={[OUTCOME_WORDS[row.outcome], ago(row.endedAt, now), spend(row.costUsd, row.billed)]} />
                ))}
              </Rows>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-col items-center gap-2 py-3">
            <button
              type="button"
              aria-expanded={false}
              aria-label="Open the crew panel"
              onClick={() => choose(true)}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-well hover:text-body focus-visible:outline-2 focus-visible:outline-link"
            >
              <ChevronLeftIcon className="size-4" />
            </button>
            <RailButton
              label={`Needs you: ${counts.needsYou}`}
              count={counts.needsYou}
              tone="attention"
              onClick={() => {
                setTab('needs-you');
                choose(true);
              }}
            >
              <NeedsYouIcon className="size-4" />
            </RailButton>
            <RailButton
              label={`Running: ${counts.running}`}
              count={counts.running}
              tone="signal"
              onClick={() => {
                setTab('running');
                choose(true);
              }}
            >
              <PlayIcon className="size-4" />
            </RailButton>
          </div>
        )}
      </aside>
      {sheet && <ItemView key={sheet.subject} subject={sheet.subject} initialRole={sheet.role} variant="sheet" onClose={() => setSheet(null)} now={now} />}
    </>
  );
}

function RailButton({ label, count, tone, onClick, children }: { label: string; count: number; tone: 'attention' | 'signal'; onClick: () => void; children: ReactNode }) {
  const shown = badge(count);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="relative inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-well hover:text-body focus-visible:outline-2 focus-visible:outline-link"
    >
      {children}
      {shown && (
        <span
          data-badge
          aria-hidden
          className={cn(
            'absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4',
            tone === 'attention' ? 'bg-attention text-surface' : 'bg-signal text-surface',
          )}
        >
          {shown}
        </span>
      )}
    </button>
  );
}

function Rows({ empty, children }: { empty: string; children: ReactNode[] }) {
  if (children.length === 0) return <p className="px-3 py-4 text-[12.5px] text-dim">{empty}</p>;
  return <ul className="divide-y divide-edge">{children}</ul>;
}

const ROW = 'block w-full px-3 py-2.5 text-left';
const ROW_HOVER = 'hover:bg-well focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-link';

function TaskRow({ row, status, onOpen }: { row: PanelRunning | PanelRecent; status: (string | null)[]; onOpen: (subject: string) => void }) {
  const body = (
    <>
      <span className="block text-[11.5px] text-muted">
        {row.bot}
        {row.repo ? ` · ${row.repo}` : ''}
      </span>
      <span className="block truncate text-[13px] text-body">{row.title ?? row.subject}</span>
      <span className="block text-[11.5px] text-soft">{status.filter(Boolean).join(' · ')}</span>
    </>
  );
  const opens = row.opens;
  return (
    <li data-task={row.id}>
      {opens ? (
        <button type="button" onClick={() => onOpen(opens)} className={cn(ROW, ROW_HOVER)}>
          {body}
        </button>
      ) : (
        <div className={ROW}>{body}</div>
      )}
    </li>
  );
}

function NeedsYouRow({ item, onOpen }: { item: AttentionItem; onOpen: (subject: string, role: string | null) => void }) {
  const body = (
    <>
      <span className="block text-[13px] text-body">{item.headline}</span>
      {item.subject.repo && <span className="block text-[11.5px] text-muted">{item.subject.repo}</span>}
    </>
  );
  const work = groupOf(item) === 'work';
  const subject = work ? (item.subject.item ?? null) : null;
  return (
    <li data-attention={item.id}>
      {subject ? (
        <button type="button" onClick={() => onOpen(subject, item.bot?.role ?? null)} className={cn(ROW, ROW_HOVER)}>
          {body}
        </button>
      ) : !work ? (
        <Link href="/needs-you?tab=system" className={cn(ROW, ROW_HOVER)}>
          {body}
        </Link>
      ) : (
        <div className={ROW}>{body}</div>
      )}
    </li>
  );
}
