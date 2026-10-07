import { createSign } from 'node:crypto';
import { REVIEW_GATE_CHECK } from '@fleetadlc/shared';

/**
 * Acting as the GitHub App itself, rather than as one of its users.
 *
 * A bot's work runs on its user-to-server token, whose reach is the app's
 * permissions **intersected with that account's own access**. That is the
 * point — it is what keeps a bot's token as weak as the bot. It is also why no
 * bot can invite another: inviting a collaborator needs admin on the
 * repository, and the crew are collaborators.
 *
 * An installation token is the other kind. It carries the app's permissions
 * un-intersected, because it is not acting for anybody, so it can administer the
 * repositories the app is installed on. That is a wider credential than any bot
 * holds, which is exactly why it lives here, server-side, and never reaches a
 * task. The bridge and the CLI use it to:
 *
 * - invite the crew as collaborators, and look up an account's permission;
 * - write rulesets and environments, and, on the console's Apply, commit
 *   CODEOWNERS and the repository templates to the default branch through the
 *   ruleset's bypass;
 * - merge at the merge line;
 * - publish the `review-gate` check, put `adlc:ci` on a pull request and take
 *   it off, turn auto-merge off, and make a pull request a draft;
 * - re-run failed CI and dispatch deploy workflows.
 *
 * Each of these is attributed to the app on GitHub, and the commits and merges
 * appear in the repository's history as the app's bot. Reviews and comments are
 * never posted as the app: they come from an accountable account. The app's
 * webhook is configured with the app's own JWT (`appJwt`), not with this token.
 */

export interface AppCredentials {
  /** The app's client id works as the JWT issuer; the numeric App ID also does. */
  clientId: string;
  /** The PEM GitHub gave you when the key was generated. */
  privateKey: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * A short-lived JWT proving we hold the app's private key.
 *
 * Backdated by a minute because GitHub rejects a token whose `iat` is in its
 * future, and a laptop's clock drifts. Ten minutes is GitHub's maximum.
 */
export function appJwt(credentials: AppCredentials, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: credentials.clientId }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();

  return `${header}.${payload}.${base64Url(signer.sign(credentials.privateKey))}`;
}

export interface AppApi {
  request<T>(method: string, path: string, token: string, body?: unknown): Promise<T>;
  /**
   * A GET of one page of a list, with the path of the next page from GitHub's
   * `Link` header, or null on the last. A list GitHub pages by cursor, such as
   * the hook's deliveries, can be read past its first page only this way.
   * Absent, such a list is read one page deep.
   */
  page?<T>(path: string, token: string): Promise<{ items: T; next: string | null }>;
}

/**
 * An installation token for the installation that covers one repository.
 *
 * Scoped to that repository rather than to everything the app is installed on:
 * the token is wide enough already without also reaching repositories this call
 * has no business in.
 */
export async function installationTokenFor(
  api: AppApi,
  credentials: AppCredentials,
  repoFullName: string,
  now = Date.now(),
): Promise<{ token: string; expiresAt: string | null }> {
  const jwt = appJwt(credentials, now);

  const installation = await api.request<{ id?: number }>(
    'GET',
    `/repos/${repoFullName}/installation`,
    jwt,
  );
  if (!installation.id) {
    throw new Error(`the OpenADLC app is not installed on ${repoFullName}`);
  }

  const minted = await api.request<{ token?: string; expires_at?: string }>(
    'POST',
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    { repositories: [repoFullName.split('/')[1]] },
  );
  if (!minted.token) throw new Error('GitHub returned no installation token');

  return { token: minted.token, expiresAt: minted.expires_at ?? null };
}

/**
 * What the repository rules need from the app itself: its id, which names it
 * as the rulesets' bypass actor, and the checks only it may satisfy —
 * `review-gate`, once it holds Checks: write and so publishes the gate.
 *
 * One `GET /app` for both, for the bridge and the CLI alike. The CLI built its
 * rules without them, so `github check` called every repository the console
 * had protected drifted, and `github apply` wrote the ruleset back with no
 * bypass and an unpinned gate any crew account could set. No credentials, or
 * no answer, gives no id: `applyRepoRules` then leaves a ruleset that has an
 * app bypass alone rather than take it off.
 */
export async function appRuleFields(
  api: AppApi,
  credentials: AppCredentials | null,
  now = Date.now(),
): Promise<{ appId?: number; pinnedChecks: string[] }> {
  if (!credentials?.clientId || !credentials.privateKey) return { pinnedChecks: [] };
  const app = await api
    .request<{ id?: number; permissions?: Record<string, string> }>('GET', '/app', appJwt(credentials, now))
    .catch(() => null);
  if (!app?.id) return { pinnedChecks: [] };
  return { appId: app.id, pinnedChecks: app.permissions?.checks === 'write' ? [REVIEW_GATE_CHECK] : [] };
}

