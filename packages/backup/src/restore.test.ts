import { describe, expect, it } from 'vitest';
import { BackupError, readPlain, writePlain, type BackupContents } from './archive.js';
import { NOT_CLEAN, cleanliness } from './clean.js';
import { compareInstall, itemsOf } from './compare.js';
import { buildBackup } from './contents.js';
import { applyRestore } from './apply.js';
import { changeCount, planRestore } from './plan.js';
import { runRestore } from './restore.js';
import { EVERYTHING, type BackupSelection } from './selection.js';
import { NOTHING_HELD, defaultSignInChoices, judgeSignIns, type SignInChoices } from './signins.js';
import { describePlan, summarizeArchive, summarizeRestore } from './summary.js';
import {
  CLAUDE_SEAT,
  CODEX_LOGIN,
  CODEX_SEAT,
  KEY_ACCOUNT,
  REFRESH_LOGINS,
  VALUES,
  cleanShape,
  fakeChecks,
  fakeTakeOver,
  fakeTarget,
  HISTORY,
  memoryInstall,
  sourceInstall,
} from './test-fixtures.js';

/**
 * Restoring onto a clean install: every group goes where it belongs, found by
 * seat and by name rather than by the old install's ids; each sign-in is
 * judged first, and the ones that rotate are checked by using them and taken
 * over; and the bots whose sign-ins came back take their handles through the
 * rename routine.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');

function archive(selection: BackupSelection = { ...EVERYTHING, history: true }): BackupContents {
  return buildBackup(sourceInstall(), selection, NOW).contents;
}

async function restoreOnto(
  contents: BackupContents,
  options: Parameters<typeof fakeTarget>[0] & {
    refuse?: string[];
    refuseRefresh?: string[];
    refuseLogin?: string[];
    choices?: (defaults: SignInChoices) => SignInChoices;
  } = {},
) {
  const shape = cleanShape();
  const clientId = contents.settings.githubClientId ?? null;
  const signIns = await judgeSignIns({
    contents,
    shape,
    facts: NOTHING_HELD,
    checks: fakeChecks({ refuse: options.refuse ?? [] }).checks,
    now: NOW,
    clientId: { after: clientId, archive: clientId },
  });
  const defaults = defaultSignInChoices(signIns, 'clean');
  const { target, recorded } = fakeTarget(options);
  const takeOver = fakeTakeOver({ refuse: options.refuseRefresh ?? [], logins: REFRESH_LOGINS, refuseLogin: options.refuseLogin ?? [] });
  const report = await runRestore({
    contents,
    shape,
    signIns,
    choices: options.choices ? options.choices(defaults) : defaults,
    target,
    takeOver: takeOver.ports,
    actor: 'alex@example.test',
  });
  return { plan: report.plan, recorded, outcome: report.outcome, report, takeOver };
}

describe('a restore of everything onto a clean install', () => {
  it('puts back the settings and the App’s key, but never the internal API secret', async () => {
    // A backup leaves the secret out, so one is put in by hand: the install
    // and the archive held the same value, and a restore that wrote it back
    // passed.
    const contents = archive();
    contents.secrets['internal-api-secret'] = 'zzz-archived-internal-zzz';
    const { recorded } = await restoreOnto(contents, { existing: { 'internal-api-secret': 'zzz-this-install-internal-zzz' } });

    expect(recorded.settings).toMatchObject({ organization: 'janedoe', githubClientId: VALUES.clientId });
    expect(recorded.secrets.get('github-app-private-key')).toBe(VALUES.appKey);
    expect(recorded.secrets.get('internal-api-secret')).toBe('zzz-this-install-internal-zzz');
    expect(recorded.order).not.toContain('secret internal-api-secret');
  });

  it('puts an older archive’s webhook secret setting into the secret store, where the bridge reads it', async () => {
    // The archive's settings hold it, as every backup did before it moved.
    const contents = archive();
    expect(contents.settings.webhookSecret).toBe(VALUES.hook);

    const { recorded, outcome } = await restoreOnto(contents);

    expect(recorded.secrets.get('github-webhook-secret')).toBe(VALUES.hook);
    expect(recorded.settings).not.toHaveProperty('webhookSecret');
    expect(outcome.settings).not.toContain('webhookSecret');
    expect(outcome.secrets).toContain('github-webhook-secret');
  });

  it('puts back a webhook secret the archive carries in its secret store', async () => {
    const found = sourceInstall();
    found.secrets['github-webhook-secret'] = 'zzz-hook-in-the-store-zzz';
    const { recorded } = await restoreOnto(buildBackup(found, { ...EVERYTHING, history: true }, NOW).contents);

    expect(recorded.secrets.get('github-webhook-secret')).toBe('zzz-hook-in-the-store-zzz');
    expect(recorded.settings).not.toHaveProperty('webhookSecret');
  });

  it('writes each bot’s secrets under the name its seat has here, and takes over its sign-in with the token GitHub gives for it', async () => {
    const { recorded, takeOver } = await restoreOnto(archive());

    expect(recorded.secrets.get('ssh-signing-builder')).toBe(VALUES.builderSigning);
    // The archive's tokens were exchanged — that is the check — and what is
    // kept is the pair GitHub answered with, never the spent one.
    expect(takeOver.refreshed).toEqual([VALUES.builderRefresh, VALUES.reviewerRefresh]);
    expect(recorded.secrets.get('github-refresh-builder')).toBe('ghr_zzz-fresh-refresh-1-zzz');
    expect(recorded.secrets.get('github-refresh-lead-reviewer')).toBe('ghr_zzz-fresh-refresh-2-zzz');
    expect([...recorded.secrets.values()]).not.toContain(VALUES.builderRefresh);
    expect(recorded.secrets.has('github-refresh-fleetadlc-atlas-janedoe')).toBe(false);
  });

  it('binds each bot to its account, records the sign-in it took over, and renames it to the archived handle', async () => {
    const { recorded, report } = await restoreOnto(archive());

    expect(recorded.logins).toEqual({ builder: 'fleetadlc-atlas-janedoe', 'lead-reviewer': 'fleetadlc-sydney-janedoe' });
    expect(recorded.credentials).toEqual({ builder: 'github-refresh-builder', 'lead-reviewer': 'github-refresh-lead-reviewer' });
    expect(recorded.renamed).toEqual([
      { name: 'builder', to: 'fleetadlc-atlas-janedoe' },
      { name: 'lead-reviewer', to: 'fleetadlc-sydney-janedoe' },
    ]);
    expect(report.renames.every((rename) => rename.state === 'renamed')).toBe(true);
    expect(report.signIns.filter((line) => line.provider === 'github').map((line) => line.state)).toEqual(['taken-over', 'taken-over']);
  });

  it('gives each bot its model assignment back, on the account it had', async () => {
    const { recorded, plan } = await restoreOnto(archive());

    expect(recorded.assignments.builder).toEqual({ engine: 'claude', model: 'newest:opus', modelAccountId: CLAUDE_SEAT });
    expect(recorded.assignments['lead-reviewer']).toEqual({ engine: 'codex', model: 'gpt-5-codex', modelAccountId: CODEX_SEAT });
    // The automation seat thinks with no model on both installs; there is nothing to give it.
    expect(plan.bots.assign.map((bot) => bot.name)).not.toContain('automation');
  });

  it('adds the repository with its owner found by seat, and the model accounts before the bots that use them', async () => {
    const { recorded } = await restoreOnto(archive());

    expect(recorded.repositories).toEqual([{ name: 'fleetadlc-testbed', owner: 'builder' }]);
    expect(recorded.accounts.map((account) => account.id)).toEqual([KEY_ACCOUNT, CLAUDE_SEAT, CODEX_SEAT]);
    expect(recorded.secrets.get(`model-account-${CLAUDE_SEAT}`)).toBe(VALUES.seatToken);
  });

  it('keeps an account’s last check only when the credential it checked came back with it, and records the take-over’s', async () => {
    const withFolder = await restoreOnto(archive());
    // The folder is not written with the rows; it is checked by using it, and
    // that check is the one kept.
    expect(withFolder.recorded.accounts.find((account) => account.id === CODEX_SEAT)?.keepCheck).toBe(false);
    expect(withFolder.recorded.order).toContain(`check ${CODEX_SEAT}`);
    expect(withFolder.recorded.accounts.find((account) => account.id === CLAUDE_SEAT)?.keepCheck).toBe(true);

    const withoutFolder = await restoreOnto(archive({ ...EVERYTHING, accountSignIns: false }));
    expect(withoutFolder.recorded.accounts.find((account) => account.id === CODEX_SEAT)?.keepCheck).toBe(false);
    expect(withoutFolder.recorded.order).not.toContain(`check ${CODEX_SEAT}`);
  });

  it('checks a subscription’s sign-in folder by using a copy of it, through hostd, after the rows', async () => {
    const { takeOver, report, recorded } = await restoreOnto(archive());

    expect(takeOver.adopted[CODEX_SEAT]).toEqual(CODEX_LOGIN);
    expect(report.signIns.find((line) => line.accountId === CODEX_SEAT)?.state).toBe('taken-over');
    // After the rows it depends on.
    expect(recorded.order.indexOf(`check ${CODEX_SEAT}`)).toBeGreaterThan(recorded.order.indexOf('login builder=fleetadlc-atlas-janedoe'));
  });

  it('adds the history of the seats it has, and says what it left out', async () => {
    const { recorded, plan } = await restoreOnto(archive());

    expect(recorded.history).toHaveLength(1);
    expect(plan.history).toMatchObject({ threads: 1, messages: 1, audit: 1, ledger: 1, requests: 1, skipped: 2 });
  });

  it('counts a queued request among those it restores, and one in a state it does not take as skipped', async () => {
    // The plan counted every archived request while the restore dropped the
    // queued ones, so the summary and the audit entry said more than was written.
    const contents = archive();
    const first = contents.history!.requests[0]!;
    contents.history!.requests = [
      first,
      { ...first, id: 'cccccccc-0000-4000-8000-000000000002', state: 'queued' },
      { ...first, id: 'cccccccc-0000-4000-8000-000000000003', state: 'shelved' },
    ];
    const { recorded, plan, report } = await restoreOnto(contents);

    expect(plan.history).toMatchObject({ requests: 2, skipped: 3 });
    expect(recorded.history[0]?.requests.map((one) => one.state)).toEqual(['filed', 'queued', 'shelved']);
    expect(report.outcome.history?.requests).toBe(plan.history?.requests);
  });

  it('audits the restore by name, never by value', async () => {
    const { recorded } = await restoreOnto(archive());

    const line = recorded.audit.find((entry) => entry.action === 'install.restored');
    expect(line?.payload.bots).toEqual(['builder', 'lead-reviewer', 'automation']);
    const said = JSON.stringify(line);
    for (const value of Object.values(VALUES)) expect(said).not.toContain(value);
  });
});

describe('a restore without the GitHub sign-ins', () => {
  const contents = () => archive({ ...EVERYTHING, botSignIns: false });

  it('binds each seat to its account but leaves it at its seat, to be connected', async () => {
    const { recorded, plan } = await restoreOnto(contents());

    expect(recorded.logins).toEqual({ builder: 'fleetadlc-atlas-janedoe', 'lead-reviewer': 'fleetadlc-sydney-janedoe' });
    expect(recorded.credentials).toEqual({});
    expect(recorded.renamed).toEqual([]);
    expect(recorded.secrets.get('ssh-signing-builder')).toBe(VALUES.builderSigning);
    expect(plan.bots.deviceFlow).toEqual([
      { name: 'builder', login: 'fleetadlc-atlas-janedoe' },
      { name: 'lead-reviewer', login: 'fleetadlc-sydney-janedoe' },
    ]);
  });

  it('says what is left to do: connect those bots', () => {
    const plan = planRestore(contents(), cleanShape());
    const summary = summarizeRestore(contents(), plan, cleanShape().bots);

    expect(summary.next[0]).toMatch(/^Connect 2 bots to GitHub — fleetadlc-atlas-janedoe, fleetadlc-sydney-janedoe — because their sign-ins were not in the backup/);
    expect(summary.bots.find((bot) => bot.seat === 'builder')).toMatchObject({ needsConnecting: true, becomes: null, signIn: false });
  });
});

describe('a bot already on the archive’s account, written in other capitals', () => {
  it('is unchanged, and its credential record is kept', async () => {
    // GitHub logins are one account whatever their case; `replace` deleted the
    // bot's credential row over a capital letter.
    const contents = archive({ ...EVERYTHING, botSignIns: false });
    const shape = cleanShape();
    shape.bots = shape.bots.map((bot) => (bot.slot === 'builder' ? { ...bot, githubLogin: 'FleetADLC-Atlas-Janedoe' } : bot));
    const plan = planRestore(contents, shape);

    expect(plan.bots.unchanged).toContain('builder');
    expect(plan.bots.replace).toEqual([]);

    const { target, recorded } = fakeTarget();
    await applyRestore(contents, plan, target, { actor: 'alex@example.test' });
    expect(recorded.order).not.toContain('forget credential builder');
  });
});

describe('an archive written before a backup could be chosen', () => {
  /** What `fleetadlc backup` wrote then: version 1, persona names, and once in a while a refresh token. */
  const old: BackupContents = {
    manifest: { version: 1, createdAt: '2026-06-01T00:00:00.000Z', counts: { secrets: 4, settings: 2, bots: 2 } },
    secrets: {
      'github-app-private-key': VALUES.appKey,
      'ssh-signing-atlas': VALUES.builderSigning,
      'github-refresh-atlas': VALUES.builderRefresh,
      'internal-api-secret': VALUES.internal,
    },
    settings: { organization: 'janedoe', githubClientId: VALUES.clientId },
    bots: [
      { name: 'atlas', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: 'claude-opus-4' },
      { name: 'sydney', githubLogin: 'fleetadlc-sydney-janedoe', engine: 'codex', model: null },
    ],
  };

  it('still restores: settings, the App key, the signing keys by seat and each seat’s account', async () => {
    const { recorded, plan } = await restoreOnto(old);

    expect(recorded.settings).toEqual({ organization: 'janedoe', githubClientId: VALUES.clientId });
    expect(recorded.secrets.get('github-app-private-key')).toBe(VALUES.appKey);
    expect(recorded.secrets.get('ssh-signing-builder')).toBe(VALUES.builderSigning);
    expect(recorded.logins).toEqual({ builder: 'fleetadlc-atlas-janedoe', 'lead-reviewer': 'fleetadlc-sydney-janedoe' });
    // Nothing an old archive never promised: no assignment, no sign-in.
    expect(recorded.assignments).toEqual({});
    expect(recorded.renamed).toEqual([]);
    expect(plan.bots.deviceFlow.map((bot) => bot.name)).toEqual(['builder', 'lead-reviewer']);
  });

  it('does not write back a refresh token it happened to carry, nor the internal API secret, and says why', async () => {
    const { recorded, plan, report, takeOver } = await restoreOnto(old, { existing: { 'internal-api-secret': 'zzz-this-install-internal-zzz' } });

    // Blocked before it was planned: never written, never even used.
    expect(report.signIns.find((line) => line.key === 'bot:builder')).toMatchObject({
      kind: 'github-refresh',
      state: 'blocked',
      reason: 'it is from a backup made before sign-ins could be chosen, and the old install has replaced it since',
    });
    expect(takeOver.refreshed).toEqual([]);
    expect(plan.secrets.skipped).toEqual(['internal-api-secret']);
    expect(recorded.secrets.has('github-refresh-builder')).toBe(false);
    expect(recorded.secrets.get('internal-api-secret')).toBe('zzz-this-install-internal-zzz');
    expect(recorded.order).not.toContain('secret internal-api-secret');
    expect(report.summary.next).toContain(
      'Connect fleetadlc-atlas-janedoe to GitHub again: it is from a backup made before sign-ins could be chosen, and the old install has replaced it since.',
    );
  });

  it('is planned on its own as it always was, naming the refresh token as stale', () => {
    expect(planRestore(old, cleanShape()).secrets.stale).toEqual(['github-refresh-atlas']);
  });
});

