import { parseRef } from './work.js';

/** An issue or pull request, as a card names it. */
export interface SubjectTitle {
  title: string;
  url: string | null;
  pullRequest: boolean;
}

export interface SubjectTitlesDeps {
  /** A client to read GitHub with — the automation account's — or null when there is none. */
  client: () => Promise<{ getIssue(repo: string, number: number): Promise<{ title: string; htmlUrl: string }> } | null>;
  /** A managed repository's `owner/name`, by its short name. */
  fullName: (repoName: string) => Promise<string | null>;
  now?: () => number;
}

/** A pull request is seldom renamed, and the board reads what needs you every fifteen seconds. */
const KEPT_MS = 6 * 60 * 60 * 1000;
/** Not being able to read one is kept for less, so a GitHub that did not answer is asked again soon. */
const MISSED_MS = 10 * 60 * 1000;
/** At most this many are read from GitHub on one read of the list; the rest are named on the next. */
const PER_READ = 5;

/**
 * The titles of issues and pull requests the board has no row for.
 *
 * A reviewer's task is filed under the pull request, and a card named it by
 * the issue the pull request closes — which the board does not always know,
 * and then the card said "#2" and nothing else. What #2 is, is one read of
 * GitHub, kept for hours.
 */
export class SubjectTitles {
  private readonly cache = new Map<string, { at: number; title: SubjectTitle | null }>();

  constructor(private readonly deps: SubjectTitlesDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async lookup(refs: readonly string[]): Promise<Map<string, SubjectTitle>> {
    const found = new Map<string, SubjectTitle>();
    const toRead: string[] = [];
    for (const ref of new Set(refs)) {
      const kept = this.cache.get(ref);
      const fresh = kept && this.now() - kept.at < (kept.title ? KEPT_MS : MISSED_MS);
      if (fresh) {
        if (kept.title) found.set(ref, kept.title);
      } else if (parseRef(ref)) {
        toRead.push(ref);
      }
    }
    if (toRead.length === 0) return found;

    const client = await this.deps.client().catch(() => null);
    if (!client) return found;
    for (const ref of toRead.slice(0, PER_READ)) {
      const parsed = parseRef(ref)!;
      const fullName = await this.deps.fullName(parsed.repo).catch(() => null);
      let title: SubjectTitle | null = null;
      if (fullName) {
        title = await client
          .getIssue(fullName, parsed.number)
          .then((issue) => ({ title: issue.title, url: issue.htmlUrl, pullRequest: /\/pull\/\d+$/.test(issue.htmlUrl) }))
          .catch(() => null);
      }
      this.cache.set(ref, { at: this.now(), title });
      if (title) found.set(ref, title);
    }
    return found;
  }
}
