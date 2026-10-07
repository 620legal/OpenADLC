import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupError,
  EVERYTHING,
  archivedSeat,
  botsNeedingDeviceFlow,
  changeCount,
  credentialsForReplacedAccounts,
  describeContents,
  describeManifest,
  describeOmittedRefreshTokens,
  describePlan,
  describeUnrestoredRefreshTokens,
  encryptBackup,
  decryptBackup,
  passphraseRefusal,
  passphraseWarning,
  planRestore,
  withoutRefreshTokens,
  type ArchivedBot,
  type BackupContents,
  type BackupSelection,
  type InstallFacts,
  type InstallShape,
  type InstallSnapshot,
  type RestoreDb,
  type RestoreTarget,
  type TakeOverPorts,
} from '@fleetadlc/backup';
import { DeviceAuthError } from '@fleetadlc/github';
import { buildBackup } from '@fleetadlc/backup';
import {
  asMissingSchema,
  CONFIRM_WORD,
  backup,
  confirmed,
  defaultBackupPath,
  outputRefusal,
  printable,
  resolveSelection,
  restore,
  safeMessage,
  selectionFromFlags,
  writeArchive,
  type ArchiveSource,
  type BackupDeps,
  type BackupIo,
  type InstallAccess,
  type SignInProviders,
} from './backup.js';

/**
 * Nothing here touches `~/.fleetadlc`, a database, or a terminal: the install is a
 * fake and every path is under `os.tmpdir()`. For the one command in the CLI
 * that rewrites every credential in an install, that is the difference between
 * a unit test and an incident.
 */

/**
 * The values that must never reach the output.
 *
 * Deliberately gibberish, and deliberately sharing no substring with any ref,
 * key, bot name or login below — a fixture where the organization was `janedoe`
 * and a bot was `fleetadlc-atlas-janedoe` fails the leak assertion without anything
 * having leaked, which is the sort of test that gets deleted rather than fixed.
 */
const VALUES = {
  appKey: '-----BEGIN RSA PRIVATE KEY-----zzz-app-key-zzz',
  refresh: 'ghr_zzz-atlas-refresh-zzz',
  hook: 'zzz-webhook-secret-zzz',
  org: 'zzz-org-zzz',
};

const MADE_AT = new Date('2026-09-21T10:00:00.000Z');

/** What an install looked like to a backup before seats and assignments: the shape older tests hand in. */
interface InstallContents {
  secrets: Record<string, string>;
  settings: Record<string, string>;
  bots: ArchivedBot[];
}

/**
 * The archive a choice makes of an install described by its secrets,
 * settings and bots alone. A bot with no seat recorded sits in the seat its
 * persona was.
 */
function buildContents(found: InstallContents, now: Date, selection: BackupSelection = EVERYTHING): BackupContents {
  const snapshot: InstallSnapshot = {
    secrets: found.secrets,
    settings: found.settings,
    bots: found.bots.map((bot) => ({
      name: bot.name,
      slot: bot.slot ?? archivedSeat(bot),
      githubLogin: bot.githubLogin,
      engine: bot.engine,
      model: bot.model ?? '',
      modelAccountId: bot.modelAccountId ?? null,
      modelSetAt: bot.modelSetAt ?? null,
    })),
    credentials: {},
    repositories: [],
    accounts: [],
    logins: {},
    history: null,
  };
  return buildBackup(snapshot, selection, now).contents;
}

/**
 * An archive as `fleetadlc backup` wrote it before a backup could be chosen:
 * version 1, the crew by persona, and no refresh token — they were left out.
 * Most of the restore tests below are about archives like this one, which a
 * restore still has to read the way it always did.
 */
function oldArchive(parts: Partial<InstallContents> = {}): BackupContents {
  const found: InstallContents = {
    secrets: { 'github-app-private-key': VALUES.appKey, 'github-refresh-atlas': VALUES.refresh },
    settings: { organization: VALUES.org, webhookSecret: VALUES.hook },
    bots: [
      { name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'opus-4' },
      { name: 'flow', githubLogin: null, engine: 'claude', model: 'opus-4' },
    ],
    ...parts,
  };
  const secrets = withoutRefreshTokens(found.secrets);
  return {
    manifest: {
      version: 1,
      createdAt: MADE_AT.toISOString(),
      counts: { secrets: Object.keys(secrets).length, settings: Object.keys(found.settings).length, bots: found.bots.length },
    },
    secrets,
    settings: found.settings,
    bots: found.bots,
  };
}

const archiveOf = oldArchive;

/** The whole install without the sign-ins: `fleetadlc backup --no-sign-ins`. */
const NO_SIGN_INS: BackupSelection = { ...EVERYTHING, botSignIns: false, accountSignIns: false };

function snapshotOf(found: InstallContents | undefined): InstallSnapshot {
  const contents = found ?? { secrets: {}, settings: {}, bots: [] };
  return {
    secrets: contents.secrets,
    settings: contents.settings,
    bots: contents.bots.map((bot) => ({
      name: bot.name,
      slot: bot.slot ?? bot.name,
      githubLogin: bot.githubLogin,
      engine: bot.engine,
      model: bot.model ?? 'none',
      modelAccountId: null,
      modelSetAt: null,
    })),
    credentials: {},
    repositories: [],
    accounts: [],
    logins: {},
    history: null,
  };
}

/**
 * An install that records what a restore wrote. Rows count only once the
 * transaction they were written in commits; a secret the restore could not
 * write can be named, to see what a failure leaves behind.
 */
function fakeInstall(
  options: { shape?: Partial<InstallShape>; contents?: InstallContents; failSecret?: string; clientId?: string } = {},
) {
  const wrote = {
    secrets: [] as string[],
    settings: [] as string[],
    bots: [] as string[],
    deleted: [] as string[],
  };
  /** Every write and delete, in the order the restore made them. */
  const order: string[] = [];
  /** What the secret store holds, starting from what the shape says it has. */
  const store = new Map<string, string>((options.shape?.secretRefs ?? []).map((ref) => [ref, `current-${ref}`]));
  const values: Record<string, string> = {};

  const target: RestoreTarget = {
    secrets: {
      get: async (ref) => store.get(ref) ?? null,
      set: async (ref, value) => {
        if (ref === options.failSecret) throw new Error(`the store refused ${ref}`);
        store.set(ref, value);
        values[ref] = value;
        wrote.secrets.push(ref);
        order.push(`secret ${ref}`);
      },
      delete: async (ref) => {
        if (ref === options.failSecret) throw new Error(`the store refused ${ref}`);
        store.delete(ref);
        wrote.deleted.push(ref);
        order.push(`delete ${ref}`);
      },
    },
    async transaction(fn) {
      const settings: string[] = [];
      const bots: string[] = [];
      const db: RestoreDb = {
        setSetting: async (key) => void settings.push(key),
        replaceSpendingLimits: async () => undefined,
        mergeSpendingLimits: async () => undefined,
        putAccount: async () => undefined,
        putRepository: async () => undefined,
        setBotLogin: async (name, login) => {
          bots.push(`${name}=${login}`);
          order.push(`bot ${name}=${login}`);
        },
        putIdentity: async () => undefined,
        setAssignment: async () => undefined,
        setLook: async () => undefined,
        putCredential: async () => undefined,
        deleteCredential: async (name) => void order.push(`forget credential ${name}`),
        putHistory: async () => ({ threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0 }),
        audit: async () => undefined,
      };
      const result = await fn(db);
      wrote.settings.push(...settings);
      wrote.bots.push(...bots);
      return result;
    },
  };

  const shape: InstallShape = { secretRefs: [], settingKeys: [], bots: [], ...options.shape };
  /** Set up, the way the walkthrough counts it: an app, a repository, a bot holding a credential, an account. */
  const facts: InstallFacts = {
    appConfigured: shape.secretRefs.includes('github-app-private-key') || shape.settingKeys.includes('githubClientId'),
    repositories: shape.repositories ?? [],
    connectedBots: shape.bots
      .filter((bot) => shape.secretRefs.includes(`github-refresh-${bot.name}`) || shape.secretRefs.includes(`github-token-${bot.name}`))
      .map((bot) => bot.name),
    modelAccounts: shape.accounts ?? [],
  };
  const access: InstallAccess = {
    shape: async () => shape,
    snapshot: async () => snapshotOf(options.contents),
    facts: async () => facts,
    signInFacts: () => ({
      secret: async (ref) => store.get(ref) ?? null,
      folder: async () => null,
      credential: async () => null,
    }),
    clientId: async () => options.clientId ?? null,
    target: () => target,
    close: async () => {},
  };
  return { access, wrote, order, store, values };
}

/**
 * The providers, answered here. A GitHub token signs in as the account
 * `logins` names it; a refresh token in `spent` is one GitHub refuses, and any
 * other comes back as a new pair. Nothing leaves the process.
 */
