import { GitHubApiError } from './client.js';

/**
 * Accepting the repository invitation a bot has been sent.
 *
 * This was the last step of onboarding a crew that a person had to do by hand,
 * once per bot and once per repository, by signing in as each account in turn.
 * It is also the step that stranded an install silently: the account connects,
 * its token is valid, `fleetadlc auth status` says so, and every push still fails,
 * because an invitation is sitting unread in a mailbox.
 *
 * A bot's ordinary credential can do it. That is worth stating plainly, because
 * it is not what the refusal looks like:
 *
 *     PATCH /user/repository_invitations/1000001
 *     403  {"message":"Resource not accessible by integration"}
 *     x-accepted-github-permissions: administration=write
 *
 * `Resource not accessible by integration` reads like "app tokens cannot do
 * this". The header beside it says otherwise: it names the fine-grained
 * permission that would accept the call. With `Administration: read and write`
 * on the app, the same token that was refused returns `204` and the account is a
 * collaborator — measured for all four bots of a real install.
 *
 * What is **not** possible is finding the invitation in the first place. All
 * three ways a bot might discover its own are closed to an app token:
 *
 * - `GET /user/repository_invitations` answers `200 []`, not a 403. The
 *   permission is evaluated against a repository the invitee cannot see yet, and
 *   an empty list is indistinguishable from having none. This is the dangerous
 *   one, because it looks like success.
 * - `GET /repos/{owner}/{repo}/invitations` answers `403` naming
 *   `private_repository_invitations=read`, which is not a permission a GitHub
 *   App can be granted — it does not appear in the app's permission list at all.
 * - There is no `repository_invitation` event to subscribe a webhook to.
 *
 * So acceptance takes an id, and the id has to come from whoever created the
 * invitation, and the bridge accepts by id (`acceptInvitation`).
 * `acceptPendingInvitations` sweeps the listing instead, which is correct for a
 * token that can see it, but nothing in the bridge calls it today.
 */

/** Just enough of a GitHub client to be faked in a test. */
export interface InvitationApi {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface Invitation {
  id: number;
  /** `owner/name` of the repository the invitation is for. */
  repository: string;
  inviter: string;
}

export type InvitationOutcome =
  | { action: 'accepted'; repository: string; id: number }
  | { action: 'none'; detail: string }
  | { action: 'refused'; detail: string };

interface InvitationRow {
  id: number;
  repository?: { full_name?: string };
  inviter?: { login?: string };
}

/**
 * Every invitation this token's account has pending.
 *
 * Returns `[]` for a GitHub App token whatever is actually waiting — see the
 * note at the top of this file. A caller must not read an empty list as "this
 * account has nothing outstanding".
 */
export async function listInvitations(api: InvitationApi): Promise<Invitation[]> {
  const rows = await api.request<InvitationRow[]>('GET', '/user/repository_invitations?per_page=100');
  return rows.map((row) => ({
    id: row.id,
    repository: row.repository?.full_name ?? '',
    inviter: row.inviter?.login ?? '',
  }));
}

/**
 * Accepts one invitation by id, as whoever the token belongs to.
 *
 * The id is the whole interface. A bot cannot look its own invitation up, so
 * something that already knows the id has to supply it.
 */
export async function acceptInvitation(
  api: InvitationApi,
  invitationId: number,
  repository = '',
): Promise<InvitationOutcome> {
  try {
    await api.request('PATCH', `/user/repository_invitations/${invitationId}`);
    return { action: 'accepted', repository, id: invitationId };
  } catch (error) {
    return { action: 'refused', detail: describe(error) };
  }
}

/**
 * Accepts whatever this account has pending for one repository.
 *
 * Scoped to a named repository rather than accepting everything outstanding. A
 * bot's account may have been invited somewhere that has nothing to do with this
 * install — by a person, by mistake, or by someone who guessed the name — and a
 * platform that accepted every invitation it found would join those too, using a
 * credential the operator gave it for one job.
 *
 * On a GitHub App token the listing is empty, so this reports `none`. That is
 * why `acceptInvitation` takes an id.
 */
export async function acceptPendingInvitations(
  api: InvitationApi,
  repoFullName: string,
): Promise<InvitationOutcome> {
  let pending: Invitation[];
  try {
    pending = await listInvitations(api);
  } catch (error) {
    // Deliberately distinct from an empty list: failing to look is not the same
    // as looking and finding nothing, and reporting it as `none` would read as
    // success.
    return { action: 'refused', detail: describe(error) };
  }

  const match = pending.find((invitation) => sameRepository(invitation.repository, repoFullName));
  if (!match) {
    return {
      action: 'none',
      detail: `no invitation to ${repoFullName} is visible to this token (an app token never sees one)`,
    };
  }

  return acceptInvitation(api, match.id, match.repository);
}

/** GitHub is case-insensitive about owner and repository names; `===` is not. */
function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The reason, kept readable.
 *
 * `Resource not accessible by integration` is the one an operator will actually
 * meet, and on its own it sends people to the wrong place — it reads as a limit
 * of app tokens when it is a permission the app has not been given. The fix is
 * one setting, so it is worth naming.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not accessible by integration')) {
    return 'the OpenADLC GitHub App needs `Administration: read and write` before a bot can accept its own invitation (GitHub names it in x-accepted-github-permissions)';
  }
  return message;
}

