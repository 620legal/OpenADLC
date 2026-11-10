import { leases } from '@openadlc/db';
import type { Automation } from './automation.js';
import { stackBrief } from './stacking.js';
import type { TaskService } from './task-service.js';

export type Started = Awaited<ReturnType<TaskService['open']>>;

export interface BuildStartDeps {
  taskService: Pick<TaskService, 'open'>;
  automation: Pick<Automation, 'assignIssue' | 'comment'>;
  /** The clock the lease comment's "today" is read by. */
  now?: () => Date;
}

/**
 * Starts a builder on an issue it holds the lease for, the one way it is
 * done: a task on the bot's branch for the issue, the issue assigned to it,
 * a comment saying until when it holds it, and the lease marked as in a task.
 *
 * The dispatcher's lease comes here, and so does "Try again" on a build that
 * failed — so a build run again leaves the same trail as the first.
 *
 * `continueBranch` is a build that ended without opening its pull request,
 * continued on the branch it pushed (`build-left.ts`) rather than started
 * from the base again: started that way, it would redo the pushed work, and
 * could not push over it without forcing.
 */
export async function startBuild(
  deps: BuildStartDeps,
  input: {
    leaseId: string;
    repo: { name: string; fullName: string };
    issue: number;
    bot: { id: string; name: string };
    declaredPaths: string[];
    expiresAt: string | null;
    /** The branch an earlier build of the issue pushed, to go on from. */
    continueBranch?: string | null;
    /** The pull request still open from that branch, when that is why it is gone on from. */
    continuePull?: number | null;
    /** The issue in review this one depends on, whose branch it starts from (`stacking.ts`). */
    stackOn?: { issue: number; pr: number; branch: string };
  },
): Promise<Started> {
  const branch = input.continueBranch || `agent/${input.bot.name}/${input.issue}-issue-${input.issue}`;
  const stacked = input.continueBranch ? undefined : input.stackOn;
  const started = await deps.taskService.open({
    bot: input.bot.name,
    botId: input.bot.id,
    repo: input.repo.name,
    kind: 'implement',
    subjectType: 'issue',
    subjectRef: `${input.repo.name}#${input.issue}`,
    skill: 'implement',
    branch,
    leaseId: input.leaseId,
    declaredPaths: input.declaredPaths,
    ...(input.continueBranch ? { checkoutExistingBranch: true, startFromBaseIfMissing: true } : {}),
    ...(stacked ? { baseRef: `refs/heads/${stacked.branch}`, extraContext: [stackBrief(stacked)] } : {}),
  });
  if (started.error) return started;

  await deps.automation.assignIssue(input.repo.fullName, input.issue, input.bot.name).catch(() => undefined);
  await deps.automation.comment(input.repo.fullName, input.issue, leaseComment({ ...input, branch, stacked }, deps.now?.() ?? new Date())).catch(() => undefined);

  await leases.setLeaseState(input.leaseId, 'in_task');
  return started;
}

/**
 * What the lease comment says of how long the lease holds. It said "until
 * 2026-11-09T08:49:00.000Z", and once the pull request opened the lease held
 * on past that, as it should (`expireStaleLeases` lets go only of one with no
 * pull request): a card held for 21 hours read as a lease long expired (ADR
 * 0046). The time is now the deadline for a pull request to open, and a
 * lease going on from an open one gives none.
 */
function leaseComment(
  input: {
    bot: { name: string };
    expiresAt: string | null;
    continueBranch?: string | null;
    continuePull?: number | null;
    branch: string;
    stacked: { issue: number; pr: number; branch: string } | undefined;
  },
  now: Date,
): string {
  const leased = `Leased to \`${input.bot.name}\`.`;
  if (input.continuePull) {
    return `${leased} Going on from branch \`${input.branch}\`, whose pull request #${input.continuePull} is still open; the lease holds until that pull request merges or closes.`;
  }
  const what = input.continueBranch
    ? `Going on from branch \`${input.branch}\`, where the last build stopped before opening its pull request.`
    : input.stacked
      ? `Working on branch \`${input.branch}\`, started from #${input.stacked.issue}'s branch \`${input.stacked.branch}\` while #${input.stacked.pr} is in review; it merges after #${input.stacked.pr}.`
      : `Working on branch \`${input.branch}\`.`;
  const by = input.expiresAt ? utcTime(input.expiresAt, now) : null;
  const holds = by
    ? ` If no pull request opens by ${by}, the lease lets go; once one opens, it holds until the pull request merges or closes.`
    : ' Once its pull request opens, the lease holds until that pull request merges or closes.';
  return `${leased} ${what}${holds}`;
}

/** `08:49 UTC`, with the date before it when that is not today's: never the raw ISO string. */
export function utcTime(iso: string, now: Date): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const time = `${at.toISOString().slice(11, 16)} UTC`;
  return at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10) ? time : `${at.toISOString().slice(0, 10)} ${time}`;
}
