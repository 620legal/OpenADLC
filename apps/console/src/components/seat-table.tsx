'use client';

import Link from 'next/link';
import type { MouseEvent } from 'react';
import { useRole } from '@/components/app-header';
import { BotAvatar } from '@/components/avatar';
import { RepoBadge } from '@/components/repo-badge';
import { HealthDot, ModelChoice, PauseControl, reconnectLink, SeatResults, StatusPill, TasksAtOnce, type SeatOpener } from '@/components/seat-controls';
import { itemOnBoard } from '@/components/needs-you';
import type { CrewMember, ModelAccountRef } from '@/lib/api';
import { botLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import {
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
  taskItem,
  thinksWithNothing,
} from '@/lib/crew';
import type { AccountListing } from '@/lib/model-onboarding';

/** Whether a click landed on something of its own — a link, a button, a select — rather than on the row. */
export function onControl(event: MouseEvent): boolean {
  return Boolean((event.target as HTMLElement | null)?.closest?.('a, button, select, input, textarea, label, form'));
}

/**
 * Every seat as a row, for comparing them and changing them side by side:
 * what it is doing and has on, what it thinks with and how many tasks it runs
 * (both changed in place by an admin), the account it acts as, what it cost
 * and did last, whether it can work, and what can be done about it. Pressing a
 * row anywhere but on its controls opens the seat's panel.
 */
export function SeatTable({
  crew,
  accounts,
  listings,
  byBot,
  now,
  showRepo,
  onOpen,
}: {
  crew: readonly CrewMember[];
  accounts: readonly ModelAccountRef[];
  listings: Record<string, AccountListing> | null;
  byBot: readonly { bot: string; costUsd: number }[];
  now: string;
  showRepo: boolean;
  onOpen: SeatOpener;
}) {
  const admin = useRole() === 'admin';
  return (
    <div className="overflow-x-auto rounded-lg border border-edge bg-panel">
      <table className="w-full min-w-[1100px] border-collapse text-left text-[12.5px]" data-seat-table>
        <thead className="border-b border-edge text-[11.5px] uppercase tracking-[0.06em] text-dim">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">Seat</th>
            <th scope="col" className="px-3 py-2 font-semibold">Status</th>
            <th scope="col" className="px-3 py-2 font-semibold">Now</th>
            <th scope="col" className="px-3 py-2 font-semibold">Model</th>
            <th scope="col" className="px-3 py-2 font-semibold">Tasks at once</th>
            <th scope="col" className="px-3 py-2 font-semibold">GitHub account</th>
            <th scope="col" className="px-3 py-2 font-semibold">Cost · last result</th>
            <th scope="col" className="px-3 py-2 font-semibold">Health</th>
            <th scope="col" className="px-3 py-2 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {inPipelineOrder(crew).map((bot) => {
            const label = botLabel(bot);
            const name = label.handle ?? roleTitle(bot);
            const state = crewState(bot);
            const health = seatHealth(bot);
            const fix = state === 'not-connected' ? null : reconnectLink(health);
            const current = bot.task ? taskItem(bot.task) : null;
            const repo = showRepo ? nowRepo(bot) : null;
            const queue = queueLine(bot.queue);
            const sharing = sharesAccountWith(bot, crew);
            return (
              <tr
                key={bot.name}
                data-seat-row={bot.name}
                onClick={(event) => {
                  if (!onControl(event)) onOpen(bot.name);
                }}
                className={cn('cursor-pointer border-b border-edge align-top last:border-b-0 hover:bg-well/40', bot.seatPaused && 'opacity-70')}
              >
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <BotAvatar bot={bot} size="md" working={state === 'working'} />
                    <div className="flex min-w-0 flex-col">
                      <button type="button" onClick={() => onOpen(bot.name)} className="truncate text-left font-semibold text-body hover:underline" title={label.text}>
                        {name}
                      </button>
                      <span className="text-[11.5px] text-muted">{label.handle ? roleTitle(bot) : 'not connected yet'}</span>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill bot={bot} now={now} />
                </td>
                <td className="max-w-[240px] px-3 py-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-soft">
                    {repo && <RepoBadge name={repo} />}
                    {current ? (
                      <Link href={itemOnBoard(current, bot.role)} className="hover:text-link hover:underline">
                        {nowLine(bot, now)}
                      </Link>
                    ) : (
                      <span>{nowLine(bot, now)}</span>
                    )}
                  </div>
                  {queue && <div className="mt-0.5 text-[11.5px] text-dim">{queue}</div>}
                </td>
                {/* Wide enough to read "Newest Sonnet · Anthropic": cut to "Newest Son…" it said nothing. */}
                <td className="min-w-[210px] px-3 py-2.5">
                  <ModelChoice bot={bot} accounts={accounts} listings={listings} />
                </td>
                <td className="px-3 py-2.5">
                  <TasksAtOnce bot={bot} accounts={accounts} />
                </td>
                <td className="px-3 py-2.5">
                  {bot.githubLogin ? (
                    <span className="flex flex-col">
                      {/* One line, cut with the whole login on hover: broken mid-word it took three lines. */}
                      <span className="max-w-[170px] truncate whitespace-nowrap font-mono text-[12px] text-soft" title={`@${bot.githubLogin}`}>
                        @{bot.githubLogin}
                      </span>
                      {sharing > 0 && <span className="text-[11.5px] text-dim">shared with {sharing}</span>}
                    </span>
                  ) : (
                    <span className="text-dim">none yet</span>
                  )}
                </td>
                <td className="max-w-[260px] px-3 py-2.5">
                  <div className="text-soft">{monthLine(bot, byBot)}</div>
                  {!thinksWithNothing(bot) && (
                    <div className="mt-0.5 text-[12px]">
                      <SeatResults bot={bot} results={recentResults(bot, 1)} now={now} />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <HealthDot health={health} />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-col items-start gap-1 whitespace-nowrap">
                    {state === 'working' && (
                      <button type="button" onClick={() => onOpen(bot.name, 'computer')} className="text-link hover:underline">
                        Watch it work
                      </button>
                    )}
                    {state === 'not-connected' && admin && (
                      <Link href="/onboarding?step=github-accounts" className="text-link hover:underline">
                        Connect its account
                      </Link>
                    )}
                    {fix && admin && (
                      <Link href={fix.href} className="text-alarm hover:underline">
                        {fix.label}
                      </Link>
                    )}
                    {admin && !thinksWithNothing(bot) && (
                      <button type="button" onClick={() => onOpen(bot.name, 'settings')} className="text-link hover:underline">
                        Change model
                      </button>
                    )}
                    <PauseControl bot={bot} now={now} compact />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
