'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppShell, useRole } from '@/components/app-header';
import { BotAvatar } from '@/components/avatar';
import { RepoBadge } from '@/components/repo-badge';
import { HealthDot, PauseControl, reconnectLink, SeatResults, seatTabs, StatusPill, TasksAtOnce, type SeatOpener } from '@/components/seat-controls';
import { onControl, SeatTable } from '@/components/seat-table';
import { ThreadPanel } from '@/components/thread-panel';
import type { CrewMember, ModelAccountRef } from '@/lib/api';
import { botLabel, findBot } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import {
  countWords,
  crewState,
  inPipelineOrder,
  monthLine,
  nowLine,
  nowRepo,
  queueLine,
  recentResults,
  roleTitle,
  seatHealth,
  sharesAccountWith,
  storeCrewLayout,
  storedCrewLayout,
  taskItem,
  thinksWith,
  thinksWithNothing,
  type CrewLayout,
} from '@/lib/crew';
import { itemOnBoard } from '@/components/needs-you';
import { listModelsFor, type AccountListing, type AccountRef } from '@/lib/model-onboarding';
import type { HeaderData } from '@/lib/header';

/**
 * Every seat, in the order a request meets them: who it is, what it is doing
 * and has on, what it did lately, what it thinks with, what it cost this month
 * and whether it can work. It replaces the strip of bots that ran along the
 * bottom of the board.
 *
 * Cards to glance at, or a table to compare and change, as each person last
 * chose. The cards are one grid: they were a section per role, every role has
 * one seat, and a grid per section held one card — three-across became a long
 * single column. The role is on each card instead.
 *
 * Pressing a seat, anywhere but on its controls, opens its panel: what it is
 * doing, its conversations, what it did, and its settings.
 */
export function CrewView({
  crew,
  accounts,
  byBot,
  header,
  now,
}: {
  crew: CrewMember[];
  accounts: readonly ModelAccountRef[];
  /** This month's spend by bot name, from the ledger. */
  byBot: readonly { bot: string; costUsd: number }[];
  header: HeaderData;
  now: string;
}) {
  const [open, setOpen] = useState<{ bot: string; tab: string } | null>(null);
  // Cards on the server; what this browser chose once it is read, so the first
  // drawing on the server and in the browser agree.
  const [layout, setLayout] = useState<CrewLayout>('cards');
  useEffect(() => setLayout(storedCrewLayout()), []);
  const admin = useRole() === 'admin';
  const [listings, setListings] = useState<Record<string, AccountListing> | null>(null);
  // What each account offers, read once and only where a model is chosen: the
  // table's rows and the panel's settings.
  const wanted = admin && (layout === 'table' || open !== null);
  useEffect(() => {
    if (!wanted || listings || accounts.length === 0) return;
    let live = true;
    void listModelsFor(accounts as unknown as readonly AccountRef[]).then((read) => {
      if (live) setListings(read);
    });
    return () => {
      live = false;
    };
  }, [wanted, listings, accounts]);

  const ordered = inPipelineOrder(crew);
  const unconnected = crew.filter((bot) => crewState(bot) === 'not-connected').length;
  // With one repository, every task is in it and a badge would say so each time.
  const showRepo = header.repos.length > 1;
  const choose = (next: CrewLayout): void => {
    setLayout(next);
    storeCrewLayout(next);
  };
  const openSeat: SeatOpener = (bot, tab) => {
    const member = findBot(crew, bot);
    // What it is doing is the first thing to see while it works.
    setOpen({ bot, tab: tab ?? (member && crewState(member) === 'working' ? 'computer' : 'chat') });
  };
  const member = open ? findBot(crew, open.bot) : undefined;

  return (
    <AppShell page="crew" data={header}>
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-[18px] px-4 py-6 md:px-6 md:py-7">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-body">Crew</h1>
            <p className="text-[13px] text-muted">
              {crew.length === 0
                ? 'No bots yet. The walkthrough seats the crew.'
                : `${countWords(crew.length, 'bot')}, one per seat. They pick up work by role, and several can share one GitHub account: each keeps its own work and conversations. Each works across your repositories, with a separate copy of each.`}
              {unconnected > 0 && (
                <>
                  {' '}
                  {unconnected === 1 ? 'One is' : `${countWords(unconnected, 'bot').replace(/ bots?$/, '')} are`} not connected yet.
                </>
              )}
            </p>
          </div>
          {crew.length > 0 && (
            <div role="group" aria-label="Show the crew as" className="flex shrink-0 overflow-hidden rounded-md border border-edge-strong text-[12.5px]">
              {(['cards', 'table'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={layout === value}
                  onClick={() => choose(value)}
                  className={cn('px-3 py-1', layout === value ? 'bg-body text-surface' : 'bg-panel text-soft hover:text-body')}
                >
                  {value === 'cards' ? 'Cards' : 'Table'}
                </button>
              ))}
            </div>
          )}
        </div>

        {layout === 'table' ? (
          <SeatTable crew={crew} accounts={accounts} listings={listings} byBot={byBot} now={now} showRepo={showRepo} onOpen={openSeat} />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-crew-grid>
            {ordered.map((bot) => (
              <CrewCard
                key={bot.name}
                bot={bot}
                accounts={accounts}
                byBot={byBot}
                now={now}
                showRepo={showRepo}
                sharing={sharesAccountWith(bot, crew)}
                onOpen={openSeat}
              />
            ))}
          </ul>
        )}
      </main>

      {open && (
        <ThreadPanel
          key={`${open.bot}:${open.tab}`}
          bot={open.bot}
          member={member}
          onClose={() => setOpen(null)}
          now={now}
          initialTab={open.tab}
          extraTabs={member ? seatTabs({ bot: member, accounts, listings, now }) : []}
        />
      )}
    </AppShell>
  );
}

