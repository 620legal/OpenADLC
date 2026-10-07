'use client';

import { useEffect, useRef, useState } from 'react';
import { SeatSignup, forgetSignupPassword, type SeatAccount } from '@/components/create-account';
import { DeviceCode } from '@/components/device-code';
import { InstallField, type InstallSettings, type SettingKey } from '@/components/install-settings';
import { SIGN_IN, type Connecting } from '@/components/github-accounts-card';
import { Button } from '@/components/ui/button';
import type { GitHubSignIn } from '@/lib/api';
import { cn } from '@/lib/cn';
import { poll } from '@/lib/reach';
import { ONBOARDING_STEPS, STEP_WHY } from '../../../../packages/shared/src/onboarding';
import { PERSONA_SEATS } from '../../../../packages/shared/src/seats';

/**
 * What the step after this one is for, said under Continue. It promised the
 * seat assignment, and the step it went to was the model accounts.
 */
const NEXT_STEP_WHY = STEP_WHY[ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf('github-accounts') + 1] ?? 'done'];

/** An account as the walkthrough's status lists it, before the crew has chosen. */
export interface WalkthroughGitHubAccount {
  login: string;
  signIn: GitHubSignIn;
  group: 'crew' | 'reviewers' | 'mixed' | null;
  /** Bots on this account. Disconnect is offered only when this is empty; absent means the bridge did not say. */
  seats?: readonly { name: string }[];
}

/** Two working sign-ins. A stored credential GitHub refuses does not count. */
export function githubAccountsReady(accounts: readonly { signIn: string }[] | null | undefined): boolean {
  return (accounts ?? []).filter((account) => account.signIn === 'signed-in').length >= 2;
}

/** The name each seat had when the crew had persona names: `atlas` was the builder. */
const PERSONA_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PERSONA_SEATS).map(([persona, seat]) => [seat, persona]),
);

function namesWords(login: string, wanted: readonly string[]): boolean {
  const words = login.toLowerCase().split('-');
  for (let at = 0; at + wanted.length <= words.length; at += 1) {
    if (!wanted.every((word, offset) => words[at + offset] === word)) continue;
    const after = words[at + wanted.length];
    if (after === undefined || !/^\d+$/.test(after)) return true;
  }
  return false;
}

/**
 * Whether a login names a seat: `fleetadlc-lead-reviewer-acme` names
 * `lead-reviewer`, by whole dash-separated words, and so does an account made
 * when the crew had persona names — `fleet-atlas-acme` is the builder's. A
 * number after it is another seat's: `fleetadlc-builder-2-acme` is the second
 * builder's, not the builder's.
 */
export function loginNamesSeat(login: string, seat: string): boolean {
  if (namesWords(login, seat.toLowerCase().split('-'))) return true;
  const persona = PERSONA_OF[seat.toLowerCase()];
  return persona ? namesWords(login, [persona]) : false;
}

/** The order the GitHub accounts step asks for accounts in, after the two that are required. */
const ASKED_AFTER = ['intake', 'system-engineer', 'second-reviewer', 'security-reviewer', 'sre', 'qa', 'automation'];

/**
 * Which account each bot starts on, when the choice can be made for it.
 *
 * 1. An account named for a seat goes to that seat: nine accounts made with
 *    the names the walkthrough suggests fill the crew with nothing to choose,
 *    and so do accounts named for the personas the crew once had.
 * 2. The account that does the work is the builder's, and the one that
 *    approves it the lead reviewer's. Without those, it is the first connected
 *    of each group — an account's group is what the bridge says, or the group
 *    of the seat it is named for.
 * 3. Accounts that say neither go by the order they were connected in, which
 *    is the order the GitHub accounts step asked for them: the first does the
 *    work, the second approves it, and each after that is the next seat it
 *    asked for. Without that order, they are left for the person to choose.
 * 4. Each group's account fills the rest of that group's seats.
 */
