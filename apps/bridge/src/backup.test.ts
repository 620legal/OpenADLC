import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVERYTHING,
  NOTHING_HELD,
  buildBackup,
  decryptBackup,
  encryptBackup,
  readManifest,
  writePlain,
  type BackupContents,
  type InstallFacts,
  type InstallShape,
  type InstallSnapshot,
  type RestoreDb,
  type RestoreTarget,
  type SignInLine,
} from '@fleetadlc/backup';
import { DeviceAuthError, setSecretStore, type SecretStore } from '@fleetadlc/github';
import { Router } from './router.js';

const CREW = [
  { id: 'b1', name: 'builder', slot: 'builder', role: 'implement', githubLogin: null as string | null },
  { id: 'b2', name: 'fleetadlc-flow-janedoe', slot: 'automation', role: 'automation', githubLogin: 'fleetadlc-flow-janedoe' },
];
const CREDENTIALS: Record<string, { status: string } | null> = {};
/** The settings a restore wrote, as the bridge reads them back after it. */
const STORED = new Map<string, string>();

// The database, for the few reads the bridge makes itself. Everything else
// here goes through fakes; the settings' closed list of keys is the real one.
vi.mock('@fleetadlc/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/db')>();
  return {
    ...actual,
    audit: vi.fn(async () => undefined),
    bots: {
      listBots: vi.fn(async () => CREW),
      getBotByName: vi.fn(async (name: string) => CREW.find((bot) => bot.name === name) ?? null),
    },
    credentials: { getCredential: vi.fn(async (id: string) => CREDENTIALS[id] ?? null) },
    repos: { listRepos: vi.fn(async () => []) },
    modelAccounts: { list: vi.fn(async () => []) },
    settings: { ...actual.settings, allSettings: vi.fn(async () => ({})), getSetting: vi.fn(async (key: string) => STORED.get(key) ?? null) },
  };
});

// The install's own read, so a test can see what was asked of it.
vi.mock('@fleetadlc/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/backup')>();
  return { ...actual, readInstall: vi.fn(actual.readInstall) };
});

const { backupFilename, defaultBackupDeps, defaultRestoreIntoDeps, installFacts, registerBackupRoutes } = await import('./backup.js');
const { readInstall } = await import('@fleetadlc/backup');
type BackupRouteDeps = Parameters<typeof registerBackupRoutes>[1];

