import { hasAbandonedLabel } from './stages.js';

/**
 * What an issue is waiting for, read from its own body.
 *
 * `blocked` was a note: nothing ever removed it, so an issue stayed blocked
 * until a person noticed that the thing it waited for had shipped. For the label
 * to be a mechanism, the dependency has to be written somewhere a machine reads,
 * and the issue body is where the rest of an issue's contract already lives —
 * beside Acceptance criteria and Expected paths, in the shape the dispatcher
 * already parses.
 *
 * ```markdown
 * ### Dependencies
 *
 * - #42
 * - #51 — the token service has to land first
 * ```
 *
 * Nothing in this repository defined that section before, so the format is a
 * decision. Bare `#42` on its own line works too; anything after the number is
 * for a person. `- owner/name#42` names issue 42 in another repository this
 * install manages; one it does not manage never ships.
 */

const HEADING = /^#{1,6}\s+dependencies\s*$/i;
const ANY_HEADING = /^#{1,6}\s+/;

/**
 * One dependency as written: `repo` is `owner/name` as the line spells it, or
 * null for `#N`, which names an issue in this issue's own repository.
 */
export interface DependencyRef {
  repo: string | null;
  number: number;
}

/**
 * The issues this one waits for, in the order written, without repeats.
 *
 * An empty list and "no Dependencies section" are the same answer here, unlike
 * the human-review rules: an issue that names no dependency is not waiting for
 * anything, which is a complete answer rather than a missing one.
 *
 * This replaced a parser that returned numbers only. It read `- #N` and skipped
 * `- owner/name#N`, so an issue waiting on work in another managed repository
 * was given `start:now` and built before that work shipped. Nothing kept the
 * numbers-only parser alive beside this one: a caller that picked it would drop
 * a cross-repository line again, with nothing to catch it.
 */
export function parseDependencyRefs(body: string | null): DependencyRef[] {
  if (!body) return [];

  const lines = body.split('\n');
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return [];

  const refs: DependencyRef[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (ANY_HEADING.test(trimmed)) break;
    if (trimmed.length === 0) continue;

    // Only a reference the line starts with, as a list item or on its own:
    // `- #42 — blocked by #43 as well` names one dependency and explains it.
    // A reference inside a sentence is prose: intake wrote "None. This
    // supersedes #3, which is closed as superseded; it is not a dependency",
    // and the issue waited for #3, which would never ship, without a word.
    const match = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+))?#(\d+)\b/.exec(trimmed);
    if (!match?.[2]) continue;
    const number = Number(match[2]);
    if (!Number.isFinite(number)) continue;
    const repo = match[1] ?? null;
    // GitHub ignores case in a repository's name, so `A/B#3` repeats `a/b#3`.
    // The first spelling is kept.
    const key = `${repo?.toLowerCase() ?? ''}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ repo, number });
  }

  return refs;
}

/** `#N`, or `owner/name#N` as written: how a dependency is shown and audited. */
export function formatDependencyRef(ref: DependencyRef): string {
  return ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`;
}

/**
 * Whether the ref names the repository `fullName`: it names no repository, or
 * names this one in any case. A ref that spells out its own repository is a
 * same-repository dependency everywhere, stacking included.
 */
export function namesRepository(ref: DependencyRef, fullName: string): boolean {
  return ref.repo === null || ref.repo.toLowerCase() === fullName.toLowerCase();
}

/**
 * Whether a dependency has shipped far enough to stop blocking.
 *
 * The plan asks for closed *and* reached testing: a merge is not a release, and
 * an issue waiting on a behaviour is waiting for it to be somewhere it can be
 * seen. `deployed:testing` is the label the bridge puts on a change when GitHub
 * reports its testing deploy succeeded.
 */
export function dependencyIsSatisfied(dependency: { stage: string; labels: string[] } | null): boolean {
  if (!dependency) {
    // An issue that names a dependency the platform has never seen is not
    // unblocked by its absence. Somebody has to look.
    return false;
  }
  // Closed without merging: in Done, and nothing of it shipped. Read as
  // shipped, the issue waiting on it started on work that will never land.
  if (hasAbandonedLabel(dependency.labels)) return false;
  // Done is otherwise shipped, however it got there. In a repository that
  // deploys, Done comes after production, which is past testing. In one that
  // deploys nothing, merging is shipping: the card goes to Done with no deploy
  // label at all, and an issue waiting on it would have waited for good.
  if (dependency.stage === 'done') return true;
  if (dependency.stage !== 'merged') return false;
  return dependency.labels.includes('deployed:testing');
}
