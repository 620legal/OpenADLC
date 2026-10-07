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
 * for a person.
 */

const HEADING = /^#{1,6}\s+dependencies\s*$/i;
const ANY_HEADING = /^#{1,6}\s+/;

/**
 * Issue numbers this one waits for, in the order written, without repeats.
 *
 * An empty list and "no Dependencies section" are the same answer here, unlike
 * the human-review rules: an issue that names no dependency is not waiting for
 * anything, which is a complete answer rather than a missing one.
 */
export function parseDependencies(body: string | null): number[] {
  if (!body) return [];

  const lines = body.split('\n');
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return [];

  const numbers: number[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (ANY_HEADING.test(trimmed)) break;
    if (trimmed.length === 0) continue;

    // Only a reference the line starts with, as a list item or on its own:
    // `- #42 — blocked by #43 as well` names one dependency and explains it.
    // A reference inside a sentence is prose: intake wrote "None. This
    // supersedes #3, which is closed as superseded; it is not a dependency",
    // and the issue waited for #3, which would never ship, without a word.
    const match = /^(?:[-*+]\s+|\d+[.)]\s+)?#(\d+)\b/.exec(trimmed);
    if (!match?.[1]) continue;
    const number = Number(match[1]);
    if (Number.isFinite(number) && !numbers.includes(number)) numbers.push(number);
  }

  return numbers;
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
  // Done is shipped, however it got there. In a repository that deploys, Done
  // comes after production, which is past testing. In one that deploys
  // nothing, merging is shipping: the card goes to Done with no deploy label
  // at all, and an issue waiting on it would have waited for good.
  if (dependency.stage === 'done') return true;
  if (dependency.stage !== 'merged') return false;
  return dependency.labels.includes('deployed:testing');
}