/**
 * Backing up from the console and restoring a clean install from the
 * walkthrough, over the wire. What goes in an archive and how it comes back is
 * `@fleetadlc/backup`'s and tested there; this is the bridge's part — the
 * download, the audit line, and the refusal of anything but a clean install.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');
const PASSPHRASE = 'correct horse battery staple';
const APP_KEY = '-----BEGIN RSA PRIVATE KEY-----\nzzz-app-key-zzz\n-----END RSA PRIVATE KEY-----\n';
const REFRESH = 'ghr_zzz-refresh-zzz';
const KEY = 'sk-ant-api-zzz-refused-zzz';
const KEY_ACCOUNT = '11111111-1111-4111-8111-111111111111';

function snapshot(): InstallSnapshot {
  return {
    secrets: {
      'github-app-private-key': APP_KEY,
      'internal-api-secret': 'zzz-internal-zzz',
      'ssh-signing-fleetadlc-atlas-janedoe': 'zzz-signing-zzz',
      'github-refresh-fleetadlc-atlas-janedoe': REFRESH,
      [`model-account-${KEY_ACCOUNT}`]: KEY,
    },
    settings: { organization: 'janedoe', githubClientId: 'Iv1.zzz-client-zzz' },
    bots: [
      {
        name: 'fleetadlc-atlas-janedoe',
        slot: 'builder',
        githubLogin: 'fleetadlc-atlas-janedoe',
        engine: 'claude',
        model: 'newest:opus',
        modelAccountId: null,
        modelSetAt: '2026-09-20T10:00:00.000Z',
      },
    ],
    credentials: {},
    repositories: [],
    accounts: [
      { id: KEY_ACCOUNT, provider: 'anthropic', kind: 'key', label: 'Anthropic API', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: null, verifyError: null },
    ],
    logins: {},
    history: null,
  };
}

const CLEAN: InstallFacts = { appConfigured: false, repositories: [], connectedBots: [], modelAccounts: [] };

const SHAPE: InstallShape = {
  secretRefs: ['internal-api-secret'],
  settingKeys: [],
  bots: [
    { name: 'builder', slot: 'builder', githubLogin: null, engine: 'claude' },
    { name: 'automation', slot: 'automation', githubLogin: null, engine: 'none' },
  ],
  repositories: [],
  accounts: [],
  logins: [],
};

function archive(): BackupContents {
  return buildBackup(snapshot(), EVERYTHING, NOW).contents;
}

/** A target that keeps what a restore wrote. */
function memoryTarget() {
  const secrets = new Map<string, string>([['internal-api-secret', 'zzz-internal-zzz']]);
  const rows: string[] = [];
  const renamed: string[] = [];
  const target: RestoreTarget = {
    secrets: {
      get: async (ref) => secrets.get(ref) ?? null,
      set: async (ref, value) => void secrets.set(ref, value),
      delete: async (ref) => void secrets.delete(ref),
    },
    async transaction(fn) {
      const db: RestoreDb = {
        setSetting: async (key, value) => {
          rows.push(`setting ${key}`);
          STORED.set(key, value);
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
        deleteCredential: async (name) => void rows.push(`forget credential ${name}`),
        putHistory: async () => ({ threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0 }),
        audit: async (entry) => void rows.push(`audit ${entry.action}`),
      };
      return fn(db);
    },
    rename: async ({ name, to }) => {
      renamed.push(`${name} → ${to}`);
      return { state: 'renamed' };
    },
  };
  return { target, secrets, rows, renamed };
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** The providers, answered here: the key is refused, and a refresh token in `spent` is one GitHub says is used up. */
function providers(spent: string[] = []) {
  const refreshed: string[] = [];
  const checks = {
    listModels: async (_provider: string, secret: string) => {
      if (secret === KEY) throw new Error('invalid x-api-key');
      return [{ id: 'claude-opus-5' }];
    },
    gitHubUser: async () => ({ login: 'fleetadlc-atlas-janedoe', id: 101 }),
  };
  const takeOver = () => ({
    refreshGitHub: async (token: string) => {
      refreshed.push(token);
      if (spent.includes(token)) throw new DeviceAuthError('bad_refresh_token', 'The refresh token passed is incorrect or expired.');
      return {
        accessToken: 'ghu_zzz-fresh-access-zzz',
        refreshToken: 'ghr_zzz-fresh-refresh-zzz',
        expiresAt: null,
        refreshExpiresAt: null,
        scopes: [],
        tokenType: 'bearer',
      };
    },
    gitHubUser: async () => ({ login: 'fleetadlc-atlas-janedoe', id: 101 }),
    adoptLogin: async () => ({ ok: true, message: 'answered: OK' }),
  });
  return { checks, takeOver, refreshed };
}

async function serve(overrides: Partial<BackupRouteDeps> = {}, spent: string[] = []) {
  const memory = memoryTarget();
  const audited: { action: string; payload: Record<string, unknown> }[] = [];
  const faked = providers(spent);
  const deps: BackupRouteDeps = {
    inventory: async () => ({
      install: { settings: ['organization'], app: { clientId: true, privateKey: true, webhookSecret: false } },
      repositories: [],
      bots: [],
      accounts: [],
      history: { threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0 },
    }),
    snapshot: async () => snapshot(),
    shape: async () => SHAPE,
    facts: async () => CLEAN,
    target: () => memory.target,
    audit: async (entry) => void audited.push({ action: entry.action, payload: entry.payload }),
    now: () => NOW,
    signInFacts: () => NOTHING_HELD,
    checks: faked.checks,
    clientId: async () => null,
    takeOver: faked.takeOver,
    ...overrides,
  };
  const router = new Router();
  registerBackupRoutes(router, deps);
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, post, memory, audited, refreshed: faked.refreshed };
}

describe('downloading a backup', () => {
  it('streams a sealed archive of what was chosen, named for the day', async () => {
    const { post } = await serve();

    const response = await post('/v1/backup', { selection: { install: true, repositories: true, bots: 'all', accounts: 'all' }, passphrase: PASSPHRASE, confirm: PASSPHRASE });
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="fleetadlc-backup-2026-09-24.fleetbak"');
    expect(bytes.subarray(0, 10).toString()).toBe('FLEETBAK1\n');
    expect(bytes.includes(Buffer.from(APP_KEY))).toBe(false);
    const opened = await decryptBackup(bytes, PASSPHRASE);
    expect(opened.secrets['github-app-private-key']).toBe(APP_KEY);
    expect(opened.secrets).not.toHaveProperty('internal-api-secret');
    expect(readManifest(bytes).includes).toMatchObject({ install: true, bots: 'all', botSignIns: true });
  });

  it('records the backup in the audit log by name, never by value', async () => {
    const { post, audited } = await serve();

    await post('/v1/backup', { selection: { install: true, bots: ['builder'] }, passphrase: PASSPHRASE });

    expect(audited).toHaveLength(1);
    expect(audited[0]?.action).toBe('install.backup');
    expect(audited[0]?.payload).toMatchObject({ bots: ['builder'], leftOut: expect.arrayContaining(['internal-api-secret']) });
    // Part of the install, so no sign-in unless it was asked for.
    expect(audited[0]?.payload.includes).toMatchObject({ install: true, repositories: false, botSignIns: false });
    const said = JSON.stringify(audited);
    for (const value of [APP_KEY, REFRESH, PASSPHRASE, 'zzz-signing-zzz']) expect(said).not.toContain(value);
  });

  it('refuses a missing or mistyped passphrase, a seat the install lacks, and a choice of nothing — and audits none of them', async () => {
    const { post, audited } = await serve();

    const cases = [
      { selection: { install: true }, passphrase: '' },
      { selection: { install: true }, passphrase: PASSPHRASE, confirm: 'correct horse battery stable' },
      { selection: { bots: ['nobody'] }, passphrase: PASSPHRASE },
      { selection: { install: false }, passphrase: PASSPHRASE },
    ];
    const answers = await Promise.all(cases.map(async (body) => {
      const response = await post('/v1/backup', body);
      return { status: response.status, error: ((await response.json()) as { error: string }).error };
    }));

    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400, 400]);
    expect(answers[1]?.error).toBe('the two passphrases do not match');
    expect(answers[2]?.error).toBe('this install has no seat nobody');
    expect(audited).toEqual([]);
  });

  it('says an archive too large to seal should leave history out, not that a string was too long', async () => {
    const { post, audited } = await serve();
    // What V8 does with a payload over about 536 million characters: only the
    // archive's payload is refused, so the request and the answer still travel.
    const original = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(function (this: unknown, value: unknown, ...rest: unknown[]) {
      if (value && typeof value === 'object' && 'bots' in value && 'secrets' in value) throw new RangeError('Invalid string length');
      return (original as (...args: unknown[]) => string).call(JSON, value, ...rest);
    });
    let answer: { status: number; error: string };
    try {
      const response = await post('/v1/backup', { selection: { install: true }, passphrase: PASSPHRASE });
      answer = { status: response.status, error: ((await response.json()) as { error: string }).error };
    } finally {
      spy.mockRestore();
    }

    expect(answer.status).toBe(400);
    expect(answer.error).toContain('without history');
    expect(answer.error).not.toContain('Invalid string length');
    expect(audited).toEqual([]);
  });

  it('names the file the way `fleetadlc backup` does', () => {
    expect(backupFilename(NOW)).toBe('fleetadlc-backup-2026-09-24.fleetbak');
  });
});

