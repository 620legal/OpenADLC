'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { prefillGitHubAccounts, shownGitHubLogin } from '@/components/github-accounts-step';
import { Button } from '@/components/ui/button';
import type { GitHubAccountsView } from '@/lib/api';
import { cn } from '@/lib/cn';
import { inPipelineOrder } from '@/lib/crew';
import { BRIDGE_NOT_ANSWERING, reach } from '@/lib/reach';
import {
  accountsFrom,
  crewFromEngines,
  draftFor,
  isVerified,
  listModelsFor,
  modelName,
  offeredLine,
  propose,
  readBridgeError,
  saveAssignment,
  type AccountListing,
  type AccountRef,
  type CrewBot,
} from '@/lib/model-onboarding';

/** One model a seat can think with: which, and on which account. */
export interface ModelOptionRow {
  key: string;
  accountId: string;
  model: string;
  label: string;
}

/** One seat, as the table shows it and the step would save it. */
export interface SeatPlan {
  /** The seat, `lead-reviewer`. */
  seat: string;
  label: string;
  role: string;
  /** Its name in the GitHub view, for saving its account; null when the view does not list it. */
  githubBot: string | null;
  /** The GitHub account it would act as, or '' when none could be chosen. */
  login: string;
  storedLogin: string | null;
  /** The accounts it may be put on, and why not where it may not. */
  logins: { login: string; refusal: string | null }[];
  /** Its name in the crew, for saving its model. */
  crewBot: string | null;
  /** Whether it thinks with a model at all: the automation seat does not. */
  thinks: boolean;
  /** The model it would think with, as `account|model`, or '' when none could be chosen. */
  model: string;
  storedModel: string;
  models: ModelOptionRow[];
  /** Why it cannot run as it is, when the bridge says it cannot. */
  problem: string | null;
  /**
   * Why it is offered no model when an account it could use failed to list
   * them: an empty list then is not "add an account", which it already has.
   */
  listingError: string | null;
}

/** What a person changed in the table, by seat. Empty until they change something. */
export interface CrewPicks {
  logins: Record<string, string>;
  models: Record<string, string>;
}

export const NO_PICKS: CrewPicks = { logins: {}, models: {} };

const keyOf = (accountId: string | null, model: string): string => (accountId && model ? `${accountId}|${model}` : '');

/** The `newest:` family a model belongs to, when it belongs to one: `claude-opus-5` is `newest:opus`. */
export function familyAlias(model: string): string | null {
  if (model.startsWith('newest:')) return model;
  const claude = /^claude-(fable|opus|sonnet|haiku)-/.exec(model);
  if (claude) return `newest:${claude[1]}`;
  if (/^grok-/.test(model)) return 'newest:grok';
  if (/codex/.test(model)) return 'newest:codex';
  return null;
}

/** The accounts a seat may think on: the checked ones, and the one it is on. */
function accountsFor(bot: CrewBot, accounts: readonly AccountRef[]): AccountRef[] {
  return accounts.filter((account) => isVerified(account) || account.id === bot.modelAccountId);
}

/**
 * The models a seat is offered on each account: the newest of each family the
 * account can follow — Newest Fable, Newest Opus, Newest Grok — and not every
 * id it lists; an OpenAI key lists dozens. A seat already pinned to an exact
 * version keeps that version in the list too, so the table says what it is on.
 * A particular version nobody here offers is still set from the Crew page.
 */
export function modelOptions(
  bot: CrewBot,
  accounts: readonly AccountRef[],
  listings: Record<string, AccountListing>,
): ModelOptionRow[] {
  const rows: ModelOptionRow[] = [];
  for (const account of accountsFor(bot, accounts)) {
    for (const alias of listings[account.id]?.aliases ?? []) {
      rows.push({ key: keyOf(account.id, alias), accountId: account.id, model: alias, label: `${modelName(alias)} · ${account.label}` });
    }
    const pinned = bot.modelAccountId === account.id && bot.model && !bot.model.startsWith('newest:') ? bot.model : null;
    if (pinned) {
      rows.push({
        key: keyOf(account.id, pinned),
        accountId: account.id,
        model: pinned,
        label: `${modelName(pinned)}, exactly · ${account.label}`,
      });
    }
  }
  return rows;
}

