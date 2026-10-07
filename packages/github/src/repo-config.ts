import { humanReviewLogins } from '@fleetadlc/shared';
import { GitHubApiError } from './client.js';
import type { RuleApi } from './rules.js';
import { CI_WORKFLOW, TEMPLATE_REVIEWER_PLACEHOLDER } from './templates.js';

/**
 * The files on a managed repository's default branch that steer the crew's
 * work: what the bridge reads to decide who reviews, what GitHub reads to
 * decide whose review counts, and what OpenADLC's templates install. A mistake
 * in one of them stops work without saying so, which is why OpenADLC reads them
 * itself rather than waiting for a pull request that never passes.
 *
 * CODEOWNERS is read where GitHub looks for it, all three places: GitHub uses
 * the first it finds, but a stale copy in another is still a name somebody
 * will copy from.
 */
export const CONFIG_FILES = [
  'AGENTS.md',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.github/pull_request_template.md',
  CI_WORKFLOW,
  'Makefile',
] as const;

/** Whether a push that changed these paths changed what the configuration check reads. */
export function touchesConfig(paths: readonly string[]): boolean {
  return paths.some((path) => (CONFIG_FILES as readonly string[]).includes(path));
}

/** The files as they are on a branch: each one's text, those that are not there, and those GitHub would not give. */
export interface ConfigFiles {
  text: Map<string, string>;
  absent: string[];
  unreadable: string[];
}

/**
 * Reads every configuration file at `ref`. A file that is not there is a
 * different answer from one GitHub would not give: the first names nobody,
 * the second is not known to name nobody, and a check reading it as absent
 * would clear a card it cannot see.
 */
export async function readConfigFiles(api: RuleApi, repo: string, ref: string): Promise<ConfigFiles> {
  const files: ConfigFiles = { text: new Map(), absent: [], unreadable: [] };
  for (const path of CONFIG_FILES) {
    try {
      const file = await api.request<{ content?: string; encoding?: string }>(
        'GET',
        `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      );
      if (typeof file.content !== 'string') {
        files.unreadable.push(path);
        continue;
      }
      files.text.set(path, Buffer.from(file.content, (file.encoding as BufferEncoding) ?? 'base64').toString('utf8'));
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) files.absent.push(path);
      else files.unreadable.push(path);
    }
  }
  return files;
}

/**
 * How a file names a login, which decides what is asked of it: a reviewer
 * must be able to review in the repository, a mention only has to exist.
 */
export type NamedAs = 'human-review' | 'code-owner' | 'mention';

export interface NamedLogin {
  login: string;
  file: string;
  /** Counting from 1. */
  line: number;
  as: NamedAs;
}

/**
 * A login as GitHub allows one, after an `@` that starts a word. The `@` must
 * not follow a word character, so an email or `actions/checkout@v4` is not a
 * mention; and the login must not be followed by `/`, so an npm scope or an
 * organization's team (`@exampleco/reviewers`) is not one either.
 */
const MENTION = /(^|[^\w@`/.-])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![\w/-])/g;

function mentionsIn(text: string): string[] {
  return [...text.matchAll(MENTION)].map((match) => match[2] as string);
}

const isCodeOwners = (file: string): boolean => file === 'CODEOWNERS' || file.endsWith('/CODEOWNERS');
const isMarkdown = (file: string): boolean => file.endsWith('.md');

/**
 * Every login a configuration file names, with where.
 *
 * - CODEOWNERS: each owner on a rule line. A team (`@org/team`) and an email
 *   are owners GitHub accepts, and are not logins.
 * - `AGENTS.md`'s `## Human review`: the people the gate waits on, read as the
 *   bridge reads them (`humanReviewLogins`).
 * - Any other markdown: an `@login` in its prose. Code blocks and inline code
 *   are skipped, since a decorator or a package is not a person.
 * - A workflow or a Makefile: an `@login` in a `#` comment only. Their code is
 *   full of `@`: `@echo` in a recipe, `uses: actions/checkout@v4`, `"$@"`.
 */
export function loginsNamedIn(file: string, text: string): NamedLogin[] {
  const lines = text.split('\n');
  const named: NamedLogin[] = [];

  if (isCodeOwners(file)) {
    lines.forEach((raw, index) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      for (const owner of line.split(/\s+/).slice(1)) {
        const login = /^@([A-Za-z0-9-]+)$/.exec(owner)?.[1];
        if (login) named.push({ login, file, line: index + 1, as: 'code-owner' });
      }
    });
    return named;
  }

  if (isMarkdown(file)) {
    const reviewers = file === 'AGENTS.md' ? humanReviewLogins(text) : [];
    for (const reviewer of reviewers) named.push({ login: reviewer.login, file, line: reviewer.line, as: 'human-review' });
    const ruleLines = new Set(reviewers.map((reviewer) => reviewer.line));
    // A comment is not prose, and a template's comment often runs over several
    // lines (`<!-- Ask @someone ... -->`): it is blanked out whole, keeping its
    // line breaks so every line after it keeps its number.
    const uncommented = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ' ')).split('\n');
    let fenced = false;
    uncommented.forEach((raw, index) => {
      if (/^\s{0,3}(```|~~~)/.test(raw)) {
        fenced = !fenced;
        return;
      }
      if (fenced || ruleLines.has(index + 1)) return;
      const prose = raw.replace(/`[^`]*`/g, ' ');
      for (const login of mentionsIn(prose)) named.push({ login, file, line: index + 1, as: 'mention' });
    });
    return named;
  }

  lines.forEach((raw, index) => {
    const comment = /(?:^|\s)#(.*)$/.exec(raw)?.[1];
    if (!comment) return;
    for (const login of mentionsIn(comment)) named.push({ login, file, line: index + 1, as: 'mention' });
  });
  return named;
}

/** Every login the files name, file by file in `CONFIG_FILES` order. */
export function loginsNamed(files: ConfigFiles): NamedLogin[] {
  return CONFIG_FILES.flatMap((file) => {
    const text = files.text.get(file);
    return text === undefined ? [] : loginsNamedIn(file, text);
  });
}


/** Whether a login is the template's placeholder rather than somebody meant. */
export function isTemplatePlaceholder(login: string): boolean {
  return login.toLowerCase() === TEMPLATE_REVIEWER_PLACEHOLDER;
}

/** Where a line of a file is on GitHub, for a person to change it there. */
export function fileLineUrl(repo: string, ref: string, file: string, line: number): string {
  return `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${file}#L${line}`;
}

/** Where a repository's collaborators are invited. */
export function collaboratorsUrl(repo: string): string {
  return `https://github.com/${repo}/settings/access`;
}
