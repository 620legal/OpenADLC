import { audit, deployRuns, issues, repos } from '@fleetadlc/db';
import type { DeliveryRules } from '@fleetadlc/shared';
import type { EffectiveDelivery } from './delivery-rules.js';
import type { SendBackResult } from './send-back.js';
import { issueNumberFromBranch } from './work.js';

/**
 * A merged change's way to production, by the repository's rules.
 *
 * It was the deploy bot's task after every merge, and a person's approval of
 * production in GitHub. Now the rules (`.github/fleetadlc.yml`, see
 * `delivery-rules.ts`) decide, and the bridge does what they say, as the
 * OpenADLC app, or as the automation account where the app cannot act on the
 * repository: a merge dispatches the testing deploy; a green smoke on
 * testing dispatches the promote; a red one is reverted as before and sends
 * the change back to build; a production deploy that fails is handled by
 * where the promote stopped (`onProductionFailed`). Production waits only on what GitHub's
 * `production` environment holds it for — its required reviewers, or its wait
 * timer as the soak. OpenADLC never approves an environment for anybody: it
 * dispatches, and GitHub's rules do the rest. A repository whose plan holds no
 * environment rules has its soak held here instead (`deploy_runs.promote_after`),
 * and a promote its rules say a person approves is held here for one
 * (`deploy_runs.promote_held_at`): a Needs you card releases it, or switches
 * the repository to automatic delivery. Dispatched at once, it ran with
 * nobody approving, because GitHub held nothing.
 *
 * Every step is recorded once per commit (`deploy_runs`), so a redelivered
 * event or the sweep that asks again does nothing twice.
 *
 * Nothing is dispatched on rules that could not be read (`readError`): the
 * fallback a failed read gives is Settings' default, which promoted a
 * repository that soaks for an hour at once. The step is left unclaimed, for
 * the deploy sweep to take once the rules read.
 */

/** What dispatching a workflow takes: the app's client, or the automation account's where there is no app. */
export interface DispatchClient {
  /** Who it acts as, for the audit trail: `fleetadlc-app`, or the automation account's login. */
  readonly actingAs?: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  listPullsForCommit(repo: string, sha: string): Promise<{ number: number; headRef: string }[]>;
}

export interface DeployPipelineDeps {
  delivery: { get(repo: { id: string; name: string; fullName: string; defaultBranch: string }): Promise<EffectiveDelivery> };
  /** The OpenADLC app's client for a repository, else the automation account's, else null. */
  client: (repoFullName: string) => Promise<DispatchClient | null>;
  /** Sends a change back to build; see `SendBack.fromBridge`. */
  sendBack: { fromBridge(input: { repoName: string; issueNumber: number; from: 'merged'; reason: string }): Promise<SendBackResult> } | null;
  now?: () => number;
}

type Repo = { id: string; name: string; fullName: string; defaultBranch: string };

/** Who a step was taken as: the app, or the automation account the dispatch fell back to. */
const actorOf = (client: DispatchClient): string => client.actingAs ?? 'fleetadlc-app';

/** A workflow by the name the rules give it, as the file GitHub dispatches. */
export function workflowFile(name: string): string {
  return /\.ya?ml$/.test(name) ? name : `${name}.yml`;
}

/** A promote step that moves traffic, by its name: OpenADLC's own is "shift traffic to it". */
export const SHIFT_STEP = /shift.traffic/i;

/** A promote step that smokes the new revision before traffic moves: "smoke the new revision by its tag". */
export const SMOKE_STEP = /smoke/i;

/**
 * Where a failed promote stopped, from its run's steps.
 *
 * - `never-ran`: no step ran — the deployment was rejected, or cancelled
 *   before it started, or is still waiting.
 * - `smoke`: the smoke of the new revision failed, before the traffic shift.
 * - `shift`: the step that moves traffic was reached and failed or was cancelled.
 * - `other`: another step failed (the candidate check, the build, a migration,
 *   the deploy at zero traffic, or a step after the shift).
 * - `unknown`: the steps could not be read, or have no traffic shift to place
 *   the failure against — the template's promote is one `promote` step — or
 *   none of them failed.
 */
export type PromoteFailure = 'never-ran' | 'smoke' | 'shift' | 'other' | 'unknown';

type Step = { name?: string | null; status?: string | null; conclusion?: string | null };

export function promoteFailure(jobs: readonly { steps?: readonly Step[] | null }[] | null): PromoteFailure {
  if (!jobs) return 'unknown';
  if (!jobs.some((job) => (job.steps ?? []).some((step) => step.conclusion && step.conclusion !== 'skipped'))) return 'never-ran';
  const steps = jobs.map((job) => job.steps ?? []).find((list) => list.some((step) => SHIFT_STEP.test(step.name ?? '')));
  if (!steps) return 'unknown';
  const shiftAt = steps.findIndex((step) => SHIFT_STEP.test(step.name ?? ''));
  const broke = (step: Step) => step.conclusion === 'failure' || step.conclusion === 'cancelled';
  const failedAt = steps.findIndex(broke);
  if (failedAt < 0) return 'unknown';
  if (failedAt === shiftAt) return 'shift';
  return failedAt < shiftAt && SMOKE_STEP.test(steps[failedAt]?.name ?? '') ? 'smoke' : 'other';
}

