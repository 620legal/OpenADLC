import { ENGINE_PROVIDER, listProviderModels, scrubSecret, type ModelProvider } from '@fleetadlc/engines';
import {
  GitHubApiError,
  GitHubClient,
  accessTokenRef,
  engineKeyRef,
  modelAccountRef,
  refreshTokenRef,
  refreshUserToken,
  type UserToken,
} from '@fleetadlc/github';
import { redactSecrets, sameLogin, type EngineName } from '@fleetadlc/shared';
import type { ArchivedAccount, ArchivedBot, ArchivedCredential, BackupContents, LoginFiles } from './archive.js';
import { signsInByFolder } from './contents.js';
import { SIGN_IN_FILE } from './login-files.js';
import {
  archivedIdentities,
  archivedSeat,
  carriesSignIns,
  restoredIdentities,
  type InstallShape,
  type RestoredIdentity,
} from './plan.js';

/**
 * Whether each sign-in an archive carries is one a restore may write.
 *
 * Every restore runs this before it writes anything — the walkthrough's onto a
 * clean install, `fleetadlc restore`, and the one into an install that is already
 * set up — so an invalid sign-in is never written anywhere, and a working one
 * is never put over by one that fails. Each sign-in gets one of four verdicts:
 *
 *   same            this install holds the very same value; nothing to do.
 *   works           proven now, read-only and without side effects: a key —
 *                   a model account's, or a bot's own engine key — or a Claude
 *                   subscription's token lists the models it can call, a
 *                   non-expiring GitHub token is asked who it is.
 *   blocked         it expired; the provider refused it; this install has used
 *                   the same authorization since the backup was made, which
 *                   spent the copy in the backup; it was signed in through
 *                   another GitHub App, or there is no client id to refresh
 *                   it with; or it signs in as another account than the one
 *                   it was for. Never written.
 *   check-by-use    it rotates: a GitHub refresh token, an OpenAI or xAI
 *                   subscription's sign-in folder. The only way to know is to
 *                   use it, and using it replaces it, so it is checked and
 *                   taken over in one step once everything else is written
 *                   (`takeOverSignIns`), and only kept if the provider accepts.
 *
 * Names only leave this file — a sign-in's seat, login, account and label,
 * and the provider's own words with the value scrubbed out of them.
 */

/** What an archive can carry that signs something in. */
export type SignInKind = 'github-refresh' | 'github-token' | 'api-key' | 'claude-token' | 'subscription' | 'engine-key';

export type SignInVerdict =
  | { state: 'same' }
  | { state: 'works'; said: string }
  | { state: 'blocked'; reason: string }
  | { state: 'check-by-use' };

export interface SignIn {
  /**
   * What a choice names it by: `bot:<seat>` for a GitHub account one seat
   * signs in as, `github:<login>` for one several seats share, `account:<id>`
   * for a model account's, `engine:<seat>` for a bot's own engine key.
   */
  key: string;
  kind: SignInKind;
  /** Null only for an engine key whose bot thinks with an engine no provider is known for. */
  provider: 'github' | 'anthropic' | 'openai' | 'xai' | null;
  /**
   * The seat of the bot it signs in, for a GitHub account only one seat uses
   * or a bot's engine key; null for a shared one.
   */
  seat: string | null;
  /**
   * Every seat a GitHub sign-in signs in: one, or all the seats sharing the
   * account, which is one sign-in however many there are — GitHub rotates it
   * on every use, so it is judged, chosen and taken over once. Empty for a
   * model account's and an engine key: a seat here keeps its GitHub record
   * (`keepOnlySignIns`).
   */
  seats: string[];
  /** The model account it is the credential of, for any other. */
  accountId: string | null;
  /** Who it signs in as: the GitHub account, or the model account's label. */
  who: string;
  /** Whether using it replaces it, so that checking it is taking it over. */
  rotates: boolean;
  /** Whether this install holds a sign-in for the same seat or account already, which restoring it would replace. */
  replaces: boolean;
  verdict: SignInVerdict;
}

/** What the four verdicts are called wherever a person reads them. */
export const VERDICT_WORDS: Record<SignInVerdict['state'], string> = {
  same: 'Same as this install’s',
  works: 'Works',
  // Not "Expired or refused": a sign-in from another app, one this install
  // has used since, and one with no client id to refresh it are none of those.
  blocked: 'Cannot be restored',
  'check-by-use': 'Can only be checked by using it',
};

