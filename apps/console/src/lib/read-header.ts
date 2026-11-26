import { api, waitingCount, type AttentionItem, type CostsView, type CrewMember } from './api';
import { headerData, type HeaderData } from './header';
import { colorMapOf, type RepoColorMap } from './repo-colors';

/**
 * Reads what the header needs, for a page that has not already read it.
 *
 * Every part is optional to the page: a bridge that cannot answer one of these
 * reads still gets a header, with that part left out, rather than a page that
 * fails because of its own header.
 */
export async function readHeader(known: {
  repos?: readonly string[];
  /** Each repository's colour by its name, read with the repositories. */
  colors?: RepoColorMap;
  crew?: readonly CrewMember[];
  costs?: Pick<CostsView, 'budget'> | null;
  attention?: readonly AttentionItem[] | null;
} = {}): Promise<HeaderData> {
  const [listed, crew, costs, attention, handsOff] = await Promise.all([
    known.repos ? null : api.repos().then((body) => body.repos).catch(() => []),
    known.crew ?? api.crew().then((body) => body.bots).catch(() => [] as CrewMember[]),
    known.costs !== undefined ? known.costs : api.costs().catch(() => null),
    known.attention !== undefined ? known.attention : api.attention().then((body) => body.items).catch(() => null),
    // The hands-off badge's windows (#383); a failed read leaves the badge
    // out. Called inside the chain, so a client without the read is a failed
    // read too, not a header that throws.
    Promise.resolve()
      .then(() => api.handsOff())
      .catch(() => null),
  ]);

  return headerData({
    repos: known.repos ?? (listed ?? []).map((repo) => repo.name),
    repoColors: known.colors ?? colorMapOf(listed ?? []),
    crew,
    budget: costs?.budget ?? null,
    // What waits on the person; a notice that something was fixed does not.
    needsYou: attention ? waitingCount(attention) : null,
    attention,
    handsOff,
  });
}
