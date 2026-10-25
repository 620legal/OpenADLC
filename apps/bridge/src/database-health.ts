import { databaseAddress, databaseNotAnswering, databaseUrl, query } from '@openadlc/db';

/**
 * How long `/healthz` waits on the database. The pool waits thirty seconds
 * for a free connection, and a health check that hangs that long reads as a
 * bridge that is not answering at all.
 */
const DATABASE_ASK_MS = 3_000;

/**
 * Why the bridge cannot use its database, in words a person can act on, or
 * null when it answers.
 *
 * After OrbStack restarted and left `openadlc-db` down, every request the
 * bridge served, `/healthz` included, failed with a bare
 * `connect ECONNREFUSED 127.0.0.1:47432`, and the console showed that or
 * nothing. The container is named only when `openadlc up` said which it is
 * (`OPENADLC_DATABASE_CONTAINER`): the bridge runs no Docker of its own.
 *
 * A server that answered and refused — a password it does not take, a
 * database it does not have — is up, and `docker start` would be the wrong
 * thing to tell anyone; pg's errors from the server carry a `severity`.
 */
export async function databaseProblem(
  options: { ask?: () => Promise<unknown>; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const ask = options.ask ?? (() => query('select 1'));
  let timer: NodeJS.Timeout | undefined;
  const failure = await Promise.race([
    // Through a promise, so a throw before the query is a failure like any other, not a 500 of its own.
    Promise.resolve().then(ask).then(
      () => null,
      (error: unknown) => error ?? new Error('the database failed and said nothing'),
    ),
    new Promise<Error>((resolve) => {
      timer = setTimeout(() => resolve(new Error('timed out')), options.timeoutMs ?? DATABASE_ASK_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (failure === null) return null;

  const url = env.DATABASE_URL || databaseUrl();
  if (typeof (failure as { severity?: unknown }).severity === 'string') {
    const said = failure instanceof Error ? failure.message : String(failure);
    return `the install's database on ${databaseAddress(url) ?? 'the address in DATABASE_URL'} answered the bridge with an error: ${said}`;
  }
  const said = databaseNotAnswering(url, env.OPENADLC_DATABASE_CONTAINER?.trim() || null);
  return `${said.message}: ${said.remedy}`;
}
