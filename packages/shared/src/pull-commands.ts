import { parse as parseYaml } from 'yaml';

/**
 * What a repository's own workflows answer on a pull request, and what they
 * post back: the `pullRequests:` section of `.github/openadlc.yml`.
 *
 * www's page sign-off waited on a person commenting `/approve-pages` on
 * GitHub, after `/preview` and two bot comments read there, while Needs you
 * offered only "Merge it on GitHub", which skipped the sign-off (#207). A
 * repository names those comments here, and the console offers them as
 * buttons beside what the workflows produced.
 *
 * Read on its own and leniently, never through `deliveryRulesSchema`: an
 * entry that does not parse is dropped and its error said, and the section
 * can never change how a repository ships.
 */

export interface PullCommand {
  /** `[a-z0-9-]`, unique: what the console presses it by. */
  name: string;
  /** The comment posted, exactly: one line, starting with `/`. */
  comment: string;
  label: string;
  /** `anyone`: posted as the app. `reviewer`: posted as one of `reviewers`, from their own account. */
  by: 'anyone' | 'reviewer';
  /** For `by: reviewer`, the GitHub logins whose own comment the workflow counts. */
  reviewers: string[];
  /** The output that answers it, by name. */
  answer: string | null;
  /** A check run's name or a commit status's context the workflow turns green. */
  unblocks: string | null;
}

export interface PullOutput {
  name: string;
  kind: 'link' | 'images';
  /** The authors read; a comment from anyone else is not. */
  from: string[];
  /** For a link: a template with `{url}`, matched line by line. */
  match: string | null;
  /** For images: the text a comment carries. */
  marker: string | null;
  /** Where the comment names its commit, as a template with `{sha}`. */
  head: string | null;
}

export interface PullRequestRules {
  commands: PullCommand[];
  outputs: PullOutput[];
  /** Why an entry was dropped, one sentence each. */
  errors: string[];
}

export const PULL_RULES_LIMIT = 10;
export const DEFAULT_OUTPUT_AUTHORS: readonly string[] = ['github-actions[bot]'];

const NAME = /^[a-z0-9-]{1,40}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const COMMENT_MAX = 100;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function listOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : [value];
  const out = list.map((one) => text(one));
  return out.every((one): one is string => one !== null) ? out : null;
}

/** The commands and outputs a rules file declares; an absent file or section gives none. */
export function pullRequestRules(source: string | null | undefined): PullRequestRules {
  const rules: PullRequestRules = { commands: [], outputs: [], errors: [] };
  if (!source) return rules;
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch {
    // The delivery rules say a file that does not parse; this section says
    // nothing more, and offers nothing.
    return rules;
  }
  const section = (raw as Record<string, unknown> | null)?.pullRequests;
  if (section === undefined || section === null) return rules;
  if (typeof section !== 'object' || Array.isArray(section)) {
    rules.errors.push('pullRequests is not a section with commands and outputs.');
    return rules;
  }
  const { commands, outputs } = section as Record<string, unknown>;

  const entries = (value: unknown, what: string): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      rules.errors.push(`pullRequests.${what} is not a list.`);
      return [];
    }
    if (value.length > PULL_RULES_LIMIT) {
      rules.errors.push(`pullRequests.${what} lists ${value.length}; only the first ${PULL_RULES_LIMIT} are read.`);
    }
    return value.slice(0, PULL_RULES_LIMIT);
  };

  for (const [index, entry] of entries(commands, 'commands').entries()) {
    const read = commandOf(entry);
    const where = `pullRequests.commands[${index}]`;
    if (typeof read === 'string') rules.errors.push(`${where}: ${read}`);
    else if (rules.commands.some((one) => one.name === read.name)) rules.errors.push(`${where}: the name ${read.name} is used twice.`);
    else rules.commands.push(read);
  }
  for (const [index, entry] of entries(outputs, 'outputs').entries()) {
    const read = outputOf(entry);
    const where = `pullRequests.outputs[${index}]`;
    if (typeof read === 'string') rules.errors.push(`${where}: ${read}`);
    else if (rules.outputs.some((one) => one.name === read.name)) rules.errors.push(`${where}: the name ${read.name} is used twice.`);
    else rules.outputs.push(read);
  }
  return rules;
}

/** One command, or why it is dropped. */
function commandOf(entry: unknown): PullCommand | string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not a command.';
  const one = entry as Record<string, unknown>;
  const name = text(one.name);
  if (!name || !NAME.test(name)) return 'needs a name of lower-case letters, digits and dashes.';
  const comment = typeof one.comment === 'string' ? one.comment.trim() : '';
  if (!comment.startsWith('/') || /[\r\n]/.test(comment) || comment.length > COMMENT_MAX) {
    return `${name}: its comment is one line starting with /, at most ${COMMENT_MAX} characters.`;
  }
  const by = one.by ?? 'anyone';
  if (by !== 'anyone' && by !== 'reviewer') return `${name}: by is anyone or reviewer.`;
  const reviewers = listOf(one.reviewers) ?? [];
  if (reviewers.some((login) => !LOGIN.test(login))) return `${name}: reviewers are GitHub logins.`;
  if (by === 'reviewer' && reviewers.length === 0) return `${name}: by: reviewer needs reviewers.`;
  return {
    name,
    comment,
    label: text(one.label) ?? comment,
    by,
    reviewers: by === 'reviewer' ? reviewers : [],
    answer: text(one.answer),
    unblocks: text(one.unblocks),
  };
}