describe('restoring onto a clean install', () => {
  const sealed = async () => (await encryptBackup(archive(), PASSPHRASE)).toString('base64');

  it('says what the archive holds, what it will set up and what each sign-in is — and uses none, and writes nothing', async () => {
    const { post, memory, refreshed } = await serve();

    const response = await post('/v1/restore/preview', { archive: await sealed(), passphrase: PASSPHRASE });
    const body = (await response.json()) as {
      sealed: boolean;
      holds: { bots: { seat: string }[] };
      restores: { bots: { becomes: string | null; signInState: string | null }[] };
      signIns: SignInLine[];
    };

    expect(response.status).toBe(200);
    expect(body.sealed).toBe(true);
    expect(body.holds.bots.map((bot) => bot.seat)).toEqual(['builder']);
    expect(body.restores.bots[0]).toMatchObject({ becomes: 'fleetadlc-atlas-janedoe', signInState: 'take-over' });
    expect(body.signIns.map((line) => [line.key, line.verdict.state, line.chosen])).toEqual([
      ['bot:builder', 'check-by-use', true],
      [`account:${KEY_ACCOUNT}`, 'blocked', false],
    ]);
    expect(body.signIns[1]?.reason).toBe('Anthropic did not accept it: invalid x-api-key');
    expect(refreshed).toEqual([]);
    expect(memory.rows).toEqual([]);
    const said = JSON.stringify(body);
    for (const value of [REFRESH, KEY, APP_KEY]) expect(said).not.toContain(value);
  });

  it('restores it: the settings, the App key, the seat’s account, its sign-in taken over, and the rename to the archived handle', async () => {
    const { post, memory, refreshed } = await serve();

    const response = await post('/v1/restore', { archive: await sealed(), passphrase: PASSPHRASE });
    const body = (await response.json()) as { renames: { name: string; to: string; state: string }[]; signIns: SignInLine[] };

    expect(response.status).toBe(200);
    expect(memory.rows).toEqual(expect.arrayContaining(['setting organization', 'login builder=fleetadlc-atlas-janedoe', 'assignment builder', 'audit install.restored', 'credential builder']));
    expect(memory.secrets.get('github-app-private-key')).toBe(APP_KEY);
    // Checked by using it: the archive's token was exchanged, and the new one kept.
    expect(refreshed).toEqual([REFRESH]);
    expect(memory.secrets.get('github-refresh-builder')).toBe('ghr_zzz-fresh-refresh-zzz');
    expect(memory.renamed).toEqual(['builder → fleetadlc-atlas-janedoe']);
    expect(body.renames).toEqual([{ name: 'builder', to: 'fleetadlc-atlas-janedoe', state: 'renamed' }]);
    expect(body.signIns.map((line) => [line.key, line.state])).toEqual([
      ['bot:builder', 'taken-over'],
      [`account:${KEY_ACCOUNT}`, 'blocked'],
    ]);
  });

  // The archive carries the pause, and the restore wrote it as a setting;
  // the gate was read only at start, so the dispatcher kept leasing while
  // Settings said work was paused, until the next restart.
  it('puts a pause the archive carries on the dispatcher at once, audited as the restore’s', async () => {
    STORED.clear();
    const { DispatchGate } = await import('./dispatch-gate.js');
    const { audit } = await import('@fleetadlc/db');
    vi.mocked(audit).mockClear();
    const gate = new DispatchGate();
    const pausedThere = { ...snapshot(), settings: { ...snapshot().settings, workPaused: JSON.stringify({ by: 'janedoe', at: '2026-09-20T09:00:00.000Z', reason: 'incident' }) } };
    const pausedArchive = (await encryptBackup(buildBackup(pausedThere, EVERYTHING, NOW).contents, PASSPHRASE)).toString('base64');
    const { resyncPause } = defaultBackupDeps({ config: {} as never, hostd: {} as never, dispatchGate: gate });
    const { post } = await serve({ resyncPause });

    const response = await post('/v1/restore', { archive: pausedArchive, passphrase: PASSPHRASE });

    expect(response.status).toBe(200);
    expect(gate.paused()).toBe('work is paused, by janedoe since 2026-09-20T09:00:00.000Z (incident); resume it in Settings → Pause work');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.any(String), action: 'work.paused', target: 'dispatch', payload: expect.objectContaining({ source: 'restore' }) }));
  });

  it('never writes a sign-in the provider refused, and says what is left to do', async () => {
    const { post, memory } = await serve();

    const response = await post('/v1/restore', { archive: await sealed(), passphrase: PASSPHRASE });
    const body = (await response.json()) as { restored: { next: string[] } };

    expect([...memory.secrets.values()]).not.toContain(KEY);
    expect(memory.rows).toContain(`account ${KEY_ACCOUNT}`);
    expect(body.restored.next).toContain('Give Anthropic API a key that works on the “Foundation model accounts / API keys” step: Anthropic did not accept it: invalid x-api-key.');
  });

  it('stores nothing for a GitHub sign-in GitHub refuses, and asks for that bot to be connected again', async () => {
    const { post, memory } = await serve({}, [REFRESH]);

    const response = await post('/v1/restore', { archive: await sealed(), passphrase: PASSPHRASE });
    const body = (await response.json()) as { restored: { next: string[] }; renames: unknown[] };

    expect(response.status).toBe(200);
    expect(memory.secrets.has('github-refresh-builder')).toBe(false);
    expect(memory.rows).not.toContain('credential builder');
    // Its account is still the one the backup named, for the walkthrough to connect.
    expect(memory.rows).toContain('login builder=fleetadlc-atlas-janedoe');
    expect(body.renames).toEqual([]);
    expect(body.restored.next).toContain(
      'Connect fleetadlc-atlas-janedoe to GitHub again: GitHub did not accept it: The refresh token passed is incorrect or expired.',
    );
  });

  it('refuses a choice that ticks a sign-in that cannot be restored, and writes nothing', async () => {
    const { post, memory } = await serve();

    const response = await post('/v1/restore', { archive: await sealed(), passphrase: PASSPHRASE, signIns: { [`account:${KEY_ACCOUNT}`]: true } });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Anthropic API’s sign-in cannot be restored: Anthropic did not accept it: invalid x-api-key',
    );
    expect(memory.rows).toEqual([]);
  });

  it('leaves a sign-in unticked in the walkthrough where it was: not used, not written', async () => {
    const { post, memory, refreshed } = await serve();

    await post('/v1/restore', { archive: await sealed(), passphrase: PASSPHRASE, signIns: { 'bot:builder': false } });

    expect(refreshed).toEqual([]);
    expect(memory.secrets.has('github-refresh-builder')).toBe(false);
  });

  it('opens an unencrypted archive without a passphrase, and says it was one', async () => {
    const { post } = await serve();

    const response = await post('/v1/restore/preview', { archive: writePlain(archive()).toString('base64') });

    expect(((await response.json()) as { sealed: boolean }).sealed).toBe(false);
  });

  it('says a wrong passphrase in the words a person can act on', async () => {
    const { post, memory } = await serve();

    const response = await post('/v1/restore', { archive: await sealed(), passphrase: 'not it' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('that passphrase does not open this archive');
    expect(memory.rows).toEqual([]);
  });
});

