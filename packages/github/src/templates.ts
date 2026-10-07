import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApplyOutcome, RuleApi, RuleReport } from './rules.js';

/**
 * The login OpenADLC's own `crew/templates/repo/AGENTS.md` names in its Human review
 * section, for the person installing it to replace. GitHub has an
 * organization by that name, so left in place it reads as a real account
 * that cannot review, and the advice for that — invite them — is wrong.
 */
export const TEMPLATE_REVIEWER_PLACEHOLDER = 'owner';

/** The workflow that publishes `ci`, the check the merge line waits for. */
export const CI_WORKFLOW = '.github/workflows/ci.yml';

/** What bringing one earlier CI workflow up to date changes, in the words each place says it. */
export interface CiTemplateUpdate {
  /** Why it is offered: the protect step, `fleetadlc github check`, and the commit's body. */
  reason: string;
  /** What the commit does, after "Bring <file> up to date: ". */
  title: string;
  /** What `apply` says it wrote. */
  outcome: string;
}

const RUNS_ONLY_WHAT_A_CHANGE_NEEDS: CiTemplateUpdate = {
  reason:
    'an earlier OpenADLC workflow, unchanged since it was written; the current one runs only what a change needs — not the build for docs alone, not again on the default branch for a tree its pull request passed — stops a hung run after 30 minutes, names each action by a commit rather than a tag that can be moved, and says in its first line that the file is also 0BSD',
  title: 'run only what a change needs',
  outcome: 'the current template, which runs only what a change needs',
};

const ADDS_THE_SPDX_LINE: CiTemplateUpdate = {
  reason:
    'the OpenADLC workflow before this one, unchanged since it was written; the current one runs the same and adds the SPDX line saying the file is also 0BSD, so the repository can keep it with no attribution or notice',
  title: 'add the SPDX line saying it is also 0BSD',
  outcome: 'the current template, which adds the SPDX line saying the file is also 0BSD',
};

/**
 * The CI workflow OpenADLC wrote in earlier versions, by the SHA-256 of the
 * file exactly as written. A repository holding one of these has not touched
 * it, so it is still ours to bring up to date: the current one runs only what
 * a change needs (`crew/templates/repo/.github/workflows/ci.yml`), and an
 * earlier one ran everything, twice per merge, with no timeout, on the
 * repository's runner minutes. Any other workflow is the repository's own and
 * is left alone, as every other present file is.
 *
 * When the template changes, the hash it had goes here, with what bringing it
 * up to date changes, and `CURRENT_CI_TEMPLATE` takes the new one;
 * `templates.test.ts` fails until both are done.
 *
 * Each hash carries its own reason because they differ: the third template
 * already ran only what a change needs, and saying so again told a repository
 * set up from it that its CI would change when only a comment line would.
 */
export const EARLIER_CI_TEMPLATES: ReadonlyMap<string, CiTemplateUpdate> = new Map<string, CiTemplateUpdate>([
  // Fleet, before the rename: on every push and pull request.
  ['e7a4ed6f4754cc5081bac918e8f678533fc8f37ab6028c88e8ca04b24f9813aa', RUNS_ONLY_WHAT_A_CHANGE_NEEDS],
  // OpenADLC's first: CI after the lead's approval, everything every time.
  ['8c7a55c9e17144d51f57c28a96a35f5b63ecb1cc4e0caa5b9248749c574f0a90', RUNS_ONLY_WHAT_A_CHANGE_NEEDS],
  // OpenADLC's second: ran only what a change needed, but skipped the push for
  // a tree any branch's run had named, and deferred a fork's `agent/` branch.
  ['2bea320fe688268f1a47b70860557a8dc7a79eebc7870f7669f0d5ab1a6f9899', RUNS_ONLY_WHAT_A_CHANGE_NEEDS],
  // OpenADLC's third: the same workflow without the SPDX line that says the
  // file is also 0BSD, which a repository needs to use it with no notice.
  ['651acce5a0081df7cd1f65b693b911d4cdb6a4a7a1e152009b28c077e63127c3', ADDS_THE_SPDX_LINE],
]);

/** The SHA-256 of the CI template as it ships now. */
export const CURRENT_CI_TEMPLATE = 'd188418766bed6373c2c46725cc92c2c7cef55040013d148de1b326bd28b1d15';

export function templateHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Whether a repository's CI workflow is one OpenADLC wrote earlier and nobody has changed since. */
export function isEarlierCiTemplate(body: string): boolean {
  return EARLIER_CI_TEMPLATES.has(templateHash(body));
}

/** What bringing an earlier CI workflow up to date changes, if `body` is one. */
export function earlierCiTemplateUpdate(body: string): CiTemplateUpdate | undefined {
  return EARLIER_CI_TEMPLATES.get(templateHash(body));
}