describe('an assignment nobody chose', () => {
  it('is not restored: it came from config/bots.yaml, which this install reads for itself', () => {
    const found = sourceInstall();
    found.bots = found.bots.map((bot) => (bot.slot === 'builder' ? { ...bot, modelAccountId: null, modelSetAt: null } : bot));
    const plan = planRestore(buildBackup(found, EVERYTHING, NOW).contents, cleanShape());

    expect(plan.bots.assign.map((bot) => bot.name)).toEqual(['lead-reviewer']);
    expect(plan.bots.keep).toEqual([]);
  });
});

describe('an assignment to an engine this install does not know', () => {
  it('is left as this install has it, rather than failing the restore on the row', () => {
    const contents = archive();
    contents.bots = contents.bots.map((bot) => (bot.slot === 'builder' ? { ...bot, engine: 'hal' } : bot));
    const plan = planRestore(contents, cleanShape());

    expect(plan.bots.keep).toEqual([{ name: 'builder', reason: 'this version of OpenADLC does not know the engine hal' }]);
    expect(plan.bots.assign.map((bot) => bot.name)).toEqual(['lead-reviewer']);
  });
});

describe('an assignment whose account is not in the backup', () => {
  it('is left as this install has it, and said', () => {
    const contents = archive({ ...EVERYTHING, accounts: [KEY_ACCOUNT] });
    const plan = planRestore(contents, cleanShape());

    expect(plan.bots.assign.map((bot) => bot.name)).toEqual([]);
    expect(plan.bots.keep).toEqual([
      { name: 'builder', reason: 'its model account is not in the backup' },
      { name: 'lead-reviewer', reason: 'its model account is not in the backup' },
    ]);
  });
});

