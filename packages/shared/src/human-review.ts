import { pathMatches as globPathMatches } from './path-overlap.js';

/**
 * Which paths need a named person's approval, read from the repository's own
 * `AGENTS.md`.
 *
 * Two things make this different from the path list it replaces. It names *who*,
 * so a path that needs one person's judgement is not satisfied by somebody
 * else's approval. And it lives in the repository being changed rather than in
 * the platform's configuration, so the rule travels with the code — read from
 * the base branch, never from the pull request's own copy, or a pull request could edit
 * its way out of the review it is subject to.
 *
 * The format is a section a person can read and edit without knowing it is
 * parsed:
 *
 * ```markdown
 * ## Human review
 *
 * - `config/` @janedoe
 * - `infra/` @janedoe
 * - `.github/workflows/` @janedoe @someone-else
 * ```
 *
 * The heading matches at any level, and the section runs to the next heading
 * of the same level or higher, so a sub-heading inside it (`### Infrastructure`)
 * groups rules rather than ending them. A rule is a list item (`-`, `*`, `+` or
 * numbered): one path, then the logins whose approval satisfies it.
 *
 * - The path is the first backticked span, or else the line's first word.
 *   Backticks are optional, and a leading `/` or `./` is ignored.
 * - A path without `*` is a prefix: `infra` and `infra/` both cover
 *   `infra/main.tf`, and neither covers `infrastructure/`. A trailing `*` or
 *   `**` reads the same way. A path with a `*` anywhere else is a glob: `*.tf`
 *   is a name at any depth, and a `**` segment any run of folders, so a rule
 *   can name every `migrations` folder wherever it is.
 * - Words in parentheses, and words after the logins, are a note.
 * - An item with no login names nobody, and is not a rule.
 *
 * A line the parser cannot read — two paths, a team (`@org/team`), a path it
 * cannot find — makes the whole section unreadable, so the gate holds rather
 * than releasing what the line meant to cover. `unreadableHumanReviewLines`
 * says which line and why.
 */

export interface HumanReviewRule {
  /**
   * A path prefix, or a glob when it holds a `*` other than at its end, as
   * written in the file without a leading `/` or `./`.
   */
  path: string;
  /** GitHub logins, without the `@`. */
  logins: string[];
}