/** Said beside every GitHub sign-in that is checked by using it. */
export const GITHUB_TAKE_OVER =
  'Checking a GitHub sign-in uses it — if it works, this install takes it over from wherever else it is in use.';

/** Said beside every subscription sign-in that is checked by using it. */
export const SUBSCRIPTION_TAKE_OVER =
  'Checking a subscription’s sign-in uses it — if it works, this install takes it over from wherever else it is in use.';

/** The warning that goes with taking over this sign-in. */
export function takeOverWarning(signIn: Pick<SignIn, 'provider'>): string {
  return signIn.provider === 'github' ? GITHUB_TAKE_OVER : SUBSCRIPTION_TAKE_OVER;
}

// ------------------------------------------------------------------ the ports

/** What this install holds now, read so a sign-in can be compared by value. */
export interface SignInFacts {
  /** The value under a ref, or null. */
  secret(ref: string): Promise<string | null>;
  /** The account's sign-in folder, or null when it has none. */
  folder(accountId: string): Promise<LoginFiles | null>;
  /** How the bot in a seat was signed in, as this install recorded it, or null. */
  credential(seat: string): Promise<Pick<ArchivedCredential, 'githubLogin' | 'githubUserId' | 'authorizedAt'> | null>;
}

/** Nothing held: what a check against no install at all compares with. */
export const NOTHING_HELD: SignInFacts = {
  secret: async () => null,
  folder: async () => null,
  credential: async () => null,
};

/** The read-only checks. Neither changes anything at the provider. */
export interface SignInChecks {
  /** What a key, or a Claude subscription's token, can call. Throws the provider's words when it cannot. */
  listModels(provider: ModelProvider, secret: string, auth: 'key' | 'oauth'): Promise<unknown[]>;
  /** The GitHub account a user token signs in as. Throws when GitHub refuses it. */
  gitHubUser(token: string): Promise<{ login: string; id: number }>;
}

/**
 * The checks the rest of OpenADLC already makes: a key is proved by listing its
 * models, as adding an account does, and a GitHub token by `GET /user`, as the
 * bridge's client asks it.
 */
export function defaultSignInChecks(fetchImpl: typeof fetch = fetch): SignInChecks {
  return {
    listModels: (provider, secret, auth) => listProviderModels(provider, secret, fetchImpl, { auth }),
    gitHubUser: (token) => new GitHubClient({ token, actingAs: 'fleetadlc restore', fetchImpl }).viewer(),
  };
}

// ------------------------------------------------------------------ the verdicts

const PROVIDER_NAME: Record<ModelProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI' };

function day(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function passed(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= now.getTime();
}

/** An error's words, bounded, with the value taken out once more. */
function wordsOf(error: unknown, secret: string): string {
  let said = error instanceof Error ? error.message : String(error);
  if (error instanceof GitHubApiError) {
    // `{"message":"Bad credentials",…}`: GitHub's message and the status. The
    // body is read on its own, since the error's message can carry more after it.
    const body = error.body.trim();
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      said = `${typeof parsed.message === 'string' ? parsed.message : body} (${error.status})`;
    } catch {
      said = `${body || 'refused'} (${error.status})`;
    }
  }
  const scrubbed = scrubSecret(said, secret).replace(/\s+/g, ' ').trim();
  return scrubbed.length > 240 ? `${scrubbed.slice(0, 239)}…` : scrubbed || 'no reason was given';
}

function sameAccount(
  a: Pick<ArchivedCredential, 'githubLogin' | 'githubUserId'>,
  b: Pick<ArchivedCredential, 'githubLogin' | 'githubUserId'>,
): boolean {
  if (a.githubUserId !== null && b.githubUserId !== null) return a.githubUserId === b.githubUserId;
  return sameLogin(a.githubLogin, b.githubLogin);
}

/** Why a sign-in made before sign-ins were a choice is not restored. */
const STALE_SIGN_IN =
  'it is from a backup made before sign-ins could be chosen, and the old install has replaced it since';

export interface JudgeInput {
  contents: BackupContents;
  /** This install, by name: which bot sits in each seat. */
  shape: InstallShape;
  facts: SignInFacts;
  checks: SignInChecks;
  now: Date;
  /**
   * The GitHub App this install will refresh sign-ins with once the restore
   * is done, by client id — the archive's when the restore brings the app,
   * this install's otherwise — and the one the archive recorded, if any. A
   * sign-in refreshes only with the app that issued it.
   */
  clientId: { after: string | null; archive: string | null };
}

