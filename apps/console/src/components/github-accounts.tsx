'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { addSeat, removeSeat } from '@/app/actions';
import { BotAvatar } from '@/components/avatar';
import { accountIds } from '@/components/model-accounts-card';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import type { CrewMember, GitHubAccountsView, ModelAccountRef } from '@/lib/api';
import { botLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { ACCOUNT_GROUP_TEXT, accountGroupOf, byAccountGroup, modelPicks, readPick, roleTitle, type ModelPick } from '@/lib/crew';
import { NO_MODEL_COPY, assignmentPath, isAccountKind, listModelsFor, readBridgeError, type AccountListing } from '@/lib/model-onboarding';
import { safeAction } from '@/lib/safe-action';
import { accountState } from '@/lib/settings';

type Seat = GitHubAccountsView['bots'][number];

const NO_ACCOUNTS: readonly ModelAccountRef[] = [];

/** One row's change: under way, or refused in the bridge's words. */
interface Saving {
  bot: string;
  what: 'account' | 'model';
  working: boolean;
  error?: string;
}

/** Bot, GitHub account, Model: the model gets the most, so its select shows a whole `Newest Opus · claude-…` label. */
const COLUMNS = 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]';

const SELECT =
  'h-11 w-full min-w-0 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-body disabled:opacity-50 md:h-8';

/**
 * A builder seat added beside the first — `builder-2`, `builder-3` — which is
 * what the row names, since two rows both reading "Builder" say nothing, and
 * what may be removed again. The bridge decides whether it can be.
 */
function addedSeat(bot: Pick<CrewMember, 'role' | 'slot'>): string | null {
  return bot.role === 'implement' && bot.slot && /-\d+$/.test(bot.slot) ? bot.slot : null;
}

/**
 * The crew, a row per bot: the GitHub account it acts as and the model it
 * thinks with, each changed where it is shown. One list, the crew account's
 * seats first, each marked with the account group it signs in as, since that
 * is the rule the account choice follows; what each group means is said under
 * the table.
 *
 * The GitHub account choices are the bridge's — every account OpenADLC holds,
 * with the reason one is refused (a reviewer on the account the crew opens
 * pull requests as, an account whose sign-in stopped working) — and the bridge
 * refuses the same when asked anyway. Taking a bot off an account, or moving
 * it to another, is asked once more, and the bridge refuses it while the bot
 * has work in flight; it leaves the account connected, listed under GitHub as
 * used by no bot. The model account and model are one choice, saved together
 * through the route the walkthrough's assignment step uses, which checks it
 * against the account; the walkthrough is still where accounts are added and
 * where the whole crew is proposed at once.
 *
 * "Add a builder" adds a seat to the crew group: a second builder seat,
 * usually on the same crew account. A repository runs as many tasks at once as its builders' tasks at once
 * add up to, so a seat that runs two is as good as two seats for that. The
 * new row is given an account and a model like any other, and needs no sign-in
 * when it joins an account OpenADLC already holds.
 */
