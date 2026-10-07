import type { BotRole } from './types.js';

/**
 * Whether two lists of declared paths can touch the same file: the
 * dispatcher's own overlap rule, which is what keeps two issues off one file.
 * A plan-change request is held by this, so it is held by the rule its lease
 * was granted under.
 */
export { pathsOverlap as declaredPathsOverlap } from './path-overlap.js';

/**
 * The check a ruleset requires before anything merges, and the name the CI
 * workflow's aggregate job must publish under.
 *
 * These have to be the same string, and they were not: an earlier plan named
 * the context `gate / ci`, but GitHub publishes a check run under the **job**
 * name, so a ruleset written from it waited for a check that never appeared,
 * and nothing merged.
 *
 * So the name lives here, the ruleset reads it, and `checks.test.ts` asserts the
 * workflow's aggregate job is called it. Two files cannot drift when one of them
 * fails if they do.
 */
export const REQUIRED_CHECK = 'ci';

/** The status the bridge sets itself, which a ruleset requires alongside it. */
export const REVIEW_GATE_CHECK = 'review-gate';

/**
 * The label that lets GitHub's CI run on a crew pull request. The bridge adds
 * it as the app once the lead has approved and the pull request is at the
 * front of the merge line, and takes it off when work goes back to build, so
 * CI minutes are spent on the head that is about to land and on nothing else.
 */
export const CI_LABEL = 'adlc:ci';

/**
 * The rules that decide whether a pull request may land, as functions rather
 * than shell inside a workflow — so they can be tested, and so the reason a
 * pull request was refused is a sentence rather than a non-zero exit code.
 */

export interface Commit {
  sha: string;
  authorEmail: string;
  authorName: string;
  /** The account GitHub matched the author to; null when it matched none. */
  authorLogin?: string | null;
}

export interface CommitAuthorFinding {
  sha: string;
  /** Who the commit says wrote it: the account GitHub matched, else its address. */
  author: string;
  /** The account that may not author, which the commit was traced to. */
  login: string;
  reason: string;
}

/**
 * Roles whose accounts review or automate, and so never author a commit, with
 * the reason a refused pull request is given.
 */
export const NEVER_AUTHORS: Readonly<Partial<Record<BotRole, string>>> = {
  review_lead: 'a reviewer must never author what it reviews',
  review_second: 'a reviewer must never author what it reviews',
  review_security: 'a reviewer must never author what it reviews',
  intake: 'intake shapes issues; it does not write code',
  automation: 'the automation account sets labels and statuses; it never authors commits',
};

/**
 * The accounts in a crew that may never author a commit.
 *
 * Every bot in one of those roles with a login recorded, connected or not: a
 * login recorded against a reviewer's seat is still that reviewer's account.
 * The configuration names no account, so the crew as the install has it is the
 * only place these can come from.
 */
export function accountsThatNeverAuthor(
  crew: readonly { role: BotRole; githubLogin: string | null }[],
): { login: string; why: string }[] {
  // An account a seat that does write code also uses is not barred: with the
  // builder, intake and automation on one crew account, barring intake's
  // account barred the builder's own commits. Reviewers have an account of
  // their own (the reviewer account), so theirs stays barred.
  const writers = new Set(
    crew
      .filter((bot) => !NEVER_AUTHORS[bot.role])
      .map((bot) => bot.githubLogin?.trim().toLowerCase())
      .filter((login): login is string => Boolean(login)),
  );
  const accounts: { login: string; why: string }[] = [];
  for (const bot of crew) {
    const why = NEVER_AUTHORS[bot.role];
    const login = bot.githubLogin?.trim();
    if (why && login && !writers.has(login.toLowerCase())) accounts.push({ login, why });
  }
  return accounts;
}

