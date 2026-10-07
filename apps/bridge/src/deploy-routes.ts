import { DELIVERY_RULES_PATH, type DeliveryRules } from '@fleetadlc/shared';
import type { DeployPipeline } from './deploy-pipeline.js';
import type { EffectiveDelivery } from './delivery-rules.js';
import { HttpFailure, type Router } from './router.js';

/**
 * A person's answer to a promote held for them (`DeployPipeline`), from its
 * Needs you card.
 *
 * A repository whose rules say a person approves production, on a plan where
 * GitHub cannot hold a reviewer on the `production` environment, has each
 * promote held by the bridge after a green smoke. The card offers two things:
 * release this promote, which dispatches it as the app; or switch the
 * repository to automatic delivery, a soak on testing, the smoke and an
 * automatic rollback, which turns what is held into soaks. Neither approves
 * anything in GitHub: the bridge dispatches a workflow, and that is all.
 */

type Repo = { id: string; name: string; fullName: string; defaultBranch: string };

/** The soak a repository switched to automatic waits at least, on testing, before its promote. */
export const AUTOMATIC_SOAK_MINUTES = 30;

export interface DeployRouteDeps {
  repo(name: string): Promise<Repo | null>;
  pipeline: Pick<DeployPipeline, 'releaseHeld'>;
  delivery: { get(repo: Repo): Promise<EffectiveDelivery>; forget(repoFullName: string): void };
  /** Writes the repository's own rules (`repos.delivery_rules`), which apply where it has no `.github/fleetadlc.yml`. */
  setRules(repoId: string, rules: DeliveryRules): Promise<void>;
  /** Records how the repository's production ships (`repos.setProductionChoice`), as repository setup does. */
  recordChoice(repoId: string, choice: { approval: 'auto'; soakMinutes: number; reviewers: string[] }): Promise<void>;
  /** The repository's promotes held for a person; `deployRuns.heldForPerson`. */
  held(repoId: string): Promise<{ sha: string }[]>;
  /** Holds a promote until `after` instead; `deployRuns.holdPromote`. */
  soak(repoId: string, sha: string, after: Date, detail: string): Promise<void>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
  now?: () => number;
}

/** Where a person edits a repository's rules on GitHub: the file always wins over the row. */
export function rulesFileEditUrl(repo: { fullName: string; defaultBranch: string }): string {
  return `https://github.com/${repo.fullName}/edit/${repo.defaultBranch}/${DELIVERY_RULES_PATH}`;
}

export function registerDeployRoutes(router: Router, deps: DeployRouteDeps): void {
  const repoOf = async (name: string | undefined): Promise<Repo> => {
    const repo = await deps.repo(name ?? '');
    if (!repo) throw new HttpFailure(404, `OpenADLC does not work in a repository named ${name ?? ''}`);
    return repo;
  };

  /** Releases a held promote to production: dispatched now, as the app. */
  router.post('/v1/repos/:repo/deploys/:sha/release', async ({ params, identity }) => {
    const repo = await repoOf(params.repo);
    const sha = params.sha ?? '';
    const outcome = await deps.pipeline.releaseHeld(repo, sha, identity);
    if (outcome.released) return { released: true, line: outcome.line };
    if (!outcome.held) throw new HttpFailure(409, `${repo.name}@${sha.slice(0, 7)} is not held for a person: its promote was released already, or never held`);
    // GitHub refused it or could not be reached: still held, for another try.
    throw new HttpFailure(502, `${outcome.line}. It is still held; release it again once GitHub answers`);
  });

  /**
   * Switches a repository to automatic delivery: no person approves
   * production, and each promote waits a soak of at least 30 minutes on
   * testing, then the smoke, with a failed production deploy rolled back.
   * What was held for a person becomes a soak ending after it.
   */
  router.post('/v1/repos/:repo/delivery/automatic', async ({ params, identity }) => {
    const repo = await repoOf(params.repo);
    const delivery = await deps.delivery.get(repo);
    if (delivery.source === 'file') {
      throw new HttpFailure(
        409,
        `${repo.fullName}'s rules come from ${DELIVERY_RULES_PATH}, which always wins over a setting here. ` +
          `Set \`production.approval: auto\` there: ${rulesFileEditUrl(repo)}`,
      );
    }
    const soakMinutes = Math.max(delivery.rules.production.soakMinutes, AUTOMATIC_SOAK_MINUTES);
    // The same choice repository setup records, which fills what the rules
    // leave out. A row of rules is rewritten too, since what it says wins
    // over the choice; none is made where there is none, because a row would
    // also take the place of Settings' testing-deploy choice.
    await deps.recordChoice(repo.id, { approval: 'auto', soakMinutes, reviewers: [] });
    if (delivery.source === 'repository') {
      await deps.setRules(repo.id, { ...delivery.rules, production: { ...delivery.rules.production, approval: 'auto', soakMinutes } });
    }
    // The rules are remembered for minutes; the pipeline and the board read them now.
    deps.delivery.forget(repo.fullName);

    const after = new Date((deps.now ?? Date.now)() + soakMinutes * 60_000);
    const soaking: string[] = [];
    for (const run of await deps.held(repo.id)) {
      await deps.soak(repo.id, run.sha, after, `soaking on testing until ${after.toISOString()}: switched to automatic by ${identity}`);
      soaking.push(run.sha);
    }
    await deps
      .audit({ actor: identity, action: 'delivery.switched_automatic', target: repo.name, payload: { soakMinutes, soaking } })
      .catch(() => undefined);
    return { repo: repo.name, approval: 'auto', soakMinutes, soaking, promoteAfter: soaking.length > 0 ? after.toISOString() : null };
  });
}
