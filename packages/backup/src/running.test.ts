import { settings as settingKeys } from '@fleetadlc/db';
import { describe, expect, it } from 'vitest';
import type { BackupContents } from './archive.js';
import { chosenArchive, compareInstall, itemsOf, refusedComparisonChoice, taken, type Comparison } from './compare.js';
import { buildBackup, RUNTIME_SETTINGS } from './contents.js';
import { previewRestore, runRestore } from './restore.js';
import { EVERYTHING } from './selection.js';
import { defaultSignInChoices, judgeSignIns } from './signins.js';
import {
  CLAUDE_SEAT,
  CODEX_LOGIN,
  CODEX_SEAT,
  HISTORY,
  KEY_ACCOUNT,
  REFRESH_LOGINS,
  VALUES,
  fakeChecks,
  fakeTakeOver,
  memoryInstall,
  sourceInstall,
  type MemoryState,
} from './test-fixtures.js';
import { applyUndo, journalOf, planUndo, undoOpen } from './undo.js';

/**
 * Restoring into an install that is already set up, and undoing it: the
 * archive laid beside the install item by item, only what is chosen written,
 * every sign-in checked first — and Undo putting back exactly what the
 * restore touched from the backup taken before it.
 */

const NOW = new Date('2026-09-25T10:00:00.000Z');
const GROK_ACCOUNT = '44444444-4444-4444-8444-444444444444';
const OTHER_REFRESH = 'ghr_zzz-other-refresh-zzz';
const B_KEY = 'sk-ant-api-zzz-b-key-zzz';

function archive(): BackupContents {
  return buildBackup(sourceInstall(), { ...EVERYTHING, history: true }, NOW).contents;
}

/** Install B: set up, with some of what the archive has, some of it otherwise, and some the archive lacks. */
function installB(): Partial<MemoryState> {
  return {
    settings: {
      organization: 'janedoe',
      operatorEmail: 'ops@b.example.test',
      githubClientId: VALUES.clientId,
      webhookSecret: VALUES.hook,
      publicUrl: 'https://b.example.test',
    },
    secrets: {
      'internal-api-secret': 'zzz-b-internal-zzz',
      'github-app-private-key': 'zzz-b-app-key-zzz',
      'ssh-signing-fleetadlc-atlas-janedoe': VALUES.builderSigning,
      'github-refresh-fleetadlc-atlas-janedoe': VALUES.builderRefresh,
      'ssh-signing-fleetadlc-other': 'zzz-other-signing-zzz',
      'github-refresh-fleetadlc-other': OTHER_REFRESH,
      [`model-account-${KEY_ACCOUNT}`]: B_KEY,
      [`model-account-${GROK_ACCOUNT}`]: 'xai-zzz-grok-key-zzz',
    },
    bots: [
      {
        name: 'fleetadlc-atlas-janedoe',
        slot: 'builder',
        githubLogin: 'fleetadlc-atlas-janedoe',
        engine: 'claude',
        model: 'newest:sonnet',
        modelAccountId: KEY_ACCOUNT,
        modelSetAt: '2026-09-10T00:00:00.000Z',
        identity: 'fleetadlc-atlas-janedoe',
      },
      {
        name: 'fleetadlc-other',
        slot: 'lead-reviewer',
        githubLogin: 'fleetadlc-other',
        engine: 'claude',
        model: 'newest:opus',
        modelAccountId: KEY_ACCOUNT,
        modelSetAt: '2026-09-10T00:00:00.000Z',
        identity: 'fleetadlc-other',
      },
      { name: 'automation', slot: 'automation', githubLogin: null, engine: 'none', model: 'none', modelAccountId: null, modelSetAt: null },
    ],
    // Each seat on an account of its own, filed under its own name, as migration 0014 left every install.
    identities: [
      { login: 'fleetadlc-atlas-janedoe', githubUserId: 101, secretNs: 'fleetadlc-atlas-janedoe' },
      { login: 'fleetadlc-other', githubUserId: 555, secretNs: 'fleetadlc-other' },
    ],
    credentials: {
      'fleetadlc-atlas-janedoe': {
        githubLogin: 'fleetadlc-atlas-janedoe',
        githubUserId: 101,
        scopes: [],
        tokenExpiresAt: '2026-09-24T18:00:00.000Z',
        refreshExpiresAt: '2027-03-01T00:00:00.000Z',
        signingKeyId: 9001,
        authorizedAt: '2026-09-01T11:00:00.000Z',
        status: 'active',
      },
      'fleetadlc-other': {
        githubLogin: 'fleetadlc-other',
        githubUserId: 555,
        scopes: [],
        tokenExpiresAt: null,
        refreshExpiresAt: '2027-03-15T00:00:00.000Z',
        signingKeyId: 7,
        authorizedAt: '2026-09-15T09:00:00.000Z',
        status: 'active',
      },
    },
    repositories: [
      {
        name: 'fleetadlc-testbed',
        fullName: 'janedoe/fleetadlc-testbed',
        ownerSeat: 'builder',
        concurrency: 1,
        stageModes: { merged: 'autonomous' },
        specRequiredLabels: ['safety'],
        humanReviewPaths: ['infra/'],
        defaultBranch: 'main',
        color: 'blue',
      },
      {
        name: 'widgets',
        fullName: 'janedoe/widgets',
        ownerSeat: 'builder',
        concurrency: 1,
        stageModes: {},
        specRequiredLabels: [],
        humanReviewPaths: [],
        defaultBranch: 'main',
        color: 'amber',
      },
    ],
    accounts: [
      { id: KEY_ACCOUNT, provider: 'anthropic', kind: 'key', label: 'Anthropic key (B)', createdAt: '2026-09-02T00:00:00.000Z', verifiedAt: null, verifyError: null },
      { id: GROK_ACCOUNT, provider: 'xai', kind: 'key', label: 'Grok', createdAt: '2026-09-02T00:00:00.000Z', verifiedAt: null, verifyError: null },
    ],
  };
}

/** The archive beside install B, with the Claude subscription's token one Anthropic refuses. */
async function compared(install = memoryInstall(installB())) {
  const contents = archive();
  const signIns = await judgeSignIns({
    contents,
    shape: install.shape(),
    facts: install.facts,
    checks: fakeChecks({ refuse: [VALUES.seatToken] }).checks,
    now: NOW,
    clientId: { after: VALUES.clientId, archive: VALUES.clientId },
  });
  const comparison = compareInstall({ contents, here: install.view(), signIns, historyHere: null });
  return { contents, signIns, comparison, install };
}