/**
 * Commits authored by an account that may never author one, at most one
 * finding per commit.
 *
 * Reviewers hold write access because GitHub only counts approvals from
 * accounts that have it, and the automation account holds it on a personal
 * repository, whose access page has no triage. Neither should ever land code, and the containment for that cannot
 * be the account's own good behaviour: it has to be a check.
 *
 * The account GitHub matched the author to decides first. Only when that names
 * none of these accounts do the commit's own address and name decide, and they
 * are all there is when GitHub could not tie the address to an account.
 */
export function findForbiddenAuthors(
  commits: Commit[],
  forbidden: { login: string; why: string }[],
): CommitAuthorFinding[] {
  const findings: CommitAuthorFinding[] = [];

  for (const commit of commits) {
    const account =
      forbidden.find((candidate) => sameLogin(commit.authorLogin, candidate.login)) ??
      forbidden.find((candidate) => writtenAs(commit, candidate.login));

    if (account) {
      findings.push({
        sha: commit.sha,
        author: commit.authorLogin ?? commit.authorEmail,
        login: account.login,
        reason: account.why,
      });
    }
  }

  return findings;
}

/** Whether a commit's address or name is an account's. */
function writtenAs(commit: Commit, account: string): boolean {
  const login = account.toLowerCase();
  const email = commit.authorEmail.toLowerCase();
  return (
    email.startsWith(`${login}@`) ||
    // GitHub's no-reply addresses are `id+login@users.noreply.github.com`.
    email.includes(`+${login}@users.noreply.github.com`) ||
    email === `${login}@users.noreply.github.com` ||
    // A bot's session commits under its own name, which is its account's handle.
    commit.authorName.trim().toLowerCase() === login
  );
}

/**
 * The issues a pull request body closes with GitHub's keywords, in the order
 * they appear, read as GitHub reads them closely enough to stand in when
 * GitHub cannot be asked: close, closes, closed, fix, fixes, fixed, resolve,
 * resolves and resolved, with or without a colon.
 *
 * A keyword in code, a quote or an HTML comment is not one: a body that
 * quotes an old "Fixes #5" or shows the template's `Closes #N` closes nothing.
 * Nor is one after a negation — "no longer fixes #5", "doesn't close #6" —
 * which a bare match read as closing.
 *
 * The one reading everywhere OpenADLC asks: the scope check knew only
 * "closes", "fixes" and "resolves", so "Fixed #12" or "Closes: #12" closed the
 * issue on GitHub while the check saw none and skipped, and a revert left
 * that issue closed.
 */
