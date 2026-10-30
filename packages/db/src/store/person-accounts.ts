import { query, queryOne } from '../client.js';

/**
 * The GitHub account each console person proved is theirs, by signing in as
 * it (`migrations/0156_person_github_accounts.sql`, the bridge's
 * `person-github.ts`). A login and an id; never a token.
 */
export interface PersonAccount {
  identity: string;
  githubLogin: string;
  githubUserId: number;
  linkedAt: string;
}

interface Row {
  identity: string;
  github_login: string;
  github_user_id: string | number;
  linked_at: Date;
}

const COLUMNS = 'identity, github_login, github_user_id, linked_at';

function toAccount(row: Row): PersonAccount {
  return {
    identity: row.identity,
    githubLogin: row.github_login,
    // bigint comes back as a string; a GitHub account id fits a number.
    githubUserId: Number(row.github_user_id),
    linkedAt: row.linked_at.toISOString(),
  };
}

/** Thrown when the account is already another person's. */
export class AccountLinkedElsewhere extends Error {
  constructor(readonly login: string) {
    super(`@${login} is already linked to another person here. They unlink it in Settings first.`);
    this.name = 'AccountLinkedElsewhere';
  }
}

/**
 * Links a person to the account they signed in as, replacing the one they had.
 * Refused when another person has linked that account: one account, one person.
 */
export async function link(input: { identity: string; githubLogin: string; githubUserId: number }): Promise<PersonAccount> {
  const row = await queryOne<Row>(
    `insert into person_github_accounts (identity, github_login, github_user_id)
       values ($1, $2, $3)
     on conflict (identity) do update
       set github_login = excluded.github_login, github_user_id = excluded.github_user_id, linked_at = now()
     where not exists (
       select 1 from person_github_accounts other
        where other.github_user_id = excluded.github_user_id and other.identity <> excluded.identity
     )
     returning ${COLUMNS}`,
    [input.identity, input.githubLogin, input.githubUserId],
  ).catch((error: unknown) => {
    // The unique id, held by another person, on a first link.
    if ((error as { code?: string } | null)?.code === '23505') return null;
    throw error;
  });
  if (!row) throw new AccountLinkedElsewhere(input.githubLogin);
  return toAccount(row);
}

/** Forgets a person's link; whether there was one. */
export async function unlink(identity: string): Promise<boolean> {
  const rows = await query<{ identity: string }>(`delete from person_github_accounts where identity = $1 returning identity`, [identity]);
  return rows.length > 0;
}

export async function ofIdentity(identity: string): Promise<PersonAccount | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from person_github_accounts where identity = $1`, [identity]);
  return row ? toAccount(row) : null;
}

export async function ofUserId(githubUserId: number): Promise<PersonAccount | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from person_github_accounts where github_user_id = $1`, [githubUserId]);
  return row ? toAccount(row) : null;
}
