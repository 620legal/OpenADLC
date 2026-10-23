import { audit, deployRuns, issues, leases, repos } from '@openadlc/db';
import { hasIgnoreLabel, shipsByRelease, type DeliveryRules } from '@openadlc/shared';
import type { EffectiveDelivery } from './delivery-rules.js';
import { sayOnCard, type MoveToDone } from './deploy-pipeline.js';
import type { AwaitingDeploy } from './scheduler.js';

/**
 * A repository that ships by release (`testing.on: release`): a merged card
 * waits in Ship until a published release contains its merge, and then goes
 * to Done saying which release.
 *
 * 620legal/OpenADLC ships as a release (`v*` tags, release.yml), and an
 * install takes a change only from one. It has no testing environment, so
 * its deploy-testing skipped every merge, and since #97 and #119 each card
 * went to Done at the next deploy sweep, "merging shipped it", while no
 * install had the change.
 *
 * A merge dispatches no testing deploy and lets its lease go, as a merge that
 * deploys nothing does (`merged`). A release is heard two ways: its `release`
 * delivery (`onPublished`), and the deploy sweep (`sweep`), which lists the
 * repository's releases published since the oldest merge in Ship, so a missed
 * delivery, or an app not subscribed to Release events, still moves the
 * cards. Only a release that is published, and neither a draft nor a
 * prerelease (`shipsWith`), ships anything, and only what its tag's commit
 * contains: GitHub's comparison of the merge with the tag says `ahead` or
 * `identical` when the merge is an ancestor of it. Each pair is asked once
 * per pass.
 */

type Repo = { id: string; name: string; fullName: string; defaultBranch: string };

/** A release, as GitHub lists it or its `release` delivery has it. */
export interface Release {
  tag: string;
  name?: string | null;
  draft: boolean;
  prerelease: boolean;
  /** When it was published; null for a draft. */
  publishedAt: string | null;
  /** When it was made, which GitHub orders its list by. */
  createdAt?: string | null;
  url?: string | null;
}

/** A release as GitHub's REST API writes it. */
export interface GitHubRelease {
  tag_name?: string | null;
  name?: string | null;
  draft?: boolean | null;
  prerelease?: boolean | null;
  published_at?: string | null;
  created_at?: string | null;
  html_url?: string | null;
}

export function releaseOf(raw: GitHubRelease): Release {
  return {
    tag: raw.tag_name ?? '',
    name: raw.name ?? null,
    draft: Boolean(raw.draft),
    prerelease: Boolean(raw.prerelease),
    publishedAt: raw.published_at ?? null,
    createdAt: raw.created_at ?? null,
    url: raw.html_url ?? null,
  };
}

/** Whether a release ships what it contains: published, with a tag, and neither a draft nor a prerelease. */
export function shipsWith(release: Release): boolean {
  return Boolean(release.tag) && !release.draft && !release.prerelease && release.publishedAt !== null && !Number.isNaN(Date.parse(release.publishedAt));
}

/** What asking GitHub about releases takes: the app's client, else the automation account's. */
export interface ReleaseClient {
  request<T>(method: string, path: string): Promise<T>;
}

export interface ReleaseShippingDeps {
  delivery: { get(repo: Repo): Promise<EffectiveDelivery> };
  /** The OpenADLC app's client for a repository, else the automation account's, else null. */
  client: (repoFullName: string) => Promise<ReleaseClient | null>;
  /** Moves a card, as `Automation.moveStage`. */
  moveStage: MoveToDone;
  now?: () => number;
}

/** The most releases GitHub lists on one page. */
const RELEASES_PAGE = 100;

/** How many pages of releases one pass reads at most: a repository with more since its oldest merge in Ship is read no further. */
export const MAX_RELEASE_PAGES = 5;

/** Allowance for GitHub's clock against the database's, when a merge's time is compared with a release's. */
const CLOCK_SLACK_MS = 5 * 60_000;

/** A merge whose cards wait in Ship, as the release that contains it is looked for. */
interface Merge {
  prNumber: number;
  sha: string;
  /** When it was made, in milliseconds: no release published before it contains it. */
  at: number;
  /** Its cards still in Ship. */
  issueNumbers: number[];
}

