import { issues, repos, settings, workItems } from '@openadlc/db';
import type { Router } from './router.js';
import { itemKey } from './items.js';
import { ignoredSubjects, type IssueFacts } from './work.js';

/**
 * The jump list: the work items the console's command palette can open, read
 * whole each time it opens and matched in the browser (docs/adr/0029). Open
 * items, and those closed in the last `RECENTLY_CLOSED_DAYS`.
 */

/** How far back a closed item is still in the jump list. */
export const RECENTLY_CLOSED_DAYS = 30;
/** At most this many: open plus a month is a few hundred on a busy install. */
export const JUMP_LIST_MAX = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An item as the palette lists it. */
export interface JumpItem {
  key: string;
  number: number;
  /** Its first issue's title, or its first link's when it has no issue. */
  title: string;
  /** `repo#12` for each issue and pull request on it, in the order they were linked. */
  refs: string[];
  /** Whether any of its links is open. */
  open: boolean;
  /** When it is not open: the latest any of its links closed (opened, for one nobody saw close). */
  closedAt: string | null;
}

/** What the list reads; the store's in `defaultItemSearchDeps`. */
export interface ItemSearchDeps {
  isNumbered(): Promise<boolean>;
  boardLinks(since: Date): Promise<workItems.Link[]>;
  boardIssues(since: Date): Promise<Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'labels'>[]>;
  repos(): Promise<{ id: string; name: string }[]>;
  organization(): Promise<string | null>;
  now?: () => Date;
}

export function defaultItemSearchDeps(): ItemSearchDeps {
  return {
    // A table a release behind is an install not numbered, not a list that fails.
    isNumbered: () => (async () => workItems.isNumbered())().catch(() => false),
    boardLinks: (since) => workItems.boardLinks(since),
    boardIssues: (since) => issues.boardIssues(since),
    repos: () => repos.listRepos(),
    organization: () => settings.getSetting('organization').catch(() => null),
  };
}

/**
 * The items open now or closed since `since`, from the board's read of links
 * (`boardLinks`), which already holds every link of each such item. A link in
 * a repository the install no longer works in is history, not the list's; an
 * issue labelled `openadlc:ignore` and its pull request are a person's
 * (`ignoredSubjects`), and an item whose first issue is one is left out
 * whole, as its page refuses it.
 */
export function jumpList(
  links: readonly workItems.Link[],
  input: { repos: readonly { id: string; name: string }[]; ignored: ReadonlySet<string>; organization: string | null; since: Date },
): JumpItem[] {
  const repoNames = new Map(input.repos.map((repo) => [repo.id, repo.name]));
  const byItem = new Map<number, { link: workItems.Link; ref: string | null }[]>();
  for (const link of links) {
    if (link.itemNumber === undefined) continue;
    const repoName = link.repoId ? repoNames.get(link.repoId) : undefined;
    if (link.repoId && !repoName) continue;
    const ref = repoName && link.number !== null ? `${repoName}#${link.number}` : null;
    const list = byItem.get(link.itemNumber) ?? [];
    list.push({ link, ref });
    byItem.set(link.itemNumber, list);
  }

  const since = input.since.getTime();
  const items: JumpItem[] = [];
  for (const [number, all] of byItem) {
    const ordered = [...all].sort((a, b) => a.link.id - b.link.id);
    const firstIssue = ordered.find((one) => one.link.kind === 'issue');
    if (firstIssue?.ref && input.ignored.has(firstIssue.ref)) continue;
    const kept = ordered.filter((one) => !(one.ref && input.ignored.has(one.ref)));
    if (kept.length === 0) continue;
    const open = kept.some((one) => one.link.state === 'open');
    const closedAt = open
      ? null
      : kept.map((one) => one.link.closedAt ?? one.link.openedAt).reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest));
    // The board also reads an item whose issue it holds outside Done; closed longer ago than the window, it is not recent.
    if (!open && Date.parse(closedAt!) < since) continue;
    const titled = kept.find((one) => one.link.kind === 'issue') ?? kept[0]!;
    items.push({
      key: itemKey(number, input.organization),
      number,
      title: titled.link.title,
      refs: kept.flatMap((one) => (one.link.kind !== 'request' && one.ref ? [one.ref] : [])),
      open,
      closedAt,
    });
  }
  return items.sort((a, b) => (a.open !== b.open ? (a.open ? -1 : 1) : b.number - a.number)).slice(0, JUMP_LIST_MAX);
}

/**
 * `GET /v1/items`: the jump list, for anyone with a role (`roles.ts`). No
 * segment after `items`, so it never meets `/v1/items/:subject`, which would
 * read `/v1/items/search` as the subject "search". Before the install is
 * numbered there is nothing to jump to.
 */
export function registerItemSearchRoutes(router: Router, deps: ItemSearchDeps = defaultItemSearchDeps()): void {
  router.get('/v1/items', async () => {
    if (!(await deps.isNumbered())) return { numbered: false, items: [] as JumpItem[] };
    const since = new Date((deps.now?.() ?? new Date()).getTime() - RECENTLY_CLOSED_DAYS * DAY_MS);
    const [links, issueList, repoList, organization] = await Promise.all([
      deps.boardLinks(since),
      deps.boardIssues(since),
      deps.repos(),
      deps.organization(),
    ]);
    return { numbered: true, items: jumpList(links, { repos: repoList, ignored: ignoredSubjects(issueList), organization, since }) };
  });
}