function fakeProviders(options: { spent?: string[]; refuse?: string[]; logins?: Record<string, string> } = {}) {
  const logins: Record<string, string> = {
    [VALUES.refresh]: 'fleetadlc-atlas-janedoe',
    'ghr_zzz-nova-refresh-zzz': 'fleetadlc-nova-janedoe',
    'ghu_zzz-static-zzz': 'fleetadlc-atlas-janedoe',
    ...options.logins,
  };
  const refreshed: string[] = [];
  const issued = new Map<string, string>();
  const providers: SignInProviders = {
    checks: {
      listModels: async (_provider, secret) => {
        if (options.refuse?.includes(secret)) throw new Error('invalid x-api-key');
        return [{ id: 'model-one' }];
      },
      gitHubUser: async (token) => {
        if (options.refuse?.includes(token)) throw new Error('Bad credentials');
        return { login: logins[token] ?? 'nobody-in-particular', id: 1 };
      },
    },
    takeOver: (): TakeOverPorts => ({
      refreshGitHub: async (token) => {
        refreshed.push(token);
        if (options.spent?.includes(token)) throw new DeviceAuthError('bad_refresh_token', 'The refresh token passed is incorrect or expired.');
        const access = `ghu_zzz-fresh-${refreshed.length}-zzz`;
        issued.set(access, logins[token] ?? 'nobody-in-particular');
        return {
          accessToken: access,
          refreshToken: `ghr_zzz-fresh-${refreshed.length}-zzz`,
          expiresAt: null,
          refreshExpiresAt: null,
          scopes: [],
          tokenType: 'bearer',
        };
      },
      gitHubUser: async (token) => ({ login: issued.get(token) ?? 'nobody-in-particular', id: 1 }),
      adoptLogin: async () => ({ ok: true, message: 'answered: OK' }),
    }),
  };
  return { providers, refreshed };
}

/** Records everything the command says, and answers its questions in order. */
function fakeIo(answers: string[] = []) {
  const said: string[] = [];
  const record =
    (kind: string) =>
    (text = '') =>
      void said.push(`${kind} ${text}`.trim());
  const io: BackupIo = {
    out: {
      heading: record('heading'),
      step: record('step'),
      ok: record('ok'),
      warn: record('warn'),
      fail: record('fail'),
      note: record('note'),
      plain: record('plain'),
    },
    askSecret: async (question) => {
      said.push(`ask-secret ${question}`);
      return answers.shift() ?? '';
    },
    askLine: async (question) => {
      said.push(`ask ${question}`);
      return answers.shift() ?? '';
    },
  };
  return { io, said, text: () => said.join('\n') };
}

function backupDeps(io: BackupIo, install: InstallAccess) {
  const written: string[] = [];
  /** Which port the bytes came from, so the two forms cannot be confused. */
  const form: string[] = [];
  /** What was actually packed, which is the only place a left-out secret can hide. */
  const packed: BackupContents[] = [];
  const deps: BackupDeps = {
    install,
    io,
    now: () => MADE_AT,
    // The sealed bytes carry the passphrase and the values, so a test that finds
    // neither in the output knows they travelled only into the file.
    seal: (contents, passphrase) => {
      form.push('sealed');
      packed.push(contents);
      return Buffer.from(`${passphrase}:${JSON.stringify(contents)}`);
    },
    plain: (contents) => {
      form.push('plain');
      packed.push(contents);
      return Buffer.from(JSON.stringify(contents));
    },
    write: (path) => void written.push(path),
  };
  return { deps, written, form, packed };
}

function fakeArchive(
  contents: BackupContents,
  open?: (passphrase: string) => BackupContents,
  sealed = true,
): ArchiveSource {
  return { manifest: () => contents.manifest, sealed: () => sealed, open: open ?? (() => contents) };
}

/** A temporary directory, removed after the test that made it. */
const made: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-backup-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Both commands report failure through `process.exitCode`; a test that left one
 * behind would make a passing suite exit non-zero.
 */
const exitCodeBefore = process.exitCode;
afterEach(() => {
  process.exitCode = exitCodeBefore;
});

describe('where a backup is allowed to land', () => {
  it('refuses a path inside the repository working tree, and says why', () => {
    // The archive holds the App private key and the signing keys. Inside the
    // tree it is one `git add -A` from being published, and a .gitignore line
    // travels with the repository while the habit of running this from the
    // checkout travels with the operator.
    const repo = scratch();
    const refusal = outputRefusal(join(repo, 'backups', 'today.fleetbak'), repo);

    expect(refusal?.reason).toContain('inside the repository');
    expect(refusal?.notes.join(' ')).toMatch(/App key|committable/);
    // Everything in it, not only the App key: a non-expiring bot token or an
    // API key in a committed file is just as published.
    expect(refusal?.notes.join(' ')).toContain('any non-expiring bot tokens and API keys');
  });

  it('refuses the repository root itself, which is what `--out .` resolves to', () => {
    const repo = scratch();
    expect(outputRefusal(repo, repo)).not.toBeNull();
  });

  it('allows a path outside the repository', () => {
    const repo = scratch();
    expect(outputRefusal(join(scratch(), 'fleetadlc.fleetbak'), repo)).toBeNull();
  });

  it('sees through a symlink that leads back into the repository', () => {
    // `/tmp` is a link to `/private/tmp` here, and a checkout reached through a
    // link is normal. Comparing the typed path would let either one through.
    const repo = scratch();
    mkdirSync(join(repo, 'infra'));
    const link = join(scratch(), 'shortcut');
    symlinkSync(join(repo, 'infra'), link);

    expect(outputRefusal(join(link, 'today.fleetbak'), repo)?.reason).toContain('inside the repository');
  });

  it('refuses to overwrite a file that is already there', () => {
    // The default path carries the date, so the file it would land on is either
    // today's archive or one somebody put there deliberately.
    const target = join(scratch(), 'today.fleetbak');
    writeFileSync(target, 'an earlier backup');

    expect(outputRefusal(target, scratch())?.reason).toContain('already there');
  });

  it('creates the file, so one that appeared after the look, or a dangling link, is not written through', () => {
    // `outputRefusal` looks before the passphrase prompt. A link planted where
    // nothing exists yet passed that look, and the archive went where it pointed.
    const dir = scratch();
    const elsewhere = join(dir, 'elsewhere.fleetbak');
    const target = join(dir, 'today.fleetbak');
    symlinkSync(elsewhere, target);
    expect(outputRefusal(target, scratch())).toBeNull();

    expect(() => writeArchive(target, Buffer.from('sealed'))).toThrow(/refusing to write .*: something is already there/);
    expect(existsSync(elsewhere)).toBe(false);

    const fresh = join(dir, 'fresh.fleetbak');
    writeArchive(fresh, Buffer.from('sealed'));
    expect(readFileSync(fresh, 'utf8')).toBe('sealed');
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    expect(() => writeArchive(fresh, Buffer.from('again'))).toThrow(/already there/);
    expect(readFileSync(fresh, 'utf8')).toBe('sealed');
  });

  it('defaults to a dated file in the home directory, not the working directory', () => {
    expect(defaultBackupPath(MADE_AT, '/home/op')).toBe('/home/op/fleetadlc-backup-2026-09-21.fleetbak');
  });
});

