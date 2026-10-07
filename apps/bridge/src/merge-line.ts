import { audit, bots, issues, mergeLines, repos } from '@fleetadlc/db';
import type { Actors } from './actors.js';
import { mergeDecision, type Automation, type LandedApproval } from './automation.js';
import { asAutomation, automationBotName } from './automation-bot.js';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';
import type { GitHubClient } from '@fleetadlc/github';
import { CI_LABEL, REQUIRED_CHECK, REVIEW_GATE_CHECK } from '@fleetadlc/shared';
import type { ConflictRounds } from './conflict-round.js';
import type { Stacking } from './stacking.js';
import { issueNumberFromBranch } from './work.js';
import type { TaskService } from './task-service.js';

/**
 * What has to be true on the head commit before a pull request may land.
 *
 * Read from the one place the names live rather than restated. These were
 * `['gate / ci', 'review-gate']`, and GitHub never publishes `gate / ci` — so
 * the line was waiting for a check that does not exist, and nothing would ever
 * have been green enough to land.
 */
export const REQUIRED_CHECKS = [REQUIRED_CHECK, REVIEW_GATE_CHECK];

/**
 * What a merge-line entry's detail says when the pull request is green and
 * at the front and only a person can land it. The board read it as
 * "Merging" and Needs you said nothing, so it sat; `heldForPerson` finds it.
 */
export const WAITING_FOR_PERSON = 'waiting for a person to merge it';

/** Why a person has to merge it, when the entry says one has to; see `WAITING_FOR_PERSON`. */
export function heldForPerson(entry: { state: string; detail: string | null }): string | null {
  if (entry.state !== 'merging' || !entry.detail?.includes(WAITING_FOR_PERSON)) return null;
  return entry.detail.split('because ')[1]?.trim() || 'auto-merge is not on for it';
}

export type ChecksVerdict = 'green' | 'pending' | 'red';

/**
 * What the line hands back to the builder (`SendBack.backToBuild`).
 * `leasePathsOnly` briefs the round with its lease's paths alone: a round sent
 * back for straying was otherwise let write every file in its diff, the
 * stray ones included.
 */
export interface BackToBuild {
  repoName: string;
  prNumber: number;
  reason: string;
  leasePathsOnly?: boolean;
}

/**
 * How long after `adlc:ci` was put on a head the line waits for a `ci` run to
 * appear before it takes the label off and puts it back: a `labeled` delivery
 * GitHub dropped, or a run it never queued, starts nothing otherwise.
 */
export const CI_REQUEST_WAIT_MS = 10 * 60 * 1000;

/**
 * How long the line waits on a branch update it asked for, while the head
 * stays where it was, before it asks again: GitHub answers 202 and makes the
 * merge afterwards, and one that never comes is asked for once more.
 */
export const UPDATE_WAIT_MS = 10 * 60 * 1000;

/**
 * When the merge line asked for CI on each pull request, by `owner/repo#n`.
 * The label guard (`Webhooks.guardCiLabel`) keeps an `adlc:ci` the bridge put
 * on, and takes off one anybody else without the say put on.
 */
export const ciRequests = new Map<string, number>();

/** Whether the merge line asked for CI on this pull request lately. */
export function askedForCi(repoFullName: string, prNumber: number, now = Date.now()): boolean {
  const at = ciRequests.get(`${repoFullName.toLowerCase()}#${prNumber}`);
  return at !== undefined && now - at < CI_REQUEST_WAIT_MS * 2;
}

/**
 * Conclusions that mean the check produced no verdict. A run superseded by the
 * next push is cancelled, and a job whose condition was false is skipped —
 * neither says the change is bad, so neither may throw a pull request out of
 * the line. They hold it instead, exactly like a check that has not run.
 */
const NO_VERDICT = new Set(['cancelled', 'skipped', 'neutral', 'stale']);

/**
 * The checks as they stand: of the check runs that share a name, the newest by
 * id. A failed `ci` and its rerun that passed are two check runs on one head;
 * read together, the old failure made the head red for good after the rerun
 * turned it green. A check without an id — a commit status — is the latest of
 * its context already.
 */
