import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DispatchGate } from './dispatch-gate.js';
import { pauseFrom, refuseWhilePaused, registerPauseRoutes, repoPausesFrom, restorePause, UNREAD_WORDS } from './pause-work.js';
import { Router } from './router.js';

/**
 * Pausing new work from Settings: a stored pause the dispatch gate holds, so
 * every lease is refused until someone resumes, and a restart is still paused.
 */

let stored: string | null;
let storedRepos: string | null;
let audited: { action: string; actor: string; target: string; payload?: Record<string, unknown> }[];
let resumedWith: (string[] | undefined)[];

const REPOSITORIES = [
  { name: 'api', fullName: 'exampleco/api' },
  { name: 'web', fullName: 'exampleco/web' },
];

/** An advisory lock as Postgres holds one: a second taker waits for the first to let go. */
function sharedLock() {
  let held: Promise<unknown> = Promise.resolve();
  return <T,>(_key: string, fn: () => Promise<T>): Promise<T> => {
    const run = held.catch(() => undefined).then(fn);
    held = run.catch(() => undefined);
    return run;
  };
}

/** What the routes read and write, kept in memory. */
const inMemory = () => ({
  read: async () => stored,
  write: async (value: string) => void (stored = value || null),
  readRepos: async () => storedRepos,
  writeRepos: async (value: string) => void (storedRepos = value || null),
  repositories: async () => REPOSITORIES,
  exclusive: sharedLock(),
  audit: async (entry: (typeof audited)[number]) => void audited.push(entry),
  resumed: (repos?: string[]) => void resumedWith.push(repos),
});
let gate: DispatchGate;
let server: Server;
let url: string;

beforeEach(async () => {
  stored = null;
  storedRepos = null;
  audited = [];
  resumedWith = [];
  gate = new DispatchGate();
  const router = new Router();
  registerPauseRoutes(router, gate, inMemory());
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = (path: string, body?: unknown) =>
  fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('pausing work', () => {
  it('stores who paused and why, holds the gate in words that say where to resume, and audits it', async () => {
    const response = await call('/v1/work/pause', { reason: 'an account may be compromised' });
    expect(response.status).toBe(200);
    expect(pauseFrom(stored)).toMatchObject({ reason: 'an account may be compromised' });
    expect(gate.paused()).toMatch(/^work is paused, by .+ \(an account may be compromised\); resume it in Settings → Pause work$/);
    expect(audited.map((entry) => entry.action)).toEqual(['work.paused']);
    expect(((await (await call('/v1/work/pause')).json()) as { paused: unknown }).paused).toMatchObject({ reason: 'an account may be compromised' });
  });

  it('resumes: the gate lets leases go, the setting is cleared, and that is audited too', async () => {
    await call('/v1/work/pause', {});
    expect((await call('/v1/work/resume', {})).status).toBe(200);
    expect(stored).toBeNull();
    expect(gate.paused()).toBeNull();
    expect(audited.map((entry) => entry.action)).toEqual(['work.paused', 'work.resumed']);
    expect((await call('/v1/work/resume', {})).status).toBe(409);
  });

  it('outlasts a restart: the stored pause holds the gate again', async () => {
    const restarted = new DispatchGate();
    await restorePause({ gate: restarted, read: async () => JSON.stringify({ by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: null }) });
    expect(restarted.paused()).toBe('work is paused, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');

    const unpaused = new DispatchGate();
    await restorePause({ gate: unpaused, read: async () => null });
    expect(unpaused.paused()).toBeNull();
  });

  it('comes before a restore’s hold, and leaves it standing after a resume', () => {
    const release = gate.hold('paused while a backup is restored');
    gate.pauseWork('work is paused');
    expect(gate.paused()).toBe('work is paused');
    gate.pauseWork(null);
    expect(gate.paused()).toBe('paused while a backup is restored');
    release();
    expect(gate.paused()).toBeNull();
  });
});

describe('a pause that cannot be read', () => {
  it('keeps work paused as the bridge starts, says so, and reads again until it can', async () => {
    const logged: string[] = [];
    const later: (() => void)[] = [];
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads === 1) throw new Error('connection refused');
      return null;
    };
    await restorePause({ gate, read }, { log: (line) => logged.push(line), schedule: (fn) => void later.push(fn) });

    // Fail closed: a restart during a database hiccup does not resume a pause.
    expect(gate.paused()).toBe(UNREAD_WORDS);
    expect(logged[0]).toMatch(/could not read whether work is paused, so it stays paused.*connection refused/);
    expect(later).toHaveLength(1);

    // Read again: nobody had paused it, so work goes on.
    later[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    expect(gate.paused()).toBeNull();
  });

  it('holds what it then reads', async () => {
    const later: (() => void)[] = [];
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads === 1) throw new Error('timeout');
      return JSON.stringify({ by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'an account may be compromised' });
    };
    await restorePause({ gate, read }, { log: () => undefined, schedule: (fn) => void later.push(fn) });
    later[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gate.paused()).toMatch(/^work is paused, by janedoe/);
  });

  it('shows as a pause on the board, and a person can resume it', async () => {
    gate.pauseWork(UNREAD_WORDS);
    const shown = (await (await call('/v1/work/pause')).json()) as { paused: { by: string; reason: string } | null };
    expect(shown.paused).toMatchObject({ by: 'the bridge', reason: expect.stringContaining('could not read') });

    expect((await call('/v1/work/resume', {})).status).toBe(200);
    expect(gate.paused()).toBeNull();
    expect(audited.map((entry) => entry.action)).toEqual(['work.resumed']);
  });
});