function find(comparison: Comparison, key: string) {
  const found = itemsOf(comparison).find((one) => one.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
}

describe('an archive laid beside an install that is set up', () => {
  it('says of each thing whether it is new here, the same, different, or only here', async () => {
    const { comparison } = await compared();
    const state = (key: string) => find(comparison, key).state;

    expect(comparison.groups.map((group) => group.group)).toEqual(['install', 'repositories', 'crew', 'accounts', 'sign-ins', 'history']);
    expect(state('app')).toBe('different');
    expect(state('setting:organization')).toBe('same');
    expect(state('setting:operatorEmail')).toBe('different');
    expect(state('setting:engineUpdates')).toBe('new');
    expect(state('setting:publicUrl')).toBe('only-here');
    expect(state('repo:janedoe/fleetadlc-testbed')).toBe('different');
    expect(state('repo:janedoe/widgets')).toBe('only-here');
    expect(state('seat:builder:account')).toBe('same');
    expect(state('seat:builder:model')).toBe('different');
    expect(state('seat:lead-reviewer:account')).toBe('different');
    expect(state(`account:${KEY_ACCOUNT}`)).toBe('different');
    expect(state(`account:${CLAUDE_SEAT}`)).toBe('new');
    expect(state(`account:${GROK_ACCOUNT}`)).toBe('only-here');
    expect(state('history')).toBe('new');
  });

  it('compares each tool’s schedule without this machine’s slots, and never offers an older backup’s update state', async () => {
    const schedule = (slot: string) =>
      JSON.stringify({ claude: { mode: 'schedule', day: 'tuesday', time: '03:00', slot, pin: '2.1.282' } });
    const contents = archive();
    // An archive from before these were left out.
    contents.settings.systemToolSchedules = schedule('2026-09-22T00:00:00.000Z');
    contents.settings.systemToolLast = '{"claude":{"state":"failed"}}';
    const install = memoryInstall({
      ...installB(),
      settings: { ...installB().settings, systemToolSchedules: schedule('2026-09-29T00:00:00.000Z') },
    });
    const signIns = await judgeSignIns({
      contents,
      shape: install.shape(),
      facts: install.facts,
      checks: fakeChecks({ refuse: [VALUES.seatToken] }).checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const comparison = compareInstall({ contents, here: install.view(), signIns, historyHere: null });

    expect(find(comparison, 'setting:systemToolSchedules')).toMatchObject({
      state: 'same',
      label: 'When each tool updates, and its pin',
    });
    expect(itemsOf(comparison).some((one) => one.key === 'setting:systemToolLast')).toBe(false);
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices: { ...comparison.choices } });
    expect(chosen.contents.settings).not.toHaveProperty('systemToolLast');
  });

  it('names every setting it compares, and shows a plain one’s values', async () => {
    // Every setting without a label was taken for a secret: a backup's CI
    // minutes cap or pause of new work showed as "The setting ciMinutesCap",
    // "the backup’s is another one", so nobody could see what taking it meant.
    const app = ['githubClientId', 'webhookSecret', 'appPrivateKey', 'appClientSecret'];
    const keys = settingKeys.SETTING_KEYS.filter((key) => !app.includes(key) && !RUNTIME_SETTINGS.includes(key));
    const contents = archive();
    const here = installB();
    for (const key of keys) {
      contents.settings[key] = 'in-the-backup';
      here.settings = { ...here.settings, [key]: 'here' };
    }
    const install = memoryInstall(here);
    const comparison = compareInstall({ contents, here: install.view(), signIns: [], historyHere: null });

    for (const key of keys) expect(find(comparison, `setting:${key}`).label, key).not.toMatch(/^The setting /);
    expect(find(comparison, 'setting:ciMinutesCap').differences).toEqual(['here here, in-the-backup in the backup']);
    expect(find(comparison, 'setting:installName').differences).toEqual(['here here, in-the-backup in the backup']);
    expect(find(comparison, 'setting:workPaused').differences).toEqual(['the backup’s is another one']);
  });

  it('ticks what is new here, keeps this install’s where it differs, and offers nothing for the same or only here', async () => {
    const { comparison } = await compared();

    expect(comparison.choices['setting:engineUpdates']).toBe(true);
    expect(comparison.choices[`account:${CLAUDE_SEAT}`]).toBe(true);
    expect(comparison.choices.history).toBe(true);
    for (const key of ['app', 'setting:operatorEmail', 'repo:janedoe/fleetadlc-testbed', 'seat:lead-reviewer:account', 'seat:builder:model']) {
      expect(comparison.choices[key]).toBe(false);
    }
    for (const key of ['setting:organization', 'setting:publicUrl', 'repo:janedoe/widgets', 'seat:builder:account']) {
      expect(comparison.choices).not.toHaveProperty(key);
    }
  });

  it('says what differs, showing plain settings and accounts by name and a secret only as different', async () => {
    const { comparison } = await compared();

    expect(find(comparison, 'app').differences).toEqual(['its private key differs']);
    expect(find(comparison, 'setting:operatorEmail').differences).toEqual(['ops@b.example.test here, alex@example.test in the backup']);
    expect(find(comparison, 'repo:janedoe/fleetadlc-testbed').differences).toEqual(['builds at once: 1 here, 2 in the backup']);
    expect(find(comparison, 'seat:lead-reviewer:account')).toMatchObject({
      accounts: { here: 'fleetadlc-other', backup: 'fleetadlc-sydney-janedoe' },
      differences: ['fleetadlc-other here, fleetadlc-sydney-janedoe in the backup'],
    });
    expect(find(comparison, 'seat:builder:model').differences).toEqual([
      'model: newest:sonnet here, newest:opus in the backup',
      'account: Anthropic key (B) here, Claude Max in the backup',
    ]);
    const said = JSON.stringify(comparison);
    for (const value of [VALUES.appKey, 'zzz-b-app-key-zzz', B_KEY, VALUES.apiKey, OTHER_REFRESH, VALUES.reviewerRefresh]) {
      expect(said).not.toContain(value);
    }
  });

  it('checks every sign-in: a refused one cannot be ticked, a rotating one waits unticked with what taking it over means', async () => {
    const { comparison } = await compared();

    expect(find(comparison, `signin:account:${CLAUDE_SEAT}`)).toMatchObject({ takeable: false, take: false, verdict: { state: 'blocked' } });
    expect(find(comparison, 'signin:bot:builder')).toMatchObject({ state: 'same', takeable: false });
    expect(find(comparison, 'signin:bot:lead-reviewer')).toMatchObject({
      state: 'different',
      takeable: true,
      take: false,
      rotates: true,
      dependsOn: 'seat:lead-reviewer:account',
      note: 'Checking a GitHub sign-in uses it — if it works, this install takes it over from wherever else it is in use.',
    });
    expect(find(comparison, `signin:account:${CODEX_SEAT}`)).toMatchObject({ state: 'new', take: false, rotates: true });
    // A working key that would replace this install's is kept unless asked.
    expect(find(comparison, `signin:account:${KEY_ACCOUNT}`)).toMatchObject({ state: 'different', takeable: true, take: false });
  });

  it('takes a seat’s model on an account new here only with that account', async () => {
    // Ticked alone, the restore could not find the account, kept this install's
    // model and still wrote the seat's engine key.
    const { contents, comparison, install } = await compared();
    expect(find(comparison, 'seat:builder:model').dependsOn).toBe(`account:${CLAUDE_SEAT}`);

    const alone = { ...comparison.choices, 'seat:builder:model': true, [`account:${CLAUDE_SEAT}`]: false };
    expect(taken(comparison, alone, 'seat:builder:model')).toBe(false);
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices: alone });
    expect(chosen.contents.bots.find((bot) => bot.slot === 'builder')?.modelAccountId).toBeNull();

    const both = { ...alone, [`account:${CLAUDE_SEAT}`]: true };
    expect(taken(comparison, both, 'seat:builder:model')).toBe(true);
  });

  it('does not offer an app the backup carries only part of, to pair with this install’s other part', async () => {
    // Taken, the backup's client id was written beside this install's private
    // key: everything done as the app failed until a key was given.
    const install = memoryInstall({ ...installB(), settings: { ...installB().settings, githubClientId: 'Iv1.zzz-other-app-zzz' } });
    const whole = archive();
    const secrets = { ...whole.secrets };
    delete secrets['github-app-private-key'];
    const contents = { ...whole, secrets };
    const comparison = compareInstall({ contents, here: install.view(), signIns: [], historyHere: null });

    expect(find(comparison, 'app')).toMatchObject({ takeable: false, take: false });
    expect(find(comparison, 'app').differences).toContain('the backup has no private key; this install’s would be paired with the backup’s app');
    expect(refusedComparisonChoice(comparison, { app: true })).toMatch(/^The GitHub App .* cannot be taken from the backup/);
  });

  it('refuses a choice that takes what cannot be taken, in words', async () => {
    const { comparison } = await compared();

    expect(refusedComparisonChoice(comparison, { [`signin:account:${CLAUDE_SEAT}`]: true })).toBe(
      'Claude Max cannot be taken from the backup: Anthropic did not accept it: invalid x-api-key',
    );
    expect(refusedComparisonChoice(comparison, { 'repo:janedoe/widgets': true })).toBe(
      'janedoe/widgets is only in this install; a restore never removes anything',
    );
    expect(refusedComparisonChoice(comparison, comparison.choices)).toBeNull();
  });

  it('keeps a seat’s account unless its account is chosen: nothing of this install’s sign-in is let go', async () => {
    const { contents, comparison, install, signIns } = await compared();

    const kept = chosenArchive({ contents, here: install.view(), comparison, choices: comparison.choices });
    const keptPlan = previewRestore({ contents: kept.contents, shape: install.shape(), signIns, choices: kept.signIns }).plan;
    expect(keptPlan.secrets.remove).toEqual([]);
    expect(keptPlan.bots.replace).toEqual([]);
    expect(keptPlan.bots.assign).toEqual([]);
    expect(kept.signIns['bot:lead-reviewer']).toBe(false);

    const switched = chosenArchive({
      contents,
      here: install.view(),
      comparison,
      choices: { ...comparison.choices, 'seat:lead-reviewer:account': true, 'signin:bot:lead-reviewer': true },
    });
    const switchedPlan = previewRestore({ contents: switched.contents, shape: install.shape(), signIns, choices: switched.signIns }).plan;
    expect(switchedPlan.bots.replace).toEqual([{ name: 'fleetadlc-other', from: 'fleetadlc-other', to: 'fleetadlc-sydney-janedoe' }]);
    expect(switchedPlan.secrets.remove).toEqual(['github-refresh-fleetadlc-other']);
    expect(switched.signIns['bot:lead-reviewer']).toBe(true);
  });

  it('writes a repository under the name this install has for it, and history only when chosen', async () => {
    const { contents, comparison, install } = await compared();

    const chosen = chosenArchive({
      contents,
      here: install.view(),
      comparison,
      choices: { ...comparison.choices, 'repo:janedoe/fleetadlc-testbed': true, history: false },
    });

    expect(chosen.contents.repositories?.map((repo) => repo.name)).toEqual(['fleetadlc-testbed']);
    expect(chosen.contents.history).toBeNull();
    expect(Object.keys(chosen.contents.settings)).toEqual(['engineUpdates']);
    expect(chosen.contents.secrets).not.toHaveProperty('github-app-private-key');
  });
});