describe('restoring onto an install that is set up', () => {
  const setUp: InstallFacts = { appConfigured: true, repositories: [], connectedBots: ['fleetadlc-atlas-janedoe'], modelAccounts: [] };

  it('is refused, in one sentence, before the archive is even opened', async () => {
    const { post, memory } = await serve({ facts: async () => setUp });

    for (const path of ['/v1/restore', '/v1/restore/preview']) {
      const response = await post(path, { archive: (await encryptBackup(archive(), PASSPHRASE)).toString('base64'), passphrase: PASSPHRASE });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'This install is already set up: restore into it from Settings → Backup, which compares the backup with this install first.' });
    }
    expect(memory.rows).toEqual([]);
    expect([...memory.secrets.keys()]).toEqual(['internal-api-secret']);
  });

  it('says what is set up, for the walkthrough to decide whether to offer a restore', async () => {
    const { base } = await serve({ facts: async () => setUp });

    const answer = await (await fetch(`${base}/v1/restore`)).json();

    expect(answer).toEqual({ clean: false, setUp: ['the GitHub App', 'fleetadlc-atlas-janedoe, connected to GitHub'] });
  });
});

describe('the backup Undo puts back', () => {
  it('reads the install without its history, which Undo never uses', async () => {
    vi.mocked(readInstall).mockResolvedValueOnce(snapshot());
    const deps = defaultRestoreIntoDeps({
      config: {} as never,
      hostd: { signInFiles: async () => null } as never,
      names: {} as never,
      actors: {} as never,
      dispatchGate: {} as never,
    });

    const contents = await deps.snapshot();

    expect(vi.mocked(readInstall).mock.calls.at(-1)?.[0]).toMatchObject({ install: true, history: false });
    expect(contents.history ?? null).toBeNull();
    expect(contents.secrets['github-app-private-key']).toBe(APP_KEY);
  });
});