describe('resuming', () => {
  it('starts what waited through the pause', async () => {
    const router = new Router();
    const drained: number[] = [];
    registerPauseRoutes(router, gate, { ...inMemory(), resumed: () => void drained.push(1) });
    const other = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const at = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      const post = (path: string) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await post('/v1/work/pause');
      expect(drained).toEqual([]);
      await post('/v1/work/resume');
      expect(drained).toEqual([1]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

describe('every other start', () => {
  it('is refused while paused, in the pause’s words, and let through otherwise', () => {
    expect(() => refuseWhilePaused(gate)).not.toThrow();
    gate.pauseWork('work is paused, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');
    expect(() => refuseWhilePaused(gate)).toThrow(/^nothing new starts: work is paused, by janedoe/);
    gate.pauseWork(null);
    const release = gate.hold('paused while a backup is restored');
    expect(() => refuseWhilePaused(gate)).toThrow(/backup is restored/);
    release();
  });
});

describe('pausing some repositories and not others', () => {
  const state = async () => (await (await call('/v1/work/pause')).json()) as { paused: unknown; repos: Record<string, { by: string; reason: string | null }> };

  it('pauses the named ones only, in words naming whose pause it is, with one audit row each', async () => {
    const response = await call('/v1/work/pause', { reason: 'a migration is running', repos: ['exampleco/api'] });
    expect(response.status).toBe(200);

    expect(gate.paused()).toBeNull();
    expect(gate.paused('web')).toBeNull();
    expect(gate.paused('api')).toMatch(/^work is paused in api, by .+ \(a migration is running\); resume it in Settings → Pause work$/);
    expect(repoPausesFrom(storedRepos)!).toMatchObject({ api: { reason: 'a migration is running' } });
    expect(stored).toBeNull();
    expect(audited).toEqual([expect.objectContaining({ action: 'work.paused', target: 'repo:api', payload: { reason: 'a migration is running' } })]);

    const shown = await state();
    expect(shown.paused).toBeNull();
    expect(Object.keys(shown.repos)).toEqual(['api']);
  });

  it('leaves a repository already paused as it was, pauses the rest, and audits only those', async () => {
    const incident = { by: 'oncall', at: '2026-09-29T10:00:00.000Z', reason: 'an account may be compromised' };
    storedRepos = JSON.stringify({ api: incident });

    const response = await call('/v1/work/pause', { reason: '', repos: ['api', 'web'] });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { repos: Record<string, unknown> }).repos.api).toEqual(incident);
    expect(repoPausesFrom(storedRepos)!.api).toEqual(incident);
    expect(repoPausesFrom(storedRepos)!.web).toMatchObject({ reason: null });
    expect(audited).toEqual([expect.objectContaining({ action: 'work.paused', target: 'repo:web' })]);
  });

  it('refuses a repository OpenADLC does not work in, and pauses nothing', async () => {
    const response = await call('/v1/work/pause', { repos: ['api', 'exampleco/nope'] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/exampleco\/nope/);
    expect(gate.paused('api')).toBeNull();
    expect(audited).toEqual([]);

    expect((await call('/v1/work/pause', { repos: [] })).status).toBe(400);
    expect((await call('/v1/work/resume', { repos: ['nope'] })).status).toBe(400);
  });

  it('resumes one, audits it, and starts what that one held', async () => {
    await call('/v1/work/pause', { repos: ['api', 'web'] });
    audited = [];

    expect((await call('/v1/work/resume', { repos: ['api'] })).status).toBe(200);
    expect(gate.paused('api')).toBeNull();
    expect(gate.paused('web')).toMatch(/paused in web/);
    expect(Object.keys(repoPausesFrom(storedRepos)!)).toEqual(['web']);
    expect(audited).toEqual([expect.objectContaining({ action: 'work.resumed', target: 'repo:api' })]);
    expect(resumedWith).toEqual([['api']]);

    const again = await call('/v1/work/resume', { repos: ['api'] });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('api is not paused on its own');
  });

  it('says two repositories that are not paused are not paused on their own', async () => {
    const refused = await call('/v1/work/resume', { repos: ['api', 'web'] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('api, web are not paused on their own');
  });

  it('resumes everything, the install and each repository, one audit row each', async () => {
    await call('/v1/work/pause', { repos: ['api', 'web'] });
    await call('/v1/work/pause', {});
    audited = [];

    expect((await call('/v1/work/resume', {})).status).toBe(200);
    expect(gate.paused()).toBeNull();
    expect(gate.paused('api')).toBeNull();
    expect(gate.paused('web')).toBeNull();
    expect(stored).toBeNull();
    expect(storedRepos).toBeNull();
    expect(audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual(['work.resumed dispatch', 'work.resumed repo:api', 'work.resumed repo:web']);
    expect(resumedWith).toEqual([undefined]);
  });

  it('keeps both of two pauses asked for at once, each writing what the other wrote', async () => {
    // A read slow enough that, unlocked, both would read the empty setting.
    const router = new Router();
    const slow = {
      ...inMemory(),
      readRepos: async () => {
        const read = storedRepos;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return read;
      },
    };
    registerPauseRoutes(router, gate, slow);
    const other = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const at = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      const post = (repos: string[]) =>
        fetch(`${at}/v1/work/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repos }) });
      await Promise.all([post(['api']), post(['web'])]);
      expect(Object.keys(repoPausesFrom(storedRepos)!).sort()).toEqual(['api', 'web']);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('keeps both of two resumes asked for at once, neither writing back the other’s pause', async () => {
    await call('/v1/work/pause', { repos: ['api', 'web'] });
    const router = new Router();
    const slow = {
      ...inMemory(),
      readRepos: async () => {
        const read = storedRepos;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return read;
      },
    };
    registerPauseRoutes(router, gate, slow);
    const other = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const at = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      const resume = (repos: string[]) =>
        fetch(`${at}/v1/work/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repos }) });
      const answers = await Promise.all([resume(['api']), resume(['web'])]);
      expect(answers.map((one) => one.status)).toEqual([200, 200]);
      // Unlocked, each read both pauses and wrote back the other's.
      expect(storedRepos).toBeNull();
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('holds everything when the stored pauses do not read, as the dispatcher on its own does, until everything is resumed', async () => {
    const restarted = new DispatchGate();
    const later: (() => void)[] = [];
    const logged: string[] = [];
    await restorePause(
      { gate: restarted, read: async () => null, readRepos: async () => 'not json' },
      { log: (line) => logged.push(line), schedule: (fn) => void later.push(fn) },
    );
    expect(restarted.paused()).toBe(UNREAD_WORDS);
    expect(logged[0]).toMatch(/does not read/);
    expect(later).toHaveLength(1);

    // An entry that does not read is still a pause.
    expect(Object.keys(repoPausesFrom(JSON.stringify({ api: { nonsense: true } }))!)).toEqual(['api']);
    expect(repoPausesFrom('["api"]')).toBeNull();

    // Keeping the repositories' pauses is refused: which they are is what did not read.
    storedRepos = 'not json';
    gate.pauseWork(UNREAD_WORDS);
    expect((await call('/v1/work/resume', { keepRepos: true })).status).toBe(409);
    expect((await call('/v1/work/resume', {})).status).toBe(200);
    expect(storedRepos).toBeNull();
    expect(gate.paused()).toBeNull();
  });

  it('can lift the install’s pause alone, keeping each repository’s own, and says which it kept', async () => {
    await call('/v1/work/pause', { repos: ['api'] });
    await call('/v1/work/pause', {});
    audited = [];

    const response = await call('/v1/work/resume', { keepRepos: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { repos: Record<string, unknown> }).repos).toHaveProperty('api');
    expect(gate.paused()).toBeNull();
    expect(gate.paused('web')).toBeNull();
    expect(gate.paused('api')).toMatch(/paused in api/);
    expect(stored).toBeNull();
    expect(Object.keys(repoPausesFrom(storedRepos)!)).toEqual(['api']);
    expect(audited).toEqual([expect.objectContaining({ action: 'work.resumed', target: 'dispatch', payload: expect.objectContaining({ keptPaused: ['api'] }) })]);

    expect((await call('/v1/work/resume', { keepRepos: true })).status).toBe(409);
    expect((await call('/v1/work/resume', { keepRepos: true, repos: ['api'] })).status).toBe(400);
  });

  it('comes after the install’s pause: every repository is held by that, and a repository’s own by it alone', async () => {
    await call('/v1/work/pause', { repos: ['api'] });
    await call('/v1/work/pause', { reason: 'an account may be compromised' });
    expect(gate.paused('web')).toMatch(/^work is paused, by/);
    expect(gate.paused('api')).toMatch(/^work is paused, by/);
  });

  it('outlasts a restart, and a repository it no longer holds is let go', async () => {
    const restarted = new DispatchGate();
    restarted.pauseRepo('web', 'stale');
    await restorePause({
      gate: restarted,
      read: async () => null,
      readRepos: async () => JSON.stringify({ api: { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: null } }),
    });
    expect(restarted.paused()).toBeNull();
    expect(restarted.paused('api')).toBe('work is paused in api, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');
    expect(restarted.paused('web')).toBeNull();
  });

  it('keeps everything paused when the repositories’ pauses cannot be read as the bridge starts', async () => {
    const restarted = new DispatchGate();
    await restorePause(
      { gate: restarted, read: async () => null, readRepos: async () => Promise.reject(new Error('timeout')) },
      { log: () => undefined, schedule: () => undefined },
    );
    expect(restarted.paused()).toBe(UNREAD_WORDS);
  });

  describe('after a start that could not read them', () => {
    const API_PAUSE = JSON.stringify({ api: { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'an incident' } });

    /** The bridge's start, on the routes' own gate, whose first read of the repositories' pauses fails. */
    async function startUnread(): Promise<(() => void)[]> {
      storedRepos = API_PAUSE;
      let reads = 0;
      const later: (() => void)[] = [];
      await restorePause(
        {
          gate,
          read: async () => stored,
          readRepos: async () => {
            reads += 1;
            if (reads === 1) throw new Error('connection terminated');
            return storedRepos;
          },
        },
        { log: () => undefined, schedule: (fn) => void later.push(fn) },
      );
      expect(gate.paused()).toBe(UNREAD_WORDS);
      return later;
    }

    it('keeps a repository paused on the gate when the install alone is resumed before the re-read', async () => {
      const later = await startUnread();

      const response = await call('/v1/work/resume', { keepRepos: true });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { repos: Record<string, unknown> }).repos).toHaveProperty('api');
      // The re-read gives up now that the hold is a person's word, not the unread one.
      for (const fn of later) fn();

      expect(gate.paused()).toBeNull();
      expect(gate.paused('api')).not.toBeNull();
      expect(gate.paused('web')).toBeNull();
    });

    it('keeps it paused through an install-wide pause in that window and a later resume of the install alone', async () => {
      const later = await startUnread();

      expect((await call('/v1/work/pause', { reason: 'looking into it' })).status).toBe(200);
      expect(gate.pausedRepos()).toEqual(['api']);
      for (const fn of later) fn();
      expect((await call('/v1/work/resume', { keepRepos: true })).status).toBe(200);

      expect(gate.paused()).toBeNull();
      expect(gate.paused('api')).not.toBeNull();
    });
  });

  it('refuses every other start in that repository, and lets the rest through', () => {
    gate.pauseRepo('api', 'work is paused in api, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');
    expect(() => refuseWhilePaused(gate, 'api')).toThrow(/^nothing new starts: work is paused in api, by janedoe/);
    expect(() => refuseWhilePaused(gate, 'web')).not.toThrow();
    expect(() => refuseWhilePaused(gate)).not.toThrow();
  });
});

/**
 * A bridge started without the dispatcher leases nothing whether or not work
 * is paused, so the pause's answer says that too: Settings and the
 * board read it rather than saying work runs.
 */
describe('whether anything dispatches', () => {
  it('is said with the pause, and taken as so when the bridge is not told otherwise', async () => {
    expect(await (await call('/v1/work/pause')).json()).toEqual({ paused: null, repos: {}, dispatching: true });
  });

  it('is false on a bridge without the dispatcher, paused or not', async () => {
    const router = new Router();
    registerPauseRoutes(router, new DispatchGate(), { ...inMemory(), dispatching: false });
    const off = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => off.listen(0, '127.0.0.1', resolve));
    const at = `http://127.0.0.1:${(off.address() as AddressInfo).port}/v1/work/pause`;
    try {
      expect(await (await fetch(at)).json()).toMatchObject({ paused: null, dispatching: false });
      await fetch(at, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(await (await fetch(at)).json()).toMatchObject({ paused: { by: expect.any(String) }, dispatching: false });
    } finally {
      await new Promise<void>((resolve) => off.close(() => resolve()));
    }
  });
});