/**
 * The files a managed repository needs to be legible to the crew.
 *
 * These are not decoration. The dispatcher parses the task form's **Expected
 * paths** field, the bridge reads human-review paths from `AGENTS.md`, hostd
 * runs `make setup` at task start, and the merge line waits for the `ci` check
 * the workflow publishes. (`CODEOWNERS` is the rules' to write, in `.github/`,
 * naming the lead reviewer: a copy at the root, which GitHub never reads while
 * that one exists, used to be written here with `@owner` still in it.) A repository
 * without them cannot produce a routable issue except by hand, and an operator
 * pointing OpenADLC at one today gets labels and a webhook and nothing else.
 *
 * Every file here is written **only when absent**, with two exceptions: a CI
 * workflow OpenADLC wrote earlier and nobody has changed since
 * (`EARLIER_CI_TEMPLATES`) is brought up to date, and an `AGENTS.md` still
 * naming the `@owner` placeholder gets the approvers in its place. Otherwise
 * what a repository says about itself is its own; the apply step fills gaps and
 * never overwrites an answer somebody already gave.
 */
export const TEMPLATE_FILES = [
  'AGENTS.md',
  'Makefile',
  CI_WORKFLOW,
  '.github/ISSUE_TEMPLATE/task.yml',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md',
  'docs/runbooks/README.md',
  'docs/adr/README.md',
  'docs/adr/0000-template.md',
] as const;

export type TemplateFile = (typeof TEMPLATE_FILES)[number];

/** Why each one matters, so a report says more than "missing". */
const WHY: Record<TemplateFile, string> = {
  'AGENTS.md': 'the bridge reads human-review paths from it, and a task is given it before it starts',
  Makefile: 'hostd runs `make setup` at task start, and `make ci` when the builder runs `fleetadlc-ci` before opening a pull request',
  [CI_WORKFLOW]: 'the merge line lands a pull request only once a check named `ci` has passed on it, and nothing else publishes one',
  '.github/ISSUE_TEMPLATE/task.yml': 'its field labels are the headings the platform parses; without it no issue is routable',
  '.github/ISSUE_TEMPLATE/bug.yml': 'a bug filed without the four sections goes back to intake instead of to a builder',
  '.github/ISSUE_TEMPLATE/config.yml': 'keeps blank issues available, so the form is not something people work around',
  '.github/pull_request_template.md': '`Closes #N` says which issue a pull request answers, and the merge line holds a crew pull request to that issue’s lease',
  'docs/runbooks/README.md': 'the workflows lens reviews this directory; an absent one reads as "no runbooks needed"',
  'docs/adr/README.md': 'decisions that are not written down are re-argued',
  'docs/adr/0000-template.md': 'a decision record with no shape is a comment',
};

/** Reads the shipped copy. `root` is the repository this platform lives in. */
export function templateBody(file: TemplateFile, root: string): string {
  return readFileSync(join(root, 'crew', 'templates', 'repo', file), 'utf8');
}

/**
 * `@owner` as a mention, with the same edges as `repo-config.ts`'s: `\b`
 * matched `@owner-ops`, `@owner/platform` and `security@owner.example`, and apply
 * then rewrote a real login into the approvers'.
 */
const placeholder = (flags: string): RegExp => new RegExp(`(^|[^\\w@\`/.-])@${TEMPLATE_REVIEWER_PLACEHOLDER}(?![\\w/-])`, flags);

/**
 * The template's `AGENTS.md` with its `@owner` placeholder replaced by the
 * people who must approve those paths.
 *
 * It was written with `@owner` still in it, and the first thing a new install
 * showed was a blocking card about a file OpenADLC had just committed itself.
 * With nobody to name, the placeholder stays, and that card is the right ask.
 */
export function withApprovers(body: string, approvers: readonly string[]): string {
  if (approvers.length === 0) return body;
  const named = approvers.map((login) => `@${login}`).join(' ');
  return body.replace(placeholder('gim'), (_match, before: string) => `${before}${named}`);
}

/**
 * Who approves a repository's human-review paths, for an `AGENTS.md` and a
 * CODEOWNERS OpenADLC writes: the install's people when it names them, else
 * the repository's admins as `api` can see them — never a crew account — else
 * the person who owns a personal repository. Empty when nobody can be told,
 * and then the caller asks rather than writing a placeholder or the
 * organization's name: an app cannot see an organization's owners, and the
 * automation account, holding triage, cannot list admins at all.
 */