describe('a restore that fails part way', () => {
  it('leaves no row written, every secret as it was and no sign-in used, when a secret cannot be written', async () => {
    const contents = archive();
    const shape = cleanShape();
    const { target, recorded } = fakeTarget({ failSecret: 'ssh-signing-lead-reviewer' });
    const takeOver = fakeTakeOver({ logins: REFRESH_LOGINS });
    const signIns = await judgeSignIns({
      contents,
      shape,
      facts: NOTHING_HELD,
      checks: fakeChecks().checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });

    await expect(
      runRestore({ contents, shape, signIns, choices: defaultSignInChoices(signIns, 'clean'), target, takeOver: takeOver.ports, actor: 'alex@example.test' }),
    ).rejects.toThrow(/refused/);

    expect(recorded.settings).toEqual({});
    expect(recorded.logins).toEqual({});
    expect(recorded.accounts).toEqual([]);
    expect([...recorded.secrets.keys()]).toEqual(['internal-api-secret']);
    // Nothing was written, so nothing was taken over: the archive's sign-ins are still good.
    expect(takeOver.refreshed).toEqual([]);
    expect(takeOver.adopted).toEqual({});
  });

  it('keeps the rest when a subscription’s CLI refuses its sign-in, stores nothing for it, and forgets that account’s check', async () => {
    const { report, recorded, takeOver } = await restoreOnto(archive(), { refuseLogin: [CODEX_SEAT] });

    expect(report.signIns.find((line) => line.accountId === CODEX_SEAT)).toMatchObject({
      state: 'refused',
      reason: 'it was not accepted: unexpected status 401 Unauthorized',
    });
    expect(takeOver.adopted).toEqual({});
    expect(recorded.order).toContain(`forget ${CODEX_SEAT}`);
    expect(recorded.settings.organization).toBe('janedoe');
    expect(report.summary.next).toContain(
      'Sign in to ChatGPT Pro again on the “Foundation model accounts / API keys” step: it was not accepted: unexpected status 401 Unauthorized.',
    );
  });
});