const HEADING = /^(#{1,6})\s+human\s+review\s*$/i;
const ANY_HEADING = /^(#{1,6})\s+/;
const ITEM = /^(?:[-*+]|\d+[.)])\s+(.+)$/;
const LOGIN = /^@([A-Za-z0-9][A-Za-z0-9-]*)(\/\S*)?/;

/** A word that reads as a path: a `/` or a `*` in it, or a file name with an extension. */
function pathLike(word: string): boolean {
  return /[/*]/.test(word) || /^\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(word);
}

/**
 * The lines of the `## Human review` section, with their line numbers counting
 * from 1, or null when there is no such section. A deeper heading is skipped;
 * one of the same level or higher ends it.
 */
function sectionLines(agentsMarkdown: string): { line: number; text: string }[] | null {
  const lines = agentsMarkdown.split('\n');
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return null;
  const level = (HEADING.exec((lines[start] ?? '').trim())?.[1] ?? '#').length;
  const section: { line: number; text: string }[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const text = (lines[index] ?? '').trim();
    const heading = ANY_HEADING.exec(text);
    if (heading) {
      if ((heading[1] ?? '').length <= level) break;
      continue;
    }
    section.push({ line: index + 1, text });
  }
  return section;
}

/**
 * The section as written, from its heading to the next heading of the same
 * level or higher, sub-headings included, with line endings made one kind and
 * the ends trimmed. Null when there is no such section.
 */
function rawSection(agentsMarkdown: string): string | null {
  const lines = agentsMarkdown.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return null;
  const level = (HEADING.exec((lines[start] ?? '').trim())?.[1] ?? '#').length;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const heading = ANY_HEADING.exec((lines[end] ?? '').trim());
    if (heading && (heading[1] ?? '').length <= level) break;
  }
  return lines.slice(start, end).join('\n').trim();
}

/**
 * Whether a pull request changes the `## Human review` section itself: its
 * text on the head differs from the base's, or the head has no section, or no
 * `AGENTS.md` at all (`null`).
 *
 * The section is read from the base, so a pull request cannot exempt itself,
 * but `AGENTS.md` is not one of the paths it lists, and builders edit the file
 * all the time. A first pull request could take a line out, or write a rule
 * the parser drops, and merge on the lead's approval alone; every later one
 * touching those paths then needed nobody. Compared as text, not as rules,
 * so an edit that leaves the parsed rules looking the same, or empty, still
 * counts.
 */
export function humanReviewSectionChanged(baseAgents: string | null, headAgents: string | null): boolean {
  const head = headAgents === null ? null : rawSection(headAgents);
  if (head === null) return true;
  return (baseAgents === null ? null : rawSection(baseAgents)) !== head;
}

/** Every login the rules name, once each, in the order they are named. */
export function everyHumanReviewer(rules: HumanReviewRule[]): string[] {
  const named: string[] = [];
  for (const rule of rules) {
    for (const login of rule.logins) if (!named.includes(login)) named.push(login);
  }
  return named;
}

/**
 * One line of the section, read: a rule, a reason it cannot be read, or null
 * for a line that is not a rule (prose, or an item that names nobody).
 */
function readLine(text: string): { rule: HumanReviewRule } | { unreadable: string } | null {
  const item = ITEM.exec(text)?.[1];
  if (!item) return null;

  let path: string;
  let rest: string[];
  const tick = item.indexOf('`');
  if (tick >= 0) {
    const close = item.indexOf('`', tick + 1);
    if (close < 0) return { unreadable: 'a backtick is not closed' };
    path = item.slice(tick + 1, close).trim();
    const others = `${item.slice(0, tick)} ${item.slice(close + 1)}`;
    if (others.includes('`')) return { unreadable: 'it names two paths; give each its own line' };
    rest = others.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);
  } else {
    const words = item.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);
    path = words[0]?.startsWith('@') ? '' : (words.shift() ?? '');
    rest = words;
  }

  const logins: string[] = [];
  for (const word of rest) {
    const login = LOGIN.exec(word);
    if (login) {
      if (login[2]) {
        return { unreadable: `${word} is a team, and the gate waits on people: name the GitHub login of each person instead` };
      }
      logins.push(login[1] as string);
    } else if (logins.length === 0 && pathLike(word)) {
      return { unreadable: 'it names two paths; give each its own line' };
    }
  }
  // A path with nobody against it names no one, which is the bug this exists
  // to fix — so it is not a rule.
  if (logins.length === 0) return null;

  path = path.replace(/^\.?\//, '');
  if (path.length === 0) return { unreadable: 'it names no path before the logins' };
  if (/\s/.test(path)) return { unreadable: 'it names two paths; give each its own line' };
  return { rule: { path, logins } };
}

/**
 * The rules, or `null` when the file has no such section at all.
 *
 * `null` and "an empty list" are different answers: a repository that says
 * nothing about human review is not the same as one that says nothing needs it,
 * and the caller holds the gate rather than guessing which was meant.
 */
export function parseHumanReviewPaths(agentsMarkdown: string | null): HumanReviewRule[] | null {
  if (agentsMarkdown === null) return null;
  const section = sectionLines(agentsMarkdown);
  if (!section) return null;

  const rules: HumanReviewRule[] = [];
  for (const { text } of section) {
    const read = readLine(text);
    if (!read) continue;
    // A rule the parser cannot read is not one to drop: `./config/`, a team or
    // two paths on a line matched nothing, and the gate released what it meant
    // to hold. Unknown, so the caller holds it.
    if ('unreadable' in read) return null;
    rules.push(read.rule);
  }
  return rules;
}

/** A line of the `## Human review` section the parser cannot read, and why. */
export interface UnreadableHumanReviewLine {
  /** Counting from 1. */
  line: number;
  text: string;
  reason: string;
}

/**
 * Every line of the section that makes it unreadable, so a card can say which
 * line to fix rather than only that the gate is holding.
 */
export function unreadableHumanReviewLines(agentsMarkdown: string | null): UnreadableHumanReviewLine[] {
  if (agentsMarkdown === null) return [];
  const found: UnreadableHumanReviewLine[] = [];
  for (const { line, text } of sectionLines(agentsMarkdown) ?? []) {
    const read = readLine(text);
    if (read && 'unreadable' in read) found.push({ line, text, reason: read.unreadable });
  }
  return found;
}

/** One login the `## Human review` section names, and where. */
export interface NamedReviewer {
  login: string;
  /** The path its rule covers, as written. */
  path: string;
  /** The line of `AGENTS.md` it is on, counting from 1. */
  line: number;
}

/**
 * Every login the section names, one entry per rule it appears in, with the
 * line it is on. The rules alone say who must approve; a person told that one
 * of those logins cannot approve also needs to know where to change it, and a
 * long `AGENTS.md` is not something to search by eye.
 */
export function humanReviewLogins(agentsMarkdown: string | null): NamedReviewer[] {
  if (agentsMarkdown === null) return [];
  const named: NamedReviewer[] = [];
  for (const { line, text } of sectionLines(agentsMarkdown) ?? []) {
    // The same reading as `parseHumanReviewPaths`, line by line, so a login
    // reported here is exactly one the gate waits on.
    const read = readLine(text);
    if (!read || !('rule' in read)) continue;
    for (const login of read.rule.logins) named.push({ login, path: read.rule.path, line });
  }
  return named;
}

/**
 * Whether a changed file falls under a rule's path.
 *
 * Without a `*`, or with stars only at its end, the rule is a prefix, as it
 * always was: `infra/**` and `infra` both hold all of `infra/`. Not through the
 * glob matcher, which reads a pattern with no `/` as a name at any depth, so
 * `infra` would stop covering `infra/main.tf`. With a `*` anywhere else it is a
 * glob (`policyPathMatches`): `*.tf`, or a `**` segment before `migrations/`.
 * It was a prefix whatever it held, so those matched no file, and the gate
 * released them.
 */
export function pathMatches(rule: string, file: string): boolean {
  const path = rule.replace(/^\.?\//, '');
  let end = path.length;
  while (end > 0 && path[end - 1] === '*') end -= 1;
  const cleaned = path.slice(0, end).replace(/\/+$/, '');
  if (!cleaned.includes('*')) {
    if (cleaned.length === 0) return true;
    return file === cleaned || file.startsWith(`${cleaned}/`);
  }
  // A folder written as a glob holds everything under it.
  return globPathMatches(file, path.endsWith('/') ? `${path}**` : path);
}

/**
 * Everyone whose approval this change needs, in the order the rules name them.
 * Empty means no listed path was touched.
 */
export function humanReviewersFor(changedFiles: string[], rules: HumanReviewRule[]): string[] {
  const needed: string[] = [];
  for (const rule of rules) {
    if (!changedFiles.some((file) => pathMatches(rule.path, file))) continue;
    for (const login of rule.logins) {
      if (!needed.includes(login)) needed.push(login);
    }
  }
  return needed;
}

/** The label that says whose approval a pull request is waiting for. */
export function humanReviewLabelFor(login: string): string {
  return `review:human:${login}`;
}

export const HUMAN_REVIEW_LABEL_PREFIX = 'review:human';

/** A person's review label's colour, which the app gives it when it makes it: `review:human`'s in `config/labels.json`. */
export const HUMAN_REVIEW_LABEL_COLOR = 'd4a017';
