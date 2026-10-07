import { describe, expect, it } from 'vitest';
import type { BackupContents } from './archive.js';
import { buildBackup } from './contents.js';
import type { InstallShape } from './plan.js';
import { previewRestore, runRestore } from './restore.js';
import { EVERYTHING } from './selection.js';
import {
  GITHUB_TAKE_OVER,
  NOTHING_HELD,
  defaultSignInChoices,
  judgeSignIns,
  keepOnlySignIns,
  refusedChoice,
  selectSignIns,
  takeOverSignIns,
  type SignIn,
  type SignInFacts,
} from './signins.js';
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
  sourceInstall,
} from './test-fixtures.js';

/**
 * The sign-ins in an archive, judged before anything is written: the same as
 * this install's, working, expired or refused, or only to be checked by using
 * them — and what a restore then does with each. Every provider here is a
 * fake; nothing leaves the process.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');

function archive(): BackupContents {
  return buildBackup(sourceInstall(), EVERYTHING, NOW).contents;
}

/** A bot connected with a token that does not expire, as an app with expiry off leaves one. */
function withStaticToken(contents: BackupContents, token: string): BackupContents {
  const secrets: Record<string, string> = { ...contents.secrets, 'github-token-fleetadlc-atlas-janedoe': token };
  delete secrets['github-refresh-fleetadlc-atlas-janedoe'];
  return { ...contents, secrets };
}

/** What an install that already holds some of these values says about itself. */
function holding(values: Record<string, string>, extra: Partial<SignInFacts> = {}): SignInFacts {
  return { ...NOTHING_HELD, secret: async (ref) => values[ref] ?? null, ...extra };
}

async function judge(
  contents: BackupContents,
  options: {
    facts?: SignInFacts;
    refuse?: string[];
    users?: Record<string, string>;
    shape?: InstallShape;
    clientId?: { after: string | null; archive: string | null };
    now?: Date;
  } = {},
) {
  const { checks, asked } = fakeChecks({ refuse: options.refuse ?? [], users: options.users ?? {} });
  const signIns = await judgeSignIns({
    contents,
    shape: options.shape ?? cleanShape(),
    facts: options.facts ?? NOTHING_HELD,
    checks,
    now: options.now ?? NOW,
    clientId: options.clientId ?? { after: VALUES.clientId, archive: VALUES.clientId },
  });
  const by = (key: string): SignIn => {
    const found = signIns.find((signIn) => signIn.key === key);
    if (!found) throw new Error(`no sign-in ${key}`);
    return found;
  };
  return { signIns, by, asked };
}

describe('every sign-in an archive carries', () => {
  it('is found, bots by seat and accounts by id, with who each signs in as', async () => {
    const { signIns } = await judge(archive());

    expect(signIns.map((signIn) => [signIn.key, signIn.kind, signIn.who])).toEqual([
      ['bot:builder', 'github-refresh', 'fleetadlc-atlas-janedoe'],
      ['bot:lead-reviewer', 'github-refresh', 'fleetadlc-sydney-janedoe'],
      [`account:${KEY_ACCOUNT}`, 'api-key', 'Anthropic API'],
      [`account:${CLAUDE_SEAT}`, 'claude-token', 'Claude Max'],
      [`account:${CODEX_SEAT}`, 'subscription', 'ChatGPT Pro'],
    ]);
    // Which of them are checked by using them.
    expect(signIns.filter((signIn) => signIn.rotates).map((signIn) => signIn.key)).toEqual([
      'bot:builder',
      'bot:lead-reviewer',
      `account:${CODEX_SEAT}`,
    ]);
  });

  it('never carries a value in what it says, whatever the verdict', async () => {
    const refused = await judge(archive(), { refuse: [VALUES.apiKey, VALUES.seatToken] });
    const working = await judge(withStaticToken(archive(), 'ghu_zzz-static-zzz'), {
      users: { 'ghu_zzz-static-zzz': 'fleetadlc-atlas-janedoe' },
    });

    const said = JSON.stringify([refused.signIns, working.signIns]);
    for (const value of [...Object.values(VALUES), 'ghu_zzz-static-zzz']) expect(said).not.toContain(value);
  });
});