/**
 * Whether a red smoke's revert task was opened (`Webhooks.revertTesting`), and
 * why not when it was not. What the send-back and the reopened issue say comes
 * from it: they said the change was being reverted whatever happened, and an
 * operator could believe testing was safe while it still served the commit.
 */
export type RevertOutcome =
  | { opened: true }
  | { opened: false; reason: 'no-deploy-bot' | 'refused' | 'busy' | 'held' | 'error'; why: string };

/** What a red smoke's send-back says of the revert. */
export function revertSaid(revert: RevertOutcome): string {
  return revert.opened ? 'The change is being reverted.' : `No revert is running: ${revert.why}.`;
}

/**
 * What a send-back says of a rollback: that production was rolled back only
 * once its run succeeded. It said so the moment the rollback was dispatched,
 * while the run could still wait behind a promote, or be cancelled.
 */
export function rollbackSaid(run: { rollbackDispatchedAt: string | null; rollbackConclusion: string | null }): string {
  if (run.rollbackConclusion === 'success') return ' Production was rolled back.';
  if (run.rollbackConclusion === 'failure') return ' The rollback of production failed.';
  return run.rollbackDispatchedAt ? ' A rollback of production was dispatched.' : '';
}

/** What a dispatch did: its log line, and why nothing was dispatched when nothing was. */
interface Dispatched {
  ok: boolean;
  line: string;
  why?: string;
}

/** How far back the deploy sweep looks for a send-back still owed. */
const SEND_BACK_RETRY_MS = 7 * 24 * 3600 * 1000;

/** How far back the deploy sweep looks for a promote whose dispatch failed. */
export const RETRY_WITHIN_MS = SEND_BACK_RETRY_MS;

/** How long after its dispatch a rollback's run may be missing from GitHub's list before it is taken as never started. */
export const ROLLBACK_APPEARS_MS = 10 * 60_000;

/** Allowance for GitHub's clock against the database's, when a rollback's run is matched to its dispatch by time. */
const CLOCK_SLACK_MS = 60_000;

/** A promote GitHub has not started: queued, or waiting on the production environment's reviewer or timer. */
const NOT_STARTED = ['queued', 'waiting', 'pending'] as const;

