/**
 * OAuth device flow: how every bot account is connected.
 *
 * A person opens https://github.com/login/device, signs in as the bot's own
 * GitHub account and enters the code. OpenADLC receives a user access token (8h)
 * and a refresh token (6 months); only the refresh token is ever stored.
 * No personal access tokens are involved at any point.
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface DeviceCodeRequest {
  clientId: string;
  /** OAuth Apps need scopes; GitHub Apps derive permissions from the app + account. */
  scopes?: string[];
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface UserToken {
  accessToken: string;
  /** Absent when the app has token expiration disabled. */
  expiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
  tokenType: string;
}

export class DeviceAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status GitHub answered with, when it answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}

const HUMAN_ERRORS: Record<string, string> = {
  access_denied: 'the authorization was cancelled in the browser; run the sign-in again and approve it',
  expired_token: 'the device code expired before it was approved; run the sign-in again',
  device_flow_disabled: 'device flow is not enabled on the OpenADLC GitHub App (enable it in the app settings)',
  incorrect_client_credentials: 'the client id is wrong (use the app client id, not the app id)',
  incorrect_device_code: 'the device code was rejected by GitHub; run the sign-in again',
  unsupported_grant_type: 'the grant type was rejected by GitHub',
};

const FORM_TIMEOUT_MS = 15_000;

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, string>> {
  return (await postFormAnswer(url, body)).parsed;
}

/**
 * `postForm`, with the HTTP status beside the body: a refresh's error keeps it.
 *
 * Given up after 15 seconds. A refresh runs under the token broker's lock, and
 * with no limit a stalled connection held it, and a database client, for the
 * runtime's five minutes. A timeout reads as GitHub not being asked, which
 * does not mark the sign-in revoked.
 */
async function postFormAnswer(url: string, body: Record<string, string>): Promise<{ parsed: Record<string, string>; status: number }> {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(FORM_TIMEOUT_MS),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(text) as Record<string, string>;
  } catch {
    throw new DeviceAuthError(
      'bad_response',
      `GitHub returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`,
      response.status,
    );
  }
  if (!response.ok && !parsed.error) {
    throw new DeviceAuthError('http_error', `GitHub returned ${response.status}: ${text.slice(0, 200)}`, response.status);
  }
  return { parsed, status: response.status };
}

export async function requestDeviceCode(input: DeviceCodeRequest): Promise<DeviceCode> {
  const body: Record<string, string> = { client_id: input.clientId };
  if (input.scopes?.length) body.scope = input.scopes.join(' ');

  const parsed = await postForm(DEVICE_CODE_URL, body);
  if (parsed.error) {
    throw new DeviceAuthError(parsed.error, HUMAN_ERRORS[parsed.error] ?? parsed.error_description ?? parsed.error);
  }
  if (!parsed.device_code || !parsed.user_code || !parsed.verification_uri) {
    throw new DeviceAuthError('bad_response', 'GitHub did not return a device code');
  }
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    expiresIn: Number(parsed.expires_in ?? 900),
    interval: Number(parsed.interval ?? 5),
  };
}

function toUserToken(parsed: Record<string, string>, now: Date): UserToken {
  const expiresIn = parsed.expires_in ? Number(parsed.expires_in) : null;
  const refreshExpiresIn = parsed.refresh_token_expires_in ? Number(parsed.refresh_token_expires_in) : null;
  return {
    accessToken: parsed.access_token ?? '',
    expiresAt: expiresIn ? new Date(now.getTime() + expiresIn * 1000) : null,
    refreshToken: parsed.refresh_token ?? null,
    refreshExpiresAt: refreshExpiresIn ? new Date(now.getTime() + refreshExpiresIn * 1000) : null,
    scopes: parsed.scope ? parsed.scope.split(/[, ]+/).filter(Boolean) : [],
    tokenType: parsed.token_type ?? 'bearer',
  };
}

export interface PollOptions {
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  onPending?: (waitedSeconds: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Polls until the person approves, respecting `interval` and `slow_down`. */
export async function pollForUserToken(options: PollOptions): Promise<UserToken> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  let interval = Math.max(1, options.intervalSeconds);
  let waited = 0;

  while (waited <= options.expiresInSeconds) {
    await sleep(interval * 1000);
    waited += interval;

    const parsed = await postForm(ACCESS_TOKEN_URL, {
      client_id: options.clientId,
      device_code: options.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (parsed.access_token) return toUserToken(parsed, now());

    switch (parsed.error) {
      case 'authorization_pending':
        options.onPending?.(waited);
        break;
      case 'slow_down':
        interval = Number(parsed.interval ?? interval + 5);
        options.onPending?.(waited);
        break;
      default:
        throw new DeviceAuthError(
          parsed.error ?? 'unknown',
          HUMAN_ERRORS[parsed.error ?? ''] ?? parsed.error_description ?? 'device authorization failed',
        );
    }
  }

  throw new DeviceAuthError('expired_token', 'the device code expired before it was approved; run the sign-in again');
}

/**
 * Refresh rotates the refresh token, so the new one must replace the stored one.
 * Device-flow tokens refresh with the client id alone: no client secret at rest.
 */
export async function refreshUserToken(input: {
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
  now?: () => Date;
}): Promise<UserToken> {
  const body: Record<string, string> = {
    client_id: input.clientId,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  };
  if (input.clientSecret) body.client_secret = input.clientSecret;

  const { parsed, status } = await postFormAnswer(ACCESS_TOKEN_URL, body);
  if (parsed.error || !parsed.access_token) {
    throw new DeviceAuthError(
      parsed.error ?? 'unknown',
      HUMAN_ERRORS[parsed.error ?? ''] ??
        parsed.error_description ??
        'GitHub refused the refresh and gave no reason',
      status,
    );
  }
  return toUserToken(parsed, (input.now ?? (() => new Date()))());
}