export async function approversFor(
  api: RuleApi,
  fullName: string,
  known: { humans: readonly string[]; crew: readonly string[] },
): Promise<string[]> {
  if (known.humans.length > 0) return [...known.humans];
  const crew = new Set(known.crew.map((login) => login.toLowerCase()));
  const person = (login: string, type?: string) => type !== 'Bot' && !login.endsWith('[bot]') && !crew.has(login.toLowerCase());
  const admins = await api
    .request<{ login: string; type?: string }[]>('GET', `/repos/${fullName}/collaborators?permission=admin&affiliation=all&per_page=100`)
    .catch(() => [] as { login: string; type?: string }[]);
  const people = admins
    .filter((one) => person(one.login, one.type))
    .map((one) => one.login)
    .sort((a, b) => a.localeCompare(b));
  if (people.length > 0) return people;
  const repository = await api
    .request<{ owner?: { login: string; type?: string } }>('GET', `/repos/${fullName}`)
    .catch(() => null);
  const owner = repository?.owner;
  return owner?.type === 'User' && person(owner.login) ? [owner.login] : [];
}

/** Whether an `AGENTS.md` still names the template's placeholder. */
export function namesPlaceholder(body: string): boolean {
  return placeholder('im').test(body);
}

/** The targets the CI workflow and hostd run, which a repository's own Makefile must have. */
const MAKE_TARGETS = ['setup', 'ci'] as const;

/**
 * Which of `make setup` and `make ci` a Makefile has no rule for.
 *
 * A repository's own Makefile is left alone, but the `ci` workflow OpenADLC
 * writes beside it runs both. One with only `build` and `test` read as
 * present, and then every pull request's `ci` failed with "No rule to make
 * target 'setup'" and the merge line landed nothing.
 */
export function makefileLacks(body: string): string[] {
  return MAKE_TARGETS.filter(
    (target) => !new RegExp(`^(?:[^\\s:#=][^:#=\\n]*[ \\t])?${target}(?:[ \\t][^:#=\\n]*)?[ \\t]*::?(?!=)`, 'm').test(body),
  );
}

