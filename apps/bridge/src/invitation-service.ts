import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bots, repos } from '@fleetadlc/db';
import {
  GitHubApiError,
  GitHubClient,
  acceptInvitation,
  acceptedPermissionsOf,
  accessSuffices,
  appPrivateKeyRef,
  getSecretStore,
  installationTokenFor,
  inviteCollaborator,
  pendingInvitationsFrom,
  repositoryAccess,
  type AppApi,
  type InvitationOutcome,
  type PendingInvitation,
} from '@fleetadlc/github';
import { botAtStart, repositoryRoleFor, sameLogin } from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import { loginAvailable } from './github-accounts.js';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';

const run = promisify(execFile);

const GITHUB_API = 'https://api.github.com';

async function asApp(method: string, path: string, token: string, body?: unknown): Promise<{ data: unknown; link: string | null }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  // The same error the users' client throws, so a 403 keeps the permission
  // GitHub named in its header, and the card can say which one to add.
  if (!response.ok) throw new GitHubApiError(response.status, path, text.slice(0, 200), acceptedPermissionsOf(response));
  return { data: text ? JSON.parse(text) : {}, link: response.headers.get('link') };
}

/** The path of the `rel="next"` page in a `Link` header, or null on the last page. */
export function nextPagePath(link: string | null): string | null {
  const next = link?.split(',').find((part) => /rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1];
  if (!next) return null;
  return next.startsWith(GITHUB_API) ? next.slice(GITHUB_API.length) : null;
}

/** GitHub, spoken to as the app rather than as one of its users. */
export const APP_API: AppApi = {
  async request<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    return (await asApp(method, path, token, body)).data as T;
  },
  async page<T>(path: string, token: string): Promise<{ items: T; next: string | null }> {
    const { data, link } = await asApp('GET', path, token);
    return { items: data as T, next: nextPagePath(link) };
  },
};

/**
 * The repository named, as OpenADLC has it, or a refusal for one it does not
 * work in. GitHub's names ignore case, so the comparison does too.
 */
export async function worksIn(repoFullName: string, options: { includeRemoved?: boolean } = {}): Promise<string> {
  const known = await repos.listRepos(options);
  const repo = known.find((one) => one.fullName.toLowerCase() === repoFullName.trim().toLowerCase());
  if (!repo) throw new NotOurRepository(repoFullName);
  return repo.fullName;
}

export class NotOurRepository extends Error {
  constructor(repoFullName: string) {
    super(`${repoFullName || 'that'} is not a repository OpenADLC works in — add it first`);
    this.name = 'NotOurRepository';
  }
}

/** Where one bot stands with the repository, as one answer rather than two. */
export interface CrewAccess {
  bot: string;
  login: string | null;
  state: 'in' | 'invited' | 'no-account' | 'refused';
  /** Whether this run changed it, as opposed to finding it already so. */
  changed: boolean;
  detail: string;
}

/**
 * The rows of a list of invitations that can be acted on: a whole positive
 * id, and an invitee and a repository named. Anything else is left out
 * before it reaches GitHub.
 */
export function acceptable(rows: readonly unknown[]): PendingInvitation[] {
  return rows.filter((row): row is PendingInvitation => {
    const one = row as Partial<Record<keyof PendingInvitation, unknown>> | null;
    return (
      typeof one === 'object' &&
      one !== null &&
      Number.isInteger(one.id) &&
      (one.id as number) > 0 &&
      typeof one.invitee === 'string' &&
      one.invitee.length > 0 &&
      typeof one.repository === 'string' &&
      one.repository.length > 0
    );
  }).map((row) => ({ id: row.id, invitee: row.invitee, repository: row.repository, expired: row.expired === true }));
}

/**
 * Why `gh api` failed, read from what gh said and how it exited. Not from the
 * error's message, which starts with the command line: a repository named
 * `auth-service` or `credentials-api` always read "not signed in", one named
 * `admin-*` "not an admin", and the fallback was the command, never gh's reason.
 */
