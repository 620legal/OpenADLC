/**
 * What the first-run page can honestly say is ready, from what the bridge
 * reports. A check that cannot be answered — the app key is not held, GitHub
 * did not answer — is left off the list rather than shown as passing: a tick
 * that was never checked is worse than no tick.
 */

export interface ReadinessCheck {
  ok: boolean;
  text: string;
  /** Where to fix it, when it is not ok. */
  fix?: { href: string; label: string };
}

/** The ruleset OpenADLC puts on a repository's default branch; `MAIN_RULESET` in `@fleetadlc/github`. */
const MAIN_RULESET = 'fleetadlc: main';

interface PlanReport {
  name: string;
  state: string;
}

export interface RepoPlanView {
  repository: string;
  rules: PlanReport[];
  canApply: boolean;
}

/**
 * Whether the repository merges only what passed review: OpenADLC's ruleset on
 * its default branch is there as declared, and the checks it requires — the
 * review gate among them — can be published there.
 */
export function reviewGateCheck(plans: readonly RepoPlanView[] | null | undefined, fullName: string | null): ReadinessCheck | null {
  if (!plans || !fullName) return null;
  const plan = plans.find((one) => one.repository === fullName);
  if (!plan || !plan.canApply) return null;

  const name = fullName.split('/').pop() ?? fullName;
  const main = plan.rules.find((rule) => rule.name === MAIN_RULESET);
  if (!main) return null;
  // The bridge reports the checks `missing` when they cannot be published
  // there (`checkRepoRules`), and it did check: that is a gate not held, with
  // the fix that writes the workflow. This looked for `unsupported`, which the
  // bridge never sends, and ticked a repository whose checks were missing.
  const checksMissing = plan.rules.some((rule) => rule.name === 'required status checks' && rule.state !== 'present');

  if (main.state === 'present' && !checksMissing) return { ok: true, text: `${name} merges only what passed review` };
  if (main.state === 'missing' || main.state === 'drifted' || checksMissing) {
    return {
      ok: false,
      text: `${name} does not require the review gate yet`,
      fix: { href: '/onboarding?step=protect', label: 'Set up the repository' },
    };
  }
  return null;
}

/** Whether GitHub's deliveries reach this bridge, as the webhook step checks it. */
export function webhookCheck(status: { ready?: unknown } | null | undefined): ReadinessCheck | null {
  if (!status || typeof status.ready !== 'boolean') return null;
  return status.ready
    ? { ok: true, text: 'GitHub reaches OpenADLC' }
    : {
        ok: false,
        text: 'GitHub cannot reach OpenADLC yet',
        fix: { href: '/onboarding?step=webhook', label: 'Let GitHub in' },
      };
}

/**
 * Whether each bot has its own account to act as, and can still sign in as it.
 * A revoked or expired sign-in still counts as an account, and used to tick
 * "9 bots connected to GitHub" for a crew that could not act.
 */
export function crewCheck(counts: { total: number; connected: number; needsReconnecting?: number }): ReadinessCheck | null {
  if (counts.total === 0) return null;
  const lost = counts.needsReconnecting ?? 0;
  if (lost > 0) {
    return {
      ok: false,
      text: `${lost} ${lost === 1 ? 'bot needs' : 'bots need'} reconnecting`,
      fix: { href: '/onboarding?step=github-accounts', label: 'Reconnect' },
    };
  }
  if (counts.connected === counts.total) {
    return { ok: true, text: `${counts.total} bots connected to GitHub` };
  }
  return {
    ok: false,
    text: `${counts.connected} of ${counts.total} bots connected`,
    fix: { href: '/onboarding?step=github-accounts', label: 'Connect the rest' },
  };
}
