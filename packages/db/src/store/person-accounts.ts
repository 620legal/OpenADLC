import { queryOne } from '../client.js';
import { AccountLinkedElsewhere, linkAccount, unlinkAccount } from './people.js';
import { normalizeEmail } from './users.js';

export { AccountLinkedElsewhere };

/**
 * The GitHub account each console person proved is theirs, by signing in as
 * it (the bridge's `person-github.ts`). Kept on the person's row in `people`
 * since 0162 (`github_login`, `github_user_id`, `github_linked_at`); this is
 * the view sign-offs read, and only a confirmed link counts: a login an admin
 * named is not the person's proof. A login and an id; never a token.
 */
export interface PersonAccount {
  identity: string;
  githubLogin: string;
  githubUserId: number;
  linkedAt: string;
}

interface Row {
  id: string;
  email: string | null;
  github_login: string;
  github_user_id: string | number;
  github_linked_at: Date;
}

const LINKED = 'id, email, github_login, github_user_id, github_linked_at';

function toAccount(row: Row): PersonAccount {
  return {
    identity: row.email ?? row.id,
    githubLogin: row.github_login,
    githubUserId: Number(row.github_user_id),
    linkedAt: row.github_linked_at.toISOString(),
  };
}

/**
 * Links a person to the account they signed in as, replacing the one they had.
 * Refused when another person has linked that account: one account, one person.
 * `personId` names the person outright (the operator, on a local install);
 * without it the person is the one signed in with `identity`.
 */
export async function link(input: { identity: string; githubLogin: string; githubUserId: number; personId?: string }): Promise<PersonAccount> {
  const person = await linkAccount(input, input.identity);
  return {
    identity: person.email ?? person.id,
    githubLogin: person.githubLogin ?? input.githubLogin,
    githubUserId: person.githubUserId ?? input.githubUserId,
    linkedAt: person.githubLinkedAt ?? new Date().toISOString(),
  };
}

/** Forgets a person's link; whether there was one. */
export async function unlink(identity: string, personId?: string): Promise<boolean> {
  return (await unlinkAccount(personId ? { personId } : { identity })) !== null;
}

export async function ofIdentity(identity: string): Promise<PersonAccount | null> {
  const row = await queryOne<Row>(`select ${LINKED} from people where email = $1 and github_linked_at is not null`, [normalizeEmail(identity)]);
  return row ? toAccount(row) : null;
}

export async function ofPerson(personId: string): Promise<PersonAccount | null> {
  const row = await queryOne<Row>(`select ${LINKED} from people where id::text = $1 and github_linked_at is not null`, [personId]);
  return row ? toAccount(row) : null;
}

export async function ofUserId(githubUserId: number): Promise<PersonAccount | null> {
  const row = await queryOne<Row>(`select ${LINKED} from people where github_user_id = $1 and github_linked_at is not null`, [githubUserId]);
  return row ? toAccount(row) : null;
}