describe('the passphrase an archive is sealed with', () => {
  it('refuses an empty one rather than writing a file that only looks encrypted', () => {
    expect(passphraseRefusal('', '')).toMatch(/empty/);
  });

  it('refuses two that do not match, because a typo is discovered too late to fix', () => {
    expect(passphraseRefusal('correct horse', 'correct hose')).toMatch(/do not match/);
  });

  it('accepts a pair that match', () => {
    expect(passphraseRefusal('correct horse', 'correct horse')).toBeNull();
  });

  it('writes no archive when the second passphrase differs from the first', async () => {
    const install = fakeInstall({ contents: { secrets: { 'github-app-private-key': 'x' }, settings: {}, bots: [] } });
    const io = fakeIo(['correct horse', 'correct hose']);
    const { deps, written } = backupDeps(io.io, install.access);

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak') }, deps);

    expect(written).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(io.text()).toContain('nothing was written');
  });

  it('warns about a short matching pair, and still writes the archive with it', async () => {
    const install = fakeInstall({ contents: { secrets: { 'github-app-private-key': 'x' }, settings: {}, bots: [] } });
    const io = fakeIo(['1234', '1234']);
    const { deps, written, form } = backupDeps(io.io, install.access);

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak') }, deps);

    expect(io.said).toContain(`warn ${passphraseWarning('1234')}`);
    expect(io.text()).toContain('warn Shorter than 12 characters');
    expect(written).toHaveLength(1);
    expect(form).toEqual(['sealed']);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('says nothing of length for a long enough one', async () => {
    const install = fakeInstall({ contents: { secrets: { 'github-app-private-key': 'x' }, settings: {}, bots: [] } });
    const io = fakeIo(['correct horse', 'correct horse']);
    const { deps } = backupDeps(io.io, install.access);

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak') }, deps);

    expect(io.text()).not.toContain('Shorter than 12 characters');
  });

  it('makes one when the first prompt is left empty, prints it once, and seals with it', async () => {
    const install = fakeInstall({ contents: { secrets: { 'github-app-private-key': 'x' }, settings: {}, bots: [] } });
    const io = fakeIo(['']);
    const sealedWith: string[] = [];
    const { deps, written } = backupDeps(io.io, install.access);
    const seal = deps.seal;
    deps.seal = (contents, passphrase) => {
      sealedWith.push(passphrase);
      return seal(contents, passphrase);
    };

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak') }, deps);

    expect(io.said.filter((line) => line.startsWith('ask-secret'))).toEqual(['ask-secret Passphrase (Enter makes one)']);
    expect(sealedWith).toHaveLength(1);
    const made = sealedWith[0] ?? '';
    expect(made.length).toBeGreaterThanOrEqual(12);
    expect(io.said.filter((line) => line.includes(made))).toEqual([`ok Passphrase: ${made}`]);
    expect(io.text()).toContain('password manager');
    expect(io.text()).not.toContain('Shorter than 12 characters');
    expect(written).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('shows what the archive will hold before asking for a passphrase', async () => {
    // Names are safe to print and are the only way to check the archive is what
    // it should be — after the passphrase it is too late to change your mind.
    const contents: InstallContents = {
      secrets: { 'github-app-private-key': VALUES.appKey },
      settings: {},
      bots: [],
    };
    const io = fakeIo(['a passphrase', 'a passphrase']);
    const { deps, written } = backupDeps(io.io, fakeInstall({ contents }).access);

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak') }, deps);

    const listed = io.said.findIndex((line) => line.includes('github-app-private-key'));
    const asked = io.said.findIndex((line) => line.startsWith('ask-secret'));
    expect(listed).toBeGreaterThan(-1);
    expect(listed).toBeLessThan(asked);
    expect(written).toHaveLength(1);
  });
});

describe('what an archive says it holds', () => {
  it('counts its contents in the manifest, so a restore can say so before decrypting', () => {
    // An archive from before a backup could be chosen counted three things.
    const manifest = archiveOf().manifest;

    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBe(MADE_AT.toISOString());
    expect(manifest.counts).toEqual({ secrets: 1, settings: 2, bots: 2 });
  });

  it('reports version, age and counts without a passphrase', () => {
    expect(describeManifest(archiveOf().manifest).join('\n')).toContain('1 secret, 2 settings, 2 bots');
  });

  it('says what a new archive chose, as well as how much it holds', async () => {
    const sealed = await encryptBackup(buildContents(archiveInstall, MADE_AT), 'a passphrase');
    const said = describeManifest((await decryptBackup(sealed, 'a passphrase')).manifest).join('\n');

    expect(said).toContain('format version 3');
    expect(said).toContain('GitHub sign-ins included; history left out');
  });
});

/** An install with one connected bot, as a backup finds it. */
const archiveInstall: InstallContents = {
  secrets: { 'github-app-private-key': VALUES.appKey, 'github-refresh-atlas': VALUES.refresh },
  settings: { organization: VALUES.org, webhookSecret: VALUES.hook },
  bots: [
    { name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'opus-4' },
    { name: 'flow', githubLogin: null, engine: 'claude', model: 'opus-4' },
  ],
};

describe('what a restore would change', () => {
  it('separates the refs this install already has from the ones it does not', () => {
    // The split is the reason `--dry-run` exists: an operator restoring one lost
    // bot has to see that the same archive is about to put an older App private
    // key over the one this install signs with.
    const plan = planRestore(
      archiveOf({
        secrets: {
          'github-app-private-key': VALUES.appKey,
          'ssh-signing-atlas': 'zzz-signing-key-zzz',
        },
      }),
      {
        secretRefs: ['github-app-private-key'],
        settingKeys: [],
        bots: [],
      },
    );

    expect(plan.secrets.overwrite).toEqual(['github-app-private-key']);
    expect(plan.secrets.create).toEqual(['ssh-signing-atlas']);
  });

  it('separates settings it would overwrite from settings it would add', () => {
    const plan = planRestore(archiveOf(), {
      secretRefs: [],
      settingKeys: ['organization'],
      bots: [],
    });

    expect(plan.settings.overwrite).toEqual(['organization']);
    expect(plan.settings.create).toEqual(['webhookSecret']);
  });

  it('skips a setting key this install has never heard of', () => {
    // An archive from a newer install carries keys `setSetting` would refuse.
    // Skipped and named, rather than failing the whole restore.
    const plan = planRestore(archiveOf({ settings: { organization: VALUES.org, quantumMode: 'on' } }), {
      secretRefs: [],
      settingKeys: [],
      bots: [],
    });

    expect(plan.settings.unknown).toEqual(['quantumMode']);
    expect(plan.settings.create).toEqual(['organization']);
  });

  it('tells a bot that gets its account back apart from one that would be replaced', () => {
    const plan = planRestore(
      archiveOf({
        bots: [
          { name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'opus-4' },
          { name: 'nova', githubLogin: 'fleetadlc-nova-janedoe', engine: 'claude', model: 'opus-4' },
          { name: 'ghost', githubLogin: 'fleetadlc-ghost', engine: 'claude', model: 'opus-4' },
        ],
      }),
      {
        secretRefs: [],
        settingKeys: [],
        bots: [
          { name: 'atlas', slot: 'builder', githubLogin: null },
          { name: 'nova', slot: 'system-engineer', githubLogin: 'fleetadlc-nova' },
        ],
      },
    );

    expect(plan.bots.connect).toEqual([{ name: 'atlas', login: 'fleetadlc-atlas-janedoe' }]);
    expect(plan.bots.replace).toEqual([{ name: 'nova', from: 'fleetadlc-nova', to: 'fleetadlc-nova-janedoe' }]);
    // Nothing in this install to hang a login on: the archive has no role, teams
    // or container for it, so `fleetadlc up` has to make the row first.
    expect(plan.bots.absent).toEqual(['ghost']);
  });

  it('counts nothing to do when the install already matches the archive', () => {
    const plan = planRestore(archiveOf(), {
      secretRefs: ['github-app-private-key', 'github-refresh-atlas'],
      settingKeys: ['organization', 'webhookSecret'],
      bots: [{ name: 'atlas', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' }],
    });

    expect(plan.bots.unchanged).toEqual(['atlas']);
    // The App key and both settings are still overwrites. The refresh token is
    // not one of them: it was never packed, and this install already holds its
    // own, for the same account, so it is neither deleted nor asked for again.
    expect(plan.secrets.remove).toEqual([]);
    expect(plan.bots.deviceFlow).toEqual([]);
    expect(changeCount(plan)).toBe(3);
    expect(changeCount(planRestore(archiveOf({ secrets: {}, settings: {} }), {
      secretRefs: [],
      settingKeys: [],
      bots: [{ name: 'atlas', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' }],
    }))).toBe(0);
  });
});

describe('GitHub sign-ins are a choice', () => {
  /**
   * GitHub rotates a refresh token every time it is used, so the copy an
   * archive takes moves the sign-in to whichever install uses it first: right
   * when the old install is going away, wrong when it keeps running — then one
   * of the two needs reconnecting. So it is a tick of its own, on for the whole
   * install and off for part of it, and said out loud either way.
   */
  const found: InstallContents = {
    secrets: {
      'github-app-private-key': VALUES.appKey,
      'github-refresh-atlas': VALUES.refresh,
      'github-refresh-nova': 'ghr_zzz-nova-refresh-zzz',
      'ssh-signing-atlas': 'zzz-signing-key-zzz',
      'registry-token': VALUES.hook,
    },
    settings: {
      organization: VALUES.org,
      githubClientId: 'Iv1.zzz-client-zzz',
      operatorEmail: 'op@example.test',
    },
    bots: [
      { name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'opus-4' },
      { name: 'nova', githubLogin: 'fleetadlc-nova-janedoe', engine: 'claude', model: 'opus-4' },
      { name: 'flow', githubLogin: null, engine: 'claude', model: null },
    ],
  };

  it('are taken with the whole install, and the manifest says so', () => {
    const contents = buildContents(found, MADE_AT);

    expect(contents.secrets['github-refresh-atlas']).toBe(VALUES.refresh);
    expect(contents.secrets['github-refresh-nova']).toBe('ghr_zzz-nova-refresh-zzz');
    expect(contents.manifest.includes?.botSignIns).toBe(true);
  });

  it('are left out, every one, when they are not chosen — and what does not rotate stays', () => {
    const contents = buildContents(found, MADE_AT, NO_SIGN_INS);

    expect(contents.secrets).toEqual({
      'github-app-private-key': VALUES.appKey,
      'registry-token': VALUES.hook,
      'ssh-signing-atlas': 'zzz-signing-key-zzz',
    });
    expect(JSON.stringify(contents)).not.toContain(VALUES.refresh);
    expect(contents.settings).toEqual(found.settings);
    expect(contents.bots.map((bot) => bot.githubLogin)).toEqual(['fleetadlc-atlas-janedoe', 'fleetadlc-nova-janedoe', null]);
  });

  it('are said to move with the archive when they are taken', async () => {
    const io = fakeIo(['a passphrase', 'a passphrase']);
    const { deps, packed } = backupDeps(io.io, fakeInstall({ contents: found }).access);

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak') }, deps);

    expect(io.text()).toMatch(/GitHub sign-ins are included\. GitHub rotates a sign-in each time it is used/);
    expect(io.text()).toContain('if the old one keeps running, one of the two will need reconnecting');
    expect(packed[0]?.secrets['github-refresh-nova']).toBe('ghr_zzz-nova-refresh-zzz');
    expect(io.text()).not.toContain(VALUES.refresh);
  });

  it('are named as not stored when they are left out, and the sealed bytes do not hold them', async () => {
    const io = fakeIo(['a passphrase', 'a passphrase']);
    const { deps, packed } = backupDeps(io.io, fakeInstall({ contents: found }).access);

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak'), selection: NO_SIGN_INS }, deps);

    expect(io.text()).toContain('The GitHub sign-ins are left out, so each bot connects again after a restore');
    expect(io.text()).toContain('Not stored: github-refresh-atlas, github-refresh-nova.');
    expect(io.text()).not.toContain(VALUES.refresh);
    expect(packed).toHaveLength(1);
    expect(packed[0]?.secrets).not.toHaveProperty('github-refresh-atlas');
    expect(JSON.stringify(packed[0])).not.toContain(VALUES.refresh);
    expect(packed[0]?.secrets['ssh-signing-atlas']).toBe('zzz-signing-key-zzz');
    expect(packed[0]?.settings['operatorEmail']).toBe('op@example.test');
    expect(packed[0]?.settings['githubClientId']).toBe('Iv1.zzz-client-zzz');
  });

  it('are left out of an unencrypted archive as well, when they are not chosen', async () => {
    const io = fakeIo([]);
    const { deps, packed, form } = backupDeps(io.io, fakeInstall({ contents: found }).access);

    await backup(scratch(), { out: join(scratch(), 'plain.json'), unencrypted: true, selection: NO_SIGN_INS }, deps);

    expect(form).toEqual(['plain']);
    expect(packed[0]?.secrets).not.toHaveProperty('github-refresh-nova');
    expect(JSON.stringify(packed[0])).not.toContain('ghr_zzz-nova-refresh-zzz');
    expect(io.text()).not.toContain(VALUES.refresh);
  });

  it('come back with a new archive that carries them — checked by using them, and taken over — and nobody is asked to connect', async () => {
    const install = fakeInstall({
      shape: {
        secretRefs: [],
        settingKeys: [],
        bots: [
          { name: 'builder', slot: 'builder', githubLogin: null },
          { name: 'system-engineer', slot: 'system-engineer', githubLogin: null },
        ],
      },
    });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);
    const { providers, refreshed } = fakeProviders();

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers,
      archive: () => fakeArchive(buildContents(found, MADE_AT)),
    });

    // Exchanged — that is the check — and what is kept is what GitHub gave for them.
    expect(refreshed).toEqual([VALUES.refresh, 'ghr_zzz-nova-refresh-zzz']);
    expect(install.values['github-refresh-builder']).toBe('ghr_zzz-fresh-1-zzz');
    expect(install.values['github-refresh-system-engineer']).toBe('ghr_zzz-fresh-2-zzz');
    expect(io.text()).not.toContain('bots that will need to connect to GitHub again');
    expect(io.text()).toContain(
      'Checking a GitHub sign-in uses it — if it works, this install takes it over from wherever else it is in use.',
    );
    expect(io.text()).toContain('builder as fleetadlc-atlas-janedoe: can only be checked by using it — this restore checks it and takes it over');
    expect(io.text()).toContain('ok builder as fleetadlc-atlas-janedoe: checked by using it, and taken over');
    expect(io.text()).not.toContain(VALUES.refresh);
  });

  it('does not restore a refresh token an older archive still holds', () => {
    const old = oldArchive(found);
    old.secrets = { ...old.secrets, 'github-refresh-atlas': VALUES.refresh };

    const plan = planRestore(old, {
      secretRefs: ['github-app-private-key'],
      settingKeys: [],
      bots: [
        { name: 'atlas', slot: 'builder', githubLogin: null },
        { name: 'nova', slot: 'system-engineer', githubLogin: null },
      ],
    });

    expect(plan.secrets.overwrite).toEqual(['github-app-private-key']);
    expect(plan.secrets.create).toEqual(['registry-token', 'ssh-signing-atlas']);
    expect(JSON.stringify(plan)).not.toContain(VALUES.refresh);
    expect(plan.bots.deviceFlow).toEqual([
      { name: 'atlas', login: 'fleetadlc-atlas-janedoe' },
      { name: 'nova', login: 'fleetadlc-nova-janedoe' },
    ]);
  });

  it('names the refresh tokens an older archive held, the way a backup names the ones it left out', async () => {
    const old = oldArchive(found);
    old.secrets = { ...old.secrets, 'github-refresh-nova': 'ghr_zzz-nova-refresh-zzz', 'github-refresh-atlas': VALUES.refresh };
    const io = fakeIo(['a passphrase']);

    await restore('/tmp/x.fleetbak', { dryRun: true }, {
      install: fakeInstall().access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(old),
    });

    expect(planRestore(old, { secretRefs: [], settingKeys: [], bots: [] }).secrets.stale).toEqual([
      'github-refresh-atlas',
      'github-refresh-nova',
    ]);
    expect(io.text()).toContain('note Not restored: github-refresh-atlas, github-refresh-nova.');
    expect(io.text()).not.toContain(VALUES.refresh);
    expect(io.text()).not.toContain('ghr_zzz-nova-refresh-zzz');
    // An archive written since has none to name, and says only why.
    expect(describeUnrestoredRefreshTokens([])).toHaveLength(1);
    expect(describeUnrestoredRefreshTokens([]).join('\n')).not.toContain('Not restored');
    expect(describeOmittedRefreshTokens([]).join('\n')).not.toContain('Not stored');
  });

  it('names, on a restore of an older archive, the bots that will need to connect again', async () => {
    const old = oldArchive(found);
    old.secrets = { ...old.secrets, 'github-refresh-atlas': VALUES.refresh, 'github-refresh-nova': 'ghr_zzz-nova-refresh-zzz' };
    const install = fakeInstall({
      shape: {
        secretRefs: [],
        settingKeys: [],
        bots: [
          { name: 'atlas', slot: 'builder', githubLogin: null },
          { name: 'nova', slot: 'system-engineer', githubLogin: 'fleetadlc-nova-janedoe' },
        ],
      },
    });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(old),
    });

    expect(install.wrote.secrets).not.toContain('github-refresh-atlas');
    expect(install.wrote.secrets).not.toContain('github-refresh-nova');
    expect(install.wrote.secrets).toContain('github-app-private-key');
    expect(install.wrote.secrets).toContain('ssh-signing-atlas');
    expect(io.text()).toContain('bots that will need to connect to GitHub again');
    expect(io.text()).toContain('atlas as fleetadlc-atlas-janedoe');
    expect(io.text()).toContain('nova as fleetadlc-nova-janedoe');
    expect(io.text()).toMatch(/will need to connect again/);
    expect(io.text()).not.toContain(VALUES.refresh);
    expect(io.text()).not.toContain('ghr_zzz-nova-refresh-zzz');
    // `flow` has no account, so there is nothing to connect.
    expect(io.text()).not.toMatch(/flow as /);
  });

  it('leaves a bot alone when this install already holds a current refresh token for the same account', () => {
    const contents = oldArchive(found);
    const current = {
      secretRefs: ['github-refresh-atlas'],
      settingKeys: [],
      bots: [
        { name: 'atlas', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' },
        { name: 'nova', slot: 'system-engineer', githubLogin: 'fleetadlc-nova-janedoe' },
      ],
    };

    expect(botsNeedingDeviceFlow(contents, current)).toEqual([{ name: 'nova', login: 'fleetadlc-nova-janedoe' }]);
    expect(planRestore(contents, current).bots.deviceFlow).toEqual([{ name: 'nova', login: 'fleetadlc-nova-janedoe' }]);
  });

  it('asks again when the archive would connect the bot to a different account than the token on disk', () => {
    const again = botsNeedingDeviceFlow(oldArchive(found), {
      secretRefs: ['github-refresh-atlas'],
      settingKeys: [],
      bots: [
        { name: 'atlas', slot: 'builder', githubLogin: 'someone-else' },
        { name: 'nova', slot: 'system-engineer', githubLogin: 'fleetadlc-nova-janedoe' },
      ],
    });

    expect(again).toEqual([
      { name: 'atlas', login: 'fleetadlc-atlas-janedoe' },
      { name: 'nova', login: 'fleetadlc-nova-janedoe' },
    ]);
  });

  it('names a bot this install does not have once, with the remedy, and not as one to connect', () => {
    // There is no row to put a login on, so connecting is not the next step —
    // adding the seat is. Saying both sends the operator to the wrong one, and
    // `fleetadlc up` alone adds only a seat config/bots.yaml names.
    const plan = planRestore(oldArchive(found), {
      secretRefs: [],
      settingKeys: [],
      bots: [{ name: 'atlas', slot: 'builder', githubLogin: null }],
    });
    const text = describePlan(plan).join('\n');

    expect(plan.bots.absent).toEqual(['nova']);
    expect(plan.bots.deviceFlow).toEqual([{ name: 'atlas', login: 'fleetadlc-atlas-janedoe' }]);
    expect(text.match(/\bnova\b/g)).toHaveLength(1);
    expect(text).toMatch(/does not have, skipped — for each one’s seat, add it[^\n]*Add a builder[^\n]*\n {2}nova$/m);
  });

  it('restores a non-expiring user token from an older archive, and does not ask that bot to connect', () => {
    const contents = oldArchive({
      secrets: {
        'github-token-atlas': 'ghu_zzz-static-zzz',
        'github-refresh-atlas': VALUES.refresh,
      },
      settings: { organization: VALUES.org },
      bots: [{ name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: null }],
    });

    expect(contents.secrets).toEqual({ 'github-token-atlas': 'ghu_zzz-static-zzz' });
    const plan = planRestore(contents, { secretRefs: [], settingKeys: [], bots: [] });
    expect(plan.secrets.create).toEqual(['github-token-atlas']);
    expect(plan.bots.deviceFlow).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(VALUES.refresh);
  });
});

describe('choosing part of the install from the command line', () => {
  it('takes everything, with the sign-ins, when nothing narrows it', () => {
    expect(selectionFromFlags({})).toEqual(EVERYTHING);
    expect(selectionFromFlags({ history: true })).toEqual({ ...EVERYTHING, history: true });
  });

  it('leaves the sign-ins out of part of the install, unless asked to take them', () => {
    const some = selectionFromFlags({ bots: 'builder,qa' });
    expect(some).toMatchObject({ bots: ['builder', 'qa'], botSignIns: false, accountSignIns: false });
    expect(selectionFromFlags({ bots: 'builder', signIns: true })).toMatchObject({ botSignIns: true });
    expect(selectionFromFlags({ signIns: false })).toMatchObject({ bots: 'all', botSignIns: false });
    expect(selectionFromFlags({ without: 'crew,accounts' })).toMatchObject({ bots: [], accounts: [], install: true });
  });

  it('says what it could not read', () => {
    expect(selectionFromFlags({ without: 'everything' })).toEqual({
      error: '--without takes install, repositories, crew or accounts, not everything',
    });
    expect(selectionFromFlags({ bots: '' })).toHaveProperty('error');
  });

  it('checks the seats and accounts it names against the install, and takes an account by its label', () => {
    const found = {
      bots: [{ name: 'builder', slot: 'builder', githubLogin: null, engine: 'claude', model: 'x', modelAccountId: null, modelSetAt: null }],
      accounts: [
        { id: 'a1', provider: 'anthropic' as const, kind: 'key' as const, label: 'Anthropic API', createdAt: '', verifiedAt: null, verifyError: null },
      ],
    };

    expect(resolveSelection({ ...EVERYTHING, bots: ['nobody'] }, found)).toEqual({ error: 'this install has no seat nobody' });
    expect(resolveSelection({ ...EVERYTHING, accounts: ['Anthropic API'] }, found)).toMatchObject({ accounts: ['a1'] });
  });

  it('writes only the chosen bot’s secrets', async () => {
    const io = fakeIo(['a passphrase', 'a passphrase']);
    const contents: InstallContents = {
      secrets: { 'ssh-signing-builder': 'zzz-builder-zzz', 'ssh-signing-qa': 'zzz-qa-zzz', 'github-app-private-key': VALUES.appKey },
      settings: {},
      bots: [
        { name: 'builder', slot: 'builder', githubLogin: null, engine: 'claude', model: 'x' },
        { name: 'qa', slot: 'qa', githubLogin: null, engine: 'claude', model: 'x' },
      ],
    };
    const { deps, packed } = backupDeps(io.io, fakeInstall({ contents }).access);

    await backup(scratch(), { out: join(scratch(), 'out.fleetbak'), selection: selectionFromFlags({ without: 'install', bots: 'builder' }) as BackupSelection }, deps);

    expect(Object.keys(packed[0]?.secrets ?? {})).toEqual(['ssh-signing-builder']);
    expect(io.text()).toContain('Left out, because qa was not chosen: ssh-signing-qa.');
  });
});

describe('a restore that changes which account a bot is', () => {
  /**
   * Rewriting the login does not change whose token the bot holds. The broker
   * reads `github-refresh-<bot>` first, so a token left behind for the old
   * account would go on acting as that account — under the new one's name.
   * Before refresh tokens were left out, the archived one overwrote it; now
   * nothing does unless the restore deletes it.
   */
  const archived = buildContents(
    {
      secrets: { 'ssh-signing-atlas': 'zzz-signing-key-zzz' },
      settings: {},
      bots: [{ name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'opus-4' }],
    },
    MADE_AT,
  );
  const connectedElsewhere: InstallShape = {
    secretRefs: ['github-refresh-atlas', 'ssh-signing-atlas'],
    settingKeys: [],
    bots: [{ name: 'atlas', slot: 'builder', githubLogin: 'someone-else' }],
  };

  it('deletes the old account\'s refresh token when it puts the new login on the bot', async () => {
    const install = fakeInstall({ shape: connectedElsewhere });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archived),
    });

    expect(install.wrote.deleted).toEqual(['github-refresh-atlas']);
    expect(install.wrote.bots).toEqual(['atlas=fleetadlc-atlas-janedoe']);
    expect(install.wrote.secrets).toEqual(['ssh-signing-atlas']);
    // Nor is the old account's record of its sign-in kept, which would count the bot as connected.
    expect(install.order).toContain('forget credential atlas');
    expect(io.text()).toContain('GitHub credentials of an account this replaces, which this would delete (1):');
    expect(io.text()).toContain('deleted secret github-refresh-atlas');
    expect(io.text()).toContain('atlas: someone-else becomes fleetadlc-atlas-janedoe');
    // Nothing of the new account's is left to act with, so it has to connect.
    expect(io.text()).toContain('bots that will need to connect to GitHub again (1):');
    expect(io.text()).toContain('atlas as fleetadlc-atlas-janedoe');
  });

  it('never leaves the new login over the old account\'s token: one that cannot be deleted undoes the login', async () => {
    // The login and the deletion are one restore. If the old account's token
    // cannot be deleted, the bot must not come out named as the new account
    // while still holding the old one's credential.
    const install = fakeInstall({ shape: connectedElsewhere, failSecret: 'github-refresh-atlas' });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archived),
    });

    expect(io.text()).toContain('restore failed');
    expect(install.wrote.bots).toEqual([]);
    expect(install.store.get('github-refresh-atlas')).toBe('current-github-refresh-atlas');
    expect(install.store.get('ssh-signing-atlas')).toBe('current-ssh-signing-atlas');
    expect(process.exitCode).toBe(1);
  });

  it('counts the deletion as a change, and names it in a dry run without deleting it', async () => {
    const plan = planRestore(archiveOf({ secrets: {}, settings: {} }), {
      secretRefs: ['github-refresh-atlas'],
      settingKeys: [],
      bots: [{ name: 'atlas', slot: 'builder', githubLogin: 'someone-else' }],
    });
    // The login and the token: two changes, not one.
    expect(changeCount(plan)).toBe(2);

    const install = fakeInstall({ shape: connectedElsewhere });
    const io = fakeIo(['a passphrase']);
    await restore('/tmp/x.fleetbak', { dryRun: true }, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archived),
    });

    expect(install.wrote.deleted).toEqual([]);
    expect(io.text()).toContain('which this would delete (1):');
    expect(io.text()).toContain('github-refresh-atlas');
  });

  it('deletes a non-expiring token for the old account as well', () => {
    const current: InstallShape = {
      secretRefs: ['github-token-atlas'],
      settingKeys: [],
      bots: [{ name: 'atlas', slot: 'builder', githubLogin: 'someone-else' }],
    };

    expect(credentialsForReplacedAccounts(archived, current)).toEqual(['github-token-atlas']);
    expect(planRestore(archived, current).bots.deviceFlow).toEqual([
      { name: 'atlas', login: 'fleetadlc-atlas-janedoe' },
    ]);
  });

  it('keeps the non-expiring token the archive restores, and lets it act instead of asking again', () => {
    // The archive's own `github-token-atlas` is for the new account. Only once
    // the old refresh token is gone does the broker reach it.
    const withToken = buildContents(
      {
        secrets: { 'github-token-atlas': 'ghu_zzz-static-zzz' },
        settings: {},
        bots: [{ name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: null }],
      },
      MADE_AT,
    );
    const plan = planRestore(withToken, {
      secretRefs: ['github-refresh-atlas', 'github-token-atlas'],
      settingKeys: [],
      bots: [{ name: 'atlas', slot: 'builder', githubLogin: 'someone-else' }],
    });

    expect(plan.secrets.remove).toEqual(['github-refresh-atlas']);
    expect(plan.secrets.overwrite).toEqual(['github-token-atlas']);
    expect(plan.bots.deviceFlow).toEqual([]);
  });

  it('leaves the token alone when only the casing of the login differs', () => {
    // GitHub answers with the canonical casing, and onboarding compares logins
    // without case. One account spelled two ways keeps its token.
    const current: InstallShape = {
      secretRefs: ['github-refresh-atlas'],
      settingKeys: [],
      bots: [{ name: 'atlas', slot: 'builder', githubLogin: 'FleetADLC-Atlas-Janedoe' }],
    };

    expect(credentialsForReplacedAccounts(archived, current)).toEqual([]);
    expect(planRestore(archived, current).bots.deviceFlow).toEqual([]);
  });
});

