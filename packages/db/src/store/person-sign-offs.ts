import { query, withTransaction } from '../client.js';

/**
 * A pull request's author, named by AGENTS.md's Human review for its paths,
 * signing off from the console where GitHub refuses their own approval. See
 * `migrations/0167_person_sign_offs.sql` and
 * docs/adr/0063-an-author-who-is-the-named-person-signs-off-in-the-console.md.
 *
 * A row is a claim, not an approval on its own: `review-gate` and the merge
 * count it only for the pull request's author, matched by account id.
 */
export interface PersonSignOff {
  id: string;
  repoId: string;
  /** The repository's short name, as the wait reads key on it. */
  repoName: string;
  prNumber: number;
  head: string;
  githubUserId: number;
  githubLogin: string;
  identity: string;
  signedAt: string;
}

interface Row {
  id: string;
  repo_id: string;
  repo_name: string;
  pr_number: number;
  head: string;
  github_user_id: string | number;
  github_login: string;
  identity: string;
  signed_at: Date;
}

const COLUMNS = `s.id, s.repo_id, r.name as repo_name, s.pr_number, s.head, s.github_user_id, s.github_login, s.identity, s.signed_at`;
const FROM = 'person_sign_offs s join repos r on r.id = s.repo_id';

function toSignOff(row: Row): PersonSignOff {
  return {
    id: row.id,
    repoId: row.repo_id,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    head: row.head,
    // `bigint` comes back as a string.
    githubUserId: Number(row.github_user_id),
    githubLogin: row.github_login,
    identity: row.identity,
    signedAt: row.signed_at.toISOString(),
  };
}

/** The audit entry a sign-off is written with, in the same transaction. */
export interface SignOffAudit {
  actor: string;
  action: string;
  target: string;
  payload: Record<string, unknown>;
}

/**
 * Records one with its audit entry, in one transaction: both land or neither
 * does. Written one after the other, a failed audit row took the sign-off
 * back with a second write, and when that failed too a sign-off counted
 * toward `review-gate` and the merge with no audit entry at all (#322).
 *
 * A second press, in another tab, signs off nothing twice: it answers the
 * row already there with `created: false`, and its press is audited too.
 */
export async function record(
  input: {
    repoId: string;
    prNumber: number;
    head: string;
    githubUserId: number;
    githubLogin: string;
    identity: string;
  },
  audit: SignOffAudit,
): Promise<{ signOff: PersonSignOff; created: boolean }> {
  return withTransaction(async (client) => {
    const key = [input.repoId, input.prNumber, input.head, input.githubUserId];
    const inserted = (
      await client.query<Row>(
        `with added as (
           insert into person_sign_offs (repo_id, pr_number, head, github_user_id, github_login, identity)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (repo_id, pr_number, head, github_user_id) do nothing
           returning *
         )
         select ${COLUMNS} from added s join repos r on r.id = s.repo_id`,
        [...key, input.githubLogin, input.identity],
      )
    ).rows[0];
    const row = inserted ?? (await client.query<Row>(`select ${COLUMNS} from ${FROM} where s.repo_id = $1 and s.pr_number = $2 and s.head = $3 and s.github_user_id = $4`, key)).rows[0];
    if (!row) throw new Error(`the sign-off of #${input.prNumber} at ${input.head.slice(0, 7)} could not be recorded or read; try again`);
    await client.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [audit.actor, audit.action, audit.target, JSON.stringify(audit.payload)]);
    return { signOff: toSignOff(row), created: Boolean(inserted) };
  });
}

/** Every sign-off on one pull request, oldest first: what `review-gate` and the merge read. */
export async function forPull(repoId: string, prNumber: number): Promise<PersonSignOff[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where s.repo_id = $1 and s.pr_number = $2 order by s.signed_at, s.id`, [repoId, prNumber]);
  return rows.map(toSignOff);
}

/** Every sign-off since a moment, oldest first: what ends a held approval's card. */
export async function listSince(since: Date): Promise<PersonSignOff[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where s.signed_at >= $1 order by s.signed_at, s.id`, [since]);
  return rows.map(toSignOff);
}
