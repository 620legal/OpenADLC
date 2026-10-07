import { describe, expect, it } from 'vitest';
import { applyRestore } from './apply.js';
import { BackupError, decryptBackup, encryptBackup, readManifest } from './archive.js';
import { buildBackup } from './contents.js';
import { planRestore } from './plan.js';
import { EVERYTHING, selectionFrom, signInsByDefault, type BackupSelection } from './selection.js';
import { CLAUDE_SEAT, CODEX_SEAT, KEY_ACCOUNT, VALUES, cleanShape, fakeTarget, sourceInstall } from './test-fixtures.js';

/**
 * What a choice takes from an install, and what the archive then says about
 * itself. Every group is its own; nothing the archive does not need goes in.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');

function take(selection: BackupSelection) {
  return buildBackup(sourceInstall(), selection, NOW);
}

describe('everything', () => {
  const { contents, leftOut } = take(EVERYTHING);

  it('takes the install and its App, every repository, bot and account, with their sign-ins', () => {
    expect(contents.secrets['github-app-private-key']).toBe(VALUES.appKey);
    expect(contents.secrets['registry-token']).toBe(VALUES.registry);
    expect(contents.settings).toMatchObject({ organization: 'janedoe', githubClientId: VALUES.clientId, webhookSecret: VALUES.hook });
    expect(contents.repositories?.map((repo) => repo.fullName)).toEqual(['janedoe/fleetadlc-testbed']);
    expect(contents.bots.map((bot) => bot.slot)).toEqual(['builder', 'lead-reviewer', 'automation']);
    expect(contents.secrets['github-refresh-fleetadlc-atlas-janedoe']).toBe(VALUES.builderRefresh);
    expect(contents.bots[0]?.credential?.signingKeyId).toBe(9001);
    expect(contents.accounts?.map((account) => account.id)).toEqual([KEY_ACCOUNT, CLAUDE_SEAT, CODEX_SEAT]);
    expect(contents.secrets[`model-account-${CLAUDE_SEAT}`]).toBe(VALUES.seatToken);
    expect(Object.keys(contents.logins ?? {})).toEqual([CODEX_SEAT]);
    expect(contents.history).toBeNull();
  });

  it('carries each bot’s model assignment: the model, the engine and the account', () => {
    expect(contents.bots[0]).toMatchObject({ engine: 'claude', model: 'newest:opus', modelAccountId: CLAUDE_SEAT });
    expect(contents.bots[0]?.modelSetAt).toBe('2026-09-01T12:00:00.000Z');
  });

  it('never takes the internal API secret, nor a ref it does not recognise, and says so', () => {
    expect(contents.secrets).not.toHaveProperty('internal-api-secret');
    expect(contents.secrets).not.toHaveProperty('something-newer');
    expect(leftOut.map((entry) => entry.ref)).toEqual(['internal-api-secret', 'something-newer']);
    expect(leftOut[0]?.reason).toMatch(/each install makes its own/);
  });

  it('carries the webhook secret as the install’s secret store entry, and not a second time as a setting', () => {
    const found = sourceInstall();
    // As the bridge keeps it now; the setting is the environment's fallback.
    found.secrets['github-webhook-secret'] = VALUES.hook;
    const whole = buildBackup(found, EVERYTHING, NOW);
    expect(whole.contents.secrets['github-webhook-secret']).toBe(VALUES.hook);
    expect(whole.contents.settings).not.toHaveProperty('webhookSecret');
    expect(whole.leftOut.map((entry) => entry.ref)).not.toContain('github-webhook-secret');

    const crewOnly = buildBackup(found, { ...EVERYTHING, install: false }, NOW);
    expect(crewOnly.contents.secrets).not.toHaveProperty('github-webhook-secret');
    expect(crewOnly.leftOut.find((entry) => entry.ref === 'github-webhook-secret')?.reason).toBe('the install was not chosen');
  });

  it('carries the caps Settings saved, and a backup without the install does not', async () => {
    const found = sourceInstall();
    found.spendingLimits = [{ scope: 'global', kind: 'month_total', amountUsd: 80 }];
    const whole = buildBackup(found, EVERYTHING, NOW).contents;
    expect(whole.spendingLimits).toEqual([{ scope: 'global', kind: 'month_total', amountUsd: 80 }]);
    const crewOnly = buildBackup(found, { ...EVERYTHING, install: false }, NOW).contents;
    expect(crewOnly.spendingLimits).toBeUndefined();

    const back = await decryptBackup(await encryptBackup(whole, 'a passphrase'), 'a passphrase');
    expect(back.spendingLimits).toEqual([{ scope: 'global', kind: 'month_total', amountUsd: 80 }]);

    // An archive from before caps were saved has no list, so a restore of it
    // must not wipe caps set since.
    const { spendingLimits: _dropped, ...older } = whole;
    const fromBefore = await decryptBackup(await encryptBackup(older, 'a passphrase'), 'a passphrase');
    expect(fromBefore.spendingLimits).toBeUndefined();
  });

  it('leaves out what an engine update remembered about this machine', () => {
    expect(contents.settings).toHaveProperty('engineUpdates');
    expect(contents.settings).not.toHaveProperty('engineUpdateLast');
  });

  it('keeps each tool’s schedule and pin, and leaves out when this machine last ran it and how', () => {
    const found = sourceInstall();
    found.settings.systemToolSchedules = JSON.stringify({
      claude: { mode: 'schedule', day: 'tuesday', time: '03:00', slot: '2026-09-22T00:00:00.000Z', pin: null },
      codex: { mode: 'manual', day: 'sunday', time: '18:00', slot: '2026-09-20T15:00:00.000Z', pin: '0.155.1' },
    });
    found.settings.systemToolLast = JSON.stringify({ claude: { state: 'updated', to: '2.1.290' } });

    const archived = buildBackup(found, EVERYTHING, NOW).contents.settings;

    expect(archived).not.toHaveProperty('systemToolLast');
    expect(JSON.parse(archived.systemToolSchedules ?? '{}')).toEqual({
      claude: { mode: 'schedule', day: 'tuesday', time: '03:00', slot: null, pin: null },
      codex: { mode: 'manual', day: 'sunday', time: '18:00', slot: null, pin: '0.155.1' },
    });
  });

  it('records the choice in the manifest as flags and counts — never a name', async () => {
    const archive = await encryptBackup(contents, 'a passphrase');
    const manifest = readManifest(archive);

    expect(manifest.version).toBe(3);
    expect(manifest.includes).toEqual({
      install: true,
      repositories: true,
      bots: 'all',
      botSignIns: true,
      accounts: 'all',
      accountSignIns: true,
      history: false,
    });
    expect(manifest.counts).toMatchObject({ bots: 3, repositories: 1, accounts: 3, logins: 1, threads: 0 });
    const cleartext = JSON.stringify(manifest);
    for (const name of ['janedoe', 'fleetadlc-atlas', 'builder', 'Claude Max', CODEX_SEAT]) expect(cleartext).not.toContain(name);
  });

  it('round-trips through the sealed form exactly', async () => {
    const back = await decryptBackup(await encryptBackup(contents, 'a passphrase'), 'a passphrase');
    expect(back.bots).toEqual(contents.bots);
    expect(back.repositories).toEqual(contents.repositories);
    expect(back.accounts).toEqual(contents.accounts);
    expect(back.logins).toEqual(contents.logins);
    expect(back.secrets).toEqual(contents.secrets);
  });
});

describe('part of the install', () => {
  it('takes one bot by seat, with its signing key and nothing of the others', async () => {
    const { contents, leftOut } = take({ ...EVERYTHING, install: false, repositories: false, bots: ['builder'], accounts: [], botSignIns: false });

    expect(contents.bots.map((bot) => bot.slot)).toEqual(['builder']);
    expect(Object.keys(contents.secrets)).toEqual(['ssh-signing-fleetadlc-atlas-janedoe']);
    expect(contents.settings).toEqual({});
    expect(contents.accounts).toEqual([]);
    expect(leftOut.find((entry) => entry.ref === 'ssh-signing-fleetadlc-sydney-janedoe')?.reason).toMatch(/was not chosen/);
    expect(readManifest(await encryptBackup(contents, 'p')).includes).toMatchObject({ bots: 'some', botSignIns: false, install: false });
  });

  it('takes a bot’s sign-in only with its tick, and the record of it with the token', () => {
    const without = take({ ...EVERYTHING, bots: ['builder'], botSignIns: false }).contents;
    const withIt = take({ ...EVERYTHING, bots: ['builder'], botSignIns: true }).contents;

    expect(without.secrets).not.toHaveProperty('github-refresh-fleetadlc-atlas-janedoe');
    expect(without.bots[0]).not.toHaveProperty('credential');
    expect(withIt.secrets['github-refresh-fleetadlc-atlas-janedoe']).toBe(VALUES.builderRefresh);
    expect(withIt.bots[0]?.credential?.githubUserId).toBe(101);
  });

  it('takes one model account by id, with its key, and a subscription’s folder only with its tick', () => {
    const key = take({ ...EVERYTHING, install: false, repositories: false, bots: [], accounts: [KEY_ACCOUNT] }).contents;
    expect(key.accounts?.map((account) => account.label)).toEqual(['Anthropic API']);
    expect(Object.keys(key.secrets)).toEqual([`model-account-${KEY_ACCOUNT}`]);

    const seat = take({ ...EVERYTHING, bots: [], accounts: [CODEX_SEAT], accountSignIns: false }).contents;
    expect(seat.logins).toEqual({});
    const signedIn = take({ ...EVERYTHING, bots: [], accounts: [CODEX_SEAT], accountSignIns: true }).contents;
    expect(Object.keys(signedIn.logins ?? {})).toEqual([CODEX_SEAT]);
  });

  it('carries no caps it did not read, so a restore does not delete this install’s', () => {
    // An empty list is the whole table to a restore: `replaceSpendingLimits`
    // deletes every cap first.
    expect(take(EVERYTHING).contents).not.toHaveProperty('spendingLimits');
    const caps = [{ scope: 'install', scopeKey: '', period: 'month', capUsd: 50 }] as never;
    expect(buildBackup({ ...sourceInstall(), spendingLimits: caps }, EVERYTHING, NOW).contents.spendingLimits).toEqual(caps);
    expect(buildBackup({ ...sourceInstall(), spendingLimits: [] }, EVERYTHING, NOW).contents.spendingLimits).toEqual([]);
  });

  it('takes the history only when it is asked for', async () => {
    expect(take(EVERYTHING).contents.history).toBeNull();
    const { contents } = take({ ...EVERYTHING, history: true });
    expect(contents.history?.threads).toHaveLength(2);
    expect(readManifest(await encryptBackup(contents, 'p')).counts).toMatchObject({ threads: 2, messages: 2, audit: 1, ledger: 1, requests: 1 });
  });
});

describe('a choice sent by the console', () => {
  const install = { seats: ['builder', 'lead-reviewer', 'automation'], accounts: [KEY_ACCOUNT, CLAUDE_SEAT, CODEX_SEAT] };

  it('takes the sign-ins by default for everything, and not for part of it', () => {
    expect(signInsByDefault(EVERYTHING)).toBe(true);
    const all = selectionFrom({ install: true, repositories: true, bots: 'all', accounts: 'all' }, install);
    expect(all.botSignIns).toBe(true);
    expect(all.accountSignIns).toBe(true);

    const some = selectionFrom({ install: true, repositories: true, bots: ['builder'], accounts: 'all' }, install);
    expect(some.botSignIns).toBe(false);
    expect(some.accountSignIns).toBe(false);

    const asked = selectionFrom({ bots: ['builder'], botSignIns: true }, install);
    expect(asked.botSignIns).toBe(true);
  });

  it('refuses a seat or an account the install does not have, and a choice of nothing', () => {
    expect(() => selectionFrom({ bots: ['nobody'] }, install)).toThrow(/no seat nobody/);
    expect(() => selectionFrom({ accounts: ['not-an-account'] }, install)).toThrow(BackupError);
    expect(() => selectionFrom({ install: false, bots: [], accounts: [] }, install)).toThrow(/choose something/);
    expect(() => selectionFrom({ install: 'yes' }, install)).toThrow(/true or false/);
  });
});

describe('putting the caps back', () => {
  it('replaces the table with the list the archive carried', async () => {
    const found = sourceInstall();
    found.spendingLimits = [
      { scope: 'global', kind: 'month_total', amountUsd: 80 },
      { scope: 'repo:repo-1', kind: 'month_bot:bot-1', amountUsd: 10 },
    ];
    const contents = buildBackup(found, EVERYTHING, NOW).contents;
    const { target, recorded } = fakeTarget();
    await applyRestore(contents, planRestore(contents, cleanShape()), target);
    expect(recorded.spendingLimits).toEqual(found.spendingLimits);
  });
});
