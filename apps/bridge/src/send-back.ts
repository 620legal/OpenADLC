import { audit, bots, deployRuns, issues, leases, listEventsOfTypeWith, recordEvent, repos, stageMoves, tasks, threads } from '@fleetadlc/db';
import type { GitHubClient } from '@fleetadlc/github';
import {
  STAGE_COLUMN_TITLES,
  STAGE_KEYS,
  pathsOverlap,
  previousStage,
  inertMarkup,
  renderMarker,
  type Lease,
  type StageKey,
  type TaskKind,
} from '@fleetadlc/shared';
import { reviewLimits, type Automation } from './automation.js';
import type { BridgeConfig } from './config.js';
import type { MergeLine } from './merge-line.js';
import type { StageHandoff } from './stage-handoff.js';
import type { TaskService } from './task-service.js';
import { publicNameOf } from './thread-view.js';
import { DEPLOY_PATH_BRANCH_PREFIX, issueNumberFromBranch, REVIEW_STALLED, SEND_BACK_STALLED, SEND_BACK_TO_PERSON, stageOfTask } from './work.js';

/**
 * Sending work back to the stage before it.
 *
 * Every stage could only hand on. A design that missed what the issue asked, an
 * issue that could not be built as filed, a deploy that failed on the change
 * itself: each was a task that failed, or worse finished, and a person found
 * out from the card. Now the stage that finds it sends the work back with a
 * reason, to the stage `previousStage` names from the issue's own history, and
 * that stage starts again with the reason in front of it (`sent-back.md`,
 * `context.ts`).
 *
 * GitHub is the record: the bridge says it on the issue as the automation
 * account, with a `send_back` marker that is only ever recorded, never acted
 * on — anyone who can comment could write one. What asks for a send-back is a
 * task's own session, through `POST /internal/tasks/:id/send-back` with its
 * task token; review to build is the review loop (`reviewRound`); and a person
 * moves a card anywhere (`fromPerson`).
 */

export { sentBackReason } from './work.js';

/**
 * The stage a task's work is in, for the kinds that send work back: design,
 * build (a build or a patch round), and ship. Intake is the first stage — it
 * asks the person instead — and a reviewer sends work back by requesting
 * changes, which is the review loop's round.
 */
export function stageOfSender(kind: TaskKind): StageKey | null {
  if (kind === 'spec') return 'spec';
  if (kind === 'implement' || kind === 'patch') return 'build';
  if (kind === 'deploy') return 'merged';
  return null;
}

export type SendBackResult =
  | { sent: true; from: StageKey; to: StageKey; staffed: boolean; round: number; commentUrl: string | null }
  | { sent: false; reason: string; stalled?: boolean };

export interface SendBackDeps {
  config: Pick<BridgeConfig, 'review'>;
  automation: Pick<Automation, 'moveStage' | 'comment' | 'parkPull' | 'reopenIssue' | 'addLabels' | 'setCiLabel'>;
  mergeLine: Pick<MergeLine, 'leave'>;
  taskService: Pick<TaskService, 'open'>;
  /** Starts the bot of the stage work went back to, for a person's move; a task's send-back is staffed when the task ends. */
  stages?: Pick<StageHandoff, 'staff'> | null;
  /** Stops work a person's move left behind (`stopTask` in api.ts). */
  stopTask?: ((taskId: string, actor: string, note: string) => Promise<unknown>) | null;
  /** Asked for a dispatch when work went back to build with nobody holding it. */
  dispatchRuns?: { soon(reason: string): void } | null;
  /** Reads GitHub as the automation account, for the merge line's and CI's send-backs. */
  client?: (() => Promise<GitHubClient | null>) | null;
}

const title = (stage: StageKey): string => STAGE_COLUMN_TITLES[stage];
const quoted = (text: string): string =>
  text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
const refuse = (reason: string): SendBackResult => ({ sent: false, reason });

/**
 * Takes an issue's lease again for its pull request, when nothing holds the
 * issue: the pull request was closed unmerged, which released the lease, and
 * then reopened; or the reconciler let the lease go while the pull request
 * stayed open. With no lease, a request for changes, a red CI run or a
 * conflict opened no patch round and the work stopped where nobody saw it.
 *
 * The same builder and paths as the last lease linked to the pull request,
 * and only while that is still right: the issue is on the board in Review or
 * Build (one closed unmerged has been forgotten by the reconciler, and
 * reviving its work would be wrong), its builder is still in the crew, and no
 * other lease has taken any of its paths since. Otherwise, why not.
 */