/** What a choice names a GitHub account's sign-in by: its seat's when it has one, the account's when seats share it. */
export function gitHubSignInKey(identity: Pick<RestoredIdentity, 'seats' | 'login'>): string {
  return identity.seats.length === 1 ? `bot:${identity.seats[0]}` : `github:${identity.login.toLowerCase()}`;
}

/**
 * The restored account a judged GitHub sign-in is for, in the contents a
 * restore is given: found by who it signs in as, never by its key.
 *
 * Sign-ins are judged on the whole archive, but a restore into a set-up
 * install is handed the chosen contents, in which every seat that kept its
 * own account no longer names the archived one. An account five seats shared
 * may have one seat left on it there, and its key, worked out again, was
 * `bot:<seat>` rather than the `github:<login>` that was ticked — so the
 * sign-in was refused as one the backup did not have. The seats, names and
 * `ns` used are the chosen contents', which are what the plan wrote; the
 * judged seats would point the seats that kept their accounts at this one.
 */
export function restoredIdentityOfSignIn(
  identities: readonly RestoredIdentity[],
  signIn: Pick<SignIn, 'who'>,
): RestoredIdentity | undefined {
  return identities.find((one) => one.from !== null && sameLogin(one.login, signIn.who));
}

/** The archived bots in these seats, in the archive's order. */
function botsIn(contents: Pick<BackupContents, 'bots'>, seats: readonly string[]): ArchivedBot[] {
  return contents.bots.filter((bot) => seats.includes(archivedSeat(bot)));
}

/**
 * One GitHub account's sign-in, judged once for every seat on it.
 *
 * The account, not the seat, is what holds a sign-in: seats sharing one hold
 * the same refresh token, and using it to check it would spend it for all of
 * them. So each account is one line, found here under the name this install
 * will file it under (`restoredIdentities`).
 */
async function judgeGitHub(identity: RestoredIdentity, input: JudgeInput): Promise<SignIn | null> {
  const { contents, facts, checks, now, clientId } = input;
  if (!identity.from) return null;
  const refresh = contents.secrets[refreshTokenRef(identity.from)];
  const token = contents.secrets[accessTokenRef(identity.from)];
  if (refresh === undefined && token === undefined) return null;

  const seat = identity.seats[0] as string;
  const heldRefresh = await facts.secret(refreshTokenRef(identity.ns));
  const heldToken = await facts.secret(accessTokenRef(identity.ns));
  // Every seat on it was signed in by the same authorization; the first
  // record the archive has says when, and until when.
  const credential = botsIn(contents, identity.seats).find((bot) => bot.credential)?.credential;
  const base = {
    key: gitHubSignInKey(identity),
    provider: 'github' as const,
    seat: identity.shared ? null : seat,
    seats: [...identity.seats],
    accountId: null,
    who: identity.login,
    replaces: heldRefresh !== null || heldToken !== null,
  };
  const otherApp =
    clientId.archive !== null && clientId.after !== null && clientId.archive !== clientId.after
      ? 'it was signed in through a different GitHub App than the one this install uses'
      : null;

  if (refresh !== undefined) {
    const signIn = { ...base, kind: 'github-refresh' as const, rotates: true };
    if (heldRefresh === refresh) return { ...signIn, verdict: { state: 'same' } };
    if (!carriesSignIns(contents)) return { ...signIn, verdict: { state: 'blocked', reason: STALE_SIGN_IN } };
    if (passed(credential?.refreshExpiresAt, now)) {
      return { ...signIn, verdict: { state: 'blocked', reason: `it expired on ${day(credential?.refreshExpiresAt ?? '')}` } };
    }
    if (otherApp) return { ...signIn, verdict: { state: 'blocked', reason: otherApp } };
    if (!clientId.after) {
      return {
        ...signIn,
        verdict: {
          state: 'blocked',
          reason: 'this install has no GitHub App client id to refresh it with; include the install’s app in this restore, or connect the bot again afterwards',
        },
      };
    }
    // The same authorization as the one this install holds for the seat, and
    // another token than the archive's: this install has refreshed it since,
    // and GitHub replaced the archive's copy when it did.
    const here = await facts.credential(seat);
    if (
      heldRefresh !== null &&
      here &&
      credential &&
      sameAccount(here, credential) &&
      here.authorizedAt !== null &&
      here.authorizedAt === credential.authorizedAt
    ) {
      return {
        ...signIn,
        verdict: {
          state: 'blocked',
          reason: 'this install has used this sign-in since the backup was made, which replaced the copy in the backup',
        },
      };
    }
    return { ...signIn, verdict: { state: 'check-by-use' } };
  }

  const signIn = { ...base, kind: 'github-token' as const, rotates: false };
  const value = token as string;
  if (heldToken === value) return { ...signIn, verdict: { state: 'same' } };
  if (otherApp) return { ...signIn, verdict: { state: 'blocked', reason: otherApp } };
  if (passed(credential?.tokenExpiresAt, now)) {
    return { ...signIn, verdict: { state: 'blocked', reason: `it expired on ${day(credential?.tokenExpiresAt ?? '')}` } };
  }
  try {
    const user = await checks.gitHubUser(value);
    if (!sameLogin(user.login, identity.login)) {
      return {
        ...signIn,
        verdict: { state: 'blocked', reason: `it signs in as ${user.login}, not ${identity.login}` },
      };
    }
    return { ...signIn, verdict: { state: 'works', said: `GitHub says it is ${user.login}` } };
  } catch (error) {
    return { ...signIn, verdict: { state: 'blocked', reason: `GitHub did not accept it: ${wordsOf(error, value)}` } };
  }
}

