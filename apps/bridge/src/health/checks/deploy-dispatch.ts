import type { CheckResult, HealthCheck } from '../types.js';

/** A promote or rollback the deploy pipeline owes and has not dispatched; see `deployRuns.undispatchedSince`. */
export interface UndispatchedStep {
  step: 'promote' | 'rollback';
  run: { repoId: string; sha: string; detail: string | null };
}

export interface DeployDispatchReader {
  /** Steps due before `before` and still not dispatched. */
  undispatched(before: Date): Promise<UndispatchedStep[]>;
  repos(): Promise<{ id: string; name: string; fullName: string }[]>;
  /** The workflow the repository's rules name for the step, or null when they cannot be read. */
  workflow(repo: { id: string; name: string; fullName: string }, step: UndispatchedStep['step']): Promise<string | null>;
  /**
   * Rollbacks that did not finish well: the last one dispatched was cancelled
   * or never started (`rollbackTrouble`), or one ran and failed; see
   * `deployRuns.unfinishedRollbacks`.
   */
  unfinishedRollbacks?(): Promise<{ repoId: string; sha: string; rollbackConclusion: string | null; rollbackTrouble: string | null }[]>;
}

/** How long a step may stay undispatched after it was due before the board says so: a few of the deploy sweep's tries. */
export const UNDISPATCHED_AFTER_MS = 15 * 60_000;

/**
 * Every promote and rollback the repositories' rules called for was dispatched.
 *
 * A dispatch GitHub refused or did not answer is given back, and the deploy
 * sweep dispatches it again. One that keeps failing was a log line and
 * nothing else — `deploy_runs.detail` was read nowhere — so a rollback could
 * be owed for hours with production on a broken revision, and nobody told. A
 * card names the repository, the commit, the workflow and GitHub's reason,
 * and goes once the step is dispatched. A promote waits (a warning); a
 * rollback is production left on what failed (blocking).
 */
export function deployDispatchCheck(reader: DeployDispatchReader, afterMs = UNDISPATCHED_AFTER_MS): HealthCheck {
  return {
    id: 'deploy-dispatch',
    proves: 'Every promote and rollback the repositories’ rules called for was dispatched',
    how: 'reads the deploy pipeline’s record of each merged commit for a promote or rollback still not dispatched a quarter of an hour after it was due',
    everyMinutes: 5,
    steps: [],
    async run(now) {
      const [stuck, repos] = await Promise.all([reader.undispatched(new Date(now.getTime() - afterMs)), reader.repos()]);
      const results: CheckResult[] = [];
      for (const { step, run } of stuck) {
        const repo = repos.find((one) => one.id === run.repoId);
        if (!repo) continue;
        const short = run.sha.slice(0, 7);
        const workflow = (await reader.workflow(repo, step).catch(() => null)) ?? `the ${step} workflow`;
        const said = run.detail ? ` The last try: ${run.detail}.` : '';
        results.push({
          subject: `${repo.name}@${short}:${step}`,
          ok: false,
          severity: step === 'rollback' ? 'blocking' : 'warning',
          title: `${repo.name}: ${workflow} of ${short} has not been dispatched`,
          detail:
            (step === 'rollback'
              ? `The traffic shift of ${short} failed, and the rollback it owes has not been dispatched, so production may still serve that revision.`
              : `The smoke on testing passed for ${short}, and its promote has not been dispatched.`) +
            `${said} The deploy sweep dispatches it again every few minutes; this goes once it is dispatched. ` +
            `If GitHub keeps refusing, fix what it says, or run ${workflow} from the repository's Actions.`,
          action: { label: 'Open Actions', url: `https://github.com/${repo.fullName}/actions` },
          facts: { repo: repo.name, sha: run.sha, step, workflow, detail: run.detail },
        });
      }
      // A rollback dispatched is not a rollback run: one cancelled behind a
      // promote, or never started, left production on what failed while the
      // board was quiet. Said until one succeeds.
      for (const run of (await reader.unfinishedRollbacks?.()) ?? []) {
        const repo = repos.find((one) => one.id === run.repoId);
        if (!repo) continue;
        const short = run.sha.slice(0, 7);
        const workflow = (await reader.workflow(repo, 'rollback').catch(() => null)) ?? 'the rollback workflow';
        const failed = run.rollbackConclusion === 'failure';
        results.push({
          subject: `${repo.name}@${short}:rollback-run`,
          ok: false,
          severity: 'blocking',
          title: failed ? `${repo.name}: ${workflow} after ${short} failed` : `${repo.name}: ${workflow} after ${short} did not run`,
          detail: failed
            ? `The traffic shift of ${short} failed, and the rollback OpenADLC dispatched failed too, so production may still serve that revision. ` +
              `Read the run, and put production on a healthy release.`
            : `The traffic shift of ${short} failed, and the rollback OpenADLC dispatched did not run: ${run.rollbackTrouble}. ` +
              'The deploy sweep dispatches it again, and holds new promotes in this repository until one succeeds; this goes then. ' +
              `If it keeps not running, look for a promote holding the production-traffic concurrency group, or run ${workflow} from the repository's Actions.`,
          action: { label: 'Open Actions', url: `https://github.com/${repo.fullName}/actions` },
          facts: { repo: repo.name, sha: run.sha, step: 'rollback', workflow, conclusion: run.rollbackConclusion, trouble: run.rollbackTrouble },
        });
      }
      return results;
    },
  };
}