describe('a dry run', () => {
  it('writes nothing', async () => {
    const install = fakeInstall({
      shape: { secretRefs: ['github-app-private-key'], bots: [{ name: 'atlas', slot: 'builder', githubLogin: null }] },
    });
    const io = fakeIo(['a passphrase']);

    await restore('/tmp/does-not-matter.fleetbak', { dryRun: true }, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf()),
    });

    expect(install.wrote).toEqual({ secrets: [], settings: [], bots: [], deleted: [] });
    expect(io.text()).toContain('dry run: nothing was written');
    // Still says what it would have done, by name — including who has to sign
    // in again, because this install has no refresh token to leave in place.
    expect(io.text()).toContain('bots that will need to connect to GitHub again');
    expect(io.text()).toContain('atlas as fleetadlc-atlas-janedoe');
    expect(io.text()).not.toContain(VALUES.refresh);
  });

  it('shows the manifest before it asks for a passphrase', async () => {
    // Reading the manifest needs no passphrase, so whether this is the right
    // archive is settled before anybody types one at the wrong one.
    const io = fakeIo(['a passphrase']);

    await restore('/tmp/x.fleetbak', { dryRun: true }, {
      install: fakeInstall().access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf()),
    });

    const shown = io.said.findIndex((line) => line.includes(MADE_AT.toISOString()));
    const asked = io.said.findIndex((line) => line.startsWith('ask-secret'));
    expect(shown).toBeGreaterThan(-1);
    expect(shown).toBeLessThan(asked);
  });
});