describe('a seat made the backup’s account', () => {
  it('lets go of the record of the old account’s sign-in, and keeps none when the new one is refused', async () => {
    const install = memoryInstall(installB());
    const { contents, signIns, comparison } = await compared(install);
    const choices = { ...comparison.choices, 'seat:lead-reviewer:account': true, 'signin:bot:lead-reviewer': true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });

    const report = await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: fakeTakeOver({ refuse: [VALUES.reviewerRefresh] }).ports,
      actor: 'alex@example.test',
    });

    expect(report.signIns.find((line) => line.key === 'bot:lead-reviewer')?.state).toBe('refused');
    expect(install.state().bots.find((bot) => bot.slot === 'lead-reviewer')?.githubLogin).toBe('fleetadlc-sydney-janedoe');
    // No token, and no record claiming one: the bot is to be connected, not counted as connected.
    expect(install.state().secrets).not.toHaveProperty('github-refresh-fleetadlc-other');
    expect(install.state().credentials).not.toHaveProperty('fleetadlc-other');
  });
});

describe('undoing a seat whose sign-in had already been refused', () => {
  it('puts back the record of it, which counts nobody as connected, and no token', async () => {
    const setUp = installB();
    setUp.secrets = { ...setUp.secrets };
    delete setUp.secrets['github-refresh-fleetadlc-other'];
    setUp.credentials = { ...setUp.credentials, 'fleetadlc-other': { ...setUp.credentials!['fleetadlc-other']!, status: 'revoked' } };
    const install = memoryInstall(setUp);
    const before = install.state();
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const { contents, signIns, comparison } = await compared(install);
    const choices = { ...comparison.choices, 'seat:lead-reviewer:account': true, 'signin:bot:lead-reviewer': true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const journal = journalOf({ id: 'r3', now: NOW, actor: 'alex@example.test', contents, chosen: chosen.contents, comparison, choices });
    await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: fakeTakeOver({ refuse: [VALUES.reviewerRefresh] }).ports,
      actor: 'alex@example.test',
    });
    expect(install.state().credentials).not.toHaveProperty('fleetadlc-other');

    const plan = planUndo(snapshot, journal, install.shape());
    expect(plan.drop.credentials).toEqual([]);
    await applyUndo({
      plan,
      signIns: [],
      shape: install.shape(),
      target: install.target,
      takeOver: fakeTakeOver().ports,
      actor: 'alex@example.test',
      journal,
    });

    expect(install.state().credentials).toEqual(before.credentials);
    expect(install.state().secrets).not.toHaveProperty('github-refresh-fleetadlc-other');
  });
});