export async function retakeLease(input: {
  repo: { id: string; name: string };
  issueNumber: number;
  prNumber: number;
  crew: readonly { id: string; name: string }[];
  reason: string;
}): Promise<{ lease: Lease; why: null } | { lease: null; why: string }> {
  const { repo, issueNumber, prNumber } = input;
  const no = (why: string) => ({ lease: null, why }) as const;
  const issue = await issues.getIssue(repo.id, issueNumber).catch(() => null);
  if (!issue) return no(`#${issueNumber} is no longer on the board`);
  if (issue.stage !== 'review' && issue.stage !== 'build') return no(`#${issueNumber} is in ${title(issue.stage)}, not in review or build`);
  const last = await leases.lastForPullRequest(repo.id, prNumber).catch(() => null);
  if (!last || last.issueNumber !== issueNumber) return no(`no lease on #${issueNumber} was ever linked to #${prNumber}`);
  if (last.state !== 'released') return no(`the last lease on #${issueNumber} for #${prNumber} is ${last.state}, not released`);
  const builder = input.crew.find((bot) => bot.id === last.botId);
  if (!builder) return no(`the builder that held #${issueNumber} is no longer in the crew`);
  const taken = (await leases.listActiveLeases(repo.id).catch(() => [])).find(
    (other) => other.issueNumber !== issueNumber && pathsOverlap(other.declaredPaths, last.declaredPaths),
  );
  if (taken) return no(`#${taken.issueNumber} now holds paths #${issueNumber} declared`);
  const lease = await leases
    .reacquireForPullRequest({ repoId: repo.id, issueNumber, prNumber, actor: 'bridge', reason: input.reason })
    .catch(() => null);
  if (!lease) return no(`another lease now holds #${issueNumber}, or the lease could not be written`);
  console.log(`[bridge] ${repo.name}#${issueNumber}: took the lease again for #${prNumber} (${input.reason})`);
  return { lease, why: null };
}

export class SendBack {
  constructor(private readonly deps: SendBackDeps) {}

  /**
   * A task asking to send its work back: the only way a bot moves a card
   * backwards. The stage it names has to be exactly the one `previousStage`
   * works out; a bot that names another is refused, and so is one past its
   * limits, which hands the issue to a person instead.
   */
  async request(input: { taskId: string; to: string; reason: string }): Promise<SendBackResult> {
    const reason = input.reason.trim().slice(0, 4000);
    if (!reason) return refuse('a send-back needs a reason: the stage it goes to works from it');
    const task = await tasks.getTask(input.taskId);
    if (!task) return refuse('there is no such task');
    if (task.state !== 'running') return refuse(`the task is ${task.state}; only a running task sends its work back`);
    const from = stageOfSender(task.kind);
    if (!from) {
      return refuse(
        task.kind === 'review'
          ? 'a reviewer sends work back by requesting changes in its review'
          : task.kind === 'intake' || task.kind === 'request'
            ? 'intake is the first stage: ask the person instead'
            : `a ${task.kind} task does not send work back`,
      );
    }
    const repo = task.repoId ? (await repos.listRepos()).find((entry) => entry.id === task.repoId) : null;
    if (repo && task.kind === 'deploy' && task.branch?.startsWith(DEPLOY_PATH_BRANCH_PREFIX)) {
      return this.changeAtCommit({ task, repo, to: input.to, reason, short: task.branch.slice(DEPLOY_PATH_BRANCH_PREFIX.length) });
    }
    const issueNumber = repo ? await issueOf(task, repo.name) : null;
    if (!repo || !issueNumber) return refuse('this task’s work is not an issue OpenADLC tracks, so there is nothing to send back');
    if (!(STAGE_KEYS as readonly string[]).includes(input.to)) return refuse(`${input.to} is not a stage`);
    const bot = await bots.getBotById(task.botId).catch(() => null);
    return this.send({ repo, issueNumber, from, to: input.to as StageKey, reason, actor: bot?.name ?? 'a bot', taskId: task.id });
  }

  /**
   * The SRE after a failed testing deploy works on the issue the bridge filed
   * (`Webhooks.reportDeployFailure`), not on the change. When the change is
   * what broke the deploy, the work that goes back to build is the change's
   * issue, and the commit is the one the task's branch names, which the
   * bridge chose: a session cannot name another change to send back.
   */
  private async changeAtCommit(input: {
    task: { id: string; botId: string };
    repo: repos.RepoRecord;
    to: string;
    reason: string;
    short: string;
  }): Promise<SendBackResult> {
    const { repo, short } = input;
    if (!(STAGE_KEYS as readonly string[]).includes(input.to)) return refuse(`${input.to} is not a stage`);
    const changes = await mergedAt(repo, short);
    if (changes.length === 0) {
      return refuse(`no issue in ${title('merged')} on the board was merged at ${short}, so there is no change to send back; say what broke on the issue, and a person moves the change`);
    }
    const bot = await bots.getBotById(input.task.botId).catch(() => null);
    const results: SendBackResult[] = [];
    for (const issueNumber of changes) {
      results.push(await this.send({ repo, issueNumber, from: 'merged', to: input.to as StageKey, reason: input.reason, actor: bot?.name ?? 'a bot', taskId: input.task.id }));
    }
    return results.find((result) => result.sent) ?? results[0]!;
  }