/**
 * What a seat with nothing saved starts on: the proposal, as the newest of
 * its family when the account follows that family. The proposal can name an
 * exact version — a seat moved to another provider is given that provider's
 * model for its tier — and the table offers families.
 */
function asFamily(draft: { accountId: string | null; model: string }, listings: Record<string, AccountListing> | null) {
  const alias = familyAlias(draft.model);
  const follows = draft.accountId && alias ? (listings?.[draft.accountId]?.aliases ?? []).includes(alias) : false;
  return follows ? { ...draft, model: alias! } : draft;
}

/**
 * Every seat, in the order work moves through them, with the GitHub account and
 * the model it would be saved with: what a person picked, else what is stored,
 * else what can be worked out. The summary and the table both read this, so
 * the summary is the table said in a few lines, not a second opinion about it.
 */
export function planCrew(
  github: GitHubAccountsView | null,
  crew: readonly CrewBot[] | null,
  accounts: readonly AccountRef[] | null,
  listings: Record<string, AccountListing> | null,
  picks: CrewPicks = NO_PICKS,
): SeatPlan[] {
  const prefill = github ? prefillGitHubAccounts(github.bots, github.accounts) : null;
  const proposal = crew && accounts && listings ? propose(accounts, crew, listings) : null;
  const seatOfCrew = (bot: CrewBot) => bot.slot ?? bot.bot;
  const seats = new Map<string, { label: string; role: string }>();
  for (const bot of github?.bots ?? []) seats.set(bot.slot, { label: bot.roleLabel, role: bot.role });
  for (const bot of crew ?? []) {
    if (!seats.has(seatOfCrew(bot))) seats.set(seatOfCrew(bot), { label: bot.roleLabel, role: bot.role ?? '' });
  }

  const ordered = inPipelineOrder([...seats].map(([seat, facts]) => ({ seat, ...facts })));
  return ordered.map(({ seat, label, role }) => {
    const gh = github?.bots.find((one) => one.slot === seat) ?? null;
    const bot = crew?.find((one) => seatOfCrew(one) === seat) ?? null;
    const thinks = Boolean(bot && bot.engine !== 'none');
    const proposed = bot ? (proposal?.assignments.find((one) => one.bot === bot.bot) ?? null) : null;
    const stored = bot?.modelAccountId ? { accountId: bot.modelAccountId, model: bot.model } : null;
    const draft = bot ? (stored ?? asFamily(draftFor(bot, undefined, proposed), listings)) : null;
    const models = bot && thinks && accounts && listings ? modelOptions(bot, accounts, listings) : [];
    const failedListing =
      bot && thinks && accounts && listings && models.length === 0
        ? accountsFor(bot, accounts)
            .map((account) => listings[account.id])
            .find((listing) => listing?.error)
        : undefined;

    return {
      seat,
      label,
      role,
      githubBot: gh?.name ?? null,
      login: gh && prefill ? (picks.logins[seat] ?? shownGitHubLogin(gh, {}, prefill)) : '',
      storedLogin: gh?.login ?? null,
      logins: gh?.choices ?? [],
      crewBot: bot?.bot ?? null,
      thinks,
      model: thinks ? (picks.models[seat] ?? (draft ? keyOf(draft.accountId, draft.model) : '')) : '',
      storedModel: bot && thinks ? keyOf(bot.modelAccountId, bot.model) : '',
      models,
      problem: bot && thinks && bot.readiness && !bot.readiness.ready ? bot.readiness.detail : null,
      listingError: failedListing ? (offeredLine(failedListing)?.text ?? null) : null,
    };
  });
}

/** One line of the summary: what the seats share, and which seats they are. */
export interface CrewLine {
  /** The GitHub login, or the model and the account it is on. */
  what: string;
  /** Said before it: "Does the work", "Approves it", or nothing. */
  part: string | null;
  seats: string[];
}

export interface CrewSummary {
  github: CrewLine[];
  models: CrewLine[];
  /** Seats nothing could be chosen for: they need a person, in the table. */
  unchosen: string[];
  /** Seats that cannot run as they are, or whose models could not be listed, and why. */
  problems: { seat: string; note: string }[];
}