export function prefillGitHubAccounts(
  bots: readonly { name: string; slot?: string; group: 'crew' | 'reviewers'; login: string | null }[],
  accounts: readonly {
    login: string;
    signIn: string;
    group: 'crew' | 'reviewers' | 'mixed' | null;
    connectedAt?: string | null;
  }[],
): {
  byBot: Record<string, string>;
  bySeat: Record<string, string>;
  crewLogin: string | null;
  reviewLogin: string | null;
} {
  const working = accounts
    .filter((account) => account.signIn === 'signed-in' && account.group !== 'mixed')
    .map((account, at) => ({ ...account, at }));
  const ordered = working.every((account) => account.connectedAt)
    ? [...working].sort((a, b) => Date.parse(a.connectedAt!) - Date.parse(b.connectedAt!) || a.at - b.at)
    : null;
  const seatOf = (bot: (typeof bots)[number]) => bot.slot ?? bot.name;

  const bySeat: Record<string, string> = {};
  const seatGroup = new Map<string, 'crew' | 'reviewers' | 'mixed'>();
  const named = new Map<string, string>();
  for (const bot of bots) {
    const matches = working.filter((account) => loginNamesSeat(account.login, seatOf(bot)));
    if (matches.length !== 1) continue;
    const login = matches[0]!.login;
    named.set(seatOf(bot), login);
    if (!bot.login) bySeat[bot.name] = login;
    const before = seatGroup.get(login);
    seatGroup.set(login, before && before !== bot.group ? 'mixed' : bot.group);
  }
  const groupOf = (account: (typeof working)[number]) => account.group ?? seatGroup.get(account.login) ?? null;
  const byConnection = ordered ?? working;
  const firstOf = (group: 'crew' | 'reviewers') => byConnection.find((account) => groupOf(account) === group)?.login ?? null;

  let crewLogin = named.get('builder') ?? firstOf('crew');
  let reviewLogin = named.get('lead-reviewer') ?? firstOf('reviewers');
  const loose = byConnection.filter((account) => groupOf(account) === null && account.login !== crewLogin && account.login !== reviewLogin);

  if (ordered) {
    // The order the step asked in: work, then approval, then each seat after.
    const queue = [...loose];
    if (!crewLogin && queue.length > 0) crewLogin = queue.shift()!.login;
    if (!reviewLogin && queue.length > 0) reviewLogin = queue.shift()!.login;
    for (const seat of ASKED_AFTER) {
      if (queue.length === 0) break;
      const bot = bots.find((one) => seatOf(one) === seat && !one.login && !bySeat[one.name]);
      if (bot) bySeat[bot.name] = queue.shift()!.login;
    }
  }

  const byBot: Record<string, string> = { ...bySeat };
  for (const bot of bots) {
    if (bot.login || byBot[bot.name]) continue;
    const login = bot.group === 'reviewers' ? reviewLogin : crewLogin;
    if (login) byBot[bot.name] = login;
  }
  return { byBot, bySeat, crewLogin, reviewLogin };
}

/** What a prefill looks like once `prefillGitHubAccounts` has chosen. */
type GitHubPrefill = {
  byBot: Readonly<Record<string, string>>;
  bySeat?: Readonly<Record<string, string>>;
  crewLogin: string | null;
  reviewLogin: string | null;
};

/**
 * The login the row shows: a choice the person made, the account already
 * stored, the account named for the seat, or the prefill.
 */
export function shownGitHubLogin(
  bot: { name: string; group: 'crew' | 'reviewers'; login: string | null },
  picks: Readonly<Record<string, string>>,
  prefill: GitHubPrefill,
): string {
  const chosen = picks[bot.name];
  if (chosen) return chosen;
  if (bot.login) return bot.login;
  const named = prefill.bySeat?.[bot.name];
  if (named) return named;
  return prefill.byBot[bot.name] ?? '';
}

/** How many seats a default crew has: one GitHub account each is what works best. */
export const SEATS_AT_BEST = 9;

/** The least the crew can work with: one account that does the work and one that approves it. */
export const ACCOUNTS_REQUIRED = 2;

/**
 * The seat whose username and address to offer for the next account made.
 *
 * The first two are the two that are required — the builder, which does the
 * work, and the lead reviewer, which approves it — and the rest follow in the
 * order work moves through them. A seat already on an account is passed over.
 */
export function nextSeatToCreate(seats: readonly SeatAccount[], connected: readonly string[]): SeatAccount | null {
  const taken = new Set(connected.map((login) => login.toLowerCase()));
  const first = ['builder', 'lead-reviewer'];
  const ordered = [
    ...first.flatMap((seat) => seats.filter((one) => one.seat === seat)),
    ...seats.filter((one) => !first.includes(one.seat)),
  ];
  // By the seat a login names, not the bare suggestion: the page suggests
  // `acme-fleetadlc-builder` when `fleetadlc-builder-acme` is taken, and an
  // account made under it was asked for again.
  return (
    ordered.find(
      (one) =>
        !one.connectedLogin &&
        !taken.has(one.suggestedLogin.toLowerCase()) &&
        !connected.some((login) => loginNamesSeat(login, one.seat)),
    ) ?? null
  );
}

/** What the step asks about the account it is on: which one it is, and whether it is needed. */
export function accountHeading(count: number, target: number): { title: string; note: string } {
  const n = count + 1;
  if (n <= ACCOUNTS_REQUIRED) {
    return {
      title: `Account ${n} of ${ACCOUNTS_REQUIRED}`,
      note: n === 1 ? 'Required: the account that does the work.' : 'Required: the account that approves the work.',
    };
  }
  return { title: `Account ${n}`, note: `Optional. ${target} are recommended, one per seat.` };
}