  /**
   * The bridge sending work back on its own, from what it saw: a deploy whose
   * smoke failed on the change, a production deploy that failed. It goes
   * where `previousStage` says and is held to the same limits as a task's.
   */
  async fromBridge(input: { repoName: string; issueNumber: number; from: StageKey; reason: string }): Promise<SendBackResult> {
    const repo = await repos.getRepoByName(input.repoName);
    if (!repo) return refuse(`${input.repoName} is not a repository OpenADLC works in`);
    const history = await stageMoves.listForIssue(repo.id, input.issueNumber).catch(() => []);
    const back = previousStage(input.from, history, repo.stageModes);
    if (!back) return refuse(`${title(input.from)} has no stage before it to send work back to`);
    return this.send({ repo, issueNumber: input.issueNumber, from: input.from, to: back.to, reason: input.reason, actor: 'fleetadlc', taskId: null });
  }

  private async send(input: {
    repo: repos.RepoRecord;
    issueNumber: number;
    from: StageKey;
    to: StageKey;
    reason: string;
    actor: string;
    /** The task that asked; null when the bridge sends it back itself. */
    taskId: string | null;
  }): Promise<SendBackResult> {
    const { repo, issueNumber, from } = input;
    const ref = `${repo.name}#${issueNumber}`;
    const issue = await issues.getIssue(repo.id, issueNumber);
    if (!issue) return refuse(`${ref} is not on the board`);
    if (issue.stage !== from) return refuse(`${ref} is in ${title(issue.stage)}, not ${title(from)}, so there is no ${title(from)} work of it to send back`);

    const history = await stageMoves.listForIssue(repo.id, issueNumber);
    const back = previousStage(from, history, repo.stageModes);
    if (!back) return refuse(`${title(from)} has no stage before it to send work back to`);
    if (input.to !== back.to) {
      return refuse(
        `${title(from)} sends ${ref} back to ${title(back.to)}, not ${title(input.to)}: that is the stage before it in this issue’s history. ` +
          `Send it back to ${back.to}, or ask a person to move it.`,
      );
    }

    // Review to build is the review loop's, counted by `maxRounds`; these
    // limits are for every other edge.
    const rules = reviewLimits(this.deps.config.review).sendBack;
    const earlier = history.filter((move) => move.kind === 'send_back' && move.from !== 'review');
    const onEdge = earlier.filter((move) => move.from === from && move.to === back.to).length;
    if (onEdge >= rules.maxPerEdge || earlier.length >= rules.maxPerIssue) {
      const which =
        onEdge >= rules.maxPerEdge ? `${onEdge} times from ${title(from)} to ${title(back.to)}` : `${earlier.length} times in all`;
      return this.stall({ repo, issueNumber, from, to: back.to, actor: input.actor, reason: input.reason, taskId: input.taskId, which });
    }
    const round = onEdge + 1;

    // The task that sent it back has nothing left to ask.
    if (input.taskId) await threads.expireGatesOfTask(input.taskId, 'bridge', `the work was sent back to ${back.to}`).catch(() => []);

    // GitHub first: the comment is what the receiving stage reads, and what a
    // person sees when they open the issue.
    const commentUrl = await this.deps.automation
      .comment(repo.fullName, issueNumber, recordComment({ from, to: back.to, by: input.actor, round, reason: input.reason, staffed: back.staffed }))
      .catch((error: unknown) => {
        console.warn(`[bridge] ${ref}: the send-back was not said on the issue: ${error instanceof Error ? error.message : error}`);
        return null;
      });

    // A merge closed the issue; work sent back to build is open again.
    if (from === 'merged') {
      await this.deps.automation.reopenIssue(repo.fullName, issueNumber).catch((error: unknown) =>
        console.warn(`[bridge] ${ref} was not reopened: ${error instanceof Error ? error.message : error}`),
      );
    }

    const moved = await this.deps.automation.moveStage({
      repoName: repo.name,
      issueNumber,
      to: back.to,
      actor: input.actor,
      direction: 'send_back',
      reason: input.reason,
      taskId: input.taskId,
      prNumber: issue.prNumber,
      commentUrl,
    });
    if (!moved.moved) return refuse(moved.reason ?? `${ref} could not be moved to ${back.to}`);

    await this.letGoOfBuild({ repo, issueNumber, prNumber: issue.prNumber, to: back.to, from, why: `sent back to ${back.to}` });
    if (!back.staffed) await this.toPerson({ repo, issueNumber, from, to: back.to, by: input.actor, reason: input.reason });

    await audit({
      actor: input.actor,
      action: 'stage.sent_back',
      target: ref,
      payload: { from, to: back.to, reason: input.reason, task: input.taskId, round, staffed: back.staffed, comment: commentUrl },
    }).catch(() => undefined);
    console.log(`[bridge] ${ref}: ${input.actor} sent it back from ${from} to ${back.to}: ${input.reason.slice(0, 200)}`);
    return { sent: true, from, to: back.to, staffed: back.staffed, round, commentUrl };
  }

