import type { RepoConfig } from '@fleetadlc/shared';

/** The stand-in's full name. The scripted board is written here and nowhere else. */
export const SCRIPTED_REPO_FULL_NAME = 'local/scripted';

/**
 * The repository the integration suite works in when nothing else is configured.
 *
 * `config/repos.yaml` ships empty so a clone is not pointed at somebody else's
 * repository. The suite still needs a row: it leases against whatever
 * `listRepos()` returns, and an empty table is "no repository is configured".
 * A normal install does not call this. The walkthrough asks instead.
 */
export function scriptedRepository(owner: string): RepoConfig {
  return {
    name: 'scripted',
    fullName: SCRIPTED_REPO_FULL_NAME,
    owner,
    concurrency: 1,
    defaultBranch: 'main',
    stageModes: {
      intake: 'autonomous',
      spec: 'conditional',
      build: 'autonomous',
      review: 'autonomous',
      merged: 'autonomous',
      done: 'autonomous',
    },
    specRequiredLabels: ['touches:schema', 'touches:contract', 'touches:migration', 'size:large', 'safety'],
    humanReviewPaths: [],
  };
}

/** The builder owns the work, which is what the pipeline asserts. */
export function standInOwner(bots: { name: string; role: string }[]): string | null {
  return bots.find((bot) => bot.role === 'implement')?.name ?? bots[0]?.name ?? null;
}

/**
 * What to insert, or null when the install already has a repository or has no
 * bot to own one. A configured repository is left alone: the suite should run
 * against the one somebody named, not a second one beside it.
 */
export function scriptedStandIn(
  configuredCount: number,
  bots: { name: string; role: string }[],
): RepoConfig | null {
  if (configuredCount > 0) return null;
  const owner = standInOwner(bots);
  if (!owner) return null;
  return scriptedRepository(owner);
}