export class DeployPipeline {
  constructor(private readonly deps: DeployPipelineDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * A pull request merged. Merging is shipping where the rules say testing is
   * `none`; otherwise the testing deploy is dispatched for the merge commit.
   */
  async onMerged(repo: Repo, prNumber: number, mergeSha: string | null): Promise<string> {
    const rules = await this.rulesOf(repo, `${repo.name}#${prNumber}`);
    if (typeof rules === 'string') return rules;
    if (rules.testing.on === 'none') return `${repo.name}#${prNumber}: merging is shipping here`;
    if (!mergeSha) return `${repo.name}#${prNumber}: merged with no merge commit named; the deploy sweep finds it`;
    return this.deployTesting(repo, mergeSha, prNumber, rules);
  }

  /** Dispatches the testing deploy of a commit, once. */
  async deployTesting(repo: Repo, sha: string, prNumber: number | null, given?: DeliveryRules): Promise<string> {
    const rules = given ?? (await this.rulesOf(repo, `${repo.name}@${sha.slice(0, 7)}`));
    if (typeof rules === 'string') return rules;
    if (rules.testing.on === 'none') return `${repo.name}@${sha.slice(0, 7)}: no testing deploy in this repository's rules`;
    await deployRuns.ensure(repo.id, sha, prNumber);
    const workflow = rules.testing.workflow;
    if (!(await deployRuns.claim(repo.id, sha, 'testing_dispatched_at', `dispatching ${workflow}`))) {
      return `${repo.name}@${sha.slice(0, 7)}: its testing deploy was already dispatched`;
    }
    return this.dispatch(repo, sha, 'testing_dispatched_at', workflow, { sha }, 'deploy.testing_dispatched');
  }

  /**
   * The smoke on testing finished for a commit. Green goes on to production
   * when the rules say so; red is a change that does not work on testing, and
   * goes back to build (the revert is `Webhooks.revertTesting`'s, as before),
   * saying whether a revert is running (`revert`).
   */
  async onTestingSmoke(
    repo: Repo,
    sha: string,
    conclusion: 'success' | 'failure',
    runUrl: string | null,
    revert?: RevertOutcome,
  ): Promise<string> {
    await deployRuns.ensure(repo.id, sha, null);
    // A red smoke also drops a soak or a person's hold kept for the commit, and stays red through
    // a green re-run (`recordSmoke`): the commit is being reverted.
    await deployRuns.recordSmoke(repo.id, sha, conclusion);
    if (conclusion === 'failure') {
      const sent = await this.sendBack(repo, sha, `The smoke failed on testing at \`${sha.slice(0, 7)}\`${runUrl ? `: ${runUrl}` : ''}.${revert ? ` ${revertSaid(revert)}` : ''}`);
      const held = await this.cancelHeldPromote(repo, sha);
      return held ? `${sent}; ${held}` : sent;
    }
    const rules = await this.rulesOf(repo, `${repo.name}@${sha.slice(0, 7)}`);
    if (typeof rules === 'string') return rules;
    return this.afterGreenSmoke(repo, sha, rules);
  }

  /** What a green smoke on testing goes on to, by the rules: nothing, a soak the bridge holds, or the promote. */
  private async afterGreenSmoke(repo: Repo, sha: string, rules: DeliveryRules): Promise<string> {
    if (rules.production.on === 'none') return `${repo.name}@${sha.slice(0, 7)}: testing is as far as this repository goes`;
    // A person the environment cannot hold for, the bridge holds for: the
    // plan refused the reviewer, so a dispatched promote would run at once.
    // Only for `reviewers`; a repository set to `auto` keeps its soak below.
    if (rules.production.approval === 'reviewers') {
      const why = await this.whyProductionNeedsAPerson(repo);
      if (why) return this.holdForPerson(repo, sha, why);
    }
    // A soak the environment cannot hold, the bridge holds: a plan with no
    // environment rules keeps no wait timer.
    if (rules.production.approval === 'auto' && rules.production.soakMinutes > 0 && (await this.noEnvironmentRules(repo))) {
      const after = new Date(this.now() + rules.production.soakMinutes * 60_000);
      await deployRuns.holdPromote(repo.id, sha, after, `soaking on testing until ${after.toISOString()}`);
      return `${repo.name}@${sha.slice(0, 7)}: soaking on testing for ${rules.production.soakMinutes} minutes before the promote`;
    }
    return this.promote(repo, sha, rules);
  }

  /**
   * Holds a commit's promote for a person, who releases it from Needs you.
   * `why` is this promote's reason, stored as a sentence of its own: the
   * Needs-you card reads it between two others.
   */
  private async holdForPerson(repo: Repo, sha: string, why: string): Promise<string> {
    await deployRuns.holdForPerson(repo.id, sha, `${why.charAt(0).toUpperCase()}${why.slice(1)}.`);
    return `${repo.name}@${sha.slice(0, 7)}: the promote waits in Needs you for a person to release it; ${why}`;
  }

  /**
   * A person released a held promote from Needs you: it is dispatched, as the
   * app. The bridge approves nothing in GitHub; it starts the workflow the
   * person asked for. Not held, it is refused; a dispatch GitHub refused
   * gives the step back and leaves it held, and who released it is written
   * only once it went.
   */
  async releaseHeld(repo: Repo, sha: string, by: string): Promise<{ released: boolean; held: boolean; line: string }> {
    // Released by a person, but still not on rules that could not be read: it stays held.
    const rules = await this.rulesOf(repo, `${repo.name}@${sha.slice(0, 7)}`);
    if (typeof rules === 'string') return { released: false, held: true, line: rules };
    const workflow = rules.production.workflow;
    if (!(await deployRuns.releaseHeld(repo.id, sha, `released by ${by}: dispatching ${workflow}`))) {
      return { released: false, held: false, line: `${repo.name}@${sha.slice(0, 7)}: its promote is not held for a person` };
    }
    const sent = await this.dispatchStep(repo, sha, 'promote_dispatched_at', workflow, { candidate: sha }, 'deploy.promote_dispatched');
    if (!sent.ok) return { released: false, held: true, line: sent.line };
    await deployRuns.recordRelease(repo.id, sha, by).catch(() => undefined);
    await audit({ actor: by, action: 'deploy.promote_released', target: `${repo.name}@${sha.slice(0, 7)}`, payload: { sha, workflow } }).catch(() => undefined);
    return { released: true, held: false, line: sent.line };
  }

  /**
   * Dispatches the promote of a commit, once, and only of one whose smoke on
   * testing passed and that nothing sent back (`claimPromote`). The
   * `production` environment holds it as GitHub's rules say. A soak held
   * here once promoted a commit whose smoke went red during it, and a green
   * re-run after a red one promoted the commit being reverted.
   */
  async promote(repo: Repo, sha: string, given?: DeliveryRules): Promise<string> {
    const ref = `${repo.name}@${sha.slice(0, 7)}`;
    const rules = given ?? (await this.rulesOf(repo, ref));
    if (typeof rules === 'string') return rules;
    // Read again: a soak can outlast a change of the rules.
    if (rules.production.on === 'none') return `${ref}: testing is as far as this repository goes`;
    // A rollback owed here that has not finished goes first. Both runs are in
    // one concurrency group, which keeps one pending run: a promote dispatched
    // now cancelled a rollback waiting there, and production stayed broken.
    // Held as a soak that is over, so the deploy sweep asks again.
    const rollback = await deployRuns.rollbackOutstanding(repo.id);
    if (rollback) {
      const after = rollback.sha.slice(0, 7);
      await deployRuns.holdPromote(repo.id, sha, new Date(this.now()), `held for the rollback of production after ${after}`);
      return `${ref}: holding its promote for the rollback of production after ${after}, which has not finished`;
    }
    const workflow = rules.production.workflow;
    if (!(await deployRuns.claimPromote(repo.id, sha, `dispatching ${workflow}`))) {
      const run = await deployRuns.get(repo.id, sha).catch(() => null);
      return run?.promoteDispatchedAt ? `${ref}: its promote was already dispatched` : `${ref}: its smoke went red, or it was sent back; not promoting`;
    }
    return this.dispatch(repo, sha, 'promote_dispatched_at', workflow, { candidate: sha }, 'deploy.promote_dispatched');
  }

  /**
   * A promote of a commit whose smoke went red, that GitHub is still holding:
   * on the production environment's wait timer, which is the soak, or for a
   * reviewer, or queued. It is cancelled. One already running is left to
   * finish: a deploy stopped halfway is worse, and a failure there rolls back.
   * Null when no promote was dispatched for it, or it already finished.
   *
   * The dispatch answers with no run id, so the run is found by its name:
   * `promote-production.yml` names it `promote-production <candidate>`.
   */
  private async cancelHeldPromote(repo: Repo, sha: string): Promise<string | null> {
    const run = await deployRuns.get(repo.id, sha).catch(() => null);
    if (!run?.promoteDispatchedAt || run.productionConclusion) return null;
    const ref = `${repo.name}@${sha.slice(0, 7)}`;
    try {
      const { rules } = await this.deps.delivery.get(repo);
      const client = await this.deps.client(repo.fullName);
      if (!client) return `${ref}: its promote was dispatched, and neither the app nor the automation account can cancel it`;
      const workflow = workflowFile(rules.production.workflow);
      const listed = await client.request<{ workflow_runs?: { id: number; status: string; display_title?: string; html_url?: string }[] }>(
        'GET',
        `/repos/${repo.fullName}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=30`,
      );
      const mine = (listed.workflow_runs ?? []).filter((one) => one.display_title === `promote-production ${sha}`);
      if (mine.length === 0) return `${ref}: its promote was dispatched, and no run of ${workflow} for it was found to cancel`;
      const said: string[] = [];
      for (const one of mine) {
        if (!['waiting', 'pending', 'queued', 'requested'].includes(one.status)) {
          if (one.status !== 'completed') said.push(`${ref}: its promote is already ${one.status.replace('_', ' ')}, and is left to finish`);
          continue;
        }
        await client.request('POST', `/repos/${repo.fullName}/actions/runs/${one.id}/cancel`);
        await audit({ actor: actorOf(client), action: 'deploy.promote_cancelled', target: ref, payload: { workflow, runId: one.id, status: one.status } }).catch(() => undefined);
        said.push(`${ref}: cancelled its promote, which GitHub was holding (${one.status})`);
      }
      return said.join('; ') || null;
    } catch (error) {
      return `${ref}: its promote could not be cancelled: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * A promote of a commit failed, handled by where it stopped.
   *
   * It always dispatched the rollback and sent the change back. Most promotes
   * fail before traffic moves, while production still serves the healthy
   * release, and an empty rollback target is "whatever served before the last
   * shift": a healthy production went back a release, onto a schema already
   * migrated forward, with nobody asked. So only a promote this bridge
   * dispatched is acted on, and then:
   *
   * - it never ran: nothing;
   * - its smoke failed: the change goes back to build, and production is left
   *   on the release it serves;
   * - its traffic shift failed: the rollback is dispatched, whose empty target
   *   is then the release that served before that shift, and a person is told;
   * - anything else, or a run whose steps cannot be placed: a person is told
   *   to check whether traffic moved, and nothing is rolled back.
   *
   * `person` is what the person's issue says, filed by the caller; null when
   * none is owed. A rollback needs no approval: one that waits is not a rollback.
   */
  async onProductionFailed(repo: Repo, sha: string, runId: number | null, runUrl: string | null): Promise<{ line: string; person: string | null }> {
    const ref = `${repo.name}@${sha.slice(0, 7)}`;
    const run = await deployRuns.get(repo.id, sha).catch(() => null);
    if (!run?.promoteDispatchedAt) {
      return { line: `${ref}: a production deploy failed, but this bridge dispatched no promote of it; nothing was done`, person: null };
    }

    const client = await this.deps.client(repo.fullName);
    const jobs =
      client && runId !== null
        ? await client
            .request<{ jobs?: { steps?: Step[] | null }[] }>('GET', `/repos/${repo.fullName}/actions/runs/${runId}/jobs`)
            .then((answer) => answer.jobs ?? null)
            .catch(() => null)
        : null;
    const stopped = promoteFailure(jobs);
    const at = runUrl ? `: ${runUrl}` : '';

    if (stopped === 'never-ran') return { line: `${ref}: its promote failed before any step ran (rejected or never started); nothing to undo`, person: null };

    if (stopped === 'smoke') {
      await deployRuns.recordProduction(repo.id, sha, 'failure');
      const line = await this.sendBack(
        repo,
        sha,
        `The production smoke of \`${sha.slice(0, 7)}\` failed${at}. Traffic never moved, so production still serves the previous release.`,
      );
      return { line, person: null };
    }

    if (stopped === 'shift') {
      const { rules, readError } = await this.deps.delivery.get(repo);
      const failed = `The traffic shift of \`${sha.slice(0, 7)}\` failed${at}.`;
      if (rules.production.on === 'none' && !readError) {
        return {
          line: `${ref}: its traffic shift failed, and this repository's rules name no production rollback; a person is told`,
          person: `${failed} This repository's rules name no production rollback, so OpenADLC dispatched none. Check which release production serves.`,
        };
      }
      // Owed from here, whatever becomes of this dispatch: one that fails is
      // dispatched again by the deploy sweep, and shows on the board until it is.
      await deployRuns.oweRollback(repo.id, sha);
      if (readError) {
        return {
          line: `${ref}: its delivery rules could not be read (${readError}); nothing dispatched, and the deploy sweep tries again`,
          person:
            `${failed} OpenADLC could not read this repository's delivery rules (${readError}), so it has not dispatched the rollback yet; ` +
            'the deploy sweep dispatches it once they read. Check which release production serves.',
        };
      }
      const rollback = rules.production.rollback;
      if (!(await deployRuns.claim(repo.id, sha, 'rollback_dispatched_at', `dispatching ${rollback}`))) {
        return { line: `${ref}: its rollback was already dispatched`, person: null };
      }
      const sent = await this.dispatchRollback(repo, sha, rules);
      return {
        line: sent.line,
        person: sent.ok
          ? `${failed} A rollback of production was dispatched: \`${rollback}\`, with no target, which puts back ` +
            'the release that served before the last shift. OpenADLC checks that it runs, and dispatches it again if it is cancelled or never starts. ' +
            'Check that production serves that release, and why the shift failed.'
          : `${failed} OpenADLC could not dispatch \`${rollback}\` (${sent.why}); the deploy sweep tries it again, and the board says so ` +
            'while it is not dispatched. Until then production may serve the new revision: run the rollback yourself if it cannot wait.',
      };
    }

    const { rules } = await this.deps.delivery.get(repo);
    return {
      line: `${ref}: its promote failed ${stopped === 'other' ? 'at a step other than the smoke and the traffic shift' : 'at a step OpenADLC cannot place'}; nothing was rolled back, and a person is told`,
      person:
        `The promote of \`${sha.slice(0, 7)}\` failed${at}, ${stopped === 'other' ? 'at a step other than the smoke and the traffic shift' : 'and OpenADLC cannot tell at which step'}. ` +
        `Nothing was rolled back. Check whether traffic moved to the new revision; if it did, run \`${rules.production.rollback}\`.`,
    };
  }