  /**
   * Past a limit: nothing moves, `needs-human` goes on, and a person decides —
   * as a review loop that does not converge stops and asks rather than going
   * round again.
   */
  private async stall(input: {
    repo: repos.RepoRecord;
    issueNumber: number;
    from: StageKey;
    to: StageKey;
    actor: string;
    reason: string;
    taskId: string | null;
    which: string;
  }): Promise<SendBackResult> {
    const ref = `${input.repo.name}#${input.issueNumber}`;
    await this.deps.automation.addLabels(input.repo.fullName, input.issueNumber, ['needs-human']).catch(() => undefined);
    await this.deps.automation
      .comment(
        input.repo.fullName,
        input.issueNumber,
        [
          `**Not sent back to ${title(input.to)}.** ${input.actor} asked to, because:`,
          '',
          quoted(input.reason),
          '',
          `It has gone back ${input.which} already, so a person decides: answer here and take \`needs-human\` off, move the card yourself, or close the issue.`,
          renderMarker({ event: 'send_back', from: input.from, to: input.to, by: input.actor, stalled: true }),
        ].join('\n'),
      )
      .catch(() => null);
    if (input.taskId) await threads.expireGatesOfTask(input.taskId, 'bridge', 'the send-back was refused at its limit').catch(() => []);
    await recordEvent({
      source: 'platform',
      type: SEND_BACK_STALLED,
      payload: { repo: input.repo.name, issue: input.issueNumber, from: input.from, to: input.to, by: input.actor, reason: input.reason, task: input.taskId },
    }).catch(() => undefined);
    await audit({ actor: input.actor, action: 'send_back.stalled', target: ref, payload: { from: input.from, to: input.to, which: input.which } }).catch(() => undefined);
    return { sent: false, stalled: true, reason: `${ref} has gone back ${input.which} already; a person decides now` };
  }

  /**
   * Work that left build lets go of what build held: the lease's files, and a
   * pull request still open, which is made a draft again and taken out of the
   * merge line, so nothing reviews or lands it meanwhile. The branch stays,
   * and the next build goes on from it (`internal-api.ts`, the lease route).
   */
  private async letGoOfBuild(input: { repo: repos.RepoRecord; issueNumber: number; prNumber: number | null; from: StageKey; to: StageKey; why: string }): Promise<void> {
    const ref = `${input.repo.name}#${input.issueNumber}`;
    const beforeBuild = input.to === 'intake' || input.to === 'spec';
    // A merged change held its lease for the verification after it; sent
    // back, there is nothing to verify, and the next build takes a lease of its own.
    if (beforeBuild || input.from === 'merged') {
      const lease = await leases.getActiveLease(input.repo.id, input.issueNumber).catch(() => null);
      if (lease) {
        await leases.setLeaseState(lease.id, 'released').catch(() => undefined);
        await audit({ actor: 'bridge', action: 'lease.released', target: ref, payload: { leaseId: lease.id, reason: input.why } }).catch(() => undefined);
      }
    }
    if (input.from === 'merged') this.deps.dispatchRuns?.soon(`${ref} ${input.why}`);
    if (!beforeBuild || !input.prNumber) return;
    await this.deps.mergeLine.leave(input.repo.name, input.prNumber).catch(() => undefined);
    await this.deps.automation.parkPull(input.repo.fullName, input.prNumber).catch((error: unknown) =>
      console.warn(`[bridge] ${ref}: #${input.prNumber} was not made a draft: ${error instanceof Error ? error.message : error}`),
    );
  }

  /** Work went back to a stage nobody staffs: the issue waits for a person, said as a card. */
  private async toPerson(input: { repo: repos.RepoRecord; issueNumber: number; from: StageKey; to: StageKey; by: string; reason: string }): Promise<void> {
    await this.deps.automation.addLabels(input.repo.fullName, input.issueNumber, ['needs-human']).catch(() => undefined);
    await recordEvent({
      source: 'platform',
      type: SEND_BACK_TO_PERSON,
      payload: { repo: input.repo.name, issue: input.issueNumber, from: input.from, to: input.to, by: input.by, reason: input.reason },
    }).catch(() => undefined);
  }

