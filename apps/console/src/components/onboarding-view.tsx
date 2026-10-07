'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { WebhookStep } from '@/components/webhook-step';
import { RepositoryField } from '@/components/repository-field';
import { AccountsStep } from '@/components/accounts-step';
import { RepoSetupStep, repositoriesReady, type RepoPlan } from '@/components/repo-setup-step';
import { InstallField, SettingsUnread, useInstallSettings, type InstallSettings } from '@/components/install-settings';
import { Markdown } from '@/components/markdown';
import { AccountField } from '@/components/account-field';
import { Invitations } from '@/components/invitations';
import { CreateApp } from '@/components/create-app';
import { AppChecksPanel, installHeld, installKnown, type AppChecks } from '@/components/app-checks';
import { GitHubAccountsStep, githubAccountsReady, type WalkthroughGitHubAccount } from '@/components/github-accounts-step';
import { RestoreStep } from '@/components/restore-step';
import { CrewStep } from '@/components/crew-step';
import type { SeatAccount } from '@/components/create-account';
import { seatFor } from '@/lib/bot-label';
import { inPipelineOrder } from '@/lib/crew';
import type { RestoreState } from '@/lib/backup';
import { cn } from '@/lib/cn';
import {
  accountsFrom,
  accountsStepDone,
  assignmentStepDone,
  crewFromEngines,
  forwardLabel,
  readBridgeError,
  type AccountRef,
  type CrewBot,
} from '@/lib/model-onboarding';
import {
  ONBOARDING_STEPS,
  STEP_SHORT,
  STEP_TITLES,
  STEP_WHY,
  onboardingStepKey,
  type OnboardingStep,
} from '../../../../packages/shared/src/onboarding';

interface OnboardingBot {
  /** The handle of its account once one is connected; the seat it fills until then. */
  bot: string;
  /** The seat, `second-reviewer`. Absent from a bridge older than seats. */
  slot?: string | null;
  displayName: string;
  role: string;
  roleLabel: string;
  /** The account's login once connected. Before that, only what the bridge would suggest. */
  login: string;
  suggestedLogin: string;
  suggestedEmail: string | null;
  emailNote: string;
  repositoryRole: 'triage' | 'write';
  accessReason: string;
  accountExists: boolean | null;
  connected: boolean;
  /** Whether that credential can still act. Null when there is none to try. */
  authorizationWorks: boolean | null;
  credentialKind: 'refresh' | 'static' | null;
  hasSigningKey: boolean;
  /** In every repository OpenADLC works in. */
  inRepository: boolean | null;
  /** The same, one repository at a time. Absent from an older bridge. */
  access?: { repository: string; inRepository: boolean | null }[];
  profile: { login: string; name: string | null; email: string | null; avatarUrl: string; htmlUrl: string } | null;
}

export interface OnboardingData {
  organization: string | null;
  organizationIsOrg: boolean | null;
  repositories: string[];
  clientIdConfigured: boolean;
  webhookSecretConfigured: boolean;
  /** Whether GitHub can reach this bridge, which a stored secret does not prove. */
  webhookReady: boolean;
  operatorEmail: string;
  steps: { step: string; title: string; done: boolean; detail: string }[];
  bots: OnboardingBot[];
  links: { signup: string; emailSettings: string; device: string; newApp: string; yourApps: string; invite: string | null };
  appSettings: readonly { setting: string; value: string; why: string }[];
  appPermissions: readonly { scope: string; permission: string; access: string; why: string }[];
  webhookEvents: readonly string[];
  webhookUrl: string;
  complete: boolean;
  /** Accounts OpenADLC holds, apart from which bot uses which. Absent from an older bridge. */
  githubAccounts?: WalkthroughGitHubAccount[];
  /**
   * What the bridge's health checks say about each step a person does: done
   * when a check proves it, not done when one fails, null when none has an
   * answer yet. The same checks that put a card on the board. Absent from an
   * older bridge.
   */
  checks?: Partial<Record<string, StepCheck>>;
}

/** How long to wait between reads while the GitHub accounts check has not written. */
const ACCOUNTS_CHECK_PAUSE_MS = 1_000;
/** A check that never runs must not poll for the rest of the visit. */
const ACCOUNTS_CHECK_TRIES = 20;

/** The GitHub accounts health row, so two loads can tell whether the check has written. */
export function githubAccountsCheckKey(data: { checks?: OnboardingData['checks'] }): string {
  return JSON.stringify(data.checks?.['github-accounts'] ?? null);
}

type AccountsRead = { checks?: OnboardingData['checks']; githubAccounts?: readonly { signIn: string }[] };

/**
 * Reads onboarding again until the GitHub accounts check row changes.
 *
 * Connecting or disconnecting updates the account list at once. The failure
 * banner is the check's row, and that check does not start until `runSoon`
 * has waited and then asked the token broker. A load on a clock left the
 * banner on the previous failure for the rest of the visit while the
 * already-done row had already followed the list.
 *
 * The first read is immediate. Later reads happen after `wait`, and stop
 * when the row differs from `before`, or when the check passes and the list
 * it read is ready: with two accounts signed in the row stays
 * `{"done":true,"failing":[]}` whatever else connects, and every connect after
 * the second ran all 21 reads. `tries` is the bound, not the signal.
 */
export async function reloadUntilGitHubAccountsCheckMoves(
  before: string,
  read: () => Promise<AccountsRead | null>,
  wait: (ms: number) => Promise<void>,
  options?: { tries?: number; pauseMs?: number },
): Promise<void> {
  const tries = options?.tries ?? ACCOUNTS_CHECK_TRIES;
  const pauseMs = options?.pauseMs ?? ACCOUNTS_CHECK_PAUSE_MS;
  const settled = (next: AccountsRead | null): boolean =>
    !next ||
    githubAccountsCheckKey(next) !== before ||
    (next.checks?.['github-accounts']?.done === true && githubAccountsReady(next.githubAccounts ?? []));
  if (settled(await read())) return;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await wait(pauseMs);
    if (settled(await read())) return;
  }
}