  /**
   * Promotes and rollbacks whose dispatch failed, dispatched again. The
   * deploy sweep calls this. A promote goes back through what a green smoke
   * decides, by the rules as they are now: a repository that no longer
   * promotes is left, and a soak the bridge must hold is held. Each step is
   * still claimed, so a webhook racing the sweep dispatches it once.
   */
  async retryUndispatched(): Promise<string[]> {
    const lines: string[] = [];
    const repoList = await repos.listRepos();
    const failed = (ref: string) => (error: unknown) => `${ref}: ${error instanceof Error ? error.message : String(error)}`;
    for (const run of await deployRuns.undispatchedPromotes(new Date(this.now() - RETRY_WITHIN_MS))) {
      const repo = repoList.find((one) => one.id === run.repoId);
      if (!repo) continue;
      const ref = `${repo.name}@${run.sha.slice(0, 7)}`;
      const line = await this.rulesOf(repo, ref)
        .then((rules) => (typeof rules === 'string' || rules.production.on === 'none' ? rules : this.afterGreenSmoke(repo, run.sha, rules)))
        .catch(failed(ref));
      // Testing as far as it goes is no news on every sweep.
      if (typeof line === 'string') lines.push(line);
    }
    for (const run of await deployRuns.undispatchedRollbacks()) {
      const repo = repoList.find((one) => one.id === run.repoId);
      if (!repo) continue;
      const ref = `${repo.name}@${run.sha.slice(0, 7)}`;
      lines.push(await this.rollBack(repo, run.sha, ref).catch(failed(ref)));
    }
    return lines;
  }