describe('a bot’s own engine key the provider refuses', () => {
  it('is not written, and the summary says to give the bot a model account, with the reason', async () => {
    const built = archive();
    const contents = { ...built, secrets: { ...built.secrets, 'engine-key-fleetadlc-atlas-janedoe': 'sk-ant-api-zzz-revoked-zzz' } };

    const { report, recorded } = await restoreOnto(contents, { refuse: ['sk-ant-api-zzz-revoked-zzz'] });

    expect(recorded.secrets.has('engine-key-builder')).toBe(false);
    expect(report.signIns.find((line) => line.key === 'engine:builder')).toMatchObject({ kind: 'engine-key', state: 'blocked' });
    expect(report.summary.next).toContain(
      'Give builder a model account on the “Foundation model accounts / API keys” step: its own engine key was not restored, because Anthropic did not accept it: invalid x-api-key.',
    );
  });
});

describe('what an archive holds, as a page shows it', () => {
  it('is by group and name, and carries no value', () => {
    const summary = summarizeArchive(archive());

    expect(summary.install.app).toEqual(['private key', 'client id', 'webhook secret']);
    expect(summary.repositories).toEqual(['janedoe/fleetadlc-testbed']);
    expect(summary.bots[0]).toMatchObject({ seat: 'builder', login: 'fleetadlc-atlas-janedoe', signingKey: true, signIn: true });
    expect(summary.accounts.map((account) => account.credential)).toEqual(['key', 'token', 'sign-in']);
    expect(summary.history).toMatchObject({ threads: 2 });
    const said = JSON.stringify(summary);
    for (const value of Object.values(VALUES)) expect(said).not.toContain(value);
  });
});