export function latestByName<C extends { name: string; id?: number }>(checks: readonly C[]): C[] {
  const newest = new Map<string, C>();
  const rest: C[] = [];
  for (const check of checks) {
    if (typeof check.id !== 'number') {
      rest.push(check);
      continue;
    }
    const seen = newest.get(check.name);
    if (!seen || (seen.id ?? 0) < check.id) newest.set(check.name, check);
  }
  return [...newest.values(), ...rest];
}

/**
 * Whether the required checks have all finished and passed on one commit.
 *
 * A check that has not reported is not a pass. The whole point of the line is
 * that nothing lands untested against the main it will become part of, so an
 * absent check holds the line rather than being read as consent.
 */
export function verdictFor(
  checks: { name: string; status: string; conclusion: string | null; id?: number }[],
  required: string[] = REQUIRED_CHECKS,
): ChecksVerdict {
  let pending = false;
  const latest = latestByName(checks);

  for (const name of required) {
    const reported = latest.filter((check) => check.name === name);
    if (reported.length === 0) {
      pending = true;
      continue;
    }
    if (reported.some((check) => check.status !== 'completed')) {
      pending = true;
      continue;
    }
    if (reported.some((check) => check.conclusion && NO_VERDICT.has(check.conclusion))) {
      pending = true;
      continue;
    }
    if (reported.some((check) => check.conclusion !== 'success')) return 'red';
  }

  return pending ? 'pending' : 'green';
}

