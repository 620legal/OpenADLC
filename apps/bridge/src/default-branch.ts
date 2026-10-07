import type { GitHubClient } from '@fleetadlc/github';

/**
 * A repository's default branch, as GitHub says it is.
 *
 * Adding a repository from the console stored `main` without asking. Every
 * task's worktree starts from the stored branch, and the merge line, the merge
 * rule, the human-review rules and deploys compare against it, so in a
 * repository whose default is `master` every task failed at its first step,
 * and one that also had an old `main` was built from the wrong base and then
 * refused at the merge.
 */

/** Something that can ask GitHub: a client as the app, or as the automation account. */
type Asker = () => Promise<Pick<GitHubClient, 'request'> | null>;

/**
 * GitHub's `default_branch` for `fullName`, asked of each client in turn, or
 * null when none of them answers. Never throws: a repository is added, and
 * reconciled, whether GitHub answers or not.
 */
export async function readDefaultBranch(fullName: string, askers: readonly Asker[]): Promise<string | null> {
  for (const ask of askers) {
    const client = await ask().catch(() => null);
    if (!client) continue;
    const branch = await client
      .request<{ default_branch?: unknown }>('GET', `/repos/${fullName}`)
      .then((repository) => (typeof repository?.default_branch === 'string' && repository.default_branch.trim() ? repository.default_branch : null))
      .catch(() => null);
    if (branch) return branch;
  }
  return null;
}

/**
 * Brings each repository's stored default branch in step with GitHub's: one
 * added with a guess, one `config/repos.yaml` names wrongly, and one whose
 * branch was renamed on GitHub since. Says only what it changed; a repository
 * GitHub does not answer for is left as it is.
 */
export async function syncDefaultBranches(deps: {
  repositories: () => Promise<readonly { fullName: string; defaultBranch: string }[]>;
  read: (fullName: string) => Promise<string | null>;
  store: (fullName: string, branch: string) => Promise<unknown>;
}): Promise<string[]> {
  const actions: string[] = [];
  for (const repo of await deps.repositories()) {
    const github = await deps.read(repo.fullName).catch(() => null);
    if (!github || github === repo.defaultBranch) continue;
    try {
      await deps.store(repo.fullName, github);
      actions.push(`${repo.fullName}: its default branch is ${github} on GitHub, not ${repo.defaultBranch}; corrected`);
    } catch (error) {
      actions.push(`${repo.fullName}: its default branch is ${github} on GitHub, not ${repo.defaultBranch}, and could not be corrected: ${error instanceof Error ? error.message : error}`);
    }
  }
  return actions;
}