describe('undoing a setting this install had only from its environment', () => {
  it('clears it rather than writing the environment’s value into the settings table', async () => {
    // The backup Undo reads has the environment's values beside the stored
    // ones. Written back, a webhook secret from install.json was pinned in the
    // table, and a rotated one in install.json was ignored from then on.
    const install = memoryInstall(installB());
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const { contents, comparison } = await compared(install);
    const choices = { ...comparison.choices, 'setting:operatorEmail': true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const journal = journalOf({
      id: 'r4',
      now: NOW,
      actor: 'alex@example.test',
      contents,
      chosen: chosen.contents,
      comparison,
      choices,
      storedSettings: ['organization', 'publicUrl'],
    });
    expect(journal.settings).toEqual(['engineUpdates', 'operatorEmail']);
    expect(journal.storedSettings).toEqual([]);

    const plan = planUndo(snapshot, journal, install.shape());
    expect(plan.settings.set).toEqual({});
    expect(plan.settings.clear).toEqual(['engineUpdates', 'operatorEmail']);

    // A journal from before this was kept sets them back as they were.
    const older = planUndo(snapshot, { ...journal, storedSettings: undefined }, install.shape());
    expect(older.settings.set).toEqual({ operatorEmail: 'ops@b.example.test' });
  });
});

describe('a restore into a set-up install, and its undo', () => {
  it('writes only what was chosen, takes a rotating sign-in over only when asked, and Undo puts back exactly what it touched', async () => {
    const install = memoryInstall(installB());
    const before = install.state();
    // The backup taken before the restore writes anything.
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const { contents, signIns, comparison } = await compared(install);

    const choices = {
      ...comparison.choices,
      'repo:janedoe/fleetadlc-testbed': true,
      'seat:lead-reviewer:account': true,
      'signin:bot:lead-reviewer': true,
      [`signin:account:${CODEX_SEAT}`]: true,
    };
    expect(refusedComparisonChoice(comparison, choices)).toBeNull();
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const journal = journalOf({ id: 'r1', now: NOW, actor: 'alex@example.test', contents, chosen: chosen.contents, comparison, choices });
    const takeOver = fakeTakeOver({ logins: { ...REFRESH_LOGINS, [OTHER_REFRESH]: 'fleetadlc-other' } });
    const ports = { ...takeOver.ports, adoptLogin: async (id: string, files: typeof CODEX_LOGIN) => (install.adopt(files, id), { ok: true, message: 'answered: OK' }) };

    const report = await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: ports,
      actor: 'alex@example.test',
    });
    journal.history = report.outcome.history?.ids ?? null;
    const after = install.state();

    // New here: added. Different and not chosen: this install's kept. Only here: kept.
    expect(after.settings.engineUpdates).toBe('on');
    expect(after.settings.operatorEmail).toBe('ops@b.example.test');
    expect(after.settings.publicUrl).toBe('https://b.example.test');
    expect(after.secrets['github-app-private-key']).toBe('zzz-b-app-key-zzz');
    expect(after.repositories.find((repo) => repo.name === 'fleetadlc-testbed')?.concurrency).toBe(2);
    expect(after.repositories.find((repo) => repo.name === 'widgets')?.removed).toBeFalsy();
    expect(after.bots.find((bot) => bot.slot === 'builder')?.model).toBe('newest:sonnet');
    expect(after.accounts.map((account) => account.id).sort()).toEqual([KEY_ACCOUNT, CLAUDE_SEAT, CODEX_SEAT, GROK_ACCOUNT].sort());
    expect(after.accounts.find((account) => account.id === KEY_ACCOUNT)?.label).toBe('Anthropic key (B)');
    // The refused token was never written; the key this install had stays.
    expect(after.secrets).not.toHaveProperty(`model-account-${CLAUDE_SEAT}`);
    expect(after.secrets[`model-account-${KEY_ACCOUNT}`]).toBe(B_KEY);
    // The reviewer is the backup's account now, holding the token GitHub gave for its sign-in.
    expect(after.bots.find((bot) => bot.slot === 'lead-reviewer')?.githubLogin).toBe('fleetadlc-sydney-janedoe');
    expect(takeOver.refreshed).toEqual([VALUES.reviewerRefresh]);
    expect(after.secrets['github-refresh-fleetadlc-other']).toBe('ghr_zzz-fresh-refresh-1-zzz');
    expect(after.secrets['ssh-signing-fleetadlc-other']).toBe(VALUES.reviewerSigning);
    expect(after.logins[CODEX_SEAT]).toEqual(CODEX_LOGIN);
    expect(after.history.threads.map((thread) => thread.id)).toContain(HISTORY.threads[0]?.id);
    expect(report.signIns.find((line) => line.key === `account:${CLAUDE_SEAT}`)?.state).toBe('blocked');

    // The registry token was new here, so it came too.
    expect(after.secrets['registry-token']).toBe(VALUES.registry);
    expect(journal).toMatchObject({
      settings: ['engineUpdates'],
      install: ['registry-token'],
      seats: [{ seat: 'lead-reviewer', account: true, model: false, signIn: true }],
      repositories: ['janedoe/fleetadlc-testbed'],
      accounts: [CLAUDE_SEAT, CODEX_SEAT],
      accountCredentials: [CODEX_SEAT],
    });
    expect(undoOpen(journal, new Date('2026-09-26T09:59:00.000Z'))).toBe(true);
    expect(undoOpen(journal, new Date('2026-09-26T10:00:01.000Z'))).toBe(false);

    // Undo: back from the backup taken before, checked like any restore.
    const plan = planUndo(snapshot, journal, install.shape());
    const undoSignIns = await judgeSignIns({
      contents: plan.signIns,
      shape: install.shape(),
      facts: install.facts,
      checks: fakeChecks().checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const back = fakeTakeOver({ logins: { [OTHER_REFRESH]: 'fleetadlc-other' } });
    const outcome = await applyUndo({
      plan,
      signIns: undoSignIns,
      shape: install.shape(),
      target: install.target,
      takeOver: back.ports,
      actor: 'alex@example.test',
      journal,
    });
    const undone = install.state();

    // The reviewer's own sign-in was taken back by using it; nothing else of the
    // install is anything but what it was.
    expect(back.refreshed).toEqual([OTHER_REFRESH]);
    expect(outcome.signIns).toEqual([{ key: 'bot:lead-reviewer', who: 'fleetadlc-other', state: 'taken-over' }]);
    expect(undone.secrets['github-refresh-fleetadlc-other']).toBe('ghr_zzz-fresh-refresh-1-zzz');
    const { 'github-refresh-fleetadlc-other': _taken, ...secretsNow } = undone.secrets;
    const { 'github-refresh-fleetadlc-other': _had, ...secretsBefore } = before.secrets;
    expect(secretsNow).toEqual(secretsBefore);
    expect(undone.settings).toEqual(before.settings);
    expect(undone.bots).toEqual(before.bots);
    expect(undone.identities).toEqual(before.identities);
    expect(undone.accounts).toEqual(before.accounts);
    expect(undone.repositories.filter((repo) => !repo.removed).map(({ removed: _removed, ...repo }) => repo)).toEqual(before.repositories);
    expect(undone.logins).toEqual(before.logins);
    expect(undone.history).toEqual(before.history);
    expect(undone.credentials['fleetadlc-other']).toMatchObject({ githubLogin: 'fleetadlc-other', githubUserId: 7, status: 'active' });
  });

  it('does not put a seat back on an account whose sign-in no longer works over the one that does, and says so', async () => {
    const install = memoryInstall(installB());
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const { contents, signIns, comparison } = await compared(install);
    const choices = { ...comparison.choices, 'seat:lead-reviewer:account': true, 'signin:bot:lead-reviewer': true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const journal = journalOf({ id: 'r2', now: NOW, actor: 'alex@example.test', contents, chosen: chosen.contents, comparison, choices });
    await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: fakeTakeOver({ logins: REFRESH_LOGINS }).ports,
      actor: 'alex@example.test',
    });
    const working = install.state().secrets['github-refresh-fleetadlc-other'];

    const plan = planUndo(snapshot, journal, install.shape());
    const undoSignIns = await judgeSignIns({
      contents: plan.signIns,
      shape: install.shape(),
      facts: install.facts,
      checks: fakeChecks().checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const outcome = await applyUndo({
      plan,
      signIns: undoSignIns,
      shape: install.shape(),
      target: install.target,
      takeOver: fakeTakeOver({ refuse: [OTHER_REFRESH] }).ports,
      actor: 'alex@example.test',
      journal,
    });

    expect(outcome.signIns).toEqual([
      {
        key: 'bot:lead-reviewer',
        who: 'fleetadlc-other',
        state: 'kept',
        reason: 'GitHub did not accept it: The refresh token passed is incorrect or expired.',
      },
    ]);
    // Its account follows its sign-in: the seat stays the account whose sign-in works, and says why.
    expect(outcome.keptSeats).toEqual([
      {
        seat: 'lead-reviewer',
        login: 'fleetadlc-sydney-janedoe',
        reason: 'GitHub did not accept it: The refresh token passed is incorrect or expired.',
      },
    ]);
    expect(install.state().bots.find((bot) => bot.slot === 'lead-reviewer')?.githubLogin).toBe('fleetadlc-sydney-janedoe');
    expect(install.state().secrets['github-refresh-fleetadlc-other']).toBe(working);
    expect(install.state().credentials['fleetadlc-other']?.githubLogin).toBe('fleetadlc-sydney-janedoe');
    // Everything else the restore touched went back.
    expect(install.state().settings.engineUpdates).toBeUndefined();
  });
});

describe('undoing a seat whose old account had a token that does not expire', () => {
  const OTHER_TOKEN = 'ghu_zzz-other-static-zzz';

  /** Install B, with the lead reviewer's account (A) signed in by a token that does not expire. */
  function staticInstall() {
    const b = installB();
    const { 'github-refresh-fleetadlc-other': _refresh, ...secrets } = b.secrets ?? {};
    return memoryInstall({
      ...b,
      secrets: { ...secrets, 'github-token-fleetadlc-other': OTHER_TOKEN },
      credentials: { ...b.credentials, 'fleetadlc-other': { ...b.credentials!['fleetadlc-other']!, refreshExpiresAt: null } },
    });
  }

  /** Restores the backup's account (B) into the lead reviewer's seat, then undoes it with A's token judged as `checks` says. */
  async function restoreThenUndo(checks: ReturnType<typeof fakeChecks>['checks']) {
    const install = staticInstall();
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const { contents, signIns, comparison } = await compared(install);
    const choices = { ...comparison.choices, 'seat:lead-reviewer:account': true, 'signin:bot:lead-reviewer': true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const journal = journalOf({ id: 'r3', now: NOW, actor: 'alex@example.test', contents, chosen: chosen.contents, comparison, choices });
    await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: fakeTakeOver({ logins: REFRESH_LOGINS }).ports,
      actor: 'alex@example.test',
    });
    const restored = install.state();
    // B's sign-in, filed under the name A's was.
    expect(restored.bots.find((bot) => bot.slot === 'lead-reviewer')?.githubLogin).toBe('fleetadlc-sydney-janedoe');
    expect(restored.secrets['github-refresh-fleetadlc-other']).toBe('ghr_zzz-fresh-refresh-1-zzz');

    const plan = planUndo(snapshot, journal, install.shape());
    const undoSignIns = await judgeSignIns({
      contents: plan.signIns,
      shape: install.shape(),
      facts: install.facts,
      checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const outcome = await applyUndo({
      plan,
      signIns: undoSignIns,
      shape: install.shape(),
      target: install.target,
      takeOver: fakeTakeOver().ports,
      actor: 'alex@example.test',
      journal,
    });
    return { install, restored, outcome };
  }

  it('puts back A’s token and takes away B’s sign-in under that name, so the seat acts as the account it is recorded as', async () => {
    // Left there, B's refresh token is what the broker reads first: the seat
    // went on acting as B while OpenADLC recorded it as A.
    const { install, outcome } = await restoreThenUndo(fakeChecks({ users: { [OTHER_TOKEN]: 'fleetadlc-other' } }).checks);

    expect(outcome.signIns).toEqual([{ key: 'bot:lead-reviewer', who: 'fleetadlc-other', state: 'restored' }]);
    const after = install.state();
    expect(after.secrets['github-token-fleetadlc-other']).toBe(OTHER_TOKEN);
    expect(after.secrets).not.toHaveProperty('github-refresh-fleetadlc-other');
    expect(after.bots.find((bot) => bot.slot === 'lead-reviewer')?.githubLogin).toBe('fleetadlc-other');
  });

  it('leaves the seat on B, with its record and sign-in, when A’s token is refused, and says so', async () => {
    const { install, restored, outcome } = await restoreThenUndo(fakeChecks({ refuse: [OTHER_TOKEN] }).checks);

    const reason = 'GitHub did not accept it: Bad credentials (401)';
    expect(outcome.signIns).toEqual([{ key: 'bot:lead-reviewer', who: 'fleetadlc-other', state: 'kept', reason }]);
    expect(outcome.keptSeats).toEqual([{ seat: 'lead-reviewer', login: 'fleetadlc-sydney-janedoe', reason }]);
    const after = install.state();
    expect(after.bots.find((bot) => bot.slot === 'lead-reviewer')?.githubLogin).toBe('fleetadlc-sydney-janedoe');
    expect(after.bots.find((bot) => bot.slot === 'lead-reviewer')?.identity).toBe(restored.bots.find((bot) => bot.slot === 'lead-reviewer')?.identity);
    expect(after.credentials['fleetadlc-other']).toEqual(restored.credentials['fleetadlc-other']);
    expect(after.secrets['github-refresh-fleetadlc-other']).toBe('ghr_zzz-fresh-refresh-1-zzz');
    expect(after.secrets['ssh-signing-fleetadlc-other']).toBe(restored.secrets['ssh-signing-fleetadlc-other']);
    expect(after.secrets).not.toHaveProperty('github-token-fleetadlc-other');
    // Everything else the restore touched went back.
    expect(after.settings.engineUpdates).toBeUndefined();
  });
});

describe('a bot’s own engine key in a restore into a set-up install', () => {
  const HERE_KEY = 'sk-ant-api-zzz-b-builder-engine-zzz';
  const ARCHIVED_KEY = 'sk-ant-api-zzz-revoked-engine-zzz';

  it('never puts a refused key over this install’s working one, even with what the bot thinks with taken', async () => {
    const b = installB();
    const install = memoryInstall({ ...b, secrets: { ...b.secrets, 'engine-key-fleetadlc-atlas-janedoe': HERE_KEY } });
    const built = archive();
    const contents = { ...built, secrets: { ...built.secrets, 'engine-key-fleetadlc-atlas-janedoe': ARCHIVED_KEY } };
    const signIns = await judgeSignIns({
      contents,
      shape: install.shape(),
      facts: install.facts,
      checks: fakeChecks({ refuse: [VALUES.seatToken, ARCHIVED_KEY] }).checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const comparison = compareInstall({ contents, here: install.view(), signIns, historyHere: null });

    const model = find(comparison, 'seat:builder:model');
    expect(model.note).toBe('The backup’s engine key was refused: Anthropic did not accept it: invalid x-api-key; this install’s is kept.');
    expect(find(comparison, 'signin:engine:builder')).toMatchObject({ takeable: false, dependsOn: 'seat:builder:model' });

    const choices = { ...comparison.choices, 'seat:builder:model': true, [`account:${CLAUDE_SEAT}`]: true };
    expect(refusedComparisonChoice(comparison, choices)).toBeNull();
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: fakeTakeOver().ports,
      actor: 'alex@example.test',
    });

    const after = install.state();
    expect(after.bots.find((bot) => bot.slot === 'builder')?.model).toBe('newest:opus');
    expect(after.secrets['engine-key-fleetadlc-atlas-janedoe']).toBe(HERE_KEY);
  });

  it('comes back with what the bot thinks with when the provider accepts it', async () => {
    const b = installB();
    const install = memoryInstall({ ...b, secrets: { ...b.secrets, 'engine-key-fleetadlc-atlas-janedoe': HERE_KEY } });
    const built = archive();
    const contents = { ...built, secrets: { ...built.secrets, 'engine-key-fleetadlc-atlas-janedoe': ARCHIVED_KEY } };
    const signIns = await judgeSignIns({
      contents,
      shape: install.shape(),
      facts: install.facts,
      checks: fakeChecks({ refuse: [VALUES.seatToken] }).checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const comparison = compareInstall({ contents, here: install.view(), signIns, historyHere: null });
    expect(find(comparison, 'seat:builder:model').note).toBe('The backup’s engine key works: Anthropic lists 2 models for it.');

    const choices = { ...comparison.choices, 'seat:builder:model': true, [`account:${CLAUDE_SEAT}`]: true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    expect(chosen.signIns['engine:builder']).toBe(true);
    await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: fakeTakeOver().ports,
      actor: 'alex@example.test',
    });

    expect(install.state().secrets['engine-key-fleetadlc-atlas-janedoe']).toBe(ARCHIVED_KEY);
  });
});


/**
 * The crew's signing key and a seat's look, taken from the archive and then
 * undone. Undo put back neither: this install went on signing with a key the
 * archive's holder also has, its own dropped out of the retired keys after a
 * month, and the seat kept the archive's color and avatar.
 */
describe('undoing a restore that took the crew’s signing key and a seat’s look', () => {
  it('signs with this install’s own key again, keeps the archive’s among those that check, and puts the look back', async () => {
    const OURS = JSON.stringify({ current: { kid: 'b-kid', secret: 'zzz-b-attribution-zzz' }, retired: [] });
    const THEIRS = JSON.stringify({ current: { kid: 'a-kid', secret: 'zzz-a-attribution-zzz' }, retired: [] });
    const setUp = installB();
    setUp.secrets = { ...setUp.secrets, 'attribution-key': OURS };
    setUp.bots = setUp.bots!.map((bot) => (bot.slot === 'lead-reviewer' ? { ...bot, color: 'blue', avatar: 'dots' } : bot));
    const install = memoryInstall(setUp);
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;

    const source = sourceInstall();
    source.secrets = { ...source.secrets, 'attribution-key': THEIRS };
    source.bots = source.bots.map((bot) => (bot.slot === 'lead-reviewer' ? { ...bot, color: 'rose', avatar: 'gear' } : bot));
    const contents = buildBackup(source, { ...EVERYTHING, history: true }, NOW).contents;
    const clientId = { after: VALUES.clientId, archive: VALUES.clientId };
    const signIns = await judgeSignIns({ contents, shape: install.shape(), facts: install.facts, checks: fakeChecks().checks, now: NOW, clientId });
    const comparison = compareInstall({ contents, here: install.view(), signIns, historyHere: null });
    const choices = {
      ...comparison.choices,
      'secret:attribution-key': true,
      'seat:lead-reviewer:account': true,
      'signin:bot:lead-reviewer': true,
    };
    expect(refusedComparisonChoice(comparison, choices)).toBeNull();
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const journal = journalOf({
      id: 'r5',
      now: NOW,
      actor: 'alex@example.test',
      contents,
      chosen: chosen.contents,
      comparison,
      choices,
      shape: install.shape(),
    });
    expect(journal.install).toContain('attribution-key');
    expect(journal.looks).toEqual(['lead-reviewer']);

    await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: fakeTakeOver({ logins: { ...REFRESH_LOGINS, [OTHER_REFRESH]: 'fleetadlc-other' } }).ports,
      actor: 'alex@example.test',
    });
    const keyringOf = () =>
      JSON.parse(install.state().secrets['attribution-key'] ?? '{}') as { current: { kid: string }; retired: { kid: string; retiredAt?: string }[] };
    const reviewer = () => install.state().bots.find((bot) => bot.slot === 'lead-reviewer');
    expect(keyringOf().current.kid).toBe('a-kid');
    expect(reviewer()).toMatchObject({ color: 'rose', avatar: 'gear' });

    const plan = planUndo(snapshot, journal, install.shape());
    const undoSignIns = await judgeSignIns({ contents: plan.signIns, shape: install.shape(), facts: install.facts, checks: fakeChecks().checks, now: NOW, clientId });
    await applyUndo({
      plan,
      signIns: undoSignIns,
      shape: install.shape(),
      target: install.target,
      takeOver: fakeTakeOver({ logins: { [OTHER_REFRESH]: 'fleetadlc-other' } }).ports,
      actor: 'alex@example.test',
      journal,
    });

    const keyring = keyringOf();
    expect(keyring.current.kid).toBe('b-kid');
    expect(keyring.retired.map((key) => key.kid)).toContain('a-kid');
    expect(keyring.retired.find((key) => key.kid === 'a-kid')?.retiredAt).toEqual(expect.any(String));
    expect(reviewer()).toMatchObject({ color: 'blue', avatar: 'dots' });
  });

  it('leaves the look alone for a journal written before undo put it back', async () => {
    const install = memoryInstall(installB());
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const { contents, comparison } = await compared(install);
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices: comparison.choices });
    const journal = journalOf({ id: 'r6', now: NOW, actor: 'alex@example.test', contents, chosen: chosen.contents, comparison, choices: comparison.choices });

    expect(journal).not.toHaveProperty('looks');
    expect(planUndo(snapshot, journal, install.shape()).looks).toEqual([]);
  });
});

