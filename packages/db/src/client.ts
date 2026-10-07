import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { envOr } from '@fleetadlc/shared';

let pool: Pool | undefined;

export function databaseUrl(): string {
  return envOr('DATABASE_URL', 'postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db');
}

/**
 * Where a database URL points, for a log line or an error: its database, host
 * and port, never its user or password. Masking the password inside the URL
 * missed one with an `@` in it and one given as `?password=`, and the line is
 * printed on every start, into Cloud Logging on a cloud install. Null when the
 * URL cannot be read, so nothing of it is printed.
 */
export function describeDatabase(url: string): string | null {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'the default database';
    const host = parsed.hostname || parsed.searchParams.get('host') || 'localhost';
    return `${name} on ${host}:${parsed.port || parsed.searchParams.get('port') || '5432'}`;
  } catch {
    return null;
  }
}

/**
 * How long a caller waits for a free connection before it is refused. With no
 * limit, a pool whose every connection was held by work waiting on the pool
 * itself stopped every query in the bridge for good — webhooks, the console,
 * the scheduler — while the process stayed alive for the keeper to see.
 * Tens of seconds, so a busy moment never reads as a full pool.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Advisory locks get a pool of their own, so the connection a lock is held on
 * is never one the locked work needs: ten callers inside `withAdvisoryLock` on
 * the one pool held all ten connections, and each body waited for an
 * eleventh. A waiter holds no connection here (`withAdvisoryLock` polls), so
 * this is the number of locks held at once: every seat's token minted in
 * parallel at start, one lock each, with the request queue's held around one
 * of them. Past it, a caller waits CONNECT_TIMEOUT_MS for one to come free.
 */
const LOCK_POOL_SIZE = 12;

let lockPool: Pool | undefined;

function newPool(which: string, max: number): Pool {
  const created = new Pool({ connectionString: databaseUrl(), max, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, keepAlive: true });
  created.on('error', (error) => {
    console.error(`[db] idle client error (${which} pool)`, error.message);
  });
  return created;
}

export function getPool(): Pool {
  if (!pool) pool = newPool('main', 10);
  return pool;
}

function getLockPool(): Pool {
  if (!lockPool) lockPool = newPool('lock', LOCK_POOL_SIZE);
  return lockPool;
}

/**
 * pg-pool's own words for a full pool are "timeout exceeded when trying to
 * connect", which names neither the pool nor a way out.
 */
function poolRanOut(which: 'main' | 'lock', error: unknown): unknown {
  if (!(error instanceof Error) || !/timeout exceeded when trying to connect/.test(error.message)) return error;
  const seconds = CONNECT_TIMEOUT_MS / 1000;
  return new Error(
    which === 'main'
      ? `the database's main pool had no free connection for ${seconds}s: every one is in use. ` +
          'If this keeps happening, restart the service and report it with the log before this line.'
      : `the database's lock pool had no free connection for ${seconds}s: ${LOCK_POOL_SIZE} advisory locks are held at once. ` +
          'If this keeps happening, restart the service and report it with the log before this line.',
    { cause: error },
  );
}

async function connect(which: 'main' | 'lock'): Promise<PoolClient> {
  try {
    return await (which === 'main' ? getPool() : getLockPool()).connect();
  } catch (error) {
    throw poolRanOut(which, error);
  }
}

/**
 * Listens for the death of a connection held out of the pool. pg-pool takes
 * its own error listener off a client it hands out, so a connection that died
 * while held — a Postgres restart, a failover, a proxy's idle timeout —
 * emitted 'error' with nobody listening, and Node ended the process: in the
 * middle of a token refresh, losing the rotated refresh token. The work in
 * progress fails on its next query instead, and `release` hands the pool back
 * the error so it discards the connection rather than lending it again.
 */
export function watchConnection(client: PoolClient, what: string): { release(error?: unknown): void } {
  let lost: Error | undefined;
  const onError = (error: Error) => {
    console.error(`[db] ${what}: connection lost`, error.message);
    lost = error;
  };
  client.on('error', onError);
  return {
    release(error?: unknown) {
      client.off('error', onError);
      const broken = lost ?? (error instanceof Error ? error : undefined);
      client.release(broken);
    },
  };
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    const result = await getPool().query<T>(text, params as unknown[]);
    return result.rows;
  } catch (error) {
    throw poolRanOut('main', error);
  }
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connect('main');
  const held = watchConnection(client, 'transaction');
  let broken: unknown;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    // A rollback on a dead connection fails too, and its error used to replace
    // the one that says what went wrong.
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      console.error('[db] transaction: rollback failed', rollbackError instanceof Error ? rollbackError.message : rollbackError);
      broken = rollbackError;
    }
    throw error;
  } finally {
    held.release(broken);
  }
}

/** Ends both pools, so a script can exit. */
export async function closePool(): Promise<void> {
  const ending = [pool, lockPool];
  pool = undefined;
  lockPool = undefined;
  await Promise.all(ending.map((each) => each?.end()));
}

export async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await query('select 1');
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** How long a waiter sleeps between tries for a lock someone else holds. */
const LOCK_RETRY_MS = { first: 20, most: 250 };

/**
 * Runs `fn` while holding a Postgres advisory lock named by `key`, across every
 * process on this database — two bridges during a rollout included.
 *
 * The lock is held on a connection from the lock pool, which `fn`'s queries
 * never use. A waiter does not sit on a connection while another holds the
 * lock: it asks with `pg_try_advisory_lock`, gives the connection back when
 * the answer is no, and asks again a little later. Waiting inside
 * `pg_advisory_lock` held a connection per waiter, so a burst on one key, or a
 * lock taken inside another (the request queue's, around a token mint), could
 * leave the holder no connection to finish with.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let wait = LOCK_RETRY_MS.first;
  for (;;) {
    const client = await connect('lock');
    const held = watchConnection(client, `lock ${key}`);
    let got = false;
    try {
      const { rows } = await client.query<{ got: boolean }>('select pg_try_advisory_lock(hashtext($1)) as got', [key]);
      got = rows[0]?.got === true;
    } catch (error) {
      held.release(error);
      throw error;
    }
    if (!got) {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, LOCK_RETRY_MS.most);
      continue;
    }
    try {
      return await fn();
    } finally {
      // A connection that could not unlock may still hold the lock: thrown
      // away, its session ends and the lock with it.
      const unlocked = await client.query('select pg_advisory_unlock(hashtext($1))', [key]).then(
        () => undefined,
        (error: unknown) => error,
      );
      held.release(unlocked);
    }
  }
}