/** Whether a tag contains a commit, by pair, for one pass: each is asked of GitHub once. */
type Asked = Map<string, boolean>;

/**
 * The cards in Ship whose merge a release contains, moved to Done, each with
 * "released in <tag>": on its stage move, in its timeline, and in the audit
 * log (`deploy.shipped_by_release`), and when it shipped (`shippedAt`) is the
 * release's publish time. The ones it moved, and what it said.
 */
export async function shipByRelease(input: {
  moveStage: MoveToDone;
  repo: { id: string; name: string };
  prNumber: number;
  sha: string;
  issueNumbers: readonly number[];
  release: Release;
}): Promise<{ moved: number[]; lines: string[] }> {
  const { repo, prNumber, release } = input;
  const moved: number[] = [];
  const lines: string[] = [];
  const short = input.sha.slice(0, 7);
  const publishedAt = release.publishedAt ?? new Date().toISOString();
  for (const issueNumber of input.issueNumbers) {
    const ref = `${repo.name}#${issueNumber}`;
    try {
      const result = await input.moveStage({ repoName: repo.name, issueNumber, to: 'done', actor: 'bridge', reason: `released in ${release.tag}`, prNumber });
      if (!result.moved) {
        lines.push(`${ref}: not moved to Done (${result.reason ?? 'the move was refused'})`);
        continue;
      }
    } catch (error) {
      lines.push(`${ref}: not moved to Done (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`);
      continue;
    }
    moved.push(issueNumber);
    // When it shipped is when the release was, not when this found it.
    await (async () => issues.setShippedAt(repo.id, issueNumber, new Date(publishedAt)))().catch(() => undefined);
    await audit({
      actor: 'bridge',
      action: 'deploy.shipped_by_release',
      target: ref,
      payload: { prNumber, sha: input.sha, release: release.tag, publishedAt, url: release.url ?? null },
    }).catch(() => undefined);
    const said = await sayOnCard(
      [ref, `${repo.name}#${prNumber}`],
      `Moved to Done: released in ${release.tag}. The release, published ${publishedAt}, contains its merge (${short}).`,
      { stage: 'done', prNumber, sha: input.sha, release: release.tag, ...(release.url ? { url: release.url } : {}) },
    );
    lines.push(`${ref} moved to Done: released in ${release.tag}, which contains its merge (${short})${said ? '' : '; no thread on it to say so in'}`);
  }
  return { moved, lines };
}