describe('the same as this install’s', () => {
  it('is compared by value, for every kind, and needs nothing done', async () => {
    const contents = withStaticToken(archive(), 'ghu_zzz-static-zzz');
    const facts = holding(
      {
        'github-token-builder': 'ghu_zzz-static-zzz',
        'github-refresh-lead-reviewer': VALUES.reviewerRefresh,
        [`model-account-${KEY_ACCOUNT}`]: VALUES.apiKey,
        [`model-account-${CLAUDE_SEAT}`]: VALUES.seatToken,
      },
      { folder: async (id) => (id === CODEX_SEAT ? { 'auth.json': CODEX_LOGIN['auth.json'] as string } : null) },
    );

    const { signIns, asked } = await judge(contents, { facts });

    expect(signIns.map((signIn) => signIn.verdict.state)).toEqual(['same', 'same', 'same', 'same', 'same']);
    // Nothing had to be asked of anybody.
    expect(asked).toEqual([]);
  });

  it('is not a value that merely sits under another name: an archive’s token is compared with the one its seat holds here', async () => {
    const facts = holding({ 'github-refresh-fleetadlc-atlas-janedoe': VALUES.builderRefresh });

    const { by } = await judge(archive(), { facts });

    // This install's builder is called `builder`; nothing it holds is the archive's.
    expect(by('bot:builder').verdict.state).toBe('check-by-use');
  });
});

describe('a sign-in that works', () => {
  it('is an API key the provider lists models for, asked as a key', async () => {
    const { by, asked } = await judge(archive());

    expect(by(`account:${KEY_ACCOUNT}`).verdict).toEqual({ state: 'works', said: 'Anthropic lists 2 models for it' });
    expect(asked).toContainEqual({ what: 'anthropic models', auth: 'key' });
  });

  it('is a Claude subscription’s token Anthropic lists models for, asked with the OAuth header', async () => {
    const { by, asked } = await judge(archive());

    expect(by(`account:${CLAUDE_SEAT}`).verdict.state).toBe('works');
    expect(asked).toContainEqual({ what: 'anthropic models', auth: 'oauth' });
  });

  it('is a non-expiring GitHub token that says it is the account the archive names', async () => {
    const { by } = await judge(withStaticToken(archive(), 'ghu_zzz-static-zzz'), {
      users: { 'ghu_zzz-static-zzz': 'FleetADLC-Atlas-Janedoe' },
    });

    expect(by('bot:builder')).toMatchObject({
      kind: 'github-token',
      rotates: false,
      verdict: { state: 'works', said: 'GitHub says it is FleetADLC-Atlas-Janedoe' },
    });
  });
});