describe('what counts as set up', () => {
  function memoryStore(values: Record<string, string>): SecretStore {
    const data = new Map(Object.entries(values));
    return {
      get: async (ref) => data.get(ref) ?? null,
      set: async (ref, value) => void data.set(ref, value),
      delete: async (ref) => void data.delete(ref),
      list: async () => [...data.keys()],
    };
  }
  const config = { gitHubClientId: '', webhookSecret: '', organization: '', humans: [], publicUrl: '', automationBot: null } as never;

  it('is nothing on a fresh install: seats seeded, a login remembered for one, no credential anywhere', async () => {
    setSecretStore(memoryStore({ 'internal-api-secret': 'x' }));
    const facts = await installFacts(config);

    // `fleetadlc-flow-janedoe` names an account and holds nothing for it: not connected.
    expect(facts).toEqual({ appConfigured: false, repositories: [], connectedBots: [], modelAccounts: [] });
  });

  it('is a bot holding a credential, and the App’s key', async () => {
    setSecretStore(memoryStore({ 'github-refresh-builder': 'r', 'github-app-private-key': 'k' }));
    const facts = await installFacts(config);

    expect(facts.connectedBots).toEqual(['builder']);
    expect(facts.appConfigured).toBe(true);
  });

  it('is a bot whose credential is recorded as active, even with its secret elsewhere', async () => {
    setSecretStore(memoryStore({}));
    CREDENTIALS.b2 = { status: 'active' };
    try {
      expect((await installFacts(config)).connectedBots).toEqual(['fleetadlc-flow-janedoe']);
    } finally {
      delete CREDENTIALS.b2;
    }
  });
});

