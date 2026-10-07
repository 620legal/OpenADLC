import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, type BackupContents } from './archive.js';
import { chosenArchive, compareInstall } from './compare.js';
import { ATTRIBUTION_KEY_REF, SIGN_INS_NOT_CHOSEN, buildBackup, classifySecret, mergedAttributionKeys, type InstallSnapshot } from './contents.js';
import type { InstallShape } from './plan.js';
import { runRestore } from './restore.js';
import { EVERYTHING, type BackupSelection } from './selection.js';
import { NOTHING_HELD, defaultSignInChoices, judgeSignIns, type SignInChoices } from './signins.js';
import { describeContents, summarizeArchive } from './summary.js';
import {
  REFRESH_LOGINS,
  VALUES,
  cleanShape,
  fakeChecks,
  fakeTakeOver,
  fakeTarget,
  memoryInstall,
  sourceInstall,
  type MemoryBot,
} from './test-fixtures.js';

/**
 * A crew on one GitHub account: five seats share `irisexampleco`, whose one
 * sign-in is filed under the account's name — no seat's — and the lead
 * reviewer is on an account of its own. A backup has to carry that sign-in
 * once, with which seats share it; a restore has to put the seats back on
 * the one account, file its sign-in where the bridge looks for it, and take
 * it over by using it once: a refresh token rotates on every use, so a
 * second refresh — for the next seat — would be refused, and the seats would
 * lock each other out.
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');
const CREW = 'irisexampleco';
const CREW_REFRESH = 'ghr_zzz-crew-refresh-zzz';
const SHARED_SEATS = ['builder', 'intake', 'qa', 'docs', 'triage'];
const KEYRING = JSON.stringify({ current: { kid: 'k-old', secret: 'zzz-attribution-old-zzz' }, retired: [] });

const LOGINS: Record<string, string> = { ...REFRESH_LOGINS, [CREW_REFRESH]: CREW };

function crewCredential(index: number) {
  return {
    githubLogin: CREW,
    githubUserId: 300,
    scopes: [],
    tokenExpiresAt: '2026-09-26T18:00:00.000Z',
    refreshExpiresAt: '2027-03-01T00:00:00.000Z',
    signingKeyId: 8000 + index,
    authorizedAt: '2026-09-20T11:00:00.000Z',
    status: 'active' as const,
  };
}

/** Six seats: five sharing `irisexampleco`, filed under its name; the lead reviewer on its own. */
function sharedInstall(): InstallSnapshot {
  const seatBots = SHARED_SEATS.map((seat) => ({
    name: seat,
    slot: seat,
    githubLogin: CREW,
    engine: 'claude',
    model: 'newest:opus',
    modelAccountId: null,
    modelSetAt: null,
    identity: CREW,
  }));
  return {
    secrets: {
      'github-app-private-key': VALUES.appKey,
      'internal-api-secret': VALUES.internal,
      [ATTRIBUTION_KEY_REF]: KEYRING,
      [`github-refresh-${CREW}`]: CREW_REFRESH,
      'github-refresh-fleetadlc-sydney-janedoe': VALUES.reviewerRefresh,
      'ssh-signing-fleetadlc-sydney-janedoe': VALUES.reviewerSigning,
      ...Object.fromEntries(SHARED_SEATS.map((seat) => [`ssh-signing-${seat}`, `zzz-${seat}-signing-zzz`])),
    },
    settings: { organization: 'janedoe', githubClientId: VALUES.clientId, webhookSecret: VALUES.hook },
    bots: [
      ...seatBots,
      {
        name: 'fleetadlc-sydney-janedoe',
        slot: 'lead-reviewer',
        githubLogin: 'fleetadlc-sydney-janedoe',
        engine: 'codex',
        model: 'gpt-5-codex',
        modelAccountId: null,
        modelSetAt: null,
        identity: 'fleetadlc-sydney-janedoe',
      },
    ],
    identities: [
      { login: CREW, githubUserId: 300, secretNs: CREW },
      { login: 'fleetadlc-sydney-janedoe', githubUserId: 102, secretNs: 'fleetadlc-sydney-janedoe' },
    ],
    credentials: {
      ...Object.fromEntries(SHARED_SEATS.map((seat, index) => [seat, crewCredential(index)])),
      'fleetadlc-sydney-janedoe': {
        githubLogin: 'fleetadlc-sydney-janedoe',
        githubUserId: 102,
        scopes: [],
        tokenExpiresAt: null,
        refreshExpiresAt: '2027-03-01T00:00:00.000Z',
        signingKeyId: 9002,
        authorizedAt: '2026-09-01T11:00:00.000Z',
        status: 'active',
      },
    },
    repositories: [],
    accounts: [],
    logins: {},
    history: null,
  };
}

