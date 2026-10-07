import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

/** The client `migrate` holds the migration lock on, which pg-pool no longer listens to. */
class LockClient extends EventEmitter {
  released: unknown[] = [];
  onLocked: () => void = () => undefined;

  async query(text: string): Promise<{ rows: [] }> {
    if (/pg_advisory_lock/.test(text)) this.onLocked();
    return { rows: [] };
  }

  release(error?: unknown): void {
    this.released.push(error);
  }
}

const lock = new LockClient();

vi.mock('./client.js', async (original) => ({
  ...(await original<typeof import('./client.js')>()),
  getPool: () => ({
    connect: async () => lock,
    query: async (text: string) => ({ rows: /select name from schema_migrations/.test(text) ? readAll() : [] }),
  }),
}));

/** Every migration already applied, so `migrate` only takes and gives back its lock. */
function readAll(): { name: string }[] {
  return names;
}
let names: { name: string }[] = [];

const { migrate } = await import('./migrate.js');
const { readdirSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

describe('the migration lock', () => {
  it('survives its connection dying, and gives the dead connection back to be thrown away', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    names = readdirSync(dir).filter((file) => file.endsWith('.sql')).map((name) => ({ name }));
    const lost = new Error('terminating connection due to administrator command');
    // A Postgres restart while a migration runs: with nobody listening, the
    // 'error' ended the process.
    lock.onLocked = () => expect(() => lock.emit('error', lost)).not.toThrow();

    const result = await migrate();

    expect(result.applied).toEqual([]);
    expect(lock.released).toEqual([lost]);
    expect(lock.listenerCount('error')).toBe(0);
  });
});