/**
 * The GitHub accounts step, one account at a time.
 *
 * Somebody may have some of these accounts and need to make the rest, so the
 * choice is asked per account, not once for the step: for this account, make
 * a new one or use one you have. Each account connected goes into the list
 * beside the step, and the question is asked again for the next. Once the two
 * that are required are in, a third answer is offered — go on to the next
 * step — and that is the way forward: the walkthrough's own forward button is
 * not shown here, because "skip" over an account nobody has added means
 * nothing, and "next" is one of the answers.
 *
 * It replaced a page that opened on a failure box, said why two accounts
 * three ways, and laid out a five-step form for each of two accounts before
 * asking anything.
 */
export function GitHubAccountsStep({
  email,
  signupUrl,
  emailSettingsUrl,
  accounts,
  seats = [],
  settings,
  save,
  onEmail,
  onChanged,
  onContinue,
}: {
  email: string;
  signupUrl: string;
  /** GitHub's email settings, where a new account keeps its address private. */
  emailSettingsUrl: string;
  accounts: readonly WalkthroughGitHubAccount[] | null;
  /** One per seat, for the username and address of an account to create. */
  seats?: readonly SeatAccount[];
  settings: InstallSettings | null;
  save: (key: SettingKey, value: string) => Promise<void>;
  onEmail: (value: string) => void;
  onChanged: () => void;
  /** Goes on to the next step: the third answer, once the required accounts are in. */
  onContinue?: () => void;
}) {
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [way, setWay] = useState<'create' | 'have' | null>(null);
  const held = accounts ?? [];
  const working = held.filter((account) => account.signIn === 'signed-in').length;
  const target = Math.max(seats.length, SEATS_AT_BEST);
  const enough = working >= ACCOUNTS_REQUIRED;
  const heading = accountHeading(held.length, target);
  const seat = nextSeatToCreate(seats, held.map((account) => account.login));

  // An account came in: its question is answered, and the next one is asked.
  // The password made for the seat whose form was open goes with it.
  const count = useRef(held.length);
  const shownSeat = useRef<string | null>(seat?.seat ?? null);
  useEffect(() => {
    if (held.length > count.current) {
      setWay(null);
      setConnecting(null);
      if (shownSeat.current) forgetSignupPassword(shownSeat.current);
    }
    count.current = held.length;
    shownSeat.current = seat?.seat ?? null;
  }, [held.length, seat?.seat]);

  // Leaving the step leaves no generated password behind for any seat.
  const seatNames = useRef<string[]>([]);
  seatNames.current = seats.map((one) => one.seat);
  useEffect(() => () => seatNames.current.forEach(forgetSignupPassword), []);

  useEffect(() => {
    if (!connecting || connecting.state !== 'waiting' || !connecting.flowId) return;
    const timer = setInterval(async () => {
      const answer = await poll<{ state: string; login?: string; error?: string }>(
        `/api/github/accounts/connect/${encodeURIComponent(connecting.flowId ?? '')}`,
      );
      if (!answer) return;
      if (answer.state === 'connected') {
        setConnecting({ ...connecting, state: 'connected', login: answer.login });
        onChanged();
      } else if (answer.state === 'failed' || answer.state === 'none') {
        setConnecting({
          ...connecting,
          state: 'failed',
          error: answer.error ?? 'The bridge is no longer waiting on this code.',
        });
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [connecting, onChanged]);

  const connect = async (): Promise<void> => {
    setError(null);
    setConnecting({ key: 'new', who: 'a GitHub account', state: 'starting' });
    try {
      const response = await fetch('/api/github/accounts/connect', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as {
        flowId?: string;
        userCode?: string;
        verificationUri?: string;
        error?: string;
      };
      if (!response.ok || !body.flowId) {
        setConnecting({ key: 'new', who: 'a GitHub account', state: 'failed', error: body.error ?? 'GitHub did not give a code.' });
        return;
      }
      setConnecting({
        key: 'new',
        who: 'a GitHub account',
        state: 'waiting',
        flowId: body.flowId,
        userCode: body.userCode,
        verificationUri: body.verificationUri,
      });
    } catch {
      setConnecting({ key: 'new', who: 'a GitHub account', state: 'failed', error: 'The console is not answering. Try again in a moment.' });
    }
  };

  const disconnect = async (login: string): Promise<void> => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Disconnect ${login}? OpenADLC forgets its sign-in; using it again means connecting it again.`)
    ) {
      return;
    }
    setDisconnecting(login);
    setError(null);
    try {
      const response = await fetch('/api/github/accounts/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The bridge did not disconnect it.');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setDisconnecting(null);
    }
  };

  const connectBlock = (
    <div>
      <Button type="button" onClick={() => void connect()} disabled={connecting?.state === 'starting' || connecting?.state === 'waiting'}>
        Connect it
      </Button>
      {connecting?.state === 'waiting' && connecting.userCode && (
        <div className="mt-3">
          <DeviceCode code={connecting.userCode} url={connecting.verificationUri} />
          <p className="mt-2 text-[12.5px] text-muted">
            Enter it there signed in as that account — in a private window if your browser is signed in as you.
          </p>
        </div>
      )}
      {connecting?.state === 'failed' && <p className="mt-2 text-[13px] text-alarm">{connecting.error}</p>}
    </div>
  );

  const choices = [
    ['create', 'Create a new account', seat ? `We suggest a username, email and password for the ${seat.label}.` : 'We suggest a username, email and password.'],
    ['have', 'Use an account I have', 'Sign it in with a code.'],
  ] as const;

  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="flex min-w-0 flex-col gap-5">
        {held.length === 0 && (
          <p className="max-w-xl text-[13px] leading-relaxed text-body">
            <strong>{target} accounts recommended</strong>, one per seat. <strong>You can start with {ACCOUNTS_REQUIRED}</strong>,
            which are required: one that does the work and one that approves it. Not your personal account.
          </p>
        )}

        <div>
          <p className="text-[14px] font-medium text-body">{enough ? 'Add another account, or go on' : heading.title}</p>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {enough ? `${working} connected. ${target} are recommended, one per seat; you can add the rest later.` : heading.note}
          </p>
        </div>

        <div role="group" aria-label="This account" className={cn('grid max-w-2xl gap-3', enough ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
          {choices.map(([key, title, blurb]) => (
            <button
              key={key}
              type="button"
              aria-pressed={way === key}
              onClick={() => setWay(key)}
              className={cn(
                'rounded-md border px-3.5 py-3 text-left transition-colors',
                way === key ? 'border-link bg-link/5' : 'border-edge-strong bg-panel hover:border-soft',
              )}
            >
              <span className="block text-[13px] font-medium text-body">{title}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted">{blurb}</span>
            </button>
          ))}
          {enough && (
            <button
              type="button"
              onClick={() => onContinue?.()}
              className="rounded-md border border-body bg-body px-3.5 py-3 text-left text-panel transition-colors hover:opacity-90"
            >
              <span className="block text-[13px] font-medium">Continue to the next step</span>
              <span className="mt-0.5 block text-[12px] leading-snug opacity-80">{NEXT_STEP_WHY}</span>
            </button>
          )}
        </div>

        {way === 'create' && (
          <div className="flex max-w-2xl flex-col gap-4">
            {settings && !email ? (
              <InstallField
                settingKey="operatorEmail"
                label="your email"
                placeholder="you@gmail.com"
                hint="Each account gets an address like you+fleetadlc-<seat>@yourdomain, which most providers deliver to your inbox."
                settings={settings}
                save={async (key, value) => {
                  await save(key, value);
                  onEmail(value);
                }}
                onSaved={() => undefined}
              />
            ) : null}
            {seat ? (
              <SeatSignup account={seat} signupUrl={signupUrl} emailSettingsUrl={emailSettingsUrl} connect={connectBlock} />
            ) : (
              connectBlock
            )}
          </div>
        )}

        {way === 'have' && <div className="max-w-2xl">{connectBlock}</div>}
        {error && <p className="text-[13px] text-alarm">{error}</p>}
      </div>

      <aside aria-label="GitHub accounts OpenADLC holds" className="md:border-l md:border-well md:pl-6">
        <p className="text-[11px] uppercase tracking-wider text-dim">
          Accounts · {working} of {target}
        </p>
        {held.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-muted">None yet. Each one you add is listed here.</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {held.map((account) => {
              const sign = SIGN_IN[account.signIn];
              const used = account.seats ?? [];
              return (
                <li key={account.login} className="flex flex-col gap-0.5 border-t border-well py-2">
                  <span className="truncate font-mono text-[12.5px] text-body">{account.login}</span>
                  <span className="flex items-center gap-2">
                    <span className={cn('text-[11.5px]', sign.tone)}>{sign.text}</span>
                    {used.length === 0 ? (
                      <button
                        type="button"
                        className="ml-auto text-[11.5px] text-alarm hover:underline disabled:opacity-50"
                        disabled={disconnecting === account.login}
                        onClick={() => void disconnect(account.login)}
                      >
                        {disconnecting === account.login ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    ) : (
                      <span className="ml-auto text-[11px] text-dim" title={`To disconnect it, move ${used.length > 1 ? 'these bots' : 'this bot'} to another account under Crew first.`}>
                        in use
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}
