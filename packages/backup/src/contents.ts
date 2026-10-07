import {
  BOT_SECRET_REFS,
  accessTokenRef,
  appPrivateKeyRef,
  engineKeyRef,
  internalSecretRef,
  modelAccountRef,
  refreshTokenRef,
  registryTokenRef,
  signingKeyRef,
  webhookSecretRef,
} from '@fleetadlc/github';
import {
  FORMAT_VERSION,
  type ArchivedAccount,
  type ArchivedBot,
  type ArchivedCredential,
  type ArchivedHistory,
  type ArchivedIdentity,
  type ArchivedRepository,
  type ArchivedSpendingLimit,
  type BackupContents,
  type LoginFiles,
} from './archive.js';
import { includesOf, type BackupSelection } from './selection.js';

/**
 * Turning an install into an archive: what each secret is, which of them a
 * choice takes, and the archive that results. Pure, so the whole decision can
 * be tested without a database or a secret store — `live.ts` reads the install
 * into the snapshot below, and the console, the CLI and the walkthrough all go
 * through `buildBackup`.
 */

/** A bot as the install has it now. */
export interface InstallBot {
  name: string;
  slot: string;
  githubLogin: string | null;
  engine: string;
  model: string;
  modelAccountId: string | null;
  modelSetAt: string | null;
  /** The color and avatar a person chose for it. Absent where the caller has no crew look to give. */
  color?: string | null;
  avatar?: string | null;
  /**
   * The name the GitHub account it signs in as files its sign-in under — its
   * identity's `secret_ns`, which seats sharing one account share. Null or
   * absent when no identity is recorded: then it is the bot's own name, as
   * the bridge's `signInOf` falls back to.
   */
  identity?: string | null;
}

/** A GitHub account this install holds a sign-in for (`github_identities`). */
export interface InstallIdentity {
  login: string;
  githubUserId: number | null;
  secretNs: string;
}

/** Everything a backup may take from an install, values and all. */
export interface InstallSnapshot {
  secrets: Record<string, string>;
  settings: Record<string, string>;
  bots: InstallBot[];
  /** Each connected bot's sign-in bookkeeping, by the bot's name. */
  credentials: Record<string, ArchivedCredential>;
  repositories: ArchivedRepository[];
  accounts: ArchivedAccount[];
  /** Sign-in folders that were read, by account id. */
  logins: Record<string, LoginFiles>;
  /** Null when it was not read. */
  history: ArchivedHistory | null;
  /** The GitHub accounts, which the bots name by `identity`. Absent from an install read before seats could share one. */
  identities?: InstallIdentity[];
  /** Caps saved in Settings. Absent when the read did not ask. */
  spendingLimits?: ArchivedSpendingLimit[];
  /**
   * Repositories removed from OpenADLC, by name and full name. A removed row
   * still holds its name, so no other repository can be restored under it.
   * Absent from an install read before this was asked.
   */
  removedRepositories?: { name: string; fullName: string }[];
}

/** Which cap a row is, by name: the same cap in an archive and an install. */
export function spendingCapKey(cap: ArchivedSpendingLimit): string {
  return [cap.repository?.toLowerCase() ?? cap.scope, cap.kind, cap.bot ?? ''].join('\0');
}

/** A cap in words: where it holds and what it bounds, as a person reads it in a list. */
export function spendingCapName(cap: ArchivedSpendingLimit): string {
  const where = cap.repository ?? (cap.scope === 'global' ? 'all repositories' : cap.scope);
  const what =
    cap.kind === 'month_total'
      ? 'a month'
      : cap.kind === 'task'
        ? 'a task'
        : cap.kind === 'month_bot'
          ? `${cap.bot ?? 'a bot'} in a month`
          : cap.kind.startsWith('month_provider:')
            ? `${cap.kind.slice('month_provider:'.length)} in a month`
            : cap.kind;
  return `${where}, ${what}`;
}

/** An amount as Settings says it: whole dollars without `.00`, or none. */
export function spendingAmount(amountUsd: number | null | undefined): string {
  if (amountUsd == null) return 'none';
  return `$${Number.isInteger(amountUsd) ? amountUsd : amountUsd.toFixed(2)}`;
}

/**
 * A repository cap above the global one of the same kind, which saving from
 * Settings refuses. Rows as the table holds them: `repo:<id>` or `global`.
 */