/** One output, or why it is dropped. */
function outputOf(entry: unknown): PullOutput | string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not an output.';
  const one = entry as Record<string, unknown>;
  const name = text(one.name);
  if (!name || !NAME.test(name)) return 'needs a name of lower-case letters, digits and dashes.';
  const kind = one.kind;
  if (kind !== 'link' && kind !== 'images') return `${name}: kind is link or images.`;
  const from = listOf(one.from) ?? [...DEFAULT_OUTPUT_AUTHORS];
  if (from.length === 0) return `${name}: from names no author.`;
  const match = text(one.match);
  const marker = text(one.marker);
  const head = text(one.head);
  for (const [field, template] of [['match', match], ['head', head]] as const) {
    if (template !== null && typeof compileTemplate(template) === 'string') return `${name}: ${field} ${compileTemplate(template) as string}`;
  }
  if (kind === 'link' && (!match || !match.includes('{url}'))) return `${name}: a link needs match with {url}.`;
  if (kind === 'images' && !marker) return `${name}: images need a marker.`;
  if (head !== null && !head.includes('{sha}')) return `${name}: head needs {sha}.`;
  return { name, kind, from, match, marker, head };
}

const PLACEHOLDERS: Record<string, string> = {
  pr: '(\\d+)',
  sha: '([0-9a-fA-F]{7,40})',
  url: '(https://[^\\s<>()"\']+)',
};

export interface CompiledTemplate {
  pattern: RegExp;
  /** The placeholders in the order they appear. */
  names: ('pr' | 'sha' | 'url')[];
}

/**
 * A template as a pattern the bridge writes itself: `{pr}`, `{sha}` and
 * `{url}` are the only placeholders, and every other character is literal. A
 * repository's file never hands the bridge a regular expression to run.
 * A string is why the template is refused.
 */
export function compileTemplate(template: string): CompiledTemplate | string {
  if (/[\r\n]/.test(template)) return 'is one line.';
  if (template.length > 200) return 'is at most 200 characters.';
  const names: CompiledTemplate['names'] = [];
  let pattern = '';
  let last = 0;
  for (const found of template.matchAll(/\{(\w+)\}/g)) {
    const name = found[1]!;
    if (!(name in PLACEHOLDERS)) return `has {${name}}; only {pr}, {sha} and {url} are placeholders.`;
    if (names.includes(name as 'pr')) return `has {${name}} twice.`;
    names.push(name as 'pr');
    pattern += escape(template.slice(last, found.index)) + PLACEHOLDERS[name];
    last = found.index! + found[0].length;
  }
  pattern += escape(template.slice(last));
  return { pattern: new RegExp(pattern), names };
}

function escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What a template found on one line of a comment. */
function matchLines(template: string, body: string): Partial<Record<'pr' | 'sha' | 'url', string>> | null {
  const compiled = compileTemplate(template);
  if (typeof compiled === 'string') return null;
  for (const line of body.split(/\r?\n/)) {
    const found = compiled.pattern.exec(line);
    if (!found) continue;
    const out: Partial<Record<'pr' | 'sha' | 'url', string>> = {};
    compiled.names.forEach((name, index) => {
      out[name] = found[index + 1]!;
    });
    return out;
  }
  return null;
}

export interface FoundOutput {
  url?: string;
  sha?: string;
}

/**
 * What one comment says for an output on pull request `pr`, or null when it
 * is not one: a link line for a `link` output, the marker for `images`. A
 * `{pr}` that names another pull request is not this one's.
 */
export function readOutput(output: PullOutput, comment: { user: string; body: string }, pr: number): FoundOutput | null {
  if (!output.from.some((login) => login.toLowerCase() === comment.user.toLowerCase())) return null;
  if (output.kind === 'link') {
    const found = output.match ? matchLines(output.match, comment.body) : null;
    if (!found?.url) return null;
    if (found.pr !== undefined && Number(found.pr) !== pr) return null;
    return { url: found.url, ...(found.sha ? { sha: found.sha.toLowerCase() } : {}) };
  }
  if (!output.marker || !comment.body.includes(output.marker)) return null;
  const head = output.head ? matchLines(output.head, comment.body) : null;
  return head?.sha ? { sha: head.sha.toLowerCase() } : {};
}

/**
 * Whether what a comment found is for the pull request's head: a `{sha}` it
 * names is a prefix of the head, and without one the comment was posted or
 * edited at or after the head's commit.
 */
export function outputIsCurrent(found: FoundOutput, head: string, headCommittedAt: string | null, commentUpdatedAt: string): boolean {
  if (found.sha) return head.toLowerCase().startsWith(found.sha.toLowerCase());
  if (!headCommittedAt) return false;
  return Date.parse(commentUpdatedAt) >= Date.parse(headCommittedAt);
}

/** A check's state at the head that is not in the way. */
const GREEN = new Set(['success', 'neutral', 'skipped']);

export function checkIsGreen(state: string | null | undefined): boolean {
  return GREEN.has((state ?? '').toLowerCase());
}

export type PullAction = { kind: 'command'; name: string } | { kind: 'merge' };

/**
 * The order a pull request's buttons are shown in, decided here alone:
 * commands whose `unblocks` check is not green at the head first, then the
 * rest as declared, and for a held merge "Merge it on GitHub" last. A merge
 * by hand skips the sign-off the red check waits for, so it never comes first.
 */
export function orderPullActions(input: {
  commands: readonly Pick<PullCommand, 'name' | 'unblocks'>[];
  /** Each check's state at the head, by check run name or status context. */
  checks: Readonly<Record<string, string | null>>;
  held: boolean;
}): PullAction[] {
  const blocking = input.commands.filter((one) => one.unblocks !== null && !checkIsGreen(input.checks[one.unblocks]));
  const rest = input.commands.filter((one) => !blocking.includes(one));
  const actions: PullAction[] = [...blocking, ...rest].map((one) => ({ kind: 'command', name: one.name }));
  if (input.held) actions.push({ kind: 'merge' });
  return actions;
}