describe('the repositories a restore would write', () => {
  const testbed = (fullName: string, name = 'fleetadlc-testbed') => ({ name, fullName });

  it('are matched by full name, and said by full name', () => {
    const shape = { ...cleanShape(), repositories: ['fleetadlc-testbed'], repositoryNames: [testbed('janedoe/fleetadlc-testbed')] };
    const plan = planRestore(archive(), shape);

    expect(plan.repositories).toMatchObject({ overwrite: ['janedoe/fleetadlc-testbed'], create: [] });
    expect(describePlan(plan).join('\n')).toContain('repositories this would overwrite (1):\n  janedoe/fleetadlc-testbed');
  });

  it('count one removed here as added again, not overwritten', () => {
    const shape = { ...cleanShape(), repositoryNames: [{ ...testbed('janedoe/fleetadlc-testbed'), removed: true }] };
    expect(planRestore(archive(), shape).repositories).toMatchObject({ overwrite: [], create: ['janedoe/fleetadlc-testbed'] });
  });

  it('refuse one whose name another repository here has, rather than calling it an overwrite', () => {
    // `fleetadlc restore` listed it as "repositories this would overwrite:
    // fleetadlc-testbed" and then wrote it over acme's row.
    const shape = { ...cleanShape(), repositories: ['fleetadlc-testbed'], repositoryNames: [testbed('acme/fleetadlc-testbed')] };
    expect(() => planRestore(archive(), shape)).toThrow(BackupError);
    expect(() => planRestore(archive(), shape)).toThrow(
      'this install already has a repository called fleetadlc-testbed (acme/fleetadlc-testbed), and OpenADLC names each repository by its name alone, so janedoe/fleetadlc-testbed cannot be restored beside it',
    );
  });
});