/** One row of `GET /repos/{owner}/{repo}/invitations`, as an admin sees it. */
export interface PendingInvitation {
  id: number;
  /** The account the invitation was sent to. */
  invitee: string;
  repository: string;
  expired: boolean;
}

interface AdminInvitationRow {
  id?: number;
  invitee?: { login?: string };
  repository?: { full_name?: string };
  expired?: boolean;
}

/**
 * Reads the admin listing of a repository's outstanding invitations.
 *
 * This is the half a bot cannot do. The two halves are split across two
 * identities and neither is enough alone: only somebody with admin on the
 * repository can *see* an invitation, and only the invitee can *accept* one. So
 * the ids come from here and the acceptance happens as each bot.
 *
 * Tolerant of shape on purpose — it parses whatever `gh api` printed, which may
 * have been pasted by hand, and a row it cannot read is skipped rather than
 * failing the batch. Several values one after another are read in turn, and
 * arrays inside arrays flattened: one `gh api` per repository, pasted
 * together, is `[…]\n[…]`, and `--paginate --slurp` prints `[[…], […]]`. One
 * `JSON.parse` of that threw, and the paste was "nothing to accept".
 */
export function pendingInvitationsFrom(json: string): PendingInvitation[] {
  // A single object is what `gh api .../invitations/123` prints, and somebody
  // pasting one row rather than the list is a reasonable thing to do.
  const flat = (value: unknown): unknown[] => (Array.isArray(value) ? value.flatMap(flat) : [value]);
  const rows = jsonValues(json)
    .flatMap(flat)
    .filter((row): row is AdminInvitationRow => typeof row === 'object' && row !== null);

  return rows
    // `row &&` first: a `null` in the array is valid JSON and threw here.
    .filter((row) => row && typeof row.id === 'number' && row.invitee?.login)
    .map((row) => ({
      id: row.id as number,
      invitee: row.invitee?.login as string,
      repository: row.repository?.full_name ?? '',
      expired: row.expired === true,
    }));
}

/**
 * Each top-level JSON object or array in `text`, in order. It stops at the
 * first thing that is not one — the command pasted instead of its output, or
 * a value cut short — and keeps what came before.
 */
function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at]!)) at += 1;
    if (at >= text.length || (text[at] !== '[' && text[at] !== '{')) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = at; index < text.length && end < 0; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '[' || char === '{') depth += 1;
      else if ((char === ']' || char === '}') && --depth === 0) end = index;
    }
    if (end < 0) break;
    try {
      values.push(JSON.parse(text.slice(at, end + 1)));
    } catch {
      break;
    }
    at = end + 1;
  }
  return values;
}

export type InviteOutcome =
  | { action: 'invited'; login: string; id: number }
  /** Already a collaborator: GitHub answers 204 with no invitation. */
  | { action: 'already-in'; login: string }
  | { action: 'refused'; login: string; detail: string };