/** A clean install with the same six seats, each seeded under its seat's name. */
function cleanSixSeats(): InstallShape {
  return {
    secretRefs: ['internal-api-secret'],
    settingKeys: [],
    bots: [...SHARED_SEATS, 'lead-reviewer'].map((seat) => ({ name: seat, slot: seat, githubLogin: null, engine: 'claude' })),
    repositories: [],
    accounts: [],
    logins: [],
  };
}

function backup(selection: BackupSelection = EVERYTHING) {
  return buildBackup(sharedInstall(), selection, NOW);
}

async function restoreOnto(
  contents: BackupContents,
  shape: InstallShape,
  options: { refuseRefresh?: string[]; choices?: (defaults: SignInChoices) => SignInChoices } = {},
) {
  const clientId = contents.settings.githubClientId ?? null;
  const signIns = await judgeSignIns({
    contents,
    shape,
    facts: NOTHING_HELD,
    checks: fakeChecks().checks,
    now: NOW,
    clientId: { after: clientId, archive: clientId },
  });
  const defaults = defaultSignInChoices(signIns, 'clean');
  const { target, recorded } = fakeTarget();
  const takeOver = fakeTakeOver({ refuse: options.refuseRefresh ?? [], logins: LOGINS });
  const report = await runRestore({
    contents,
    shape,
    signIns,
    choices: options.choices ? options.choices(defaults) : defaults,
    target,
    takeOver: takeOver.ports,
    actor: 'alex@example.test',
  });
  return { report, recorded, takeOver, signIns };
}

describe('backing up a crew that shares one GitHub account', () => {
  it('carries the account’s one sign-in, filed under the account’s name, and which seats share it', () => {
    const { contents, leftOut } = backup();

    expect(contents.manifest.version).toBe(3);
    expect(contents.secrets[`github-refresh-${CREW}`]).toBe(CREW_REFRESH);
    // No copy per seat: there is one token, and it is the account's.
    expect(Object.keys(contents.secrets).filter((ref) => ref.startsWith('github-refresh-'))).toEqual([
      'github-refresh-fleetadlc-sydney-janedoe',
      `github-refresh-${CREW}`,
    ]);
    expect(leftOut.map((entry) => entry.ref)).toEqual(['internal-api-secret']);
    expect(contents.identities).toEqual([
      { login: CREW, githubUserId: 300, secretNs: CREW, seats: SHARED_SEATS },
      { login: 'fleetadlc-sydney-janedoe', githubUserId: 102, secretNs: 'fleetadlc-sydney-janedoe', seats: ['lead-reviewer'] },
    ]);
    // Each seat keeps its own record and its own signing key.
    expect(contents.bots.map((bot) => bot.credential?.signingKeyId)).toEqual([8000, 8001, 8002, 8003, 8004, 9002]);
    expect(contents.secrets['ssh-signing-qa']).toBe('zzz-qa-signing-zzz');
  });

  it('sorts a sign-in filed under an account’s name as that account’s seats’, not as belonging to no bot', () => {
    const holders = [{ ns: CREW, bots: SHARED_SEATS }];
    expect(classifySecret(`github-refresh-${CREW}`, [...SHARED_SEATS, 'fleetadlc-sydney-janedoe'], holders)).toEqual({
      group: 'sign-in',
      ns: CREW,
      bots: SHARED_SEATS,
    });
    // Without the accounts, as before they could be shared, it is nobody's.
    expect(classifySecret(`github-refresh-${CREW}`, SHARED_SEATS).group).toBe('never');
  });

  it('carries the shared sign-in with any one of its seats, and leaves it out when the sign-ins are not chosen', async () => {
    const one = backup({ ...EVERYTHING, bots: ['qa'], botSignIns: true }).contents;
    expect(one.secrets[`github-refresh-${CREW}`]).toBe(CREW_REFRESH);
    expect(one.identities).toEqual([{ login: CREW, githubUserId: 300, secretNs: CREW, seats: ['qa'] }]);

    const without = backup({ ...EVERYTHING, botSignIns: false });
    expect(without.contents.secrets[`github-refresh-${CREW}`]).toBeUndefined();
    expect(without.leftOut).toContainEqual({ ref: `github-refresh-${CREW}`, reason: SIGN_INS_NOT_CHOSEN });
    // Which seats share it is the crew's shape, not a secret: it comes anyway.
    expect(without.contents.identities?.[0]?.seats).toEqual(SHARED_SEATS);
  });

  it('says it as one line per account, never a value', () => {
    const { contents } = backup();
    const said = describeContents(contents).join('\n');
    expect(said).toContain('2 GitHub accounts:');
    expect(said).toContain(`${CREW}, for builder, intake, qa, docs and triage, with its sign-in`);
    expect(said).not.toContain(CREW_REFRESH);

    const summary = summarizeArchive(contents);
    expect(summary.githubAccounts).toEqual([
      { login: CREW, seats: SHARED_SEATS, signIn: true },
      { login: 'fleetadlc-sydney-janedoe', seats: ['lead-reviewer'], signIn: true },
    ]);
    expect(summary.bots.every((bot) => bot.signIn)).toBe(true);
  });

  it('keeps the accounts through sealing and opening', async () => {
    const { contents } = backup();
    const opened = await decryptBackup(await encryptBackup(contents, 'correct horse'), 'correct horse');
    expect(opened.manifest.counts.identities).toBe(2);
    expect(opened.identities).toEqual(contents.identities);
  });

  it('carries the key the crew’s posts are signed with, with the install', () => {
    expect(backup().contents.secrets[ATTRIBUTION_KEY_REF]).toBe(KEYRING);
    const noInstall = backup({ ...EVERYTHING, install: false });
    expect(noInstall.contents.secrets[ATTRIBUTION_KEY_REF]).toBeUndefined();
    expect(noInstall.leftOut).toContainEqual({ ref: ATTRIBUTION_KEY_REF, reason: 'the install was not chosen' });
  });
});