export function capAboveGlobal(
  rows: readonly { scope: string; kind: string; amountUsd: number | null }[],
): { scope: string; kind: string; amountUsd: number; globalUsd: number } | null {
  for (const row of rows) {
    if (!row.scope.startsWith('repo:') || row.amountUsd == null) continue;
    const global = rows.find((one) => one.scope === 'global' && one.kind === row.kind)?.amountUsd;
    if (global != null && row.amountUsd > global) return { scope: row.scope, kind: row.kind, amountUsd: row.amountUsd, globalUsd: global };
  }
  return null;
}

/** A repository by its two names, and whether it was removed from OpenADLC. */
export interface RepositoryName {
  name: string;
  fullName: string;
  removed?: boolean;
}

/**
 * The repository here that goes by this one's name and is another
 * repository, removed ones included.
 *
 * OpenADLC names a repository by its name alone — `widgets#12` on a card, in
 * a branch, in every thread — and the name is unique on an install. A restore
 * of `other/widgets` into an install with `acme/widgets` wrote it over acme's
 * row: acme's issues, tasks, threads and caps became other/widgets', and Undo
 * then removed the row rather than putting acme back.
 */
export function namesakeOf(repo: { name: string; fullName: string }, here: readonly RepositoryName[]): RepositoryName | undefined {
  if (here.some((one) => one.fullName.toLowerCase() === repo.fullName.toLowerCase())) return undefined;
  return here.find((one) => one.name.toLowerCase() === repo.name.toLowerCase());
}

/** Why a repository cannot be restored beside the one here that has its name. */
export function repositoryNameTaken(wanted: string, holder: RepositoryName): string {
  return (
    `this install already has a repository called ${holder.name} (${holder.fullName}${holder.removed ? ', removed from OpenADLC' : ''}), ` +
    `and OpenADLC names each repository by its name alone, so ${wanted} cannot be restored beside it`
  );
}

/** The repositories a snapshot has by name, the removed ones marked. */
export function repositoryNames(here: Pick<InstallSnapshot, 'repositories' | 'removedRepositories'>): RepositoryName[] {
  return [
    ...here.repositories.map((repo) => ({ name: repo.name, fullName: repo.fullName })),
    ...(here.removedRepositories ?? []).map((repo) => ({ ...repo, removed: true })),
  ];
}

/**
 * The key the bridge signs the crew's posts with (apps/bridge/src/attribution.ts),
 * and the keys it retired, which still check for a while.
 */
export const ATTRIBUTION_KEY_REF = 'attribution-key';

interface StoredKey {
  kid: string;
  secret: string;
  retiredAt?: string;
}

function keyringOf(raw: string | null): { current: StoredKey; retired: StoredKey[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { current?: StoredKey; retired?: StoredKey[] };
    if (!parsed.current?.kid || !parsed.current.secret) return null;
    return { current: parsed.current, retired: Array.isArray(parsed.retired) ? parsed.retired : [] };
  } catch {
    return null;
  }
}

/**
 * The crew's signing keys once an archive's are restored over this install's.
 *
 * The archive's current key signs from now on — the restored crew goes on
 * being the one that signed what is on GitHub — and this install's current
 * key, if it had made one, is retired rather than dropped, as a rotation
 * retires one, so a post it signed still checks for as long as a retired key
 * does. Neither side's value is ever read by anything but this.
 */
export function mergedAttributionKeys(archived: string, here: string | null, now: Date = new Date()): string {
  const theirs = keyringOf(archived);
  const ours = keyringOf(here);
  if (!theirs || !ours) return archived;
  const retired: StoredKey[] = [];
  const seen = new Set([theirs.current.kid]);
  for (const key of [{ ...ours.current, retiredAt: now.toISOString() }, ...ours.retired, ...theirs.retired]) {
    if (seen.has(key.kid)) continue;
    seen.add(key.kid);
    retired.push(key);
  }
  return JSON.stringify({ current: theirs.current, retired });
}

/**
 * Settings that record what this install's engine update last did, rather than
 * anything a person set: the week it last ran, how it ended, the version a
 * rollback undid, each tool's last check, and the run in flight. They are
 * about this machine's bot image, and a new machine has its own.
 */
export const RUNTIME_SETTINGS: readonly string[] = [
  'engineUpdateSlot',
  'engineUpdateLast',
  'engineUpdateHold',
  'systemToolLast',
  'systemToolRun',
];