function lacksDetail(lacking: readonly string[]): string {
  return `the ci workflow and hostd run \`make setup\` and \`make ci\`; this Makefile has no ${lacking.map((target) => `\`${target}\``).join(' or ')} target — add ${lacking.length > 1 ? 'them' : 'it'}`;
}

interface ContentFile {
  content?: string;
  sha?: string;
}

async function readFile(api: RuleApi, fullName: string, path: string): Promise<{ body: string; sha: string } | null> {
  const file = await api.request<ContentFile>('GET', `/repos/${fullName}/contents/${path}`).catch(() => null);
  if (!file?.content || !file.sha) return null;
  return { body: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha };
}

async function fileExists(api: RuleApi, fullName: string, path: string): Promise<boolean> {
  return api
    .request<unknown>('GET', `/repos/${fullName}/contents/${path}`)
    .then(() => true)
    .catch(() => false);
}

/**
 * Which templates a repository is missing. Read-only, like `checkRepoRules`.
 *
 * A present file is not inspected for drift: a repository's `AGENTS.md` is
 * supposed to diverge from the template — that is the whole point of it — and a
 * check that complained would be telling operators to undo their own work. The
 * two exceptions are what OpenADLC wrote and nobody has touched since: an
 * earlier CI template, and an `AGENTS.md` still naming the template's `@owner`.
 */
export async function checkRepoTemplates(
  api: RuleApi,
  fullName: string,
  options: { approvers?: readonly string[] } = {},
): Promise<RuleReport[]> {
  const approvers = options.approvers ?? [];
  const reports: RuleReport[] = [];
  for (const file of TEMPLATE_FILES) {
    const present = await fileExists(api, fullName, file);
    if (!present) {
      reports.push({ name: file, state: 'missing', detail: WHY[file] });
      continue;
    }
    // The exceptions to "present is left alone" are what OpenADLC itself
    // wrote, untouched: an earlier CI template, and the placeholder below.
    if (file === CI_WORKFLOW) {
      const read = await readFile(api, fullName, file);
      const update = read ? earlierCiTemplateUpdate(read.body) : undefined;
      if (update) {
        reports.push({ name: file, state: 'drifted', detail: update.reason });
        continue;
      }
    }
    if (file === 'Makefile') {
      const read = await readFile(api, fullName, file);
      const lacking = read ? makefileLacks(read.body) : [];
      if (lacking.length > 0) {
        reports.push({ name: file, state: 'drifted', detail: lacksDetail(lacking) });
        continue;
      }
    }
    // The placeholder is said even with nobody to name instead, so the caller
    // can ask who.
    if (file === 'AGENTS.md') {
      const read = await readFile(api, fullName, file);
      if (read && namesPlaceholder(read.body)) {
        reports.push({
          name: file,
          state: 'drifted',
          detail:
            approvers.length > 0
              ? `still names the template’s @${TEMPLATE_REVIEWER_PLACEHOLDER}; would name ${approvers.map((login) => `@${login}`).join(' ')}`
              : `still names the template’s @${TEMPLATE_REVIEWER_PLACEHOLDER}, and nobody is known to name instead`,
        });
        continue;
      }
    }
    reports.push({ name: file, state: 'present', detail: '' });
  }
  return reports;
}

/**
 * Writes the missing ones and leaves the rest alone.
 *
 * `dryRun` reports what it would write without writing it, because the first
 * thing an operator should be able to do with this is find out what it would do.
 */
export async function applyRepoTemplates(
  api: RuleApi,
  input: { fullName: string; root: string; dryRun?: boolean; approvers?: readonly string[] },
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  const approvers = input.approvers ?? [];

  for (const file of TEMPLATE_FILES) {
    if (await fileExists(api, input.fullName, file)) {
      const earlier = file === CI_WORKFLOW ? await readFile(api, input.fullName, file) : null;
      const update = earlier ? earlierCiTemplateUpdate(earlier.body) : undefined;
      if (earlier && update) {
        if (input.dryRun) {
          outcomes.push({ name: file, action: 'skipped', detail: `would bring it up to date: ${update.reason}` });
          continue;
        }
        try {
          await api.request('PUT', `/repos/${input.fullName}/contents/${file}`, {
            message: `Bring ${file} up to date: ${update.title}\n\nThe workflow OpenADLC wrote earlier, unchanged since, replaced by \`fleetadlc github apply\` with the current template: ${update.reason}.`,
            content: Buffer.from(templateBody(file, input.root), 'utf8').toString('base64'),
            sha: earlier.sha,
          });
          outcomes.push({ name: file, action: 'updated', detail: update.outcome });
        } catch (cause) {
          outcomes.push({ name: file, action: 'skipped', detail: `not written: ${cause instanceof Error ? cause.message.slice(0, 160) : 'refused'}` });
        }
        continue;
      }
      const placeholder =
        file === 'AGENTS.md' && approvers.length > 0 ? await readFile(api, input.fullName, file) : null;
      if (placeholder && namesPlaceholder(placeholder.body)) {
        if (input.dryRun) {
          outcomes.push({ name: file, action: 'skipped', detail: 'would name the approvers in place of @owner' });
          continue;
        }
        try {
          await api.request('PUT', `/repos/${input.fullName}/contents/${file}`, {
            message: `Name who approves human-review paths in ${file}\n\nThe template's @${TEMPLATE_REVIEWER_PLACEHOLDER} placeholder, replaced by \`fleetadlc github apply\`.`,
            content: Buffer.from(withApprovers(placeholder.body, approvers), 'utf8').toString('base64'),
            sha: placeholder.sha,
          });
          outcomes.push({ name: file, action: 'updated', detail: `names ${approvers.map((login) => `@${login}`).join(' ')}` });
        } catch (cause) {
          outcomes.push({
            name: file,
            action: 'skipped',
            detail: `not written: ${cause instanceof Error ? cause.message.slice(0, 160) : 'refused'}`,
          });
        }
        continue;
      }
      // Not ours to change, but a Makefile the ci workflow cannot run is said.
      const makefile = file === 'Makefile' ? await readFile(api, input.fullName, file) : null;
      const lacking = makefile ? makefileLacks(makefile.body) : [];
      if (lacking.length > 0) {
        outcomes.push({ name: file, action: 'skipped', detail: lacksDetail(lacking) });
        continue;
      }
      outcomes.push({ name: file, action: 'unchanged', detail: 'already there, and not ours to change' });
      continue;
    }

    if (input.dryRun) {
      outcomes.push({ name: file, action: 'skipped', detail: `would write it: ${WHY[file]}` });
      continue;
    }

    /**
     * One file per outcome, and one refusal does not cost the rest.
     *
     * This awaited without catching, so a single file GitHub would not take —
     * or one missing from the checkout this reads its body from — ended the
     * loop and every template after it went unwritten, with nothing said about
     * which. The same shape as the environments in `rules.ts`, and found the
     * same way: a real repository refused one thing and lost eight others.
     */
    try {
      await api.request('PUT', `/repos/${input.fullName}/contents/${file}`, {
        message: `Add ${file}\n\nWritten by \`fleetadlc github apply\` because it was absent.`,
        content: Buffer.from(
          file === 'AGENTS.md' ? withApprovers(templateBody(file, input.root), approvers) : templateBody(file as TemplateFile, input.root),
          'utf8',
        ).toString('base64'),
      });
      outcomes.push({ name: file, action: 'created', detail: WHY[file] });
    } catch (cause) {
      outcomes.push({
        name: file,
        action: 'skipped',
        detail: `not written: ${cause instanceof Error ? cause.message.slice(0, 160) : 'refused'}`,
      });
    }
  }

  return outcomes;
}