  /** A rollback owed, dispatched again. Not sent back: the failed shift told a person, and that was all. */
  private async rollBack(repo: Repo, sha: string, ref: string): Promise<string> {
    const rules = await this.rulesOf(repo, ref);
    if (typeof rules === 'string') return rules;
    if (rules.production.on === 'none') return `${ref}: its rollback is owed, but this repository's rules no longer name one`;
    if (!(await deployRuns.claim(repo.id, sha, 'rollback_dispatched_at', `dispatching ${rules.production.rollback}`))) {
      return `${ref}: its rollback was already dispatched`;
    }
    return (await this.dispatchRollback(repo, sha, rules)).line;
  }

  /**
   * Dispatches a claimed rollback, once the repository's promotes GitHub has
   * not started are cancelled.
   *
   * The promote and the rollback share the `production-traffic` concurrency
   * group, so they never shift traffic at once. GitHub runs one run of a
   * group and keeps one pending: a rollback dispatched behind a promote
   * waiting hours for a person's approval waited with it, and the next
   * promote dispatched cancelled it. A promote that is queued or waiting has
   * run no step, so cancelling it undoes nothing; it also cannot be approved
   * late and land after the rollback. One already running is left to finish:
   * it is short, and moves traffic last.
   */
  private async dispatchRollback(repo: Repo, sha: string, rules: DeliveryRules): Promise<Dispatched> {
    const cancelled = await this.cancelWaitingPromotes(repo, rules);
    const sent = await this.dispatchStep(repo, sha, 'rollback_dispatched_at', rules.production.rollback, {}, 'deploy.rollback_dispatched');
    return cancelled.length > 0 ? { ...sent, line: `${cancelled.join('; ')}; ${sent.line}` } : sent;
  }