async function judgeAccount(account: ArchivedAccount, input: JudgeInput): Promise<SignIn | null> {
  const { contents, facts, checks } = input;
  const base = { key: `account:${account.id}`, provider: account.provider, seat: null, seats: [], accountId: account.id, who: account.label };

  if (signsInByFolder(account)) {
    const files = contents.logins?.[account.id];
    if (!files || files[SIGN_IN_FILE] === undefined) return null;
    const here = await facts.folder(account.id);
    const signIn = { ...base, kind: 'subscription' as const, rotates: true, replaces: here !== null };
    if (here && here[SIGN_IN_FILE] === files[SIGN_IN_FILE]) return { ...signIn, verdict: { state: 'same' } };
    return { ...signIn, verdict: { state: 'check-by-use' } };
  }

  const value = contents.secrets[modelAccountRef(account.id)];
  if (value === undefined) return null;
  const held = await facts.secret(modelAccountRef(account.id));
  const kind = account.kind === 'key' ? ('api-key' as const) : ('claude-token' as const);
  const signIn = { ...base, kind, rotates: false, replaces: held !== null };
  if (held === value) return { ...signIn, verdict: { state: 'same' } };
  try {
    const models = await checks.listModels(account.provider, value, kind === 'api-key' ? 'key' : 'oauth');
    return {
      ...signIn,
      verdict: { state: 'works', said: `${PROVIDER_NAME[account.provider]} lists ${models.length} model${models.length === 1 ? '' : 's'} for it` },
    };
  } catch (error) {
    return {
      ...signIn,
      verdict: { state: 'blocked', reason: `${PROVIDER_NAME[account.provider]} did not accept it: ${wordsOf(error, value)}` },
    };
  }
}

/**
 * A bot's own engine key, which hostd still uses for a bot with no model
 * account. Checked as a model account's key is, against the provider of the
 * engine the archived bot thinks with, and compared with the key the bot in
 * that seat here has. Unchecked, a restore from an older backup wrote a key
 * revoked since: the bot looked ready while every task failed at the engine,
 * or this install's working key was replaced with it.
 */
async function judgeEngineKey(bot: ArchivedBot, input: JudgeInput): Promise<SignIn | null> {
  const { contents, shape, facts, checks } = input;
  const value = contents.secrets[engineKeyRef(bot.name)];
  if (value === undefined) return null;
  const seat = archivedSeat(bot);
  const here = shape.bots.find((live) => live.slot === seat)?.name ?? bot.name;
  const held = await facts.secret(engineKeyRef(here));
  const provider = ENGINE_PROVIDER[bot.engine as EngineName] ?? null;
  const signIn = {
    key: `engine:${seat}`,
    kind: 'engine-key' as const,
    provider,
    seat,
    seats: [],
    accountId: null,
    who: here,
    rotates: false,
    replaces: held !== null,
  };
  if (held === value) return { ...signIn, verdict: { state: 'same' } };
  if (!provider) {
    return { ...signIn, verdict: { state: 'blocked', reason: `it thinks with ${bot.engine}, which has no provider to check the key with` } };
  }
  try {
    const models = await checks.listModels(provider, value, 'key');
    return {
      ...signIn,
      verdict: { state: 'works', said: `${PROVIDER_NAME[provider]} lists ${models.length} model${models.length === 1 ? '' : 's'} for it` },
    };
  } catch (error) {
    return { ...signIn, verdict: { state: 'blocked', reason: `${PROVIDER_NAME[provider]} did not accept it: ${wordsOf(error, value)}` } };
  }
}