  /**
   * Review to build: the lead requested changes, or CI failed after the lead
   * approved. The card goes back to Build, the lease stays with the builder,
   * and a patch round opens on the pull request's branch — the round the
   * review loop has always opened, now with the card where the work is. A
   * push that changes the diff moves it on to Review again (`onPullRequest`).
   * At `maxRounds` the loop stops and asks a person, and nothing moves.
   */
  async reviewRound(input: {
    repo: { id: string; name: string };
    repoFullName: string;
    pr: { number: number; head: { ref: string; sha?: string } };
    crew: readonly { id: string; name: string }[];
    client: Pick<GitHubClient, 'listPullFilesAsNamed'> | null;
    /** Who sent it back: the lead's seat, or `fleetadlc` for CI. */
    by: string;
    reason: string;
    /** Brief the round with the lease's paths alone, not the files in its diff: it was sent back for straying outside them. */
    leasePathsOnly?: boolean;
  }): Promise<void> {
    const { repo, repoFullName, pr } = input;
    const issueNumber = issueNumberFromBranch(pr.head.ref);
    let found = issueNumber ? await leases.getActiveLease(repo.id, issueNumber) : null;
    // Nothing holds the issue: its pull request was closed and reopened, or
    // the reconciler let the lease go. Taken again where it still can be.
    let why: string | null = null;
    if (!found && issueNumber) {
      const retaken = await retakeLease({ repo, issueNumber, prNumber: pr.number, crew: input.crew, reason: `${input.by} sent #${pr.number} back to build` });
      found = retaken.lease;
      why = retaken.why;
    }
    // A lease is for the pull request it records. A branch named like the
    // builder's is not enough: a stranger's fork pull request on one had the
    // issue's builder patch it, with its files added to the lease. Such a pull
    // request is one no builder holds.
    const lease = found && (found.prNumber === null || found.prNumber === undefined || found.prNumber === pr.number) ? found : null;
    const builder = lease ? input.crew.find((bot) => bot.id === lease.botId) : undefined;
    if (!lease || !builder) {
      // It used to end here with no log, no comment and no event, and the
      // work stalled with nothing on the board to say so.
      if (issueNumber) {
        why ??= !lease
          ? `the lease on #${issueNumber} is for #${found?.prNumber}, not #${pr.number}`
          : `the builder that held #${issueNumber} is no longer in the crew`;
        console.warn(`[bridge] ${repoFullName}#${pr.number}: not sent back to build: ${why}`);
      }
      if (input.crew.some((bot) => bot.name === input.by)) await this.nobodyToSendTo({ ...input, issue: issueNumber, why });
      else if (issueNumber && !(await this.stallSaid(repo.name, pr))) await this.recordStall({ repo, pr, issue: issueNumber, why });
      return;
    }
    const round = await this.nextRound({ repo, repoFullName, pr, issueNumber, lease, builder });
    if (round === null) return;

    if (issueNumber) {
      const commentUrl = await this.deps.automation
        .comment(repoFullName, issueNumber, recordComment({ from: 'review', to: 'build', by: input.by, round, reason: input.reason, staffed: true, pr: pr.number }))
        .catch(() => null);
      await this.deps.automation
        .moveStage({ repoName: repo.name, issueNumber, to: 'build', actor: input.by, direction: 'send_back', reason: input.reason, prNumber: pr.number, commentUrl })
        .catch((error: unknown) => console.warn(`[bridge] ${repo.name}#${issueNumber} was not moved back to build: ${error instanceof Error ? error.message : error}`));
    }
    await this.openPatch({ ...input, issueNumber, lease, builder, round });
  }

  /**
   * The number of the patch round to open on a pull request, or null at
   * `maxRounds`: then the loop stops, says so on the pull request, and asks a
   * person, and nothing is opened.
   */
  private async nextRound(input: {
    repo: { name: string };
    repoFullName: string;
    pr: { number: number };
    issueNumber: number | null;
    lease: { botId: string };
    builder: { id: string; name: string };
  }): Promise<number | null> {
    const { repo, repoFullName, pr, builder } = input;
    const maxRounds = reviewLimits(this.deps.config.review).maxRounds;
    // Rounds that ran. One that never began changed nothing, and counting
    // it spent the builder's last round on a live pull request before it had written
    // a line. Never began is `startedAt` unset — a round that ran and was
    // then refused a resume did run, and counts.
    // Every round on the pull request, however long ago and by whichever bot:
    // the builder's twenty newest tasks lost earlier rounds once it was busy
    // elsewhere, and the limit never came; a handover does not reset it
    // either. A conflict resolution is a patch no review asked for, and two
    // of them used up the budget before the next request for changes.
    const round = (await tasks.listTasksForSubjects('patch', [`${repo.name}#${pr.number}`])).filter(
      (task) => task.skill !== 'resolve-conflict' && !(task.state === 'failed' && !task.startedAt),
    ).length;
    if (round < maxRounds) return round + 1;

    await this.deps.automation.comment(
      repoFullName,
      pr.number,
      `${maxRounds} review ${maxRounds === 1 ? 'round has' : 'rounds have'} not converged. Stopping here and asking for a decision: override and merge (a person dismisses the review with a reason and approves), send back to spec, or take the branch.`,
    );
    // The comment is the record on GitHub, and nothing else remembered
    // it: the console had no way to know the loop had stopped, so a
    // person found out only by opening the pull request. The event is
    // what "needs you" and the card read.
    await recordEvent({
      source: 'platform',
      type: REVIEW_STALLED,
      payload: { repo: repo.name, pr: pr.number, issue: input.issueNumber, rounds: round, bot: builder.name, botId: builder.id },
    }).catch(() => undefined);
    return null;
  }

