import { leases } from '@fleetadlc/db';
import type { Automation } from './automation.js';
import { stackBrief } from './stacking.js';
import type { TaskService } from './task-service.js';

export type Started = Awaited<ReturnType<TaskService['open']>>;

export interface BuildStartDeps {
  taskService: Pick<TaskService, 'open'>;
  automation: Pick<Automation, 'assignIssue' | 'comment'>;
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
  await deps.automation
    .comment(
      input.repo.fullName,
      input.issue,
      input.continuePull
        ? `Leased to \`${input.bot.name}\`${input.expiresAt ? ` until ${input.expiresAt}` : ''}. Going on from branch \`${branch}\`, whose pull request #${input.continuePull} is still open.`
        : input.continueBranch
        ? `Leased to \`${input.bot.name}\`${input.expiresAt ? ` until ${input.expiresAt}` : ''}. Going on from branch \`${branch}\`, where the last build stopped before opening its pull request.`
        : stacked
        ? `Leased to \`${input.bot.name}\`${input.expiresAt ? ` until ${input.expiresAt}` : ''}. Working on branch \`${branch}\`, started from #${stacked.issue}'s branch \`${stacked.branch}\` while #${stacked.pr} is in review; it merges after #${stacked.pr}.`
        : `Leased to \`${input.bot.name}\`${input.expiresAt ? ` until ${input.expiresAt}` : ''}. Working on branch \`${branch}\`.`,
    )
    .catch(() => undefined);

  await leases.setLeaseState(input.leaseId, 'in_task');
  return started;
}