  /** Cancels the repository's promotes GitHub has not started (`NOT_STARTED`), and says what it did. */
  private async cancelWaitingPromotes(repo: Repo, rules: DeliveryRules): Promise<string[]> {
    const client = await this.deps.client(repo.fullName);
    if (!client) return [];
    const workflow = workflowFile(rules.production.workflow);
    const said: string[] = [];
    for (const status of NOT_STARTED) {
      let runs: { id: number; status: string }[];
      try {
        const listed = await client.request<{ workflow_runs?: { id: number; status: string }[] }>(
          'GET',
          `/repos/${repo.fullName}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=${status}&per_page=100`,
        );
        runs = listed.workflow_runs ?? [];
      } catch (error) {
        // Not a reason to hold the rollback: one that may wait beats none.
        said.push(`${repo.name}: its ${status} promotes could not be listed (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`);
        continue;
      }
      for (const run of runs) {
        try {
          await client.request('POST', `/repos/${repo.fullName}/actions/runs/${run.id}/cancel`);
        } catch (error) {
          said.push(`${repo.name}: its ${status} promote run ${run.id} could not be cancelled (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`);
          continue;
        }
        await audit({ actor: actorOf(client), action: 'deploy.promote_cancelled', target: repo.name, payload: { workflow, runId: run.id, status, why: 'a rollback of production' } }).catch(
          () => undefined,
        );
        said.push(`${repo.name}: cancelled promote run ${run.id} (${status}) for the rollback`);
      }
    }
    return said;
  }

