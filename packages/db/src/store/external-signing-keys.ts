import { query } from '../client.js';

/**
 * A person's "this key is used elsewhere" on the signing-key check's card:
 * which keys on a bot's GitHub account are known to be someone's on purpose,
 * so the card stops counting them. See
 * `migrations/0145_external_signing_keys.sql`.
 */
export interface ExternalSigningKey {
  /** The GitHub account the key is on, as the card names it. */
  login: string;
  /** GitHub's id for the key, which outlives retitling. */
  keyId: number;
  /** The title GitHub listed when it was dismissed, or null when it had none. */
  title: string | null;
  dismissedBy: string;
  dismissedAt: string;
}

interface Row {
  login: string;
  key_id: string;
  title: string | null;
  dismissed_by: string;
  dismissed_at: Date;
}

function toRecord(row: Row): ExternalSigningKey {
  return {
    login: row.login,
    keyId: Number(row.key_id),
    title: row.title,
    dismissedBy: row.dismissed_by,
    dismissedAt: row.dismissed_at.toISOString(),
  };
}

/** Records that `by` says this key is used outside OpenADLC; pressed twice, the later press wins. */
export async function markExternal(login: string, keyId: number, by: string, title: string | null = null, at = new Date()): Promise<void> {
  await query(
    `insert into external_signing_keys (login, key_id, title, dismissed_by, dismissed_at)
     values ($1, $2, $3, $4, $5)
     on conflict (login, key_id) do update set
       title = excluded.title,
       dismissed_by = excluded.dismissed_by,
       dismissed_at = excluded.dismissed_at`,
    [login, keyId, title, by, at],
  );
}

/** The undo: the key counts as a stranger's again. True when there was something to undo. */
export async function unmarkExternal(login: string, keyId: number): Promise<boolean> {
  const rows = await query<{ login: string }>('delete from external_signing_keys where login = $1 and key_id = $2 returning login', [
    login,
    keyId,
  ]);
  return rows.length > 0;
}

/** Every dismissed key on one account, oldest dismissal first. */
export async function listExternal(login: string): Promise<ExternalSigningKey[]> {
  const rows = await query<Row>(
    'select login, key_id, title, dismissed_by, dismissed_at from external_signing_keys where login = $1 order by dismissed_at, key_id',
    [login],
  );
  return rows.map(toRecord);
}