describe('a sign-in that is expired or refused', () => {
  it('is a key or token the provider refuses, in the provider’s words', async () => {
    const { by } = await judge(archive(), { refuse: [VALUES.apiKey, VALUES.seatToken] });

    expect(by(`account:${KEY_ACCOUNT}`).verdict).toEqual({ state: 'blocked', reason: 'Anthropic did not accept it: invalid x-api-key' });
    expect(by(`account:${CLAUDE_SEAT}`).verdict.state).toBe('blocked');
  });

  it('is a GitHub token GitHub refuses, or one that signs in as somebody else', async () => {
    const refused = await judge(withStaticToken(archive(), 'ghu_zzz-static-zzz'), { refuse: ['ghu_zzz-static-zzz'] });
    const someoneElse = await judge(withStaticToken(archive(), 'ghu_zzz-static-zzz'), {
      users: { 'ghu_zzz-static-zzz': 'fleetadlc-mallory' },
    });

    expect(refused.by('bot:builder').verdict).toEqual({ state: 'blocked', reason: 'GitHub did not accept it: Bad credentials (401)' });
    expect(someoneElse.by('bot:builder').verdict).toEqual({
      state: 'blocked',
      reason: 'it signs in as fleetadlc-mallory, not fleetadlc-atlas-janedoe',
    });
  });

  it('is a refresh token whose recorded expiry has passed, without asking GitHub', async () => {
    const { by, asked } = await judge(archive(), { now: new Date('2027-03-02T00:00:00.000Z') });

    expect(by('bot:builder').verdict).toEqual({ state: 'blocked', reason: 'it expired on 1 March 2027' });
    // The reviewer's record has no expiry, so it is still checked by using it.
    expect(by('bot:lead-reviewer').verdict.state).toBe('check-by-use');
    expect(asked.filter((one) => one.what === 'github user')).toEqual([]);
  });

  it('is a refresh token from an archive made before sign-ins were a choice', async () => {
    const contents = archive();
    const old: BackupContents = { ...contents, manifest: { ...contents.manifest, version: 1, includes: undefined } };
    delete (old.manifest as { includes?: unknown }).includes;

    const { by } = await judge(old);

    expect(by('bot:builder').verdict.state).toBe('blocked');
  });

  it('is a GitHub sign-in made through another app than the one this install will refresh with, or with none', async () => {
    const otherApp = await judge(archive(), { clientId: { after: 'Iv1.zzz-this-install-zzz', archive: VALUES.clientId } });
    const noApp = await judge(archive(), { clientId: { after: null, archive: null } });

    expect(otherApp.by('bot:builder').verdict).toEqual({
      state: 'blocked',
      reason: 'it was signed in through a different GitHub App than the one this install uses',
    });
    // Read after "Cannot be restored —", so one clause, and a remedy a person can follow.
    expect(noApp.by('bot:builder').verdict).toEqual({
      state: 'blocked',
      reason: 'this install has no GitHub App client id to refresh it with; include the install’s app in this restore, or connect the bot again afterwards',
    });
  });

  it('is a refresh token this install has used since the backup: the same authorization, and another token for it here', async () => {
    const shape: InstallShape = {
      ...cleanShape(),
      bots: [{ name: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude' }, ...cleanShape().bots.slice(1)],
    };
    const sameAuthorization = holding(
      { 'github-refresh-fleetadlc-atlas-janedoe': 'ghr_zzz-rotated-since-zzz' },
      {
        credential: async (seat) =>
          seat === 'builder' ? { githubLogin: 'fleetadlc-atlas-janedoe', githubUserId: 101, authorizedAt: '2026-09-01T11:00:00.000Z' } : null,
      },
    );
    const anotherAuthorization = holding(
      { 'github-refresh-fleetadlc-atlas-janedoe': 'ghr_zzz-connected-again-zzz' },
      {
        credential: async (seat) =>
          seat === 'builder' ? { githubLogin: 'fleetadlc-atlas-janedoe', githubUserId: 101, authorizedAt: '2026-09-20T09:00:00.000Z' } : null,
      },
    );

    const spent = await judge(archive(), { shape, facts: sameAuthorization });
    const maybe = await judge(archive(), { shape, facts: anotherAuthorization });

    expect(spent.by('bot:builder').verdict).toEqual({
      state: 'blocked',
      reason: 'this install has used this sign-in since the backup was made, which replaced the copy in the backup',
    });
    // Connected again here since: the archive's may still work somewhere, so it is only checked by using it.
    expect(maybe.by('bot:builder')).toMatchObject({ verdict: { state: 'check-by-use' }, replaces: true });
  });
});

describe('a sign-in that can only be checked by using it', () => {
  it('is a refresh token in date, and a subscription’s folder unlike this install’s', async () => {
    const facts = holding({}, { folder: async () => ({ 'auth.json': Buffer.from('{"tokens":"zzz-other-zzz"}').toString('base64') }) });

    const { by, asked } = await judge(archive(), { facts });

    expect(by('bot:builder').verdict).toEqual({ state: 'check-by-use' });
    expect(by(`account:${CODEX_SEAT}`)).toMatchObject({ verdict: { state: 'check-by-use' }, replaces: true });
    // Judging one never uses it.
    expect(asked.filter((one) => one.what === 'github user')).toEqual([]);
  });

  it('says what checking it does', () => {
    expect(GITHUB_TAKE_OVER).toBe(
      'Checking a GitHub sign-in uses it — if it works, this install takes it over from wherever else it is in use.',
    );
  });
});

describe('what is ticked, and what can be', () => {
  it('on a clean install, is everything that can come back; into a running one, only a working sign-in this install lacks', async () => {
    const facts = holding({ [`model-account-${CLAUDE_SEAT}`]: 'sk-ant-oat-zzz-another-zzz' });
    const { signIns } = await judge(archive(), { facts });

    expect(defaultSignInChoices(signIns, 'clean')).toEqual({
      'bot:builder': true,
      'bot:lead-reviewer': true,
      [`account:${KEY_ACCOUNT}`]: true,
      [`account:${CLAUDE_SEAT}`]: true,
      [`account:${CODEX_SEAT}`]: true,
    });
    expect(defaultSignInChoices(signIns, 'running')).toEqual({
      // A rotating one would be taken over from wherever else it is in use.
      'bot:builder': false,
      'bot:lead-reviewer': false,
      [`account:${KEY_ACCOUNT}`]: true,
      // This install has its own token for the seat: keep it unless asked.
      [`account:${CLAUDE_SEAT}`]: false,
      [`account:${CODEX_SEAT}`]: false,
    });
  });

  it('refuses a choice that ticks a blocked sign-in, naming it and why', async () => {
    const { signIns } = await judge(archive(), { refuse: [VALUES.apiKey] });

    expect(refusedChoice(signIns, { [`account:${KEY_ACCOUNT}`]: true })).toBe(
      'Anthropic API’s sign-in cannot be restored: Anthropic did not accept it: invalid x-api-key',
    );
    expect(refusedChoice(signIns, { [`account:${CLAUDE_SEAT}`]: true })).toBeNull();
  });

  it('leaves in the archive only the sign-ins written as they are', async () => {
    const { signIns } = await judge(archive(), { refuse: [VALUES.apiKey] });
    const selection = selectSignIns(signIns, defaultSignInChoices(signIns, 'clean'));

    const kept = keepOnlySignIns(archive(), selection.write);

    expect(selection.write.map((signIn) => signIn.key)).toEqual([`account:${CLAUDE_SEAT}`]);
    expect(selection.takeOver.map((signIn) => signIn.key)).toEqual(['bot:builder', 'bot:lead-reviewer', `account:${CODEX_SEAT}`]);
    expect(kept.secrets).not.toHaveProperty(`model-account-${KEY_ACCOUNT}`);
    expect(kept.secrets).not.toHaveProperty('github-refresh-fleetadlc-atlas-janedoe');
    expect(kept.secrets[`model-account-${CLAUDE_SEAT}`]).toBe(VALUES.seatToken);
    expect(kept.logins).toEqual({});
    expect(kept.bots.every((bot) => bot.credential === undefined)).toBe(true);
    // What is not a sign-in stays.
    expect(kept.secrets['ssh-signing-fleetadlc-atlas-janedoe']).toBe(VALUES.builderSigning);
  });
});

describe('an invalid sign-in', () => {
  it('is never written, and the rest of the restore goes on', async () => {
    const contents = archive();
    const shape = cleanShape();
    const { signIns } = await judge(contents, { refuse: [VALUES.apiKey] });
    const { target, recorded } = fakeTarget();
    const takeOver = fakeTakeOver({ logins: REFRESH_LOGINS });

    const report = await runRestore({
      contents,
      shape,
      signIns,
      choices: defaultSignInChoices(signIns, 'clean'),
      target,
      takeOver: takeOver.ports,
      actor: 'alex@example.test',
    });

    expect(recorded.secrets.has(`model-account-${KEY_ACCOUNT}`)).toBe(false);
    expect([...recorded.secrets.values()]).not.toContain(VALUES.apiKey);
    // The account's row comes back, with no check to its name, for a key to be given it.
    expect(recorded.accounts.find((account) => account.id === KEY_ACCOUNT)).toEqual({ id: KEY_ACCOUNT, keepCheck: false });
    expect(recorded.secrets.get(`model-account-${CLAUDE_SEAT}`)).toBe(VALUES.seatToken);
    expect(report.summary.accounts.find((account) => account.id === KEY_ACCOUNT)).toMatchObject({
      credential: 'none',
      signIn: 'blocked',
      reason: 'Anthropic did not accept it: invalid x-api-key',
    });
    expect(report.summary.next).toContain(
      'Give Anthropic API a key that works on the “Foundation model accounts / API keys” step: Anthropic did not accept it: invalid x-api-key.',
    );
  });

  it('cannot be forced through by ticking it', async () => {
    const contents = archive();
    const { signIns } = await judge(contents, { refuse: [VALUES.apiKey] });
    const { target, recorded } = fakeTarget();

    await expect(
      runRestore({
        contents,
        shape: cleanShape(),
        signIns,
        choices: { ...defaultSignInChoices(signIns, 'clean'), [`account:${KEY_ACCOUNT}`]: true },
        target,
        takeOver: fakeTakeOver().ports,
        actor: 'alex@example.test',
      }),
    ).rejects.toThrow('Anthropic API’s sign-in cannot be restored');
    expect(recorded.settings).toEqual({});
  });
});

describe('checking a rotating sign-in by using it', () => {
  async function takeOver(options: { refuse?: string[]; refuseLogin?: string[]; failSecret?: string; logins?: Record<string, string> } = {}) {
    const contents = archive();
    const shape = cleanShape();
    const { signIns } = await judge(contents);
    const { target, recorded } = fakeTarget(options.failSecret ? { failSecret: options.failSecret } : {});
    const ports = fakeTakeOver({
      refuse: options.refuse ?? [],
      logins: options.logins ?? REFRESH_LOGINS,
      refuseLogin: options.refuseLogin ?? [],
    });
    const results = await takeOverSignIns({
      contents,
      signIns: signIns.filter((signIn) => signIn.verdict.state === 'check-by-use'),
      shape,
      target,
      ports: ports.ports,
      actor: 'alex@example.test',
    });
    return { results, recorded, ports };
  }

  it('stores the new token GitHub gives for it, and its record, in one step', async () => {
    const { results, recorded } = await takeOver();

    expect(results.find((result) => result.key === 'bot:builder')).toEqual({ key: 'bot:builder', state: 'taken-over' });
    expect(recorded.secrets.get('github-refresh-builder')).toBe('ghr_zzz-fresh-refresh-1-zzz');
    expect(recorded.credentials.builder).toBe('github-refresh-builder');
    expect(recorded.audit.map((entry) => entry.action)).toContain('install.sign_in_taken_over');
    expect(JSON.stringify(recorded.audit)).not.toContain('zzz');
  });

  it('stores nothing at all for a sign-in GitHub refuses, and says why', async () => {
    const { results, recorded } = await takeOver({ refuse: [VALUES.builderRefresh] });

    expect(results.find((result) => result.key === 'bot:builder')).toEqual({
      key: 'bot:builder',
      state: 'refused',
      reason: 'GitHub did not accept it: The refresh token passed is incorrect or expired.',
    });
    expect(recorded.secrets.has('github-refresh-builder')).toBe(false);
    expect(recorded.credentials).not.toHaveProperty('builder');
    // The next one is still taken over.
    expect(recorded.credentials['lead-reviewer']).toBe('github-refresh-lead-reviewer');
  });

  it('keeps nothing when the token turns out to be another account’s', async () => {
    const { results, recorded } = await takeOver({ logins: { [VALUES.builderRefresh]: 'fleetadlc-mallory' } });

    expect(results.find((result) => result.key === 'bot:builder')?.reason).toBe('it signs in as fleetadlc-mallory, not fleetadlc-atlas-janedoe');
    expect(recorded.secrets.has('github-refresh-builder')).toBe(false);
  });

  it('never leaves a token without its record, nor a record without its token', async () => {
    const { results, recorded } = await takeOver({ failSecret: 'github-refresh-builder' });

    expect(results.find((result) => result.key === 'bot:builder')?.state).toBe('refused');
    expect(recorded.secrets.has('github-refresh-builder')).toBe(false);
    expect(recorded.credentials).not.toHaveProperty('builder');
  });

  it('spends no token when the store cannot be read, and goes on to the next sign-in', async () => {
    // Read after the refresh, a store that failed once lost the pair GitHub had
    // just issued, with the archive's copy already spent, and threw out of the
    // whole restore: the reviewer was never tried and no report came back.
    const contents = archive();
    const { signIns } = await judge(contents);
    const { target, recorded } = fakeTarget();
    const get = target.secrets.get;
    target.secrets.get = async (ref) => {
      if (ref === 'github-refresh-builder') throw new Error(`EIO reading ${ref} near ${VALUES.builderRefresh}`);
      return get(ref);
    };
    const ports = fakeTakeOver({ logins: REFRESH_LOGINS });
    const results = await takeOverSignIns({
      contents,
      signIns: signIns.filter((signIn) => signIn.verdict.state === 'check-by-use'),
      shape: cleanShape(),
      target,
      ports: ports.ports,
      actor: 'alex@example.test',
    });

    const builder = results.find((result) => result.key === 'bot:builder');
    expect(builder?.state).toBe('refused');
    expect(builder?.reason).toMatch(/^it could not be taken over: EIO reading github-refresh-builder/);
    expect(builder?.reason).not.toContain(VALUES.builderRefresh);
    expect(ports.refreshed).not.toContain(VALUES.builderRefresh);
    expect(results.find((result) => result.key === 'bot:lead-reviewer')?.state).toBe('taken-over');
    expect(recorded.credentials['lead-reviewer']).toBe('github-refresh-lead-reviewer');
  });

  it('keeps the folder a subscription’s CLI leaves when it answers, and nothing when it refuses', async () => {
    const accepted = await takeOver();
    const refused = await takeOver({ refuseLogin: [CODEX_SEAT] });

    expect(accepted.ports.adopted[CODEX_SEAT]).toEqual(CODEX_LOGIN);
    expect(accepted.recorded.order).toContain(`check ${CODEX_SEAT}`);
    expect(refused.ports.adopted).toEqual({});
    expect(refused.results.find((result) => result.key === `account:${CODEX_SEAT}`)).toMatchObject({ state: 'refused' });
    expect(refused.recorded.order).toContain(`forget ${CODEX_SEAT}`);
  });
});

describe('what a restore says before and after', () => {
  it('names, before, each sign-in to take over; after, the bots to connect again and why', async () => {
    const contents = archive();
    const shape = cleanShape();
    const { signIns } = await judge(contents);
    const choices = defaultSignInChoices(signIns, 'clean');

    const before = previewRestore({ contents, shape, signIns, choices });
    const builder = before.summary.bots.find((bot) => bot.seat === 'builder');
    expect(builder).toMatchObject({ signInState: 'take-over', needsConnecting: false, becomes: 'fleetadlc-atlas-janedoe' });
    expect(before.summary.next).toEqual([]);

    const { target } = fakeTarget();
    const after = await runRestore({
      contents,
      shape,
      signIns,
      choices,
      target,
      takeOver: fakeTakeOver({ refuse: [VALUES.reviewerRefresh], logins: REFRESH_LOGINS }).ports,
      actor: 'alex@example.test',
    });
    expect(after.summary.bots.find((bot) => bot.seat === 'lead-reviewer')).toMatchObject({
      signIn: false,
      needsConnecting: true,
      signInState: 'refused',
    });
    expect(after.summary.next).toContain(
      'Connect fleetadlc-sydney-janedoe to GitHub again: GitHub did not accept it: The refresh token passed is incorrect or expired.',
    );
    // Only a bot that holds a sign-in now takes its handle.
    expect(after.renames.map((rename) => rename.to)).toEqual(['fleetadlc-atlas-janedoe']);
  });

  it('leaves a sign-in a person unticked where it was, and says so', async () => {
    const contents = archive();
    const { signIns } = await judge(contents);
    const { target, recorded } = fakeTarget();
    const ports = fakeTakeOver({ logins: REFRESH_LOGINS });

    const report = await runRestore({
      contents,
      shape: cleanShape(),
      signIns,
      choices: { ...defaultSignInChoices(signIns, 'clean'), 'bot:builder': false },
      target,
      takeOver: ports.ports,
      actor: 'alex@example.test',
    });

    expect(ports.refreshed).toEqual([VALUES.reviewerRefresh]);
    expect(recorded.secrets.has('github-refresh-builder')).toBe(false);
    expect(report.summary.next).toContain('Connect fleetadlc-atlas-janedoe to GitHub again: it was left out of the restore.');
  });
});

describe('a bot’s own engine key', () => {
  const BUILDER_KEY = 'sk-ant-api-zzz-builder-engine-zzz';
  const REVIEWER_KEY = 'sk-zzz-reviewer-engine-zzz';
  const AUTOMATION_KEY = 'zzz-automation-engine-zzz';

  /** The archive with the per-bot keys an install from before model accounts kept. */
  function withEngineKeys(): BackupContents {
    const contents = archive();
    return {
      ...contents,
      secrets: {
        ...contents.secrets,
        'engine-key-fleetadlc-atlas-janedoe': BUILDER_KEY,
        'engine-key-fleetadlc-sydney-janedoe': REVIEWER_KEY,
        'engine-key-automation': AUTOMATION_KEY,
      },
    };
  }

  it('is judged with the provider of the engine its bot thinks with, as a key', async () => {
    const { by, asked } = await judge(withEngineKeys(), { refuse: [BUILDER_KEY] });

    expect(by('engine:builder')).toMatchObject({
      kind: 'engine-key',
      provider: 'anthropic',
      seat: 'builder',
      seats: [],
      accountId: null,
      who: 'builder',
      rotates: false,
      replaces: false,
      verdict: { state: 'blocked', reason: 'Anthropic did not accept it: invalid x-api-key' },
    });
    expect(by('engine:lead-reviewer')).toMatchObject({
      provider: 'openai',
      verdict: { state: 'works', said: 'OpenAI lists 2 models for it' },
    });
    expect(asked).toContainEqual({ what: 'openai models', auth: 'key' });
    // An engine with no provider has nothing to check the key with.
    expect(by('engine:automation')).toMatchObject({
      provider: null,
      verdict: { state: 'blocked', reason: 'it thinks with none, which has no provider to check the key with' },
    });
  });

  it('is the same as this install’s when the bot in that seat here holds that very key', async () => {
    const { by } = await judge(withEngineKeys(), { facts: holding({ 'engine-key-builder': BUILDER_KEY, 'engine-key-lead-reviewer': 'sk-other' }) });

    expect(by('engine:builder').verdict.state).toBe('same');
    expect(by('engine:lead-reviewer')).toMatchObject({ replaces: true, verdict: { state: 'works' } });
  });

  it('is written only when it works: a refused one, or one with nothing to check it, is never planned', async () => {
    const contents = withEngineKeys();
    const { signIns } = await judge(contents, { refuse: [BUILDER_KEY] });
    const { write } = selectSignIns(signIns, defaultSignInChoices(signIns, 'clean'));

    const kept = keepOnlySignIns(contents, write).secrets;
    expect(kept).not.toHaveProperty('engine-key-fleetadlc-atlas-janedoe');
    expect(kept).not.toHaveProperty('engine-key-automation');
    expect(kept['engine-key-fleetadlc-sydney-janedoe']).toBe(REVIEWER_KEY);
    // Nor does it bring back an unjudged GitHub record for its seat.
    expect(keepOnlySignIns(contents, write.filter((one) => one.kind === 'engine-key')).bots.every((bot) => !bot.credential)).toBe(true);

    const plan = previewRestore({ contents, shape: cleanShape(), signIns, choices: defaultSignInChoices(signIns, 'clean') }).plan;
    expect(plan.secrets.create).toContain('engine-key-lead-reviewer');
    expect(plan.secrets.create).not.toContain('engine-key-builder');
  });
});

