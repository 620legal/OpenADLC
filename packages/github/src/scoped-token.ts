import { GitHubApiError } from './client.js';

const API = 'https://api.github.com';

/**
 * A bot's user token narrowed to one repository.
 *
 * A crew account is invited into every repository OpenADLC manages, so its
 * own user token reaches all of them. A task that obeyed injected text could
 * then read one private repository and post what it found in another. A token
 * from here is one GitHub itself refuses for any repository but the task's.
 */
export interface ScopedToken {
  token: string;
  /** When GitHub says the scoped token expires; null when it does not say. */
  expiresAt: Date | null;
}

/** Why a scoped token was not made: the client secret refused, or anything else GitHub said. */
export class ScopedTokenError extends Error {
  constructor(
    message: string,
    /** True when GitHub refused the app's client id and secret, which a person has to replace. */
    readonly secretRefused: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ScopedTokenError';
  }
}

function basic(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

/**
 * GitHub's "Create a scoped access token" (`POST /applications/{client_id}/token/scoped`),
 * as its REST description has it:
 * - it takes "a non-scoped user access token" — the user-to-server token a
 *   GitHub App's device flow issues, which is what the broker holds — and
 *   returns an authorization whose `token` is the new, scoped one, with an
 *   `expires_at`;
 * - like the rest of `/applications/{client_id}/token`, it is called with basic
 *   authentication, the app's client id and client secret as user and password;
 * - the token it is handed is the parent it derives from, not one it replaces:
 *   nothing in the description says it revokes it, and the broker goes on using
 *   the parent for the bridge's own calls. Were GitHub ever to revoke it, those
 *   calls would fail and the next ask refresh it;
 * - `target` (the owner) is required with `repositories`, which are names.
 *
 * Permissions are left out: the user token already carries the app's
 * permissions intersected with the account's role there.
 */
export async function createScopedToken(input: {
  clientId: string;
  clientSecret: string;
  /** The account's own user token, which the scoped one derives from. */
  accessToken: string;
  /** `owner/name`. */
  repository: string;
  fetchImpl?: typeof fetch;
}): Promise<ScopedToken> {
  const [owner, name] = input.repository.split('/');
  if (!owner || !name) throw new ScopedTokenError(`${input.repository} is not an owner/name repository`, false);
  const path = `/applications/${encodeURIComponent(input.clientId)}/token/scoped`;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${API}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: basic(input.clientId, input.clientSecret),
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fleetadlc-token-broker',
      },
      body: JSON.stringify({ access_token: input.accessToken, target: owner, repositories: [name] }),
    });
  } catch (error) {
    throw new ScopedTokenError(`GitHub could not be asked for a token scoped to ${input.repository}: ${error instanceof Error ? error.message : error}`, false, {
      cause: error,
    });
  }
  if (!response.ok) {
    // The body is GitHub's error, never a token: it is only sent with a 200.
    const body = (await response.text().catch(() => '')).slice(0, 300);
    throw new ScopedTokenError(
      response.status === 401
        ? 'GitHub refused the app’s client secret'
        : `GitHub would not scope the token to ${input.repository} (${response.status})`,
      response.status === 401,
      { cause: new GitHubApiError(response.status, path, body) },
    );
  }
  const answer = (await response.json().catch(() => null)) as { token?: unknown; expires_at?: unknown } | null;
  if (!answer || typeof answer.token !== 'string' || answer.token === '') {
    throw new ScopedTokenError(`GitHub answered without a token scoped to ${input.repository}`, false);
  }
  const expires = typeof answer.expires_at === 'string' ? new Date(answer.expires_at) : null;
  return { token: answer.token, expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null };
}

/**
 * Whether GitHub accepts the app's client id and secret, asked with a bot's
 * token on `POST /applications/{client_id}/token` (the "check a token" call,
 * which changes nothing). True when it does, false when it refuses them; throws
 * when GitHub could not be asked. A 404 is also a refusal here: the token is
 * one the broker just handed out, so it is the credentials GitHub did not know.
 */
export async function clientSecretAccepted(input: {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const response = await (input.fetchImpl ?? fetch)(`${API}/applications/${encodeURIComponent(input.clientId)}/token`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: basic(input.clientId, input.clientSecret),
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fleetadlc-health',
    },
    body: JSON.stringify({ access_token: input.accessToken }),
  });
  if (response.ok) return true;
  if (response.status === 401 || response.status === 403 || response.status === 404) return false;
  throw new Error(`GitHub answered ${response.status} when asked to check the app’s client secret`);
}
