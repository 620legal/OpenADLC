import { repos, workItems, type WorkItem } from '@openadlc/db';
import type { GitHubClient } from '@openadlc/github';
import { closingKeywords } from '@openadlc/shared';
import { headInRepository, issueNumberFromBranch } from './work.js';

/**
 * What belongs to which work item (docs/adr/0009-work-items.md): the rules,
 * over rows, and the few calls the webhook, the sweep and the history read
 * share to apply them.
 */

/** A pull request as the rules read it. */
export interface PullFacts {
  number: number;
  repoFullName: string;
  headRef: string;
  headRepoFullName: string | null;
  baseRef: string | null;
  defaultBranch: string;
  body: string | null;
}

/**
 * The issues a pull request closes, as far as can be told without GitHub's
 * closing references: the body's keywords, only into the default branch, as
 * GitHub counts them, and never the pull request itself.
 */
export function keywordCloses(pull: Pick<PullFacts, 'number' | 'baseRef' | 'defaultBranch' | 'body'>): number[] {
  if (!pull.baseRef || pull.baseRef !== pull.defaultBranch) return [];
  return closingKeywords(pull.body ?? '').filter((number) => number !== pull.number);
}

/**
 * Which item a pull request joins, by its id; null for an item of its own.
 *
 * 1. The item of the issue its branch was cut for, from a branch in the
 *    repository itself: a person's `agent/x/12-…` counts, a fork's never does.
 * 2. Else the lowest-numbered item among the issues it closes: GitHub's
 *    closing references (`closing`), another managed repository's included,
 *    or, when they could not be read (null), the body's keywords.
 * 3. Else none.
 *
 * `lookup` answers an issue's item, or null for one with none, or in a
 * repository this install does not manage.
 */
export async function claimForPull(
  pull: PullFacts,
  closing: readonly { repo: string; number: number }[] | null,
  lookup: (repoFullName: string, number: number) => Promise<WorkItem | null>,
): Promise<string | null> {
  const own = headInRepository(pull.headRepoFullName, pull.repoFullName) ? issueNumberFromBranch(pull.headRef) : null;
  if (own !== null) {
    const item = await lookup(pull.repoFullName, own);
    if (item) return item.id;
  }
  const refs = (closing ?? keywordCloses(pull).map((number) => ({ repo: pull.repoFullName, number }))).filter(
    (ref) => !(ref.repo.toLowerCase() === pull.repoFullName.toLowerCase() && ref.number === pull.number),
  );
  let lowest: WorkItem | null = null;
  for (const ref of refs) {
    const item = await lookup(ref.repo, ref.number);
    if (item && (!lowest || item.number < lowest.number)) lowest = item;
  }
  return lowest?.id ?? null;
}

/**
 * What the history numbering puts together, in the order each group was
 * first opened:
 *
 * - a request with the issue it was filed as, so requests filed as one
 *   issue share it;
 * - a pull request with the issue its branch was cut for, else the
 *   earliest-opened issue among those it closes.
 *
 * Each request and pull request joins one issue at most, so no group holds
 * two issues. An issue already linked (a restore's, or an earlier
 * numbering's) is joined by its item: the group's `claim`.
 */
export function planBackfill(pending: workItems.Pending[], linked: workItems.LinkedIssue[]): workItems.PlannedGroup[] {
  const at = (repoId: string, number: number) => `${repoId}#${number}`;
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Shortened as it is walked, so a long run of joins stays cheap.
    for (let step = node; parent.get(step) !== root; ) {
      const next = parent.get(step)!;
      parent.set(step, root);
      step = next;
    }
    return root;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));

  const nodeOf = (index: number) => `p${index}`;
  pending.forEach((_, index) => parent.set(nodeOf(index), nodeOf(index)));
  const issues = new Map<string, { node: string; openedAt: string | null }>();
  pending.forEach((thing, index) => {
    if (thing.kind === 'issue') issues.set(at(thing.repoId, thing.number), { node: nodeOf(index), openedAt: thing.openedAt });
  });
  const claims = new Map<string, string>();
  for (const issue of linked) {
    const node = `l${at(issue.repoId, issue.number)}`;
    parent.set(node, node);
    claims.set(node, issue.itemId);
    // An issue numbered before was opened before anything numbered now.
    if (!issues.has(at(issue.repoId, issue.number))) issues.set(at(issue.repoId, issue.number), { node, openedAt: null });
  }

  pending.forEach((thing, index) => {
    if (thing.kind === 'request') {
      const issue = thing.repoId && thing.issueNumber !== null ? issues.get(at(thing.repoId, thing.issueNumber)) : undefined;
      if (issue) join(nodeOf(index), issue.node);
      return;
    }
    if (thing.kind !== 'pull') return;
    const own = headInRepository(thing.headRepo, thing.repoFullName) ? issueNumberFromBranch(thing.headRef ?? '') : null;
    const ownIssue = own !== null ? issues.get(at(thing.repoId, own)) : undefined;
    const target =
      ownIssue ??
      thing.closes
        .filter((number) => number !== thing.number)
        .map((number) => issues.get(at(thing.repoId, number)))
        .filter((issue): issue is { node: string; openedAt: string | null } => Boolean(issue))
        .sort((a, b) => (a.openedAt ?? '').localeCompare(b.openedAt ?? ''))[0];
    if (target) join(nodeOf(index), target.node);
  });

  const groups = new Map<string, workItems.PlannedGroup>();
  const requestClaims = new Map<string, { claim: string; openedAt: string }>();
  pending.forEach((thing, index) => {
    const root = find(nodeOf(index));
    const group = groups.get(root) ?? { members: [], claim: null };
    group.members.push(thing);
    groups.set(root, group);
    // A request numbered already, filed as an issue that was not: its issue
    // joins it, the earliest such request's when there are several.
    if (thing.kind === 'request' && thing.itemId) {
      const before = requestClaims.get(root);
      if (!before || thing.openedAt < before.openedAt) requestClaims.set(root, { claim: thing.itemId, openedAt: thing.openedAt });
    }
  });
  for (const [node, itemId] of claims) {
    const group = groups.get(find(node));
    if (group) group.claim = itemId;
  }
  for (const [root, { claim }] of requestClaims) {
    const group = groups.get(root)!;
    group.claim ??= claim;
  }

  const earliest = (group: workItems.PlannedGroup) => group.members.reduce((first, thing) => (thing.openedAt < first ? thing.openedAt : first), '￿');
  return [...groups.values()].sort((a, b) => earliest(a).localeCompare(earliest(b)));
}