  /**
   * A person moved a card from Review back to Build while its pull request
   * is open. The pull request leaves the merge line and loses `adlc:ci`, so
   * no review still running lands it, and the builder's patch round opens on
   * its branch, as after the lead's request for changes: the lease stays
   * with the builder, so the dispatcher would start nothing. The person's
   * reason reaches the round in `sent-back.md`, from the move just recorded.
   * It stays ready for review: the round pushes to it, and that push moves
   * the card to Review again.
   */
  private async backFromReview(input: { repo: repos.RepoRecord; issueNumber: number; prNumber: number }): Promise<void> {
    const { repo, issueNumber, prNumber } = input;
    const ref = `${repo.name}#${issueNumber}`;
    await this.deps.mergeLine.leave(repo.name, prNumber).catch(() => undefined);
    await this.deps.automation.setCiLabel(repo.fullName, prNumber, false).catch((error: unknown) =>
      console.warn(`[bridge] ${ref}: adlc:ci was not taken off #${prNumber}: ${error instanceof Error ? error.message : error}`),
    );

    const client = (await this.deps.client?.().catch(() => null)) ?? null;
    const pull = client ? await client.getPullRequest(repo.fullName, prNumber).catch(() => null) : null;
    if (!pull || pull.state !== 'open') return;
    const found = await leases.getActiveLease(repo.id, issueNumber).catch(() => null);
    const lease = found && (found.prNumber === null || found.prNumber === undefined || found.prNumber === prNumber) ? found : null;
    const builder = lease ? await bots.getBotById(lease.botId).catch(() => null) : null;
    if (!lease || !builder) return;
    // A round already open on it has the reason too; a second would race it.
    const open = (await tasks.listTasksOnSubjects([`${repo.name}#${prNumber}`]).catch(() => [])).some(
      (task) => task.kind === 'patch' && ['queued', 'running', 'paused'].includes(task.state),
    );
    if (open) return;
    const pr = { number: prNumber, head: { ref: pull.headRef } };
    const round = await this.nextRound({ repo, repoFullName: repo.fullName, pr, issueNumber, lease, builder });
    if (round === null) return;
    await this.openPatch({ repo, repoFullName: repo.fullName, pr, client, issueNumber, lease, builder, round });
  }

  /**
   * The lead asked for changes on a pull request no builder holds: the SRE's
   * revert, a person's own branch, or one whose issue's lease has ended. The
   * round used to end there with no comment, no label and no card, and a
   * revert of a broken testing deploy never landed with nobody told. A person
   * decides now, once for each head the lead turned down.
   */
  private async nobodyToSendTo(input: {
    repo: { name: string };
    repoFullName: string;
    pr: { number: number; head: { ref: string; sha?: string } };
    by: string;
    /** The issue its branch names, and why nothing holds it, when it names one. */
    issue?: number | null;
    why?: string | null;
  }): Promise<void> {
    const { repo, repoFullName, pr } = input;
    if (await this.stallSaid(repo.name, pr)) return;
    await this.deps.automation
      .comment(
        repoFullName,
        pr.number,
        `${input.by} asked for changes, and no builder holds \`${pr.head.ref}\` to make them${input.why ? `: ${input.why}` : ''}. A person decides: fix it on the branch, or dismiss the review with a reason and approve.`,
      )
      .catch((error: unknown) => console.warn(`[bridge] ${repoFullName}#${pr.number}: the stalled review was not said: ${error instanceof Error ? error.message : error}`));
    await this.deps.automation.addLabels(repoFullName, pr.number, ['needs-human']).catch(() => undefined);
    await this.recordStall({ repo, pr, issue: input.issue ?? null, why: input.why ?? null });
  }

  /** Whether a stop for want of a builder was already recorded for this head, so a redelivery says nothing twice. */
  private async stallSaid(repoName: string, pr: { number: number; head: { sha?: string } }): Promise<boolean> {
    const said = await listEventsOfTypeWith(REVIEW_STALLED, { repo: repoName, pr: pr.number, ...(pr.head.sha ? { head: pr.head.sha } : {}) }).catch(() => []);
    return said.some((event) => {
      const payload = event.payload as { issue?: unknown; reason?: unknown } | null;
      return payload?.issue === null || typeof payload?.reason === 'string';
    });
  }

  /**
   * The review loop stopped for want of a lease or a builder: an event the
   * board shows as a stopped review, with why, until something moves.
   */
  private async recordStall(input: { repo: { name: string }; pr: { number: number; head: { sha?: string } }; issue: number | null; why: string | null }): Promise<void> {
    const { repo, pr } = input;
    await recordEvent({
      source: 'platform',
      type: REVIEW_STALLED,
      payload: {
        repo: repo.name,
        pr: pr.number,
        issue: input.issue,
        rounds: 0,
        bot: null,
        botId: null,
        ...(input.why ? { reason: input.why } : {}),
        ...(pr.head.sha ? { head: pr.head.sha } : {}),
      },
    }).catch(() => undefined);
  }

