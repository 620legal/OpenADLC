import type { RuleReport } from '@fleetadlc/github';
import type { CheckResult, HealthCheck } from '../types.js';
import { stepHref } from '../words.js';

export interface RulesReader {
  /**
   * What `fleetadlc github apply` sets on each repository, read as the app — the
   * same reading the walkthrough's last step lists before it applies anything.
   * `canApply` is false when OpenADLC could not read it as the app, and
   * `detail` then says why: no app, no key, the app not installed there.
   */
  plan(): Promise<{ repository: string; rules: RuleReport[]; canApply: boolean; detail?: string }[]>;
  /**
   * The names GitHub refused when the rules were last applied to a
   * repository — a plan that cannot hold a ruleset, say. Not asked of it
   * again: applying cannot put there what GitHub will not keep.
   */
  refused(repository: string): Promise<ReadonlySet<string>>;
}

/** What a pull request needs of the repository to land at all: its code owner, the checks it waits on, auto-merge. */
const LANDING = new Set(['CODEOWNERS', 'required status checks', 'auto-merge']);

/**
 * A ruleset drift that holds every pull request, not only protection: an
 * approval required after the merge line's own update, which nobody is asked for.
 */
const STUCK_RULE = /require_last_push_approval is true/;

/**
 * What the last apply's outcomes say GitHub refused, for `RulesReader.refused`:
 * only what it skipped. A plan limit is not taken from here: the plan already
 * reports one that still applies as `unsupported`, from the stored limits, and
 * drops it when the repository's plan state changes. Reading `unsupported`
 * lines too kept a missing production reviewer hidden after the repository
 * went public; a ruleset the plan refused is skipped, not unsupported, so the
 * apply names those apart (`planRefused`) and they are left out here too.
 */
export function skippedByLastApply(outcomes: readonly unknown[], planRefused: readonly unknown[] = []): Set<string> {
  const byPlan = new Set(planRefused.filter((one): one is string => typeof one === 'string'));
  return new Set(
    outcomes
      .filter((one): one is string => typeof one === 'string' && /^skipped /.test(one))
      .map((one) => one.slice(one.indexOf(' ') + 1))
      .filter((name) => !byPlan.has(name)),
  );
}

/**
 * The repository is protected the way `fleetadlc github apply` protects it: the
 * rulesets that require a review, the review gate and signed commits on the
 * default branch, the environments, and a CODEOWNERS that makes the lead
 * reviewer's review the one that counts. Read from GitHub as the app, rule by
 * rule.
 *
 * A warning when only protection is missing or has drifted: where GitHub
 * holds nothing, OpenADLC's own gates — the review gate, the merge line and
 * the lease it holds a crew pull request to — still do. A blocking card when
 * what is wrong stops anything landing: CODEOWNERS, the required status
 * checks, auto-merge, or an approval required after the last push. What it
 * guards against is protection that was there and was changed, or never went
 * on.
 */
export function rulesCheck(reader: RulesReader): HealthCheck {
  return {
    id: 'repo-rules',
    proves: 'Each repository is protected the way OpenADLC sets it: the review gate, signed commits and a code owner on the default branch',
    how: 'reads each repository’s rulesets, environments and CODEOWNERS from GitHub as the app, and compares them with what applying the rules writes',
    everyMinutes: 60,
    steps: [],
    async run() {
      const plans = await reader.plan();
      const results: CheckResult[] = [];
      for (const plan of plans) {
        const subject = plan.repository;
        if (!plan.canApply) {
          // The plan's own reason: every one read "holds no app key", and sent
          // a person to add a key the install had, for an app not installed here.
          results.push({
            subject,
            ok: null,
            reason: plan.detail
              ? `the repository’s rules could not be read as the app: ${plan.detail}`
              : 'OpenADLC holds no app key, so it cannot read the repository’s rules as the app',
          });
          continue;
        }
        if (plan.rules.length === 0) {
          results.push({ subject, ok: null, reason: 'GitHub did not describe the repository’s rules' });
          continue;
        }
        const refused = await reader.refused(plan.repository).catch(() => new Set<string>());
        const wrong = plan.rules.filter(
          (rule) =>
            (rule.state === 'drifted' || rule.state === 'missing') &&
            // What GitHub would not keep is not asked of it again. The status
            // checks are the exception: OpenADLC leaves that rule off itself while
            // nothing publishes them, and applying is what writes the workflow.
            !(rule.state === 'missing' && refused.has(rule.name) && rule.name !== 'required status checks'),
        );
        if (wrong.length === 0) {
          results.push({ subject, ok: true, fixed: `${plan.repository} is protected the way OpenADLC sets it again` });
          continue;
        }
        // Some of it is not protection at all but whether anything can land:
        // with these wrong, every pull request the crew opens waits forever.
        const stuck = wrong.filter((rule) => LANDING.has(rule.name) || STUCK_RULE.test(rule.detail));
        results.push({
          subject,
          ok: false,
          severity: stuck.length > 0 ? 'blocking' : 'warning',
          title:
            stuck.length > 0
              ? `Nothing the crew builds can land in ${plan.repository}`
              : `${plan.repository} is not protected the way OpenADLC sets it`,
          // One line each: three reasons run together with semicolons were a
          // paragraph nobody could scan on the card.
          detail:
            `${wrong.map((rule) => `- **${rule.name}:** ${rule.detail || rule.state}`).join('\n')}\n\n` +
            'Apply the rules again on the walkthrough’s last step, which lists what it will change first.',
          action: { label: stuck.length > 0 ? 'Fix the repository' : 'Protect the repository', href: stepHref('protect') },
          facts: { repository: plan.repository },
        });
      }
      return results;
    },
  };
}