export function whyGhFailed(error: unknown, repoFullName: string): string {
  const failure = error as { code?: unknown; stderr?: unknown } | null;
  if (failure?.code === 'ENOENT') return 'the `gh` command is not installed on the machine running OpenADLC';
  const stderr = String(failure?.stderr ?? '');
  // gh exits 4 when it needs signing in.
  if (failure?.code === 4 || /HTTP 401|Bad credentials|gh auth login/i.test(stderr)) {
    return '`gh` is installed but not signed in — run `gh auth login`';
  }
  if (/HTTP 40[34]|admin/i.test(stderr)) {
    return `the signed-in \`gh\` account is not an admin of ${repoFullName}, so it cannot see invitations`;
  }
  const said = stderr.split('\n').map((line) => line.trim()).find(Boolean);
  return said ? said.slice(0, 160) : 'gh failed and said nothing';
}

/**
 * Getting the crew into a repository, from the console.
 *
 * The work is split across two identities and neither half is enough alone.
 * Only somebody with admin on the repository can **see** an outstanding
 * invitation — `GET /repos/{owner}/{repo}/invitations`, which a GitHub App
 * cannot be granted, because the permission it names
 * (`private_repository_invitations`) does not exist in an app's permission list.
 * And only the invitee can **accept** one, which a bot's own token does happily:
 * `PATCH /user/repository_invitations/{id}` returns 204 given `Administration`
 * on the app. Measured both ways.
 *
 * The app sends each invitation and the reply carries its id; the bot it was
 * sent to accepts it with its own token (`inviteAndAccept`). `discover` and
 * `accept` remain for an install that holds no app private key (`canInvite` is
 * false) or for invitations sent some other way: `gh`, signed in as an admin of
 * the repository, lists them, or their JSON is pasted.
 */
export class InvitationService {
  constructor(
    private readonly actors: Actors,
    private readonly config: BridgeConfig,
  ) {}

  /** Whether this install can invite for itself, or must be invited by hand. */
  async canInvite(): Promise<boolean> {
    return Boolean(await getSecretStore().get(appPrivateKeyRef()));
  }

