import { describe, expect, it, vi } from 'vitest';
import {
  BackupError,
  EVERYTHING,
  NOTHING_HELD,
  buildBackup,
  type BackupContents,
  type InstallSnapshot,
  type RestoreJournal,
  type UndoDb,
  type UndoStore,
} from '@fleetadlc/backup';
import { DispatchGate } from './dispatch-gate.js';
import { resyncPause } from './pause-work.js';
import { RestoreInto, affectedSeats, sweepExpiredUndo, type RestoreIntoDeps, type RestoreJobView } from './restore-into.js';

/**
 * Restoring into an install that is in use, as the bridge runs it: after the
 * bots it changes are idle, holding them and the dispatcher, with a backup
 * taken first — and undoing it. What is compared and written is
 * `@fleetadlc/backup`'s and tested there; this is the order things happen in.
 */

const NOW = new Date('2026-09-25T10:00:00.000Z');
const REVIEWER_REFRESH = 'ghr_zzz-reviewer-zzz';
const KEY = 'sk-ant-api-zzz-refused-zzz';
const KEY_ACCOUNT = '11111111-1111-4111-8111-111111111111';

/** The install being restored into: a builder, and a reviewer connected as another account. */
function here(): InstallSnapshot {
  return {
    secrets: { 'github-refresh-fleetadlc-other': 'ghr_zzz-here-zzz', 'internal-api-secret': 'zzz-internal-zzz' },
    settings: { organization: 'janedoe', operatorEmail: 'ops@b.example.test' },
    bots: [
      { name: 'builder', slot: 'builder', githubLogin: null, engine: 'claude', model: 'newest:opus', modelAccountId: null, modelSetAt: null },
      {
        name: 'fleetadlc-other',
        slot: 'lead-reviewer',
        githubLogin: 'fleetadlc-other',
        engine: 'claude',
        model: 'newest:opus',
        modelAccountId: null,
        modelSetAt: null,
      },
    ],
    credentials: {},
    repositories: [],
    accounts: [],
    logins: {},
    history: null,
  };
}

/** The archive: the reviewer as another account with its sign-in, an operator email, and a key the provider refuses. */
function archive(extraSettings: Record<string, string> = {}): BackupContents {
  return buildBackup(
    {
      secrets: { 'github-refresh-fleetadlc-sydney': REVIEWER_REFRESH, [`model-account-${KEY_ACCOUNT}`]: KEY },
      settings: { organization: 'janedoe', operatorEmail: 'alex@example.test', engineUpdates: 'on', ...extraSettings },
      bots: [
        {
          name: 'fleetadlc-sydney',
          slot: 'lead-reviewer',
          githubLogin: 'fleetadlc-sydney',
          engine: 'claude',
          model: 'newest:opus',
          modelAccountId: null,
          modelSetAt: null,
        },
      ],
      credentials: {},
      repositories: [],
      accounts: [
        { id: KEY_ACCOUNT, provider: 'anthropic', kind: 'key', label: 'Anthropic API', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: null, verifyError: null },
      ],
      logins: {},
      history: null,
    },
    EVERYTHING,
    NOW,
  ).contents;
}

function memoryUndo() {
  let stored: { journal: RestoreJournal; snapshot: BackupContents } | null = null;
  const store: UndoStore = {
    begin: async (snapshot, journal) => void (stored = { snapshot, journal: { ...journal } }),
    update: async (journal) => void (stored = stored ? { ...stored, journal: { ...journal } } : null),
    load: async () => stored,
    journal: async () => stored?.journal ?? null,
    clear: async () => void (stored = null),
  };
  return { store, stored: () => stored };
}

