import { repos } from '@fleetadlc/db';
import { collaboratorsUrl, isTemplatePlaceholder } from '@fleetadlc/github';
import { humanReviewLogins, sameLogin } from '@fleetadlc/shared';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';
import { theApp, type PermissionAsker } from './people.js';

/**
 * No bot signs in as a person, or as an account that administers a managed
 * repository.
 *
 * A device code approved in a browser still signed in to GitHub as the
 * operator stored the operator's own account for a seat. The seat's tasks
 * then ran with that person's token, which on a repository they administer
 * can edit the rulesets and branch protection that back "a bot cannot merge";
 * and the person's own gate answers were read as the crew's and dropped. So
 * the people are refused wherever an account becomes a seat's — a seat's
 * connect, settings' Connect a GitHub account, and Crew's account choice —
 * and so is an account GitHub says has admin or maintain where the crew works.
 * Every path asks here, so there is one rule to keep right.
 */

/** A person no bot may sign in as, with the words for why. */
export interface Person {
  login: string;
  /** "one of this install's people (FLEETADLC_HUMANS)", "named in exampleco/app's AGENTS.md Human review". */
  why: string;
  /** The same, short, for beside a choice. */
  short: string;
}

export interface AccountGuardDeps {
  /** The install's `humans`, as the bridge reads them now. */
  humans(): Promise<readonly string[]>;
  repositories(): Promise<{ fullName: string; defaultBranch: string }[]>;
  /** The app, to ask about one repository, or null when it cannot be asked as. */
  asker(repoFullName: string): Promise<PermissionAsker | null>;
}

/** Where the guard looks on a running install: the live settings, the managed repositories, and the app. */
export function liveGuardDeps(config: BridgeConfig): AccountGuardDeps {
  return {
    humans: async () => (await effectiveConfig(config)).humans,
    repositories: async () =>
      (await repos.listRepos()).map((repo) => ({ fullName: repo.fullName, defaultBranch: repo.defaultBranch || 'main' })),
    asker: (repoFullName) => theApp(repoFullName),
  };
}

/** A file on a branch, read as the app; null when it is absent or cannot be read. */
async function readFile(asker: PermissionAsker, repo: string, path: string, ref: string): Promise<string | null> {
  const file = await asker
    .request<{ content?: string; encoding?: string }>('GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
    .catch(() => null);
  if (!file?.content) return null;
  return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? 'base64').toString('utf8');
}

/**
 * The install's people, then every login a managed repository's AGENTS.md
 * names under Human review on its default branch — read the way the review
 * gate reads it, so the refusal names exactly who the gate waits on. Asked as
 * the app, since at setup no bot may be connected to read with. A file that
 * cannot be read adds nobody: a rate limit must not block setup. OpenADLC's
 * template placeholder `@owner` is nobody.
 */
export async function peopleOf(deps: AccountGuardDeps): Promise<Person[]> {
  const people: Person[] = [];
  const add = (person: Person) => {
    if (!isTemplatePlaceholder(person.login) && !people.some((one) => sameLogin(one.login, person.login))) people.push(person);
  };
  for (const login of await deps.humans().catch(() => [] as string[])) {
    add({ login, why: 'one of this install’s people (FLEETADLC_HUMANS)', short: 'one of this install’s people' });
  }
  for (const repo of await deps.repositories().catch(() => [])) {
    const asker = await deps.asker(repo.fullName).catch(() => null);
    if (!asker) continue;
    const agents = await readFile(asker, repo.fullName, 'AGENTS.md', repo.defaultBranch);
    for (const named of humanReviewLogins(agents)) {
      add({
        login: named.login,
        why: `named in ${repo.fullName}’s AGENTS.md Human review`,
        short: `a person named in ${repo.fullName}’s AGENTS.md`,
      });
    }
  }
  return people;
}

/** The person `login` is, or null. */
export function personOf(login: string, people: readonly Person[]): Person | null {
  return people.find((person) => sameLogin(person.login, login)) ?? null;
}

/** The short reason Crew shows beside a person's account, or null. */
export function personChoiceRefusal(login: string, people: readonly Person[]): string | null {
  const person = personOf(login, people);
  return person ? `${person.short} — bots need their own account` : null;
}

/**
 * The first managed repository where GitHub says `login` has admin or
 * maintain, asked as the app, or null. A lookup that fails is not a refusal:
 * the `bot-access` check asks again every half hour and catches it.
 */
export async function elevatedOn(login: string, deps: AccountGuardDeps): Promise<{ repo: string; role: string } | null> {
  for (const repo of await deps.repositories().catch(() => [])) {
    const asker = await deps.asker(repo.fullName).catch(() => null);
    if (!asker) continue;
    const answer = await asker
      .request<{ permission?: string; role_name?: string }>(
        'GET',
        `/repos/${repo.fullName}/collaborators/${encodeURIComponent(login)}/permission`,
      )
      .catch(() => null);
    const role = [answer?.role_name, answer?.permission].find((one) => one === 'admin' || one === 'maintain');
    if (role) return { repo: repo.fullName, role };
  }
  return null;
}

/**
 * Why no bot may be `login`, as a sentence that says what to do next, or null
 * when one may. `elevated` asks GitHub about admin and maintain too: not for
 * an account connected for no seat, which may come before any repository.
 * `then` is what to do once it is put right ("enter a new code"); `people`,
 * when the caller has read them already.
 */
export async function guardRefusal(
  login: string,
  deps: AccountGuardDeps,
  options: { elevated: boolean; then: string; people?: readonly Person[] },
): Promise<string | null> {
  const person = personOf(login, options.people ?? (await peopleOf(deps)));
  if (person) {
    return (
      `${login} is ${person.why}, so no bot can sign in as it. Sign in to GitHub as the bot’s own account ` +
      `(a private window helps) and ${options.then}.`
    );
  }
  if (!options.elevated) return null;
  const elevated = await elevatedOn(login, deps);
  if (elevated) {
    return (
      `${login} has ${elevated.role} on ${elevated.repo}, which can change the rules that keep a bot from merging. ` +
      `Lower it to the role its seat needs (write; triage for intake or automation in an organization) at ${collaboratorsUrl(elevated.repo)}, then ${options.then}.`
    );
  }
  return null;
}
