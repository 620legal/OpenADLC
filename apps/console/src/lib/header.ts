import type { AttentionItem, CrewMember } from './api';
import { groupCounts, groupOf, waiting } from './attention-card';
import type { BotFacts } from './bot-label';
import { crewCounts, type CrewCounts } from './crew';
import { notificationText } from './needs-you-alerts';
import type { RepoColorMap } from './repo-colors';

/**
 * What the header shows on every page, gathered by the page and handed down as
 * plain data: the header is drawn in the browser, and a function cannot cross
 * from a server page to it.
 */
export interface HeaderData {
  repos: string[];
  /** Each repository's colour by its name, for its dot wherever it is named. */
  repoColors: RepoColorMap;
  counts: CrewCounts;
  /**
   * Billed spend month to date against the cap, and the bridge's word on it;
   * `estimateUsd` beside it when runs on subscriptions cost anything, which is
   * not billed and not capped. Null when the costs could not be read.
   */
  spend: { spentUsd: number; capUsd: number; state?: string; estimateUsd?: number } | null;
  /** How many things are waiting on the person. Null when that could not be read. */
  needsYou: number | null;
  /** The same, as work and system, when the page read the items themselves. */
  needsSplit: { work: number; system: number } | null;
  /**
   * The work that waits, the chip's work count item by item, in the list's
   * order: what the tab's alerts tell new from already seen, and what a
   * notification says. Null when the page read no items.
   */
  needsItems: NeedsItem[] | null;
  /** Enough of the crew to name the bot that takes a request. */
  crew: BotFacts[];
}

/** One piece of work waiting on the person, as an alert names it and opens it. */
export interface NeedsItem {
  id: string;
  /** What its notification says: "The builder has a question about #42". */
  text: string;
  /** Its work item, which `/needs-you?item=` opens; null when it has none. */
  item: string | null;
}

export type Page = 'board' | 'crew' | 'costs' | 'insights' | 'settings' | 'needs-you';

export function headerData(input: {
  repos: readonly string[];
  repoColors?: RepoColorMap;
  crew: readonly CrewMember[];
  budget: { spentUsd: number; capUsd: number; state?: string; estimateUsd?: number } | null;
  needsYou: number | null;
  /** What waits, to say it as work and system; the count alone when absent. */
  attention?: readonly AttentionItem[] | null;
}): HeaderData {
  return {
    repos: [...input.repos],
    repoColors: { ...(input.repoColors ?? {}) },
    counts: crewCounts(input.crew),
    spend: input.budget
      ? {
          spentUsd: input.budget.spentUsd,
          capUsd: input.budget.capUsd,
          ...(input.budget.state ? { state: input.budget.state } : {}),
          ...((input.budget.estimateUsd ?? 0) > 0 ? { estimateUsd: input.budget.estimateUsd } : {}),
        }
      : null,
    needsYou: input.needsYou,
    needsSplit: input.attention ? groupCounts(input.attention) : null,
    needsItems: input.attention
      ? waiting(input.attention)
          .filter((item) => groupOf(item) === 'work')
          .map((item) => ({ id: item.id, text: notificationText(item, input.repos), item: item.subject.item ?? null }))
      : null,
    crew: input.crew.map((bot) => ({
      name: bot.name,
      slot: bot.slot ?? null,
      role: bot.role,
      authorization: bot.authorization,
      githubLogin: bot.githubLogin,
    })),
  };
}

/** The board, for a repository or for all of them. `?board=1` is what gets past the walkthrough. */
export function boardHref(repo: string | null | undefined, hash = ''): string {
  const query = repo && repo !== 'all' ? `&repo=${encodeURIComponent(repo)}` : '';
  return `/?board=1${query}${hash}`;
}

export const NAV: readonly { page: Exclude<Page, 'needs-you'>; label: string; href: (repo: string) => string }[] = [
  { page: 'board', label: 'Board', href: (repo) => boardHref(repo) },
  { page: 'crew', label: 'Crew', href: () => '/crew' },
  { page: 'costs', label: 'Costs', href: () => '/costs' },
  { page: 'insights', label: 'Insights', href: () => '/insights' },
  { page: 'settings', label: 'Settings', href: () => '/settings' },
];

/**
 * How much of the cap is spent, and the colour that says whether that is fine.
 * `percent` is said and is not held to 100: $2,000 of a $1,500 cap read as
 * "100.0 percent" and understated the overrun. `width` is the bar's, which is.
 */
export function spendLevel(spend: { spentUsd: number; capUsd: number; state?: string }): {
  percent: number;
  width: number;
  tone: 'signal' | 'attention' | 'alarm';
} {
  const percent = spend.capUsd > 0 ? (spend.spentUsd / spend.capUsd) * 100 : 0;
  const width = Math.min(100, percent);
  // The bridge warns at `warningAt` (90% by default) and the dispatcher stops
  // leasing at the cap. Its state says which, for whatever `warningAt` is set
  // to; the percentages are only for a figure that came without one.
  if (spend.state === 'stopped') return { percent, width, tone: 'alarm' };
  if (spend.state === 'warning') return { percent, width, tone: 'attention' };
  if (spend.state) return { percent, width, tone: 'signal' };
  return { percent, width, tone: percent >= 100 ? 'alarm' : percent >= 90 ? 'attention' : 'signal' };
}