  /**
   * Invites the whole crew and lets each one in.
   *
   * Both halves, in the order that makes the second possible. The app sends the
   * invitations — the only identity here that can, since inviting needs admin
   * and the crew are collaborators — and each reply carries the id of the
   * invitation it created. That id is then presented by the bot it belongs to,
   * which is the only account allowed to accept it.
   *
   * Nothing has to *find* an invitation, which is the step that cannot be done
   * at all: an app token sees an empty list where invitations are waiting.
   *
   * A bot that can already work here is left as it is, however it got in —
   * invited before, a team, an organization's base permission — so running
   * this again changes nothing: not a second invitation, and not a lower role
   * over one somebody raised by hand, which re-sending an invitation would set.
   */
  async inviteAndAccept(repoFullName: string, onlyBot?: string): Promise<{ results: CrewAccess[] }> {
    // The name comes from a request body. The app is often installed on every
    // repository of an account, so without this it invited the crew anywhere
    // it reached, not only where OpenADLC works.
    repoFullName = await worksIn(repoFullName);
    const key = await getSecretStore().get(appPrivateKeyRef());
    if (!key) throw new Error('no GitHub App private key is stored, so OpenADLC cannot invite anybody');

    const live = await effectiveConfig(this.config);
    const { token } = await installationTokenFor(
      APP_API,
      { clientId: live.gitHubClientId, privateKey: key },
      repoFullName,
    );

    // As the app: wide enough to administer this one repository, and never
    // handed to a task.
    const asApp = new GitHubClient({ token, actingAs: 'fleetadlc-app' });
    const crew = await bots.listBots();
    const ownerIsOrganization = await this.ownerIsOrganization(asApp, repoFullName);

    const results: CrewAccess[] = [];

    for (const bot of crew) {
      if (onlyBot && bot.name !== onlyBot) continue;
      if (!bot.githubLogin) {
        results.push({ bot: bot.name, login: null, state: 'no-account', changed: false, detail: 'no account name yet' });
        continue;
      }

      // Asked before inviting rather than inferred from the failure. With an
      // installation token GitHub answers `403 Resource not accessible by
      // integration` for an account that does not exist — indistinguishable
      // from a genuine permissions problem, and it was reported as one: five
      // bots whose accounts had simply never been created were shown as the app
      // lacking `Administration`, while four others were invited successfully
      // by that same app in the same breath.
      const exists = await loginAvailable(bot.githubLogin, { token });
      if (exists === true) {
        results.push({
          bot: bot.name,
          login: bot.githubLogin,
          state: 'no-account',
          changed: false,
          detail: 'this account has not been created yet',
        });
        continue;
      }

      // Intake and automation get triage on an organization's repository and
      // write on a person's. Taking an unknown owner for a person gave them
      // push on a run where GitHub answered 502, and no later run lowers a
      // grant, so intake, which reads untrusted issue text, kept write for good.
      if (ownerIsOrganization === null && (bot.role === 'intake' || bot.role === 'automation')) {
        results.push({
          bot: bot.name,
          login: bot.githubLogin,
          state: 'refused',
          changed: false,
          detail: `OpenADLC could not tell whether ${repoFullName.split('/')[0]} is an organization, so it did not choose a role for this account; try again`,
        });
        continue;
      }

      const role = repositoryRoleFor(bot.role, ownerIsOrganization === true);
      const access = await repositoryAccess(asApp, repoFullName, bot.githubLogin);
      if (accessSuffices(access, role)) {
        results.push({ bot: bot.name, login: bot.githubLogin, state: 'in', changed: false, detail: 'can already work here' });
        continue;
      }

      const invite = await inviteCollaborator(
        asApp,
        repoFullName,
        bot.githubLogin,
        // GitHub's wire values differ from the words in its own UI.
        role === 'triage' ? 'triage' : 'push',
      );

      if (invite.action === 'already-in') {
        // GitHub adds an organization's member without an invitation, and
        // raises a collaborator's role in place: either way, asked again, it
        // can work here now. When it still cannot, "added" is not the truth.
        const after = access === null ? null : await repositoryAccess(asApp, repoFullName, bot.githubLogin);
        results.push(
          after === null || accessSuffices(after, role)
            ? {
                bot: bot.name,
                login: bot.githubLogin,
                state: 'in',
                changed: after !== null,
                detail: after === null ? 'already a collaborator' : 'added just now',
              }
            : {
                bot: bot.name,
                login: bot.githubLogin,
                state: 'refused',
                changed: false,
                detail: `GitHub says it is added, and it still cannot ${role === 'triage' ? 'triage' : 'push'} here`,
              },
        );
        continue;
      }

      if (invite.action === 'refused') {
        // An account that does not exist is the ordinary case here, not a
        // failure of this step: somebody has not made it yet.
        const missing = invite.detail.includes('is not a GitHub account');
        results.push({
          bot: bot.name,
          login: bot.githubLogin,
          state: missing ? 'no-account' : 'refused',
          changed: false,
          detail: missing ? 'this account has not been created yet' : invite.detail,
        });
        continue;
      }

      // Invited. Whether it gets in now depends on the bot being connected,
      // because only the invitee can accept.
      const [accepted] = await this.accept([
        { id: invite.id, invitee: invite.login, repository: repoFullName, expired: false },
      ]);

      results.push(
        accepted?.outcome.action === 'accepted'
          ? { bot: bot.name, login: bot.githubLogin, state: 'in', changed: true, detail: 'invited and accepted just now' }
          : {
              bot: bot.name,
              login: bot.githubLogin,
              state: 'invited',
              changed: true,
              detail: accepted?.outcome.detail ?? 'invited; it will accept when it connects',
            },
      );
    }

    return { results };
  }

  /**
   * Asked of the app's own token, which needs no bot to be connected. Null when
   * GitHub could not be asked: a 5xx or a rate limit is not an answer.
   */
  private async ownerIsOrganization(asApp: GitHubClient, repoFullName: string): Promise<boolean | null> {
    return asApp
      .request<{ owner?: { type?: string } }>('GET', `/repos/${repoFullName}`)
      .then((repo) => repo.owner?.type === 'Organization')
      .catch(() => null);
  }