/**
 * Every sign-in in the archive and what a restore may do with it, bots first
 * in the archive's order, then the model accounts, then the bots' own engine
 * keys. The read-only checks run side by side; nothing here writes anything,
 * anywhere.
 */
export async function judgeSignIns(input: JudgeInput): Promise<SignIn[]> {
  const judged = await Promise.all([
    ...restoredIdentities(input.contents, input.shape).map((identity) => judgeGitHub(identity, input)),
    ...(input.contents.accounts ?? []).map((account) => judgeAccount(account, input)),
    ...input.contents.bots.map((bot) => judgeEngineKey(bot, input)),
  ]);
  return judged.filter((signIn): signIn is SignIn => signIn !== null);
}

// ------------------------------------------------------------------ choosing

/** Which sign-ins to restore, by key. A blocked one is never restored, whatever this says. */
export type SignInChoices = Record<string, boolean>;

/**
 * What is ticked before anybody touches it.
 *
 * On a clean install everything that can come back does: the old install is
 * gone, so a rotating sign-in is checked and taken over. Into an install that
 * is set up, a working sign-in this install has none of is ticked; one that
 * would replace this install's is not, and neither is a rotating one, whose
 * check would take it over from wherever else it is in use.
 */
export function defaultSignInChoices(signIns: readonly SignIn[], into: 'clean' | 'running'): SignInChoices {
  const choices: SignInChoices = {};
  for (const signIn of signIns) {
    const { state } = signIn.verdict;
    choices[signIn.key] =
      state === 'works' ? into === 'clean' || !signIn.replaces : state === 'check-by-use' ? into === 'clean' : false;
  }
  return choices;
}

/** Whether a sign-in can be ticked at all. */
export function choosable(signIn: Pick<SignIn, 'verdict'>): boolean {
  return signIn.verdict.state === 'works' || signIn.verdict.state === 'check-by-use';
}

export interface SignInSelection {
  /** Written as the archive has them, with everything else in the restore's one transaction. */
  write: SignIn[];
  /** Checked by using them once the rest is written, and kept only when the provider accepts. */
  takeOver: SignIn[];
  /** Neither, and why. */
  leftOut: { signIn: SignIn; why: 'same' | 'blocked' | 'not-chosen' }[];
}

export function selectSignIns(signIns: readonly SignIn[], choices: SignInChoices): SignInSelection {
  const selection: SignInSelection = { write: [], takeOver: [], leftOut: [] };
  for (const signIn of signIns) {
    const { state } = signIn.verdict;
    if (state === 'same') selection.leftOut.push({ signIn, why: 'same' });
    else if (state === 'blocked') selection.leftOut.push({ signIn, why: 'blocked' });
    else if (choices[signIn.key] !== true) selection.leftOut.push({ signIn, why: 'not-chosen' });
    else if (state === 'works') selection.write.push(signIn);
    else selection.takeOver.push(signIn);
  }
  return selection;
}

/** Refuses a choice that ticks a sign-in that cannot be ticked. Names it, never its value. */
export function refusedChoice(signIns: readonly SignIn[], choices: SignInChoices): string | null {
  for (const signIn of signIns) {
    if (choices[signIn.key] === true && !choosable(signIn)) {
      return signIn.verdict.state === 'blocked'
        ? `${signIn.who}’s sign-in cannot be restored: ${signIn.verdict.reason}`
        : `${signIn.who}’s sign-in is the same as this install’s already`;
    }
  }
  return null;
}

/**
 * The archive with only the sign-ins the one transaction writes left in it.
 *
 * Every other sign-in comes out — blocked, the same as here, not chosen, or
 * to be taken over once the rest is written — and with a bot's the record of
 * it, which is never written without a token under it. What is left is what
 * `planRestore` plans and `applyRestore` writes, so neither can write a
 * sign-in that was not judged.
 */
