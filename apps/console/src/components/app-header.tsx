'use client';

import Link from 'next/link';
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CommandPalette } from '@/components/command-palette';
import { IntakeDialog } from '@/components/intake-dialog';
import { KeysHelp } from '@/components/keys-help';
import {
  BoardIcon,
  CheckIcon,
  ChevronDownIcon,
  CostsIcon,
  CrewIcon,
  InsightsIcon,
  MoreIcon,
  NeedsYouIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  ShipIcon,
} from '@/components/icons';
import { LiveRefresh } from '@/components/live-refresh';
import { AlertsMenu, NeedsYouAlerts } from '@/components/needs-you-alerts';
import { RepoColorsProvider, RepoDot } from '@/components/repo-badge';
import { labelIn } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { crewLine, needsYouLine } from '@/lib/crew';
import type { Brand, Role } from '@/lib/api';
import { boardHref, navFor, pinnedNav, spendLevel, type HeaderData, type NavPage, type Page } from '@/lib/header';
import { NAV_PIN_DEFAULTS, onPinsChange, pin, storedPins, unpin } from '@/lib/nav-pins';
import type { RepoColorMap } from '@/lib/repo-colors';
import { consoleName } from '@/lib/needs-you-alerts';
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

/**
 * The console's name and logo, read by the root layout once per page, for
 * everyone. Nothing, when nothing says otherwise — a bridge that did not
 * answer, a component drawn in a test — is the header as it always was.
 */
const BrandContext = createContext<Brand>({ name: null, logoUrl: null });

export function BrandProvider({ brand, children }: { brand: Brand; children: ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}

/**
 * The top left of both headers: the logo, when one is set, and the name.
 *
 * The logo is only ever an `<img>`, which never runs a script whatever an SVG
 * holds, held to the row's height and never stretched. It is decorative: the
 * link's text is the name, so a screen reader hears it once. The name is
 * text, never markup, and cut short with an ellipsis rather than pushing the
 * wide header onto a second line at 768px.
 */
function BrandMark({ compact = false }: { compact?: boolean }) {
  const { name, logoUrl } = useBrand();
  const shown = consoleName({ name });
  return (
    <>
      {logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- next/image would fetch it through its optimiser, which does not take an SVG
        <img data-brand-logo src={logoUrl} alt="" className="h-7 w-auto max-w-[7rem] shrink-0 object-contain" />
      )}
      <span data-brand-name title={name ?? undefined} className={cn('truncate', compact ? 'max-w-[11rem]' : 'max-w-[9rem] lg:max-w-[14rem]')}>
        {shown}
      </span>
    </>
  );
}

/**
 * The pages this browser pinned (`nav-pins.ts`). The defaults first, then
 * what storage holds once mounted: the server has no storage and draws the
 * defaults, so a first client drawing that read it would not match what the
 * server sent. Every change after, in this tab or another, is followed.
 */
function usePins(): readonly Page[] {
  const [pins, setPins] = useState<readonly Page[]>(NAV_PIN_DEFAULTS);
  useEffect(() => {
    const follow = () => setPins(storedPins());
    follow();
    return onPinsChange(follow);
  }, []);
  return pins;
}

/**
 * Every page this person may see (`navFor`), each with its pin, behind a
 * button named More, with a search box over them. Built like the repository
 * switcher: a button that opens a list, Escape or a click anywhere else
 * closing it, and every control a native button, input or link, so a
 * keyboard and a screen reader already know them. A toggle leaves the list
 * open, to pin several in a row; following a link closes it.
 *
 * The wide header opens it below its button; the phone's bar opens it above.
 */
