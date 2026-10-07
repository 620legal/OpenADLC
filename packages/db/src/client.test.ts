import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A stand-in for `pg` that keeps to what the bugs depended on: a pool lends at
 * most `max` clients and makes the rest wait (forever, unless
 * `connectionTimeoutMillis` is set), advisory locks are held per client, and
 * a client is an EventEmitter that pg-pool stops listening to once lent, so an
 * 'error' nobody listens for throws.
 */
class FakeClient extends EventEmitter {
  dead = false;
  failRollback = false;
  released: unknown[] = [];

  constructor(readonly pool: FakePool) {
    super();
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    await Promise.resolve();
    if (this.dead) throw new Error('Connection terminated unexpectedly');
    const key = params[0];
    if (/pg_try_advisory_lock/.test(text)) {
      if (locks.has(key)) return { rows: [{ got: false }] };
      locks.set(key, this);
      return { rows: [{ got: true }] };
    }
    if (/pg_advisory_lock/.test(text)) {
      while (locks.has(key)) await new Promise<void>((resolve) => unlocked.push(resolve));
      locks.set(key, this);
      return { rows: [] };
    }
    if (/pg_advisory_unlock/.test(text)) {
      if (locks.get(key) === this) locks.delete(key);
      unlocked.splice(0).forEach((wake) => wake());
      return { rows: [] };
    }
    if (text === 'rollback' && this.failRollback) throw new Error('rollback failed: connection gone');
    return { rows: [] };
  }

  release(error?: unknown): void {
    this.released.push(error);
    this.pool.giveBack(this, error);
  }
}

class FakePool extends EventEmitter {
  static made: FakePool[] = [];
  readonly max: number;
  readonly timeout: number | undefined;
  lent = 0;
  ended = false;
  clients: FakeClient[] = [];
  private waiting: { give(client: FakeClient): void }[] = [];

  constructor(options: { max?: number; connectionTimeoutMillis?: number }) {
    super();
    this.max = options.max ?? 10;
    this.timeout = options.connectionTimeoutMillis;
    FakePool.made.push(this);
  }

  connect(): Promise<FakeClient> {
    if (this.lent < this.max) return Promise.resolve(this.lend());
    return new Promise((resolve, reject) => {
      const waiter = { give: (client: FakeClient) => resolve(client) };
      this.waiting.push(waiter);
      if (this.timeout) {
        setTimeout(() => {
          const at = this.waiting.indexOf(waiter);
          if (at < 0) return;
          this.waiting.splice(at, 1);
          reject(new Error('timeout exceeded when trying to connect'));
        }, this.timeout);
      }
    });
  }

  async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const client = await this.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  giveBack(client: FakeClient, error?: unknown): void {
    this.lent -= 1;
    const next = this.waiting.shift();
    if (next) {
      // A client released with an error is thrown away; the next waiter gets a new one.
      next.give(error ? this.lend() : this.relend(client));
    }
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  private lend(): FakeClient {
    const client = new FakeClient(this);
    this.clients.push(client);
    this.lent += 1;
    return client;
  }

  private relend(client: FakeClient): FakeClient {
    this.lent += 1;
    return client;
  }
}

let locks = new Map<unknown, FakeClient>();
let unlocked: (() => void)[] = [];

vi.mock('pg', () => ({ Pool: FakePool }));

const db = await import('./client.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

beforeEach(() => {
  locks = new Map();
  unlocked = [];
  FakePool.made = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await db.closePool();
});

describe('advisory locks and the pool the work queries through', () => {
  it('lets twenty callers at once, each querying inside its lock, all finish', async () => {
    // On one pool of ten, ten lock holders took every connection and each body
    // waited for an eleventh: every query in the bridge hung for good.
    const done = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        db.withAdvisoryLock(`seat:${n}`, async () => {
          await tick();
          await db.query('select 1');
          return n;
        }),
      ),
    );
    expect(done).toEqual(Array.from({ length: 20 }, (_, n) => n));
    expect(locks.size).toBe(0);
  });

  it('lets a burst on one key finish, one at a time, without a waiter holding a connection', async () => {
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        db.withAdvisoryLock('bridge:testing-deploy', async () => {
          inside += 1;
          most = Math.max(most, inside);
          await db.query('select 1');
          inside -= 1;
        }),
      ),
    );
    expect(most).toBe(1);
    const lockPool = FakePool.made.find((made) => made.max !== 10);
    expect(lockPool?.lent).toBe(0);
  });

  it('finishes a lock taken inside another, while others queue for the outer one', async () => {
    // The request queue's drain holds its lock across a start that mints a
    // token under the token broker's lock.
    const drains = Array.from({ length: 15 }, () =>
      db.withAdvisoryLock('bridge:request-queue', () =>
        db.withAdvisoryLock('token:builder-1', async () => {
          await db.query('select 1');
          return 'minted';
        }),
      ),
    );
    expect(await Promise.all(drains)).toEqual(Array(15).fill('minted'));
  });

  it('refuses, naming the lock pool, when every lock connection stays held', async () => {
    vi.useFakeTimers();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const holders = Array.from({ length: 12 }, (_, n) => db.withAdvisoryLock(`held:${n}`, () => gate));
    await vi.advanceTimersByTimeAsync(10);
    const late = db.withAdvisoryLock('one-more', async () => 'never');
    const refused = expect(late).rejects.toThrow(/lock pool had no free connection for 30s/);
    await vi.advanceTimersByTimeAsync(30_000);
    await refused;
    open();
    await Promise.all(holders);
  });

  it('refuses a query, naming the main pool, when every connection stays held', async () => {
    vi.useFakeTimers();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const holders = Array.from({ length: 10 }, () => db.withTransaction(() => gate));
    await vi.advanceTimersByTimeAsync(10);
    const refused = expect(db.query('select 1')).rejects.toThrow(/main pool had no free connection for 30s/);
    await vi.advanceTimersByTimeAsync(30_000);
    await refused;
    open();
    await Promise.all(holders);
  });

  it('ends both pools', async () => {
    await db.withAdvisoryLock('k', () => db.query('select 1'));
    expect(FakePool.made).toHaveLength(2);
    await db.closePool();
    expect(FakePool.made.every((made) => made.ended)).toBe(true);
  });
});

