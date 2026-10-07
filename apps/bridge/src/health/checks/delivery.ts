import type { DeliveryRules } from '@fleetadlc/shared';
import type { CheckResult, HealthCheck } from '../types.js';
import { stepHref } from '../words.js';

/** A repository's production environment as GitHub holds it. */
export interface ProductionEnvironment {
  /**
   * Who GitHub asks to approve a deployment, each a person or a team; empty
   * when none is required. Kept apart because every member of a team may
   * approve, and a team's slug compared with the crew's logins never matched.
   */
  reviewers: { kind: 'user' | 'team'; name: string }[];
  /** Minutes GitHub holds a deployment before it runs. */
  waitTimer: number;
  /**
   * The branches a deployment may come from: its custom branch policies'
   * names, `protected` when it admits every protected branch, null when it has
   * no branch policy, and undefined when the policies could not be read.
   */
  branches?: string[] | 'protected' | null;
}

export interface DeliveryReader {
  repos(): Promise<{ name: string; fullName: string; defaultBranch: string }[]>;
  /** The repository's delivery rules, as the bridge reads them; see `delivery-rules.ts`. */
  rules(repo: { name: string; fullName: string }): Promise<DeliveryRules | null>;
  /** GitHub's `production` environment, null when it is not there, undefined when GitHub could not be asked. */
  production(fullName: string): Promise<ProductionEnvironment | null | undefined>;
  /** Whether the repository's plan refused the environment's rules when they were last applied. */
  planRefused(fullName: string): Promise<boolean>;
  /** Every login the crew works under. */
  crewLogins(): Promise<string[]>;
}

/**
 * Production is held the way the repository's rules say, and by nobody in
 * the crew.
 *
 * A bot never approves a deploy; the repository's GitHub rules do. The
 * bridge dispatches a promote and leaves it to the `production` environment:
 * its required reviewers when the rules say `approval: reviewers`, its wait
 * timer when they say `auto`. So the environment is the gate, and two things
 * break it without anything failing loudly — a crew account among its
 * reviewers, which could approve a deploy it built (GitHub's "prevent self
 * review" stops only the account that started the run); and an environment
 * that holds for nobody though the rules say a person approves, which ships
 * to production unseen. Both are what this looks for, and a branch policy
 * that admits anything but the default branch: the crew's own branches are
 * protected, so a workflow pushed to one could deploy. `fleetadlc github
 * apply` writes the environment the rules call for.
 *
 * Where GitHub's plan refused the reviewer (a private repository on Free, Pro
 * or Team), the bridge holds each promote for a person itself, in Needs you
 * (`DeployPipeline`), so production is still held: it passes, and says what
 * holds it (`heldBy: 'fleetadlc'`). It used to pass in silence while the
 * promote ran with nobody approving.
 */