export function keepOnlySignIns(contents: BackupContents, write: readonly SignIn[]): BackupContents {
  const keep = new Set(write.map((signIn) => signIn.key));
  const keepSeats = new Set(write.flatMap((signIn) => signIn.seats));
  const keepRefs = new Set<string>();
  const accounts = archivedIdentities(contents);
  for (const signIn of write) {
    if (signIn.accountId) keepRefs.add(modelAccountRef(signIn.accountId));
    if (signIn.kind === 'engine-key') {
      // Under the archive's name: `restoredSecretRefs` moves it to the bot's name here after this.
      const bot = contents.bots.find((one) => archivedSeat(one) === signIn.seat);
      if (bot) keepRefs.add(engineKeyRef(bot.name));
    }
    // Filed under the account's name in the archive, once for all its seats.
    const account = accounts.find((one) => signIn.seats.some((seat) => one.seats.includes(seat)));
    if (account?.from) {
      keepRefs.add(refreshTokenRef(account.from));
      keepRefs.add(accessTokenRef(account.from));
    }
  }
  // Every ref shaped like a sign-in goes unless it is one of those: a bot's
  // GitHub sign-in of either kind, a model account's key or token, a bot's
  // own engine key — whether or not the archive still has the bot or the
  // account it belonged to.
  const secrets: Record<string, string> = {};
  for (const [ref, value] of Object.entries(contents.secrets)) {
    if (SIGN_IN_PREFIXES.some((prefix) => ref.startsWith(prefix)) && !keepRefs.has(ref)) continue;
    secrets[ref] = value;
  }
  const bots = contents.bots.map((bot) => {
    if (keepSeats.has(archivedSeat(bot))) return bot;
    const { credential: _dropped, ...rest } = bot;
    return rest;
  });
  // A subscription's folder is never written as the archive has it: it is
  // taken over, or not restored at all.
  const logins: Record<string, LoginFiles> = {};
  for (const [id, files] of Object.entries(contents.logins ?? {})) {
    if (keep.has(`account:${id}`)) logins[id] = files;
  }
  return { ...contents, secrets, bots, ...(contents.logins !== undefined ? { logins } : {}) };
}

/** What every sign-in's ref starts with. */
const SIGN_IN_PREFIXES: readonly string[] = [refreshTokenRef(''), accessTokenRef(''), modelAccountRef(''), engineKeyRef('')];

// ------------------------------------------------------------------ what became of each

/**
 * What becomes, or became, of one sign-in: `take-over` is one still to be
 * checked by using it, and `taken-over` and `refused` are how that went.
 */
export type SignInState = 'restored' | 'same' | 'take-over' | 'taken-over' | 'refused' | 'blocked' | 'left-out';

/** A sign-in as a page or the CLI shows it: its verdict, whether it is ticked, and what becomes of it. */
export interface SignInLine extends SignIn {
  chosen: boolean;
  state: SignInState;
  /** Why it does not come back, in words: the verdict's reason, or the provider's refusal. */
  reason: string | null;
}

/**
 * The sign-ins with what becomes of each: before a restore, with `taken`
 * absent, what will; after it, with how each take-over went, what did.
 */
export function signInLines(
  signIns: readonly SignIn[],
  choices: SignInChoices,
  taken?: readonly TakeOverResult[],
): SignInLine[] {
  const results = new Map((taken ?? []).map((result) => [result.key, result]));
  return signIns.map((signIn) => {
    const chosen = choosable(signIn) && choices[signIn.key] === true;
    const line = (state: SignInState, reason: string | null = null): SignInLine => ({ ...signIn, chosen, state, reason });
    const { verdict } = signIn;
    if (verdict.state === 'same') return line('same');
    if (verdict.state === 'blocked') return line('blocked', verdict.reason);
    if (!chosen) return line('left-out');
    if (verdict.state === 'works') return line('restored');
    const result = results.get(signIn.key);
    if (!taken) return line('take-over');
    if (result?.state === 'taken-over') return line('taken-over');
    return line('refused', result?.reason ?? 'it was not checked');
  });
}

// ------------------------------------------------------------------ taking over