export class ReleaseShipping {
  constructor(private readonly deps: ReleaseShippingDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private leaseListener: ((why: string) => unknown) | null = null;

  /** Told, with why, when a merge's lease was let go here: what that frees is taken up as for any merge that ships (`DeployPipeline.onLeaseReleased`). */
  onLeaseReleased(listener: (why: string) => unknown): void {
    this.leaseListener = listener;
  }

  /**
   * A pull request merged into a repository that ships by release: nothing
   * is dispatched. The merge is recorded, which is what the release is
   * compared with, and its lease let go as a merge that deploys nothing
   * lets its go: nothing reaches an environment to verify it on, and the
   * next change on its files would wait for good. Its card is told it waits
   * for the next release.
   */
  async merged(repo: Repo, prNumber: number, sha: string, at: Date = new Date(this.now())): Promise<string> {
    await deployRuns.ensure(repo.id, sha, prNumber, at);
    const why = `merged, and ${repo.name} ships by release: nothing deploys it to verify`;
    const released = await (async () => leases.releaseForPullRequest(repo.id, prNumber, why))().catch(() => null);
    await (async () => this.leaseListener?.(`${repo.name}#${prNumber}: ${why}`))().catch(() => undefined);
    const board = await (async () => issues.listIssues(repo.name))().catch(() => []);
    const cards = board.filter((issue) => issue.prNumber === prNumber && issue.stage === 'merged').map((issue) => `${repo.name}#${issue.number}`);
    await sayOnCard(
      [...cards, `${repo.name}#${prNumber}`],
      `Merged. ${repo.name} ships by release, so no testing deploy follows: this stays in Ship until a published release contains its merge (${sha.slice(0, 7)}), then goes to Done.`,
      { stage: 'merged', prNumber, sha },
    );
    const lease = released ? `; released the lease on #${released.issueNumber}` : '';
    return `${repo.name}#${prNumber}: merged; ${repo.name} ships by release, so no testing deploy was dispatched, and its card waits in Ship for the next release${lease}`;
  }

  /**
   * A `release` delivery: published, and not a draft or a prerelease. The
   * cards in Ship whose merge its tag contains go to Done, all of them at
   * once; a merge made after it was published is not asked about. A release
   * that came with no delivery is the deploy sweep's (`sweep`).
   */
  async onPublished(repo: Repo, release: Release): Promise<string[]> {
    const ref = `${repo.name} ${release.tag || 'a release with no tag'}`;
    if (!shipsWith(release)) {
      const what = release.draft ? 'a draft' : release.prerelease ? 'a prerelease' : 'not published';
      return [`${ref}: ${what}, which ships nothing; no card was moved`];
    }
    const rules = await this.rulesOf(repo);
    if (typeof rules === 'string') return [`${ref}: ${rules}; the deploy sweep looks again`];
    if (!shipsByRelease(rules)) return [`${ref}: ${repo.name} does not ship by release; no card was moved`];
    const client = await this.deps.client(repo.fullName).catch(() => null);
    if (!client) return [`${ref}: neither the app nor the automation account can ask what it contains; the deploy sweep looks again`];
    const board = await (async () => issues.listIssues(repo.name))().catch(() => null);
    if (!board) return [`${ref}: the board could not be read; the deploy sweep looks again`];
    const inShip = board.filter((issue) => issue.stage === 'merged' && issue.prNumber !== null && !hasIgnoreLabel(issue.labels));
    if (inShip.length === 0) return [`${ref}: no card is in Ship`];
    const lines: string[] = [];
    const merges = await this.mergesOf(repo, inShip, client, lines);
    const published = Date.parse(release.publishedAt as string);
    const asked: Asked = new Map();
    const later: number[] = [];
    for (const merge of merges) {
      if (merge.at > published + CLOCK_SLACK_MS) {
        later.push(merge.prNumber);
        continue;
      }
      lines.push(...(await this.shipIfIn(repo, client, release, merge, asked)).lines);
    }
    if (later.length > 0) lines.push(`${ref}: ${later.map((number) => `${repo.name}#${number}`).join(', ')} merged after it was published, so it cannot contain them`);
    return lines;
  }

  /**
   * The deploy sweep's look, for the cards in Ship of each repository that
   * ships by release: the releases published since the oldest of their
   * merges, oldest first, and each merge moved with the first that contains
   * it. The rest of `inShip`, in repositories that do not ship by release or
   * whose rules could not be read, is returned for the deploy path, and none
   * of those that do: a testing deploy is never dispatched for them.
   */
  async sweep(inShip: readonly AwaitingDeploy[]): Promise<{ waiting: AwaitingDeploy[]; moved: string[] }> {
    const waiting: AwaitingDeploy[] = [];
    const moved: string[] = [];
    for (const name of new Set(inShip.map((item) => item.repo))) {
      const mine = inShip.filter((item) => item.repo === name);
      const repo = await (async () => repos.getRepoByName(name))().catch(() => null);
      // Rules that could not be read are only a fallback: left on the deploy
      // path, which dispatches nothing on them either.
      const delivery = repo ? await this.deps.delivery.get(repo).catch(() => null) : null;
      if (!repo || !delivery || delivery.readError || !shipsByRelease(delivery.rules)) {
        waiting.push(...mine);
        continue;
      }
      moved.push(
        ...(await this.sweepRepo(repo, mine).catch((error: unknown) => [
          `${name}: whether a release contains its merges in Ship could not be asked: ${error instanceof Error ? error.message : String(error)}`,
        ])),
      );
    }
    return { waiting, moved };
  }

  private async sweepRepo(repo: Repo, cards: readonly AwaitingDeploy[]): Promise<string[]> {
    const lines: string[] = [];
    for (const card of cards) {
      if (card.prNumber) continue;
      lines.push(
        `${repo.name}#${card.number} is merged with no pull request recorded: no release can be matched to its merge; move it to Done by hand once a release has it`,
      );
    }
    const recorded = cards.filter((card) => card.prNumber);
    if (recorded.length === 0) return lines;
    const client = await this.deps.client(repo.fullName).catch(() => null);
    if (!client) {
      lines.push(`${repo.name}: its cards wait in Ship; neither the app nor the automation account can list ${repo.fullName}’s releases`);
      return lines;
    }
    const merges = await this.mergesOf(
      repo,
      recorded.map((card) => ({ number: card.number, prNumber: card.prNumber })),
      client,
      lines,
    );
    if (merges.length === 0) return lines;
    let releases: Release[];
    try {
      releases = await this.releasesSince(repo, client, Math.min(...merges.map((merge) => merge.at)) - CLOCK_SLACK_MS);
    } catch (error) {
      lines.push(`${repo.name}: its releases could not be listed (${error instanceof Error ? error.message.slice(0, 160) : String(error)}); its cards wait in Ship`);
      return lines;
    }
    const asked: Asked = new Map();
    const waiting: Merge[] = [];
    for (const merge of merges) {
      let shipped = false;
      for (const release of releases) {
        if (Date.parse(release.publishedAt as string) < merge.at - CLOCK_SLACK_MS) continue;
        const outcome = await this.shipIfIn(repo, client, release, merge, asked);
        lines.push(...outcome.lines);
        // Not known: the next sweep asks again, from the same release.
        if (outcome.contained === null) break;
        if (outcome.contained) {
          shipped = true;
          break;
        }
      }
      if (!shipped) waiting.push(merge);
    }
    if (waiting.length > 0) {
      const refs = waiting.flatMap((merge) => merge.issueNumbers.map((number) => `${repo.name}#${number}`)).join(', ');
      lines.push(`${refs}: in Ship until a published release contains ${waiting.length === 1 ? 'its merge' : 'their merges'}; ${repo.name} ships by release`);
    }
    return lines;
  }

  /**
   * Each pull request's merge, from what was recorded when it merged, or,
   * for one whose delivery was missed, from GitHub, recorded then and settled
   * as its delivery would have (`merged`). What could not be found is said
   * in `lines`.
   */
  private async mergesOf(
    repo: Repo,
    cards: readonly { number: number; prNumber: number | null }[],
    client: ReleaseClient,
    lines: string[],
  ): Promise<Merge[]> {
    const numbers = [...new Set(cards.flatMap((card) => (card.prNumber ? [card.prNumber] : [])))];
    const records = await (async () => deployRuns.forPullRequests(repo.id, numbers))().catch(() => null);
    if (!records) {
      lines.push(`${repo.name}: what was recorded of its merges could not be read; its cards wait in Ship`);
      return [];
    }
    const merges: Merge[] = [];
    for (const prNumber of numbers) {
      const issueNumbers = cards.filter((card) => card.prNumber === prNumber).map((card) => card.number);
      // Newest first: a pull request's rows all name its merge commit.
      const record = records.find((run) => run.prNumber === prNumber);
      if (record) {
        merges.push({ prNumber, sha: record.sha, at: Date.parse(record.mergedAt ?? record.createdAt), issueNumbers });
        continue;
      }
      const pull = await client
        .request<{ merged?: boolean; merge_commit_sha?: string | null; merged_at?: string | null }>('GET', `/repos/${repo.fullName}/pulls/${prNumber}`)
        .catch((error: unknown) => error as Error);
      if (pull instanceof Error) {
        lines.push(`${repo.name}#${prNumber}: its merge could not be read (${pull.message.slice(0, 120)}); its cards wait in Ship`);
        continue;
      }
      if (!pull.merged || !pull.merge_commit_sha) {
        lines.push(`${repo.name}#${prNumber}: GitHub names no merge commit for it, so no release can be matched to it; move its cards to Done by hand once a release has it`);
        continue;
      }
      const at = pull.merged_at && !Number.isNaN(Date.parse(pull.merged_at)) ? new Date(pull.merged_at) : new Date(this.now());
      lines.push(await this.merged(repo, prNumber, pull.merge_commit_sha, at));
      merges.push({ prNumber, sha: pull.merge_commit_sha, at: at.getTime(), issueNumbers });
    }
    return merges;
  }

  /**
   * The repository's releases that ship, published since `since`, oldest
   * first. GitHub lists the newest first, so a page ending before `since`,
   * or not full, is the last one read, and no more than `MAX_RELEASE_PAGES`.
   */
  private async releasesSince(repo: Repo, client: ReleaseClient, since: number): Promise<Release[]> {
    const found: Release[] = [];
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const listed = await client.request<GitHubRelease[]>('GET', `/repos/${repo.fullName}/releases?per_page=${RELEASES_PAGE}&page=${page}`);
      const list = Array.isArray(listed) ? listed.map(releaseOf) : [];
      for (const release of list) {
        if (shipsWith(release) && Date.parse(release.publishedAt as string) >= since) found.push(release);
      }
      const last = list.at(-1);
      const lastAt = last ? Date.parse(last.createdAt ?? last.publishedAt ?? '') : Number.NaN;
      if (list.length < RELEASES_PAGE || Number.isNaN(lastAt) || lastAt < since) break;
    }
    return found.sort((a, b) => Date.parse(a.publishedAt as string) - Date.parse(b.publishedAt as string));
  }

  /**
   * A merge's cards moved to Done when the release contains it. `contained`
   * is null when GitHub could not say, which moves nothing and is said.
   */
  private async shipIfIn(
    repo: Repo,
    client: ReleaseClient,
    release: Release,
    merge: Merge,
    asked: Asked,
  ): Promise<{ contained: boolean | null; lines: string[] }> {
    const key = `${release.tag}\u0000${merge.sha}`;
    let contained = asked.get(key);
    if (contained === undefined) {
      try {
        contained = await this.contains(repo, client, release.tag, merge.sha);
      } catch (error) {
        return {
          contained: null,
          lines: [
            `${repo.name}#${merge.prNumber}: whether ${release.tag} contains its merge (${merge.sha.slice(0, 7)}) could not be asked ` +
              `(${error instanceof Error ? error.message.slice(0, 120) : String(error)}); the deploy sweep asks again`,
          ],
        };
      }
      asked.set(key, contained);
    }
    if (!contained) return { contained: false, lines: [] };
    const shipped = await shipByRelease({ moveStage: this.deps.moveStage, repo, prNumber: merge.prNumber, sha: merge.sha, issueNumbers: merge.issueNumbers, release });
    return { contained: true, lines: shipped.lines };
  }

  /**
   * Whether a tag's commit contains a merge: GitHub compares the merge with
   * the tag, `ahead` when the merge is an ancestor of it and `identical`
   * when it is the tagged commit. `behind` and `diverged` are a merge the tag
   * does not have. One commit is asked for, not the 250 GitHub would list.
   */
  private async contains(repo: Repo, client: ReleaseClient, tag: string, sha: string): Promise<boolean> {
    const comparison = await client.request<{ status?: string }>(
      'GET',
      `/repos/${repo.fullName}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(tag)}?per_page=1`,
    );
    if (!comparison.status) throw new Error(`GitHub compared ${sha.slice(0, 7)} with ${tag} and gave no status`);
    return comparison.status === 'ahead' || comparison.status === 'identical';
  }

  /** The repository's rules, or why they could not be read. */
  private async rulesOf(repo: Repo): Promise<DeliveryRules | string> {
    const delivery = await this.deps.delivery.get(repo).catch((error: unknown) => error as Error);
    if (delivery instanceof Error) return `its delivery rules could not be read (${delivery.message})`;
    return delivery.readError ? `its delivery rules could not be read (${delivery.readError})` : delivery.rules;
  }
}