/** One step's verdict from the health checks, and what fails on it. */
export interface StepCheck {
  done: boolean | null;
  failing: {
    id: string;
    title: string;
    detail: string;
    severity: 'blocking' | 'warning';
    action: { label: string; href?: string; url?: string; command?: string } | null;
    waiting: boolean;
  }[];
}

/**
 * Setting OpenADLC up, one thing at a time.
 *
 * This was a single page with every section stacked on it: a checklist of eight,
 * a five-field form, a permissions table, nine bot cards and a webhook section,
 * all visible at once. Everything was there and nothing was next — you had to
 * read the whole page to work out what to do, every time you came back to it.
 *
 * So it is a sequence now. One screen asks one thing, says why it matters, and
 * offers exactly one way forward. Where you are is taken from GitHub rather than
 * from anything remembered here, so closing the tab half way through costs
 * nothing: it reopens on the first thing still undone.
 */

interface WizardStep {
  key: OnboardingStep;
  short: string;
  title: string;
  done: boolean;
}

/**
 * What is already true, asked of GitHub rather than remembered here. A step is
 * done because the world says so, which is what makes closing the tab safe.
 *
 * Pure, so the starting step can be worked out before the first paint rather
 * than corrected after it.
 */
function stepsFor(
  data: OnboardingData,
  appChecks?: AppChecks | null,
  /**
   * Whether GitHub actually delivers here, once the step has asked. A stored
   * secret is not the same thing: a tunnel address outlives the tunnel, so an
   * install can hold every setting and receive nothing.
   */
  webhookReady?: boolean | null,
  /**
   * Two facts, asked separately. A verified account is not an assignment, and
   * one flag cannot say both — the walkthrough would open on the wrong screen
   * the moment either of them became true.
   */
  accounts?: AccountRef[] | null,
  crew?: CrewBot[] | null,
  /**
   * Whether this install can be restored into, as the bridge says. The first
   * step is there once it has said: done when the install is set up, because
   * a restore is offered only onto a clean one.
   */
  restore?: RestoreState | null,
  /** Whether every repository has nothing left to change, once the page has asked; see `repositoriesReady`. */
  protectedRepositories?: boolean | null,
): WizardStep[] {
  // A stored credential GitHub refuses does not count. It used to, which is how
  // the walkthrough ticked "the crew" over nine accounts that could not act.
  const inRepository = data.bots.filter((bot) => bot.inRepository === true).length;
  // What the health checks proved, where one has an answer: the same checks
  // that put a card on the board. Null leaves the step to what it knew before.
  const proved = (key: OnboardingStep): boolean | null => data.checks?.[key]?.done ?? null;

  // The same list the bridge reports. Start is offered once the bridge has
  // said whether a backup can be restored here; until then it is left out
  // rather than offering a restore the page cannot do.
  const keys = restore ? ONBOARDING_STEPS : ONBOARDING_STEPS.filter((key) => key !== 'start');

  const doneOf = (key: OnboardingStep): boolean => {
    switch (key) {
      case 'start':
        return restore ? !restore.clean : false;
      case 'owner':
        return Boolean(data.organization);
      case 'app':
        // Having a client id is not the same as having an app that works.
        // Device flow off means every connect fails, and somebody who moved on
        // from here finds that out on an account they already spent five
        // minutes making. Unknown counts as done: a network failure must not
        // hold up setup. Installing is the next step, not this one.
        // And every permission this OpenADLC asks for: a new version can ask for
        // one an older app was never given, which only the checks can see.
        return data.clientIdConfigured && appChecks?.deviceFlow !== 'disabled' && proved('app') !== false;
      case 'install':
        // A known yes, and a client id. No answer yet used to count: nothing
        // had asked GitHub, `installHeld` does not hold an unknown, and a
        // clean install showed Install in the already-done row.
        return data.clientIdConfigured && proved('install') !== false && installKnown(appChecks) && !installHeld(appChecks);
      case 'webhook':
        // What the step itself asked, once it has, and otherwise only a health
        // check that proved a delivery. A stored address and secret are not
        // one: raising a tunnel for the app stores both before GitHub has
        // sent anything, and that painted Webhook done while the person was
        // still on Start.
        if (webhookReady != null) return webhookReady;
        return proved('webhook') === true;
      case 'repository':
        return data.repositories.length > 0;
      case 'github-accounts':
        // The list this load just read. A check from before the connect or
        // disconnect must not outrank it: startup writes a failing row while
        // there are no accounts, and that row stays failing until the check
        // runs. Seats are the Crew step.
        if (data.githubAccounts) return githubAccountsReady(data.githubAccounts);
        return proved('github-accounts') === true;
      case 'models':
        // One verified, which is what the step's own panel lists. Stored was
        // not enough: a seat nothing had checked ticked this and was skipped.
        return proved('models') === false ? false : accounts ? accountsStepDone(accounts, crew ?? []) : false;
      case 'crew':
        // Models being assigned is not a seat on an account. A failing
        // `bot-sign-in` or `signing-key` used to hold GitHub accounts open;
        // tagged `crew`, they hold this step open, or Crew ticks with no seat
        // and no committing bot's key registered.
        if (proved('crew') === false) return false;
        return accounts && crew ? assignmentStepDone(accounts, crew) : false;
      case 'access':
        // Every seat's account in the repository, as the bridge counts it. An
        // organization used to count as done on its own — a member is added
        // rather than invited — which ticked Access on an organization's
        // install before a single account was connected. Being added is how
        // an account gets in there, not a sign that it has.
        return proved('access') ?? (data.bots.length > 0 && inRepository === data.bots.length);
      case 'protect':
        return protectedRepositories === true;
      case 'done':
        return false;
    }
  };

  return keys.map((key) => ({ key, short: STEP_SHORT[key], title: STEP_TITLES[key], done: doneOf(key) }));
}

