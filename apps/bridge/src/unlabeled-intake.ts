import type { GitHubClient } from '@fleetadlc/github';
import { hasIgnoreLabel, stageFromLabels } from '@fleetadlc/shared';
import { everyIssue } from './reconciler.js';

/**
 * Issues a person filed that OpenADLC never looked at, sent to intake.
 *
 * A new issue goes to intake when it is opened (`Webhooks.learnIssue`), but one
 * filed before the repository was added, or while no delivery arrived, carried
 * no stage label and nothing ever picked it up: nothing built it, and intake
 * still had to work around its files — `testbed`'s #3 and #7 were asked
 * about on every new request that touched the Makefile.
 *
 * So the reconcile sweep sends the oldest such issue in each repository to
 * intake, the same way an opened one goes: one at a time per repository, and
 * only while no intake is running on an issue there, so a backlog is worked
 * through rather than triaged all at once. Intake shapes it as it does any
 * issue a person filed — their words kept, "Here's what #N will say. OK?",
 * then labels. Only issues whose author OpenADLC acts for; `fleetadlc:ignore`
 * keeps one out. An issue intake cannot shape stops after two tries
 * (`StageHandoff.intakeGaveUp`) and waits in Needs you.
 */
export interface UnlabeledIssue {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  labels: string[];
  pullRequest: boolean;
  author: string | null;
  association: string | null;
}

/**
 * A repository's open issues and pull requests, every page of them.
 *
 * It was one page of a hundred, newest first. The backlog this sweep is for is
 * the oldest end, so in a repository with more than a hundred open, an issue
 * filed before the repository was added was never seen.
 */
export async function openIssuesOn(client: Pick<GitHubClient, 'listIssues'>, repoFullName: string): Promise<UnlabeledIssue[]> {
  return (await everyIssue(client, repoFullName)).map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    htmlUrl: issue.htmlUrl,
    labels: issue.labels,
    pullRequest: issue.pullRequest,
    author: issue.author,
    association: issue.association,
  }));
}

export interface UnlabeledIntakeDeps {
  repos(): Promise<{ id: string; name: string; fullName: string }[]>;
  /** The repository's open issues as GitHub lists them; null when GitHub cannot be asked. */
  openIssues(repoFullName: string): Promise<UnlabeledIssue[] | null>;
  /** Whether OpenADLC acts for this author on this repository (`actsForOn`). */
  actsFor(repoFullName: string, author: { login: string | null; association: string | null }): Promise<boolean>;
  /** Whether an intake task is going on an issue in this repository. */
  intakeGoingIn(repoName: string): Promise<boolean>;
  /** Why nothing new starts in this repository now — the install's or its own pause — or null. */
  paused(repoName: string): string | null;
  /** Why the intake seat takes no new work now, or null. */
  intakePaused(): Promise<string | null>;
  /** Sends an issue to intake, as an opened one goes (`Webhooks.learnIssue`). */
  learn(repo: { id: string; name: string }, issue: UnlabeledIssue): Promise<void>;
  /**
   * The repository's unlabeled issues it will not send on its own, because
   * OpenADLC does not act for their author (`unowned-issues.ts`). True when the
   * list changed. Absent, nothing is recorded.
   */
  recordUnowned?(repoName: string, issues: { number: number; title: string; url: string; author: string | null }[]): Promise<boolean>;
}

export class UnlabeledIntake {
  constructor(private readonly deps: UnlabeledIntakeDeps) {}

  /** One pass: at most one issue per repository sent to intake. Says what it did, for the job's log. */
  async sweepOnce(): Promise<string[]> {
    const said: string[] = [];
    const seat = await this.deps.intakePaused().catch(() => null);
    if (seat) return said;
    for (const repo of await this.deps.repos()) {
      if (this.deps.paused(repo.name)) continue;
      const open = await this.deps.openIssues(repo.fullName).catch(() => null);
      if (!open) continue;
      const waiting = open
        .filter((issue) => !issue.pullRequest && !stageFromLabels(issue.labels) && !hasIgnoreLabel(issue.labels))
        .sort((a, b) => a.number - b.number);

      // Which of them OpenADLC acts for: those go to intake, one a pass; the
      // rest are written down for a person, every pass, intake busy or not —
      // they were skipped without a word.
      const ours: UnlabeledIssue[] = [];
      const theirs: UnlabeledIssue[] = [];
      for (const issue of waiting) {
        const acts = await this.deps.actsFor(repo.fullName, { login: issue.author, association: issue.association }).catch(() => false);
        (acts ? ours : theirs).push(issue);
      }
      if (this.deps.recordUnowned) {
        const changed = await this.deps
          .recordUnowned(
            repo.name,
            theirs.map((issue) => ({ number: issue.number, title: issue.title, url: issue.htmlUrl, author: issue.author })),
          )
          .catch(() => false);
        if (changed && theirs.length > 0) {
          said.push(
            `${repo.name}: ${theirs.map((issue) => `#${issue.number}`).join(', ')} not sent to intake: OpenADLC does not act for ${theirs.length === 1 ? 'its author' : 'their authors'}; Needs you asks what to do`,
          );
        }
      }

      if (await this.deps.intakeGoingIn(repo.name).catch(() => true)) continue;
      const next = ours[0];
      if (!next) continue;
      await this.deps.learn(repo, next);
      said.push(`sent ${repo.name}#${next.number} to intake: it has no stage label, and is the oldest such issue there`);
    }
    return said;
  }
}