  /**
   * Review to build from the merge line or CI, which know only the pull
   * request: a branch that conflicts with the base, or CI that failed again
   * after the lead approved. The same round as a request for changes.
   */
  async backToBuild(input: { repoName: string; prNumber: number; reason: string; leasePathsOnly?: boolean }): Promise<void> {
    const repo = await repos.getRepoByName(input.repoName);
    const client = (await this.deps.client?.().catch(() => null)) ?? null;
    if (!repo || !client) return;
    const pull = await client.getPullRequest(repo.fullName, input.prNumber).catch(() => null);
    if (!pull || pull.state !== 'open') return;
    const crew = await bots.listBots();
    await this.reviewRound({
      repo,
      repoFullName: repo.fullName,
      pr: { number: input.prNumber, head: { ref: pull.headRef, sha: pull.headSha } },
      crew,
      client,
      by: 'fleetadlc',
      reason: input.reason,
      ...(input.leasePathsOnly ? { leasePathsOnly: true } : {}),
    });
  }

  private async openPatch(input: {
    repo: { id: string; name: string };
    repoFullName: string;
    pr: { number: number; head: { ref: string } };
    client: Pick<GitHubClient, 'listPullFilesAsNamed'> | null;
    issueNumber: number | null;
    lease: { id: string; declaredPaths?: string[] | null };
    builder: { id: string; name: string };
    round: number;
    leasePathsOnly?: boolean;
  }): Promise<void> {
    // What the round may write: the lease's paths, and every file the
    // pull request already changes — a widening a person approved is in
    // the diff, not the lease. With neither, the round could write only
    // tests and docs, and asked to be let at the very files the review
    // was about (found live). Not for a round sent back for
    // changing files outside its lease: those are in the diff too, and it
    // would have been let write the very files it is to take out. It can
    // still restore them to the base with git.
    const inDiff =
      input.client && !input.leasePathsOnly ? await input.client.listPullFilesAsNamed(input.repoFullName, input.pr.number).catch(() => []) : [];
    const declaredPaths = [...new Set([...(input.lease.declaredPaths ?? []), ...inDiff])];
    await this.deps.taskService
      .open({
        bot: input.builder.name,
        repo: input.repo.name,
        kind: 'patch',
        subjectType: 'pr',
        subjectRef: `${input.repo.name}#${input.pr.number}`,
        skill: 'implement',
        branch: input.pr.head.ref,
        // The round is answering a review, so it gets the reviews and the
        // issue the change is still accountable to.
        issueNumber: input.issueNumber,
        checkoutExistingBranch: true,
        round: input.round,
        leaseId: input.lease.id,
        declaredPaths,
        // Only this review starts a patch round: one the builder cannot
        // do yet is recorded, for the recovery to run once it can.
        whenBlocked: 'record',
      })
      .catch((error) => console.warn(`[bridge] patch round not started: ${error.message}`));
  }

  /**
   * A person moved a card back: from the console, with the reason they gave,
   * or on GitHub by its label, which the webhook or the reconciler found
   * (`moved`). A person may move a card anywhere; what this does is make the
   * rest agree — the move recorded and said on the issue, work of a later
   * stage still running stopped, build's lease and pull request let go of
   * when the card left build, a pull request taken out of the merge line and
   * its patch round opened when the card left review for build
   * (`backFromReview`), and the stage it is in now started.
   */
  async fromPerson(input: {
    repoName: string;
    issueNumber: number;
    to: StageKey;
    actor: string;
    reason: string;
    /** Set when the label already moved on GitHub, from this stage. */
    moved?: { from: StageKey } | null;
  }): Promise<SendBackResult> {
    const repo = await repos.getRepoByName(input.repoName);
    if (!repo) return refuse(`${input.repoName} is not a repository OpenADLC works in`);
    const ref = `${repo.name}#${input.issueNumber}`;
    const issue = await issues.getIssue(repo.id, input.issueNumber);
    const from = input.moved?.from ?? issue?.stage ?? null;
    if (!issue || !from) return refuse(`${ref} is not on the board`);
    const reason = input.reason.trim().slice(0, 4000);

    // The comment and its marker name the person; the move keeps who it was.
    const commentUrl = await this.deps.automation
      .comment(repo.fullName, input.issueNumber, recordComment({ from, to: input.to, by: publicNameOf(input.actor), round: 0, reason, staffed: true, person: true }))
      .catch(() => null);

    if (input.moved) {
      // GitHub's label moved already: the board follows it, and the move is kept.
      await issues.setIssueStage(repo.id, input.issueNumber, input.to);
      await stageMoves
        .record({ repoId: repo.id, issueNumber: input.issueNumber, prNumber: issue.prNumber, from, to: input.to, kind: 'person', actor: input.actor, reason, commentUrl })
        .catch(() => undefined);
    } else {
      if (from === 'merged' || from === 'done') await this.deps.automation.reopenIssue(repo.fullName, input.issueNumber).catch(() => false);
      const moved = await this.deps.automation.moveStage({
        repoName: repo.name,
        issueNumber: input.issueNumber,
        to: input.to,
        actor: input.actor,
        direction: 'person',
        reason,
        prNumber: issue.prNumber,
        commentUrl,
      });
      if (!moved.moved) return refuse(moved.reason ?? `${ref} could not be moved to ${input.to}`);
    }

    // Work of a stage the card is no longer in is stopped: a build left
    // running would push to a pull request that was just parked.
    const subjects = [ref, ...(issue.prNumber ? [`${repo.name}#${issue.prNumber}`] : [])];
    const later = (await tasks.listTasksOnSubjects(subjects).catch(() => [])).filter(
      (task) =>
        ['queued', 'running', 'paused'].includes(task.state) &&
        STAGE_KEYS.indexOf(stageOfTask(task.kind)) > STAGE_KEYS.indexOf(input.to) &&
        task.kind !== 'review',
    );
    for (const task of later) {
      await this.deps.stopTask?.(task.id, input.actor, `${ref} was moved back to ${input.to}`).catch((error: unknown) =>
        console.warn(`[bridge] ${ref}: ${task.kind} ${task.id} was not stopped: ${error instanceof Error ? error.message : error}`),
      );
    }

    await this.letGoOfBuild({ repo, issueNumber: input.issueNumber, prNumber: issue.prNumber, from, to: input.to, why: `moved back to ${input.to} by ${input.actor}` });
    if (input.to === 'build' && from === 'review' && issue.prNumber) {
      await this.backFromReview({ repo, issueNumber: input.issueNumber, prNumber: issue.prNumber });
    }

    const staffed = repo.stageModes[input.to] !== 'untouched';
    if (!staffed) await this.toPerson({ repo, issueNumber: input.issueNumber, from, to: input.to, by: input.actor, reason });
    else if (input.to === 'intake' || input.to === 'spec') {
      await this.deps.stages?.staff({ repoName: repo.name, issueNumber: input.issueNumber, stage: input.to }).catch(() => false);
    } else if (input.to === 'build') {
      this.deps.dispatchRuns?.soon(`${ref} moved back to build`);
    }

    await audit({
      actor: input.actor,
      action: 'stage.moved_back',
      target: ref,
      payload: { from, to: input.to, reason, onGitHub: Boolean(input.moved), stopped: later.map((task) => task.id), comment: commentUrl },
    }).catch(() => undefined);
    return { sent: true, from, to: input.to, staffed, round: 0, commentUrl };
  }
}

