import { query, queryOne, withTransaction } from '../client.js';

/**
 * A GitHub account OpenADLC holds a sign-in for. Seats point at one; several may
 * point at the same one, which is how a crew runs on a single account. See
 * migration 0014.
 */
export interface Identity {
  id: string;
  login: string;
  githubUserId: number | null;
  /** The name the account's secrets are filed under. */
  secretNs: string;
  /** When it was first connected: the walkthrough asks for accounts in an order, and means it. */
  connectedAt?: string | null;
}

interface IdentityRow {
  id: string;
  login: string;
  github_user_id: string | null;
  secret_ns: string;
  created_at?: Date | string | null;
}

function toIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    login: row.login,
    githubUserId: row.github_user_id === null ? null : Number(row.github_user_id),
    secretNs: row.secret_ns,
    connectedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function listIdentities(): Promise<Identity[]> {
  const rows = await query<IdentityRow>('select id, login, github_user_id, secret_ns, created_at from github_identities order by login');
  return rows.map(toIdentity);
}

/** The identity a bot uses, or null when it has none — not connected yet. */
export async function identityOfBot(botId: string): Promise<Identity | null> {
  const row = await queryOne<IdentityRow>(
    `select i.id, i.login, i.github_user_id, i.secret_ns
     from bots b join github_identities i on i.id = b.identity_id
     where b.id = $1`,
    [botId],
  );
  return row ? toIdentity(row) : null;
}

/** Which identity each seat is on, for the seats that are on one: what lists the accounts with their seats. */
export async function seatIdentities(): Promise<{ botId: string; identityId: string }[]> {
  const rows = await query<{ id: string; identity_id: string }>(
    'select id, identity_id from bots where identity_id is not null order by name',
  );
  return rows.map((row) => ({ botId: row.id, identityId: row.identity_id }));
}

/** The names of the bots that sign in as an identity, found by the name its secrets are filed under. */
export async function botsOnSecretNs(secretNs: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `select b.name from bots b join github_identities i on i.id = b.identity_id where i.secret_ns = $1 order by b.name`,
    [secretNs],
  );
  return rows.map((row) => row.name);
}

/**
 * Files an account's sign-in under another name: the identity's `secret_ns`
 * and every seat's credential row that points at it, in one transaction. The
 * secrets themselves are the caller's to copy, before this, and to delete
 * after — as a rename does with a seat's own.
 *
 * What a seat leaving a shared account needs when the sign-in is filed under
 * that seat's name: left there, the seat would carry the account's sign-in off
 * with it on its next rename.
 */
export async function moveSecretNs(
  identityId: string,
  to: string,
  secretRefs: readonly { from: string; to: string }[],
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('update github_identities set secret_ns = $2, updated_at = now() where id = $1', [identityId, to]);
    for (const ref of secretRefs) {
      await client.query(
        `update bot_credentials set secret_ref = $3, updated_at = now()
         where secret_ref = $2 and bot_id in (select id from bots where identity_id = $1)`,
        [identityId, ref.from, ref.to],
      );
    }
  });
}

/**
 * Forgets an account no seat uses any more. Refused — nothing happens — while
 * any seat is still on it, so a caller that read a stale list cannot take an
 * account out from under a seat.
 */
export async function deleteUnusedIdentity(identityId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from github_identities i
     where i.id = $1 and not exists (select 1 from bots b where b.identity_id = i.id)
     returning i.id`,
    [identityId],
  );
  return rows.length > 0;
}

/** The identity for a login, whatever its casing, or null when OpenADLC holds none. */
export async function identityByLogin(login: string): Promise<Identity | null> {
  const row = await queryOne<IdentityRow>(
    'select id, login, github_user_id, secret_ns from github_identities where lower(login) = lower($1)',
    [login],
  );
  return row ? toIdentity(row) : null;
}

/**
 * Records an account connected on its own, before any seat uses it — what
 * settings' "Connect a GitHub account" does. Its sign-in is the caller's to
 * store, under `secretNs`, which no seat's name can be (see `accountSecretNs`
 * in the bridge), so no rename ever carries it off.
 *
 * An account OpenADLC already holds is kept as it is, with its GitHub user id
 * filled in when it had none: reconnecting refreshes its sign-in, not where
 * that is filed.
 */
export async function recordIdentity(input: { login: string; githubUserId: number | null; secretNs: string }): Promise<Identity> {
  const existing = await identityByLogin(input.login);
  if (existing) {
    if (existing.githubUserId === null && input.githubUserId !== null) {
      await query('update github_identities set github_user_id = $2, updated_at = now() where id = $1', [existing.id, input.githubUserId]);
      return { ...existing, githubUserId: input.githubUserId };
    }
    return existing;
  }
  const row = await queryOne<IdentityRow>(
    `insert into github_identities (login, github_user_id, secret_ns) values ($1, $2, $3)
     returning id, login, github_user_id, secret_ns`,
    [input.login, input.githubUserId, input.secretNs],
  );
  if (!row) throw new Error(`could not record the GitHub account ${input.login}`);
  return toIdentity(row);
}