/**
 * A work item's key as a person reads it: the GitHub organization, for
 * display only, and the number, which is the identity. #27 shows it.
 */
export function formatKey(number: number, organization: string): string {
  return `${organization}-${number}`;
}

/** The number and organization a key names; null for something that is not a key. */
export function parseKey(key: string): { organization: string; number: number } | null {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)-(\d+)$/.exec(key.trim());
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { organization: match[1]!, number } : null;
}

/** An issue's item, by its repository's full name: null for one with none, or in a repository this install does not manage. */
export async function issueItemLookup(): Promise<(repoFullName: string, number: number) => Promise<WorkItem | null>> {
  const managed = await repos.listRepos();
  return async (repoFullName, number) => {
    const repo = managed.find((one) => one.fullName.toLowerCase() === repoFullName.toLowerCase());
    return repo ? workItems.itemOf({ repoId: repo.id, number }) : null;
  };
}

/**
 * An issue's link, made or brought up to date. An issue's link is never
 * moved automatically: `claim` is the item a new one joins, a filed request's.
 */
export async function linkIssue(
  repo: { id: string },
  issue: { number: number; title: string; htmlUrl: string; state?: string | null; createdAt?: string | null },
  gone = false,
  claim: string | null = null,
): Promise<WorkItem | null> {
  return workItems.ensureLink(
    { repoId: repo.id, number: issue.number, kind: 'issue' },
    {
      title: issue.title,
      state: gone || issue.state === 'closed' ? 'closed' : 'open',
      url: issue.htmlUrl,
      openedAt: issue.createdAt ?? new Date().toISOString(),
    },
    claim,
  );
}

/** A pull request as GitHub delivers or lists it, for its link. */
export interface PullSighting extends PullFacts {
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  merged: boolean;
  createdAt: string | null;
}

/**
 * A pull request's link, made or brought up to date. `reclaim` works out
 * again which item it belongs to, as on an edit that adds `Closes #5`, and
 * moves an automatic link there; otherwise only a pull request with no link
 * yet is claimed. GitHub's closing references are read only when a claim is
 * worked out; when they cannot be, the body's keywords stand in.
 */
export async function linkPull(
  repo: { id: string },
  pull: PullSighting,
  options: { reclaim: boolean; client: Pick<GitHubClient, 'closingIssueRefs'> | null },
): Promise<WorkItem | null> {
  const thing = { repoId: repo.id, number: pull.number, kind: 'pull' as const };
  const snapshot: workItems.Snapshot = {
    title: pull.title,
    state: pull.merged ? 'merged' : pull.state,
    url: pull.htmlUrl,
    openedAt: pull.createdAt ?? new Date().toISOString(),
    headRef: pull.headRef,
    headRepo: pull.headRepoFullName,
    baseRef: pull.baseRef,
    closes: keywordCloses(pull),
  };
  const linked = await workItems.itemOf({ repoId: repo.id, number: pull.number });
  if (!(await workItems.isNumbered())) return workItems.ensureLink(thing, snapshot, null);
  if (linked && !options.reclaim) {
    // Its branch's issue, once that has an item, wins over whatever it was
    // given before: a pull request delivered before its issue was seen took
    // an item of its own, and kept it until it was edited or reopened. This
    // reads only the database, so it runs on every delivery.
    const own = headInRepository(pull.headRepoFullName, pull.repoFullName) ? issueNumberFromBranch(pull.headRef) : null;
    const ownItem = own !== null ? await workItems.itemOf({ repoId: repo.id, number: own }) : null;
    return workItems.ensureLink(thing, snapshot, ownItem?.id ?? null);
  }
  const closing = options.client
    ? await options.client.closingIssueRefs(pull.repoFullName, pull.number).catch((error: unknown) => {
        console.warn(
          `[bridge] GitHub could not say which issues ${pull.repoFullName}#${pull.number} closes, so its work item was found from its body: ` +
            `${error instanceof Error ? error.message : error}`,
        );
        return null;
      })
    : null;
  const claim = await claimForPull(pull, closing, await issueItemLookup());
  return workItems.ensureLink(thing, snapshot, claim);
}

