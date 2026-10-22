import { repos, workItems } from '@openadlc/db';
import type { GitHubClient } from '@openadlc/github';
import { keywordCloses, linkListed, planBackfill } from './work-items.js';

/** GitHub's largest page. */
const PAGE = 100;

/** How often the read is looked at again: a repository added, a rate limit lifted. */
export const BACKFILL_EVERY_MS = 15 * 60 * 1000;

/**
 * How far before the last catch-up the next asks from: `since` is GitHub's
 * clock, and one a little behind the bridge's must not lose a change.
 */
const SINCE_SLACK_MS = 10 * 60 * 1000;

/** Where one catch-up read stops: fifty pages, as reconcile reads. */
const MOST_PAGES = 50;

type Reader = Pick<GitHubClient, 'listIssues' | 'listPullRequests' | 'getPullRequest' | 'closingIssueRefs'>;

/**
 * Numbers every issue and pull request a managed repository ever had, and
 * every request, as work items (docs/adr/0009-work-items.md). It only reads
 * GitHub, as the automation account.
 *
 * 1. Read: each repository's issues and pull requests, oldest first, a page
 *    at a time, each page saved with the next page's number, so a restart or
 *    a rate limit picks up where it stopped. Oldest first is what makes that
 *    safe: something opened mid-read lands on the last page and shifts none.
 * 2. Number: once every repository is read, one transaction numbers it all in
 *    opened order, and live numbering begins. A repository added later is
 *    read the same way and numbered on its own, after what is numbered.
 * 3. Catch up, once per start: what changed in a numbered repository while
 *    the bridge was down is linked.
 */
export class WorkItemBackfill {
  private running: Promise<void> | null = null;
  /** The repositories caught up since this bridge started. */
  private readonly caughtUp = new Set<string>();

  constructor(private readonly client: () => Promise<Reader | null>) {}

  /** One pass; a second asked for while one runs joins it. */
  run(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const client = await this.client();
    if (!client) return;
    const managed = await repos.listRepos();
    for (const repo of managed) await workItems.startBackfill(repo.id);

    let states = await workItems.backfillState();
    for (const repo of managed) {
      const state = states.find((one) => one.repoId === repo.id);
      if (!state || state.readAt) continue;
      try {
        await this.read(client, repo, state);
      } catch (error) {
        // A rate limit or anything else: kept for the next run, which
        // resumes at the page saved, and this run ends here.
        const reason = error instanceof Error ? error.message : String(error);
        await workItems.recordBackfillError(repo.id, reason);
        console.warn(`[bridge] work items: reading ${repo.fullName}'s history stopped, and resumes on the next run: ${reason}`);
        return;
      }
    }

    states = await workItems.backfillState();
    const installNumbered = Boolean(states.find((state) => state.repoId === null)?.numberedAt);
    const read = (id: string) => Boolean(states.find((state) => state.repoId === id)?.readAt);
    const waiting = managed.filter((repo) => read(repo.id) && !states.find((state) => state.repoId === repo.id)?.numberedAt);
    // The first numbering waits for every repository, so nothing new takes a
    // low number while older history is still being read.
    if ((!installNumbered && managed.every((repo) => read(repo.id))) || (installNumbered && waiting.length > 0)) {
      const numbered = await workItems.numberPending(planBackfill);
      console.log(`[bridge] work items: numbered ${numbered.links} issues, pull requests and requests as ${numbered.items} new work items`);
      states = await workItems.backfillState();
    }

    for (const repo of managed) {
      const state = states.find((one) => one.repoId === repo.id);
      if (!state?.numberedAt || this.caughtUp.has(repo.id)) continue;
      try {
        await this.catchUp(client, repo, state.caughtUpAt ?? state.numberedAt);
        this.caughtUp.add(repo.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await workItems.recordBackfillError(repo.id, reason);
        console.warn(`[bridge] work items: catching up ${repo.fullName} stopped, and is tried again on the next run: ${reason}`);
      }
    }
  }

  private async read(
    client: Reader,
    repo: { id: string; fullName: string; defaultBranch: string },
    state: workItems.BackfillState,
  ): Promise<void> {
    for (let page = state.issuesPage; ; page += 1) {
      const listed = await client.listIssues(repo.fullName, { state: 'all', sort: 'created', direction: 'asc', perPage: PAGE, page });
      // The issues listing has pull requests too; theirs is the pulls listing, with the branches.
      const rows = listed
        .filter((issue) => !issue.pullRequest)
        .map((issue) => ({ number: issue.number, kind: 'issue' as const, title: issue.title, state: issue.state, url: issue.htmlUrl, openedAt: issue.createdAt }));
      await workItems.saveBackfillPage(repo.id, 'issues', page + 1, rows);
      if (listed.length < PAGE) break;
    }
    for (let page = state.pullsPage; ; page += 1) {
      const listed = await client.listPullRequests(repo.fullName, { state: 'all', sort: 'created', direction: 'asc', perPage: PAGE, page });
      const rows = listed.map((pull) => ({
        number: pull.number,
        kind: 'pull' as const,
        title: pull.title,
        state: pull.merged ? ('merged' as const) : pull.state,
        url: pull.htmlUrl,
        openedAt: pull.createdAt,
        headRef: pull.headRef,
        headRepo: pull.headRepoFullName,
        baseRef: pull.baseRef,
        // History is linked by branch and keywords: GitHub's closing
        // references would cost a query per pull request.
        closes: keywordCloses({ number: pull.number, baseRef: pull.baseRef, defaultBranch: repo.defaultBranch, body: pull.body }),
      }));
      await workItems.saveBackfillPage(repo.id, 'pulls', page + 1, rows);
      if (listed.length < PAGE) break;
    }
    await workItems.markRead(repo.id);
  }

  /** What changed since `since` in a numbered repository, linked: deliveries lost while the bridge was down. */
  private async catchUp(client: Reader, repo: { id: string; fullName: string; defaultBranch: string }, since: string): Promise<void> {
    const started = new Date();
    const from = new Date(Date.parse(since) - SINCE_SLACK_MS).toISOString();
    for (let page = 1; page <= MOST_PAGES; page += 1) {
      const listed = await client.listIssues(repo.fullName, { state: 'all', since: from, sort: 'updated', direction: 'asc', perPage: PAGE, page });
      for (const entry of listed) await linkListed(repo, entry, client);
      if (listed.length < PAGE) break;
    }
    await workItems.markCaughtUp(repo.id, started.toISOString());
  }
}