/**
 * Using a rotating sign-in, which is the only way to check one.
 *
 * `refreshGitHub` is the device-flow app's token refresh: GitHub answers with
 * a new pair and the one it was handed stops working. `adoptLogin` runs the
 * subscription's CLI on a copy of the folder, as hostd's account check runs
 * it, and keeps the folder the CLI leaves behind when it answers.
 */
export interface TakeOverPorts {
  refreshGitHub(refreshToken: string): Promise<UserToken>;
  gitHubUser(token: string): Promise<{ login: string; id: number }>;
  adoptLogin(accountId: string, files: LoginFiles): Promise<{ ok: boolean; message: string }>;
}

/** GitHub's half of the ports, refreshing with the app this install will use. */
export function gitHubTakeOver(clientId: string, fetchImpl: typeof fetch = fetch): Pick<TakeOverPorts, 'refreshGitHub' | 'gitHubUser'> {
  return {
    refreshGitHub: (refreshToken) => refreshUserToken({ clientId, refreshToken }),
    gitHubUser: (token) => new GitHubClient({ token, actingAs: 'fleetadlc restore', fetchImpl }).viewer(),
  };
}

export interface TakeOverResult {
  key: string;
  state: 'taken-over' | 'refused';
  reason?: string;
}

/** Where a take-over writes: the restore's own target, less what it does not need. */
export interface TakeOverTarget {
  secrets: {
    get(ref: string): Promise<string | null>;
    set(ref: string, value: string): Promise<void>;
    delete(ref: string): Promise<void>;
  };
  transaction<T>(
    fn: (db: {
      putCredential(name: string, credential: ArchivedCredential, secretRef: string): Promise<void>;
      audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
  forgetCheck?(accountId: string): Promise<void>;
  recordCheck?(accountId: string, checkedAt: string): Promise<void>;
}

/**
 * Checks each rotating sign-in by using it, and takes it over when it works.
 *
 * One sign-in at a time, and each in one step: the provider is asked first,
 * and only an answer that accepts it is written — the new GitHub token and
 * the record of it together, in one transaction whose secrets are put back if
 * it fails; the folder the CLI left, which hostd moves into place itself. A
 * refusal writes nothing for that bot or account, and says why, so the
 * walkthrough asks for it to be connected again.
 *
 * Bots are found in `shape` by seat, under the names they have now: the
 * restore's renames come after this.
 */
export async function takeOverSignIns(input: {
  contents: BackupContents;
  signIns: readonly SignIn[];
  shape: InstallShape;
  target: TakeOverTarget;
  ports: TakeOverPorts;
  actor: string;
  now?: () => Date;
}): Promise<TakeOverResult[]> {
  const results: TakeOverResult[] = [];
  const now = input.now ?? (() => new Date());
  for (const signIn of input.signIns) {
    if (signIn.verdict.state !== 'check-by-use') continue;
    try {
      results.push(signIn.kind === 'subscription' ? await adoptFolder(signIn, input, now) : await refreshBot(signIn, input));
    } catch (error) {
      // What nothing below expected, a store that would not answer say, costs
      // this sign-in alone. Thrown on, it ended the restore after it had
      // committed: the other sign-ins were never tried, no bot was renamed and
      // nothing said what had been done.
      let said = redactSecrets(error instanceof Error ? error.message : String(error));
      for (const value of Object.values(input.contents.secrets)) said = scrubSecret(said, value);
      results.push({ key: signIn.key, state: 'refused', reason: `it could not be taken over: ${wordsOf(said, '')}` });
    }
  }
  return results;
}

async function refreshBot(
  signIn: SignIn,
  input: Parameters<typeof takeOverSignIns>[0],
): Promise<TakeOverResult> {
  const refused = (reason: string): TakeOverResult => ({ key: signIn.key, state: 'refused', reason });
  // The account, found as judging found it: every seat on it, under the
  // names they have here, and the one name its sign-in goes under.
  const identity = restoredIdentityOfSignIn(restoredIdentities(input.contents, input.shape), signIn);
  const value = identity?.from ? input.contents.secrets[refreshTokenRef(identity.from)] : undefined;
  if (!identity || value === undefined) return refused('the backup has no sign-in for that account');
  const login = identity.login;
  const seats = botsIn(input.contents, identity.seats);

  // Once, however many seats share it: GitHub answers a refresh with a new
  // pair and the token it was handed stops working, so a second refresh of
  // the same token — for the next seat on the account — would be refused,
  // and one seat's take-over would leave the others signed out.
  // What the two refs hold now, read before the refresh: a store that cannot
  // be read then stops here, while the archive's token still works. Read after,
  // its failure lost the pair GitHub had just issued, with the old one spent.
  const before = new Map<string, string | null>();
  for (const one of [refreshTokenRef(identity.ns), accessTokenRef(identity.ns)]) before.set(one, await input.target.secrets.get(one));

  let token: UserToken;
  try {
    token = await input.ports.refreshGitHub(value);
  } catch (error) {
    return refused(`GitHub did not accept it: ${wordsOf(error, value)}`);
  }
  if (!token.accessToken) return refused('GitHub answered without a token');

  // The refresh has already replaced the archive's token, so an answer that
  // cannot say who it is does not undo it; only a different account does.
  let user: { login: string; id: number } | null = null;
  try {
    user = await input.ports.gitHubUser(token.accessToken);
  } catch {
    user = null;
  }
  if (user && !sameLogin(user.login, login)) {
    return refused(`it signs in as ${user.login}, not ${login}`);
  }

  // A pair from an app that expires tokens; an app that does not answers
  // with the token alone, which is kept the way a connect keeps one.
  const ref = token.refreshToken ? refreshTokenRef(identity.ns) : accessTokenRef(identity.ns);
  const other = token.refreshToken ? accessTokenRef(identity.ns) : refreshTokenRef(identity.ns);
  const stored = token.refreshToken ?? token.accessToken;
  // A record per seat, each pointing at the one sign-in, each keeping its
  // own signing key: the account is shared, the keys GitHub knows are not.
  const recordFor = (credential: ArchivedCredential | undefined): ArchivedCredential => ({
    githubLogin: login,
    githubUserId: user?.id ?? credential?.githubUserId ?? identity.githubUserId ?? null,
    scopes: token.scopes.length > 0 ? token.scopes : (credential?.scopes ?? []),
    tokenExpiresAt: token.expiresAt?.toISOString() ?? null,
    refreshExpiresAt: token.refreshExpiresAt?.toISOString() ?? credential?.refreshExpiresAt ?? null,
    signingKeyId: credential?.signingKeyId ?? null,
    authorizedAt: credential?.authorizedAt ?? null,
    status: 'active',
  });

  try {
    await input.target.transaction(async (db) => {
      for (const [index, seat] of identity.seats.entries()) {
        const name = identity.names[index] as string;
        await db.putCredential(name, recordFor(seats.find((bot) => archivedSeat(bot) === seat)?.credential), ref);
      }
      await db.audit({
        actor: input.actor,
        action: 'install.sign_in_taken_over',
        target: identity.shared ? login : (identity.names[0] as string),
        // Whose, never the token.
        payload: { seat: signIn.seat, seats: identity.seats, login },
      });
      await input.target.secrets.set(ref, stored);
      if (before.get(other) !== null) await input.target.secrets.delete(other);
    });
  } catch (error) {
    for (const [one, was] of before) {
      await (was === null ? input.target.secrets.delete(one) : input.target.secrets.set(one, was)).catch(() => undefined);
    }
    return refused(`GitHub accepted it, but it could not be stored: ${wordsOf(error, stored)}`);
  }
  return { key: signIn.key, state: 'taken-over' };
}

async function adoptFolder(
  signIn: SignIn,
  input: Parameters<typeof takeOverSignIns>[0],
  now: () => Date,
): Promise<TakeOverResult> {
  const files = signIn.accountId ? input.contents.logins?.[signIn.accountId] : undefined;
  if (!signIn.accountId || !files) return { key: signIn.key, state: 'refused', reason: 'the backup has no sign-in for that account' };
  let check: { ok: boolean; message: string };
  try {
    check = await input.ports.adoptLogin(signIn.accountId, files);
  } catch (error) {
    check = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!check.ok) {
    await input.target.forgetCheck?.(signIn.accountId).catch(() => undefined);
    // A CLI says it over several lines; a reason is one.
    const said = check.message.replace(/\s+/g, ' ').trim();
    const bounded = said.length > 300 ? `${said.slice(0, 299)}…` : said;
    return { key: signIn.key, state: 'refused', reason: `it was not accepted: ${bounded || 'the CLI did not answer'}` };
  }
  await input.target.recordCheck?.(signIn.accountId, now().toISOString()).catch(() => undefined);
  return { key: signIn.key, state: 'taken-over' };
}