/**
 * A request filed as an issue: the two share one item. An issue with no
 * link yet (the filing came before its delivery) joins the request's.
 * Otherwise the lower-numbered of their items is kept: an issue whose
 * delivery came first had an item of its own, later than the request's,
 * and is merged into it; an issue already in an earlier request's item (a
 * second request filed into the same issue) keeps it, and the later
 * request's is merged in. Either way the issue carries the earliest
 * request's number. `mergeInto` refuses two items that each hold an issue,
 * and those stay apart.
 */
export async function linkFiled(
  request: { id: string },
  repo: { id: string },
  issue: { number: number; title: string; htmlUrl: string; createdAt?: string | null },
): Promise<WorkItem | null> {
  const requestItem = await workItems.itemOf({ requestId: request.id });
  const known = await workItems.itemOf({ repoId: repo.id, number: issue.number });
  const issueItem = await linkIssue(repo, issue, false, known ? null : (requestItem?.id ?? null));
  if (requestItem && !issueItem) return joinFiledBefore(request, repo, issue.number, requestItem);
  if (!requestItem || !issueItem || requestItem.id === issueItem.id) return issueItem ?? requestItem;
  const [into, from] = requestItem.number < issueItem.number ? [requestItem, issueItem] : [issueItem, requestItem];
  return (await workItems.mergeInto(from.id, into.id)) ? into : issueItem;
}

/**
 * A request filed as an issue that has no item yet, its repository's history
 * not numbered: the issue cannot carry the number until it is, so a second
 * request filed as it kept the item it drew at create, and the two requests
 * stayed on two numbers. It joins the earlier request's item now, the lower
 * number kept, and the history numbering puts the issue there.
 */
async function joinFiledBefore(request: { id: string }, repo: { id: string }, issueNumber: number, requestItem: WorkItem): Promise<WorkItem> {
  const first = await workItems.firstFiledItem(repo.id, issueNumber, request.id);
  if (!first || first.id === requestItem.id) return requestItem;
  const [into, from] = first.number < requestItem.number ? [first, requestItem] : [requestItem, first];
  return (await workItems.mergeInto(from.id, into.id)) ? into : requestItem;
}

/** The repositories whose things are numbered live: their history has been numbered. */
export async function numberedRepoIds(): Promise<Set<string>> {
  const states = await workItems.backfillState();
  return new Set(states.flatMap((state) => (state.repoId && state.numberedAt ? [state.repoId] : [])));
}

/** An issue or pull request as the issues listing gives it: what the sweep and the catch-up read. */
export interface Listed {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  pullRequest: boolean;
  state: 'open' | 'closed';
  createdAt: string;
}

/**
 * Links what a listing found, in a numbered repository. An issue is linked or
 * refreshed. A pull request already linked is refreshed from the listing; one
 * with no link yet is read in full to work out which item it joins, which
 * once numbering has begun is the rare one a delivery missed.
 */
export async function linkListed(
  repo: { id: string; fullName: string; defaultBranch: string },
  entry: Listed,
  client: Pick<GitHubClient, 'getPullRequest' | 'closingIssueRefs'>,
): Promise<void> {
  if (!entry.pullRequest) {
    await linkIssue(repo, entry);
    return;
  }
  const thing = { repoId: repo.id, number: entry.number, kind: 'pull' as const };
  // One linked already is refreshed from the listing, unless it is open and
  // still alone, on an item of its own: its branch's issue may have been
  // seen since, and nothing else would move it there without a delivery.
  // The listing has no branch, so only that one is read in full.
  if ((await workItems.itemOf(thing)) && !(entry.state === 'open' && (await workItems.standsAlone(thing)))) {
    await workItems.ensureLink(thing, { title: entry.title, state: entry.state, url: entry.htmlUrl, openedAt: entry.createdAt }, null);
    return;
  }
  const pull = await client.getPullRequest(repo.fullName, entry.number);
  await linkPull(
    repo,
    {
      number: entry.number,
      repoFullName: repo.fullName,
      headRef: pull.headRef,
      headRepoFullName: pull.headRepoFullName,
      baseRef: pull.baseRef,
      defaultBranch: repo.defaultBranch,
      body: entry.body,
      title: entry.title,
      htmlUrl: entry.htmlUrl,
      state: pull.state,
      merged: pull.merged,
      createdAt: entry.createdAt,
    },
    { reclaim: false, client },
  );
}