describe('a restored bot’s rename', () => {
  it('goes through the one routine that renames bots, by the bot’s id', async () => {
    const renames: unknown[] = [];
    const names = { rename: vi.fn(async (input: unknown) => (renames.push(input), { botId: 'b1', from: 'builder', to: 'x', state: 'renamed' as const })) };
    const deps = defaultBackupDeps({ config: {} as never, hostd: {} as never, names: names as never });

    const outcome = await deps.target('alex@example.test').rename?.({ name: 'builder', to: 'fleetadlc-atlas-janedoe', reason: 'restored as fleetadlc-atlas-janedoe' });

    expect(outcome?.state).toBe('renamed');
    expect(renames).toEqual([{ botId: 'b1', to: 'fleetadlc-atlas-janedoe', reason: 'restored as fleetadlc-atlas-janedoe', actor: 'alex@example.test' }]);
  });
});

describe('restoring into an install that is set up, from Settings', () => {
  function stubInto(options: { running?: boolean } = {}) {
    const calls: unknown[][] = [];
    const job = {
      id: 'job-1',
      kind: 'restore',
      state: 'waiting',
      startedAt: NOW.toISOString(),
      finishedAt: null,
      waitingFor: ['fleetadlc-other'],
      error: null,
      result: null,
    };
    const into = {
      running: options.running ?? false,
      compare: async (contents: BackupContents) => {
        calls.push(['compare', contents.bots.length]);
        return {
          comparison: {
            groups: [{ group: 'install', items: [{ key: 'setting:organization', label: 'The organization', state: 'same' }] }],
            choices: {},
          },
        };
      },
      start: async (_contents: BackupContents, choices: unknown, actor: string) => {
        calls.push(['start', choices, actor]);
        return job;
      },
      view: () => job,
      undoState: async () => ({ restoredAt: NOW.toISOString(), until: '2026-09-25T12:00:00.000Z', backupMadeAt: NOW.toISOString(), actor: 'alex@example.test' }),
      startUndo: async (actor: string) => {
        calls.push(['undo', actor]);
        return { ...job, kind: 'undo' };
      },
    };
    return { into: into as unknown as import('./restore-into.js').RestoreInto, calls };
  }
  const sealed = async () => (await encryptBackup(archive(), PASSPHRASE)).toString('base64');
  const setUp: InstallFacts = { appConfigured: true, repositories: [], connectedBots: ['fleetadlc-atlas-janedoe'], modelAccounts: [] };

  it('lays the archive beside this install, whether or not it is set up, and says what can be undone', async () => {
    const { into, calls } = stubInto();
    const { post, memory } = await serve({ facts: async () => setUp, into });

    const response = await post('/v1/restore/into/preview', { archive: await sealed(), passphrase: PASSPHRASE });
    const body = (await response.json()) as { comparison: { groups: unknown[] }; undo: { until: string }; holds: { bots: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.comparison.groups).toHaveLength(1);
    expect(body.undo.until).toBe('2026-09-25T12:00:00.000Z');
    expect(calls).toEqual([['compare', 1]]);
    expect(memory.rows).toEqual([]);
  });

  it('starts it with the person’s choices, as the person, and answers where it has got to', async () => {
    const { into, calls } = stubInto();
    const { post, base } = await serve({ facts: async () => setUp, into });

    const response = await post('/v1/restore/into', { archive: await sealed(), passphrase: PASSPHRASE, choices: { 'setting:engineUpdates': true } });
    const body = (await response.json()) as { job: { state: string; waitingFor: string[] } };

    expect(response.status).toBe(200);
    expect(body.job).toMatchObject({ state: 'waiting', waitingFor: ['fleetadlc-other'] });
    expect(calls[0]).toEqual(['start', { 'setting:engineUpdates': true }, 'local operator']);
    const status = (await (await fetch(`${base}/v1/restore/into`)).json()) as { job: { id: string }; undo: unknown };
    expect(status.job.id).toBe('job-1');
  });

  it('starts an undo', async () => {
    const { into, calls } = stubInto();
    const { post } = await serve({ into });

    const response = await post('/v1/restore/undo', {});

    expect(((await response.json()) as { job: { kind: string } }).job.kind).toBe('undo');
    expect(calls).toEqual([['undo', 'local operator']]);
  });

  it('refuses an undo while a restore into the install is still starting', async () => {
    const { into, calls } = stubInto();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const inStart = new Promise<void>((resolve) => (entered = resolve));
    const starting = into.start.bind(into);
    (into as unknown as { start: typeof into.start }).start = async (...args) => {
      entered();
      await started;
      return starting(...args);
    };
    const { post } = await serve({ facts: async () => setUp, into });

    const restoring = post('/v1/restore/into', { archive: await sealed(), passphrase: PASSPHRASE, choices: {} });
    // Until its job begins, only the route knows a restore is on its way.
    await inStart;
    const undo = await post('/v1/restore/undo', {});
    release();

    expect(undo.status).toBe(409);
    expect((await restoring).status).toBe(200);
    expect(calls.filter((call) => call[0] === 'undo')).toEqual([]);
  });

  it('refuses a restore body past the limit as it arrives, when no length was declared', async () => {
    const { into, calls } = stubInto();
    const { base } = await serve({ facts: async () => setUp, into });
    const { request } = await import('node:http');
    const { RESTORE_BODY_MAX } = await import('./backup.js');

    const status = await new Promise<number>((resolve, reject) => {
      const sending = request(`${base}/v1/restore/into/preview`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      sending.on('error', reject);
      // Chunked: no Content-Length for the old check to read.
      const chunk = Buffer.alloc(4 * 1024 * 1024, 0x20);
      let sent = 0;
      const more = (): void => {
        while (sent <= RESTORE_BODY_MAX) {
          sent += chunk.length;
          if (!sending.write(chunk)) return void sending.once('drain', more);
        }
        sending.end();
      };
      more();
    });

    expect(status).toBe(413);
    expect(calls).toEqual([]);
  }, 20_000);

  it('runs one restore at a time: the walkthrough’s waits while one into the install runs', async () => {
    const { into } = stubInto({ running: true });
    const { post } = await serve({ into });

    const response = await post('/v1/restore', { archive: await sealed(), passphrase: PASSPHRASE });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('a restore is already running');
  });
});