describe('a repository whose name another repository here has', () => {
  // OpenADLC names a repository by its name alone. Restoring other/widgets
  // into an install with acme/widgets wrote it over acme's row — its issues,
  // tasks and caps with it — and Undo then marked that row removed.
  const OTHER = {
    name: 'widgets',
    fullName: 'other/widgets',
    ownerSeat: 'builder',
    concurrency: 3,
    stageModes: {},
    specRequiredLabels: [],
    humanReviewPaths: [],
    defaultBranch: 'trunk',
    color: 'pink',
  };
  const withOther = (): BackupContents => {
    const contents = archive();
    return { ...contents, repositories: [...(contents.repositories ?? []), OTHER] };
  };
  const acme = (removed = false) => {
    const state = installB();
    state.repositories = (state.repositories ?? []).map((repo) =>
      repo.name === 'widgets' ? { ...repo, fullName: 'acme/widgets', ...(removed ? { removed: true } : {}) } : repo,
    );
    return memoryInstall(state);
  };
  const compareWith = (install: ReturnType<typeof memoryInstall>, contents = withOther()) =>
    compareInstall({ contents, here: install.view(), signIns: [], historyHere: null });

  it.each([
    ['in use', false],
    ['removed from OpenADLC', true],
  ])('cannot be taken when the one here is %s, and says why', (_how, removed) => {
    const comparison = compareWith(acme(removed));

    const item = find(comparison, 'repo:other/widgets');
    expect(item).toMatchObject({ takeable: false, take: false });
    expect(item.note).toContain(`a repository called widgets (acme/widgets${removed ? ', removed from OpenADLC' : ''})`);
    expect(item.note).toContain('OpenADLC names each repository by its name alone');
    expect(comparison.choices).not.toHaveProperty('repo:other/widgets');
    expect(refusedComparisonChoice(comparison, { 'repo:other/widgets': true })).toBe(`other/widgets cannot be taken from the backup: ${item.note}`);
  });

  it('is left alone by a restore and its undo: acme/widgets keeps its row', async () => {
    const install = acme();
    const before = install.state();
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const contents = withOther();
    const comparison = compareWith(install, contents);
    const choices = comparison.choices;
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    expect(chosen.contents.repositories?.map((repo) => repo.fullName)).not.toContain('other/widgets');
    const journal = journalOf({ id: 'r5', now: NOW, actor: 'alex@example.test', contents, chosen: chosen.contents, comparison, choices });

    const takeOver = fakeTakeOver({ logins: REFRESH_LOGINS });
    await runRestore({ contents: chosen.contents, shape: install.shape(), signIns: [], choices: chosen.signIns, target: install.target, takeOver: takeOver.ports, actor: 'alex@example.test' });
    const plan = planUndo(snapshot, journal, install.shape());
    await applyUndo({ plan, signIns: [], shape: install.shape(), target: install.target, takeOver: takeOver.ports, actor: 'alex@example.test', journal });

    const widgets = (state: ReturnType<typeof install.state>) => state.repositories.filter((repo) => repo.name === 'widgets');
    expect(widgets(install.state())).toEqual(widgets(before));
    expect(widgets(install.state())[0]).toMatchObject({ fullName: 'acme/widgets', concurrency: 1, color: 'amber' });
  });

  it('is refused by a restore that was handed it anyway, before anything is written', async () => {
    const install = acme();
    const before = install.state();
    const contents = { ...withOther(), repositories: [OTHER] };

    await expect(
      runRestore({ contents, shape: install.shape(), signIns: [], choices: {}, target: install.target, takeOver: fakeTakeOver({}).ports, actor: 'alex@example.test' }),
    ).rejects.toThrow('this install already has a repository called widgets (acme/widgets)');
    expect(install.state().repositories).toEqual(before.repositories);
  });

  it('goes back to the repository it was when an older restore wrote another over its row', async () => {
    // What a restore before this fix left: acme/widgets' row holding other/widgets.
    const install = acme();
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const before = install.state();
    const overwritten = memoryInstall({
      ...before,
      repositories: before.repositories.map((repo) => (repo.name === 'widgets' ? { ...repo, ...OTHER } : repo)),
    });
    const journal = journalOf({
      id: 'r6',
      now: NOW,
      actor: 'alex@example.test',
      contents: withOther(),
      chosen: { ...withOther(), settings: {}, secrets: {}, bots: [], accounts: [], repositories: [OTHER], history: null },
      comparison: { groups: [], choices: {} },
      choices: {},
    });
    expect(journal.repositories).toEqual(['other/widgets']);

    const plan = planUndo(snapshot, journal, overwritten.shape());
    expect(plan.repositories).toEqual({
      put: [{ repo: expect.objectContaining({ fullName: 'acme/widgets' }), owner: 'fleetadlc-atlas-janedoe', over: 'other/widgets' }],
      remove: [],
    });
    await applyUndo({ plan, signIns: [], shape: overwritten.shape(), target: overwritten.target, takeOver: fakeTakeOver({}).ports, actor: 'alex@example.test', journal });

    const rows = (state: ReturnType<typeof install.state>) => state.repositories.map(({ removed: _removed, ...repo }) => repo);
    expect(rows(overwritten.state())).toEqual(rows(before));
  });

  it('fails the undo, writing nothing, when a repository cannot be put back', async () => {
    // acme/widgets is to go back, and other/widgets has its name meanwhile.
    const install = acme();
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const before = install.state();
    const taken = memoryInstall({
      ...before,
      repositories: before.repositories.filter((repo) => repo.name !== 'widgets').concat([{ ...OTHER, name: 'widgets' }]),
    });
    const journal = journalOf({
      id: 'r7',
      now: NOW,
      actor: 'alex@example.test',
      contents: snapshot,
      chosen: { ...snapshot, settings: {}, secrets: {}, bots: [], accounts: [], repositories: snapshot.repositories?.filter((repo) => repo.name === 'widgets') ?? [], history: null },
      comparison: { groups: [], choices: {} },
      choices: {},
    });
    const plan = planUndo(snapshot, journal, taken.shape());
    const was = taken.state();

    await expect(
      applyUndo({ plan, signIns: [], shape: taken.shape(), target: taken.target, takeOver: fakeTakeOver({}).ports, actor: 'alex@example.test', journal }),
    ).rejects.toThrow('cannot be restored beside it');
    expect(taken.state()).toEqual(was);
  });
});