export function CrewTable({
  crew,
  accounts = NO_ACCOUNTS,
  github = null,
}: {
  crew: CrewMember[];
  accounts?: readonly ModelAccountRef[];
  /** The GitHub accounts and each bot's choices; null when the bridge did not say. */
  github?: GitHubAccountsView | null;
}) {
  const router = useRouter();
  const crewSeats = useSeats();
  const [saving, setSaving] = useState<Saving | null>(null);
  /** What each model account offers, once asked; until then a row offers the model it has. */
  const [listings, setListings] = useState<Record<string, AccountListing> | null>(null);
  /**
   * A seat about to be taken off its account, asked once more as Remove is: a
   * misclick in the select used to post at once and break the seat's work.
   */
  const [moving, setMoving] = useState<{ bot: string; login: string | null } | null>(null);

  // Listed again only when the set of accounts changes. Keyed on the array,
  // every fifteen-second read of the page listed every account again, and a
  // failure is not cached: a refused key was asked of its provider each time.
  const listed = accountIds(accounts);
  useEffect(() => {
    let live = true;
    const listable = accounts.map((account) => ({ id: account.id, ...(isAccountKind(account.kind) ? { kind: account.kind } : {}) }));
    void listModelsFor(listable).then((found) => live && setListings(found));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed]);

  const run = async (bot: string, what: Saving['what'], request: () => Promise<Response>): Promise<boolean> => {
    setSaving({ bot, what, working: true });
    try {
      const response = await request();
      if (!response.ok) throw new Error(await readBridgeError(response));
      setSaving(null);
      router.refresh();
      return true;
    } catch (cause) {
      setSaving({ bot, what, working: false, error: cause instanceof Error ? cause.message : 'That did not work.' });
      return false;
    }
  };

  const assign = (bot: CrewMember, login: string | null): void =>
    void run(bot.name, 'account', () =>
      fetch('/api/github/accounts/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bot: bot.name, login }),
      }),
    );

  /** Straight away for a seat on no account; a seat on one is asked first. */
  const choose = (bot: CrewMember, seat: Seat | null, login: string | null): void => {
    if (seat?.login && login !== seat.login) {
      setSaving(null);
      setMoving({ bot: bot.name, login });
      return;
    }
    assign(bot, login);
  };

  /** One choice is a whole pair, account and model, so one request saves both. */
  const think = (bot: CrewMember, accountId: string, model: string): void => {
    if (accountId === bot.modelAccountId && model === bot.model) return;
    void run(bot.name, 'model', () =>
      fetch(assignmentPath(bot.name), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, modelAccountId: accountId }),
      }),
    );
  };

  const seats = byAccountGroup(crew).flatMap(({ seats: inGroup }) => inGroup);
  return (
    <div className="flex flex-col">
      <div role="table" aria-label="The crew" className="flex flex-col">
        <div role="row" className={cn('hidden gap-3 pb-1.5 text-[11px] uppercase tracking-wider text-dim md:grid', COLUMNS)}>
          <span role="columnheader">Bot</span>
          <span role="columnheader">GitHub account</span>
          <span role="columnheader">Model</span>
        </div>
        {seats.map((bot) => {
          const seat = github?.bots.find((one) => one.name === bot.name || (bot.slot ? one.slot === bot.slot : false)) ?? null;
          const mine = saving?.bot === bot.name ? saving : null;
          const move = moving?.bot === bot.name ? moving : null;
          const group = accountGroupOf(bot.role);
          return (
            <div key={bot.name} role="row" className="flex flex-col border-t border-well py-[9px]">
              <div className={cn('grid grid-cols-1 items-center gap-x-3 gap-y-1.5', COLUMNS)}>
                <span role="cell" className="flex min-w-0 items-center gap-2.5 text-[13px]">
                  <BotAvatar bot={bot} size="md" />
                  <span className="min-w-0 truncate font-medium text-body">
                    {roleTitle(bot)}
                    {addedSeat(bot) && <span className="font-normal text-muted"> · {addedSeat(bot)}</span>}
                  </span>
                  <span aria-describedby={`crew-account-${group}`} className="shrink-0">
                    <Chip title={ACCOUNT_GROUP_TEXT[group].blurb}>{ACCOUNT_GROUP_TEXT[group].label}</Chip>
                  </span>
                  {addedSeat(bot) &&
                    (crewSeats.confirming === addedSeat(bot) ? (
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        <Button
                          variant="danger"
                          size="sm"
                          className="h-11 px-2 md:h-7"
                          disabled={crewSeats.pending}
                          onClick={() => crewSeats.remove(addedSeat(bot) ?? bot.name)}
                        >
                          Remove {addedSeat(bot)}
                        </Button>
                        <Button variant="ghost" size="sm" className="h-11 px-2 md:h-7" disabled={crewSeats.pending} onClick={crewSeats.cancel}>
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-11 shrink-0 px-2 md:h-7"
                        disabled={crewSeats.pending}
                        onClick={() => crewSeats.ask(addedSeat(bot) ?? bot.name)}
                      >
                        Remove
                      </Button>
                    ))}
                </span>
                <span role="cell" className="flex min-w-0 flex-col gap-1">
                  <GitHubAccountSelect
                    bot={bot}
                    seat={seat}
                    disabled={Boolean(mine?.working) || move !== null}
                    onChange={(login) => choose(bot, seat, login)}
                  />
                  {move && seat?.login && (
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="text-[12px] text-attention">
                        {move.login ? `Move it from ${seat.login} to ${move.login}?` : `Take it off ${seat.login}?`}
                      </span>
                      <Button
                        variant="danger"
                        size="sm"
                        className="h-11 px-2 md:h-7"
                        onClick={() => {
                          setMoving(null);
                          assign(bot, move.login);
                        }}
                      >
                        Confirm
                      </Button>
                      <Button variant="ghost" size="sm" className="h-11 px-2 md:h-7" onClick={() => setMoving(null)}>
                        Cancel
                      </Button>
                    </span>
                  )}
                </span>
                <span role="cell" className="flex min-w-0 flex-col">
                  {bot.engine === 'none' ? (
                    <span className="text-[12.5px] text-muted">{NO_MODEL_COPY.charAt(0).toUpperCase() + NO_MODEL_COPY.slice(1)}</span>
                  ) : (
                    <ModelSelect
                      bot={bot}
                      accounts={accounts}
                      listings={listings}
                      disabled={Boolean(mine?.working) || accounts.length === 0}
                      onChange={(pick) => think(bot, pick.accountId, pick.model)}
                    />
                  )}
                </span>
              </div>
              {mine?.working && <p className="mt-1.5 text-[12px] text-muted">Saving…</p>}
              {mine?.error && <p className="mt-1.5 text-[12px] text-alarm">{mine.error}</p>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-well py-[9px]">
        <Button size="sm" className="h-11 shrink-0 px-3 md:h-7" disabled={crewSeats.pending} onClick={crewSeats.add}>
          {crewSeats.pending ? 'Working…' : 'Add a builder'}
        </Button>
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-muted">
          Adds another builder seat on the crew account, so a repository runs more tasks at once. It needs no sign-in of its own.
        </span>
        {crewSeats.error && <p className="w-full text-[12px] text-alarm">{crewSeats.error}</p>}
      </div>
      {/* A badge's title is reached by no keyboard and no touch; this is, and each badge points to its line. */}
      <p className="border-t border-well pt-2 text-[12px] leading-normal text-muted">
        {(['crew', 'reviewers'] as const).map((group) => (
          <span key={group} id={`crew-account-${group}`} className="block">
            {ACCOUNT_GROUP_TEXT[group].label}: {ACCOUNT_GROUP_TEXT[group].blurb}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * Adding and removing builder seats: the bridge numbers the new seat and
 * refuses a removal that would lose work, a lease or spend, in words shown
 * here. A removal is asked twice, since it takes the seat off its account.
 */
function useSeats(): {
  pending: boolean;
  error: string | null;
  confirming: string | null;
  add: () => void;
  ask: (seat: string) => void;
  cancel: () => void;
  remove: (seat: string) => void;
} {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const act = (work: () => Promise<{ ok: boolean; error?: string }>): void => {
    setError(null);
    startTransition(async () => {
      // A call that fails outright is said here; inside the transition it took the page down.
      const result = await safeAction(work);
      setConfirming(null);
      if (!result.ok) {
        setError(result.error ?? 'the bridge refused it');
        return;
      }
      router.refresh();
    });
  };
  return {
    pending,
    error,
    confirming,
    add: () => act(() => addSeat('implement')),
    ask: (seat) => {
      setError(null);
      setConfirming(seat);
    },
    cancel: () => setConfirming(null),
    remove: (seat) => act(() => removeSeat(seat)),
  };
}

/**
 * A bot's GitHub account: not connected, or any account OpenADLC holds — the
 * ones it may not use shown, disabled, with the bridge's reason. Without the
 * bridge's choices, the account it is on, said rather than offered.
 */
function GitHubAccountSelect({
  bot,
  seat,
  disabled,
  onChange,
}: {
  bot: CrewMember;
  seat: Seat | null;
  disabled: boolean;
  onChange: (login: string | null) => void;
}) {
  const state = accountState(bot);
  if (!seat) {
    return <span className="truncate text-[12.5px] text-soft">{bot.githubLogin ?? state.text}</span>;
  }
  return (
    <>
      <select
        aria-label={`GitHub account for the ${seat.roleLabel}`}
        value={seat.login ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className={SELECT}
      >
        <option value="">Not connected</option>
        {seat.choices.map((choice) => {
          const refused = choice.refusal !== null && choice.login !== seat.login;
          return (
            <option key={choice.login} value={choice.login} disabled={refused}>
              {refused ? `${choice.login} — ${choice.refusal}` : choice.login}
            </option>
          );
        })}
      </select>
      {seat.login && state.tone === 'attention' && (
        <Link href="#github-accounts" className={cn('text-[12px] text-attention hover:underline')}>
          {state.text} — under GitHub
        </Link>
      )}
    </>
  );
}

/**
 * A bot's model account and model as one choice: every account's models
 * under its name, so what is chosen is always a pair the bridge can save. See
 * `modelPicks`.
 */
function ModelSelect({
  bot,
  accounts,
  listings,
  disabled,
  onChange,
}: {
  bot: CrewMember;
  accounts: readonly ModelAccountRef[];
  listings: Record<string, AccountListing> | null;
  disabled: boolean;
  onChange: (pick: ModelPick) => void;
}) {
  const picks = modelPicks(bot, accounts, listings);
  return (
    <select
      aria-label={`Model for the ${botLabel(bot).role}`}
      value={picks.value}
      disabled={disabled}
      onChange={(event) => {
        const pick = readPick(event.target.value);
        if (pick) onChange(pick);
      }}
      className={SELECT}
    >
      {picks.placeholder && (
        <option value="" disabled>
          {picks.placeholder}
        </option>
      )}
      {picks.groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