/** Steps that offer their own way forward, so the footer offers none. */
const ASKS_ITS_OWN_WAY_ON: ReadonlySet<string> = new Set(['github-accounts', 'crew']);

/**
 * Steps drawn from the install's settings: the owner's field, the app's, the
 * GitHub accounts step's email, and whether Access can invite. Without them
 * these showed only their title, with nothing to say why.
 */
const NEEDS_SETTINGS: ReadonlySet<string> = new Set(['owner', 'app', 'github-accounts', 'access']);

/** Each seat as the GitHub accounts step's table lists it: what to sign up with, or the account it has. */
export function seatAccounts(bots: readonly OnboardingBot[]): SeatAccount[] {
  // In the order work moves through them, not by name: automation came first.
  return inPipelineOrder(bots).map((bot) => ({
    seat: seatFor(bot),
    label: bot.roleLabel || seatFor(bot),
    suggestedLogin: bot.suggestedLogin,
    suggestedEmail: bot.suggestedEmail,
    connectedLogin: bot.connected ? bot.login : null,
  }));
}

function firstUndoneIn(steps: readonly { done: boolean }[]): number {
  return Math.max(0, steps.findIndex((step) => !step.done));
}

/**
 * Where the walkthrough opens: the step its address names, when it names one
 * that exists, and otherwise the first thing still undone.
 *
 * `steps` is whatever list is on screen. A name that is not one of them is
 * tried as an old `?step=` key before it is ignored.
 */
export function startingStep(steps: readonly { key: string; done: boolean }[], named?: string | null): number {
  if (named) {
    const direct = steps.findIndex((step) => step.key === named);
    if (direct >= 0) return direct;
    // A link from before the reorder (`?step=email`) names the step it is now.
    const aliased = onboardingStepKey(named);
    if (aliased) {
      const at = steps.findIndex((step) => step.key === aliased);
      if (at >= 0) return at;
    }
  }
  return firstUndoneIn(steps);
}

/** One line of the Ready step: a step, whether it is done, and the fact that shows it. */
export interface ReadyLine {
  key: string;
  title: string;
  done: boolean;
  fact: string;
}

/**
 * What the Ready step says is set up: each step between Start and Ready, done
 * or not, with the fact that shows it where the page knows one — the owner,
 * the repositories, the crew's accounts. "The crew is connected" alone did not
 * say what had been set up, which is the one thing this step is for.
 */
export function readySummary(
  data: Pick<OnboardingData, 'organization' | 'repositories' | 'bots' | 'githubAccounts'>,
  steps: readonly { key: string; title: string; done: boolean }[],
): ReadyLine[] {
  // The accounts step is about accounts, which belong to no seat until Crew
  // puts one on them: counted by seat, two accounts connected read
  // "GitHub accounts ✓ — 0 of 9 connected". The seats are Crew's fact.
  const signedIn = (data.githubAccounts ?? []).filter((account) => account.signIn === 'signed-in').length;
  const seated = data.bots.filter((bot) => bot.connected).length;
  const facts: Record<string, string> = {
    owner: data.organization ?? '',
    repository: data.repositories.join(', '),
    'github-accounts': data.githubAccounts ? `${signedIn} connected` : '',
    crew: data.bots.length > 0 ? `${seated} of ${data.bots.length} seats on an account` : '',
  };
  return steps
    .filter((one) => one.key !== 'start' && one.key !== 'done')
    .map((one) => ({ key: one.key, title: one.title, done: one.done, fact: facts[one.key] ?? '' }));
}

/**
 * Each line still open is a link to its step, followed in place as the
 * progress bar's are. A plain `<Link>` changed only the address: the
 * walkthrough keeps its state across a change of `?step=`, and stayed on Ready.
 */