/**
 * The request states a restore writes back: every one `requests_state_check`
 * accepts. `queued` came with migration 0021 and was missing here, so a request
 * waiting its turn when the backup was taken was dropped on restore while the
 * plan and the summary counted it as restored. One in any other state is
 * left out, and the plan counts it as skipped.
 */
export const RESTORED_REQUEST_STATES: ReadonlySet<string> = new Set(['queued', 'draft', 'questions', 'filed', 'abandoned']);

/**
 * A setting as a backup carries it: null for a runtime one, and each tool's
 * schedule without the slot this machine last ran it for. The mode, day, time
 * and pin are what a person chose. The slot is when this machine's image was
 * last updated: restored onto a new machine it said a week was done that had
 * never run there. Without it the first look starts counting from then, as a
 * new install does.
 */
export function archivedSetting(key: string, value: string): string | null {
  if (RUNTIME_SETTINGS.includes(key)) return null;
  if (key !== 'systemToolSchedules') return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
  const rows: Record<string, unknown> = {};
  for (const [id, row] of Object.entries(parsed as Record<string, unknown>)) {
    rows[id] = row && typeof row === 'object' && !Array.isArray(row) ? { ...(row as Record<string, unknown>), slot: null } : row;
  }
  return JSON.stringify(rows);
}

/** `github-refresh-`, taken from the helper so a rename of the ref is the only way this can drift. */
const REFRESH_TOKEN_PREFIX = refreshTokenRef('');

/** Whether this secret ref is a GitHub device-flow refresh token. */
export function isGitHubRefreshTokenRef(ref: string): boolean {
  return ref.startsWith(REFRESH_TOKEN_PREFIX) && ref.length > REFRESH_TOKEN_PREFIX.length;
}

/** Refresh-token refs in a secret map, by name. The values are not returned. */
export function refreshTokenRefs(secrets: Record<string, string>): string[] {
  return Object.keys(secrets).filter(isGitHubRefreshTokenRef).sort();
}

/**
 * The secrets without a single refresh token, for an archive whose maker left
 * the sign-ins out. Everything that does not rotate on use stays.
 */
export function withoutRefreshTokens(secrets: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const ref of Object.keys(secrets)) {
    if (isGitHubRefreshTokenRef(ref)) continue;
    const value = secrets[ref];
    if (value !== undefined) kept[ref] = value;
  }
  return kept;
}

/** What one secret ref is, and so which choice takes it. */
export type SecretKind =
  | { group: 'install' }
  | { group: 'bot'; bot: string; kind: 'signing-key' | 'engine-key' | 'sign-in' }
  /** A GitHub account's sign-in, filed under its name and used by every one of these bots. */
  | { group: 'sign-in'; ns: string; bots: string[] }
  | { group: 'account'; account: string }
  | { group: 'never'; reason: string };

const ACCOUNT_PREFIX = modelAccountRef('');

/** Where a GitHub account's sign-in is filed, and the bots that use it. */
export interface SignInHolder {
  ns: string;
  bots: readonly string[];
}

/**
 * Sorts a ref into its group.
 *
 * A GitHub sign-in belongs to the account it signs in as, not to a bot: seats
 * that share an account share one, filed under the account's name, which is
 * often no bot's name at all. So `holders` — each account's name and the bots
 * on it — is asked first, and a sign-in filed under one of them goes with
 * those bots. One filed under a bot's own name with no account recorded is
 * that bot's, as every sign-in was before accounts could be shared.
 *
 * The key the crew's posts are signed with is the install's, like the App's
 * key: a restored install goes on being the crew that signed what is already
 * on GitHub, and posts signed before the move still check after it.
 * The internal API secret is never taken: it is what hostd and the bridge of
 * *this* install prove themselves to each other with, and a new install makes
 * its own. Nor is anything this does not recognise — a ref belonging to a bot
 * the install no longer has, or one added by something newer than this — so an
 * archive holds what a restore knows where to put, and nothing it would have
 * to guess about.
 */
