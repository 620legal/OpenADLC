'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { pauseSeat, resumeSeat, setCrewAvatar, setCrewTasksAtOnce } from '@/app/actions';
import { useRole } from '@/components/app-header';
import { AvatarPicker } from '@/components/avatar';
import { SaveLine, useColors } from '@/components/color-choice';
import { modelOptions } from '@/components/crew-step';
import { itemOnBoard } from '@/components/needs-you';
import type { CrewMember, ModelAccountRef, SeatHealth, SeatResult } from '@/lib/api';
import { botLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import {
  crewState,
  MAX_TASKS_AT_ONCE,
  OUTCOME,
  type CrewState,
  pausedLine,
  recentResults,
  resultWords,
  roleTitle,
  sharesARefreshingLogin,
  tasksAtOnce,
  thinksWith,
  thinksWithNothing,
} from '@/lib/crew';
import { saveAssignment, type AccountListing, type AccountRef, type CrewBot } from '@/lib/model-onboarding';
import { safeAction } from '@/lib/safe-action';
import { ago, money } from '@/lib/when';

/**
 * The parts of a seat the crew page shows in three places — its card, its row
 * in the table and its panel — so a model chosen in one is the same control,
 * saved the same way, as in the others.
 */

/** Opens a seat's panel, on one of its tabs when the caller says which. */
export type SeatOpener = (bot: string, tab?: string) => void;

const PILL: Record<CrewState, { text: string; className: string; dot?: string }> = {
  working: { text: 'Working', className: 'bg-signal/12 text-signal', dot: 'bg-signal' },
  waiting: { text: 'Waiting for you', className: 'bg-attention/12 text-attention' },
  attention: { text: 'Needs you', className: 'bg-alarm/10 text-alarm' },
  idle: { text: 'Idle', className: 'bg-well text-soft' },
  'on-duty': { text: 'On duty', className: 'bg-well text-soft' },
  'not-connected': { text: 'Not connected', className: 'bg-attention/12 text-attention' },
};

/**
 * Where a seat stands, in a word. A paused seat says so first — who paused it
 * and why are its title — and what it is still finishing is under "Now".
 */
export function StatusPill({ bot, now }: { bot: CrewMember; now: string }) {
  const paused = bot.seatPaused ?? null;
  const pill = paused ? { text: 'Paused', className: 'bg-attention/12 text-attention' } : PILL[crewState(bot)];
  return (
    <span
      title={paused ? pausedLine(paused, now) : undefined}
      className={cn('inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap', pill.className)}
    >
      {'dot' in pill && pill.dot && <span aria-hidden className={cn('size-1.5 rounded-full', pill.dot)} />}
      {pill.text}
    </span>
  );
}

/** A seat as the model choice reads it: what it thinks with, on which account. */
function asCrewBot(bot: CrewMember): CrewBot {
  return {
    bot: bot.name,
    slot: bot.slot ?? undefined,
    role: bot.role,
    roleLabel: roleTitle(bot),
    engine: bot.engine as CrewBot['engine'],
    model: bot.model,
    modelAccountId: bot.modelAccountId ?? null,
    readiness: null,
  };
}

const keyOf = (accountId: string | null | undefined, model: string): string => (accountId && model ? `${accountId}|${model}` : '');

/**
 * What it thinks with, as a choice an admin changes in place: the newest of
 * each family its accounts follow, the same list the walkthrough's Crew step
 * offers. Until the accounts have said what they offer, the list is the one it
 * is on now. Anybody else reads it in words.
 */
export function ModelChoice({
  bot,
  accounts,
  listings,
}: {
  bot: CrewMember;
  accounts: readonly ModelAccountRef[];
  /** What each account offers, once read; null until then. */
  listings: Record<string, AccountListing> | null;
}) {
  const admin = useRole() === 'admin';
  const current = keyOf(bot.modelAccountId, bot.model);
  const { colors, saving, choose } = useColors({ model: current }, async (_key, value) => {
    const [accountId, ...model] = (value ?? '').split('|');
    const refusal = await saveAssignment(bot.name, { model: model.join('|'), modelAccountId: accountId || null }, () => undefined).catch((cause: unknown) =>
      cause instanceof Error ? cause.message : 'could not save',
    );
    return refusal ? { ok: false, error: refusal } : { ok: true };
  });

  if (thinksWithNothing(bot)) return <span className="text-soft">No model, by design</span>;
  if (!admin) return <span className="text-soft">{thinksWith(bot, accounts)}</span>;

  const options = listings ? modelOptions(asCrewBot(bot), accounts as unknown as AccountRef[], listings) : [];
  // What it is on is always a choice, read or not, so the select says it.
  if (current && !options.some((option) => option.key === current)) {
    options.unshift({ key: current, accountId: bot.modelAccountId ?? '', model: bot.model, label: thinksWith(bot, accounts) });
  }
  const name = botLabel(bot).handle ?? roleTitle(bot);

  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <select
        aria-label={`${name} model`}
        value={colors.model ?? ''}
        onChange={(event) => void choose('model', event.target.value)}
        className="w-full min-w-0 max-w-[280px] truncate rounded-md border border-edge-strong bg-panel px-2 py-0.5 text-[12.5px] text-body"
      >
        {!current && <option value="">No model chosen yet</option>}
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {saving.state !== 'idle' && <SaveLine saving={saving} />}
    </span>
  );
}