/** The plan in a few lines: which account each set of seats acts as, and what each set thinks with. */
export function summarisePlan(plan: readonly SeatPlan[], github: GitHubAccountsView | null): CrewSummary {
  const prefill = github ? prefillGitHubAccounts(github.bots, github.accounts) : null;
  const unchosen = new Set<string>();
  const problems: { seat: string; note: string }[] = [];
  const byLogin = new Map<string, string[]>();
  const byModel = new Map<string, string[]>();
  for (const seat of plan) {
    if (seat.githubBot !== null) {
      if (seat.login) byLogin.set(seat.login, [...(byLogin.get(seat.login) ?? []), seat.label]);
      else unchosen.add(seat.label);
    }
    if (seat.thinks) {
      // The summary says what a seat thinks with; "exactly" is for choosing between a version and its family.
      const label = seat.models.find((option) => option.key === seat.model)?.label.replace(', exactly', '');
      if (label) byModel.set(label, [...(byModel.get(label) ?? []), seat.label]);
      else if (!seat.listingError) unchosen.add(seat.label);
    }
    // The step said "Your crew is ready" over a seat whose engine is not on
    // this host, and "Still to choose" for one whose account could not list
    // its models: the reason is what the person needs.
    const note = seat.problem ?? seat.listingError;
    if (note) problems.push({ seat: seat.label, note });
  }
  return {
    github: [...byLogin].map(([login, seats]) => ({
      what: login,
      part: login === prefill?.crewLogin ? 'Does the work' : login === prefill?.reviewLogin ? 'Approves it' : null,
      seats,
    })),
    models: [...byModel]
      .map(([what, seats]) => ({ what, part: null, seats }))
      .sort((a, b) => b.seats.length - a.seats.length),
    unchosen: [...unchosen],
    problems,
  };
}

/** What saving the plan sends: only the seats that differ from what is stored. */
export function changesIn(plan: readonly SeatPlan[]): {
  logins: { bot: string; login: string; seat: string }[];
  models: { bot: string; accountId: string; model: string; seat: string }[];
} {
  return {
    logins: plan
      .filter((seat) => seat.githubBot && seat.login && seat.login !== (seat.storedLogin ?? ''))
      .map((seat) => ({ bot: seat.githubBot!, login: seat.login, seat: seat.seat })),
    models: plan.flatMap((seat) => {
      const option = seat.models.find((one) => one.key === seat.model);
      if (!seat.crewBot || !seat.thinks || !option || seat.model === seat.storedModel) return [];
      return [{ bot: seat.crewBot, accountId: option.accountId, model: option.model, seat: seat.seat }];
    }),
  };
}

/**
 * The Crew step: who each seat acts as on GitHub, and what it thinks with.
 *
 * It opened on a red box of nine things to do, nine "Choose an account" menus
 * in alphabetical order with a save of their own, a paragraph on what an
 * account and a model are, a proposal written out as a sentence to read before
 * it could be accepted, and a card per bot below that. Everything in it could
 * be worked out from the accounts already connected, and almost always one
 * way. So the step works it out and says it in a few lines, with one button
 * that saves it and goes on; "Change seats" opens one table — a row per seat
 * in pipeline order, its GitHub account and its model — and the same button
 * saves what it shows.
 */
async function readFromBridge(path: string): Promise<unknown> {
  const response = await reach(path, { cache: 'no-store' }, BRIDGE_NOT_ANSWERING);
  if (!response.ok) throw new Error(await readBridgeError(response));
  return response.json();
}