/** The issue a task's work is about: its subject, or for a pull request's task the issue the pull request is for. */
async function issueOf(task: { kind: TaskKind; subjectRef: string; branch?: string | null }, repoName: string): Promise<number | null> {
  const [name, number] = task.subjectRef.split('#');
  const subject = Number(number ?? '');
  if (name !== repoName || !Number.isInteger(subject) || subject <= 0) return null;
  if (task.kind === 'spec' || task.kind === 'implement') return subject;
  const fromBranch = issueNumberFromBranch(task.branch ?? '');
  if (fromBranch) return fromBranch;
  const issue = (await issues.listIssues(repoName).catch(() => [])).find((one) => one.prNumber === subject);
  return issue?.number ?? null;
}

/**
 * The issues in Merged whose pull request merged as the commit `short`
 * begins, as the deploy pipeline recorded it when it dispatched the testing
 * deploy (`deployRuns`).
 */
async function mergedAt(repo: { id: string; name: string }, short: string): Promise<number[]> {
  if (!/^[0-9a-f]{7,40}$/i.test(short)) return [];
  const merged = (await issues.listIssues(repo.name).catch(() => [])).filter((issue) => issue.stage === 'merged' && issue.prNumber !== null);
  if (merged.length === 0) return [];
  const runs = await deployRuns.forPullRequests(repo.id, merged.map((issue) => issue.prNumber as number)).catch(() => []);
  const pulls = new Set(runs.filter((run) => run.sha.toLowerCase().startsWith(short.toLowerCase())).map((run) => run.prNumber));
  return merged.filter((issue) => pulls.has(issue.prNumber)).map((issue) => issue.number);
}

/**
 * What the bridge says on the issue. The marker records the move for whoever
 * reads the issue's history; the bridge never acts on one it finds in a
 * comment. The reason is the sender's words, quoted, and the receiving stage
 * reads it from `sent-back.md`.
 */
export function recordComment(input: {
  from: StageKey;
  to: StageKey;
  by: string;
  round: number;
  reason: string;
  staffed: boolean;
  pr?: number;
  person?: boolean;
}): string {
  const how = input.person ? `Moved back to ${title(input.to)}` : `Sent back to ${title(input.to)}`;
  const round = input.round > 0 ? (input.from === 'review' ? ` (review round ${input.round})` : ` (send-back ${input.round} from ${title(input.from)})`) : '';
  const where = input.pr ? ` from #${input.pr}` : '';
  return [
    `**${how}**${where} by ${input.by}${round}.`,
    '',
    // The sender's words, a person's among them: a marker in them is written
    // as text. The bridge's own `send_back` marker below is left as it is.
    input.reason ? quoted(inertMarkup(input.reason)) : '_No reason was given._',
    ...(input.staffed ? [] : ['', `Nobody staffs ${title(input.to)} in this repository, so a person takes it from here.`]),
    renderMarker({ event: 'send_back', from: input.from, to: input.to, by: input.by, round: input.round, ...(input.person ? { person: true } : {}) }),
  ].join('\n');
}