describe('a held connection that dies', () => {
  it('does not end the process when the lock connection dies, and is released to be thrown away', async () => {
    // pg-pool takes its listener off a lent client; an 'error' with no listener
    // throws, and Node ended the bridge in the middle of a token refresh.
    const lost = new Error('terminating connection due to administrator command');
    const result = await db.withAdvisoryLock('token:builder-1', async () => {
      const holder = locks.get('token:builder-1')!;
      expect(() => holder.emit('error', lost)).not.toThrow();
      holder.dead = true;
      return 'carried on';
    });
    expect(result).toBe('carried on');
    const holder = FakePool.made.flatMap((made) => made.clients).find((client) => client.dead)!;
    expect(holder.released).toEqual([lost]);
    expect(holder.listenerCount('error')).toBe(0);
  });

  it('does not end the process when a transaction’s connection dies, and the caller sees the failure', async () => {
    const lost = new Error('terminating connection due to administrator command');
    let client: FakeClient | undefined;
    const failed = db.withTransaction(async (lent) => {
      client = lent as unknown as FakeClient;
      expect(() => client!.emit('error', lost)).not.toThrow();
      client.dead = true;
      await lent.query('select 1');
    });
    await expect(failed).rejects.toThrow(/Connection terminated unexpectedly/);
    expect(client?.released).toEqual([lost]);
    expect(client?.listenerCount('error')).toBe(0);
  });

  it('rejects with the work’s own error when the rollback fails too', async () => {
    const failed = db.withTransaction(async (lent) => {
      (lent as unknown as FakeClient).failRollback = true;
      throw new Error('duplicate key value violates unique constraint');
    });
    await expect(failed).rejects.toThrow('duplicate key value violates unique constraint');
    const client = FakePool.made[0]!.clients[0]!;
    // The connection that could not roll back is not lent again.
    expect(client.released[0]).toBeInstanceOf(Error);
  });
});

describe('where a database URL points, as a log line says it', () => {
  it('names the database, host and port, and nothing of the sign-in', () => {
    expect(db.describeDatabase('postgres://fleetadlc:s3cret@db:5432/fleetadlc_db')).toBe('fleetadlc_db on db:5432');
  });

  it('keeps a password with an @ in it, or given as a parameter, out of the line', () => {
    const one = db.describeDatabase('postgres://fleet:p@ss@db.example.com/fleetadlc_db');
    const two = db.describeDatabase('postgres://fleet@db.example.com:6543/fleetadlc_db?password=s3cret&sslpassword=k3y');
    expect(one).toBe('fleetadlc_db on db.example.com:5432');
    expect(two).toBe('fleetadlc_db on db.example.com:6543');
    for (const line of [one, two]) {
      expect(line).not.toMatch(/ss|s3cret|k3y|fleet@/);
    }
  });

  it('says nothing of a URL it cannot read', () => {
    expect(db.describeDatabase('not a url: secret')).toBeNull();
  });
});