export function classifySecret(
  ref: string,
  botNames: readonly string[],
  holders: readonly SignInHolder[] = [],
): SecretKind {
  if (ref === appPrivateKeyRef() || ref === webhookSecretRef() || ref === registryTokenRef() || ref === ATTRIBUTION_KEY_REF) return { group: 'install' };
  if (ref === internalSecretRef()) return { group: 'never', reason: 'each install makes its own' };
  // Opens the backup an undo of the last restore puts back: this install's own, for a day.
  if (ref === 'restore-undo-key') return { group: 'never', reason: 'it opens this install’s own undo of its last restore' };
  if (ref.startsWith(ACCOUNT_PREFIX) && ref.length > ACCOUNT_PREFIX.length) {
    return { group: 'account', account: ref.slice(ACCOUNT_PREFIX.length) };
  }
  for (const holder of holders) {
    if (holder.bots.length === 0) continue;
    if (ref === refreshTokenRef(holder.ns) || ref === accessTokenRef(holder.ns)) {
      return { group: 'sign-in', ns: holder.ns, bots: [...holder.bots] };
    }
  }
  for (const bot of botNames) {
    if (ref === signingKeyRef(bot)) return { group: 'bot', bot, kind: 'signing-key' };
    if (ref === engineKeyRef(bot)) return { group: 'bot', bot, kind: 'engine-key' };
    if (ref === refreshTokenRef(bot) || ref === accessTokenRef(bot)) return { group: 'bot', bot, kind: 'sign-in' };
  }
  if (BOT_SECRET_REFS.some((ref_) => ref.startsWith(ref_('')))) {
    return { group: 'never', reason: 'it belongs to no bot this install has' };
  }
  return { group: 'never', reason: 'it is not something a backup carries' };
}

/** Why a bot's sign-in was left out, when it was. */
export const SIGN_INS_NOT_CHOSEN = 'the GitHub sign-ins were not chosen';

/** A ref the archive did not take, and why. Names only. */
export interface LeftOut {
  ref: string;
  reason: string;
}

function chosen<T>(choice: 'all' | string[], items: readonly T[], key: (item: T) => string): T[] {
  if (choice === 'all') return [...items];
  const wanted = new Set(choice);
  return items.filter((item) => wanted.has(key(item)));
}

/** Whether an account signs in by device code into a folder: an OpenAI or xAI subscription. */
export function signsInByFolder(account: Pick<ArchivedAccount, 'kind' | 'provider'>): boolean {
  return account.kind === 'subscription' && account.provider !== 'anthropic';
}

/**
 * The archive a choice makes of an install.
 *
 * Each group takes only what is its own: the install's settings and the App's
 * key; each chosen bot's seat, login, model assignment, signing key and
 * per-bot engine key, and its sign-in when that was ticked; each chosen
 * account's row and key or token, and its sign-in folder when that was
 * ticked. A secret no group takes is left out and named in `leftOut`, so the
 * CLI can say so.
 */