/**
 * Invites one account to a repository, as the app.
 *
 * The reply is the point. `PUT /repos/{owner}/{repo}/collaborators/{username}`
 * returns the invitation it just created, id included — so the id never has to
 * be *found*. That matters because finding one is the half that does not work:
 * `GET /user/repository_invitations` answers `200 []` for an app token, and
 * `GET /repos/{owner}/{repo}/invitations` names a permission no app can be
 * granted. Sending the invitation is how OpenADLC comes to know the id at all.
 *
 * A `204` means the account is already a collaborator. That is a success with
 * nothing to accept, and it is what makes running this twice harmless.
 */
export async function inviteCollaborator(
  api: InvitationApi,
  repoFullName: string,
  login: string,
  permission: 'pull' | 'triage' | 'push',
): Promise<InviteOutcome> {
  try {
    const created = await api.request<{ id?: number; invitee?: { login?: string } } | null>(
      'PUT',
      `/repos/${repoFullName}/collaborators/${login}`,
      { permission },
    );

    if (created && typeof created.id === 'number') {
      return { action: 'invited', login: created.invitee?.login ?? login, id: created.id };
    }
    return { action: 'already-in', login };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not accessible by integration')) {
      return {
        action: 'refused',
        login,
        detail: 'the OpenADLC app needs `Administration: read and write` to invite anybody',
      };
    }
    // By the status, not by searching the message: it starts with the path, so
    // a login or repository with `404` or `422` in its name read as that.
    const status = error instanceof GitHubApiError ? error.status : 0;
    if (status === 404) {
      // The account does not exist. By far the likeliest cause, and nothing to
      // do with permissions — somebody has not made it yet.
      return { action: 'refused', login, detail: `${login} is not a GitHub account` };
    }
    if (status === 422) {
      // The one an operator meets on a user-owned repository: `triage` is an
      // organization role and GitHub refuses it outright rather than degrading.
      return {
        action: 'refused',
        login,
        detail:
          permission === 'triage'
            ? `GitHub refused the role \`triage\` for ${login}; a repository owned by a person has no triage role`
            : `GitHub refused the role \`${permission}\` for ${login}: ${message.slice(0, 200)}`,
      };
    }
    return { action: 'refused', login, detail: message.slice(0, 200) };
  }
}

/** How far an account may act in a repository, however it came to: GitHub's role names. */
export type RepositoryAccess = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

const ACCESS_ORDER: readonly RepositoryAccess[] = ['none', 'read', 'triage', 'write', 'maintain', 'admin'];

/**
 * An account's access to a repository, as the repository sees it.
 *
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission` counts every
 * way in — invited as a collaborator, a team the account is on, an
 * organization's base permission — so an account a team already lets in is
 * found to be in and is not invited a second time. An installation token can
 * ask it with the `Metadata` permission every app has, and no bot has to be
 * connected. `role_name` is read before `permission`, which folds `triage`
 * into `read` and `maintain` into `write`.
 *
 * Null when GitHub could not answer: an account that does not exist is a 404,
 * and a caller goes on to find that out its own way.
 */
export async function repositoryAccess(
  api: InvitationApi,
  repoFullName: string,
  login: string,
): Promise<RepositoryAccess | null> {
  try {
    const answer = await api.request<{ permission?: string; role_name?: string }>(
      'GET',
      `/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    const named = [answer?.role_name, answer?.permission].find((value): value is RepositoryAccess =>
      (ACCESS_ORDER as readonly string[]).includes(value ?? ''),
    );
    return named ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether an account's access is enough for the role OpenADLC gives it: `triage`
 * for an account that files and labels, `write` for one that pushes. More is
 * enough too — somebody may have made a bot an admin, and OpenADLC does not take
 * that away by inviting it again.
 */
export function accessSuffices(access: RepositoryAccess | null, wanted: 'triage' | 'write'): boolean {
  if (access === null) return false;
  return ACCESS_ORDER.indexOf(access) >= ACCESS_ORDER.indexOf(wanted);
}