export function CrewStep({
  crew,
  accounts,
  onCrew,
  onSaved,
  onContinue,
}: {
  crew: CrewBot[] | null;
  accounts: AccountRef[] | null;
  onCrew: Dispatch<SetStateAction<CrewBot[] | null>>;
  /** Asks the walkthrough to read again what a saved account changed. */
  onSaved: () => void;
  onContinue: () => void;
}) {
  const [github, setGithub] = useState<GitHubAccountsView | null>(null);
  const [listings, setListings] = useState<Record<string, AccountListing> | null>(null);
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<CrewPicks>(NO_PICKS);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  /** Why what the step is worked out from could not be read; "Try again" reads it again. */
  const [readError, setReadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The model accounts, read here when the walkthrough had none to hand down. */
  const [ownAccounts, setOwnAccounts] = useState<AccountRef[] | null>(null);
  const known = accounts ?? ownAccounts;

  // A read that failed said nothing, and the step stayed on "Working out the
  // crew…" for ever. So did one waiting on accounts or a crew the walkthrough
  // could not read: nothing on this step asked for them again.
  useEffect(() => {
    let gone = false;
    setReadError(null);
    void Promise.all([
      readFromBridge('/api/github/identities').then((view) => {
        if (!gone) setGithub(view as GitHubAccountsView);
      }),
      accounts
        ? null
        : readFromBridge('/api/model-accounts').then((body) => {
            if (!gone) setOwnAccounts(accountsFrom(body));
          }),
      crew
        ? null
        : readFromBridge('/api/engines').then((body) => {
            if (!gone) onCrew(crewFromEngines(body));
          }),
    ]).catch((cause: unknown) => {
      if (!gone) setReadError(cause instanceof Error ? cause.message : 'could not read the accounts');
    });
    return () => {
      gone = true;
    };
    // Once, and again on "Try again": not on every array the parent hands down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const accountIds = (known ?? []).map((account) => account.id).join(',');
  useEffect(() => {
    if (!known) return;
    let gone = false;
    void listModelsFor(known)
      .then((found) => {
        if (!gone) setListings(found);
      })
      .catch(() => {
        if (!gone) setListings({});
      });
    return () => {
      gone = true;
    };
    // By the accounts there are, not by the array the parent passes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIds]);

  const plan = planCrew(github, crew, known, listings, picks);
  const summary = summarisePlan(plan, github);
  const ready = github !== null && listings !== null && crew !== null;
  const failed = Object.keys(refused).length > 0;
  // Nothing worked out, or something refused: the table is where either is fixed.
  const showTable = open || failed || (ready && summary.github.length === 0 && summary.models.length === 0);

  async function saveAndContinue(): Promise<void> {
    const { logins, models } = changesIn(plan);
    setSaving(true);
    const refusals: Record<string, string> = {};
    // The accounts first: putting a committing seat on one is what registers
    // its signing key, and a model on a seat with no account is half a crew.
    for (const change of logins) {
      const response = await fetch('/api/github/accounts/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bot: change.bot, login: change.login }),
      }).catch(() => null);
      if (!response) refusals[change.seat] = 'The console is not answering. Try again in a moment.';
      else if (!response.ok) refusals[change.seat] = await readBridgeError(response);
    }
    for (const change of models) {
      const refusal = await saveAssignment(change.bot, { model: change.model, modelAccountId: change.accountId }, onCrew).catch(
        (cause: unknown) => (cause instanceof Error ? cause.message : 'could not save that'),
      );
      if (refusal) refusals[change.seat] = refusal;
    }
    // Read again what the saves changed. Putting a seat alone on an account
    // renames it to the account's handle, and a second press sent the names
    // from before. Not reading them is no reason to stay on the step.
    await Promise.all([
      readFromBridge('/api/github/identities').then((view) => setGithub(view as GitHubAccountsView)),
      readFromBridge('/api/engines').then((body) => onCrew(crewFromEngines(body))),
    ]).catch(() => undefined);
    setSaving(false);
    setRefused(refusals);
    onSaved();
    if (Object.keys(refusals).length === 0) onContinue();
  }

  if (!ready && readError) {
    return (
      <div className="flex max-w-lg flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
        <p className="text-attention">Could not work out the crew: {readError}</p>
        <Button size="sm" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (!ready) return <p className="text-[13px] text-muted">Working out the crew from your accounts…</p>;

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      {showTable ? (
        <>
          {open && !failed && (
            <button type="button" className="w-fit text-[12.5px] text-link hover:underline" onClick={() => setOpen(false)}>
              ‹ Back to the summary
            </button>
          )}
          <PlanTable plan={plan} refused={refused} onPick={setPicks} />
        </>
      ) : (
        <>
          <p className="text-[14px] font-medium text-body">
            {summary.unchosen.length === 0 && summary.problems.length === 0 ? 'Your crew is ready.' : 'Your crew is almost ready.'}
          </p>
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-[13px]">
            {summary.github.map((line) => (
              <SummaryLine key={`gh:${line.what}`} label={line.part ?? 'GitHub account'} line={line} mono />
            ))}
            {summary.models.map((line, n) => (
              <SummaryLine key={`m:${line.what}`} label={n === 0 ? 'Thinks with' : ''} line={line} />
            ))}
          </dl>
          {summary.problems.length > 0 && (
            <ul className="flex flex-col gap-1">
              {summary.problems.map(({ seat, note }) => (
                <li key={seat} className="text-[12px] leading-snug text-alarm">
                  {seat}: {note}
                </li>
              ))}
            </ul>
          )}
          {summary.unchosen.length > 0 && (
            <p className="text-[12.5px] text-attention">
              Still to choose for: {summary.unchosen.join(', ')}.{' '}
              <button type="button" className="text-link hover:underline" onClick={() => setOpen(true)}>
                Choose them
              </button>
            </p>
          )}
          <button type="button" className="w-fit text-[12.5px] text-link hover:underline" onClick={() => setOpen(true)}>
            Change seats ›
          </button>
        </>
      )}

      <div>
        <Button variant="primary" disabled={saving} onClick={() => void saveAndContinue()}>
          {saving ? 'Saving…' : 'Save crew and continue'}
        </Button>
      </div>
    </div>
  );
}

/**
 * A row per seat, in pipeline order: the GitHub account it acts as and the
 * model it thinks with. It replaced two editors with a save each, a card per
 * bot, and a legend explaining the marks on them: what cannot run, or was not
 * saved, is said in a line under the table, by seat.
 */
function PlanTable({
  plan,
  refused,
  onPick,
}: {
  plan: readonly SeatPlan[];
  refused: Readonly<Record<string, string>>;
  onPick: Dispatch<SetStateAction<CrewPicks>>;
}) {
  const select = 'w-full min-w-0 rounded-md border border-edge-strong bg-panel px-2 py-1.5 text-[12.5px] text-body';
  const notes = plan.flatMap((seat) => {
    const note = refused[seat.seat] ?? seat.problem;
    return note ? [{ seat, note }] : [];
  });
  return (
    <div className="flex flex-col gap-3">
      <table className="w-full table-fixed text-left">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-dim">
            <th className="w-[9.5rem] pb-1.5 pr-3 font-normal">Seat</th>
            <th className="w-[38%] pb-1.5 pr-3 font-normal">GitHub account</th>
            <th className="pb-1.5 font-normal">Model</th>
          </tr>
        </thead>
        <tbody>
          {plan.map((seat) => (
            <tr key={seat.seat} className="border-t border-well align-middle">
              <td className={cn('py-2 pr-3 text-[12.5px] text-body', (refused[seat.seat] ?? seat.problem) && 'text-alarm')}>
                {seat.label}
              </td>
              <td className="py-2 pr-3">
                {seat.githubBot ? (
                  <select
                    aria-label={`GitHub account for the ${seat.label}`}
                    value={seat.login}
                    onChange={(event) => {
                      const login = event.target.value;
                      onPick((current) => ({ ...current, logins: { ...current.logins, [seat.seat]: login } }));
                    }}
                    className={cn(select, 'font-mono')}
                  >
                    {!seat.login && <option value="">Choose an account</option>}
                    {seat.logins.map((choice) => (
                      <option key={choice.login} value={choice.login} disabled={Boolean(choice.refusal)}>
                        {choice.login}
                        {choice.refusal ? ' — not for this seat' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[12px] text-dim">—</span>
                )}
              </td>
              <td className="py-2">
                {!seat.thinks ? (
                  <span className="text-[12px] text-dim">No model needed</span>
                ) : seat.models.length === 0 ? (
                  <span className="text-[12px] text-attention">{seat.listingError ?? 'Add a model account first'}</span>
                ) : (
                  <select
                    aria-label={`Model for the ${seat.label}`}
                    value={seat.model}
                    onChange={(event) => {
                      const model = event.target.value;
                      onPick((current) => ({ ...current, models: { ...current.models, [seat.seat]: model } }));
                    }}
                    className={select}
                  >
                    {!seat.model && <option value="">Choose a model</option>}
                    {seat.models.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {notes.map(({ seat, note }) => (
            <li key={seat.seat} className="text-[12px] leading-snug text-alarm">
              {seat.label}: {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SummaryLine({ label, line, mono = false }: { label: string; line: CrewLine; mono?: boolean }) {
  return (
    <>
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className="min-w-0">
        <span className={mono ? 'font-mono text-[12.5px] text-body' : 'text-body'}>{line.what}</span>
        <span className="block text-[12px] text-muted">{line.seats.join(', ')}</span>
      </dd>
    </>
  );
}