describe('the spending caps in a restore into a set-up install', () => {
  // Every restore replaced the whole table with the archive's caps, whatever
  // was ticked: a monthly cap raised, the repository, bot and provider caps
  // deleted, and nothing on the comparison or in the audit log to say so.
  const HERE = [
    { scope: 'global', kind: 'month_total', amountUsd: 300 },
    { scope: 'global', kind: 'task', amountUsd: 10 },
    { scope: 'repo', repository: 'janedoe/widgets', kind: 'month_total', amountUsd: 25 },
  ];
  const withCaps = (caps: { scope: string; kind: string; amountUsd: number }[]): BackupContents => ({ ...archive(), spendingLimits: caps });
  const capsOf = (install: ReturnType<typeof memoryInstall>) =>
    install.state().spendingLimits.map((cap) => `${cap.repository ?? cap.scope} ${cap.kind} ${cap.amountUsd}`).sort();

  async function restoreCaps(take: boolean | undefined) {
    const install = memoryInstall({ ...installB(), spendingLimits: HERE });
    const snapshot = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const contents = withCaps([{ scope: 'global', kind: 'month_total', amountUsd: 5000 }]);
    const comparison = compareInstall({ contents, here: install.view(), signIns: [], historyHere: null });
    const choices = take === undefined ? comparison.choices : { ...comparison.choices, spending: take };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const journal = journalOf({ id: 'r8', now: NOW, actor: 'alex@example.test', contents, chosen: chosen.contents, comparison, choices });
    const takeOver = fakeTakeOver({ logins: REFRESH_LOGINS });
    await runRestore({
      contents: chosen.contents,
      shape: install.shape(),
      signIns: [],
      choices: chosen.signIns,
      target: install.target,
      takeOver: takeOver.ports,
      actor: 'alex@example.test',
      spending: 'merge',
    });
    return { install, snapshot, journal, comparison, takeOver };
  }

  it('are one item: the same when they match, and different and unticked when they do not', () => {
    const install = memoryInstall({ ...installB(), spendingLimits: HERE });
    const same = compareInstall({ contents: withCaps([HERE[0] as never]), here: install.view(), signIns: [], historyHere: null });
    expect(find(same, 'spending')).toMatchObject({ group: 'install', state: 'same', takeable: false, take: false });

    const differs = compareInstall({ contents: withCaps([{ scope: 'global', kind: 'month_total', amountUsd: 5000 }]), here: install.view(), signIns: [], historyHere: null });
    expect(find(differs, 'spending')).toMatchObject({
      state: 'different',
      takeable: true,
      take: false,
      differences: ['all repositories, a month: $300 here, $5000 in the backup'],
    });
    expect(differs.choices.spending).toBe(false);
  });

  it('change nothing when the item is not ticked', async () => {
    const { install, journal } = await restoreCaps(undefined);

    expect(capsOf(install)).toEqual(['global month_total 300', 'global task 10', 'janedoe/widgets month_total 25']);
    expect(journal.spending).toBe(false);
    expect(install.audit).not.toContain('spending.limit_changed');
  });

  it('set the cap the archive names when ticked, keep the caps only here, audit it, and Undo puts the table back', async () => {
    const { install, snapshot, journal, takeOver } = await restoreCaps(true);

    expect(capsOf(install)).toEqual(['global month_total 5000', 'global task 10', 'janedoe/widgets month_total 25']);
    expect(journal.spending).toBe(true);
    expect(install.audit.filter((action) => action === 'spending.limit_changed')).toHaveLength(1);

    const plan = planUndo(snapshot, journal, install.shape());
    await applyUndo({ plan, signIns: [], shape: install.shape(), target: install.target, takeOver: takeOver.ports, actor: 'alex@example.test', journal });
    expect(capsOf(install)).toEqual(['global month_total 300', 'global task 10', 'janedoe/widgets month_total 25']);
  });
});

