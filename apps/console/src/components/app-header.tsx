'use client';

import Link from 'next/link';
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IntakeDialog } from '@/components/intake-dialog';
import { BoardIcon, CheckIcon, ChevronDownIcon, CostsIcon, CrewIcon, InsightsIcon, PlusIcon, SettingsIcon } from '@/components/icons';
import { LiveRefresh } from '@/components/live-refresh';
import { RepoColorsProvider, RepoDot } from '@/components/repo-badge';
import { labelIn } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { crewLine, needsYouLine } from '@/lib/crew';
import type { Role } from '@/lib/api';
import { boardHref, NAV, spendLevel, type HeaderData, type Page } from '@/lib/header';
import type { RepoColorMap } from '@/lib/repo-colors';
import { money } from '@/lib/when';

/**
 * What the person looking may do, read from the bridge once per page by the
 * root layout. Only what is shown follows it: the bridge refuses a user's
 * request for an admin's route whatever the page offered. Admin when nothing
 * says otherwise — a bridge that did not answer, a component drawn in a test —
 * so nothing an admin needs goes missing on a bad read.
 */
const RoleContext = createContext<Role>('admin');

export function RoleProvider({ role, children }: { role: Role; children: ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useRole(): Role {
  return useContext(RoleContext);
}

/** The navigation this person has: Settings is an admin's. */
function useNav(): typeof NAV {
  const role = useRole();
  return role === 'admin' ? NAV : NAV.filter((item) => item.page !== 'settings');
}

/**
 * The top of every page but the walkthrough.
 *
 * It says four things and offers one: where you are, whether the crew is
 * working, what this month has cost against its cap, and whether anything is
 * waiting on you — and the button that starts a request. What used to be here
 * was a line of internals ("main · github is the system of record · host local
 * (docker)") and a chip that said "running unattended" whether or not anything
 * was, which told a person nothing they could act on.
 *
 * Below 768px it is two rows with touch-sized controls, and the page's own
 * navigation moves to a bar at the bottom (`BottomNav`).
 */
export function AppHeader({ page, repo = 'all', data }: { page: Page; repo?: string; data: HeaderData }) {
  const labelOf = (name: string) => labelIn(data.crew, name);
  // Every item is on its own page now; the board shows only the few most pressing.
  const needsHref = '/needs-you';
  const working = data.counts.working > 0;
  const ready = data.counts.total > 0 && data.counts.connected === data.counts.total;
  const nav = useNav();

  return (
    <>
      <header className="hidden h-14 shrink-0 items-center gap-6 border-b border-edge bg-panel px-6 md:flex">
        <div className="flex items-center gap-2.5">
          <Link href={boardHref(repo)} className="text-[15px] font-semibold tracking-tight text-body">
            OpenADLC
          </Link>
          <RepoSwitcher repos={data.repos} colors={data.repoColors} current={repo} />
        </div>

        <nav aria-label="Console" className="flex items-center gap-0.5">
          {nav.map((item) => (
            <Link
              key={item.page}
              href={item.href(repo)}
              aria-current={item.page === page ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center rounded-md px-3 text-[13px] transition-colors',
                item.page === page ? 'bg-well font-medium text-body' : 'text-muted hover:text-body',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-[18px]">
          <span className="hidden items-center gap-[7px] text-[12.5px] text-soft xl:flex">
            <StatusDot working={working} ready={ready} />
            {crewLine(data.counts)}
          </span>
          {data.spend && <Spend spend={data.spend} />}
          {data.needsYou !== null && <NeedsChip count={data.needsYou} split={data.needsSplit} href={needsHref} />}
          <IntakeDialog repos={data.repos} labelOf={labelOf} defaultRepo={repo}>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-body px-3 text-[13px] font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
            >
              <PlusIcon />
              New request
            </button>
          </IntakeDialog>
        </div>
      </header>

      <header className="shrink-0 border-b border-edge bg-panel px-4 py-2.5 md:hidden">
        <div className="flex items-center gap-2.5">
          <Link href={boardHref(repo)} className="text-base font-semibold tracking-tight text-body">
            OpenADLC
          </Link>
          <RepoSwitcher repos={data.repos} colors={data.repoColors} current={repo} compact />
          <IntakeDialog repos={data.repos} labelOf={labelOf} defaultRepo={repo}>
            <button
              type="button"
              className="ml-auto inline-flex h-11 items-center gap-1.5 rounded-lg bg-body px-3.5 text-sm font-medium text-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
            >
              <PlusIcon size={15} />
              New
            </button>
          </IntakeDialog>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-[7px] text-[12.5px] text-muted">
          <StatusDot working={working} ready={ready} />
          <span>{crewLine(data.counts)}</span>
          {data.spend && (
            <span>
              · {money(data.spend.spentUsd, { whole: data.spend.spentUsd === 0 })} of {money(data.spend.capUsd, { whole: true })}
            </span>
          )}
          {/* The board has its own row of what needs you right under this. */}
          {page !== 'board' && data.needsYou ? (
            <Link href={needsHref} className="font-medium text-attention">
              · {needsLine(data.needsYou, data.needsSplit)}
            </Link>
          ) : null}
        </p>
      </header>
    </>
  );
}

function StatusDot({ working, ready }: { working: boolean; ready: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        working ? 'working-dot bg-signal' : ready ? 'bg-signal' : 'bg-dim',
      )}
    />
  );
}

function Spend({ spend }: { spend: NonNullable<HeaderData['spend']> }) {
  const { percent, width, tone } = spendLevel(spend);
  return (
    <span
      className="hidden items-center gap-2 text-[12.5px] text-soft lg:flex"
      title={`${percent.toFixed(1)} percent of this month's cap`}
    >
      {money(spend.spentUsd, { whole: spend.spentUsd === 0 })} of {money(spend.capUsd, { whole: true })}
      <span className="block h-1 w-14 overflow-hidden rounded-full bg-well">
        <span
          className={cn(
            'block h-full rounded-full',
            tone === 'alarm' ? 'bg-alarm' : tone === 'attention' ? 'bg-attention' : 'bg-signal',
          )}
          // Never narrower than a sliver once anything is spent, or $7 of $1,500
          // draws as nothing at all.
          style={{ width: spend.spentUsd > 0 ? `max(2px, ${width}%)` : '0' }}
        />
      </span>
    </span>
  );
}

/**
 * The badge's words: how much work waits, and how much the install needs
 * beside it — "3 need you · 10 system" — so a dozen health checks do not
 * read as a dozen questions from the crew.
 */
export function needsLine(count: number, split: { work: number; system: number } | null): string {
  if (!split || split.system === 0) return needsYouLine(count);
  if (split.work === 0) return `${split.system} system`;
  return `${needsYouLine(split.work)} · ${split.system} system`;
}

function NeedsChip({ count, split, href }: { count: number; split: { work: number; system: number } | null; href: string }) {
  if (count <= 0) {
    // Still a link when nothing waits: what recovered is listed on that page, and nowhere else now.
    return (
      <Link
        href={href}
        className="flex h-[26px] items-center rounded-full border border-signal/30 bg-signal/10 px-2.5 text-[12px] font-medium text-signal transition-colors hover:bg-signal/20"
      >
        {needsYouLine(0)}
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className="flex h-[26px] items-center rounded-full border border-attention/35 bg-attention/12 px-2.5 text-[12px] font-medium text-attention transition-colors hover:bg-attention/20"
    >
      {needsLine(count, split)}
    </Link>
  );
}

/**
 * Which repository the board shows, each with its colour, and all of them at
 * once whenever there is more than one.
 *
 * It was a plain select, which a keyboard and a screen reader already know —
 * but an option cannot hold a coloured dot. So it is a button that opens a
 * list of links: Enter or a click opens it, Escape or a click anywhere else
 * closes it, and each entry is a link to that board, the one on screen marked.
 */
function RepoSwitcher({
  repos,
  colors,
  current,
  compact = false,
}: {
  repos: string[];
  colors: RepoColorMap;
  current: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (repos.length <= 1) {
    return (
      <span className={cn('truncate text-soft', compact ? 'text-[13px]' : 'rounded-md border border-edge px-2.5 py-1 text-[12.5px]')}>
        {repos[0] ?? 'No repository yet'}
      </span>
    );
  }

  const all = current === 'all' || !repos.includes(current);
  const everyColour = repos.map((name) => colors[name]);

  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => setOpen((shown) => !shown)}
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-soft focus-visible:outline-2 focus-visible:outline-link',
          compact
            ? 'h-11 pl-1.5 pr-1 text-[13px]'
            : 'h-7 rounded-md border border-edge bg-panel pl-2.5 pr-2 text-[12.5px] hover:border-edge-strong',
        )}
      >
        <span className="sr-only">Repository: </span>
        {all ? <EveryDot colors={everyColour} /> : <RepoDot color={colors[current]} />}
        <span className="truncate">{all ? 'All repositories' : current}</span>
        <ChevronDownIcon className="shrink-0 text-muted" />
      </button>
      <ul
        id={list}
        hidden={!open}
        aria-label="Repositories"
        className="absolute left-0 top-full z-40 mt-1 w-max min-w-[13rem] max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-edge-strong bg-panel p-1 shadow-xl"
      >
        <SwitcherItem href={boardHref('all')} current={all} label="All repositories" onPick={() => setOpen(false)}>
          <EveryDot colors={everyColour} />
        </SwitcherItem>
        {repos.map((name) => (
          <SwitcherItem key={name} href={boardHref(name)} current={!all && current === name} label={name} onPick={() => setOpen(false)}>
            <RepoDot color={colors[name]} />
          </SwitcherItem>
        ))}
      </ul>
    </div>
  );
}

/** Every repository at once: their colours side by side, the first three. */
function EveryDot({ colors }: { colors: (string | undefined)[] }) {
  return (
    <span aria-hidden className="flex shrink-0 gap-[3px]">
      {colors.slice(0, 3).map((color, index) => (
        <RepoDot key={index} color={color} className="size-1.5" />
      ))}
    </span>
  );
}

function SwitcherItem({
  href,
  current,
  label,
  onPick,
  children,
}: {
  href: string;
  current: boolean;
  label: string;
  onPick: () => void;
  /** Its colour, or every colour for all of them. */
  children: ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={current ? 'page' : undefined}
        onClick={onPick}
        className={cn(
          'flex h-11 items-center gap-2 rounded-md px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-link md:h-8 md:text-[12.5px]',
          current ? 'bg-well font-medium text-body' : 'text-soft hover:bg-well hover:text-body',
        )}
      >
        {children}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {current && <CheckIcon size={12} className="shrink-0 text-muted" />}
      </Link>
    </li>
  );
}

// Only the pages in the navigation: Needs you is reached from the header's badge.
const NAV_ICONS: Record<Exclude<Page, 'needs-you'>, (props: { size?: number }) => ReactNode> = {
  board: BoardIcon,
  crew: CrewIcon,
  costs: CostsIcon,
  insights: InsightsIcon,
  settings: SettingsIcon,
};

/**
 * The phone's navigation, at the bottom where a thumb is. Not fixed: it is the
 * last thing in the page's column, so it cannot sit over anything that scrolls.
 */
export function BottomNav({ page, repo = 'all', className }: { page: Page; repo?: string; className?: string }) {
  const nav = useNav();
  return (
    <nav
      aria-label="Console"
      className={cn('grid h-16 shrink-0 border-t border-edge bg-panel md:hidden', nav.length >= 5 ? 'grid-cols-5' : nav.length === 4 ? 'grid-cols-4' : 'grid-cols-3', className)}
    >
      {nav.map((item) => {
        const Icon = NAV_ICONS[item.page];
        const current = item.page === page;
        return (
          <Link
            key={item.page}
            href={item.href(repo)}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex flex-col items-center justify-center gap-[3px] text-[11px]',
              current ? 'font-medium text-body' : 'text-muted',
            )}
          >
            <Icon size={20} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A page with the header on top and, on a phone, the navigation at the bottom.
 * `fill` is for the board, which scrolls inside itself; every other page
 * scrolls as a document and its bottom bar stays in reach while it does.
 *
 * Every page under it is read again while it is on screen, so what needs you
 * and the header's chip are current on all of them.
 */
export function AppShell({
  page,
  repo = 'all',
  data,
  fill = false,
  children,
}: {
  page: Page;
  repo?: string;
  data: HeaderData;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <RepoColorsProvider colors={data.repoColors}>
      <div className={cn('flex flex-col', fill ? 'h-dvh' : 'min-h-dvh')}>
        <LiveRefresh />
        <AppHeader page={page} repo={repo} data={data} />
        <div className={cn('flex-1', fill && 'flex min-h-0 flex-col')}>{children}</div>
        <BottomNav page={page} repo={repo} className={fill ? undefined : 'sticky bottom-0'} />
      </div>
    </RepoColorsProvider>
  );
}
