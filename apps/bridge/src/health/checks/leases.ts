import type { Lease, TaskState } from '@fleetadlc/shared';
import type { CheckResult, HealthCheck } from '../types.js';

export interface LeaseReader {
  /** Every lease still holding an issue. */
  leases(): Promise<Lease[]>;
  repos(): Promise<{ id: string; name: string }[]>;
  /** The tasks on these subjects, whatever their state. */
  tasksOn(subjectRefs: readonly string[]): Promise<
    { leaseId: string | null; state: TaskState; createdAt: string; endedAt: string | null }[]
  >;
  /** The issue as the board has it: its title, and its pull request once there is one. */
  issue(repoId: string, number: number): Promise<{ title: string; prNumber: number | null } | null>;
  botName(botId: string): Promise<string | null>;
  /**
   * Lets the issue go, and records who let it go and why — only if it is
   * still idle as it is written: false when, since it was read, a task
   * started under it, a question paused it or a pull request linked to it.
   */
  release(lease: Lease, why: string): Promise<boolean>;
}

/** How long a lease may hold an issue with nothing working on it before OpenADLC lets it go. */
export const IDLE_LEASE_MS = 15 * 60 * 1000;

const ACTIVE: readonly TaskState[] = ['queued', 'running', 'paused'];

/**
 * No issue is held by a lease that nothing is working under.
 *
 * A lease is what stops a second builder taking an issue, and it is let go
 * when the pull request lands or is closed — or, with no pull request at all,
 * twelve hours after it was taken. A builder whose task failed before it
 * opened one held its issue for all twelve, with nothing running and nothing
 * on the board saying so.
 *
 * So a lease with no task going, no pull request, and nothing for a quarter of
 * an hour is released here, and the board says so once. OpenADLC can do this for
 * itself; what it cannot fix — a bot that cannot sign its commits — the
 * dispatcher reads from the other checks and does not hand the issue back to.
 */
export function leaseCheck(reader: LeaseReader, idleMs = IDLE_LEASE_MS): HealthCheck {
  return {
    id: 'idle-lease',
    proves: 'No issue is held by a lease that nothing is working under',
    how: 'compares each lease with the tasks on its issue and whether a pull request has been opened for it',
    everyMinutes: 5,
    steps: [],
    async run(now) {
      const [leases, repos] = await Promise.all([reader.leases(), reader.repos()]);
      const results: CheckResult[] = [];
      for (const lease of leases) {
        // Paused is a question to a person, which holds the issue on purpose.
        if (lease.state === 'paused' || lease.prNumber) continue;
        const repo = repos.find((one) => one.id === lease.repoId);
        if (!repo) continue;
        const subject = lease.id;
        const issue = await reader.issue(lease.repoId, lease.issueNumber);
        if (issue?.prNumber) {
          results.push({ subject, ok: true });
          continue;
        }

        const ref = `${repo.name}#${lease.issueNumber}`;
        const tasks = await reader.tasksOn([ref]);
        if (tasks.some((task) => ACTIVE.includes(task.state))) {
          results.push({ subject, ok: true });
          continue;
        }

        const own = tasks
          .filter((task) => task.leaseId === lease.id)
          .sort((a, b) => Date.parse(b.endedAt ?? b.createdAt) - Date.parse(a.endedAt ?? a.createdAt));
        // A build that finished has a pull request on its way, whose link to
        // the issue may not have arrived yet; letting its lease go would hand
        // the same issue out twice. Only work that ended without finishing —
        // or never started — leaves a lease holding nothing.
        const newest = own[0];
        if (newest && newest.state !== 'failed' && newest.state !== 'stopped') {
          results.push({ subject, ok: true });
          continue;
        }
        const since = newest ? Date.parse(newest.endedAt ?? newest.createdAt) : Date.parse(lease.updatedAt ?? '');
        if (!Number.isFinite(since) || now.getTime() - since < idleMs) {
          // Just ended: a retry or the next round may be on its way.
          results.push({ subject, ok: true });
          continue;
        }

        const holder = (await reader.botName(lease.botId)) ?? 'a bot';
        const named = issue?.title ? `#${lease.issueNumber} “${issue.title}”` : `#${lease.issueNumber}`;
        if (!(await reader.release(lease, `nothing was working under it, and it had no pull request`))) {
          results.push({ subject, ok: true });
          continue;
        }
        results.push({
          subject,
          ok: true,
          note: `Released ${named} in ${repo.name}, which ${holder} held with nothing working on it`,
        });
      }
      return results;
    },
  };
}