describe('a restore that writes', () => {
  const shape: Partial<InstallShape> = {
    secretRefs: ['github-app-private-key'],
    settingKeys: ['organization'],
    bots: [{ name: 'atlas', slot: 'builder', githubLogin: null }],
  };

  it('writes nothing unless the confirmation word is typed', async () => {
    // A y/N prompt is answered by muscle memory. This overwrites the App key,
    // so a stray `y` must not be enough.
    const install = fakeInstall({ shape });
    const io = fakeIo(['a passphrase', 'y']);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf()),
    });

    expect(install.wrote).toEqual({ secrets: [], settings: [], bots: [], deleted: [] });
    expect(io.text()).toContain('nothing was written');
  });

  it('is not satisfied by a word that merely contains the confirmation', () => {
    expect(confirmed(CONFIRM_WORD)).toBe(true);
    expect(confirmed(` ${CONFIRM_WORD.toUpperCase()} `)).toBe(true);
    expect(confirmed(`${CONFIRM_WORD} everything`)).toBe(false);
    expect(confirmed('y')).toBe(false);
  });

  it('writes every secret, setting and bot login the plan named', async () => {
    const install = fakeInstall({ shape });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf()),
    });

    // The archive's webhook secret is a setting, as before it moved; it is
    // written to the secret store, where the bridge reads it.
    expect(install.wrote.secrets).toEqual(['github-app-private-key', 'github-webhook-secret']);
    expect(install.wrote.settings).toEqual(['organization']);
    // The login is what maps a bot to its GitHub account, and the one thing here
    // no device flow can hand back without a person.
    expect(install.wrote.bots).toEqual(['atlas=fleetadlc-atlas-janedoe']);
    expect(io.text()).toContain('atlas as fleetadlc-atlas-janedoe');
    expect(io.text()).not.toContain('secret github-refresh-atlas');
    expect(io.text()).not.toContain(VALUES.refresh);
  });

  it('leaves a bot alone when the archive has no account for it', async () => {
    const install = fakeInstall({ shape: { bots: [{ name: 'flow', slot: 'automation', githubLogin: 'fleetadlc-flow' }] } });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf()),
    });

    // `flow` is in the archive with a null login: there is nothing to put back,
    // and overwriting a connected account with nothing would cost a device flow.
    expect(install.wrote.bots).toEqual([]);
  });
});