function MoreMenu({
  pages,
  pins,
  page,
  repo,
  compact = false,
}: {
  pages: readonly NavPage[];
  pins: readonly Page[];
  page: Page;
  repo: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panel = useId();

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
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

  const q = query.trim().toLowerCase();
  const found = q ? pages.filter((one) => one.label.toLowerCase().includes(q)) : pages;
  // Where the person is, when that page is not in the bar beside it.
  const here = pages.some((one) => one.page === page) && !pins.includes(page);

  return (
    <div ref={root} className={cn('relative', compact && 'flex w-16 shrink-0')}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => {
          setQuery('');
          setOpen((shown) => !shown);
        }}
        className={cn(
          'focus-visible:outline-2 focus-visible:outline-link',
          compact
            ? cn('flex flex-1 flex-col items-center justify-center gap-[3px] text-[11px]', here || open ? 'font-medium text-body' : 'text-muted')
            : cn(
                'flex h-8 items-center gap-1 rounded-md px-2 text-[13px] transition-colors lg:px-2.5 xl:px-3',
                here ? 'bg-well font-medium text-body' : 'text-muted hover:text-body',
              ),
        )}
      >
        {compact && <MoreIcon size={20} />}
        More
        {!compact && <ChevronDownIcon className="shrink-0" />}
      </button>
      <div
        id={panel}
        hidden={!open}
        className={cn(
          'absolute z-40 w-[15rem] max-w-[calc(100vw-1rem)] rounded-lg border border-edge-strong bg-panel p-1 shadow-xl',
          compact ? 'bottom-full right-1 mb-1' : 'left-0 top-full mt-1',
        )}
      >
        <input
          ref={search}
          type="search"
          aria-label="Find a page"
          placeholder="Find a page"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mb-1 h-11 w-full rounded-md border border-edge bg-surface px-2.5 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link md:h-8 md:text-[12.5px]"
        />
        {found.length === 0 ? (
          <p className="px-2.5 py-2 text-[12.5px] text-muted">No page matches</p>
        ) : (
          <ul aria-label="Pages">
            {found.map((one) => {
              const pinned = pins.includes(one.page);
              const current = one.page === page;
              return (
                <li key={one.page} className="flex items-center gap-1">
                  <Link
                    href={one.href(repo)}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'block h-11 min-w-0 flex-1 truncate rounded-md px-2.5 text-[13px] leading-[2.75rem] focus-visible:outline-2 focus-visible:outline-link md:h-8 md:text-[12.5px] md:leading-8',
                      current ? 'bg-well font-medium text-body' : 'text-soft hover:bg-well hover:text-body',
                    )}
                  >
                    {one.label}
                  </Link>
                  <button
                    type="button"
                    aria-pressed={pinned}
                    aria-label={`${pinned ? 'Unpin' : 'Pin'} ${one.label}`}
                    title={pinned ? 'Unpin from the navigation' : 'Pin to the navigation'}
                    onClick={() => (pinned ? unpin(one.page) : pin(one.page))}
                    className={cn(
                      'flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-link md:size-8',
                      pinned ? 'text-body' : 'text-dim hover:text-soft',
                    )}
                  >
                    <PinIcon size={14} className={pinned ? undefined : 'opacity-60'} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
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
 * From 768px up it is one row, and nothing in it wraps: at 800px the badge
 * of what needs you broke into four lines inside its pill, "New request"
 * into two, and the row ran past the window. Each part keeps its words on
 * one line and its width; the gaps and the links' padding are tighter until
 * 1280px, the button says "New" until 1024px, and the repository's name is
 * what gives way, cut short with an ellipsis. Below 768px it is two rows with
 * touch-sized controls, the second wrapping between its parts, never inside
 * one, and the page's own navigation moves to a bar at the bottom
 * (`BottomNav`).
 */
export function AppHeader({ page, repo = 'all', data }: { page: Page; repo?: string; data: HeaderData }) {
  const labelOf = (name: string) => labelIn(data.crew, name);
  // Every item is on its own page now; the board shows only the few most pressing.
  const needsHref = '/needs-you';
  const working = data.counts.working > 0;
  const ready = data.counts.total > 0 && data.counts.connected === data.counts.total;
  const pages = navFor(useRole());
  const pins = usePins();
  const nav = pinnedNav(pages, pins);

  return (
    <>
      <header data-wide-header className="hidden h-14 shrink-0 items-center gap-3 whitespace-nowrap border-b border-edge bg-panel px-4 md:flex lg:gap-4 xl:gap-6 xl:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link href={boardHref(repo)} className="flex min-w-0 shrink items-center gap-2 text-[15px] font-semibold tracking-tight text-body">
            <BrandMark />
          </Link>
          <RepoSwitcher repos={data.repos} colors={data.repoColors} current={repo} />
        </div>

        {/* The pinned links scroll inside their row rather than push the right side off at 768px; More sits outside it, so its list is not clipped. */}
        <nav aria-label="Console" className="flex min-w-0 items-center gap-0.5">
          <div data-pinned className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {nav.map((item) => (
              <Link
                key={item.page}
                href={item.href(repo)}
                aria-current={item.page === page ? 'page' : undefined}
                className={cn(
                  'flex h-8 shrink-0 items-center rounded-md px-2 text-[13px] transition-colors lg:px-2.5 xl:px-3',
                  item.page === page ? 'bg-well font-medium text-body' : 'text-muted hover:text-body',
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <MoreMenu pages={pages} pins={pins} page={page} repo={repo} />
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2.5 lg:gap-3 xl:gap-[18px]">
          <span className="hidden items-center gap-[7px] text-[12.5px] text-soft xl:flex">
            <StatusDot working={working} ready={ready} />
            {crewLine(data.counts)}
          </span>
          {data.spend && <Spend spend={data.spend} />}
          {/* Every role's, unlike Settings: how this browser says something waits. */}
          <AlertsMenu />
          {data.needsYou !== null && <NeedsChip count={data.needsYou} split={data.needsSplit} href={needsHref} />}
          <IntakeDialog repos={data.repos} labelOf={labelOf}>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-body px-3 text-[13px] font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
            >
              <PlusIcon />
              {/* Said in full to a screen reader whatever the width. */}
              New<span className="sr-only lg:not-sr-only"> request</span>
            </button>
          </IntakeDialog>
        </div>
      </header>

      <header className="shrink-0 border-b border-edge bg-panel px-4 py-2.5 md:hidden">
        <div className="flex items-center gap-2.5">
          <Link href={boardHref(repo)} className="flex min-w-0 shrink items-center gap-2 text-base font-semibold tracking-tight text-body">
            <BrandMark compact />
          </Link>
          <RepoSwitcher repos={data.repos} colors={data.repoColors} current={repo} compact />
          <div className="ml-auto shrink-0">
            <AlertsMenu compact />
          </div>
          <IntakeDialog repos={data.repos} labelOf={labelOf}>
            <button
              type="button"
              className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-body px-3.5 text-sm font-medium text-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
            >
              <PlusIcon size={15} />
              New
            </button>
          </IntakeDialog>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-[7px] whitespace-nowrap text-[12.5px] text-muted">
          <StatusDot working={working} ready={ready} />
          <span>{crewLine(data.counts)}</span>
          {data.spend && (
            <span>
              · {money(data.spend.spentUsd, { whole: data.spend.spentUsd === 0 })} of {money(data.spend.capUsd, { whole: true })}
              {data.spend.estimateUsd ? <Estimate usd={data.spend.estimateUsd} /> : null}
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

/**
 * What runs on subscriptions would have cost, beside billed spend: never part
 * of it, and never drawn on the cap's bar
 * (docs/adr/0050-a-subscription-run-is-estimated-not-billed.md).
 */
function Estimate({ usd }: { usd: number }) {
  return <span title="estimated on subscriptions, not billed"> · {money(usd)} est.</span>;
}

function Spend({ spend }: { spend: NonNullable<HeaderData['spend']> }) {
  const { percent, width, tone } = spendLevel(spend);
  return (
    <span
      className="hidden items-center gap-2 text-[12.5px] text-soft lg:flex"
      title={`${percent.toFixed(1)} percent of this month's cap`}
    >
      <span>
        {money(spend.spentUsd, { whole: spend.spentUsd === 0 })} of {money(spend.capUsd, { whole: true })}
        {spend.estimateUsd ? <Estimate usd={spend.estimateUsd} /> : null}
      </span>
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
        // Held to its box, so a narrow header cuts the name short rather than
        // drawing the button over the navigation beside it.
        className={cn(
          'flex min-w-0 max-w-full items-center gap-1.5 text-soft focus-visible:outline-2 focus-visible:outline-link',
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

// Every page in `PAGES`, since any of them may be pinned to the phone's bar.
const NAV_ICONS: Record<Page, (props: { size?: number }) => ReactNode> = {
  board: BoardIcon,
  'needs-you': NeedsYouIcon,
  crew: CrewIcon,
  costs: CostsIcon,
  insights: InsightsIcon,
  releases: ShipIcon,
  settings: SettingsIcon,
};

/**
 * The phone's navigation, at the bottom where a thumb is. Not fixed: it is the
 * last thing in the page's column, so it cannot sit over anything that scrolls.
 *
 * It shows the same pinned pages as the wide header, then More, which opens
 * the same list above the bar. The pinned cells share the width and scroll
 * rather than crush once there are more than fit (seven and More at 320px);
 * More stays outside that row, always in reach.
 */
export function BottomNav({ page, repo = 'all', className }: { page: Page; repo?: string; className?: string }) {
  const pages = navFor(useRole());
  const pins = usePins();
  const nav = pinnedNav(pages, pins);
  return (
    <nav aria-label="Console" className={cn('flex h-16 shrink-0 border-t border-edge bg-panel md:hidden', className)}>
      <div data-pinned className="flex min-w-0 flex-1 overflow-x-auto">
        {nav.map((item) => {
          const Icon = NAV_ICONS[item.page];
          const current = item.page === page;
          return (
            <Link
              key={item.page}
              href={item.href(repo)}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'flex min-w-[4rem] flex-1 flex-col items-center justify-center gap-[3px] whitespace-nowrap text-[11px]',
                current ? 'font-medium text-body' : 'text-muted',
              )}
            >
              <Icon size={20} />
              {item.label}
            </Link>
          );
        })}
      </div>
      <MoreMenu pages={pages} pins={pins} page={page} repo={repo} compact />
    </nav>
  );
}

/**
 * A page with the header on top and, on a phone, the navigation at the bottom.
 * `fill` is for the board, which scrolls inside itself; every other page
 * scrolls as a document and its bottom bar stays in reach while it does.
 *
 * Every page under it is read again on a timer, in the background too, so
 * what needs you and the header's chip are current on all of them, and the
 * tab's title and icon say so (`NeedsYouAlerts`).
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
        <NeedsYouAlerts data={data} />
        {/* Once per page, whatever renders the shell: each adds one listener for its key. */}
        <CommandPalette data={data} repo={repo} />
        <KeysHelp />
        <AppHeader page={page} repo={repo} data={data} />
        <div className={cn('flex-1', fill && 'flex min-h-0 flex-col')}>{children}</div>
        <BottomNav page={page} repo={repo} className={fill ? undefined : 'sticky bottom-0'} />
      </div>
    </RepoColorsProvider>
  );
}
