import { resolveBotRef, type RepoConfig } from '@fleetadlc/shared';
import * as bots from '../store/bots.js';
import * as repos from '../store/repos.js';

/**
 * Writes the repositories `config/repos.yaml` lists. Returns those whose
 * `owner` names no bot, and those refused because another repository already
 * goes by the name, rather than stopping at the first.
 *
 * An `owner` that names nobody — `buidler` — was stored as no owner without a
 * word, and the dispatcher skips a repository with no owner, so nothing ever
 * built there and nothing said why. It is still written, so the rest of the
 * file's settings land, and the caller says which seat it could not find.
 *
 * A setting the entry leaves out is passed as undefined, and `upsertRepo`
 * keeps the row's value for it.
 */
export async function writeRepos(list: readonly RepoConfig[]): Promise<{
  unknownOwners: { fullName: string; owner: string }[];
  refused: { fullName: string; reason: string }[];
}> {
  const crew = await bots.listBots();
  const unknownOwners: { fullName: string; owner: string }[] = [];
  const refused: { fullName: string; reason: string }[] = [];
  for (const repo of list) {
    const owner = resolveBotRef(crew, repo.owner);
    try {
      await repos.upsertRepo({
        name: repo.name,
        fullName: repo.fullName,
        ownerBotId: owner?.id ?? null,
        concurrency: repo.concurrency,
        stageModes: repo.stageModes,
        specRequiredLabels: repo.specRequiredLabels,
        humanReviewPaths: repo.humanReviewPaths,
        defaultBranch: repo.defaultBranch,
      });
    } catch (error) {
      if (!(error instanceof repos.RepoNameTaken)) throw error;
      refused.push({ fullName: repo.fullName, reason: error.message });
      continue;
    }
    if (!owner) unknownOwners.push({ fullName: repo.fullName, owner: repo.owner });
  }
  return { unknownOwners, refused };
}