/** The world a job runs in, recording the order things happen in. */
function world(options: { busyFor?: number; startMeanwhile?: boolean; snapshotFails?: boolean; repositoryStays?: boolean; now?: () => Date; gate?: DispatchGate } = {}) {
  const events: string[] = [];
  const secrets = new Map(Object.entries(here().secrets));
  const settings = new Map(Object.entries(here().settings));
  const rows: string[] = [];
  const audited: { action: string; target: string; payload?: Record<string, unknown> }[] = [];
  const gate = options.gate;
  const undo = memoryUndo();
  let busyCalls = 0;
  let clock = NOW.getTime();
  const db: UndoDb = {
    setSetting: async (key, value) => {
      rows.push(`setting ${key}`);
      settings.set(key, value);
    },
    replaceSpendingLimits: async () => undefined,
    mergeSpendingLimits: async () => undefined,
    putAccount: async (account) => void rows.push(`account ${account.id}`),
    putRepository: async (repo) => void rows.push(`repository ${repo.name}`),
    setBotLogin: async (name, login) => void rows.push(`login ${name}=${login}`),
    putIdentity: async () => undefined,
    setAssignment: async (name) => void rows.push(`assignment ${name}`),
    setLook: async (name) => void rows.push(`look ${name}`),
    putCredential: async (name) => void rows.push(`credential ${name}`),
    putHistory: async () => ({ threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0 }),
    audit: async (entry) => void rows.push(`audit ${entry.action}`),
    clearSetting: async (key) => {
      rows.push(`clear ${key}`);
      settings.delete(key);
    },
    removeRepository: async (name) => {
      if (options.repositoryStays) throw new BackupError(`${name} could not be put back as it was`);
      rows.push(`remove repository ${name}`);
    },
    removeAccount: async (id) => (rows.push(`remove account ${id}`), []),
    releaseLogin: async (name) => void rows.push(`release ${name}`),
    deleteCredential: async (name) => void rows.push(`forget credential ${name}`),
    deleteHistory: async () => void rows.push('delete history'),
  };
  const deps: RestoreIntoDeps = {
    here: async () => here(),
    shape: async () => ({
      secretRefs: [...secrets.keys()],
      settingKeys: [...settings.keys()],
      bots: here().bots.map((bot) => ({ name: bot.name, slot: bot.slot, githubLogin: bot.githubLogin, engine: bot.engine })),
      repositories: [],
      accounts: [],
      logins: [],
    }),
    historyHere: async () => ({ threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0 }),
    signInFacts: () => ({ ...NOTHING_HELD, secret: async (ref) => secrets.get(ref) ?? null }),
    checks: {
      listModels: async (_provider, secret) => {
        if (secret === KEY) throw new Error('invalid x-api-key');
        return [{ id: 'model' }];
      },
      gitHubUser: async () => ({ login: 'fleetadlc-sydney', id: 1 }),
    },
    clientId: async () => 'Iv1.zzz-client-zzz',
    snapshot: async () => {
      events.push('backed up');
      if (options.snapshotFails) throw new Error('hostd did not answer');
      return buildBackup(here(), { ...EVERYTHING, history: true }, NOW).contents;
    },
    target: () => ({
      secrets: {
        get: async (ref) => secrets.get(ref) ?? null,
        set: async (ref, value) => {
          events.push(`wrote ${ref}`);
          secrets.set(ref, value);
        },
        delete: async (ref) => {
          events.push(`deleted ${ref}`);
          secrets.delete(ref);
        },
      },
      transaction: async (fn) => fn(db),
    }),
    takeOver: () => ({
      refreshGitHub: async (token) => {
        events.push(`used ${token}`);
        // Whose each token is: the archive's reviewer, or this install's own.
        const who = token === REVIEWER_REFRESH ? 'sydney' : 'other';
        return { accessToken: `ghu_zzz-${who}-zzz`, refreshToken: 'ghr_zzz-new-zzz', expiresAt: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' };
      },
      gitHubUser: async (token) => ({ login: token.includes('sydney') ? 'fleetadlc-sydney' : 'fleetadlc-other', id: 1 }),
      adoptLogin: async () => ({ ok: true, message: 'answered: OK' }),
    }),
    undo: undo.store,
    busy: async (seats) => {
      busyCalls += 1;
      events.push(`asked who is busy in ${seats.join(', ')}`);
      if (busyCalls <= (options.busyFor ?? 0)) return [{ seat: 'lead-reviewer', name: 'fleetadlc-other' }];
      if (options.startMeanwhile && busyCalls === (options.busyFor ?? 0) + 2) return [{ seat: 'lead-reviewer', name: 'fleetadlc-other' }];
      return [];
    },
    hold: async (seats, fn) => {
      events.push(`held ${seats.join(', ')} and paused the dispatcher`);
      const release = gate?.hold('paused while a backup is restored into this install');
      try {
        return await fn();
      } finally {
        release?.();
        events.push('let go');
      }
    },
    reconcileNames: async () => void events.push('names reconciled'),
    checkHealth: () => void events.push('health checked'),
    ...(gate
      ? {
          resyncPause: (actor: string, source: string) =>
            resyncPause(
              {
                gate,
                read: async () => settings.get('workPaused') ?? null,
                readRepos: async () => settings.get('workPausedRepos') ?? null,
                audit: async (entry) => void audited.push(entry),
              },
              { actor, source },
            ),
        }
      : {}),
    now: options.now ?? (() => new Date(clock)),
    sleep: async (ms) => {
      clock += ms;
      events.push('waited');
    },
    newId: () => 'job-1',
    waitLimitMs: 60_000,
    log: () => undefined,
  };
  return { deps, events, rows, secrets, settings, undo, audited };
}

async function settled(into: RestoreInto): Promise<RestoreJobView> {
  for (let i = 0; i < 200; i += 1) {
    const job = into.view();
    if (job && (job.state === 'done' || job.state === 'failed')) return job;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('the job did not settle');
}

const TAKE_REVIEWER = { 'seat:lead-reviewer:account': true, 'signin:bot:lead-reviewer': true };

describe('restoring into an install that is in use', () => {
  it('refuses a choice that takes a sign-in that cannot be restored, before anything waits or is written', async () => {
    const { deps, events } = world();
    const into = new RestoreInto(deps);

    await expect(into.start(archive(), { [`signin:account:${KEY_ACCOUNT}`]: true }, 'alex@example.test')).rejects.toThrow(
      'Anthropic API cannot be taken from the backup: Anthropic did not accept it: invalid x-api-key',
    );
    expect(events).toEqual([]);
    expect(into.view()).toBeNull();
  });

  it('waits until the bots it changes are idle, holds them and the dispatcher, backs up first, and afterwards names and checks', async () => {
    const { deps, events, secrets, undo } = world({ busyFor: 2 });
    const into = new RestoreInto(deps);

    const started = await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    expect(started.state).toBe('waiting');
    const job = await settled(into);

    expect(job.state).toBe('done');
    const order = events.filter((event) => !event.startsWith('asked'));
    expect(order.slice(0, 3)).toEqual(['waited', 'waited', 'held lead-reviewer and paused the dispatcher']);
    // Backed up before anything was written, and used the sign-in only after.
    expect(order.indexOf('backed up')).toBeLessThan(order.findIndex((event) => event.startsWith('wrote') || event.startsWith('deleted')));
    expect(order).toContain(`used ${REVIEWER_REFRESH}`);
    expect(order.indexOf('let go')).toBeLessThan(order.indexOf('names reconciled'));
    expect(order.slice(-2)).toEqual(['names reconciled', 'health checked']);
    expect(secrets.get('github-refresh-fleetadlc-other')).toBe('ghr_zzz-new-zzz');
    expect(undo.stored()?.journal).toMatchObject({ seats: [{ seat: 'lead-reviewer', account: true, signIn: true }], until: '2026-09-26T10:00:06.000Z' });
    expect(job.result && 'undoUntil' in job.result ? job.result.undoUntil : null).toBe('2026-09-26T10:00:06.000Z');
  });

  it('says whom it is waiting for while it waits', async () => {
    const { deps } = world({ busyFor: 1_000 });
    // What the console would read at each step of the wait.
    const seen: (RestoreJobView | null)[] = [];
    const into: RestoreInto = new RestoreInto({
      ...deps,
      sleep: async (ms) => {
        seen.push(into.view());
        await deps.sleep(ms);
      },
    });

    await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    const job = await settled(into);

    expect(seen.length).toBeGreaterThan(0);
    for (const view of seen) expect(view).toMatchObject({ state: 'waiting', waitingFor: ['fleetadlc-other'] });
    // Gave up after the limit, having changed nothing.
    expect(job.state).toBe('failed');
    expect(job.error).toBe('fleetadlc-other did not finish its work within 1 minutes, so nothing was changed — try again once it is idle');
  });

  it('waits again for a task that started in the moment before the bots were held', async () => {
    const { deps, events } = world({ startMeanwhile: true });
    const into = new RestoreInto(deps);

    await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    const job = await settled(into);

    expect(job.state).toBe('done');
    expect(events.filter((event) => event.startsWith('held')).length).toBe(2);
    expect(events.filter((event) => event.startsWith('wrote')).length).toBeGreaterThan(0);
  });

  it('changes nothing when this install cannot be backed up first', async () => {
    const { deps, events, rows } = world({ snapshotFails: true });
    const into = new RestoreInto(deps);

    await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    const job = await settled(into);

    expect(job.state).toBe('failed');
    expect(job.error).toBe('this install could not be backed up first (hostd did not answer), so nothing was changed');
    expect(rows).toEqual([]);
    expect(events.some((event) => event.startsWith('wrote') || event.startsWith('used'))).toBe(false);
  });

  it('runs one at a time', async () => {
    const { deps } = world({ busyFor: 3 });
    const into = new RestoreInto(deps);

    await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    await expect(into.start(archive(), TAKE_REVIEWER, 'alex@example.test')).rejects.toMatchObject({ status: 409 });
    await settled(into);
  });

  it('is undone for a day, and not after', async () => {
    let now = NOW.getTime();
    const { deps, rows, undo } = world({ now: () => new Date(now) });
    const into = new RestoreInto(deps);
    await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    await settled(into);

    expect(await into.undoState()).toMatchObject({ until: '2026-09-26T10:00:00.000Z' });
    await into.startUndo('alex@example.test');
    const undone = await settled(into);
    expect(undone.kind).toBe('undo');
    expect(undone.state).toBe('done');
    expect(rows).toContain('audit install.restore_undone');
    expect(rows).toContain('login fleetadlc-other=fleetadlc-other');
    expect(undo.stored()).toBeNull();
    await expect(into.startUndo('alex@example.test')).rejects.toMatchObject({ status: 409, name: 'NothingToUndo' });

    await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    await settled(into);
    now += 24 * 60 * 60 * 1000 + 1;
    expect(await into.undoState()).toBeNull();
    expect(undo.stored()).toBeNull();
  });

  // The archive's pause is written as a setting; the gate was read only at
  // start, so the dispatcher kept leasing while Settings said paused.
  it('puts the pause it took on the dispatcher once it is done, and an undo takes it off again', async () => {
    const gate = new DispatchGate();
    const { deps, audited } = world({ gate });
    const into = new RestoreInto(deps);
    const pause = JSON.stringify({ by: 'janedoe', at: '2026-09-20T09:00:00.000Z', reason: null });
    const repoPause = JSON.stringify({ app: { by: 'janedoe', at: '2026-09-20T09:00:00.000Z', reason: 'release freeze' } });

    await into.start(archive({ workPaused: pause, workPausedRepos: repoPause }), { 'setting:workPaused': true, 'setting:workPausedRepos': true }, 'alex@example.test');
    expect((await settled(into)).state).toBe('done');

    // The restore's own hold is let go, and the stored pause is what stays.
    expect(gate.pausedByAPerson()).toBe('work is paused, by janedoe since 2026-09-20T09:00:00.000Z; resume it in Settings → Pause work');
    expect(gate.pausedRepos()).toEqual(['app']);
    expect(audited).toEqual([
      { actor: 'alex@example.test', action: 'work.paused', target: 'dispatch', payload: expect.objectContaining({ source: 'restore into' }) },
      { actor: 'alex@example.test', action: 'work.paused', target: 'repo:app', payload: { source: 'restore into' } },
    ]);

    await into.startUndo('alex@example.test');
    expect((await settled(into)).state).toBe('done');

    expect(gate.paused('app')).toBeNull();
    expect(audited.slice(2)).toEqual([
      { actor: 'alex@example.test', action: 'work.resumed', target: 'dispatch', payload: { source: 'undo of a restore' } },
      { actor: 'alex@example.test', action: 'work.resumed', target: 'repo:app', payload: { source: 'undo of a restore' } },
    ]);
  });

  it('keeps the backup Undo reads from when a repository could not be put back, so it can be tried again', async () => {
    const { deps, undo } = world({ repositoryStays: true });
    const into = new RestoreInto(deps);
    const repository = {
      name: 'widgets',
      fullName: 'exampleco/widgets',
      ownerSeat: null,
      concurrency: 1,
      stageModes: {},
      specRequiredLabels: [],
      humanReviewPaths: [],
      defaultBranch: 'main',
    };
    await into.start({ ...archive(), repositories: [repository] }, TAKE_REVIEWER, 'alex@example.test');
    await settled(into);
    expect(undo.stored()?.journal.repositories).toEqual(['exampleco/widgets']);

    await into.startUndo('alex@example.test');
    const failed = await settled(into);

    expect(failed).toMatchObject({ kind: 'undo', state: 'failed' });
    expect(failed.error).toContain('exampleco/widgets could not be put back as it was');
    expect(undo.stored()).not.toBeNull();
    expect(await into.undoState()).not.toBeNull();
  });

  it('starts one undo of two asked for at once', async () => {
    const { deps, rows } = world();
    const into = new RestoreInto(deps);
    await into.start(archive(), TAKE_REVIEWER, 'or');
    await settled(into);

    // Both pass the first check while the record is read; only one may begin.
    const [first, second] = await Promise.allSettled([into.startUndo('or'), into.startUndo('alex@example.test')]);

    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    await settled(into);
    expect(rows.filter((row) => row === 'audit install.restore_undone')).toHaveLength(1);
  });

  it('starts one of a restore and an undo asked for at once', async () => {
    const { deps } = world();
    const into = new RestoreInto(deps);
    await into.start(archive(), TAKE_REVIEWER, 'or');
    await settled(into);

    // Each passes its first check while it reads; an undo that ran beside the
    // restore would clear the new restore's undo when it finished.
    const results = await Promise.allSettled([into.start(archive(), TAKE_REVIEWER, 'or'), into.startUndo('alex@example.test')]);

    expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((one) => one.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    await settled(into);
  });

  it('is removed a day later by the sweep, with nobody asking', async () => {
    let now = NOW.getTime();
    const { deps, undo } = world({ now: () => new Date(now) });
    const into = new RestoreInto(deps);
    await into.start(archive(), TAKE_REVIEWER, 'alex@example.test');
    await settled(into);

    vi.useFakeTimers();
    try {
      const stop = sweepExpiredUndo(into, 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(undo.stored()).not.toBeNull();

      now += 24 * 60 * 60 * 1000 + 1;
      await vi.advanceTimersByTimeAsync(1000);
      expect(undo.stored()).toBeNull();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the bots a restore changes', () => {
  it('are those whose account, model or sign-in it takes, and those on a model account whose credential it takes', async () => {
    const { deps } = world();
    const into = new RestoreInto(deps);
    const { comparison, here: install } = await into.compare(archive());

    expect(affectedSeats(comparison, comparison.choices, install)).toEqual([]);
    expect(affectedSeats(comparison, { ...comparison.choices, ...TAKE_REVIEWER }, install)).toEqual(['lead-reviewer']);
  });
});
