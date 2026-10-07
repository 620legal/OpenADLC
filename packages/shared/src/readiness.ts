/**
 * Whether an issue says enough to be worked on.
 *
 * Routability required only `adlc:build`, `start:now`, and the absence of
 * `needs-human` and `blocked`. So an issue with no declared paths was leased,
 * and the overlap check that keeps two changes off the same file then had
 * nothing to compare — the guarantee was only as good as whoever wrote the
 * issue.
 *
 * The plan asks for more, and what it asks for is the difference between a
 * request and a task: a priority so the board can order it, an area so it can be
 * routed, exactly one `do:*` so it is clear who acts, and the four fields a
 * builder reads before it starts.
 */

import { unreadablePathLines } from './checks.js';

/** The sections a task is briefed from. Missing one means the builder guesses. */
const REQUIRED_SECTIONS: { field: string; pattern: RegExp }[] = [
  { field: 'Outcome', pattern: /^#{1,6}\s+outcome\s*$/im },
  { field: 'Acceptance criteria', pattern: /^#{1,6}\s+acceptance criteria\s*$/im },
  { field: 'Expected paths', pattern: /^#{1,6}\s+expected paths\s*$/im },
  { field: 'Verification', pattern: /^#{1,6}\s+verification\s*$/im },
];

export interface RoutableIssue {
  labels: string[];
  declaredPaths: string[];
  body: string;
}

/**
 * What is missing before this can be leased, in the order a person would fix it.
 * Empty means it is ready.
 */
export function missingForRouting(issue: RoutableIssue): string[] {
  const missing: string[] = [];
  const labels = issue.labels;

  if (!labels.some((label) => label.startsWith('priority:'))) missing.push('a priority label');
  if (!labels.some((label) => label.startsWith('area:'))) missing.push('an area label');

  const doers = labels.filter((label) => label.startsWith('do:'));
  // Exactly one: none leaves nobody assigned, and two is a disagreement about
  // who acts that nothing downstream resolves.
  if (doers.length === 0) missing.push('a do: label');
  else if (doers.length > 1) missing.push(`one do: label, not ${doers.length} (${doers.join(', ')})`);

  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(issue.body)) missing.push(`${/^[aeiou]/i.test(section.field) ? 'an' : 'a'} ${section.field} section`);
  }

  // The one with teeth. Declared paths are what the lease claims and what the
  // overlap check compares; without them two bots can be sent at the same file.
  if (issue.declaredPaths.length === 0) missing.push(NO_EXPECTED_PATH);
  // A line the parser cannot read is a file the lease would not claim.
  for (const line of unreadablePathLines(issue.body)) missing.push(`${UNREADABLE_PATH_LINE}: ${line}`);

  return missing;
}

const NO_EXPECTED_PATH = 'at least one expected path';
/** How `missingForRouting` names a line of Expected paths that is not a path, before the line itself. */
export const UNREADABLE_PATH_LINE = 'an Expected paths line that is not a path';

/**
 * Whether what is missing is only that the Expected paths do not read, with a
 * line there that is not a path. That is no question for a person: the stage
 * that wrote the paths rewrites them from the code, one file per line, so the
 * dispatcher sends such an issue back to it rather than to triage.
 */
export function onlyExpectedPathsUnreadable(missing: readonly string[]): boolean {
  return (
    missing.some((item) => item.startsWith(`${UNREADABLE_PATH_LINE}: `)) &&
    missing.every((item) => item === NO_EXPECTED_PATH || item.startsWith(`${UNREADABLE_PATH_LINE}: `))
  );
}

/**
 * How many times work has been handed out for an issue and come back with
 * nothing.
 *
 * The plan sends an issue to triage after three. Not because the builder is at
 * fault — three failures to produce a pull request is the issue failing to say
 * what it wants, and trying a fourth time is how a loop is made.
 */
export const ATTEMPTS_BEFORE_TRIAGE = 3;

export function tooManyAttempts(leasesWithoutPullRequest: number): boolean {
  return leasesWithoutPullRequest >= ATTEMPTS_BEFORE_TRIAGE;
}
