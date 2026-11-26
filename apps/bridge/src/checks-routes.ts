import type { GitHubReads } from './ci-failure.js';
import { checksViewOf, ChecksViews, type ChecksRecords, type ChecksRepo } from './checks-view.js';
import { HttpFailure, type Router } from './router.js';

/**
 * A repository's Checks page, as the console reads it (`checks-view.ts`).
 * One GET; nothing here writes, to GitHub or anywhere else.
 */

export interface ChecksRouteDeps {
  /** A repository the install manages, by its name or full name; null for any other. */
  repo(name: string): Promise<ChecksRepo | null>;
  /** GET-only reads of GitHub as the automation account; null when none is connected. */
  reads(): Promise<GitHubReads | null>;
  records: ChecksRecords;
}

export function registerChecksRoutes(router: Router, deps: ChecksRouteDeps): void {
  const views = new ChecksViews(async (repo) => checksViewOf(repo, await deps.reads().catch(() => null), deps.records));
  router.get('/v1/repos/:name/checks', async ({ params }) => {
    const name = params.name ?? '';
    const repo = await deps.repo(name);
    if (!repo) throw new HttpFailure(404, `${name || 'that'} is not a repository this install manages; add it in Settings → Repositories first`);
    return views.of(repo);
  });
}