export function closingKeywords(body: string): number[] {
  const prose = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^ {0,3}>.*$/gm, ' ');
  const numbers: number[] = [];
  // Spaces, or a colon with spaces after it: `\s*:?\s+` put two runs of
  // spaces side by side, and a body of "closes" and many spaces backtracked
  // for seconds.
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s+|\s*:\s+)#(\d+)\b/gi;
  for (let match = pattern.exec(prose); match; match = pattern.exec(prose)) {
    const before = prose.slice(Math.max(0, match.index - 24), match.index);
    if (/\b(?:not|never|no longer|n[\u2019']t)\s+$|n[\u2019']t\s+$/i.test(before)) continue;
    const number = Number(match[1]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

/** Issue numbers a pull request says it closes, in the order they appear: `closingKeywords`. */
export const closedIssues = closingKeywords;

/**
 * Paths a task may always write, whatever its lease declared: its own evidence,
 * what it learned, the notes the next agent reads, and the documentation a
 * change to behaviour has to update. The plan allows these explicitly, and a
 * check that refused them would teach bots not to write tests or leave the docs
 * stale. Everything else outside a lease is asked for, not taken: see
 * `addExpectedPaths` and the plan-change request.
 *
 * A unit test beside its module is not in this list. `tests/` is unconditional
 * on purpose; `checks.test.ts` is in scope only when it sits next to a path the
 * change declared. See `filesOutsideScope`.
 */
export const ALWAYS_IN_SCOPE = ['tests/', 'docs/', 'AGENTS.md'];

/**
 * Drop the `./` and the trailing globs a task form writes onto a path. The
 * stars are cut by scanning back, not with `/\*+$/`: that is quadratic on a
 * long run of stars that does not end the path, and one such declared path
 * took the scope check seconds.
 */
function normaliseDeclared(declared: string): string {
  const path = declared.trim().replace(/^\.\//, '');
  let end = path.length;
  while (end > 0 && path[end - 1] === '*') end -= 1;
  return path.slice(0, end);
}

export function matchesDeclaredPath(file: string, declared: string): boolean {
  // Declared paths are written as globs in the task form: `apps/bridge/src/**`.
  // The match is that path, or a file inside it. A longer name that only starts
  // the same way is a different file: `checks.ts` does not cover `checks.ts.test.ts`.
  const cleaned = normaliseDeclared(declared);
  if (cleaned.length === 0) return false;
  if (file === cleaned) return true;
  // A star on a name, not a directory — `scheduler*`, `0012_*` — is a glob over
  // names that start that way, so it stays a plain prefix.
  if (declared.trim().endsWith('*') && !cleaned.endsWith('/')) return file.startsWith(cleaned);
  const prefix = cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
  return file.startsWith(prefix);
}

/**
 * `dir/name.test.ts` sits beside `dir/name.ts`, and the same for `.tsx` and
 * `.mjs`. The suffix has to be the whole filename, so `name.test.ts/hidden.ts`
 * or `name.test.ts.txt` is not a unit test.
 */
const COLOCATED_UNIT_TEST = /^(.*)\.test\.(tsx|ts|mjs)$/;

function moduleBeside(file: string): string | null {
  const slash = file.lastIndexOf('/');
  const base = slash >= 0 ? file.slice(slash + 1) : file;
  const match = COLOCATED_UNIT_TEST.exec(base);
  const stem = match?.[1];
  const ext = match?.[2];
  if (!stem || !ext) return null;
  const dir = slash >= 0 ? file.slice(0, slash + 1) : '';
  return `${dir}${stem}.${ext}`;
}

/**
 * A colocated unit test is in scope when the module it sits beside is exactly
 * a path the change declared. Not otherwise: `tests/` is the unconditional
 * exemption, and a test next to code the lease never named is still outside.
 * A test named for a behaviour rather than its module (`webhook-trust.test.ts`)
 * is not beside anything, and still has to be declared.
 */
function isColocatedTestBesideDeclared(file: string, declaredPaths: string[]): boolean {
  const modulePath = moduleBeside(file);
  if (!modulePath) return false;
  return declaredPaths.some((declared) => {
    const cleaned = normaliseDeclared(declared);
    return cleaned.length > 0 && modulePath === cleaned;
  });
}

export interface ScopeVerdict {
  outside: string[];
  /** True when the diff stayed inside what the issues declared. */
  inScope: boolean;
}

/**
 * Which changed files nothing declared.
 *
 * Leaving the declared scope is not forbidden — some changes genuinely are
 * cross-cutting — but it has to be deliberate and visible, which is what the
 * `scope:cross-cutting` label is for. The check exists so that widening a
 * change is a decision somebody made rather than something that happened.
 */
export function filesOutsideScope(changedFiles: string[], declaredPaths: string[]): ScopeVerdict {
  const declared = [...declaredPaths, ...ALWAYS_IN_SCOPE].filter((path) => path.trim().length > 0);

  const outside = changedFiles.filter(
    (file) =>
      !declared.some((path) => matchesDeclaredPath(file, path)) &&
      !isColocatedTestBesideDeclared(file, declaredPaths),
  );

  return { outside, inScope: outside.length === 0 };
}

/** The label that says a pull request leaves its declared scope on purpose. */
export const CROSS_CUTTING_LABEL = 'scope:cross-cutting';

/** What the scope check reads of an issue: its body, and whether it is a pull request. */
export interface ScopeIssue {
  body: string | null;
  pull_request?: unknown;
}

export interface ScopeCheckInput {
  /** The pull request's body, which names the issues it closes. */
  body: string;
  /** The pull request's own number: never the issue that declares its scope. */
  prNumber: number | null;
  /** Who opened it, whose own `scope:cross-cutting` waives nothing. */
  prAuthor: string | null;
  labels: readonly string[];
  /** The files the diff changes. */
  files: readonly string[];
  /** Reads an issue, and throws, naming it and GitHub's status, when it cannot. */
  readIssue: (number: number) => Promise<ScopeIssue>;
  /** Who last put `scope:cross-cutting` on, or null when that cannot be read. Asked only when it would decide. */
  crossCuttingBy: () => Promise<string | null>;
}

/**
 * The scope check's verdict on a pull request, which `.github/scripts/scope-check.mjs`
 * prints and exits with.
 *
 * It fails closed. A failed read of an issue (a rate limit, a 5xx, a 404)
 * counted as "declares nothing" and passed; a number in the body that is a
 * pull request, the pull request's own included, let a body declare its own
 * scope; and `scope:cross-cutting` waived the check whoever put it on, the
 * builder whose work it bounds included. A pull request that closes no issue
 * still passes here: holding a crew one is the bridge's merge line's job.
 */
export async function scopeCheck(input: ScopeCheckInput): Promise<{ exit: 0 | 1; message: string }> {
  const said: string[] = [];
  const done = (exit: 0 | 1, message: string) => ({ exit, message: [...said, `scope-check: ${message}`].join('\n') });

  const issues: number[] = [];
  for (const number of closingKeywords(input.body)) {
    if (number === input.prNumber) {
      said.push(`scope-check: #${number} is this pull request, which declares nothing for itself; skipped`);
      continue;
    }
    issues.push(number);
  }
  if (issues.length === 0) return done(0, 'this pull request closes no issue, so nothing declared a scope; skipping');

  const declared: string[] = [];
  const declaring: number[] = [];
  for (const number of issues) {
    let issue: ScopeIssue;
    try {
      issue = await input.readIssue(number);
    } catch (error) {
      return done(1, `could not read #${number}, so what it declares is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (issue.pull_request) {
      said.push(`scope-check: #${number} is a pull request, not an issue, and declares nothing here; skipped`);
      continue;
    }
    declaring.push(number);
    declared.push(...declaredPathsFrom(issue.body ?? ''));
  }
  const named = declaring.length > 0 ? `#${declaring.join(', #')}` : 'no issue';
  if (declared.length === 0) return done(0, `${named} declared no paths; skipping`);

  const verdict = filesOutsideScope([...input.files], declared);
  if (verdict.inScope) return done(0, `${input.files.length} file(s) changed, all within what ${named} declared`);

  const listed = verdict.outside.slice(0, 20).join('\n  ');
  const more = verdict.outside.length > 20 ? `\n  ...and ${verdict.outside.length - 20} more` : '';
  const outside = `${verdict.outside.length} file(s) are outside what ${named} declared:\n  ${listed}${more}`;

  if (input.labels.includes(CROSS_CUTTING_LABEL)) {
    const by = await input.crossCuttingBy().catch(() => null);
    if (by && !sameLogin(by, input.prAuthor)) {
      return done(0, `${outside}\n\nand ${by} said the widening is deliberate with ${CROSS_CUTTING_LABEL}`);
    }
    return done(
      1,
      `${outside}\n\n${CROSS_CUTTING_LABEL} counts only when someone other than the pull request's author put it on` +
        `${by ? `, and ${by} did` : ', and who did could not be read'}. Declare the files on the issue, or ask a person or the lead to accept the widening.`,
    );
  }

  return done(1, `${outside}\n\nEither declare them on the issue, or have someone other than the author label this pull request ${CROSS_CUTTING_LABEL} to say the widening is deliberate.`);
}

const MAX_DECLARED_PATH = 200;

/** The Expected paths field of the task form, as the dispatcher reads it. */
export function declaredPathsFrom(issueBody: string): string[] {
  return expectedPathLines(issueBody).flatMap((line) =>
    pathsOf(line)
      .filter((path) => path.readable)
      .map((path) => path.path)
      // The limit a plan change's paths are held to (`normalisePlanPaths`): a
      // path longer than 200 characters is not one anybody's change touches,
      // and every comparison pays for its length. A path with a space in it is
      // written in backticks, and kept whole.
      .filter((path) => path.length <= MAX_DECLARED_PATH),
  );
}

/**
 * The lines of Expected paths that name something that is not a path, as
 * written: "packages/db/migrations/0037_x.sql and its test" names a file and
 * then a phrase. What is not a path is not declared, so the lease and the
 * overlap check do not compare a sentence against files; readiness lists these
 * lines, and the bridge sends the issue back to the stage that wrote them.
 */
export function unreadablePathLines(issueBody: string): string[] {
  return expectedPathLines(issueBody).filter((line) => pathsOf(line).some((path) => !path.readable));
}

/** The lines of an issue's Expected paths, each without its list marker. */
function expectedPathLines(issueBody: string): string[] {
  // Any heading level: the issue form writes `###`, and a bot drafting the
  // body writes `##` as often as not — which read as no paths at all, and the
  // dispatcher would not lease the issue. A body edited in GitHub's web editor
  // can come with CRLF line endings, which the heading's `\n` did not match:
  // the issue read as declaring nothing.
  const text = issueBody.replace(/\r\n?/g, '\n');
  const match = /(?:^|\n)#{1,6}\s*Expected paths[ \t]*\n+([\s\S]*?)(?=\n#{1,6}\s|$(?![\s\S]))/i.exec(text);
  if (!match?.[1]) return [];
  return match[1]
    .split('\n')
    // Only the list marker and the space after it: a path may itself start
    // with `-` or `*`, and `**/fixtures/**`, stripped of every leading star,
    // was read back as `/fixtures/**`, which is not what a person approved.
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0 && line !== '_No response_');
}

const EXPECTED_PATHS_SECTION = /((?:^|\n)#{1,6}\s*Expected paths[ \t]*\n+)([\s\S]*?)(?=\n#{1,6}\s|$(?![\s\S]))/i;

/**
 * The issue body with paths added to its Expected paths, one line each, after
 * the last of the ones already there. A path something declared already covers
 * is not written again, so asking twice, or for a file inside a directory that
 * is declared, changes nothing. A body with no such section gets one at its end.
 *
 * People read this list on the issue, and OpenADLC's own CI scope check reads
 * it from GitHub, so a grant only in OpenADLC's database would leave the pull
 * request outside what the issue says. The merge line holds a crew pull
 * request to the lease, which the same approval widens.
 */
export function addExpectedPaths(issueBody: string, paths: readonly string[]): string {
  const have = declaredPathsFrom(issueBody);
  const added: string[] = [];
  for (const path of paths) {
    const covered = [...have, ...added].some((declared) => matchesDeclaredPath(path, declared));
    if (!covered) added.push(path);
  }
  if (added.length === 0) return issueBody;

  // Found and written in the body with LF endings, as `declaredPathsFrom`
  // reads it: a CRLF body's section was not found, a second one was appended,
  // and only the new paths were read from then on. The signature hashes a
  // normalised body, so the endings changing breaks no stamp.
  const text = issueBody.replace(/\r\n?/g, '\n');
  const lines = added.map((path) => `- ${path}`).join('\n');
  const match = EXPECTED_PATHS_SECTION.exec(text);
  if (!match) return `${text.replace(/\s+$/, '')}\n\n## Expected paths\n\n${lines}\n`;

  const contentAt = match.index + match[1]!.length;
  const content = match[2]!;
  const kept = content.replace(/\s+$/, '');
  const before = text.slice(0, contentAt) + kept;
  return `${before}${kept.length > 0 ? '\n' : ''}${lines}${content.slice(kept.length)}${text.slice(contentAt + content.length)}`;
}

/**
 * The paths a line of Expected paths names, without what was said about them:
 * "`greet.mjs` — modify the greet function" is `greet.mjs`. The lease and the
 * overlap check compare paths, and a sentence matched no file anybody changed.
 *
 * Only the first path of a line was read, so "`a.ts`, `a.test.ts`" leased
 * a.ts alone: the builder had to ask a person for its own test file, and a
 * second issue on that file could be leased alongside. Every backticked span
 * is a path, whole, so one with a space in it can be written; a line with none
 * is cut at its description and split on commas and "and". A brace group is
 * expanded, one level: `src/{gates,send-back}.ts` is two files, and the
 * overlap check reads braces as letters.
 *
 * What is left with a space or a brace in it is not a path, and says so.
 */
function pathsOf(line: string): { path: string; readable: boolean }[] {
  const quoted = [...line.matchAll(/`([^`]+)`/g)].map((span) => span[1]!.trim()).filter(Boolean);
  const written =
    quoted.length > 0
      ? quoted.map((path) => ({ path, quoted: true }))
      : // `(?<!\s)` starts each match at the front of a run of spaces: without
        // it a line of spaces was tried from every one of them, about 22 s
        // for 65 KB, as the comma split was.
        commaParts(line.split(/(?<!\s)\s+[—–-]\s+|(?<!\s)\s+\(|:\s/)[0]!)
          .flatMap((part) => part.trim().replace(/^and\s+/, '').split(/(?<!\s)\s+and\s+/))
          .map((path) => ({ path: path.trim(), quoted: false }))
          .filter((entry) => entry.path.length > 0);
  return written.flatMap(({ path, quoted: inBackticks }) =>
    bracesExpanded(path).map((one) => ({ path: one, readable: !/[{}]/.test(one) && (inBackticks || !/\s/.test(one)) })),
  );
}

/**
 * `line` split on its commas, but not on one inside a brace group: one whose
 * next brace is a `}`. It was `/,(?![^{]*\})/`, which scanned ahead from every
 * comma, and a 65 KB line of commas took six seconds. Read from the end, each
 * comma knows the next brace without looking for it.
 */
function commaParts(line: string): string[] {
  const parts: string[] = [];
  let end = line.length;
  let inGroup = false;
  for (let at = line.length - 1; at >= 0; at--) {
    const char = line[at];
    if (char === '}') inGroup = true;
    else if (char === '{') inGroup = false;
    else if (char === ',' && !inGroup) {
      parts.push(line.slice(at + 1, end));
      end = at;
    }
  }
  parts.push(line.slice(0, end));
  return parts.reverse();
}

/**
 * How many paths one line may name. Each brace group multiplies the last, so
 * twenty `{a,b}` groups are a million strings and twenty-six abort the
 * process. A line that would name more than this is not a list of files.
 */
const MAX_BRACE_PATHS = 16;

/** `a/{b,c}.ts` as `a/b.ts` and `a/c.ts`, each group once; a nested, unclosed, or unbounded one is left as written. */
function bracesExpanded(path: string): string[] {
  if (path.length > MAX_DECLARED_PATH) return [path];
  return expandBraces(path, MAX_BRACE_PATHS) ?? [path];
}

/** The expansion, or null when it would name more paths than `budget`. */
function expandBraces(path: string, budget: number): string[] | null {
  if (budget < 1) return null;
  const group = /\{([^{}]*,[^{}]*)\}/.exec(path);
  if (!group) return [path];
  const before = path.slice(0, group.index);
  const after = path.slice(group.index + group[0].length);
  if (/[{}]/.test(before)) return [path];
  const choices = group[1]!.split(',');
  if (choices.length > budget) return null;
  const out: string[] = [];
  for (const choice of choices) {
    const next = expandBraces(`${before}${choice.trim()}${after}`, budget - out.length);
    if (!next || out.length + next.length > budget) return null;
    out.push(...next);
  }
  return out;
}

/**
 * Whether two GitHub logins name the same account.
 *
 * GitHub treats a login as case-insensitive — you sign in as `acme-crew` or
 * `Acme-Crew` alike — but its API answers with the canonical casing the account
 * was registered under. So a stored `acme-crew` and a webhook saying `Acme-Crew`
 * are the same account, and `===` says they are not.
 *
 * That mattered in two places worth naming. A bot dismissing a review is
 * supposed to raise an incident and hold `review-gate`; unrecognised, it raised
 * nothing. And a bot's own comment is supposed to be ignored; unrecognised, the
 * platform answered its own comment as though a person had written it.
 *
 * It was also self-inflicting: `fleetadlc up` seeds the crew from the configuration
 * on every start, so the login onboarding had corrected to the real casing was
 * overwritten again at the next restart.
 */
export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** An issue's text and how it came to read so, as CI's scope check reads it from GitHub. */
export interface IssueHistory {
  number: number;
  /** The body as it reads now. */
  body: string;
  author: string | null;
  /** GitHub's `authorAssociation`: `OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`, … */
  authorAssociation: string | null;
  /** Who last edited the body, and when; null for a body never edited. */
  editor: string | null;
  lastEditedAt: string | null;
  /** Each revision GitHub keeps (`userContentEdits`), in any order; `body` null when it cannot be read. */
  revisions: readonly { editedAt: string; editor: string | null; body: string | null; deleted: boolean }[];
  /** Who put a label on it, and when (`LabeledEvent`), in any order. */
  labelled: readonly { at: string; actor: string | null }[];
}

/** Associations GitHub gives only to people with access to the repository. */
const WITH_ACCESS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/**
 * The body CI's scope check reads an issue's Expected paths from: the issue
 * as it was when someone with access accepted it, for an author OpenADLC
 * does not act for.
 *
 * A stranger's issue is taken up when somebody else labels it, and the bridge
 * keeps its text from then. The scope check read GitHub's live body, so an
 * author who widened Expected paths to `.github/workflows/**` afterwards
 * widened what CI let a pull request change. The workflow's token cannot ask
 * GitHub who has access, so this decides from the author's association, the
 * last editor, and when somebody other than the author first labelled it:
 * an edit by the author after that is not read, and the newest revision from
 * before it, or one made by somebody other than the author, is. When none can
 * be read, the check fails with what to do rather than skipping.
 *
 * Known limit: an author with access GitHub's association does not show (a
 * private organisation member) looks like a stranger here, and only for edits
 * made after somebody else labelled their issue.
 */
export function acceptedIssueBody(issue: IssueHistory): { body: string } | { error: string } {
  const current = { body: issue.body };
  if (WITH_ACCESS.includes((issue.authorAssociation ?? '').toUpperCase())) return current;
  if (!issue.lastEditedAt || !issue.author) return current;
  const time = (at: string) => Date.parse(at);
  const accepted = [...issue.labelled]
    .filter((label) => label.actor && !sameLogin(label.actor, issue.author))
    .sort((a, b) => time(a.at) - time(b.at))[0];
  if (!accepted) return current;
  if (issue.editor && !sameLogin(issue.editor, issue.author)) return current;
  if (time(issue.lastEditedAt) <= time(accepted.at)) return current;

  const revision = [...issue.revisions]
    .filter((one) => time(one.editedAt) <= time(accepted.at) || Boolean(one.editor && !sameLogin(one.editor, issue.author)))
    .sort((a, b) => time(b.editedAt) - time(a.editedAt))[0];
  if (!revision || revision.deleted || revision.body === null) {
    return {
      error:
        `#${issue.number} was edited by its author, ${issue.author}, after ${accepted.actor} took it up, and the text it had then cannot be read. ` +
        `Its Expected paths are not read from the edit. A person with access edits #${issue.number} to say what it declares, then runs this check again.`,
    };
  }
  return { body: revision.body };
}