describe('what these commands may print', () => {
  it('never prints a secret value, in any mode', async () => {
    const contents = archiveOf();
    const values = Object.values(contents.secrets).concat(Object.values(contents.settings));

    const backupIo = fakeIo(['a passphrase', 'a passphrase']);
    const { deps } = backupDeps(
      backupIo.io,
      fakeInstall({ contents: { secrets: contents.secrets, settings: contents.settings, bots: contents.bots } }).access,
    );
    await backup(scratch(), { out: join(scratch(), 'out.fleetbak') }, deps);

    const dryIo = fakeIo(['a passphrase']);
    await restore('/tmp/x.fleetbak', { dryRun: true }, {
      install: fakeInstall().access,
      io: dryIo.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(contents),
    });

    const writeIo = fakeIo(['a passphrase', CONFIRM_WORD]);
    await restore('/tmp/x.fleetbak', {}, {
      install: fakeInstall().access,
      io: writeIo.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(contents),
    });

    const everything = [
      backupIo.text(),
      dryIo.text(),
      writeIo.text(),
      describeContents(contents).join('\n'),
      describePlan(planRestore(contents, { secretRefs: [], settingKeys: [], bots: [] })).join('\n'),
    ].join('\n');

    expect(values).not.toHaveLength(0);
    for (const value of values) expect(everything).not.toContain(value);
    // It is still the archive it says it is: the names are all there.
    expect(everything).toContain('github-app-private-key');
    expect(everything).toContain('webhookSecret');
  });

  it('prints no control character an archive carries, before or after the passphrase', async () => {
    // A name in an archive is anybody's, and a terminal reads an escape
    // sequence in it as a command: retitle the window, write the clipboard.
    const contents = archiveOf();
    const hostile = {
      ...contents,
      bots: contents.bots.map((bot) => ({ ...bot, name: `${bot.name}\u001b]52;c;cHduZWQ=\u0007\nFORGED` })),
    };
    const io = fakeIo(['a passphrase']);
    await restore('/tmp/x.fleetbak', { dryRun: true }, {
      install: fakeInstall().access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(hostile),
    });

    expect(io.text()).toContain(']52;c;cHduZWQ= FORGED');
    expect(io.text()).not.toMatch(/[\u001b\u0007\u009b]/);
    expect(printable('a\u001b[2Jb\u009b\u007fc\nd')).toBe('a[2Jbc d');
  });

  it('reports a failure without repeating the message it came with', async () => {
    // A store or codec error raised with a credential in hand can carry it in
    // the message, and this is the only command where every credential in the
    // install is in memory at once.
    const io = fakeIo(['a passphrase']);
    await restore('/tmp/x.fleetbak', {}, {
      install: fakeInstall().access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf(), () => {
        throw new Error(`could not decrypt ${VALUES.appKey}`);
      }),
    });

    expect(io.text()).toContain('restore failed');
    expect(io.text()).not.toContain(VALUES.appKey);
    expect(process.exitCode).toBe(1);
  });

  it('still says what a missing or unreadable file was', () => {
    // The two failures worth naming, because they are the operator's own typo.
    expect(safeMessage(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('no such file');
    expect(safeMessage(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('permission denied');
    expect(safeMessage('a string')).toContain('without its message');
  });

  /**
   * A refusal that cannot explain itself.
   *
   * `safeMessage` repeats only `BackupError`, which is right — an error raised
   * with the App private key in hand must not print its own message. But the
   * refusals this command raises deliberately were plain `Error`s, so piping a
   * passphrase in printed "unexpected Error, reported without its message":
   * correct behaviour, no file written, and nothing an operator could act on.
   */
  it('explains a deliberate refusal rather than suppressing it', () => {
    const refusal = new BackupError('a passphrase has to be typed at a terminal, not piped in');

    expect(safeMessage(refusal)).toContain('terminal');
  });

  it('still refuses to repeat an error it did not raise on purpose', () => {
    // The property that makes the above safe to trust: anything else is reported
    // by kind, whatever it was carrying.
    const leaky = new Error(`failed while holding ${VALUES.appKey}`);

    expect(safeMessage(leaky)).not.toContain(VALUES.appKey);
    expect(safeMessage(leaky)).toContain('without its message');
  });
});

const SOMETHING_TO_SAVE = {
  secrets: { 'github-app-private-key': 'x' },
  settings: {},
  bots: [],
};

describe('--unencrypted', () => {
  /**
   * The risky path is the one you have to ask for. An install whose access is
   * controlled elsewhere may decide the passphrase costs more than it buys —
   * it cannot be scripted, and a forgotten one loses the archive — but the file
   * is still every credential the install has, so choosing it is deliberate and
   * loud.
   */
  it('writes without asking for a passphrase at all', async () => {
    const io = fakeIo([]); // No answers queued: a prompt would read ''.
    const { deps, written, form } = backupDeps(io.io, fakeInstall({ contents: SOMETHING_TO_SAVE }).access);

    await backup(scratch(), { out: join(scratch(), 'plain.json'), unencrypted: true }, deps);

    expect(form).toEqual(['plain']);
    expect(written).toHaveLength(1);
    expect(io.text()).not.toMatch(/Passphrase/i);
  });

  it('says what it is doing, in the output, every time', async () => {
    const io = fakeIo([]);
    const { deps } = backupDeps(io.io, fakeInstall({ contents: SOMETHING_TO_SAVE }).access);

    await backup(scratch(), { out: join(scratch(), 'plain.json'), unencrypted: true }, deps);

    expect(io.text()).toMatch(/UNENCRYPTED/);
    expect(io.text()).toContain('any non-expiring bot tokens and API keys');
    // What a leak actually costs. The file has no refresh token, so the
    // device flow is not the remedy; revoking and rotating what it holds is.
    expect(io.text()).toContain('revoking any non-expiring bot token, rotating every API key');
    expect(io.text()).toContain('a new key for signing posts (fleetadlc attribution rotate --drop-old)');
    expect(io.text()).not.toMatch(/device flow/);
  });

  it('names the registry token and the subscriptions, and how to recover them after a leak', async () => {
    const io = fakeIo([]);
    const { deps } = backupDeps(io.io, fakeInstall({ contents: SOMETHING_TO_SAVE }).access);

    await backup(scratch(), { out: join(scratch(), 'plain.json'), unencrypted: true }, deps);

    expect(io.text()).toContain('any package registry token');
    expect(io.text()).toContain('any Claude subscription tokens');
    expect(io.text()).toContain('rotating every API key and the registry token');
    expect(io.text()).toContain('signing each model subscription out and in again');
  });

  it('names the sign-ins and the history only when they were included', async () => {
    // An install with a subscription on it, so its sign-in can be chosen.
    const withAccount = (): InstallAccess => {
      const access = fakeInstall({ contents: SOMETHING_TO_SAVE }).access;
      const snapshot = access.snapshot.bind(access);
      return {
        ...access,
        snapshot: async (selection) => ({
          ...(await snapshot(selection)),
          accounts: [{ id: 'c1', provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: null, verifyError: null }],
        }),
      };
    };
    const withAll = fakeIo([]);
    const all = backupDeps(withAll.io, withAccount());
    await backup(scratch(), { out: join(scratch(), 'plain.json'), unencrypted: true, selection: { ...EVERYTHING, history: true } }, all.deps);
    expect(withAll.text()).toContain('the OpenAI and xAI subscription sign-ins');
    expect(withAll.text()).toContain('the history: messages, requests and attachments');

    const without = fakeIo([]);
    const none = backupDeps(without.io, withAccount());
    await backup(scratch(), { out: join(scratch(), 'plain.json'), unencrypted: true, selection: { ...NO_SIGN_INS, history: false } }, none.deps);
    expect(without.text()).not.toContain('subscription sign-ins');
    expect(without.text()).not.toContain('the history:');
  });

  it('is not what happens by default', async () => {
    const io = fakeIo(['a passphrase', 'a passphrase']);
    const { deps, form } = backupDeps(io.io, fakeInstall({ contents: SOMETHING_TO_SAVE }).access);

    await backup(scratch(), { out: join(scratch(), 'sealed.fleetbak') }, deps);

    expect(form).toEqual(['sealed']);
  });

  it('still refuses a path inside the repository', async () => {
    // The riskier the file, the more this matters: an unencrypted archive one
    // `git add -A` from being published is the worst case in this whole module.
    const root = scratch();
    const io = fakeIo([]);
    const { deps, written } = backupDeps(io.io, fakeInstall({ contents: SOMETHING_TO_SAVE }).access);

    await backup(root, { out: join(root, 'oops.json'), unencrypted: true }, deps);

    expect(written).toEqual([]);
    expect(io.text()).toMatch(/inside the repository/);
  });

  it('names the two forms differently when nobody says where', () => {
    // A directory listing has to tell them apart; `.fleetbak` has always meant
    // sealed and must keep meaning it.
    const sealed = defaultBackupPath(MADE_AT, '/home/someone');
    const plain = defaultBackupPath(MADE_AT, '/home/someone', true);

    expect(sealed).toMatch(/\.fleetbak$/);
    expect(plain).toMatch(/\.plain\.json$/);
    expect(sealed).not.toBe(plain);
  });
});

describe('restoring an unencrypted archive', () => {
  it('does not ask for a passphrase it has no use for', async () => {
    const io = fakeIo([]);

    await restore('/tmp/plain.json', { dryRun: true }, {
      install: fakeInstall().access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf(), undefined, false),
    });

    expect(io.text()).not.toMatch(/Passphrase/i);
  });

  it('says the file was never protected, because that is worth knowing', async () => {
    const io = fakeIo([]);

    await restore('/tmp/plain.json', { dryRun: true }, {
      install: fakeInstall().access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(archiveOf(), undefined, false),
    });

    expect(io.text()).toMatch(/UNENCRYPTED/);
  });
});

describe('restoring into an install that was never migrated', () => {
  /**
   * The fresh-machine case, which is the one this whole feature exists for:
   * new checkout, new database, archive in hand. The settings read fails with
   * `relation "settings" does not exist`, `safeMessage` repeats only
   * `BackupError`, and the recovery path ended at "unexpected error, reported
   * without its message" — with the remedy being one command.
   */
  it('becomes a refusal that names the remedy', () => {
    let thrown: unknown;
    try {
      asMissingSchema(new Error('relation "settings" does not exist'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BackupError);
    expect(safeMessage(thrown)).toMatch(/no database schema/);
    expect(safeMessage(thrown)).toMatch(/fleetadlc up/);
  });

  it('stays narrow, so anything else is still reported by kind alone', () => {
    // The guard must not become a general "explain the error" path: an error
    // raised while the App key is in hand still has to be suppressed.
    const leaky = new Error(`connection failed while holding ${VALUES.appKey}`);
    let thrown: unknown;
    try {
      asMissingSchema(leaky);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(leaky);
    expect(safeMessage(thrown)).not.toContain(VALUES.appKey);
    expect(safeMessage(thrown)).toMatch(/without its message/);
  });
});

describe('restoring onto an install whose bots are named differently', () => {
  // This install's builder has no account yet, so it is named after its seat.
  const freshInstall: InstallShape = {
    secretRefs: [],
    settingKeys: [],
    bots: [
      { name: 'builder', slot: 'builder', githubLogin: null },
      { name: 'automation', slot: 'automation', githubLogin: null },
    ],
  };

  it('finds the row for an archive from before seats by the seat its persona was', () => {
    // The archive says `atlas`; nothing here is called that any more.
    const plan = planRestore(
      archiveOf({
        secrets: { 'ssh-signing-atlas': 'zzz-signing-key-zzz' },
        bots: [{ name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'opus-4' }],
      }),
      freshInstall,
    );

    expect(plan.bots.connect).toEqual([{ name: 'builder', login: 'fleetadlc-atlas-janedoe' }]);
    expect(plan.bots.absent).toEqual([]);
    // The bot's own secret goes where this install will look for it.
    expect(plan.secrets.create).toEqual(['ssh-signing-builder']);
    expect(plan.secrets.from).toEqual({ 'ssh-signing-builder': 'ssh-signing-atlas' });
    expect(plan.bots.deviceFlow).toEqual([{ name: 'builder', login: 'fleetadlc-atlas-janedoe' }]);
  });

  it('finds the row for an archive with seats by the seat it recorded, whatever the bot was called there', () => {
    const archived = buildContents(
      {
        secrets: { 'github-token-fleetadlc-atlas-janedoe': 'zzz-static-token-zzz' },
        settings: {},
        bots: [
          {
            name: 'fleetadlc-atlas-janedoe',
            slot: 'builder',
            githubLogin: 'fleetadlc-atlas-janedoe',
            engine: 'claude',
            model: 'opus-4',
          },
        ],
      },
      MADE_AT,
    );

    const plan = planRestore(archived, freshInstall);

    expect(plan.bots.connect).toEqual([{ name: 'builder', login: 'fleetadlc-atlas-janedoe' }]);
    expect(plan.secrets.create).toEqual(['github-token-builder']);
    // A non-expiring token comes back with it, so there is nothing to sign in
    // again for; the bridge names the bot after its account when it starts.
    expect(plan.bots.deviceFlow).toEqual([]);
  });

  it('writes a moved secret with the archive’s value, under this install’s name for the bot', async () => {
    const install = fakeInstall({ shape: freshInstall });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders().providers,
      archive: () =>
        fakeArchive(
          archiveOf({
            secrets: { 'ssh-signing-atlas': 'zzz-signing-key-zzz' },
            settings: {},
            bots: [{ name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'opus-4' }],
          }),
        ),
    });

    expect(install.values).toEqual({ 'ssh-signing-builder': 'zzz-signing-key-zzz' });
    expect(install.wrote.bots).toEqual(['builder=fleetadlc-atlas-janedoe']);
    expect(io.text()).toContain('secret ssh-signing-builder (ssh-signing-atlas in the archive)');
    expect(io.text()).not.toContain('zzz-signing-key-zzz');
  });

  it('records each bot’s seat in a new archive, and names it by seat', () => {
    const contents = buildContents(
      {
        secrets: {},
        settings: {},
        bots: [
          { name: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: null },
          { name: 'qa', slot: 'qa', githubLogin: null, engine: 'claude', model: null },
        ],
      },
      MADE_AT,
    );

    expect(contents.bots.map((bot) => bot.slot)).toEqual(['builder', 'qa']);
    const said = describeContents(contents).join('\n');
    expect(said).toContain('builder (fleetadlc-atlas-janedoe) as fleetadlc-atlas-janedoe');
    expect(said).toContain('qa (no account connected)');
  });
});

describe('the sign-ins a restore finds in an archive', () => {
  const KEY_ACCOUNT = '11111111-1111-4111-8111-111111111111';
  const TOKEN_ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const REFUSED_KEY = 'sk-ant-api-zzz-refused-zzz';
  const WORKING_TOKEN = 'sk-ant-oat-zzz-working-zzz';

  /** A whole install: one bot with its refresh token, a key the provider refuses, a token it takes. */
  function archived(): BackupContents {
    return buildBackup(
      {
        secrets: {
          'github-app-private-key': VALUES.appKey,
          'github-refresh-fleetadlc-atlas-janedoe': VALUES.refresh,
          [`model-account-${KEY_ACCOUNT}`]: REFUSED_KEY,
          [`model-account-${TOKEN_ACCOUNT}`]: WORKING_TOKEN,
        },
        settings: { organization: VALUES.org, githubClientId: 'Iv1.zzz-client-zzz' },
        bots: [
          {
            name: 'fleetadlc-atlas-janedoe',
            slot: 'builder',
            githubLogin: 'fleetadlc-atlas-janedoe',
            engine: 'claude',
            model: 'opus-4',
            modelAccountId: null,
            modelSetAt: null,
          },
        ],
        credentials: {},
        repositories: [],
        accounts: [
          { id: KEY_ACCOUNT, provider: 'anthropic', kind: 'key', label: 'Anthropic API', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: null, verifyError: null },
          { id: TOKEN_ACCOUNT, provider: 'anthropic', kind: 'subscription', label: 'Claude Max', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: null, verifyError: null },
        ],
        logins: {},
        history: null,
      },
      EVERYTHING,
      MADE_AT,
    ).contents;
  }

  const clean: Partial<InstallShape> = { secretRefs: [], settingKeys: [], bots: [{ name: 'builder', slot: 'builder', githubLogin: null }] };

  it('are each shown with their verdict before anything is asked, and never by value', async () => {
    const io = fakeIo(['a passphrase']);
    const { providers, refreshed } = fakeProviders({ refuse: [REFUSED_KEY] });

    await restore('/tmp/x.fleetbak', { dryRun: true }, {
      install: fakeInstall({ shape: clean }).access,
      io: io.io,
      providers,
      archive: () => fakeArchive(archived()),
    });

    const text = io.text();
    expect(text).toContain('Sign-ins in this archive (3)');
    expect(text).toContain('builder as fleetadlc-atlas-janedoe: can only be checked by using it — this restore checks it and takes it over');
    expect(text).toContain('Anthropic API (API key): cannot be restored: Anthropic did not accept it: invalid x-api-key — not restored');
    expect(text).toContain('Claude Max (subscription token): works (Anthropic lists 1 model for it) — restored');
    // A dry run uses nothing: judging a rotating sign-in never does.
    expect(refreshed).toEqual([]);
    expect(text).toContain('dry run: nothing was written, and no sign-in was used');
    for (const value of [REFUSED_KEY, WORKING_TOKEN, VALUES.refresh, VALUES.appKey]) expect(text).not.toContain(value);
  });

  it('names a bot’s own engine key by the bot, and never writes one its provider refuses', async () => {
    const contents = archived();
    contents.secrets['engine-key-fleetadlc-atlas-janedoe'] = 'sk-ant-api-zzz-engine-zzz';
    const install = fakeInstall({ shape: clean });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders({ refuse: [REFUSED_KEY, 'sk-ant-api-zzz-engine-zzz'] }).providers,
      archive: () => fakeArchive(contents),
    });

    expect(io.text()).toContain('builder (engine key): cannot be restored: Anthropic did not accept it: invalid x-api-key — not restored');
    expect(Object.values(install.values)).not.toContain('sk-ant-api-zzz-engine-zzz');
  });

  it('never writes one that is expired or refused, whatever is typed', async () => {
    const install = fakeInstall({ shape: clean });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders({ refuse: [REFUSED_KEY] }).providers,
      archive: () => fakeArchive(archived()),
    });

    expect(Object.values(install.values)).not.toContain(REFUSED_KEY);
    expect(install.values[`model-account-${TOKEN_ACCOUNT}`]).toBe(WORKING_TOKEN);
    expect(io.text()).toContain('Give Anthropic API a key that works on the “Foundation model accounts / API keys” step: Anthropic did not accept it: invalid x-api-key.');
  });

  it('stores nothing for a GitHub sign-in GitHub refuses when it is used, and names the bot to connect again', async () => {
    const install = fakeInstall({ shape: clean });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: install.access,
      io: io.io,
      providers: fakeProviders({ spent: [VALUES.refresh] }).providers,
      archive: () => fakeArchive(archived()),
    });

    expect(install.values).not.toHaveProperty('github-refresh-builder');
    expect(io.text()).toContain(
      'warn builder as fleetadlc-atlas-janedoe was not restored — nothing was stored for it: GitHub did not accept it: The refresh token passed is incorrect or expired',
    );
    expect(io.text()).toContain('Connect fleetadlc-atlas-janedoe to GitHub again: GitHub did not accept it: The refresh token passed is incorrect or expired.');
    // The rest of the restore stood.
    expect(install.values['github-app-private-key']).toBe(VALUES.appKey);
  });

  it('leaves a rotating sign-in alone on an install that is set up, unless asked to take it over', async () => {
    const setUp: Partial<InstallShape> = {
      secretRefs: ['github-refresh-builder', 'github-app-private-key'],
      settingKeys: [],
      bots: [{ name: 'builder', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' }],
    };
    const left = fakeProviders();
    const leftIo = fakeIo(['a passphrase', CONFIRM_WORD]);
    const leftInstall = fakeInstall({ shape: setUp });
    await restore('/tmp/x.fleetbak', {}, { install: leftInstall.access, io: leftIo.io, providers: left.providers, archive: () => fakeArchive(archived()) });

    expect(left.refreshed).toEqual([]);
    expect(leftInstall.store.get('github-refresh-builder')).toBe('current-github-refresh-builder');
    expect(leftIo.text()).toContain('left as this install has it; pass --take-over-sign-ins to take it');

    const taken = fakeProviders();
    const takenInstall = fakeInstall({ shape: setUp });
    await restore(
      '/tmp/x.fleetbak',
      { takeOverSignIns: true },
      { install: takenInstall.access, io: fakeIo(['a passphrase', CONFIRM_WORD]).io, providers: taken.providers, archive: () => fakeArchive(archived()) },
    );

    expect(taken.refreshed).toEqual([VALUES.refresh]);
    expect(takenInstall.store.get('github-refresh-builder')).toBe('ghr_zzz-fresh-1-zzz');
  });
});

describe('a restore with the database down', () => {
  it('says to start the stack before asking for the passphrase', async () => {
    // The passphrase was asked and typed, then the restore ended at "unexpected
    // Error, reported without its message".
    const install = fakeInstall();
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:47432'), { code: 'ECONNREFUSED' });
    const io = fakeIo(['a passphrase', CONFIRM_WORD]);

    await restore('/tmp/x.fleetbak', {}, {
      install: { ...install.access, shape: async () => Promise.reject(refused) },
      io: io.io,
      providers: fakeProviders().providers,
      archive: () => fakeArchive(oldArchive()),
    });

    expect(io.text()).toContain('cannot reach the database');
    expect(io.text()).toContain('start the stack with fleetadlc up');
    expect(io.text()).not.toContain('ask-secret');
    expect(process.exitCode).toBe(1);
  });
});