/** One account the app is installed on, as GitHub describes the installation. */
export interface AppInstallation {
  id: number;
  account: { login: string; id: number | null; type: 'User' | 'Organization' };
  /** Every repository of the account, or only the ones it chose. */
  selection: 'all' | 'selected';
  /** The installation's own page: where the account chooses its repositories, and unsuspends it. */
  settingsUrl: string | null;
  suspended: boolean;
}

/**
 * Every account the app is installed on.
 *
 * `GET /repos/{owner}/{repo}/installation` answers 404 alike for an account
 * that never installed the app, one that installed it on other repositories,
 * and a repository that does not exist. Which of those it is decides what a
 * person has to do, and only this list tells them apart.
 */
export async function appInstallations(api: AppApi, credentials: AppCredentials, now = Date.now()): Promise<AppInstallation[]> {
  const listed = await api.request<
    {
      id?: number;
      account?: { login?: string; id?: number; type?: string } | null;
      repository_selection?: string;
      html_url?: string;
      suspended_at?: string | null;
    }[]
  >('GET', '/app/installations?per_page=100', appJwt(credentials, now));

  return listed.flatMap((installation) => {
    if (!installation.id || !installation.account?.login) return [];
    return [
      {
        id: installation.id,
        account: {
          login: installation.account.login,
          id: installation.account.id ?? null,
          type: installation.account.type === 'Organization' ? 'Organization' : 'User',
        },
        selection: installation.repository_selection === 'selected' ? 'selected' : 'all',
        settingsUrl: installation.html_url ?? null,
        suspended: Boolean(installation.suspended_at),
      },
    ];
  });
}

/**
 * Whether an account other than the app's owner can install it.
 *
 * GitHub installs a private app only on the account that owns it, and nothing
 * in the app's own description says which it is. What does say so is asking
 * for the app without any credential: GitHub shows a public app to anybody
 * and a private one to nobody. `unknown` is no answer — the unauthenticated
 * budget is sixty an hour — and never a reason to call it private.
 */
export async function appVisibility(slug: string, fetchImpl: typeof fetch = fetch): Promise<'public' | 'private' | 'unknown'> {
  try {
    const response = await fetchImpl(`https://api.github.com/apps/${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (response.status === 200) return 'public';
    if (response.status === 404) return 'private';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A repository the app has been installed on, as the picker needs it. */
export interface InstalledRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * Every repository this app was installed on, across its installations.
 *
 * The authoritative answer to "which repositories may this install work in",
 * and the reason the question is worth asking *after* the app is installed
 * rather than before: at that point GitHub already holds the list, it includes
 * private repositories, and it is exactly the set the app can act on. Asked
 * earlier, the best anyone can do is type a name and hope.
 *
 * Installation tokens are minted without a `repositories` field here, which
 * scopes them to the whole installation. That is wider than
 * `installationTokenFor` deliberately grants, and it is why this is only used
 * to read a list of names and is never handed out.
 *
 * Every page is read: an organization that installed the app on all of its
 * repositories, more than a page of them, was offered the first hundred. A
 * failure to list the installations at all — a wrong client id, a bad key —
 * is thrown, for the caller to say, rather than read as "installed nowhere";
 * one installation that cannot be read still leaves the others.
 */
const PER_PAGE = 100;

export async function installedRepositories(
  api: AppApi,
  credentials: AppCredentials,
  now = Date.now(),
): Promise<InstalledRepository[]> {
  const jwt = appJwt(credentials, now);

  const installations: { id?: number }[] = [];
  for (let page = 1; ; page++) {
    const listed = await api.request<{ id?: number }[]>('GET', `/app/installations?per_page=${PER_PAGE}&page=${page}`, jwt);
    installations.push(...listed);
    if (listed.length < PER_PAGE) break;
  }

  const found = new Map<string, InstalledRepository>();

  for (const installation of installations) {
    if (!installation.id) continue;

    const minted = await api
      .request<{ token?: string }>('POST', `/app/installations/${installation.id}/access_tokens`, jwt)
      .catch(() => null);
    if (!minted?.token) continue;

    for (let page = 1; ; page++) {
      const listed = await api
        .request<{ repositories?: { full_name?: string; private?: boolean; default_branch?: string }[] }>(
          'GET',
          `/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
          minted.token,
        )
        .catch(() => null);
      const repositories = listed?.repositories ?? [];

      for (const repository of repositories) {
        if (!repository.full_name) continue;
        found.set(repository.full_name, {
          fullName: repository.full_name,
          private: repository.private === true,
          defaultBranch: repository.default_branch ?? 'main',
        });
      }
      if (repositories.length < PER_PAGE) break;
    }
  }

  return [...found.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}