  /**
   * Rollbacks dispatched and not yet seen to end, looked at again. The deploy
   * sweep calls this. How each run ended is recorded: a success is what lets
   * the repository's promotes go again, and what the send-back can say. One
   * whose run was cancelled — by a person, or a promote dispatched behind it
   * — or that never appeared is given back, so the sweep dispatches it again
   * (`retryUndispatched`), and the board says why until one succeeds.
   */
  async checkRollbacks(): Promise<string[]> {
    const lines: string[] = [];
    const repoList = await repos.listRepos();
    for (const run of await deployRuns.dispatchedRollbacks(new Date(this.now() - RETRY_WITHIN_MS))) {
      const repo = repoList.find((one) => one.id === run.repoId);
      if (!repo || !run.rollbackDispatchedAt) continue;
      const ref = `${repo.name}@${run.sha.slice(0, 7)}`;
      lines.push(
        await this.checkRollback(repo, run.sha, run.rollbackDispatchedAt, ref).catch(
          (error: unknown) => `${ref}: its rollback could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    return lines;
  }

  private async checkRollback(repo: Repo, sha: string, dispatchedAt: string, ref: string): Promise<string> {
    const rules = await this.rulesOf(repo, ref);
    if (typeof rules === 'string') return rules;
    const client = await this.deps.client(repo.fullName);
    if (!client) return `${ref}: its rollback cannot be checked; neither the app nor the automation account can act here`;
    const workflow = rules.production.rollback;
    // The dispatch answers with no run id, so the run is the first of the
    // workflow GitHub made after it.
    const listed = await client.request<{ workflow_runs?: { id: number; status: string; conclusion?: string | null; created_at?: string }[] }>(
      'GET',
      `/repos/${repo.fullName}/actions/workflows/${encodeURIComponent(workflowFile(workflow))}/runs?event=workflow_dispatch&per_page=30`,
    );
    const since = Date.parse(dispatchedAt) - CLOCK_SLACK_MS;
    const run = (listed.workflow_runs ?? [])
      .filter((one) => one.created_at && Date.parse(one.created_at) >= since)
      .sort((a, b) => Date.parse(a.created_at as string) - Date.parse(b.created_at as string))[0];

    if (!run) {
      if (this.now() - Date.parse(dispatchedAt) < ROLLBACK_APPEARS_MS) return `${ref}: its rollback was dispatched, and GitHub lists no run of it yet`;
      const why = `no run of ${workflow} appeared within ${ROLLBACK_APPEARS_MS / 60_000} minutes of its dispatch`;
      await deployRuns.rollbackDidNotRun(repo.id, sha, why);
      await audit({ actor: actorOf(client), action: 'deploy.rollback_not_run', target: ref, payload: { workflow, why } }).catch(() => undefined);
      return `${ref}: ${why}; the deploy sweep dispatches it again`;
    }
    if (run.status !== 'completed') return `${ref}: its rollback is ${run.status.replace(/_/g, ' ')}`;
    if (run.conclusion === 'success') {
      await deployRuns.recordRollback(repo.id, sha, 'success');
      await audit({ actor: actorOf(client), action: 'deploy.rollback_finished', target: ref, payload: { workflow, runId: run.id, conclusion: 'success' } }).catch(() => undefined);
      return `${ref}: production was rolled back (${workflow} run ${run.id})`;
    }
    if (run.conclusion === 'cancelled') {
      const why = `${workflow} run ${run.id} was cancelled before it finished`;
      await deployRuns.rollbackDidNotRun(repo.id, sha, why);
      await audit({ actor: actorOf(client), action: 'deploy.rollback_not_run', target: ref, payload: { workflow, runId: run.id, why } }).catch(() => undefined);
      return `${ref}: ${why}; the deploy sweep dispatches it again`;
    }
    await deployRuns.recordRollback(repo.id, sha, 'failure');
    await audit({ actor: actorOf(client), action: 'deploy.rollback_finished', target: ref, payload: { workflow, runId: run.id, conclusion: run.conclusion ?? null } }).catch(() => undefined);
    return `${ref}: the rollback failed (${workflow} run ${run.id}: ${run.conclusion ?? 'no conclusion'}); production may still serve the failed revision`;
  }

  /** Promotes whose soak the bridge held and is over. The deploy sweep calls this. */
  async promoteDue(): Promise<string[]> {
    const lines: string[] = [];
    for (const run of await deployRuns.duePromotes(new Date(this.now()))) {
      const repo = (await repos.listRepos()).find((one) => one.id === run.repoId);
      if (!repo) continue;
      const due = async (): Promise<string> => {
        // The rules again, not as they were when the soak began: a repository
        // switched to `reviewers` since then is held for a person instead.
        const { rules } = await this.deps.delivery.get(repo);
        if (rules.production.approval === 'reviewers') {
          const why = await this.whyProductionNeedsAPerson(repo);
          if (why) return this.holdForPerson(repo, run.sha, why);
        }
        return this.promote(repo, run.sha, rules);
      };
      lines.push(await due().catch((error: unknown) => `${repo.name}@${run.sha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`));
    }
    return lines;
  }

  /** The repository's rules, or the line saying they could not be read and nothing was dispatched. */
  private async rulesOf(repo: Repo, ref: string): Promise<DeliveryRules | string> {
    const { rules, readError } = await this.deps.delivery.get(repo);
    return readError ? `${ref}: its delivery rules could not be read (${readError}); nothing dispatched` : rules;
  }

  /**
   * Why a `reviewers` promote has to wait for a person, or null when GitHub
   * is holding a reviewer.
   *
   * The remembered plan limit is one signal. It is not the only one: the row
   * is dropped when a rulesets read fails, or when an apply skips production,
   * and the promote then dispatched with nothing on GitHub holding it. What
   * holds it is a required reviewer on the production environment. Absent, or
   * unreadable, the promote waits, and the words say which of those it was.
   *
   * The live read comes first and wins over the row. A row can outlive the
   * limit: an apply whose branch-policy write was refused reports production
   * skipped and keeps it, while GitHub still holds the reviewer it had, and
   * the promote was then held twice.
   */
  async whyProductionNeedsAPerson(repo: Repo): Promise<string | null> {
    const held = await this.productionReviewerHeld(repo);
    if (held === true) return null;
    if (await this.noEnvironmentRules(repo)) return 'GitHub’s plan cannot hold a production reviewer here';
    return held === false
      ? 'the production environment is not holding a reviewer'
      : 'the production environment could not be read, so it is not known to be holding a reviewer';
  }

  /** Whether GitHub's production environment holds a required reviewer; null when it could not be read. */
  private async productionReviewerHeld(repo: Repo): Promise<boolean | null> {
    const client = await this.deps.client(repo.fullName);
    if (!client) return null;
    try {
      const environment = await client.request<{ protection_rules?: { type?: string; reviewers?: unknown[] }[] }>(
        'GET',
        `/repos/${repo.fullName}/environments/production`,
      );
      const reviewers = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers')?.reviewers ?? [];
      return reviewers.length > 0;
    } catch {
      return null;
    }
  }

  /** Whether a `reviewers` promote has to wait for a person. */
  async productionNeedsAPerson(repo: Repo): Promise<boolean> {
    return (await this.whyProductionNeedsAPerson(repo)) !== null;
  }

  /** Whether the repository's plan refused the production environment's rules when they were last applied. */
  async noEnvironmentRules(repo: Repo): Promise<boolean> {
    const limits = await repos.getPlanLimits(repo.fullName).catch(() => null);
    return Boolean(limits?.limits.some((limit) => limit.name === 'environment production'));
  }

  /**
   * Send-backs a failed smoke or production deploy is still owed: tried again
   * by the deploy sweep, since one GitHub did not answer for was given back.
   */
  async sendBackDue(): Promise<string[]> {
    if (!this.deps.sendBack) return [];
    const lines: string[] = [];
    const since = new Date(this.now() - SEND_BACK_RETRY_MS);
    for (const run of await deployRuns.unsentBack(since)) {
      const repo = (await repos.listRepos()).find((one) => one.id === run.repoId);
      if (!repo) continue;
      const short = run.sha.slice(0, 7);
      // Said without what this sweep does not know: whether the rollback
      // finished, or whether a revert started.
      const reason =
        run.productionConclusion === 'failure'
          ? `The production deploy of \`${short}\` failed.${rollbackSaid(run)}`
          : `The smoke failed on testing at \`${short}\`.`;
      lines.push(await this.sendBack(repo, run.sha, reason).catch((error: unknown) => `${repo.name}@${short}: ${error instanceof Error ? error.message : String(error)}`));
    }
    return lines;
  }

  /**
   * Each issue a commit's pull requests are for, sent back to build once per
   * commit. The step is claimed first, so two deliveries do not both send it;
   * anything that stops it reaching every issue gives the claim back. Kept
   * after a GitHub that did not answer, it was a send-back lost for good: the
   * revert happened, and the issue never went back to Build.
   */
  private async sendBack(repo: Repo, sha: string, reason: string): Promise<string> {
    if (!this.deps.sendBack) return `${repo.name}@${sha.slice(0, 7)}: nothing here sends it back`;
    const ref = `${repo.name}@${sha.slice(0, 7)}`;
    if (!(await deployRuns.claim(repo.id, sha, 'sent_back_at', 'sending it back to build'))) {
      return `${ref}: already sent back`;
    }
    const giveBack = async (why: string): Promise<string> => {
      await deployRuns.release(repo.id, sha, 'sent_back_at', `not sent back: ${why.slice(0, 200)}`);
      return `${ref}: not sent back (${why.slice(0, 160)}); the deploy sweep tries again`;
    };

    const client = await this.deps.client(repo.fullName);
    if (!client) return giveBack('neither the app nor the automation account can act here');
    let pulls: { number: number; headRef: string }[];
    try {
      pulls = await client.listPullsForCommit(repo.fullName, sha);
    } catch (error) {
      // The pull request it merged from, recorded when the merge was heard.
      const recorded = (await deployRuns.get(repo.id, sha).catch(() => null))?.prNumber ?? null;
      if (recorded === null) return giveBack(`its pull requests could not be listed: ${error instanceof Error ? error.message : String(error)}`);
      pulls = [{ number: recorded, headRef: '' }];
    }
    const board = await issues.listIssues(repo.name).catch(() => null);
    if (!board) return giveBack('the board could not be read');

    const lines: string[] = [];
    let failed: string | null = null;
    for (const pull of pulls) {
      const issueNumber = issueNumberFromBranch(pull.headRef) ?? board.find((issue) => issue.prNumber === pull.number)?.number ?? null;
      if (!issueNumber) continue;
      try {
        const result = await this.deps.sendBack.fromBridge({ repoName: repo.name, issueNumber, from: 'merged', reason });
        lines.push(result.sent ? `${repo.name}#${issueNumber} sent back to ${result.to}` : `${repo.name}#${issueNumber} not sent back: ${result.reason}`);
      } catch (error) {
        failed = `${repo.name}#${issueNumber}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (failed) lines.push(await giveBack(failed));
    return lines.join('; ') || `${ref}: no issue of ours behind it to send back`;
  }

  /**
   * Dispatches a workflow on the default branch, as the app, or as the
   * automation account where the app cannot act on the repository. Refused or
   * unreachable, the step is given back so the deploy sweep can try again
   * (`retryUndispatched`, and `deployTesting` through the sweep's plan), and
   * it is said: a deploy the rules call for that never started is a card's
   * worth (`health/checks/deploy-dispatch.ts`).
   */
  private async dispatch(
    repo: Repo,
    sha: string,
    step: deployRuns.Step,
    workflow: string,
    inputs: Record<string, string>,
    action: string,
  ): Promise<string> {
    return (await this.dispatchStep(repo, sha, step, workflow, inputs, action)).line;
  }

  /** `dispatch`, saying whether it went, and GitHub's reason when it did not. */
  private async dispatchStep(
    repo: Repo,
    sha: string,
    step: deployRuns.Step,
    workflow: string,
    inputs: Record<string, string>,
    action: string,
  ): Promise<Dispatched> {
    const client = await this.deps.client(repo.fullName);
    const ref = `${repo.name}@${sha.slice(0, 7)}`;
    if (!client) {
      const why = 'neither the app nor the automation account can act here';
      await deployRuns.release(repo.id, sha, step, `${workflow} not dispatched: ${why}`);
      return { ok: false, why, line: `${ref}: ${workflow} not dispatched; ${why}` };
    }
    try {
      await client.request('POST', `/repos/${repo.fullName}/actions/workflows/${encodeURIComponent(workflowFile(workflow))}/dispatches`, {
        ref: repo.defaultBranch,
        inputs,
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await deployRuns.release(repo.id, sha, step, `${workflow} not dispatched: ${why.slice(0, 200)}`);
      return { ok: false, why: why.slice(0, 160), line: `${ref}: ${workflow} not dispatched (${why.slice(0, 160)}); the deploy sweep tries again` };
    }
    await audit({ actor: actorOf(client), action, target: ref, payload: { workflow, inputs } }).catch(() => undefined);
    return { ok: true, line: `${ref}: dispatched ${workflow}` };
  }
}