/** What the pull request is told when the bridge lands it: the approvals it landed on. */
export function landedComment(head: string, merged: string, approvals: readonly LandedApproval[]): string {
  const lines = approvals.map(
    (approval) =>
      `- ${approval.person ? `@${approval.reviewer}` : approval.reviewer} approved \`${approval.commitId.slice(0, 7)}\`` +
      (approval.ofHead ? '' : ', an earlier head with the same diff against the base'),
  );
  return [
    `Merged by OpenADLC, as its GitHub App, as \`${merged.slice(0, 7)}\` (squash). \`${head.slice(0, 7)}\` was up to date with the base branch, and ${REQUIRED_CHECKS.map((name) => `\`${name}\``).join(' and ')} were green on it.`,
    '',
    'The approvals it landed on:',
    ...lines,
  ].join('\n');
}

export interface MergeLineStep {
  repo: string;
  prNumber: number;
  state: string;
  detail: string;
}

/**
 * The order pull requests land in, one repository at a time.
 *
 * GitHub's merge queue is unavailable on a private repository outside
 * Enterprise Cloud, so the bridge does the same job: it takes the pull request
 * at the front of the line, brings it up to date with the base branch, waits
 * for the checks to report on that new head, and then lands it.
 *
 * Landing is the bridge's, as the GitHub App, and never a bot's: a bot that
 * could merge would be a bot that could merge around a red check, and OpenADLC's
 * `gh` refuses one. On GitHub's free plan a private repository has no
 * branch protection and no merge queue, so a pull request whose every rule
 * holds (`mergeDecision`) is merged here, and audited. A repository an install
 * lists in `bridgeMergeOff` is left, as before, for auto-merge or a person.
 *
 * The branch update is made with the builder's own credential: the branch is
 * its work, and the automation account, which holds triage on an
 * organization's repository, cannot push to it.
 */
export class MergeLine {
  constructor(
    private readonly config: BridgeConfig,
    private readonly actors: Actors,
    private readonly taskService: TaskService,
    /** What lands a pull request as the app; without it, nothing is merged here. */
    private readonly automation: Pick<Automation, 'mergeFacts' | 'mergeAsApp' | 'setCiLabel'> | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sends a conflicted pull request back to build; set once the send-back exists (`main.ts`). */
  private backToBuild: ((input: BackToBuild) => Promise<void>) | null = null;

  /** Why no more CI is asked for this month, or null (`ci-usage.ts`); set once the counter exists (`main.ts`). */
  private ciCap: (() => Promise<string | null>) | null = null;

  useCiCap(reason: () => Promise<string | null>): void {
    this.ciCap = reason;
  }

  useSendBack(backToBuild: (input: BackToBuild) => Promise<void>): void {
    this.backToBuild = backToBuild;
  }

  /** Opens a conflicted pull request's resolution round; set once at start-up (`main.ts`). */
  private conflicts: Pick<ConflictRounds, 'start' | 'unstarted'> | null = null;

  useConflictRounds(rounds: Pick<ConflictRounds, 'start' | 'unstarted'>): void {
    this.conflicts = rounds;
  }

  /** Keeps a stacked pull request out until what it was built on merges; set once at start-up (`main.ts`). */
  private stacks: Pick<Stacking, 'waitingOn' | 'updating' | 'made'> | null = null;

  useStacking(stacks: Pick<Stacking, 'waitingOn' | 'updating' | 'made'>): void {
    this.stacks = stacks;
  }

  /** The heads `adlc:ci` was put on, and when, by `repo#n@sha`. */
  private readonly ciAsked = new Map<string, number>();

  /** When the line first found an update it asked for still unmade, by `repo#n@sha`. */
  private readonly updateWaited = new Map<string, number>();

  /** Joins the line, or refreshes the place it already holds. */
  async enter(input: {
    repoName: string;
    prNumber: number;
    headSha: string | null;
    revert?: boolean;
  }): Promise<void> {
    const repo = await repos.getRepoByName(input.repoName);
    if (!repo) return;
    // Its resolution round has not started: back in the line it conflicted
    // again on every sweep, with another comment and another failed round.
    // One waiting for its builder is asked for again here, which the gate
    // sweep does every few minutes; one recorded as a failed task is Try
    // again's, or the recovery's.
    const waiting = this.conflicts ? await this.conflicts.unstarted(repo.name, input.prNumber).catch(() => null) : null;
    if (waiting) {
      if (waiting.pending === 'busy' && waiting.base) {
        await this.conflicts?.start({ repoName: repo.name, prNumber: input.prNumber, baseRef: waiting.base }).catch((error: unknown) =>
          console.warn(`[bridge] ${repo.name}#${input.prNumber}: no resolution round: ${error instanceof Error ? error.message : error}`),
        );
      }
      return;
    }
    // Built on another pull request still in review: it lands after that one,
    // or it would land both. The gate sweep comes back for it. One whose
    // stack cannot be read waits too: let in, it merged with the other's
    // unreviewed commits inside it.
    const issue = this.stacks
      ? ((await issues.listIssues(repo.name).catch(() => [])).find((entry) => entry.prNumber === input.prNumber)?.number ?? null)
      : null;
    let waitingOn: number | null = null;
    try {
      waitingOn = this.stacks && issue ? await this.stacks.waitingOn(repo.name, issue) : null;
    } catch (error) {
      console.log(
        `[bridge] ${repo.name}#${input.prNumber}: approved, and waits: whether it was built on another pull request could not be read ` +
          `(${error instanceof Error ? error.message : String(error)}); the gate sweep asks again`,
      );
      return;
    }
    if (waitingOn) {
      console.log(`[bridge] ${repo.name}#${input.prNumber}: approved, and waits for #${waitingOn}, which it was built on, to merge`);
      return;
    }
    await mergeLines.enter({
      repoId: repo.id,
      prNumber: input.prNumber,
      headSha: input.headSha,
      revert: input.revert ?? false,
    });
  }

  async leave(repoName: string, prNumber: number): Promise<void> {
    const repo = await repos.getRepoByName(repoName);
    if (repo) await mergeLines.leave(repo.id, prNumber);
  }

  /**
   * The account whose credential may update this branch: the builder that owns
   * the repository, whose work the branch is and whose push the branch's rules
   * are written around (the ruleset's only bypass is the app); falling back to
   * the automation account is deliberate, because when that is refused the
   * refusal is the useful signal, not a silent skip.
   */
  private async updaterFor(repoName: string): Promise<string> {
    const repo = await repos.getRepoByName(repoName);
    const owner = repo?.ownerBotId ? await bots.getBotById(repo.ownerBotId) : null;
    return owner?.name ?? (await automationBotName(this.config));
  }

  /**
   * Moves the front of one repository's line along by one step, and stops.
   *
   * Each call does at most one thing — update a branch, or read the checks on a
   * head — because everything it waits for arrives as another event. Being
   * called again is how it makes progress, so it is safe to call on every
   * webhook and on a tick.
   */
  async advance(repoName: string): Promise<MergeLineStep | null> {
    // One step at a time per repository. A review's webhook and the tick both
    // advance the line, and two at once both tried to merge the same pull
    // request: GitHub landed it once, and the loser said it had been refused.
    const key = repoName.toLowerCase();
    const run = (this.advancing.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.advanceOnce(repoName));
    const settled = run.catch(() => undefined);
    this.advancing.set(key, settled);
    void settled.then(() => {
      if (this.advancing.get(key) === settled) this.advancing.delete(key);
    });
    return run;
  }

  private readonly advancing = new Map<string, Promise<unknown>>();

  /**
   * Merges the base into a stacked pull request's branch and records what it
   * made: the commit's SHA when its first parent is the head the line read,
   * otherwise none, so no push is taken for this update. Answers as
   * `updateBranch` does.
   */
  private async stackedUpdate(
    client: GitHubClient,
    repo: { name: string; fullName: string },
    prNumber: number,
    pull: { headRef: string; headSha: string; baseRef: string },
  ): Promise<{ updated: boolean; conflict: boolean; message: string }> {
    const made = await client.mergeIntoBranch(repo.fullName, pull.headRef, pull.baseRef);
    const ours = made.merged && made.sha !== null && made.parents[0] === pull.headSha;
    await this.stacks?.made({ repoName: repo.name, prNumber, from: pull.headSha, to: ours ? made.sha : null }).catch(() => undefined);
    if (made.merged && !ours) return { updated: true, conflict: false, message: `${made.message}, onto a head that had moved: reviewed as any push` };
    return { updated: made.merged, conflict: made.conflict, message: made.message };
  }

  private async advanceOnce(repoName: string): Promise<MergeLineStep | null> {
    const repo = await repos.getRepoByName(repoName);
    if (!repo) return null;

    const entry = await mergeLines.head(repo.id);
    if (!entry) return null;

    const automation = await asAutomation(this.actors, this.config);
    if (!automation) return null;

    const pull = await automation.getPullRequest(repo.fullName, entry.prNumber).catch(() => null);
    if (!pull) {
      await mergeLines.leave(repo.id, entry.prNumber);
      return { repo: repo.name, prNumber: entry.prNumber, state: 'left', detail: 'the pull request is gone' };
    }

    if (pull.merged || pull.state === 'closed') {
      await mergeLines.setState(entry.id, pull.merged ? 'merged' : 'failed', {
        detail: pull.merged ? 'merged' : 'closed without merging',
      });
      // The next one is now at the front, and the caller comes back for it.
      return { repo: repo.name, prNumber: entry.prNumber, state: pull.merged ? 'merged' : 'failed', detail: 'left the line' };
    }

    // Nothing from a fork, and nothing onto a branch but the default one, goes
    // through the line: its branch is not the crew's to update, and the human
    // paths are read from the default branch's AGENTS.md, which a pull request
    // into a branch a bot made could have had taken out.
    const foreign =
      pull.headRepoFullName?.toLowerCase() !== repo.fullName.toLowerCase()
        ? `its head is in ${pull.headRepoFullName ?? 'a repository that is gone'}`
        : pull.baseRef !== repo.defaultBranch
          ? `it is based on ${pull.baseRef}, not ${repo.defaultBranch}`
          : null;
    if (foreign) {
      await mergeLines.setState(entry.id, 'failed', { detail: `not for the merge line: ${foreign}` });
      return { repo: repo.name, prNumber: entry.prNumber, state: 'failed', detail: `left the line: ${foreign}` };
    }

    // An issue's pull request lands only while the issue is in Review. A
    // person who moved the card back to Build meant it to wait for more work,
    // and whatever put it in the line since would have landed it anyway. The
    // gate sweep asks only of issues in Review; this is the same filter, for
    // whatever path let it in. A stage that cannot be read waits.
    const issueNumber = issueNumberFromBranch(pull.headRef);
    if (issueNumber) {
      let stage: string | null;
      try {
        stage = (await issues.getIssue(repo.id, issueNumber))?.stage ?? null;
      } catch (error) {
        const why = `could not read the stage of #${issueNumber}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
        await mergeLines.setState(entry.id, 'waiting', { detail: why });
        return { repo: repo.name, prNumber: entry.prNumber, state: 'waiting', detail: why };
      }
      if (stage && stage !== 'review') {
        const why = `its issue #${issueNumber} is in ${stage}, not review`;
        await mergeLines.leave(repo.id, entry.prNumber);
        await this.leaveFor(repo.name, entry.prNumber, why, false);
        return { repo: repo.name, prNumber: entry.prNumber, state: 'left', detail: `left the line: ${why}` };
      }
    }

    // A comparison that failed is not "up to date". Read as 0, it skipped the
    // update, and a branch behind its base landed with CI that never ran
    // against the main it joined. It waits, as the other unread steps do.
    let behind: number;
    try {
      behind = await automation.behindBy(repo.fullName, pull.baseRef, pull.headSha);
    } catch (error) {
      const why = `could not compare it with ${pull.baseRef}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
      await mergeLines.setState(entry.id, 'waiting', { detail: why });
      return { repo: repo.name, prNumber: entry.prNumber, state: 'waiting', detail: why };
    }

    if (behind > 0) {
      // An update it already asked for, from this head, is still being made.
      // Asking again sent a second request after GitHub's 202, which answers
      // 422 once the first lands and moves the head.
      const key = `${repo.fullName.toLowerCase()}#${entry.prNumber}@${pull.headSha}`;
      if (entry.state === 'updating' && entry.headSha === pull.headSha) {
        const since = this.updateWaited.get(key) ?? this.now();
        this.updateWaited.set(key, since);
        if (this.now() - since < UPDATE_WAIT_MS) {
          return { repo: repo.name, prNumber: entry.prNumber, state: 'updating', detail: `still updating from ${pull.baseRef}` };
        }
      }
      this.updateWaited.delete(key);
      const updater = await this.updaterFor(repo.name);
      const client = (await this.actors.asBot(updater)) ?? automation;
      // A stacked branch's first update takes out what its dependency landed.
      // It is noted first, then made with a call that answers with the commit
      // it made; the approvals stand only for a push to that exact SHA, whose
      // first parent is the head read here (`stacking.ts`).
      const stacked =
        (await this.stacks
          ?.updating({
            repoName: repo.name,
            repoFullName: repo.fullName,
            prNumber: entry.prNumber,
            issue: issueNumberFromBranch(pull.headRef),
            baseRef: pull.baseRef,
            headSha: pull.headSha,
          })
          .catch(() => false)) ?? false;
      const result = stacked
        ? await this.stackedUpdate(client, repo, entry.prNumber, pull)
        : await client.updateBranch(repo.fullName, entry.prNumber, pull.headSha);

      if (result.conflict) {
        // Only the branch's owner can resolve this, so it leaves the line. A
        // short resolution round when there is one to open (`conflict-round.ts`):
        // the whole round, card back to Build and every reviewer again, was
        // what two changes adding a line each to one Makefile cost.
        await mergeLines.setState(entry.id, 'failed', { detail: `conflicts with ${pull.baseRef}` });
        if (this.conflicts) {
          await this.leaveFor(repo.name, entry.prNumber, `the branch conflicts with ${pull.baseRef}`, false);
          await this.conflicts.start({ repoName: repo.name, prNumber: entry.prNumber, baseRef: pull.baseRef }).catch((error: unknown) =>
            console.warn(`[bridge] ${repo.name}#${entry.prNumber}: no resolution round: ${error instanceof Error ? error.message : error}`),
          );
        } else {
          await this.leaveFor(repo.name, entry.prNumber, `the branch conflicts with ${pull.baseRef}`, true);
        }
        return {
          repo: repo.name,
          prNumber: entry.prNumber,
          state: 'failed',
          detail: `conflicts with ${pull.baseRef}; handed back to its owner`,
        };
      }

      // The head it was asked from is recorded, so the next tick knows the
      // update is under way rather than asking for it again. A head that moved
      // since it was read, or any other refusal, waits with GitHub's words.
      await mergeLines.setState(entry.id, result.updated ? 'updating' : 'waiting', {
        ...(result.updated ? { headSha: pull.headSha } : {}),
        detail: result.updated ? `updating from ${pull.baseRef}` : result.message,
      });
      return {
        repo: repo.name,
        prNumber: entry.prNumber,
        state: result.updated ? 'updating' : 'waiting',
        detail: result.updated ? `brought up to date with ${pull.baseRef} as ${updater}` : result.message,
      };
    }

    // Up to date: what matters now is whether the checks have reported on this
    // exact commit, which is the head that will become part of the base branch.
    const checks = await automation.checksFor(repo.fullName, pull.headSha).catch(() => []);

    // A crew pull request's CI runs only with `adlc:ci` on it, and it is put
    // on here: the lead approved (it would not be in the line otherwise), it
    // is at the front, and it is up to date, so the one run is on the head
    // that lands. A branch update re-runs it, the label still on.
    if (pull.headRef.startsWith('agent/') && !checks.some((check) => check.name === REQUIRED_CHECK)) {
      return this.askForCi(repo, entry, pull);
    }

    const verdict = verdictFor(checks);

    if (verdict === 'red') {
      // CI's own failure is `onCiRun`'s: run again once, then back to build.
      await mergeLines.setState(entry.id, 'failed', { detail: 'checks failed on the updated head' });
      await this.leaveFor(repo.name, entry.prNumber, 'the checks failed once the branch was up to date', false);
      return {
        repo: repo.name,
        prNumber: entry.prNumber,
        state: 'failed',
        detail: 'checks failed on the updated head',
      };
    }

    if (verdict === 'pending') {
      await mergeLines.setState(entry.id, 'testing', {
        headSha: pull.headSha,
        detail: 'waiting for the checks on the updated head',
      });
      return { repo: repo.name, prNumber: entry.prNumber, state: 'testing', detail: 'waiting for checks' };
    }

    // Green and up to date. The bridge lands it, as the app, when every rule
    // holds; otherwise auto-merge, if the builder enabled it, or a person.
    let held: string | null = null;
    if (this.automation && !(await this.mergesOff(repo.name))) {
      const landed = await this.land(repo, entry, pull, automation);
      if (landed.step) return landed.step;
      held = landed.held;
    }

    const detail = pull.autoMerge
      ? 'green and up to date; auto-merge will land it'
      : `green and up to date; ${WAITING_FOR_PERSON}${held ? `: OpenADLC did not, because ${held}` : ''}`;
    // Said once for each reason. Every tick and every review advances the line,
    // and a pull request waiting on a person had the same comment again each
    // time; the entry's detail is what was last said.
    const said = entry.state === 'merging' && entry.detail === detail;
    await mergeLines.setState(entry.id, 'merging', { headSha: pull.headSha, detail });

    if (!pull.autoMerge && !said) {
      await automation
        .comment(
          repo.fullName,
          entry.prNumber,
          'This is at the front of the merge line, up to date with the base branch, and every required check is green. ' +
            (held ? `OpenADLC did not merge it, because ${held}, so it is waiting to be merged.` : 'Auto-merge is not enabled, so it is waiting to be merged.'),
        )
        .catch(() => undefined);
    }

    return {
      repo: repo.name,
      prNumber: entry.prNumber,
      state: 'merging',
      detail: pull.autoMerge ? 'auto-merge will land it' : 'waiting to be merged',
    };
  }

  /** Whether an install turned the bridge's merging off for this repository. */
  private async mergesOff(repoName: string): Promise<boolean> {
    // Settings that cannot be read may be the ones that turned it off: a merge
    // waits rather than land in a repository its operator took out.
    const live = await effectiveConfig(this.config).catch(() => null);
    if (!live || !live.settingsRead) return true;
    return live.bridgeMergeOff.includes(repoName.toLowerCase());
  }

  /**
   * Merges the pull request at the front of the line when `mergeDecision` says
   * every rule holds on its head, as the app, and says so: an audit entry that
   * names every approval it landed on, and a comment on the pull request.
   * Otherwise it says why not (`held`), and the line waits for a person.
   */
  private async land(
    repo: { name: string; fullName: string; defaultBranch: string },
    entry: { id: string; prNumber: number },
    pull: Parameters<Automation['mergeFacts']>[1],
    automation: Pick<GitHubClient, 'comment' | 'getPullRequest'>,
  ): Promise<{ step: MergeLineStep | null; held: string | null }> {
    const facts = await this.automation?.mergeFacts(repo, pull).catch(() => null);
    if (!facts) return { step: null, held: 'GitHub could not be read in full to check its approvals' };
    const decision = mergeDecision(facts);
    // A crew pull request that strayed outside its lease goes back to its
    // builder, as a conflict does: nothing about it needs a person, and the
    // builder is the one who can take the files out or ask for them.
    if (!decision.land && decision.sendBack) {
      const detail = 'changes files outside its lease; sent back to build';
      await mergeLines.setState(entry.id, 'failed', { detail });
      await this.leaveFor(repo.name, entry.prNumber, decision.reason, true, {
        reason: `The branch left the merge line: ${decision.reason}, run fleetadlc-ci, and push.`,
        leasePathsOnly: true,
      });
      return { step: { repo: repo.name, prNumber: entry.prNumber, state: 'failed', detail }, held: null };
    }
    if (!decision.land) return { step: null, held: decision.reason };

    let merged: { sha: string } | null;
    try {
      merged = (await this.automation?.mergeAsApp(repo.fullName, entry.prNumber, pull.headSha)) ?? null;
    } catch (error) {
      // Merged after all — by a person, or by another advance that got there
      // first — is not a refusal, and says nothing that is not true.
      const now = await automation.getPullRequest(repo.fullName, entry.prNumber).catch(() => null);
      if (now?.merged) {
        await mergeLines.setState(entry.id, 'merged', { detail: 'merged' });
        return { step: { repo: repo.name, prNumber: entry.prNumber, state: 'merged', detail: 'left the line' }, held: null };
      }
      return { step: null, held: `GitHub refused the merge (${error instanceof Error ? error.message : String(error)})` };
    }
    // Where to look, since the reason is not carried this far: "cannot be
    // asked to merge it" left a person whose app was not installed on a new
    // repository with nothing to act on. No "because " in it: `heldForPerson`
    // splits on the first.
    if (!merged) {
      return { step: null, held: `the OpenADLC app could not get a token for ${repo.fullName} (the app’s card on the board, or fleetadlc doctor, says why)` };
    }

    await mergeLines.setState(entry.id, 'merged', { headSha: pull.headSha, detail: `merged by OpenADLC as ${merged.sha.slice(0, 7)}` });
    try {
      await audit({
        actor: 'fleetadlc-app',
        action: 'merge.landed',
        target: `${repo.name}#${entry.prNumber}`,
        payload: { head: pull.headSha, merged: merged.sha, method: 'squash', approvals: decision.approvals, checks: REQUIRED_CHECKS },
      });
    } catch (error) {
      // The merge happened; its record did not. Said as loudly as the bridge
      // says anything, with what the entry would have held, and the comment
      // still goes on the pull request, where the approvals are then written.
      console.error(
        `[bridge] AUDIT NOT WRITTEN: ${repo.name}#${entry.prNumber} was merged by OpenADLC as ${merged.sha} (head ${pull.headSha}) ` +
          `on ${JSON.stringify(decision.approvals)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await automation.comment(repo.fullName, entry.prNumber, landedComment(pull.headSha, merged.sha, decision.approvals)).catch(() => undefined);
    return {
      step: { repo: repo.name, prNumber: entry.prNumber, state: 'merged', detail: `merged by OpenADLC as ${merged.sha.slice(0, 7)}` },
      held: null,
    };
  }

  /**
   * Puts `adlc:ci` on the head at the front of the line, or puts it back when
   * no `ci` run has appeared for it in `CI_REQUEST_WAIT_MS`. Each ask is
   * audited as `ci.requested`.
   */
  private async askForCi(
    repo: { name: string; fullName: string },
    entry: { id: string; prNumber: number },
    pull: { headSha: string; labels: string[] },
  ): Promise<MergeLineStep> {
    const key = `${repo.fullName.toLowerCase()}#${entry.prNumber}@${pull.headSha}`;
    const at = this.ciAsked.get(key);
    const labelled = pull.labels.includes(CI_LABEL);
    const waiting = (detail: string): Promise<MergeLineStep> =>
      mergeLines
        .setState(entry.id, 'testing', { headSha: pull.headSha, detail })
        .then(() => ({ repo: repo.name, prNumber: entry.prNumber, state: 'testing', detail }));

    // On already, from an earlier head: the push that made this head runs CI.
    if (labelled && at === undefined) {
      this.ciAsked.set(key, this.now());
      return waiting(`waiting for GitHub's CI on ${pull.headSha.slice(0, 7)}`);
    }
    if (labelled && at !== undefined && this.now() - at < CI_REQUEST_WAIT_MS) {
      return waiting(`waiting for GitHub's CI on ${pull.headSha.slice(0, 7)}`);
    }
    if (!this.automation) return waiting(`no ${REQUIRED_CHECK} run on ${pull.headSha.slice(0, 7)}, and nothing here can ask for one`);

    // At the month's cap a person set, no new run is asked for: a run already
    // asked for goes on, and the line waits here, saying why, until the cap is
    // raised or the month turns. One that cannot be read holds nothing.
    const capped = await this.ciCap?.().catch(() => null);
    if (capped) return waiting(capped);

    const again = labelled;
    ciRequests.set(`${repo.fullName.toLowerCase()}#${entry.prNumber}`, this.now());
    this.ciAsked.set(key, this.now());
    try {
      // Off and on again: a label already there fires nothing when added.
      if (again) await this.automation.setCiLabel(repo.fullName, entry.prNumber, false);
      const as = await this.automation.setCiLabel(repo.fullName, entry.prNumber, true);
      await audit({
        actor: as === 'app' ? 'fleetadlc-app' : 'bridge',
        action: 'ci.requested',
        target: `${repo.name}#${entry.prNumber}`,
        payload: { head: pull.headSha, again },
      }).catch(() => undefined);
    } catch (error) {
      this.ciAsked.delete(key);
      return waiting(`could not put ${CI_LABEL} on it: ${error instanceof Error ? error.message : String(error)}`);
    }
    return waiting(
      again ? `no ${REQUIRED_CHECK} run appeared; asked GitHub's CI again on ${pull.headSha.slice(0, 7)}` : `asked GitHub's CI to run on ${pull.headSha.slice(0, 7)}`,
    );
  }

  /**
   * Says on the pull request why it left the line. A conflict is the
   * builder's to resolve, so it goes back to build with that as its reason
   * (`SendBack`); a red check is `onCiRun`'s, which runs CI again once first.
   * `sentBack` is what the round is told instead of how to resolve a
   * conflict: for a change that strayed, the files and how to put it right.
   */
  private async leaveFor(
    repoName: string,
    prNumber: number,
    reason: string,
    backToBuild: boolean,
    sentBack?: { reason: string; leasePathsOnly?: boolean },
  ): Promise<void> {
    const repo = await repos.getRepoByName(repoName);
    const automation = await asAutomation(this.actors, this.config);
    if (repo) {
      await automation
        ?.comment(repo.fullName, prNumber, `Leaving the merge line: ${reason}.`)
        .catch(() => undefined);
    }
    if (backToBuild && this.backToBuild) {
      const told = sentBack ?? { reason: `The branch left the merge line: ${reason}. Bring it up to date and resolve it, run fleetadlc-ci, and push.` };
      await this.backToBuild({ repoName, prNumber, ...told }).catch(
        (error: unknown) => console.warn(`[bridge] ${repoName}#${prNumber} was not sent back to build: ${error instanceof Error ? error.message : error}`),
      );
    }
  }

  /** Every repository, one step each. The scheduler's tick and the safety net. */
  async advanceAll(): Promise<string[]> {
    const steps: string[] = [];
    for (const repo of await repos.listRepos()) {
      const step = await this.advance(repo.name).catch((error: unknown) => {
        console.warn(`[bridge] merge line for ${repo.name}: ${error instanceof Error ? error.message : error}`);
        return null;
      });
      if (step) steps.push(`${step.repo}#${step.prNumber}: ${step.detail}`);
    }
    return steps;
  }
}
