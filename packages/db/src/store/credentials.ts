import { query, queryOne } from '../client.js';

export interface BotCredentialRecord {
  botId: string;
  githubLogin: string;
  githubUserId: number | null;
  secretRef: string;
  scopes: string[];
  tokenExpiresAt: string | null;
  refreshExpiresAt: string | null;
  signingKeyId: number | null;
  authorizedAt: string | null;
  status: 'unauthorized' | 'active' | 'expired' | 'revoked';
}

interface CredentialRow {
  bot_id: string;
  github_login: string;
  github_user_id: string | null;
  secret_ref: string;
  scopes: string[];
  token_expires_at: Date | null;
  refresh_expires_at: Date | null;
  signing_key_id: string | null;
  authorized_at: Date | null;
  status: BotCredentialRecord['status'];
}

const SELECT = `
  select bot_id, github_login, github_user_id, secret_ref, scopes,
         token_expires_at, refresh_expires_at, signing_key_id, authorized_at, status
  from bot_credentials
`;

function toRecord(row: CredentialRow): BotCredentialRecord {
  return {
    botId: row.bot_id,
    githubLogin: row.github_login,
    githubUserId: row.github_user_id === null ? null : Number(row.github_user_id),
    secretRef: row.secret_ref,
    scopes: row.scopes,
    tokenExpiresAt: row.token_expires_at?.toISOString() ?? null,
    refreshExpiresAt: row.refresh_expires_at?.toISOString() ?? null,
    signingKeyId: row.signing_key_id === null ? null : Number(row.signing_key_id),
    authorizedAt: row.authorized_at?.toISOString() ?? null,
    status: row.status,
  };
}

/**
 * Device-flow bookkeeping only. The refresh token itself lives in the install's
 * secret store under `secretRef`; this row is what the console and `fleetadlc doctor` read.
 */
export async function recordAuthorization(input: {
  botId: string;
  githubLogin: string;
  githubUserId: number | null;
  secretRef: string;
  scopes: string[];
  tokenExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}): Promise<BotCredentialRecord> {
  const row = await queryOne<CredentialRow>(
    `insert into bot_credentials
       (bot_id, github_login, github_user_id, secret_ref, scopes, token_expires_at, refresh_expires_at, authorized_at, status)
     values ($1,$2,$3,$4,$5,$6,$7, now(), 'active')
     on conflict (bot_id) do update set
       github_login = excluded.github_login,
       github_user_id = excluded.github_user_id,
       secret_ref = excluded.secret_ref,
       scopes = excluded.scopes,
       token_expires_at = excluded.token_expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       authorized_at = now(),
       status = 'active',
       updated_at = now()
     returning bot_id, github_login, github_user_id, secret_ref, scopes,
               token_expires_at, refresh_expires_at, signing_key_id, authorized_at, status`,
    [
      input.botId,
      input.githubLogin,
      input.githubUserId,
      input.secretRef,
      input.scopes,
      input.tokenExpiresAt,
      input.refreshExpiresAt,
    ],
  );
  if (!row) throw new Error('failed to record authorization');
  return toRecord(row);
}

/**
 * What a refresh left: when the new token expires, and when the new refresh
 * token does. GitHub gives every refresh token its own six months, so the one
 * recorded at authorization says less each time the bot is refreshed — and a
 * restore reads this one to tell an expired sign-in from a live one. A refresh
 * that says nothing about it leaves it as it was.
 */
export async function setTokenExpiry(
  botId: string,
  tokenExpiresAt: Date | null,
  refreshExpiresAt: Date | null = null,
): Promise<void> {
  await query(
    `update bot_credentials
        set token_expires_at = $2, refresh_expires_at = coalesce($3, refresh_expires_at),
            status = 'active', updated_at = now()
      where bot_id = $1`,
    [botId, tokenExpiresAt, refreshExpiresAt],
  );
}

export async function setCredentialStatus(
  botId: string,
  status: BotCredentialRecord['status'],
): Promise<void> {
  await query('update bot_credentials set status = $2, updated_at = now() where bot_id = $1', [botId, status]);
}

export async function setSigningKeyId(botId: string, signingKeyId: number | null): Promise<void> {
  await query('update bot_credentials set signing_key_id = $2, updated_at = now() where bot_id = $1', [
    botId,
    signingKeyId,
  ]);
}

/**
 * Forgets a seat's GitHub authorization: what taking a seat off its account
 * leaves. The sign-in itself is the account's, filed elsewhere and still used
 * by any other seat on it, so only this row goes.
 */
export async function forgetAuthorization(botId: string): Promise<void> {
  await query('delete from bot_credentials where bot_id = $1', [botId]);
}

export async function getCredential(botId: string): Promise<BotCredentialRecord | null> {
  const row = await queryOne<CredentialRow>(`${SELECT} where bot_id = $1`, [botId]);
  return row ? toRecord(row) : null;
}

export async function listCredentials(): Promise<BotCredentialRecord[]> {
  const rows = await query<CredentialRow>(`${SELECT} order by github_login`);
  return rows.map(toRecord);
}