function ReadySummary({
  lines,
  steps,
  onPick,
}: {
  lines: ReadyLine[];
  steps: readonly WizardStep[];
  onPick: (position: number) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <ul className="mb-3 max-w-lg space-y-1 text-[13px] leading-relaxed">
      {lines.map((line) => (
        <li key={line.key} className="flex gap-2">
          <span className={cn('w-3 shrink-0 text-center', line.done ? 'text-signal' : 'text-attention')}>
            {line.done ? '✓' : '·'}
          </span>
          <span className={line.done ? 'text-body' : 'text-muted'}>
            {line.done ? (
              line.title
            ) : (
              <StepLink
                step={steps.find((one) => one.key === line.key)!}
                position={steps.findIndex((one) => one.key === line.key)}
                onPick={onPick}
                className="text-link hover:underline"
              >
                {line.title}
              </StepLink>
            )}
            {line.fact ? <span className="text-muted"> — {line.fact}</span> : null}
            {line.done ? null : <span className="text-dim"> (still open)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The address of one step, relative to the walkthrough's own. */
function stepHref(key: string): string {
  return `?step=${encodeURIComponent(key)}`;
}

export function OnboardingView({
  initialEmail,
  initialData,
  initialChecks,
  initialAccounts,
  initialCrew,
  initialStep = null,
  initialRestore = null,
  initialSettings = null,
}: {
  initialEmail: string;
  initialData: OnboardingData;
  /** Known before the first paint, so the starting step is decided on facts. */
  initialChecks: AppChecks | null;
  /** Stored accounts and assignments, so coming back does not open a blank step. */
  initialAccounts: AccountRef[] | null;
  initialCrew: CrewBot[] | null;
  /** A step the address named, such as `?step=models`, which is what the walkthrough's own links carry; old names are mapped by onboardingStepKey. */
  initialStep?: string | null;
  /** Whether a backup can be restored here: a clean install only. */
  initialRestore?: RestoreState | null;
  /** The install's settings, read with the rest, so the Owner and App steps are there on first paint. */
  initialSettings?: InstallSettings | null;
}) {
  const [data, setData] = useState<OnboardingData>(initialData);
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  /** Reloads failed in a row, so each retry waits longer than the last. */
  const [failures, setFailures] = useState(0);
  /** Null until the webhook step has looked; see `stepsFor`. */
  const [webhookReady, setWebhookReady] = useState<boolean | null>(null);
  /**
   * Null until the page has asked. A failed ask is not "no accounts": the
   * starting step was already chosen from what the server knew.
   */
  const [accounts, setAccounts] = useState<AccountRef[] | null>(initialAccounts);
  const [crew, setCrew] = useState<CrewBot[] | null>(initialCrew);
  /** Null until the repositories' setup has been read; see `repositoriesReady`. */
  const [protectedRepositories, setProtectedRepositories] = useState<boolean | null>(null);
  const { settings, error: settingsError, save, reload: reloadSettings } = useInstallSettings(initialSettings);

  /**
   * Which step is on screen. Chosen once, from where the install was when the
   * page opened, and moved only by somebody pressing something.
   *
   * It used to be derived continuously from "the first step not yet done", and
   * that quietly made the page move while you were using it: when there was an
   * email step, it was done once the field was non-empty, so the first
   * character typed marked it complete and the wizard advanced to the next
   * step mid-keystroke.
   *
   * Resuming is a decision about where to *start*, not a rule about where to be.
   * A step named in the address is where it starts instead: that is a link
   * followed before the page's script had run, or opened in a tab of its own.
   */
  const [restore, setRestore] = useState<RestoreState | null>(initialRestore);
  const [chosenStep, setChosenStep] = useState(() =>
    startingStep(
      stepsFor(initialData, initialChecks, null, initialAccounts, initialCrew, initialRestore),
      initialStep,
    ),
  );
  /** What GitHub says about the two settings the manifest cannot set. */
  const [appChecks, setAppChecks] = useState<AppChecks | null>(initialChecks);
  const load = useCallback(async (forEmail: string) => {
    try {
      const response = await fetch(`/api/onboarding?email=${encodeURIComponent(forEmail)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readBridgeError(response));
      setData((await response.json()) as OnboardingData);
      setError(null);
      setFailures(0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'could not load onboarding');
      setFailures((count) => count + 1);
    }
  }, []);

  /**
   * A failed reload keeps the walkthrough as it was, says so, and tries again,
   * further apart each time. It used to replace the whole page with an error,
   * which unmounted every step — a pasted key, a device code on screen — and
   * nothing ever read again.
   */
  useEffect(() => {
    if (failures === 0) return;
    const timer = window.setTimeout(() => void load(email), Math.min(30_000, 2_000 * 2 ** (failures - 1)));
    return () => window.clearTimeout(timer);
  }, [failures, email, load]);

  /**
   * Connecting or disconnecting an account changes the list at once. The
   * failure banner is the health row, which is written only after `runSoon`
   * waits and the check asks the token broker. Keep reading until that row
   * changes; a fixed delay left the banner on the previous failure.
   */
  const accountsReload = useRef<number | null>(null);
  const accountsGeneration = useRef(0);
  const refreshAccounts = useCallback(() => {
    const generation = (accountsGeneration.current += 1);
    if (accountsReload.current !== null) window.clearTimeout(accountsReload.current);
    const before = githubAccountsCheckKey(data);
    void reloadUntilGitHubAccountsCheckMoves(
      before,
      async () => {
        if (accountsGeneration.current !== generation) return null;
        try {
          const response = await fetch(`/api/onboarding?email=${encodeURIComponent(email)}`, { cache: 'no-store' });
          if (!response.ok || accountsGeneration.current !== generation) return null;
          const next = (await response.json()) as OnboardingData;
          if (accountsGeneration.current !== generation) return null;
          setData(next);
          setError(null);
          setFailures(0);
          return next;
        } catch (loadError) {
          if (accountsGeneration.current === generation) {
            setError(loadError instanceof Error ? loadError.message : 'could not load onboarding');
            setFailures((count) => count + 1);
          }
          return null;
        }
      },
      (ms) =>
        new Promise((resolve) => {
          if (accountsGeneration.current !== generation) {
            resolve();
            return;
          }
          accountsReload.current = window.setTimeout(() => {
            accountsReload.current = null;
            resolve();
          }, ms);
        }),
    );
  }, [data, email]);
  useEffect(
    () => () => {
      if (accountsReload.current !== null) window.clearTimeout(accountsReload.current);
    },
    [],
  );

  // The stored address, once it arrives, is what the page runs on when the URL
  // carried none — which is every reload.
  useEffect(() => {
    if (!email && settings?.operatorEmail) {
      setEmail(settings.operatorEmail);
      void load(settings.operatorEmail);
    }
  }, [settings, email, load]);

  // Checked once for the whole walkthrough, not only while the app step is on screen.
  // Otherwise "already done: the app" is claimed by a page that never asked, and
  // the crew step gives no warning until somebody has gone back to look.
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/app-checks', { cache: 'no-store' });
        if (response.ok) setAppChecks((await response.json()) as AppChecks);
      } catch {
        // Left null, which counts as "not known to be broken".
      }
    })();
  }, [data.clientIdConfigured]);

  useEffect(() => {
    if (email === initialEmail) return;
    const timer = setTimeout(() => void load(email), 400);
    return () => clearTimeout(timer);
  }, [load, email, initialEmail]);

  const steps = useMemo(
    () => stepsFor(data, appChecks, webhookReady, accounts, crew, restore, protectedRepositories),
    [data, appChecks, webhookReady, accounts, crew, restore, protectedRepositories],
  );

  // Read once, so the progress bar and the footer know the repositories are
  // protected before anybody opens that step; the step itself tells again
  // after its button has run. Kept unknown when the bridge does not answer.
  const repositoryCount = data.repositories.length;
  useEffect(() => {
    if (repositoryCount === 0) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/repo-setup', { cache: 'no-store' });
        if (!response.ok) return;
        const { repositories } = (await response.json()) as { repositories: RepoPlan[] };
        if (live) setProtectedRepositories(repositoriesReady(repositories));
      } catch {
        // Unknown, as before.
      }
    })();
    return () => {
      live = false;
    };
  }, [repositoryCount]);

  // Asked again as the install changes, so the first step is ticked once
  // something is set up. Kept as it was when the bridge does not answer: the
  // steps are counted from it, and must not come and go.
  useEffect(() => {
    if (!initialRestore) return;
    let live = true;
    void fetch('/api/restore', { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<RestoreState>) : null))
      .then((state) => live && state && setRestore(state))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [data, initialRestore]);

  /**
   * Everything the steps are worked out from, read again after a restore, so
   * each step it set up is ticked; the step then offers the first thing it
   * did not do.
   */
  const restored = useCallback(async () => {
    const json = (path: string) =>
      fetch(path, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    const [accountsBody, enginesBody, checks, state] = await Promise.all([
      json('/api/model-accounts'),
      json('/api/engines'),
      json('/api/app-checks'),
      json('/api/restore'),
      load(email),
      reloadSettings(),
    ]);
    if (accountsBody) setAccounts(accountsFrom(accountsBody));
    if (enginesBody) setCrew(crewFromEngines(enginesBody));
    if (checks) setAppChecks(checks as AppChecks);
    if (state) setRestore(state as RestoreState);
  }, [email, load, reloadSettings]);

  const index = Math.min(chosenStep, steps.length - 1);
  const step = steps[index]!;

  /**
   * Why this step will not work, when OpenADLC has actually checked and knows.
   * Absent for a step that is merely unfinished.
   */
  const blocked = (() => {
    // What a check says is wrong on this step comes first: it is what was
    // proved, and it says what to do.
    const trouble = data.checks?.[step.key]?.failing.find((one) => !one.waiting && one.severity === 'blocking');
    if (trouble) return trouble.title;

    if (!data.clientIdConfigured) return null;

    const flowOff = appChecks?.deviceFlow === 'disabled';
    const notInstalled = appChecks?.installed === 'no';

    if (step.key === 'app' && flowOff) return 'device flow is off — connect will fail on every account';
    if (step.key === 'install' && notInstalled) {
      return `the app is not installed on ${appChecks?.repository ?? 'the owner'} yet`;
    }
    // Named on the steps that depend on them too, rather than only where they
    // are fixed — otherwise somebody meets the consequence with no idea why.
    if (step.key === 'github-accounts' && flowOff) return 'device flow is off — turn it on in “Create the app” first';
    if (step.key === 'access' && notInstalled) {
      return 'the app is not installed on the repository, so it cannot invite anybody';
    }
    return null;
  })();

  /**
   * Moves on. The crew step saves what it shows before it calls this — its
   * rows used to wait here, in two editors' saves the button reached through
   * refs; the step saves its own now, with one button.
   */
  function forward(): void {
    setChosenStep(index + 1);
  }

  return (
    <main
      className={cn(
        // Not animated. The width eased from one step's to the next's, and the
        // header's links, centred with it, slid under the pointer while it did:
        // a click aimed at "the accounts" as the page settled could land beside it.
        'mx-auto px-5 py-8 sm:px-6',
        // Wider only where a panel of what is done sits beside the steps: the
        // crew's connected accounts, and the verified model accounts.
        step.key === 'github-accounts' || step.key === 'models'
          ? 'max-w-5xl'
          : step.key === 'crew'
            ? 'max-w-4xl'
            : 'max-w-2xl',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[15px] font-semibold text-body">Set up OpenADLC</h1>
        <Link href="/?board=1" className="shrink-0 text-[12px] text-soft hover:text-body">
          back to the board
        </Link>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-attention/40 bg-attention/5 px-3 py-2 text-[12.5px] leading-relaxed text-body"
        >
          <span>
            Could not refresh from the bridge — retrying. <span className="text-muted">{error}</span>
          </span>
          <Button size="sm" onClick={() => void load(email)}>
            Try again
          </Button>
        </div>
      )}

      <Progress steps={steps} index={index} onPick={setChosenStep} />

      {/*
        Says what is already true, because arriving part-way through with only a
        progress rail to go on reads exactly like starting over — somebody who
        had created the app came back and asked whether their work had been
        lost. Where you are is taken from GitHub, so this is also the proof that
        it was. It names only steps up to the one on screen: a later step that
        is already true is not shown as done from here.
      */}
      {index !== steps.length - 1 && <AlreadyDone steps={steps} index={index} onPick={setChosenStep} />}

      <section className="mt-6">
        <p className="text-[11px] uppercase tracking-wider text-dim">
          step {index + 1} of {steps.length}
        </p>
        <h2 className="mt-1 text-[19px] font-semibold leading-tight text-body">{step.title}</h2>
        <p className="mt-1 max-w-lg text-[13px] leading-relaxed text-muted">{STEP_WHY[step.key]}</p>
        {/*
          The footer says why a step will not work, and a step that asks its
          own way forward has no footer note: device flow off was worked out
          for GitHub accounts and never shown, and "Connect it" then failed.
        */}
        {blocked && ASKS_ITS_OWN_WAY_ON.has(step.key) && (
          <p className="mt-2 max-w-lg text-[12.5px] leading-relaxed text-attention">{blocked}</p>
        )}
        {!settings && settingsError && NEEDS_SETTINGS.has(step.key) && (
          <div
            role="alert"
            className="mt-3 flex max-w-lg flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-attention/40 bg-attention/5 px-3 py-2 text-[12.5px] leading-relaxed text-body"
          >
            <span>
              Could not read the install’s settings, which this step needs. <span className="text-muted">{settingsError}</span>
            </span>
            <Button size="sm" onClick={() => void reloadSettings()}>
              Try again
            </Button>
          </div>
        )}

        {/*
          Not while nothing is connected: "No GitHub account is connected" in a
          red box was the first thing this step said, before it had asked for
          one — the step's own job, written as a failure.
        */}
        {/*
          Nor on Crew, whose checks — a seat on no account, a model not yet
          chosen — are what the step fills in: nine of them in a red box were
          the first thing it said, before it had proposed anything. What is
          still undecided is said in the step, where it is chosen.
        */}
        {!(step.key === 'github-accounts' && (data.githubAccounts ?? []).length === 0) && step.key !== 'crew' && (
          <StepTrouble check={data.checks?.[step.key]} />
        )}

        <div className="mt-5">
          {step.key === 'start' && (
            <RestoreStep
              restore={restore}
              onRestored={restored}
              next={steps[firstUndoneIn(steps)]?.title ?? null}
              onContinue={() => setChosenStep(firstUndoneIn(steps))}
            />
          )}

          {step.key === 'owner' && settings && (
            <AccountField settings={settings} save={save} onSaved={() => void load(email)} />
          )}

          {/* One failed read of the settings left these two steps blank, with
              no "Create the app" and no word of why, until a reload. */}
          {(step.key === 'owner' || step.key === 'app') && !settings && settingsError && (
            <SettingsUnread error={settingsError} reload={reloadSettings} />
          )}

          {step.key === 'repository' && (
            <>
              <p className="mb-4 max-w-lg text-[13px] leading-relaxed text-muted">
                This is the list the app can reach once it is installed, so GitHub already knows the answer, including
                the private ones.
              </p>
              <RepositoryField
                added={data.repositories}
                account={appChecks?.account ?? null}
                installUrl={appChecks?.installUrl ?? null}
                onAdded={() => void load(email)}
              />
              <p className="mt-4 max-w-lg text-[12px] leading-relaxed text-dim">
                Add every one the crew should work in. More can be added later, and any removed, in Settings under
                Repositories.
              </p>
            </>
          )}


          {step.key === 'app' && settings && (
            <>
              {/*
               * Once there is an app, the step is about finishing it, not making
               * one: the create button stayed first, the loudest thing on a step
               * that was done, and "what now?" had no answer on the page.
               */}
              {appChecks?.app ? (
                <div className="max-w-lg rounded-md border border-signal/40 bg-signal/5 p-3 text-[12.5px] leading-relaxed text-body">
                  <p className="font-semibold">
                    Your app is ready: <span className="font-mono">{appChecks.app.slug}</span>
                  </p>
                  <p className="mt-1 text-muted">
                    {appChecks.app.installations === 0
                      ? 'Next, install it on the owner — that is its own step — then continue.'
                      : 'Finish Device Flow and token expiry below, then continue.'}
                  </p>
                </div>
              ) : (
                <CreateApp organization={data.organization} />
              )}

              {data.clientIdConfigured && (
                <div className="mt-5">
                  <p className="mb-2 max-w-lg text-[12.5px] leading-relaxed text-muted">
                    GitHub’s manifest has no field for these two, so they are the only things left to do by hand — on
                    the app’s settings page. OpenADLC checks rather than trusting you to remember.
                  </p>
                  <AppChecksPanel variant="settings" onChecked={setAppChecks} onMoved={() => void load(email)} />
                </div>
              )}

              {appChecks?.app && (
                /*
                 * Which app these credentials belong to.
                 *
                 * Reusing an app means pasting a client id and a private key, and
                 * pasting is how you end up authenticated as something other than
                 * what you meant — one from an older install, or from another
                 * account. Two opaque strings accepted in silence is the version
                 * of this that cannot be checked.
                 */
                <p className="mt-4 max-w-lg rounded-md border border-signal/40 bg-signal/5 p-3 text-[12.5px] leading-relaxed text-body">
                  Using <span className="font-mono">{appChecks.app.slug}</span> (app{' '}
                  {appChecks.app.id}), installed on {appChecks.app.installations}{' '}
                  {appChecks.app.installations === 1 ? 'account' : 'accounts'}. OpenADLC did not create a second
                  one.
                </p>
              )}

              {appChecks?.app && (
                <details className="mt-4 rounded-md border border-edge bg-panel/40 p-3">
                  <summary className="cursor-pointer text-[12px] text-soft">create a different app instead</summary>
                  <div className="mt-2.5">
                    <CreateApp organization={data.organization} />
                  </div>
                </details>
              )}

              <details className="mt-4 rounded-md border border-edge bg-panel/40 p-3">
                <summary className="cursor-pointer text-[12px] text-soft">
                  already have an OpenADLC app? reuse it — or register one by hand
                </summary>
                <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted">
                  GitHub has no API for listing the apps an account owns, so OpenADLC cannot find yours — but
                  GitHub has a page for it, and both values below are on it: the client id is shown there, and
                  a private key is generated from the same screen. OpenADLC will then say which app the values
                  resolved to, so you can tell you took them from the right one. Creating a second app works
                  too, and leaves the first installed and unused.
                </p>

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <a
                    href={data.links.yourApps}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-7 items-center justify-center rounded-md border border-edge-strong bg-surface px-2.5 text-xs font-medium text-body transition-colors hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                  >
                    find your app on GitHub ↗
                  </a>
                  {appChecks?.settingsUrl && (
                    <a
                      href={appChecks.settingsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-7 items-center justify-center rounded-md border border-edge-strong bg-surface px-2.5 text-xs font-medium text-body transition-colors hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                    >
                      open {appChecks.app?.slug ?? 'this app'}’s settings ↗
                    </a>
                  )}
                </div>
                <table className="mt-2.5 w-full text-left text-[11.5px]">
                  <tbody className="text-soft">
                    {data.appPermissions.map((permission) => (
                      <tr key={`${permission.scope}-${permission.permission}`} className="border-t border-edge/70">
                        <td className="py-1.5 pr-3">{permission.permission}</td>
                        <td className="py-1.5 pr-3 text-signal">{permission.access}</td>
                        <td className="py-1.5 text-dim">{permission.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-4 space-y-4 border-t border-edge pt-3">
                  <p className="text-[11.5px] leading-relaxed text-muted">
                    If you would rather register it yourself, paste the two values here afterwards.
                  </p>
                  <InstallField
                    settingKey="githubClientId"
                    label="client id"
                    placeholder="Iv23li…"
                    settings={settings}
                    save={save}
                    onSaved={() => void load(email)}
                  />
                  <InstallField
                    settingKey="appPrivateKey"
                    label="app private key (PEM)"
                    fileAccept=".pem"
                    placeholder="-----BEGIN RSA PRIVATE KEY-----"
                    hint="GitHub downloads this as a .pem file when you generate it — choose that file rather than opening it. Without this key OpenADLC cannot invite the crew, list the repositories the app can reach, apply the repository’s rules, or point the webhook here."
                    secret
                    multiline
                    settings={settings}
                    save={save}
                    onSaved={() => void load(email)}
                  />
                </div>
              </details>
            </>
          )}

          {step.key === 'install' && (
            <>
              <p className="mb-4 max-w-lg text-[13px] leading-relaxed text-muted">
                Creating the app does not install it. Install it on the owner and choose only the repositories the crew
                will work in. Until it is installed, the next steps cannot list what it can reach, and GitHub cannot deliver
                events here.
              </p>
              {data.clientIdConfigured ? (
                <AppChecksPanel variant="install" onChecked={setAppChecks} onMoved={() => void load(email)} />
              ) : (
                <p className="max-w-lg text-[13px] leading-relaxed text-muted">
                  Create the app first. There is nothing to install until it exists.
                </p>
              )}
            </>
          )}

          {step.key === 'github-accounts' && (
            <GitHubAccountsStep
              email={email}
              signupUrl={data.links.signup}
              emailSettingsUrl={data.links.emailSettings}
              accounts={data.githubAccounts ?? null}
              seats={seatAccounts(data.bots)}
              onContinue={() => forward()}
              settings={settings}
              save={save}
              onEmail={(value) => {
                setEmail(value);
                void load(value);
              }}
              onChanged={refreshAccounts}
            />
          )}

          {step.key === 'access' && (
            <Invitations
              bots={data.bots}
              repositories={data.repositories}
              isOrganization={data.organizationIsOrg}
              inviteUrl={data.links.invite}
              canInvite={settings?.appPrivateKeyConfigured ?? false}
              onChanged={() => void load(email)}
              onGoToCrew={() => {
                setChosenStep(steps.findIndex((one) => one.key === 'crew'));
              }}
            />
          )}

          {step.key === 'models' && (
            <AccountsStep accounts={accounts} crew={crew} onAccounts={setAccounts} onCrew={setCrew} />
          )}

          {step.key === 'crew' && (
            <CrewStep
              crew={crew}
              accounts={accounts}
              onCrew={setCrew}
              onSaved={() => void load(email)}
              onContinue={() => forward()}
            />
          )}

          {step.key === 'webhook' && (
            <WebhookStep
              onStatus={(status) => setWebhookReady(status.ready)}
              onChanged={() => void load(email)}
            />
          )}

          {step.key === 'protect' && (
            <RepoSetupStep onPlans={(plans) => setProtectedRepositories(repositoriesReady(plans))} />
          )}

          {step.key === 'done' && <ReadySummary lines={readySummary(data, steps)} steps={steps} onPick={setChosenStep} />}

          {step.key === 'done' && (
            <p className="max-w-lg text-[13px] leading-relaxed text-muted">
              {data.complete ? (
                <>
                  The crew is connected.{' '}
                  <Link href="/?board=1" className="text-link hover:underline">
                    File the first request
                  </Link>{' '}
                  from the board; from here the crew works on GitHub as the accounts you connected.
                </>
              ) : (
                <>
                  Anything still open is on the steps behind this one. The{' '}
                  <Link href="/?board=1" className="text-link hover:underline">
                    board
                  </Link>{' '}
                  is there whenever you want it.
                </>
              )}
            </p>
          )}
        </div>
      </section>

      {/*
        A step that asks its own way forward has no "next" or "skip" here: on
        GitHub accounts, going on is one of the answers to "this account?",
        offered once the required accounts are in, and a skip over an account
        nobody has added meant nothing.
      */}
      <div className="mt-8 flex items-center gap-2 border-t border-edge pt-4">
        <Button onClick={() => setChosenStep(Math.max(0, index - 1))} disabled={index === 0}>
          back
        </Button>
        <span className="ml-auto flex items-center gap-2">
          {ASKS_ITS_OWN_WAY_ON.has(step.key) ? null : (
            !step.done &&
            index < steps.length - 1 && (
              // Still never hard-blocked: somebody may be fixing this in another
              // tab, or doing the steps out of order, and a wizard that refuses to
              // advance is one people work around. But where OpenADLC *knows* the
              // step will not work, it says so here instead of a bare "skip".
              <span className={cn('text-[11px]', blocked ? 'text-attention' : 'text-dim')}>
                {blocked ?? 'you can come back to this'}
              </span>
            )
          )}
          {index < steps.length - 1 && !ASKS_ITS_OWN_WAY_ON.has(step.key) && (
            <Button variant="primary" onClick={() => forward()}>
              {step.key === 'start' && !step.done
                ? 'start fresh'
                : forwardLabel({ done: step.done, blocked: Boolean(blocked) })}
            </Button>
          )}
          {index === steps.length - 1 && (
            <Link href="/?board=1">
              <Button variant="primary">go to the board</Button>
            </Link>
          )}
        </span>
      </div>
    </main>
  );
}

/** More than this many and they are one line to open, not a wall above the step that fixes them. */
const TROUBLE_SHOWN = 2;

/**
 * What the health checks say is wrong on this step, each with the thing to do
 * and where — the same words as its card on the board. Nothing when nothing is.
 * Seven seats without an account were seven red cards above the step, which
 * pushed the one place they are connected below the fold; past a couple, they
 * fold into one line.
 */
export function StepTrouble({ check }: { check: StepCheck | undefined }) {
  const failing = (check?.failing ?? []).filter((one) => !one.waiting);
  if (failing.length === 0) return null;
  if (failing.length > TROUBLE_SHOWN) {
    const blocking = failing.some((one) => one.severity === 'blocking');
    return (
      <details
        className={cn(
          'mt-4 max-w-2xl rounded-md border px-3 py-2 text-[12.5px]',
          blocking ? 'border-alarm/35 bg-alarm/5' : 'border-attention/35 bg-attention/5',
        )}
      >
        <summary className="cursor-pointer font-medium text-body">
          {failing.length} things still to do on this step — each is below
        </summary>
        <StepTroubleList failing={failing} />
      </details>
    );
  }
  return <StepTroubleList failing={failing} />;
}

function StepTroubleList({ failing }: { failing: StepCheck['failing'] }) {
  return (
    <ul className="mt-4 flex max-w-2xl flex-col gap-2">
      {failing.map((one) => (
        <li
          key={one.id}
          className={cn(
            'rounded-md border px-3 py-2.5 text-[12.5px] leading-relaxed',
            one.severity === 'blocking' ? 'border-alarm/35 bg-alarm/5' : 'border-attention/35 bg-attention/5',
          )}
        >
          <p className="font-medium text-body">{one.title}</p>
          {/* The same words as the card on the board, which reads them as markdown: a fix that is two places on GitHub is a numbered list with a link in each. */}
          {one.detail && <Markdown text={one.detail} className="text-muted" />}
          {one.action?.url && (
            <a href={one.action.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-link hover:underline">
              {one.action.label} ↗
            </a>
          )}
          {one.action?.href && (
            <Link href={one.action.href} className="mt-1 inline-block text-link hover:underline">
              {one.action.label}
            </Link>
          )}
          {one.action?.command && <code className="mt-1 inline-block font-mono text-[11.5px] text-soft">{one.action.command}</code>}
        </li>
      ))}
    </ul>
  );
}

/**
 * A way to one step: a link with the step in its address, which a plain
 * click follows in place, by position.
 *
 * These were buttons, which do nothing until the page's script has run. The
 * walkthrough is rendered on the server and looks ready before that, so a
 * click in the meantime did nothing at all. A link is followed either way:
 * before the script runs, to the same step rendered by the server, and into a
 * new tab when that is what was asked for.
 */
function StepLink({
  step,
  position,
  onPick,
  current,
  label,
  className,
  children,
}: {
  step: WizardStep;
  position: number;
  onPick: (position: number) => void;
  current?: boolean;
  label?: string;
  className: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={stepHref(step.key)}
      onClick={(event) => {
        // A new tab or window is the browser's to open, from the address.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onPick(position);
      }}
      title={label}
      aria-label={label}
      aria-current={current ? 'step' : undefined}
      className={className}
    >
      {children}
    </a>
  );
}

/**
 * A finished step that is on screen or behind it.
 *
 * One ahead of the step on screen stays unmarked. A fact stored early — an
 * owner saved, a tunnel raised for the app — is true, and painting it green
 * before the person reaches that step reads as if they had already done it.
 */
function reached(step: WizardStep, position: number, index: number): boolean {
  return step.done && position <= index;
}

function Progress({
  steps,
  index,
  onPick,
}: {
  steps: readonly WizardStep[];
  index: number;
  onPick: (next: number) => void;
}) {
  return (
    <div className="mt-5 flex gap-1.5">
      {steps.map((step, position) => (
        <StepLink
          key={step.key}
          step={step}
          position={position}
          onPick={onPick}
          current={position === index}
          label={step.title}
          className={cn(
            'h-1.5 flex-1 rounded-full transition-colors',
            position === index
              ? 'bg-link'
              : reached(step, position, index)
                ? 'bg-signal/60'
                : 'bg-edge-strong hover:bg-edge-strong/70',
          )}
        />
      ))}
    </div>
  );
}

/**
 * What is already true, each a link to its step, which it reaches the way the
 * progress bar reaches it: by its position among the steps. Only steps the
 * person has reached: a later one that happens to be true is not listed.
 */
function AlreadyDone({
  steps,
  index,
  onPick,
}: {
  steps: readonly WizardStep[];
  index: number;
  onPick: (position: number) => void;
}) {
  const done = steps.flatMap((step, position) => (reached(step, position, index) ? [{ step, position }] : []));
  if (done.length === 0) return null;

  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted">
      <span className="text-signal">✓</span>
      <span>already done:</span>
      {done.map(({ step, position }, n) => (
        <StepLink
          key={step.key}
          step={step}
          position={position}
          onPick={onPick}
          className="text-soft underline decoration-edge-strong underline-offset-2 hover:text-body"
        >
          {step.short}
          {n < done.length - 1 ? ',' : ''}
        </StepLink>
      ))}
    </p>
  );
}