  /**
   * Asks `gh` what is outstanding, as the person running OpenADLC.
   *
   * Deliberately not fatal when `gh` is missing, signed out, or not admin on the
   * repository: those are the ordinary states of a cloud install, and the paste
   * box exists for exactly them. The reason is returned so the console can say
   * which it was rather than showing an empty list.
   */
  async discover(repoFullName: string): Promise<{ pending: PendingInvitation[]; reason: string | null }> {
    // `gh` runs as the person, for whatever name a `?repo=` carried. A removed
    // repository still counts: removing one reads its invitations to cancel them.
    repoFullName = await worksIn(repoFullName, { includeRemoved: true });
    try {
      const { stdout } = await run('gh', ['api', `repos/${repoFullName}/invitations`, '--paginate'], {
        timeout: 20_000,
        maxBuffer: 4_000_000,
      });
      return { pending: pendingInvitationsFrom(stdout), reason: null };
    } catch (error) {
      return { pending: [], reason: whyGhFailed(error, repoFullName) };
    }
  }

  /**
   * Accepts each invitation as the bot it was sent to.
   *
   * An invitation for an account that is not one of this install's bots is left
   * alone. OpenADLC holds credentials for every account its crew uses and could
   * accept anything offered to them; joining a repository nobody configured, because somebody
   * guessed a bot's name and sent an invitation, is not a thing it should do.
   */
  async accept(pending: PendingInvitation[]): Promise<
    { bot: string | null; invitee: string; id: number; outcome: InvitationOutcome }[]
  > {
    const crew = await bots.listBots();
    const known = await repos.listRepos();
    const results: { bot: string | null; invitee: string; id: number; outcome: InvitationOutcome }[] = [];

    for (const invitation of pending) {
      // The seat whose account was invited. On an account several seats share,
      // any of them accepts it for all: the invitation is the account's.
      const bot = crew.find((candidate) => sameLogin(candidate.githubLogin, invitation.invitee));

      if (!bot) {
        results.push({
          bot: null,
          invitee: invitation.invitee,
          id: invitation.id,
          outcome: { action: 'none', detail: `${invitation.invitee} is not one of this install's bots` },
        });
        continue;
      }

      // Same reasoning one level up: an invitation to a repository this install
      // was never told about is somebody else's business. One that names no
      // repository is refused too; it skipped this check, and a pasted
      // `{"id": 999, ...}` had a bot accept whatever invitation 999 was. The
      // repository is the pasted row's word for it: only ids the app created
      // itself, or that `gh` listed for a managed repository, can be trusted.
      if (
        !invitation.repository ||
        !known.some((repo) => repo.fullName.toLowerCase() === invitation.repository.toLowerCase())
      ) {
        results.push({
          bot: bot.name,
          invitee: invitation.invitee,
          id: invitation.id,
          outcome: {
            action: 'none',
            detail: invitation.repository
              ? `${invitation.repository} is not a repository OpenADLC manages`
              : 'it names no repository, so OpenADLC cannot tell it is one it manages',
          },
        });
        continue;
      }

      if (invitation.expired) {
        results.push({
          bot: bot.name,
          invitee: invitation.invitee,
          id: invitation.id,
          outcome: { action: 'refused', detail: 'this invitation has expired; send a new one' },
        });
        continue;
      }

      const client = await this.actors.asBot(bot.name).catch(() => null);
      if (!client) {
        results.push({
          bot: bot.name,
          invitee: invitation.invitee,
          id: invitation.id,
          outcome: { action: 'refused', detail: `${botAtStart(bot)} is not connected yet, so it cannot accept anything` },
        });
        continue;
      }

      results.push({
        bot: bot.name,
        invitee: invitation.invitee,
        id: invitation.id,
        outcome: await acceptInvitation(client, invitation.id, invitation.repository),
      });
    }

    return results;
  }
}
