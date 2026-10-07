import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, watchConnection, withTransaction } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  // Resolves both from src (tsx) and dist (compiled).
  return join(here, '..', 'migrations');
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Held for the whole run. A cloud install migrates from two places at once — the
 * bridge as its revision starts and the host as it boots — and without a lock
 * both read the same `schema_migrations`, both apply the same file, and the
 * second fails on the first's primary key halfway through a start.
 */
const MIGRATION_LOCK = 4_700_431;

export async function migrate(): Promise<MigrationResult> {
  const lock = await getPool().connect();
  const held = watchConnection(lock, 'migration lock');
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    return await migrateUnlocked();
  } finally {
    // Thrown away when it could not unlock, so its session, and the lock, end.
    const unlocked = await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).then(
      () => undefined,
      (error: unknown) => error,
    );
    held.release(unlocked);
  }
}

async function migrateUnlocked(): Promise<MigrationResult> {
  const pool = getPool();
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = readdirSync(migrationsDir())
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string }>('select name from schema_migrations');
  const done = new Set(rows.map((row) => row.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(migrationsDir(), file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }

  return { applied, skipped };
}
