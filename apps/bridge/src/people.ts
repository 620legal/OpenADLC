import { actsFor } from '@fleetadlc/shared';
import { isPinnedHuman } from './human-ids.js';

/**
 * Who OpenADLC acts for, when the delivery's label for its author is not enough.
 *
 * GitHub labels every issue, comment and pull request with its author's
 * association, and `actsFor` trusts OWNER, MEMBER and COLLABORATOR. The label
 * is not the permission: an organization's owner whose membership is private
 * is a CONTRIBUTOR on an issue in a private repository of their own
 * organization — found when the owner's first issue on a new install went
 * unanswered, its context and its gate answers with it. So an author the label
 * leaves out is asked about, as whoever can ask, and the answer kept for ten
 * minutes. The install's own people always count, from the GitHub account
 * each login was pinned to (`human-ids.ts`).
 */

const KEPT_MS = 10 * 60 * 1000;
const known = new Map<string, { at: number; access: boolean }>();

/**
 * Who else can ask, per repository: the app, with an installation token. The
 * automation account usually holds triage, and GitHub answers this question
 * only to an account that can push — so asked as it, the answer was always
 * no. Set once at start-up; see main.ts.
 */
let appAsker: ((repoFullName: string) => Promise<PermissionAsker | null>) | null = null;

export function askAsTheApp(asker: (repoFullName: string) => Promise<PermissionAsker | null>): void {
  appAsker = asker;
}

/** The app, to ask about one repository, when it can be asked as; see `askAsTheApp`. */
export async function theApp(repoFullName: string): Promise<PermissionAsker | null> {
  return appAsker ? appAsker(repoFullName).catch(() => null) : null;
}

/** Just enough of a GitHub client to ask, and to write as the app where the automation account may not. */
export interface PermissionAsker {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** Whether a login can at least triage the repository, as GitHub says when asked. */
export async function hasRepoAccess(client: PermissionAsker | null, repoFullName: string, login: string): Promise<boolean> {
  return (await repoAccess(client, repoFullName, login)) === true;
}

/** Roles that can at least triage, by name. */
const TRIAGE_OR_MORE = ['admin', 'maintain', 'write', 'triage'];
/**
 * The base permission GitHub reports beside the role. A custom role is named
 * by its own name (`release-manager`) and is refused by name, though its base
 * says `write`; triage, on the other hand, reports a base of `read`.
 */
const WRITE_OR_MORE = ['admin', 'maintain', 'write'];

/**
 * `hasRepoAccess`, telling "no" from "could not ask": null when neither the
 * client nor the app got an answer, so a caller can say GitHub was not reached
 * rather than that the person lacks a role. Nothing but an answer is kept.
 */
export async function repoAccess(client: PermissionAsker | null, repoFullName: string, login: string): Promise<boolean | null> {
  const key = `${repoFullName.toLowerCase()}:${login.toLowerCase()}`;
  const kept = known.get(key);
  if (kept && Date.now() - kept.at < KEPT_MS) return kept.access;
  const ask = async (asker: PermissionAsker | null) =>
    typeof asker?.request !== 'function'
      ? null
      : Promise.resolve()
          .then(() =>
            asker.request<{ permission?: string; role_name?: string }>(
              'GET',
              `/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}/permission`,
            ),
          )
          .catch(() => null);
  const answer =
    (await ask(client)) ?? (appAsker ? await ask(await appAsker(repoFullName).catch(() => null)) : null);
  if (!answer) return null;
  const access =
    TRIAGE_OR_MORE.includes(answer.role_name ?? '') || WRITE_OR_MORE.includes(answer.permission ?? '');
  known.set(key, { at: Date.now(), access });
  return access;
}

/**
 * The role GitHub gives a login on the repository (`admin`, `write`, `triage`,
 * a custom role's name…), asked as the app first and then as `client`, or
 * `unknown` when neither got an answer. Asked as the automation account
 * alone, a triage seat was refused every time, so a passer-by's request for
 * changes read as unknown and held the merge line. Not kept: the merge check
 * needs the role, not `repoAccess`'s yes or no, and asks once per decision.
 */
export async function permissionOn(
  client: { permissionOf(repoFullName: string, login: string): Promise<string> } | null,
  repoFullName: string,
  login: string,
): Promise<string> {
  const app = await theApp(repoFullName);
  const asApp = app
    ? await Promise.resolve()
        .then(() =>
          app.request<{ permission?: string; role_name?: string }>(
            'GET',
            `/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}/permission`,
          ),
        )
        .then((answer) => answer.role_name || answer.permission || 'none')
        .catch(() => null)
    : null;
  if (asApp !== null) return asApp;
  return client
    ? Promise.resolve()
        .then(() => client.permissionOf(repoFullName, login))
        .catch(() => 'unknown')
    : 'unknown';
}

/**
 * `actsFor`, and when that says no, the install's people and then GitHub's own
 * answer. One of `humans` counts only from the account its login was pinned
 * to (`isPinnedHuman`): the author's `id` has to be that account's. Without an
 * id, or from another account by that login, GitHub's answer about the login
 * is what decides.
 */
export async function actsForOn(input: {
  client: PermissionAsker | null;
  repoFullName: string;
  author: { login: string | null | undefined; association: string | null | undefined; id?: number | null };
  crew: readonly { githubLogin: string | null }[];
  humans?: readonly string[];
}): Promise<boolean> {
  if (actsFor(input.author, input.crew)) return true;
  const login = input.author.login;
  if (!login) return false;
  if (input.humans && (await isPinnedHuman(input.humans, login, input.author.id))) return true;
  return hasRepoAccess(input.client, input.repoFullName, login);
}

/** For tests: forget what GitHub said. */
export function forgetRepoAccess(): void {
  known.clear();
  appAsker = null;
}