/** How many tasks it runs at once, each in a computer of its own: a choice for an admin, a number for anybody else. */
export function TasksAtOnce({ bot, accounts }: { bot: CrewMember; accounts: readonly ModelAccountRef[] }) {
  const admin = useRole() === 'admin';
  const { colors, saving, choose } = useColors({ tasks: String(tasksAtOnce(bot)) }, (_key, value) => setCrewTasksAtOnce(bot.name, Number(value)));
  const name = botLabel(bot).handle ?? roleTitle(bot);
  if (thinksWithNothing(bot)) return <span className="text-dim">—</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {/* Choosing is an admin's, as the bridge enforces. */}
      {admin ? (
        <select
          aria-label={`${name} tasks at once`}
          value={colors.tasks ?? '1'}
          onChange={(event) => void choose('tasks', event.target.value)}
          className="w-16 rounded-md border border-edge-strong bg-panel px-2 py-0.5 text-[12.5px] text-body"
        >
          {Array.from({ length: MAX_TASKS_AT_ONCE }, (_, index) => String(index + 1)).map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-soft">{tasksAtOnce(bot)}</span>
      )}
      {sharesARefreshingLogin(bot, accounts) && Number(colors.tasks ?? '1') > 1 && (
        <span className="text-[11.5px] text-attention">
          Keep this at 1: its OpenAI or xAI subscription keeps one sign-in that every task on it refreshes.
        </span>
      )}
      {saving.state !== 'idle' && <SaveLine saving={saving} />}
    </span>
  );
}

const HEALTH: Record<SeatHealth['state'], { className: string; words: string }> = {
  ok: { className: 'bg-signal', words: 'Can work' },
  warning: { className: 'bg-attention', words: 'Works, with something to look at' },
  failing: { className: 'bg-alarm', words: 'Cannot work' },
};

/** One dot for whether it can work; what is wrong is its title, so hovering says it. */
export function HealthDot({ health }: { health: SeatHealth }) {
  const said = [HEALTH[health.state].words, ...health.reasons.map((reason) => reason.title)].join(' — ');
  return (
    <span data-health={health.state} title={said} className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2 rounded-full', HEALTH[health.state].className)} />
      <span className="sr-only">{said}</span>
    </span>
  );
}

/**
 * The fix for a seat that cannot work, in the check's own words: "Let the crew
 * in" for a seat not in the repository yet, not "Reconnect account" for an
 * account that works. The bridge puts what stops the seat first.
 */
export function reconnectLink(health: SeatHealth): { label: string; href: string } | null {
  if (health.state !== 'failing') return null;
  const action = health.reasons.find((reason) => reason.action)?.action;
  if (!action) return null;
  return { label: action.label, href: action.href ?? action.url ?? '/?board=1#needs' };
}