describe('the spending caps a restore would set', () => {
  const contents = (): BackupContents => ({
    ...archive(),
    spendingLimits: [
      { scope: 'global', kind: 'month_total', amountUsd: 5000 },
      { scope: 'repo', repository: 'janedoe/fleetadlc-testbed', kind: 'month_total', amountUsd: 40 },
    ],
  });

  it('are listed by `fleetadlc restore` before it asks, and counted as changes', () => {
    const plan = planRestore(contents(), cleanShape());

    expect(plan.spendingLimits).toEqual(['all repositories, a month: $5000', 'janedoe/fleetadlc-testbed, a month: $40']);
    expect(describePlan(plan).join('\n')).toContain(
      'spending caps this would set (2):\n  all repositories, a month: $5000\n  janedoe/fleetadlc-testbed, a month: $40',
    );
    expect(changeCount(plan)).toBe(changeCount(planRestore(archive(), cleanShape())) + 2);
  });

  it('replace the table onto a clean install, and are merged only when asked', async () => {
    const replaced = fakeTarget();
    await applyRestore(contents(), planRestore(contents(), cleanShape()), replaced.target);
    expect(replaced.recorded.spendingLimits).toEqual(contents().spendingLimits);

    const merged = fakeTarget();
    merged.recorded.spendingLimits = [{ scope: 'global', kind: 'task', amountUsd: 10 }];
    await applyRestore(contents(), planRestore(contents(), cleanShape()), merged.target, { actor: 'alex@example.test', spending: 'merge' });
    expect(merged.recorded.spendingLimits).toEqual([{ scope: 'global', kind: 'task', amountUsd: 10 }, ...(contents().spendingLimits ?? [])]);
  });
});