function CrewCard({
  bot,
  accounts,
  byBot,
  now,
  showRepo,
  sharing = 0,
  onOpen,
}: {
  bot: CrewMember;
  accounts: readonly ModelAccountRef[];
  byBot: readonly { bot: string; costUsd: number }[];
  now: string;
  /** Whether "Now" says which repository, when OpenADLC works in more than one. */
  showRepo: boolean;
  /** How many other seats post as its GitHub account. */
  sharing?: number;
  onOpen: SeatOpener;
}) {
  const current = bot.task ? taskItem(bot.task) : null;
  const label = botLabel(bot);
  const repo = showRepo ? nowRepo(bot) : null;
  const state = crewState(bot);
  // The walkthrough is an admin's: it connects accounts and chooses models.
  const admin = useRole() === 'admin';
  const name = label.handle ?? roleTitle(bot);
  const thinks = !thinksWithNothing(bot);
  const health = seatHealth(bot);
  const fix = state === 'not-connected' ? null : reconnectLink(health);
  const queue = queueLine(bot.queue);
  const results = recentResults(bot);

  return (
    <li
      data-seat-card={bot.name}
      onClick={(event) => {
        if (!onControl(event)) onOpen(bot.name);
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-2.5 rounded-lg border border-edge bg-panel px-4 py-3.5 transition-colors hover:border-edge-strong',
        bot.seatPaused && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* No status dot on the avatar: the pill beside it says the same thing in words. The avatar still moves while the bot works. */}
        <BotAvatar bot={bot} size="lg" working={state === 'working'} />
        <div className="flex min-w-0 flex-col gap-px">
          {/* The way in from the keyboard; the rest of the card is for the pointer. */}
          <button type="button" onClick={() => onOpen(bot.name)} className="min-w-0 text-left hover:underline">
            <span className="block truncate text-sm font-semibold text-body" title={label.text}>
              {name}
            </span>
          </button>
          <span className="text-[12px] text-muted">{label.handle ? roleTitle(bot) : 'not connected yet'}</span>
          {sharing > 0 && bot.githubLogin && (
            <span data-shares className="text-[11.5px] text-dim">
              shares @{bot.githubLogin} with {sharing} other {sharing === 1 ? 'seat' : 'seats'}
            </span>
          )}
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <HealthDot health={health} />
          <StatusPill bot={bot} now={now} />
        </span>
      </div>

      <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-y-[5px] text-[12.5px]">
        <dt className="text-dim">Thinks with</dt>
        <dd className="text-soft">{thinksWith(bot, accounts)}</dd>
        <dt className="text-dim">Now</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-soft">
          {repo && <RepoBadge name={repo} />}
          {/* The task going now opens its work item, on this seat's role. */}
          {current ? (
            <Link href={itemOnBoard(current, bot.role)} className="hover:text-link hover:underline">
              {nowLine(bot, now)}
            </Link>
          ) : (
            <span>{nowLine(bot, now)}</span>
          )}
        </dd>
        {queue && thinks && (
          <>
            <dt className="text-dim">Has on</dt>
            <dd className="text-soft">{queue}</dd>
          </>
        )}
        {thinks && results.length > 0 && (
          <>
            <dt className="text-dim">Lately</dt>
            <dd className="min-w-0">
              <SeatResults bot={bot} results={results} now={now} />
            </dd>
          </>
        )}
        <dt className="text-dim">This month</dt>
        <dd className="text-soft">{monthLine(bot, byBot)}</dd>
        {thinks && (
          <>
            <dt className="text-dim">Tasks at once</dt>
            <dd className="min-w-0">
              <TasksAtOnce bot={bot} accounts={accounts} />
            </dd>
          </>
        )}
        {health.state !== 'ok' && (
          <>
            <dt className="text-dim">Needs</dt>
            <dd className={health.state === 'failing' ? 'text-alarm' : 'text-attention'}>{health.reasons.map((reason) => reason.title).join('; ')}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        {state === 'not-connected' && admin && (
          <>
            <Link href="/onboarding?step=github-accounts" className="text-link hover:underline">
              Connect its account
            </Link>
            <Dot />
          </>
        )}
        {fix && admin && (
          <>
            <Link href={fix.href} className="text-alarm hover:underline">
              {fix.label}
            </Link>
            <Dot />
          </>
        )}
        <button type="button" onClick={() => onOpen(bot.name, state === 'working' ? 'computer' : 'chat')} className="text-link hover:underline">
          {state === 'working' ? 'Watch it work' : state === 'waiting' ? 'Answer' : state === 'on-duty' ? 'See what it did' : 'Open thread'}
        </button>
        {thinks && admin && (
          <>
            <Dot />
            <button type="button" onClick={() => onOpen(bot.name, 'settings')} className="text-link hover:underline">
              Change model
            </button>
            <Dot />
            <PauseControl bot={bot} now={now} compact />
          </>
        )}
      </div>
    </li>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-edge-strong">
      ·
    </span>
  );
}
