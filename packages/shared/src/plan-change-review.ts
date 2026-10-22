import { pathMatches as ruleMatches, type HumanReviewRule } from './human-review.js';
import { normalisePlanPaths, parseMarkers } from './markers.js';
import { pathMatches as policyPathMatches, pathsOverlap } from './path-overlap.js';

/**
 * Settling a builder's plan changes without a person answering each one
 * (#77): a person's standing approval for one piece of work, or the design
 * seat's judgement of one request against the issue's design. Both stop at
 * the same line: a path under `## Human review` in `AGENTS.md` is always a
 * person's to approve. On 2026-10-22, #27 and #45 each asked for several paths
 * one after another, and each waited on a person.
 */

/** The skill the design seat runs to judge one plan change (`crew/skills/plan-change-review/`). */
export const PLAN_CHANGE_REVIEW_SKILL = 'plan-change-review';

/**
 * The paths of a request that a Human-review rule covers, or that hold a file
 * one covers: asking for `apps/bridge/src/` asks for `gates.ts` with it.
 */
export function underHumanReview(paths: readonly string[], rules: readonly HumanReviewRule[]): string[] {
  return paths.filter((path) => rules.some((rule) => ruleMatches(rule.path, path) || pathsOverlap([path], [rule.path])));
}

/**
 * What a card and the issue say when a repository's Human-review rules could
 * not be read: `what` could not be, and the `fix`, each without its full
 * stop. The bridge cannot tell which way they failed (`readFileAtRef` answers
 * null for a file that is missing and for one it could not read, the parser
 * null for no section and for a line it cannot read), so the fix names both.
 */
export function rulesUnreadWords(base: string | null): { what: string; fix: string } {
  const on = base && base !== 'HEAD' ? `on \`${base}\`` : 'on the default branch';
  return {
    what: `OpenADLC could not read the Human-review rules in AGENTS.md ${on}`,
    fix:
      `Add a \`## Human review\` section to AGENTS.md ${on}, or fix the line of it OpenADLC cannot read ` +
      '(the repository’s card in Needs you names it); until then a person approves every path',
  };
}

/**
 * What keeps a plan change for a person, whatever approve all or the designer
 * would give it: the paths under Human review, or the rules that could not be
 * read. Unknown holds, as the merge gate holds it, so with no rules every path
 * is a person's, but none is said to be under Human review: on 2026-10-22 a
 * card said `apps/probe60-more/util.ts` was, in a repository whose AGENTS.md
 * could not be read for its rules.
 */
export interface KeptForPerson {
  humanReview: string[];
  /** Set when the rules could not be read (`rulesUnreadWords`); every path is a person's then. */
  rulesUnread: { what: string; fix: string } | null;
}

/** What keeps these paths for a person, from the rules on `base`, or null rules when they could not be read. */
export function keptForPerson(paths: readonly string[], rules: readonly HumanReviewRule[] | null, base: string | null): KeptForPerson {
  if (!rules) return { humanReview: [], rulesUnread: rulesUnreadWords(base) };
  return { humanReview: underHumanReview(paths, rules), rulesUnread: null };
}

/** Whether anything keeps a plan change for a person. */
export function keepsForPerson(kept: KeptForPerson): boolean {
  return kept.rulesUnread !== null || kept.humanReview.length > 0;
}