describe('what a restore into a set-up install leaves to do', () => {
  // A seat whose archived sign-in did not come back was told to connect
  // again, though it kept this install's own working sign-in: restoring a
  // week-old backup into the install it came from asked to reconnect every bot.
  const NEWER = 'ghr_zzz-builder-newer-zzz';
  /** Install B with a newer sign-in for the builder's account: refreshed since, or, `reauthorized`, another authorization. */
  const setUp = (reauthorized = false) => {
    const b = installB();
    const builder = b.credentials!['fleetadlc-atlas-janedoe']!;
    return memoryInstall({
      ...b,
      secrets: { ...b.secrets, 'github-refresh-fleetadlc-atlas-janedoe': NEWER },
      credentials: {
        ...b.credentials,
        'fleetadlc-atlas-janedoe': reauthorized ? { ...builder, authorizedAt: '2026-09-20T08:00:00.000Z' } : builder,
      },
    });
  };

  async function next(install: ReturnType<typeof memoryInstall>, archiveClientId: string, leaveOut: boolean) {
    const contents = archive();
    const signIns = await judgeSignIns({
      contents,
      shape: install.shape(),
      facts: install.facts,
      checks: fakeChecks().checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: archiveClientId },
    });
    const choices = { ...defaultSignInChoices(signIns, 'running'), ...(leaveOut ? { 'bot:builder': false } : {}) };
    const preview = previewRestore({ contents, shape: install.shape(), signIns, choices });
    return { builder: preview.signIns.find((line) => line.key === 'bot:builder'), next: preview.summary.next };
  }

  it('does not ask to connect a seat again when its archived sign-in is blocked but its own is kept', async () => {
    const { builder, next: todo } = await next(setUp(), 'Iv1.zzz-another-app-zzz', false);
    expect(builder?.state).toBe('blocked');
    expect(todo.join('\n')).not.toContain('Connect fleetadlc-atlas-janedoe');
  });

  it('does not ask to connect a seat again when its archived sign-in is left out but its own is kept', async () => {
    const { builder, next: todo } = await next(setUp(true), VALUES.clientId, true);
    expect(builder?.state).toBe('left-out');
    expect(todo.join('\n')).not.toContain('Connect fleetadlc-atlas-janedoe');
  });
});

describe('a seat the archive has and this install does not', () => {
  it('says how to add it, not to run fleetadlc up, which already seeded every seat it knows', async () => {
    // Told "`fleetadlc up` seeds it from config/bots.yaml", a person ran it,
    // nothing changed, and they were told the same again.
    const b = installB();
    const install = memoryInstall({ ...b, bots: b.bots!.filter((bot) => bot.slot !== 'lead-reviewer') });
    const { comparison } = await compared(install);

    const note = find(comparison, 'seat:lead-reviewer:account').note ?? '';
    expect(note).toContain('Add a builder in Settings → GitHub accounts');
    expect(note).toContain('config/bots.yaml');
    expect(note).not.toContain('seeds it');
  });
});
