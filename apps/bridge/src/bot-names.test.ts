import { describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@fleetadlc/github';
import type { Bot, BotRole } from '@fleetadlc/shared';
import { BotNames, type NamesDb } from './bot-names.js';

/**
 * Renaming a bot against an in-memory crew, secret store and hostd: the order
 * the three move in is the whole point, so each is a fake that records what
 * it was asked, and the database refuses a rename the way the real statement
 * does — only while the bot still has the name the caller expects.
 */

interface Credential {
  githubLogin: string;
  status: string;
  secretRef: string;
}

function bot(name: string, slot: string, role: BotRole, githubLogin: string | null = null): Bot {
  return {
    id: `id-${slot}`,
    name,
    slot,
    displayName: slot,
    role,
    engine: 'claude',
    model: 'claude-sonnet-5',
    githubLogin,
    hostId: null,
    container: `bot-${name}`,
    status: 'stopped',
    skills: [],
    sidecarDb: true,
    modelAccountId: null,
    modelSetAt: null,
  };
}

function world(input: {
  crew: Bot[];
  secrets?: Record<string, string>;
  credentials?: Record<string, Credential>;
  /** Where each bot's sign-in is filed, by bot id; its own name, unshared, when absent. */
  signIns?: Record<string, { ns: string; shared: boolean }>;
}) {
  const crew = input.crew.map((entry) => ({ ...entry }));
  const secrets = new Map(Object.entries(input.secrets ?? {}));
  const creds = new Map(Object.entries(input.credentials ?? {}));
  const marks = new Map<string, string>();
  const active = new Map<string, number>();
  const audits: { action: string; target: string; payload?: Record<string, unknown> }[] = [];
  const hostdCalls: string[] = [];
  const events: string[] = [];
  let hostdAnswer: (from: string, to: string) => Promise<unknown> = async () => ({});
  let failRow = false;

  const store: SecretStore = {
    get: async (ref) => secrets.get(ref) ?? null,
    set: async (ref, value) => {
      events.push(`set ${ref}`);
      secrets.set(ref, value);
    },
    delete: async (ref) => {
      if (secrets.has(ref)) events.push(`delete ${ref}`);
      secrets.delete(ref);
    },
    list: async (prefix = '') => [...secrets.keys()].filter((ref) => ref.startsWith(prefix)),
  };

  const db: NamesDb = {
    listBots: async () => crew.map((entry) => ({ ...entry })),
    getBotById: async (id) => {
      const found = crew.find((entry) => entry.id === id);
      return found ? { ...found } : null;
    },
    countActiveTasksForBot: async (id) => active.get(id) ?? 0,
    renameBotRow: async (rename) => {
      if (failRow) throw new Error('the database went away');
      const row = crew.find((entry) => entry.id === rename.id && entry.name === rename.from);
      if (!row) return null;
      events.push(`row ${rename.from} → ${rename.to}`);
      row.name = rename.to;
      row.container = `bot-${rename.to}`;
      marks.set(row.id, rename.from);
      const credential = creds.get(row.id);
      for (const ref of rename.secretRefs) {
        if (credential?.secretRef === ref.from) credential.secretRef = ref.to;
      }
      audits.push({ action: 'bot.renamed', target: rename.to, payload: { from: rename.from, to: rename.to, reason: rename.reason } });
      return { ...row };
    },
    finishRename: async (id) => {
      events.push(`finish ${id}`);
      marks.delete(id);
    },
    unfinishedRenames: async () =>
      [...marks.entries()].map(([id, renamedFrom]) => ({
        id,
        name: crew.find((entry) => entry.id === id)?.name ?? '',
        renamedFrom,
      })),
    setGithubLogin: async (id, login) => {
      const row = crew.find((entry) => entry.id === id);
      if (row) row.githubLogin = login;
    },
    getCredential: async (id) => creds.get(id) ?? null,
    audit: async (entry) => void audits.push(entry),
    ...(input.signIns
      ? { signInOf: async (entry: Bot) => input.signIns?.[entry.id] ?? { ns: entry.name, shared: false } }
      : {}),
  };

  const held: string[][] = [];
  const names = new BotNames({
    hostd: {
      renameBot: async (from, to) => {
        hostdCalls.push(`${from} → ${to}`);
        events.push(`hostd ${from} → ${to}`);
        return hostdAnswer(from, to);
      },
    },
    exclusive: async (names, fn) => {
      held.push([...names]);
      return fn();
    },
    store,
    db,
    retryMs: 0,
    log: () => undefined,
  });

  return {
    names,
    crew,
    store,
    secrets,
    creds,
    marks,
    active,
    audits,
    hostdCalls,
    events,
    held,
    answerHostd(answer: (from: string, to: string) => Promise<unknown>) {
      hostdAnswer = answer;
    },
    failRowOnce() {
      failRow = true;
      return () => {
        failRow = false;
      };
    },
    named: (slot: string) => crew.find((entry) => entry.slot === slot)?.name,
  };
}

function refused(status: number, message: string) {
  return async () => Promise.reject(Object.assign(new Error(message), { status }));
}

describe('renaming a bot', () => {
  it('moves the computer first, then the secrets and the row together, and leaves nothing under the old name', async () => {
    const w = world({
      crew: [bot('atlas', 'builder', 'implement', 'fleetadlc-atlas-janedoe')],
      secrets: {
        'github-refresh-atlas': 'ghr_live',
        'ssh-signing-atlas': 'PRIVATE KEY',
        'engine-key-atlas': 'sk-ant-key',
        'internal-api-secret': 'untouched',
      },
      credentials: {
        'id-builder': { githubLogin: 'fleetadlc-atlas-janedoe', status: 'active', secretRef: 'github-refresh-atlas' },
      },
    });

    const outcome = await w.names.rename({
      botId: 'id-builder',
      to: 'FleetADLC-Atlas-Janedoe',
      reason: 'connected as FleetADLC-Atlas-Janedoe',
      actor: 'ada',
    });

    expect(outcome).toMatchObject({ state: 'renamed', from: 'atlas', to: 'fleetadlc-atlas-janedoe' });
    expect(w.named('builder')).toBe('fleetadlc-atlas-janedoe');
    expect([...w.secrets.keys()].sort()).toEqual([
      'engine-key-fleetadlc-atlas-janedoe',
      'github-refresh-fleetadlc-atlas-janedoe',
      'internal-api-secret',
      'ssh-signing-fleetadlc-atlas-janedoe',
    ]);
    expect(w.secrets.get('github-refresh-fleetadlc-atlas-janedoe')).toBe('ghr_live');
    expect(w.creds.get('id-builder')?.secretRef).toBe('github-refresh-fleetadlc-atlas-janedoe');
    expect(w.audits).toContainEqual(
      expect.objectContaining({ action: 'bot.renamed', payload: expect.objectContaining({ from: 'atlas', to: 'fleetadlc-atlas-janedoe' }) }),
    );
    // hostd, then copies, then the row, then the old secrets go, then the mark.
    const order = w.events.map((event) => event.split(' ')[0]);
    expect(order[0]).toBe('hostd');
    expect(order.indexOf('row')).toBeGreaterThan(order.lastIndexOf('set'));
    expect(order.indexOf('delete')).toBeGreaterThan(order.indexOf('row'));
    expect(order.at(-1)).toBe('finish');
    // With the broker held off both names while the refresh token moved.
    expect(w.held).toEqual([['atlas', 'fleetadlc-atlas-janedoe']]);
    expect(w.marks.size).toBe(0);
  });

  it('leaves a shared account’s sign-in where the account files it, when the seat it was shared from goes back to its seat', async () => {
    // The builder connected first and took the account's handle, so the
    // account's sign-in is filed under that name, and four more seats use it.
    const w = world({
      crew: [bot('irisexampleco', 'builder', 'implement', 'irisexampleco')],
      secrets: { 'github-refresh-irisexampleco': 'ghr_shared', 'ssh-signing-irisexampleco': 'BUILDER KEY' },
      signIns: { 'id-builder': { ns: 'irisexampleco', shared: true } },
    });

    const outcome = await w.names.rename({ botId: 'id-builder', to: 'builder', reason: 'it shares irisexampleco', actor: 'ada' });

    expect(outcome).toMatchObject({ state: 'renamed', to: 'builder' });
    // Its own signing key goes with it; the account's sign-in stays for every seat on it.
    expect(w.secrets.get('github-refresh-irisexampleco')).toBe('ghr_shared');
    expect(w.secrets.has('github-refresh-builder')).toBe(false);
    expect(w.secrets.get('ssh-signing-builder')).toBe('BUILDER KEY');
  });

  it('waits while the bot has a task queued or running, and moves nothing', async () => {
    const w = world({ crew: [bot('atlas', 'builder', 'implement')], secrets: { 'ssh-signing-atlas': 'KEY' } });
    w.active.set('id-builder', 1);

    const outcome = await w.names.rename({ botId: 'id-builder', to: 'fleetadlc-atlas-janedoe', reason: 'r', actor: 'ada' });

    expect(outcome.state).toBe('waiting');
    expect(outcome.reason).toMatch(/task queued or running/);
    expect(w.hostdCalls).toEqual([]);
    expect(w.named('builder')).toBe('atlas');
    expect(w.secrets.get('ssh-signing-atlas')).toBe('KEY');
  });

  it('refuses a name another bot has, or another bot’s seat, and one that is no login', async () => {
    const w = world({ crew: [bot('atlas', 'builder', 'implement'), bot('qa', 'qa', 'qa')] });

    const taken = await w.names.rename({ botId: 'id-builder', to: 'qa', reason: 'r', actor: 'ada' });
    expect(taken).toMatchObject({ state: 'refused', reason: 'qa is already the name of the QA' });

    w.crew[1]!.name = 'irisexampleco';
    const seat = await w.names.rename({ botId: 'id-builder', to: 'qa', reason: 'r', actor: 'ada' });
    expect(seat).toMatchObject({ state: 'refused', reason: 'qa is the seat of the QA' });

    const invalid = await w.names.rename({ botId: 'id-builder', to: 'not a login', reason: 'r', actor: 'ada' });
    expect(invalid.state).toBe('refused');
    expect(w.hostdCalls).toEqual([]);
  });

  it('waits when hostd is busy or away, refuses what it never will, and moves nothing either way', async () => {
    const w = world({ crew: [bot('atlas', 'builder', 'implement')], secrets: { 'ssh-signing-atlas': 'KEY' } });

    w.answerHostd(refused(409, 'atlas is running task t-1; a bot is renamed between tasks'));
    expect(await w.names.rename({ botId: 'id-builder', to: 'fleetadlc-atlas-janedoe', reason: 'r', actor: 'ada' })).toMatchObject({
      state: 'waiting',
      reason: 'atlas is running task t-1; a bot is renamed between tasks',
    });

    w.answerHostd(refused(502, 'hostd is not answering'));
    expect((await w.names.rename({ botId: 'id-builder', to: 'fleetadlc-atlas-janedoe', reason: 'r', actor: 'ada' })).state).toBe(
      'waiting',
    );

    w.answerHostd(refused(400, '"x" cannot be a bot\'s name'));
    expect((await w.names.rename({ botId: 'id-builder', to: 'fleetadlc-atlas-janedoe', reason: 'r', actor: 'ada' })).state).toBe(
      'refused',
    );

    expect(w.named('builder')).toBe('atlas');
    expect([...w.secrets.keys()]).toEqual(['ssh-signing-atlas']);
  });

  it('does not let a bot inherit a secret left under the name it takes', async () => {
    // A refresh token under the new name is somebody else's: the bot that last
    // had the name took its own with it. Kept, it would act as that account.
    const w = world({
      crew: [bot('builder', 'builder', 'implement')],
      secrets: { 'github-refresh-fleetadlc-atlas-janedoe': 'ghr_someone_elses' },
    });

    await w.names.rename({ botId: 'id-builder', to: 'fleetadlc-atlas-janedoe', reason: 'r', actor: 'ada' });

    expect(w.secrets.has('github-refresh-fleetadlc-atlas-janedoe')).toBe(false);
  });

  it('is finished by the next reconcile when the bridge stopped after hostd answered', async () => {
    const w = world({
      crew: [bot('atlas', 'builder', 'implement', 'fleetadlc-atlas-janedoe')],
      secrets: { 'github-refresh-atlas': 'ghr_live' },
      credentials: { 'id-builder': { githubLogin: 'fleetadlc-atlas-janedoe', status: 'active', secretRef: 'github-refresh-atlas' } },
    });
    const recover = w.failRowOnce();

    // Waiting, not thrown: a connect that got this far has stored its
    // credential, and that stands whatever the rename does.
    expect(
      await w.names.rename({ botId: 'id-builder', to: 'fleetadlc-atlas-janedoe', reason: 'r', actor: 'ada' }),
    ).toMatchObject({ state: 'waiting', reason: expect.stringContaining('the database went away') });
    expect(w.named('builder')).toBe('atlas');
    expect(w.secrets.get('github-refresh-atlas')).toBe('ghr_live');
    recover();

    const [outcome] = await w.names.reconcile();

    expect(outcome).toMatchObject({ state: 'renamed', from: 'atlas', to: 'fleetadlc-atlas-janedoe' });
    // hostd was asked twice with the same names, which it finishes the second time.
    expect(w.hostdCalls).toEqual(['atlas → fleetadlc-atlas-janedoe', 'atlas → fleetadlc-atlas-janedoe']);
    expect([...w.secrets.entries()]).toEqual([['github-refresh-fleetadlc-atlas-janedoe', 'ghr_live']]);
  });

  it('finishes moving the secrets of a rename that stopped after the row changed, keeping the live one', async () => {
    // The row already says the new name, so the broker has refreshed under it:
    // that token is the live one, and the copy under the old name is stale.
    const w = world({
      crew: [bot('fleetadlc-atlas-janedoe', 'builder', 'implement', 'fleetadlc-atlas-janedoe')],
      secrets: {
        'github-refresh-atlas': 'ghr_stale',
        'github-refresh-fleetadlc-atlas-janedoe': 'ghr_rotated_since',
        'ssh-signing-atlas': 'KEY',
      },
      credentials: {
        'id-builder': { githubLogin: 'fleetadlc-atlas-janedoe', status: 'active', secretRef: 'github-refresh-fleetadlc-atlas-janedoe' },
      },
    });
    w.marks.set('id-builder', 'atlas');

    await w.names.reconcile();

    expect(Object.fromEntries(w.secrets)).toEqual({
      'github-refresh-fleetadlc-atlas-janedoe': 'ghr_rotated_since',
      'ssh-signing-fleetadlc-atlas-janedoe': 'KEY',
    });
    expect(w.marks.size).toBe(0);
    expect(w.hostdCalls).toEqual([]);
  });

  it('finishing an interrupted rename of a shared seat leaves the account’s sign-in in place', async () => {
    // Two seats share octocat, filed under the name of the seat it was shared
    // from. That seat goes back to `builder`, and a store delete fails after
    // the row has changed.
    const w = world({
      crew: [bot('octocat', 'builder', 'implement', 'octocat'), bot('qa', 'qa', 'qa', 'octocat')],
      secrets: {
        'github-refresh-octocat': 'ghr_shared',
        'github-token-octocat': 'ghu_shared',
        'ssh-signing-octocat': 'BUILDER KEY',
        'engine-key-octocat': 'sk-builder',
      },
      signIns: { 'id-builder': { ns: 'octocat', shared: true }, 'id-qa': { ns: 'octocat', shared: true } },
    });
    const realDelete = w.store.delete;
    w.store.delete = async () => {
      throw new Error('the secret store went away');
    };
    expect((await w.names.rename({ botId: 'id-builder', to: 'builder', reason: 'it shares octocat', actor: 'ada' })).state).toBe(
      'waiting',
    );
    expect(w.marks.get('id-builder')).toBe('octocat');
    w.store.delete = realDelete;

    await w.names.reconcile();

    expect(w.secrets.get('github-refresh-octocat')).toBe('ghr_shared');
    expect(w.secrets.get('github-token-octocat')).toBe('ghu_shared');
    expect(w.secrets.has('github-refresh-builder')).toBe(false);
    expect(w.secrets.has('github-token-builder')).toBe(false);
    // Its own keys go with it, and nothing of them is left under the old name.
    expect(w.secrets.get('ssh-signing-builder')).toBe('BUILDER KEY');
    expect(w.secrets.get('engine-key-builder')).toBe('sk-builder');
    expect(w.secrets.has('ssh-signing-octocat')).toBe(false);
    expect(w.secrets.has('engine-key-octocat')).toBe(false);
    expect(w.marks.size).toBe(0);
  });

  it('finishing an interrupted rename of an own-account bot moves its sign-in', async () => {
    // The row has changed, so an unshared identity is filed under the new name.
    const w = world({
      crew: [bot('fleetadlc-atlas-janedoe', 'builder', 'implement', 'fleetadlc-atlas-janedoe')],
      secrets: { 'github-refresh-atlas': 'ghr_live', 'github-token-atlas': 'ghu_live', 'ssh-signing-atlas': 'KEY' },
      signIns: { 'id-builder': { ns: 'fleetadlc-atlas-janedoe', shared: false } },
    });
    w.marks.set('id-builder', 'atlas');

    await w.names.reconcile();

    expect(Object.fromEntries(w.secrets)).toEqual({
      'github-refresh-fleetadlc-atlas-janedoe': 'ghr_live',
      'github-token-fleetadlc-atlas-janedoe': 'ghu_live',
      'ssh-signing-fleetadlc-atlas-janedoe': 'KEY',
    });
    expect(w.marks.size).toBe(0);
  });

  it('holds a task off the bot until its rename is done, and hands it the new name', async () => {
    const w = world({ crew: [bot('atlas', 'builder', 'implement')] });
    let letHostdAnswer!: () => void;
    w.answerHostd(() => new Promise((resolve) => (letHostdAnswer = () => resolve({}))));

    const renaming = w.names.rename({ botId: 'id-builder', to: 'fleetadlc-atlas-janedoe', reason: 'r', actor: 'ada' });
    await vi.waitFor(() => expect(w.hostdCalls).toHaveLength(1));
    const opened = w.names.withBot('id-builder', async () => w.named('builder'));

    letHostdAnswer();
    await renaming;
    expect(await opened).toBe('fleetadlc-atlas-janedoe');
  });
});

describe('bringing the crew’s names in line with their accounts', () => {
  /** The owner's install on 2026-09-24: six connected under persona names, three not. */
  function ownersInstall() {
    const connected: [string, string, BotRole, string][] = [
      ['mira', 'intake', 'intake', 'irisexampleco'],
      ['atlas', 'builder', 'implement', 'fleetadlc-atlas-janedoe'],
      ['grok', 'second-reviewer', 'review_second', 'tessexampleco'],
      ['cipher', 'security-reviewer', 'review_security', 'fleetadlc-cipher-janedoe'],
      ['harbor', 'sre', 'deploy', 'ottoexampleco'],
      ['flow', 'automation', 'automation', 'janedoe-fleetadlc-flow'],
    ];
    const crew = [
      ...connected.map(([name, slot, role, login]) => bot(name, slot, role, login)),
      bot('nova', 'system-engineer', 'spec', 'fleetadlc-nova'),
      bot('sydney', 'lead-reviewer', 'review_lead', 'noraexampleco'),
      bot('vega', 'qa', 'qa', 'fleetadlc-vega'),
    ];
    const secrets = Object.fromEntries(connected.map(([name]) => [`github-refresh-${name}`, `ghr_${name}`]));
    const credentials = Object.fromEntries(
      connected.map(([name, slot, , login]) => [
        `id-${slot}`,
        { githubLogin: login, status: 'active', secretRef: `github-refresh-${name}` },
      ]),
    );
    return world({ crew, secrets, credentials });
  }

  it('gives each connected bot its handle and puts the rest back in their seats, letting go of their logins', async () => {
    const w = ownersInstall();

    const outcomes = await w.names.reconcile();

    expect(outcomes.every((outcome) => outcome.state === 'renamed')).toBe(true);
    expect(Object.fromEntries(w.crew.map((entry) => [entry.slot, [entry.name, entry.githubLogin]]))).toEqual({
      intake: ['irisexampleco', 'irisexampleco'],
      builder: ['fleetadlc-atlas-janedoe', 'fleetadlc-atlas-janedoe'],
      'second-reviewer': ['tessexampleco', 'tessexampleco'],
      'security-reviewer': ['fleetadlc-cipher-janedoe', 'fleetadlc-cipher-janedoe'],
      sre: ['ottoexampleco', 'ottoexampleco'],
      automation: ['janedoe-fleetadlc-flow', 'janedoe-fleetadlc-flow'],
      // Seats that named an account but never held a sign-in for it (nova,
      // sydney, vega) go back to their seat names and let go of those logins.
      'system-engineer': ['system-engineer', null],
      'lead-reviewer': ['lead-reviewer', null],
      qa: ['qa', null],
    });
    expect(w.secrets.get('github-refresh-janedoe-fleetadlc-flow')).toBe('ghr_flow');
    expect([...w.secrets.keys()].filter((ref) => /^github-refresh-(atlas|mira|flow|grok|cipher|harbor)$/.test(ref))).toEqual([]);
    expect(w.audits.filter((entry) => entry.action === 'bot.login_released').map((entry) => entry.payload?.login)).toEqual(
      ['fleetadlc-nova', 'noraexampleco', 'fleetadlc-vega'],
    );
  });

  it('leaves a bot in its seat naming the account it had, for the walkthrough to suggest', async () => {
    // A restore puts back which account each seat was, without a refresh
    // token to make it connected. It is not a name to take, and not a login
    // to throw away.
    const w = world({ crew: [bot('builder', 'builder', 'implement', 'fleetadlc-atlas-janedoe')] });

    expect(await w.names.reconcile()).toEqual([]);
    expect(w.crew[0]).toMatchObject({ name: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' });
    expect(w.audits).toEqual([]);
  });

  it('does nothing the second time', async () => {
    const w = ownersInstall();
    await w.names.reconcile();
    const calls = w.hostdCalls.length;

    expect(await w.names.reconcile()).toEqual([]);
    expect(w.hostdCalls).toHaveLength(calls);
  });

  it('lets a bot going back to its seat give up a handle before another takes it', async () => {
    // The QA seat was connected as `irisexampleco` and is not any more; the
    // intake seat is connected as it now. Intake can only take the name once
    // QA has let go of it.
    const w = world({
      crew: [bot('intake', 'intake', 'intake', 'irisexampleco'), bot('irisexampleco', 'qa', 'qa')],
      secrets: { 'github-refresh-intake': 'ghr_intake' },
      credentials: { 'id-intake': { githubLogin: 'irisexampleco', status: 'active', secretRef: 'github-refresh-intake' } },
    });

    await w.names.reconcile();

    expect(w.named('qa')).toBe('qa');
    expect(w.named('intake')).toBe('irisexampleco');
  });
});

describe('a crew with one row that cannot be written', () => {
  it('renames the others, and leaves that one for the next pass', async () => {
    // The column is unique: a connected bot whose login is also named on a
    // stale row cannot be given it until that row lets go.
    const w = world({
      crew: [bot('atlas', 'builder', 'implement'), bot('nova', 'system-engineer', 'spec')],
      secrets: { 'github-refresh-atlas': 'ghr' },
      credentials: { 'id-builder': { githubLogin: 'fleetadlc-atlas-janedoe', status: 'active', secretRef: 'github-refresh-atlas' } },
    });
    const setLogin = vi.fn(async () => {
      throw new Error('duplicate key value violates unique constraint "bots_github_login_key"');
    });
    (w.names as unknown as { db: NamesDb }).db.setGithubLogin = setLogin;

    const outcomes = await w.names.reconcile();

    expect(setLogin).toHaveBeenCalled();
    expect(outcomes).toEqual([expect.objectContaining({ from: 'nova', to: 'system-engineer', state: 'renamed' })]);
    expect(w.named('builder')).toBe('atlas');
  });
});