describe('restoring a crew on one account into a clean install', () => {
  it('judges the account’s sign-in once, as one line for its five seats', async () => {
    const { signIns } = await restoreOnto(backup().contents, cleanSixSeats());
    const github = signIns.filter((one) => one.provider === 'github');
    expect(github.map((one) => [one.key, one.who, one.seats])).toEqual([
      [`github:${CREW}`, CREW, SHARED_SEATS],
      ['bot:lead-reviewer', 'fleetadlc-sydney-janedoe', ['lead-reviewer']],
    ]);
    expect(github[0]?.seat).toBeNull();
  });

  it('takes the shared sign-in over with one refresh, filed under the account’s name for every seat', async () => {
    const { recorded, takeOver, report } = await restoreOnto(backup().contents, cleanSixSeats());

    // Once for the five of them, once for the reviewer.
    expect(takeOver.refreshed).toEqual([CREW_REFRESH, VALUES.reviewerRefresh]);
    expect(recorded.secrets.get(`github-refresh-${CREW}`)).toBe('ghr_zzz-fresh-refresh-1-zzz');
    expect(recorded.secrets.get('github-refresh-lead-reviewer')).toBe('ghr_zzz-fresh-refresh-2-zzz');
    for (const seat of SHARED_SEATS) expect(recorded.secrets.has(`github-refresh-${seat}`)).toBe(false);
    expect([...recorded.secrets.values()]).not.toContain(CREW_REFRESH);

    expect(recorded.credentials).toEqual({
      ...Object.fromEntries(SHARED_SEATS.map((seat) => [seat, `github-refresh-${CREW}`])),
      'lead-reviewer': 'github-refresh-lead-reviewer',
    });
    expect(recorded.identities).toEqual({
      ...Object.fromEntries(SHARED_SEATS.map((seat) => [seat, { login: CREW, ns: CREW }])),
      'lead-reviewer': { login: 'fleetadlc-sydney-janedoe', ns: 'lead-reviewer' },
    });
    expect(report.signIns.filter((one) => one.provider === 'github').map((one) => one.state)).toEqual(['taken-over', 'taken-over']);
  });

  it('keeps the shared seats under their seats’ names, and names the reviewer for its account', async () => {
    const { recorded, report } = await restoreOnto(backup().contents, cleanSixSeats());
    expect(recorded.renamed).toEqual([{ name: 'lead-reviewer', to: 'fleetadlc-sydney-janedoe' }]);
    const bots = report.summary.bots;
    expect(bots.filter((bot) => SHARED_SEATS.includes(bot.seat)).every((bot) => bot.becomes === null && bot.signIn)).toBe(true);
    expect(bots.find((bot) => bot.seat === 'lead-reviewer')?.becomes).toBe('fleetadlc-sydney-janedoe');
  });

  it('writes the seats onto one account, with the sign-in where the bridge looks for each of them', async () => {
    const install = memoryInstall({
      bots: [...SHARED_SEATS, 'lead-reviewer'].map(
        (seat): MemoryBot => ({ name: seat, slot: seat, githubLogin: null, engine: 'claude', model: 'newest:opus', modelAccountId: null, modelSetAt: null }),
      ),
    });
    const contents = backup().contents;
    const shape = install.shape();
    const signIns = await judgeSignIns({
      contents,
      shape,
      facts: install.facts,
      checks: fakeChecks().checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const takeOver = fakeTakeOver({ logins: LOGINS });
    await runRestore({
      contents,
      shape,
      signIns,
      choices: defaultSignInChoices(signIns, 'clean'),
      target: install.target,
      takeOver: takeOver.ports,
      actor: 'alex@example.test',
    });

    const after = install.state();
    expect(after.identities.map((one) => one.secretNs).sort()).toEqual([CREW, 'lead-reviewer']);
    const shared = install.shape().identities?.find((one) => one.login === CREW);
    expect(shared?.bots.sort()).toEqual([...SHARED_SEATS].sort());
    // What `signInOf` reads for any of them: the identity's name, and a token under it.
    for (const seat of SHARED_SEATS) {
      const bot = after.bots.find((one) => one.slot === seat);
      expect(bot?.identity).toBe(CREW);
      expect(bot?.githubLogin).toBe(CREW);
      expect(after.credentials[seat]?.signingKeyId).toBe(8000 + SHARED_SEATS.indexOf(seat));
    }
    expect(after.secrets[`github-refresh-${CREW}`]).toBe('ghr_zzz-fresh-refresh-1-zzz');
    expect(takeOver.refreshed.filter((token) => token === CREW_REFRESH)).toHaveLength(1);
  });

  it('asks for the shared account to be connected once when GitHub refuses its sign-in', async () => {
    const { report, takeOver } = await restoreOnto(backup().contents, cleanSixSeats(), { refuseRefresh: [CREW_REFRESH] });
    expect(takeOver.refreshed.filter((token) => token === CREW_REFRESH)).toHaveLength(1);
    const again = report.summary.next.filter((line) => line.includes(CREW));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatch(new RegExp(`^Connect ${CREW} to GitHub again: GitHub did not accept it`));
    expect(report.summary.bots.filter((bot) => bot.needsConnecting).map((bot) => bot.seat)).toEqual(SHARED_SEATS);
  });

  it('asks for a shared account left out of the backup as one account to connect', async () => {
    const { report } = await restoreOnto(backup({ ...EVERYTHING, botSignIns: false }).contents, cleanSixSeats());
    expect(report.summary.next[0]).toMatch(
      /^Sign in again to 2 GitHub accounts — irisexampleco, fleetadlc-sydney-janedoe — because their sign-ins were not in the backup/,
    );
  });

  it('puts the archive’s post-signing key first, and keeps one this install had made among those that check', async () => {
    const here = JSON.stringify({ current: { kid: 'k-new', secret: 'zzz-attribution-new-zzz' }, retired: [] });
    const merged = JSON.parse(mergedAttributionKeys(KEYRING, here, NOW)) as { current: { kid: string }; retired: { kid: string; retiredAt: string }[] };
    expect(merged.current.kid).toBe('k-old');
    expect(merged.retired).toEqual([{ kid: 'k-new', secret: 'zzz-attribution-new-zzz', retiredAt: NOW.toISOString() }]);

    const { recorded } = await restoreOnto(backup().contents, cleanSixSeats());
    expect(recorded.secrets.get(ATTRIBUTION_KEY_REF)).toBe(KEYRING);
  });
});

describe('restoring a crew on one account into an install that is set up', () => {
  it('takes the shared sign-in over once, when it is asked for', async () => {
    const install = memoryInstall({
      settings: { organization: 'janedoe', githubClientId: VALUES.clientId },
      bots: [...SHARED_SEATS, 'lead-reviewer'].map(
        (seat): MemoryBot => ({ name: seat, slot: seat, githubLogin: null, engine: 'claude', model: 'newest:opus', modelAccountId: null, modelSetAt: null }),
      ),
    });
    const contents = backup().contents;
    const shape = install.shape();
    const signIns = await judgeSignIns({
      contents,
      shape,
      facts: install.facts,
      checks: fakeChecks().checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const comparison = compareInstall({ contents, here: install.view(), signIns });
    const item = comparison.groups.flatMap((group) => group.items).find((one) => one.key === `signin:github:${CREW}`);
    expect(item?.label).toBe(`${CREW}, shared by Builder, Intake, QA, Docs and Triage`);
    expect(item?.seats).toEqual(SHARED_SEATS);
    // Rotating, so not ticked until someone asks.
    expect(comparison.choices[`signin:github:${CREW}`]).toBe(false);

    const choices = { ...comparison.choices, [`signin:github:${CREW}`]: true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const takeOver = fakeTakeOver({ logins: LOGINS });
    await runRestore({
      contents: chosen.contents,
      shape,
      signIns,
      choices: chosen.signIns,
      target: install.target,
      takeOver: takeOver.ports,
      actor: 'alex@example.test',
    });

    expect(takeOver.refreshed).toEqual([CREW_REFRESH]);
    const after = install.state();
    expect(after.secrets[`github-refresh-${CREW}`]).toBe('ghr_zzz-fresh-refresh-1-zzz');
    expect(after.bots.filter((bot) => bot.identity === CREW).map((bot) => bot.slot)).toEqual(SHARED_SEATS);
  });
});

describe('taking a shared account for some of its seats, while the others keep their own', () => {
  /** An install whose seats are each on an account of their own, filed under their own names. */
  function ownAccounts(seats: readonly string[]) {
    return memoryInstall({
      settings: { organization: 'janedoe', githubClientId: VALUES.clientId },
      bots: [...seats, 'lead-reviewer'].map(
        (seat): MemoryBot => ({
          name: `own-${seat}`,
          slot: seat,
          githubLogin: seat === 'lead-reviewer' ? null : `own-${seat}`,
          engine: 'claude',
          model: 'newest:opus',
          modelAccountId: null,
          modelSetAt: null,
          identity: seat === 'lead-reviewer' ? null : `own-${seat}`,
        }),
      ),
      identities: seats.map((seat, index) => ({ login: `own-${seat}`, githubUserId: 500 + index, secretNs: `own-${seat}` })),
      secrets: {
        'internal-api-secret': VALUES.internal,
        ...Object.fromEntries(seats.map((seat) => [`github-refresh-own-${seat}`, `ghr_zzz-own-${seat}-zzz`])),
      },
      credentials: Object.fromEntries(
        seats.map((seat, index) => [
          `own-${seat}`,
          {
            githubLogin: `own-${seat}`,
            githubUserId: 500 + index,
            scopes: [],
            tokenExpiresAt: null,
            refreshExpiresAt: '2027-03-01T00:00:00.000Z',
            signingKeyId: 600 + index,
            authorizedAt: '2026-09-01T00:00:00.000Z',
            status: 'active' as const,
          },
        ]),
      ),
    });
  }

  async function takeFor(seats: readonly string[], movedSeat: string) {
    const install = ownAccounts(seats);
    const before = install.state();
    const contents = backup({ ...EVERYTHING, bots: [...seats], botSignIns: true }).contents;
    const shape = install.shape();
    const signIns = await judgeSignIns({
      contents,
      shape,
      facts: install.facts,
      checks: fakeChecks().checks,
      now: NOW,
      clientId: { after: VALUES.clientId, archive: VALUES.clientId },
    });
    const comparison = compareInstall({ contents, here: install.view(), signIns });
    const choices = { ...comparison.choices, [`seat:${movedSeat}:account`]: true, [`signin:github:${CREW}`]: true };
    const chosen = chosenArchive({ contents, here: install.view(), comparison, choices });
    const takeOver = fakeTakeOver({ logins: LOGINS });
    const report = await runRestore({
      contents: chosen.contents,
      shape,
      signIns,
      choices: chosen.signIns,
      // The bridge renames a bot once its sign-in is taken over; only asked here.
      target: { ...install.target, rename: async () => ({ state: 'renamed' }) },
      takeOver: takeOver.ports,
      actor: 'alex@example.test',
    });
    return { install, before, report, takeOver };
  }

  it('takes the sign-in over for the seat that moved, with one refresh, and leaves the other four alone', async () => {
    const { install, before, report, takeOver } = await takeFor(SHARED_SEATS, 'builder');

    expect(report.signIns.find((line) => line.key === `github:${CREW}`)).toMatchObject({ state: 'taken-over' });
    expect(takeOver.refreshed).toEqual([CREW_REFRESH]);
    // Only the seat that moved goes by the account's handle now.
    expect(report.renames.map(({ name, to }) => ({ name, to }))).toEqual([{ name: 'own-builder', to: CREW }]);
    const after = install.state();
    const builder = after.bots.find((bot) => bot.slot === 'builder');
    expect(builder?.githubLogin).toBe(CREW);
    expect(after.secrets[`github-refresh-${builder?.identity}`]).toBe('ghr_zzz-fresh-refresh-1-zzz');
    // A record for the seat that moved, pointing at the account; none for the others.
    expect(after.credentials[builder?.name ?? '']).toMatchObject({ githubLogin: CREW, status: 'active' });
    for (const seat of SHARED_SEATS.filter((one) => one !== 'builder')) {
      const bot = after.bots.find((one) => one.slot === seat);
      expect(bot?.githubLogin).toBe(`own-${seat}`);
      expect(after.credentials[bot?.name ?? '']).toEqual(before.credentials[`own-${seat}`]);
      expect(after.secrets[`github-refresh-own-${seat}`]).toBe(`ghr_zzz-own-${seat}-zzz`);
    }
  });

  it('does the same for an account two seats share, one of which keeps its own', async () => {
    const { install, report, takeOver } = await takeFor(['builder', 'qa'], 'builder');

    expect(report.signIns.find((line) => line.key === `github:${CREW}`)).toMatchObject({ state: 'taken-over' });
    expect(takeOver.refreshed).toEqual([CREW_REFRESH]);
    const after = install.state();
    expect(after.bots.find((bot) => bot.slot === 'builder')?.githubLogin).toBe(CREW);
    expect(after.bots.find((bot) => bot.slot === 'qa')?.githubLogin).toBe('own-qa');
    expect(after.credentials['own-qa']?.githubLogin).toBe('own-qa');
    expect(after.secrets['github-refresh-own-qa']).toBe('ghr_zzz-own-qa-zzz');
  });
});

describe('restoring an archive written before accounts could be shared', () => {
  /** What OpenADLC wrote before version 3: no accounts, each bot's sign-in under its own name. */
  function versionTwo(): BackupContents {
    const { identities: _dropped, ...rest } = buildBackup(sourceInstall(), EVERYTHING, NOW).contents;
    return { ...rest, manifest: { ...rest.manifest, version: 2 } };
  }

  it('opens as it was written', async () => {
    const opened = await decryptBackup(await encryptBackup(versionTwo(), 'correct horse'), 'correct horse');
    expect(opened.manifest.version).toBe(2);
    expect(opened.identities).toBeUndefined();
    expect(opened.manifest.counts.identities).toBeUndefined();
  });

  it('reads each bot as an account of its own, and restores it as it always did', async () => {
    const contents = await decryptBackup(await encryptBackup(versionTwo(), 'correct horse'), 'correct horse');
    const { recorded, takeOver, signIns } = await restoreOnto(contents, cleanShape());

    expect(signIns.filter((one) => one.provider === 'github').map((one) => one.key)).toEqual(['bot:builder', 'bot:lead-reviewer']);
    expect(takeOver.refreshed).toEqual([VALUES.builderRefresh, VALUES.reviewerRefresh]);
    expect(recorded.credentials).toEqual({ builder: 'github-refresh-builder', 'lead-reviewer': 'github-refresh-lead-reviewer' });
    // Each on an account filed under its own name here, which moves with it when it takes the handle.
    expect(recorded.identities).toEqual({
      builder: { login: 'fleetadlc-atlas-janedoe', ns: 'builder' },
      'lead-reviewer': { login: 'fleetadlc-sydney-janedoe', ns: 'lead-reviewer' },
    });
    expect(recorded.renamed).toEqual([
      { name: 'builder', to: 'fleetadlc-atlas-janedoe' },
      { name: 'lead-reviewer', to: 'fleetadlc-sydney-janedoe' },
    ]);
  });
});