export function buildBackup(
  found: InstallSnapshot,
  selection: BackupSelection,
  now: Date,
): { contents: BackupContents; leftOut: LeftOut[] } {
  const bots = chosen(selection.bots, found.bots, (bot) => bot.slot);
  const accounts = chosen(selection.accounts, found.accounts, (account) => account.id);
  const botNames = found.bots.map((bot) => bot.name);
  const chosenBots = new Set(bots.map((bot) => bot.name));
  const githubAccounts = identitiesOf(found);
  const holders = githubAccounts.map((account) => ({ ns: account.secretNs, bots: account.bots }));
  const chosenAccounts = new Set(accounts.map((account) => account.id));

  const secrets: Record<string, string> = {};
  const leftOut: LeftOut[] = [];
  for (const ref of Object.keys(found.secrets).sort()) {
    const value = found.secrets[ref];
    if (value === undefined) continue;
    const kind = classifySecret(ref, botNames, holders);
    let reason: string | null = null;
    switch (kind.group) {
      case 'install':
        if (!selection.install) reason = 'the install was not chosen';
        break;
      case 'bot':
        if (!chosenBots.has(kind.bot)) reason = `${kind.bot} was not chosen`;
        else if (kind.kind === 'sign-in' && !selection.botSignIns) reason = SIGN_INS_NOT_CHOSEN;
        break;
      case 'sign-in':
        // Taken with any seat on the account: it is as much one's as another's.
        if (!kind.bots.some((bot) => chosenBots.has(bot))) {
          reason = `${kind.bots.join(', ')} ${kind.bots.length === 1 ? 'was' : 'were'} not chosen`;
        } else if (!selection.botSignIns) reason = SIGN_INS_NOT_CHOSEN;
        break;
      case 'account':
        if (!chosenAccounts.has(kind.account)) reason = 'that model account was not chosen';
        break;
      case 'never':
        reason = kind.reason;
        break;
    }
    if (reason) leftOut.push({ ref, reason });
    else secrets[ref] = value;
  }

  const settings: Record<string, string> = {};
  if (selection.install) {
    for (const [key, value] of Object.entries(found.settings)) {
      // The secret store's copy is carried above. The setting is then only
      // the environment's fallback, and a second copy of a secret.
      if (key === 'webhookSecret' && found.secrets[webhookSecretRef()] !== undefined) continue;
      const archived = archivedSetting(key, value);
      if (archived !== null) settings[key] = archived;
    }
  }

  const archivedBots: ArchivedBot[] = bots.map((bot) => {
    const credential = selection.botSignIns ? found.credentials[bot.name] : undefined;
    return {
      name: bot.name,
      slot: bot.slot,
      githubLogin: bot.githubLogin,
      engine: bot.engine,
      model: bot.model,
      modelAccountId: bot.modelAccountId,
      modelSetAt: bot.modelSetAt,
      ...(bot.color !== undefined ? { color: bot.color } : {}),
      ...(bot.avatar !== undefined ? { avatar: bot.avatar } : {}),
      ...(credential ? { credential } : {}),
    };
  });

  // Which account each chosen seat signs in as — the shape of the crew, not
  // a secret, so it comes with the seats whether or not the sign-ins do.
  const slots = new Map(found.bots.map((bot) => [bot.name, bot.slot]));
  const identities: ArchivedIdentity[] = [];
  for (const account of githubAccounts) {
    const seats = account.bots.filter((name) => chosenBots.has(name)).map((name) => slots.get(name) as string);
    if (seats.length === 0) continue;
    identities.push({ login: account.login, githubUserId: account.githubUserId, secretNs: account.secretNs, seats });
  }

  const logins: Record<string, LoginFiles> = {};
  if (selection.accountSignIns) {
    for (const account of accounts) {
      const files = found.logins[account.id];
      if (signsInByFolder(account) && files && Object.keys(files).length > 0) logins[account.id] = files;
    }
  }

  const contents: BackupContents = {
    manifest: {
      version: FORMAT_VERSION,
      createdAt: now.toISOString(),
      // Counted again from the payload when the archive is sealed; these only
      // fill the required field until then.
      counts: { secrets: Object.keys(secrets).length, settings: Object.keys(settings).length, bots: archivedBots.length },
      includes: includesOf(selection, { bots: found.bots.length, accounts: found.accounts.length }),
    },
    secrets,
    settings,
    bots: archivedBots,
    repositories: selection.repositories ? found.repositories : [],
    accounts,
    logins,
    history: selection.history ? found.history : null,
    identities,
    // With the install, and only then: a backup of the crew alone must not
    // wipe the caps when it is put back.
    // Only caps that were read. A list here, even an empty one, is the whole
    // table to a restore, which deletes every cap not in it.
    ...(selection.install && found.spendingLimits !== undefined ? { spendingLimits: found.spendingLimits } : {}),
  };
  return { contents, leftOut };
}

/** A GitHub account as a backup reads it: where its sign-in is filed, and the bots on it by name. */
interface AccountHere {
  login: string;
  githubUserId: number | null;
  secretNs: string;
  bots: string[];
}

/**
 * The install's GitHub accounts and who uses each.
 *
 * Every bot with a login is on one. A bot with no identity recorded — an
 * install read before accounts could be shared, or one whose row was never
 * given one — is on an account of its own filed under its own name, which is
 * where the bridge looks for its sign-in then too.
 */
function identitiesOf(found: InstallSnapshot): AccountHere[] {
  const accounts: AccountHere[] = [];
  const byNs = new Map<string, AccountHere>();
  for (const identity of found.identities ?? []) {
    const account = { ...identity, bots: [] as string[] };
    byNs.set(identity.secretNs, account);
    accounts.push(account);
  }
  for (const bot of found.bots) {
    if (!bot.githubLogin) continue;
    const listed = bot.identity ? byNs.get(bot.identity) : undefined;
    if (listed) {
      listed.bots.push(bot.name);
      continue;
    }
    const own = byNs.get(bot.name);
    if (own && own.bots.length === 0 && own.login.toLowerCase() === bot.githubLogin.toLowerCase()) {
      own.bots.push(bot.name);
      continue;
    }
    const account: AccountHere = {
      login: bot.githubLogin,
      githubUserId: found.credentials[bot.name]?.githubUserId ?? null,
      secretNs: bot.name,
      bots: [bot.name],
    };
    byNs.set(bot.name, account);
    accounts.push(account);
  }
  return accounts.filter((account) => account.bots.length > 0);
}