/** What it finished lately: each with its mark, linking to its work item on the seat's role. */
export function SeatResults({ bot, results, now, withCost = false }: { bot: CrewMember; results: readonly SeatResult[]; now: string; withCost?: boolean }) {
  if (results.length === 0) return <span className="text-dim">Nothing finished yet</span>;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5" data-results>
      {results.map((result) => {
        const outcome = OUTCOME[result.outcome];
        const words = resultWords(result);
        const when = ago(result.at, now);
        return (
          <li key={`${result.ref}-${result.at}`} className="flex min-w-0 items-baseline gap-1.5">
            <span aria-label={outcome.words} title={outcome.words} className={cn('w-3 shrink-0 text-center', outcome.tone)}>
              {outcome.mark}
            </span>
            {result.item ? (
              <Link href={itemOnBoard(result.item, bot.role)} className="min-w-0 truncate text-soft hover:text-link hover:underline">
                {words}
              </Link>
            ) : (
              <span className="min-w-0 truncate text-soft">{words}</span>
            )}
            <span className="shrink-0 text-[11.5px] text-dim">
              {[when, withCost && typeof result.costUsd === 'number' ? money(result.costUsd) : null].filter(Boolean).join(' · ')}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Stops a seat taking new work, or lets it again: an admin's, as the bridge
 * enforces. Pausing asks why, which the card then says beside "Paused"; what
 * the seat is doing finishes either way.
 */
export function PauseControl({ bot, now, compact = false }: { bot: CrewMember; now: string; compact?: boolean }) {
  const admin = useRole() === 'admin';
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!admin || thinksWithNothing(bot)) return null;
  const name = botLabel(bot).handle ?? roleTitle(bot);

  const run = (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      // A call that fails outright is said here; inside the transition it took the page down.
      const result = await safeAction(work);
      if (!result.ok) setError(result.error ?? 'that did not go through');
      else {
        setAsking(false);
        setReason('');
      }
    });
  };

  if (bot.seatPaused) {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        {!compact && <span className="text-[12px] text-attention">{pausedLine(bot.seatPaused, now)}</span>}
        <button type="button" disabled={pending} onClick={() => run(() => resumeSeat(bot.name))} className="w-fit text-link hover:underline disabled:opacity-60">
          {pending ? 'Resuming…' : 'Resume'}
        </button>
        {error && <span className="text-[12px] text-alarm">{error}</span>}
      </span>
    );
  }

  if (!asking) {
    return (
      <span className="flex flex-col gap-1">
        <button type="button" onClick={() => setAsking(true)} className="w-fit text-link hover:underline">
          Pause this seat
        </button>
      </span>
    );
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => pauseSeat(bot.name, reason));
      }}
    >
      <label className="text-[12px] text-muted">
        Why pause {name}? <span className="text-dim">(optional)</span>
        <input
          autoFocus
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Changing its model"
          className="mt-1 block w-full rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12.5px] text-body"
        />
      </label>
      <span className="flex items-center gap-2">
        <button type="submit" disabled={pending} className="rounded-md bg-body px-2.5 py-1 text-[12px] font-medium text-surface disabled:opacity-60">
          {pending ? 'Pausing…' : 'Pause'}
        </button>
        <button type="button" onClick={() => setAsking(false)} className="text-[12px] text-muted hover:text-body">
          Cancel
        </button>
      </span>
      <span className="text-[11.5px] text-dim">What it is doing finishes; it takes nothing new until it is resumed.</span>
      {error && <span className="text-[12px] text-alarm">{error}</span>}
    </form>
  );
}

/** The panel's tabs the crew page adds: what it did, and how it is set up. */
export function seatTabs({
  bot,
  accounts,
  listings,
  now,
}: {
  bot: CrewMember;
  accounts: readonly ModelAccountRef[];
  listings: Record<string, AccountListing> | null;
  now: string;
}) {
  return [
    {
      value: 'history',
      label: 'History',
      content: (
        <div className="flex flex-col gap-2 text-[12.5px]">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">What it finished lately</h3>
          {/* What the bridge sends: its last few, each with what it cost. Fifty were asked for, and three came. */}
          <SeatResults bot={bot} results={recentResults(bot)} now={now} withCost />
        </div>
      ),
    },
    {
      value: 'settings',
      label: 'Settings',
      content: <SeatSettings bot={bot} accounts={accounts} listings={listings} now={now} />,
    },
  ];
}

function SeatSettings({
  bot,
  accounts,
  listings,
  now,
}: {
  bot: CrewMember;
  accounts: readonly ModelAccountRef[];
  listings: Record<string, AccountListing> | null;
  now: string;
}) {
  const admin = useRole() === 'admin';
  const { colors, saving, choose } = useColors({ avatar: bot.avatar ?? null }, (_key, value) => setCrewAvatar(bot.name, value));
  const name = botLabel(bot).handle ?? roleTitle(bot);
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-y-3 text-[12.5px]" data-seat-settings>
      <dt className="pt-0.5 text-dim">Thinks with</dt>
      <dd>
        <ModelChoice bot={bot} accounts={accounts} listings={listings} />
      </dd>
      {!thinksWithNothing(bot) && (
        <>
          <dt className="pt-0.5 text-dim">Tasks at once</dt>
          <dd>
            <TasksAtOnce bot={bot} accounts={accounts} />
          </dd>
        </>
      )}
      {/* Set once and seldom: it lived on every card, and took a row of each. */}
      {admin && (
        <>
          <dt className="pt-0.5 text-dim">Avatar</dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            <AvatarPicker label={`${name} avatar`} bot={bot} value={colors.avatar ?? null} onChoose={(next) => void choose('avatar', next)} />
            {saving.state !== 'idle' && <SaveLine saving={saving} />}
          </dd>
        </>
      )}
      {admin && !thinksWithNothing(bot) && (
        <>
          <dt className="pt-0.5 text-dim">New work</dt>
          <dd>
            <PauseControl bot={bot} now={now} />
          </dd>
        </>
      )}
    </dl>
  );
}