/** A token a design writes that reads as a repository path: a folder, then a name. */
const PATH_TOKEN = /(?:^|[\s(`'"[,;:])((?:\.?[\w@-][\w.@-]*\/)+(?:[\w.@*-]+\/?)?)(?=$|[\s)`'",;:\]]|\.(?:\s|$))/g;

/**
 * The paths a design's text names, in the order it names them: backticked or
 * bare, as long as there is a folder in them. A sentence's `and/or` is not a
 * path, and the cleaning a plan change's own paths get (`normalisePlanPaths`)
 * is applied, so a path that leaves the repository names nothing.
 */
export function pathsNamedIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(PATH_TOKEN)) {
    const token = (match[1] ?? '').replace(/[.,;:]+$/, '');
    const segments = token.replace(/\/+$/, '').split('/');
    // Two words joined by a slash are prose unless one of them looks like a
    // file: `and/or`, `read/write` are not paths, `src/x.ts` is.
    if (segments.length < 2) continue;
    if (segments.length === 2 && !token.endsWith('/') && !segments.some((segment) => segment.includes('.'))) continue;
    found.push(token);
  }
  return normalisePlanPaths(found);
}

function segmentsOf(path: string): string[] {
  return path
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
}

/** A folder: written with a trailing `/`, or a star at its end. */
function isFolder(path: string): boolean {
  return /\/$/.test(path) || /\/\*{1,2}$/.test(path);
}

/** A star anywhere but a folder's end: wider than any one place. */
function isGlob(path: string): boolean {
  return /\*/.test(path.replace(/\/\*{1,2}$/, ''));
}

/**
 * The package a path is in: the folder two levels down from the root
 * (`apps/bridge`, `packages/shared`), or its own folder when it sits higher.
 * A file at the root, or a folder wider than one package (`apps/`), is in
 * none, and is beside nothing.
 */
function packageOf(path: string): string | null {
  if (isGlob(path)) return null;
  const segments = segmentsOf(path.replace(/\/\*{1,2}$/, '/'));
  const folders = isFolder(path) ? segments : segments.slice(0, -1);
  if (folders.length === 0 || (isFolder(path) && folders.length < 2)) return null;
  return folders.slice(0, 2).join('/');
}

/** A file's name without its folder, its extension, or its test marking: `gates` for `gates.test.ts`. */
function stemOf(path: string): string {
  const name = segmentsOf(path).at(-1) ?? '';
  return name
    .replace(/\.(?:test|spec)(?=\.)/, '')
    .replace(/^test_/, '')
    .replace(/_test(?=\.)/, '')
    .replace(/\.[^.]+$/, '');
}

function isTestFile(path: string): boolean {
  const segments = segmentsOf(path);
  const name = segments.at(-1) ?? '';
  return /\.(?:test|spec)\./.test(name) || /^test_/.test(name) || /_test\./.test(name) || segments.some((segment) => /^(?:tests?|__tests__)$/.test(segment));
}

/** Whether a design that names `named` names `path`: the same path, or a folder or pattern it is in. */
function names(named: string, path: string): boolean {
  if (named === path) return true;
  if (isFolder(named) || isGlob(named)) return !isGlob(path) && policyPathMatches(path.replace(/\/+$/, ''), isFolder(named) ? named.replace(/\*+$/, '') : named);
  return false;
}

/** Whether `path` sits beside a path the design names: its package, a test of it, or the docs. */
function beside(named: string, path: string): boolean {
  if (isGlob(path)) return false;
  if (segmentsOf(path)[0] === 'docs') return true;
  const mine = packageOf(path);
  if (mine && mine === packageOf(named)) return true;
  return isTestFile(path) && !isFolder(path) && stemOf(path) === stemOf(named) && stemOf(path).length > 0;
}

/** Why the designer's approval does not count for a path. */
export interface OutsideTheDesign {
  path: string;
  why: string;
}

/**
 * What the designer's approval of a request counts for. It counts as the
 * decision only when every path is one the design names or sits beside (the
 * same package, its tests, the docs) and none is under Human review; otherwise
 * it is advice, the question stays for a person, and `outside` says which
 * paths kept it there and why. `designPaths` null is an issue with no design
 * to judge against: the designer's view is advice then too, as it is for
 * every path when the Human-review rules could not be read (`rulesUnread`).
 */
export function designerLimits(input: {
  paths: readonly string[];
  designPaths: readonly string[] | null;
  humanReview: readonly string[];
  rulesUnread?: { what: string; fix: string } | null;
}): { counts: boolean; outside: OutsideTheDesign[] } {
  const outside: OutsideTheDesign[] = [];
  for (const path of input.paths) {
    if (input.rulesUnread) {
      outside.push({ path, why: `${input.rulesUnread.what}, so the designer’s approval is advice. ${input.rulesUnread.fix}` });
    } else if (input.humanReview.includes(path)) {
      outside.push({ path, why: 'it is under Human review in AGENTS.md, which only a person approves' });
    } else if (input.designPaths === null) {
      outside.push({ path, why: 'the issue has no design to judge it against' });
    } else if (!input.designPaths.some((named) => names(named, path) || beside(named, path))) {
      outside.push({ path, why: 'the design neither names it nor anything beside it' });
    }
  }
  return { counts: outside.length === 0 && input.paths.length > 0, outside };
}

/**
 * What kept the designer's approval from settling a request, as the issue and
 * the card say it: the paths that share a reason named together, before it,
 * so a reason every path has (rules that could not be read) is said once.
 */
export function outsideInWords(outside: readonly OutsideTheDesign[]): string {
  const byWhy = new Map<string, string[]>();
  for (const entry of outside) byWhy.set(entry.why, [...(byWhy.get(entry.why) ?? []), entry.path]);
  return [...byWhy].map(([why, paths]) => `${paths.map((path) => `\`${path}\``).join(', ')}: ${why}`).join('; ');
}

/** The design seat's answer to a plan change, as its message ends. */
export interface PlanChangeVerdict {
  verdict: 'approve' | 'refuse';
  reason: string;
}

/**
 * The verdict a design seat's message ends with:
 *
 *     <!-- openadlc:{"event":"plan_change_verdict","verdict":"approve","reason":"…"} -->
 *
 * The last such marker, so one the designer quoted from the skill before its
 * own is not taken for it. Only the runner's post of the session's own output
 * is read for this (`/internal/tasks/:id/message`); a marker in a comment on
 * GitHub is never a verdict.
 */
export function parsePlanChangeVerdict(text: string): PlanChangeVerdict | null {
  const marker = parseMarkers(text)
    .filter((one) => one.event === 'plan_change_verdict')
    .at(-1);
  const verdict = typeof marker?.verdict === 'string' ? marker.verdict.trim().toLowerCase() : '';
  if (verdict !== 'approve' && verdict !== 'refuse') return null;
  const reason = typeof marker?.reason === 'string' ? marker.reason.trim().slice(0, 2000) : '';
  return { verdict, reason };
}

const EXPECTED_PATHS = /((?:^|\n)#{1,6}\s*Expected paths[ \t]*\n+)([\s\S]*?)(?=\n#{1,6}\s|$(?![\s\S]))/i;

/**
 * The issue body with these paths taken out of its Expected paths: the lines
 * that are exactly one of them, backticks or not. What a refusal after the
 * fact takes back; a line that names more than one path is left as it is,
 * since it was a person's or the design's, not the approval's.
 */
export function withoutExpectedPaths(issueBody: string, paths: readonly string[]): string {
  const text = issueBody.replace(/\r\n?/g, '\n');
  const match = EXPECTED_PATHS.exec(text);
  if (!match) return issueBody;
  const drop = new Set(paths);
  const start = match.index + match[1]!.length;
  const section = match[2]!;
  const kept = section
    .split('\n')
    .filter((line) => {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+`?([^`\s]+)`?\s*$/.exec(line);
      return !(item && drop.has(item[1]!));
    })
    .join('\n');
  if (kept === section) return issueBody;
  return text.slice(0, start) + kept + text.slice(start + section.length);
}