export function deliveryCheck(reader: DeliveryReader): HealthCheck {
  return {
    id: 'production-rules',
    proves: 'Each repository’s production environment holds deploys the way its delivery rules say, and no crew account can approve one',
    how: 'reads each repository’s production environment on GitHub and compares its reviewers and wait timer with .github/fleetadlc.yml, and its branch policy with the default branch',
    everyMinutes: 60,
    steps: [],
    async run() {
      const results: CheckResult[] = [];
      const crew = new Set((await reader.crewLogins()).map((login) => login.toLowerCase()));
      for (const repo of await reader.repos()) {
        const subject = repo.fullName;
        const rules = await reader.rules(repo).catch(() => null);
        if (!rules) {
          results.push({ subject, ok: null, reason: 'its delivery rules could not be read' });
          continue;
        }
        if (rules.production.on === 'none') {
          results.push({ subject, ok: true });
          continue;
        }
        const environment = await reader.production(repo.fullName).catch(() => undefined);
        if (environment === undefined) {
          results.push({ subject, ok: null, reason: 'GitHub could not be asked for its production environment' });
          continue;
        }
        if (environment === null) {
          // That it is missing is the repository-rules check's to say.
          results.push({ subject, ok: null, reason: 'it has no production environment; the repository rules check says so' });
          continue;
        }

        const crewReviewers = environment.reviewers
          .filter((reviewer) => reviewer.kind === 'user' && crew.has(reviewer.name.toLowerCase()))
          .map((reviewer) => reviewer.name);
        if (crewReviewers.length > 0) {
          results.push({
            subject,
            ok: false,
            severity: 'blocking',
            title: `A crew account can approve ${repo.fullName}’s production deploy`,
            detail:
              `${crewReviewers.join(', ')} ${crewReviewers.length === 1 ? 'is' : 'are'} among the production environment’s required reviewers. ` +
              'A bot never approves a deploy; the repository’s GitHub rules do. Remove the crew from the reviewers in the repository’s ' +
              'Settings → Environments → production, then check again.',
            action: { label: 'Open environments', url: `https://github.com/${repo.fullName}/settings/environments` },
            facts: { crewReviewers },
          });
          continue;
        }

        const refused = await reader.planRefused(repo.fullName).catch(() => false);
        if (rules.production.approval === 'reviewers' && environment.reviewers.length === 0 && refused) {
          results.push({ subject, ok: true, facts: { approval: 'reviewers', heldBy: 'fleetadlc' } });
          continue;
        }
        if (rules.production.approval === 'reviewers' && environment.reviewers.length === 0) {
          results.push({
            subject,
            ok: false,
            severity: 'warning',
            title: `${repo.fullName}’s production deploys wait for nobody`,
            detail:
              'Its delivery rules say a person approves production, and its production environment has no required reviewer, so a promote ' +
              'runs as soon as it is dispatched. Choose how production ships in the walkthrough’s Protect step: name who approves it, or ' +
              'ship automatically after a soak on testing. From a terminal: `fleetadlc github apply --production reviewers --reviewer <login>`.',
            action: { label: 'Choose how production ships', href: stepHref('protect') },
          });
          continue;
        }
        if (rules.production.approval === 'auto' && environment.reviewers.length > 0) {
          results.push({
            subject,
            ok: false,
            severity: 'warning',
            title: `${repo.fullName}’s production deploys wait for a person its rules do not ask for`,
            detail:
              'Its delivery rules say production needs no approval, and its production environment still requires a reviewer, so every ' +
              'promote waits for one. Run `fleetadlc github apply` to write the environment the rules call for, or set ' +
              '`approval: reviewers` in .github/fleetadlc.yml.',
            action: { label: 'Apply the repository rules', command: 'fleetadlc github apply' },
          });
          continue;
        }
        const branches = environment.branches;
        const heldToDefault = Array.isArray(branches) && branches.length === 1 && branches[0] === repo.defaultBranch;
        if (branches !== undefined && !heldToDefault && !refused) {
          const admits =
            branches === 'protected'
              ? 'every protected branch, and the crew’s own branches are protected'
              : branches === null
                ? 'any branch, having no branch policy'
                : branches.length === 0
                  ? 'no branch at all'
                  : branches.join(', ');
          results.push({
            subject,
            ok: false,
            severity: 'warning',
            title: `${repo.fullName}’s production deploys can come from more than ${repo.defaultBranch}`,
            detail:
              `Its production environment’s branch policy admits ${admits}, not ${repo.defaultBranch} alone, so a workflow on another ` +
              `branch could deploy to production or read its secrets. Run \`fleetadlc github apply\` to hold it to ${repo.defaultBranch}.`,
            action: { label: 'Apply the repository rules', command: 'fleetadlc github apply' },
            facts: { branches },
          });
          continue;
        }
        // A team's members cannot be listed without the app reading the
        // organization's members, which it is not given, so a crew account in
        // one cannot be ruled out: a person is asked rather than told it passes.
        const owner = repo.fullName.split('/')[0] ?? repo.fullName;
        const teams = environment.reviewers.filter((reviewer) => reviewer.kind === 'team').map((reviewer) => `@${owner}/${reviewer.name}`);
        if (teams.length > 0) {
          results.push({
            subject,
            ok: null,
            reason:
              `${teams.join(', ')} ${teams.length === 1 ? 'is a team' : 'are teams'} among its production reviewers, and OpenADLC cannot ` +
              `see who is in ${teams.length === 1 ? 'it' : 'them'}. A crew account in ${teams.length === 1 ? 'it' : 'one'} could approve ` +
              'a deploy it built, so a person should confirm no crew account is a member.',
            facts: { teams },
          });
          continue;
        }
        results.push({ subject, ok: true, facts: { approval: rules.production.approval, waitTimer: environment.waitTimer } });
      }
      return results;
    },
  };
}

/**
 * GitHub's environment, as the check reads it: who reviews, how long it waits,
 * and which branches may deploy. `policies` are its custom branch policies,
 * listed apart; undefined when they could not be.
 */
export function productionEnvironmentOf(
  body: {
    protection_rules?: { type?: string; reviewers?: { type?: string; reviewer?: { login?: string; slug?: string } }[]; wait_timer?: number }[];
    deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
  },
  policies?: { name?: string; type?: string }[],
): ProductionEnvironment {
  const rules = body.protection_rules ?? [];
  const reviewers = rules
    .filter((rule) => rule.type === 'required_reviewers')
    .flatMap((rule) => rule.reviewers ?? [])
    .flatMap((entry): ProductionEnvironment['reviewers'] => {
      if (entry.type === 'Team') return entry.reviewer?.slug ? [{ kind: 'team', name: entry.reviewer.slug }] : [];
      return entry.reviewer?.login ? [{ kind: 'user', name: entry.reviewer.login }] : [];
    });
  const waitTimer = rules.find((rule) => rule.type === 'wait_timer')?.wait_timer ?? 0;
  const policy = body.deployment_branch_policy;
  const branches = policy?.protected_branches
    ? 'protected'
    : policy?.custom_branch_policies
      ? policies?.map((one) => `${one.type === 'tag' ? 'tag ' : ''}${one.name ?? ''}`)
      : null;
  return { reviewers, waitTimer, branches };
}