describe('a clean install', () => {
  it('is one with no App, no repository, no connected bot and no model account', () => {
    expect(cleanliness({ appConfigured: false, repositories: [], connectedBots: [], modelAccounts: [] })).toEqual({
      clean: true,
      setUp: [],
    });
  });

  it('is not one with any of those, and says which', () => {
    const facts = cleanliness({
      appConfigured: true,
      repositories: ['janedoe/fleetadlc-testbed'],
      connectedBots: ['fleetadlc-atlas-janedoe'],
      modelAccounts: ['Claude Max'],
    });

    expect(facts.clean).toBe(false);
    expect(facts.setUp).toEqual([
      'the GitHub App',
      'the repository janedoe/fleetadlc-testbed',
      'fleetadlc-atlas-janedoe, connected to GitHub',
      'the model account Claude Max',
    ]);
    // Several of a kind are counted, so the sentence stays one a person reads.
    expect(
      cleanliness({ appConfigured: false, repositories: [], connectedBots: ['a', 'b', 'c'], modelAccounts: ['x', 'y'] }).setUp,
    ).toEqual(['3 bots connected to GitHub', '2 model accounts']);
    expect(NOT_CLEAN).toBe('This install is already set up: restore into it from Settings → Backup, which compares the backup with this install first.');
  });
});

describe('how each bot looks, in a backup and a restore', () => {
  /** The source install with the builder given a color and its initials. */
  function styled(): BackupContents {
    const install = sourceInstall();
    install.bots = install.bots.map((bot) => (bot.slot === 'builder' ? { ...bot, color: 'rose', avatar: 'initials' } : bot));
    return buildBackup(install, { ...EVERYTHING, history: true }, NOW).contents;
  }

  it('keeps the color and avatar a person chose, through the file and back', () => {
    const contents = readPlain(writePlain(styled()));
    const builder = contents.bots.find((bot) => bot.slot === 'builder');
    expect([builder?.color, builder?.avatar]).toEqual(['rose', 'initials']);
  });

  it('gives each bot its color and avatar back', async () => {
    const { recorded, plan } = await restoreOnto(styled());
    expect(recorded.looks).toEqual({ builder: { color: 'rose', avatar: 'initials' } });
    expect(plan.bots.looks?.map((bot) => bot.name)).toEqual(['builder']);
  });

  it('leaves the look alone from an archive written before there was one to keep', async () => {
    const contents = archive();
    for (const bot of contents.bots) {
      delete bot.color;
      delete bot.avatar;
    }
    const { recorded } = await restoreOnto(contents);
    expect(recorded.looks).toEqual({});
  });

  it('restores a name this version does not draw as the default, not as a name drawn as nothing', async () => {
    const contents = styled();
    const builder = contents.bots.find((bot) => bot.slot === 'builder')!;
    builder.color = 'chartreuse';
    builder.avatar = 'sparkles';
    const { recorded } = await restoreOnto(contents);
    expect(recorded.looks).toEqual({});
  });
});

describe('a history backup restored into the install it came from', () => {
  it('restoring a history backup into its own install adds nothing', async () => {
    // The archive keeps each audit line's and cost's time to the millisecond;
    // the install holds microseconds. Matched exactly, nothing was "already
    // here": every line and cost was written a second time, and the month's
    // spend doubled.
    const install = memoryInstall({
      bots: [
        { name: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: null, engine: 'claude', model: 'newest:sonnet', modelAccountId: null, modelSetAt: null },
      ],
      history: HISTORY,
    });
    const contents = buildBackup(install.view(), { ...EVERYTHING, history: true }, NOW).contents;
    const history = contents.history!;
    expect(history.audit).toHaveLength(1);
    expect(history.ledger).toHaveLength(1);
    expect(install.state().history.audit[0]?.at).not.toBe(history.audit[0]?.at);

    const comparison = compareInstall({ contents, here: install.view(), signIns: [], historyHere: install.historyHere(history) });
    expect(itemsOf(comparison).find((one) => one.key === 'history')?.state).toBe('same');

    const added = await install.target.transaction((db) => db.putHistory(history));
    expect(added).toMatchObject({ audit: 0, ledger: 0 });
    expect(install.state().history.audit).toHaveLength(1);
    expect(install.state().history.ledger).toHaveLength(1);
  });
});
