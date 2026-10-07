import { settings, type SettingKey } from '@fleetadlc/db';
import { accessTokenRef, engineKeyRef, internalSecretRef, refreshTokenRef, signingKeyRef } from '@fleetadlc/github';
import { ENGINES, isAvatar, isCrewColor, nameForLogin, sameLogin, seatForPersona } from '@fleetadlc/shared';
import { BackupError, type ArchivedBot, type BackupContents, type BackupManifest } from './archive.js';
import {
  RESTORED_REQUEST_STATES,
  isGitHubRefreshTokenRef,
  namesakeOf,
  repositoryNameTaken,
  spendingAmount,
  spendingCapName,
  type RepositoryName,
} from './contents.js';

/**
 * What a restore would change, decided before anything is written.
 *
 * This is the whole restore, as data: the CLI prints it and asks; the
 * bridge's walkthrough applies it only to a clean install, and its restore
 * into an install in use (`restore-into.ts`) applies it for what the
 * comparison chose (`chosenArchive`); `apply.ts` does exactly what it says and
 * nothing else. Names only — refs,
 * keys, seats, ids — so a plan can be shown, logged or sent to a browser.
 */

/** What this install has, by name. A restore decides from this and nothing else. */
export interface InstallShape {
  secretRefs: string[];
  settingKeys: string[];
  bots: { name: string; slot: string; githubLogin: string | null; engine?: string; color?: string | null; avatar?: string | null }[];
  /** Repository names. Absent in a shape read before repositories were restored. */
  repositories?: string[];
  /**
   * Each repository by name and full name, removed ones marked: what a
   * restore matches a repository by, and the names it cannot give another.
   * Absent in a shape read before this was kept; then names alone decide.
   */
  repositoryNames?: RepositoryName[];
  /** Model account ids. */
  accounts?: string[];
  /** Account ids whose subscription sign-in folder is there. */
  logins?: string[];
  /**
   * The GitHub accounts this install holds a sign-in for, where each is filed,
   * and the bots on it by name. Absent in a shape read before seats could
   * share an account: then every bot's sign-in is filed under its own name.
   */
  identities?: { login: string; secretNs: string; bots: string[] }[];
}

/**
 * The seat an archived bot sat in. Recorded since seats existed; before that
 * the bots had persona names, and each is read as the seat it was — `atlas`
 * as `builder` — which is what the migration made of the same rows.
 */
export function archivedSeat(bot: { name: string; slot?: string }): string {
  return bot.slot ?? seatForPersona(bot.name) ?? bot.name;
}

/**
 * The row an archived bot is restored onto: this install's bot in the same
 * seat, whatever either install calls it. A bot's name is its account's
 * handle once one connects, so two installs name the same seat differently,
 * and an archive from before seats named it by a persona neither has now.
 */
function restoredOnto(
  bot: { name: string; slot?: string },
  current: InstallShape,
): InstallShape['bots'][number] | undefined {
  const seat = archivedSeat(bot);
  return current.bots.find((live) => live.slot === seat);
}

/** Where a bot here files its GitHub sign-in now: its account's name, or its own when none is recorded. */
export function signInNsHere(current: Pick<InstallShape, 'identities'>, name: string): string {
  return current.identities?.find((identity) => identity.bots.includes(name))?.secretNs ?? name;
}

/** A GitHub account as an archive has it: who it is, where its sign-in is filed, and the seats on it. */
export interface AccountInArchive {
  login: string;
  githubUserId: number | null;
  /** The name the archive files its sign-in under, or null when it carries none for it. */
  from: string | null;
  /** The seats that sign in as it, each of whose bots the archive has as this login. */
  seats: string[];
}

/**
 * The GitHub accounts an archive's seats sign in as, whatever version wrote it.
 *
 * Version 3 says so (`identities`). An older archive does not, and need not:
 * before seats could share an account, each bot with a login was an account
 * of its own, its sign-in filed under the bot's name — so that is how it is
 * read, and an old archive restores exactly as it always did.
 *
 * A seat is on an account only while its bot in the archive names that login:
 * a restore into an install in use that keeps a seat's own account rewrites
 * the seat's login in the archive (`chosenArchive`), and the seat is then on
 * that account, with no sign-in of the archive's for it.
 */
export function archivedIdentities(
  contents: Pick<BackupContents, 'bots' | 'identities'> & Partial<Pick<BackupContents, 'secrets'>>,
): AccountInArchive[] {
  const accounts: AccountInArchive[] = [];
  /** Accounts the archive does not list, made here from the bots. */
  const unlisted: AccountInArchive[] = [];
  const covered = new Set<string>();
  for (const identity of contents.identities ?? []) {
    const seats = identity.seats.filter((seat) => {
      const bot = contents.bots.find((one) => archivedSeat(one) === seat);
      return Boolean(bot?.githubLogin && sameLogin(bot.githubLogin, identity.login)) && !covered.has(seat);
    });
    if (seats.length === 0) continue;
    for (const seat of seats) covered.add(seat);
    accounts.push({ login: identity.login, githubUserId: identity.githubUserId, from: identity.secretNs, seats });
  }
  for (const bot of contents.bots) {
    const seat = archivedSeat(bot);
    const login = bot.githubLogin;
    if (!login || covered.has(seat)) continue;
    covered.add(seat);
    // A version 3 archive lists every account it carries a sign-in for, so a
    // seat on none of them has none in it; an older one filed each under the bot.
    const from = contents.identities === undefined ? bot.name : null;
    const holds = (ns: string | null) =>
      ns !== null && (contents.secrets?.[refreshTokenRef(ns)] !== undefined || contents.secrets?.[accessTokenRef(ns)] !== undefined);
    // Seats on one login are one account. An older archive only has that
    // from an install that shared an account before backups knew it could:
    // the sign-in is the one filed under whichever seat's name holds it.
    const same = unlisted.find((one) => sameLogin(one.login, login));
    if (same) {
      same.seats.push(seat);
      if (!holds(same.from) && holds(from)) same.from = from;
      continue;
    }
    const account = { login, githubUserId: bot.credential?.githubUserId ?? null, from, seats: [seat] };
    unlisted.push(account);
    accounts.push(account);
  }
  return accounts;
}

/** An archived GitHub account, found on this install: the seats on it here, and where its sign-in goes. */
export interface RestoredIdentity extends AccountInArchive {
  /** The name this install files its sign-in under once restored. */
  ns: string;
  /** The bots in `seats`, by the names they have here now. */
  names: string[];
  /** Whether more than one seat signs in as it. */
  shared: boolean;
}

/**
 * Each archived GitHub account whose seats this install has, and where its
 * sign-in is filed here.
 *
 * An account this install already has keeps the name it is filed under, and
 * the restored seats join it. Otherwise one seat's account is filed under that
 * bot's name here, as a bot on an account of its own always is, and moves with
 * it when it takes the handle. A shared account keeps the archive's name for
 * it, unless something here already answers to that name — a bot not on it,
 * or another account a bot here still uses — and then the first name that is
 * free.
 */
export function restoredIdentities(
  contents: Pick<BackupContents, 'bots' | 'identities'> & Partial<Pick<BackupContents, 'secrets'>>,
  current: InstallShape,
): RestoredIdentity[] {
  const out: RestoredIdentity[] = [];
  const taken = new Set<string>();
  for (const account of archivedIdentities(contents)) {
    const seats: string[] = [];
    const names: string[] = [];
    for (const seat of account.seats) {
      const live = current.bots.find((bot) => bot.slot === seat);
      if (!live) continue;
      seats.push(seat);
      names.push(live.name);
    }
    if (seats.length === 0) continue;
    const mine = new Set(names);
    const free = (ns: string): boolean =>
      !taken.has(ns) &&
      !current.bots.some((bot) => bot.name === ns && !mine.has(bot.name)) &&
      !(current.identities ?? []).some(
        (identity) =>
          identity.secretNs === ns && !sameLogin(identity.login, account.login) && identity.bots.some((bot) => !mine.has(bot)),
      );
    let ns = (current.identities ?? []).find((identity) => sameLogin(identity.login, account.login))?.secretNs;
    if (!ns) {
      const from = account.from ? [account.from] : [];
      const candidates = seats.length === 1 ? [...names, ...from] : [...from, ...names];
      const first = candidates[0] as string;
      ns = candidates.find(free);
      for (let n = 2; !ns; n += 1) if (free(`${first}-${n}`)) ns = `${first}-${n}`;
    }
    taken.add(ns);
    out.push({ ...account, seats, names, ns, shared: seats.length > 1 });
  }
  return out;
}

/** The restored account a seat signs in as, if any. */
export function restoredIdentityOf(identities: readonly RestoredIdentity[], seat: string): RestoredIdentity | undefined {
  return identities.find((identity) => identity.seats.includes(seat));
}

/**
 * The name a bot restored onto a seat goes by once it holds a sign-in: its
 * account's handle, as the bridge names a connected bot — unless it shares
 * the account with other seats, and then its seat's, as the bridge names
 * those (`BotNames.wantedFor`): nine bots called by one login could not be
 * told apart.
 */
export function restoredName(identity: Pick<RestoredIdentity, 'login' | 'shared'>, seat: string): string {
  return identity.shared ? seat : nameForLogin(identity.login);
}

/**
 * Where each of an archived bot's own secrets goes: under the name the bot in
 * that seat has here. `ssh-signing-atlas` from an old archive lands as
 * `ssh-signing-builder` on an install whose builder is not connected yet, and
 * moves with the bot when an account connects and it takes the handle — the
 * same way every other secret named after a bot does.
 *
 * A GitHub sign-in is the account's, not a bot's, and goes where the account
 * is filed here (`restoredIdentities`): one seat's under that bot's name, a
 * shared one's under the account's. Refs that belong to no bot, or to a bot
 * this install does not have, are written as they are.
 */
export function restoredSecretRefs(
  contents: Pick<BackupContents, 'secrets' | 'bots' | 'identities'>,
  current: InstallShape,
): Map<string, string> {
  const to = new Map<string, string>();
  for (const bot of contents.bots) {
    const live = restoredOnto(bot, current);
    if (!live || live.name === bot.name) continue;
    for (const ref of [signingKeyRef, engineKeyRef]) {
      if (contents.secrets[ref(bot.name)] !== undefined) to.set(ref(bot.name), ref(live.name));
    }
  }
  for (const identity of restoredIdentities(contents, current)) {
    if (!identity.from || identity.from === identity.ns) continue;
    for (const ref of [refreshTokenRef, accessTokenRef]) {
      if (contents.secrets[ref(identity.from)] !== undefined) to.set(ref(identity.from), ref(identity.ns));
    }
  }
  return to;
}

/** What a caller that handed no manifest is taken to have: an archive from before anything could be chosen. */
const UNCHOSEN: BackupManifest = { version: 1, createdAt: '', counts: { secrets: 0, settings: 0, bots: 0 } };

/** Whether an archive's maker chose to carry the bots' GitHub sign-ins. An archive from before the choice did not. */
export function carriesSignIns(contents: Pick<BackupContents, 'manifest'>): boolean {
  return contents.manifest.includes?.botSignIns === true;
}

/** Whether a secret in this archive is to be written back, or is a snapshot that was never meant to be. */
function restorable(ref: string, contents: Pick<BackupContents, 'manifest'>): 'write' | 'stale' | 'never' {
  if (ref === internalSecretRef()) return 'never';
  if (isGitHubRefreshTokenRef(ref) && !carriesSignIns(contents)) return 'stale';
  return 'write';
}

/**
 * How to make a seat the archive has and this install does not. Not just
 * `fleetadlc up`: on an install that is set up, it has already seeded every
 * seat its config/bots.yaml names, so a seat missing here is one that file
 * does not, and running it again changed nothing.
 */
export const ADD_THE_SEAT =
  'add it — an extra builder with Add a builder in Settings → GitHub accounts, any other as an entry in config/bots.yaml and then `fleetadlc up` — then restore again';

export interface HistoryPlan {
  threads: number;
  messages: number;
  audit: number;
  ledger: number;
  requests: number;
  /**
   * Files given to the crew. Every one the archive holds is written, pointing
   * at its request or message only when the restore brought that too.
   */
  attachments: number;
  /** Threads, their messages and ledger rows of a seat this install does not have, which are left out. */
  skipped: number;
}

export interface RestorePlan {
  secrets: {
    overwrite: string[];
    create: string[];
    /**
     * A ref the archive holds under another name, by the ref it is written as:
     * a bot's own secret, going to the name the bot in its seat has here.
     */
    from: Record<string, string>;
    /**
     * GitHub credentials this install holds for an account the archive
     * replaces. Deleted rather than left behind: see
     * `credentialsForReplacedAccounts`.
     */
    remove: string[];
    /**
     * Refresh tokens an archive carries without its maker having chosen the
     * sign-ins — one written before that was a choice. Not written back, and
     * named so the operator sees that.
     */
    stale: string[];
    /** Refs never written back: the internal API secret, which each install makes for itself. */
    skipped: string[];
  };
  settings: { overwrite: SettingKey[]; create: SettingKey[]; unknown: string[] };
  bots: {
    /** Has no account connected, and the archive knows which one it was. */
    connect: { name: string; login: string }[];
    /** Connected to a different account than the archive recorded. */
    replace: { name: string; from: string; to: string }[];
    unchanged: string[];
    /** In the archive but not in this install, so there is no row to update. */
    absent: string[];
    /**
     * Has an account in the archive, and this restore will not leave it a
     * GitHub credential that works — its sign-in was not in the archive.
     */
    deviceFlow: { name: string; login: string }[];
    /**
     * Whose sign-in comes back: a token for its account, and the record of it
     * when the archive has one. Every seat on a shared account is here, each
     * with the one name the account's sign-in is filed under.
     */
    signIns: { name: string; seat: string; login: string; ns: string }[];
    /** Who will hold a credential and so takes its account's handle as its name. */
    rename: { name: string; to: string }[];
    /** The model assignment each gets back: the model, the engine, the account. */
    assign: { name: string; engine: string; model: string; modelAccountId: string | null; modelSetAt: string | null }[];
    /** Whose assignment stays as this install has it, and why. */
    keep: { name: string; reason: string }[];
    /** Whose avatar gets back the color and avatar a person chose. Absent from a plan made before either was kept. */
    looks?: { name: string; color: string | null; avatar: string | null }[];
  };
  /**
   * The GitHub accounts the restored seats sign in as, and where each is
   * filed here: written so seats that shared an account share it again, and
   * the bridge finds its sign-in where this restore puts it.
   */
  identities: { login: string; githubUserId: number | null; ns: string; names: string[] }[];
  /** By full name. */
  repositories: { overwrite: string[]; create: string[]; owners: Record<string, string | null> };
  accounts: { overwrite: string[]; create: string[] };
  logins: { overwrite: string[]; create: string[] };
  /** The spending caps the archive sets, each in words with its amount. Empty when it carries none. */
  spendingLimits: string[];
  history: HistoryPlan | null;
}

/**
 * Whether the archive would make a bot a different GitHub account from the one
 * this install has it as.
 *
 * Compared without case, the way onboarding compares them: GitHub answers with
 * the canonical casing, so `FleetADLC-Atlas` and `fleetadlc-atlas` are one account, and
 * telling them apart here would delete a working token over a capital letter.
 */
function changesAccount(live: string | null | undefined, archived: string): boolean {
  return live !== undefined && live !== null && !sameLogin(live, archived);
}

/** The refs this restore writes, under the names they are written as. */
function writtenRefs(
  contents: Pick<BackupContents, 'secrets' | 'bots' | 'manifest' | 'identities'>,
  current: InstallShape,
): Set<string> {
  const movedTo = restoredSecretRefs(contents, current);
  const written = new Set<string>();
  for (const ref of Object.keys(contents.secrets)) {
    if (restorable(ref, contents) === 'write') written.add(movedTo.get(ref) ?? ref);
  }
  return written;
}

/**
 * The GitHub credentials this install holds for an account the restore replaces.
 *
 * Rewriting a bot's login does not change whose token it holds. The broker
 * reads `github-refresh-<bot>` before anything else, so a token left behind for
 * the old account would go on acting — as that account, under the new one's
 * name. So both kinds go when the account changes, unless the archive puts its
 * own in their place. A ref this install does not hold is not named, because
 * there is nothing to delete; nor is a shared account's while a seat this
 * restore does not move off it still signs in as it.
 */
export function credentialsForReplacedAccounts(
  contents: Pick<BackupContents, 'secrets' | 'bots'> & Partial<Pick<BackupContents, 'manifest' | 'identities'>>,
  current: InstallShape,
): string[] {
  const have = new Set(current.secretRefs);
  const written = writtenRefs({ ...contents, manifest: contents.manifest ?? UNCHOSEN }, current);
  const leaving = new Set<string>();
  for (const bot of contents.bots) {
    const live = bot.githubLogin ? restoredOnto(bot, current) : undefined;
    if (live && bot.githubLogin && changesAccount(live.githubLogin, bot.githubLogin)) leaving.add(live.name);
  }
  const remove = new Set<string>();

  for (const name of leaving) {
    const ns = signInNsHere(current, name);
    const staying = (current.identities?.find((identity) => identity.secretNs === ns)?.bots ?? []).filter((bot) => !leaving.has(bot));
    if (staying.length > 0) continue;
    // This install's own refs, under the name its account is filed under here.
    for (const ref of [refreshTokenRef(ns), accessTokenRef(ns)]) {
      if (have.has(ref) && !written.has(ref)) remove.add(ref);
    }
  }

  return [...remove];
}

/**
 * Which bots have to sign in to GitHub again after this restore.
 *
 * Decided from what each bot will hold once the restore is done: what this
 * install has now, less what the restore deletes, plus what the archive writes.
 * A bot left holding either kind of token keeps working and is not named. One
 * whose account the archive replaces keeps nothing of the old account's, so it
 * is named unless the archive restores a token for the new one.
 *
 * A bot this install does not have is not named either. The restore skips it,
 * and the plan already says so with the remedy.
 */
export function botsNeedingDeviceFlow(
  contents: Pick<BackupContents, 'secrets' | 'bots'> & Partial<Pick<BackupContents, 'manifest' | 'identities'>>,
  current: InstallShape,
): { name: string; login: string }[] {
  const full = { ...contents, manifest: contents.manifest ?? UNCHOSEN };
  const removed = new Set(credentialsForReplacedAccounts(full, current));
  const after = new Set(current.secretRefs.filter((ref) => !removed.has(ref)));
  for (const ref of writtenRefs(full, current)) after.add(ref);
  const identities = restoredIdentities(full, current);
  const again: { name: string; login: string }[] = [];

  for (const bot of contents.bots) {
    const live = bot.githubLogin ? restoredOnto(bot, current) : undefined;
    if (!bot.githubLogin || !live) continue;
    // Where the seat's account is filed once restored: every seat on a shared
    // one looks in the same place.
    const ns = restoredIdentityOf(identities, live.slot)?.ns ?? live.name;
    if (after.has(refreshTokenRef(ns)) || after.has(accessTokenRef(ns))) continue;
    again.push({ name: live.name, login: bot.githubLogin });
  }

  return again;
}

/**
 * The model assignment an archived bot gets back, or why it keeps this
 * install's.
 *
 * Only an archive that recorded one has one to give: a version 1 archive
 * carried a bot's engine and model and nothing ever restored them. A bot is
 * never moved to or from thinking with no model — that is what a seat is, not
 * which model it runs — and an assignment to an account that is neither in the
 * archive nor here would point at nothing.
 */
function assignmentFor(
  bot: ArchivedBot,
  live: InstallShape['bots'][number],
  contents: Pick<BackupContents, 'manifest' | 'accounts'>,
  current: InstallShape,
): RestorePlan['bots']['assign'][number] | { name: string; reason: string } | null {
  if (contents.manifest.version < 2 || bot.model === null || bot.model.trim() === '') return null;
  // A seat that thinks with no model here and did there has nothing to be given.
  if (bot.engine === 'none' && live.engine === 'none') return null;
  // Nobody chose it: it came from config/bots.yaml, which this install reads
  // for itself — and puts back over anything unchosen at the next `fleetadlc up`.
  if (!bot.modelSetAt && !bot.modelAccountId) return null;
  // An engine a newer OpenADLC added is one this install cannot run.
  if (!(ENGINES as readonly string[]).includes(bot.engine)) {
    return { name: live.name, reason: `this version of OpenADLC does not know the engine ${bot.engine}` };
  }
  if (live.engine !== undefined && (live.engine === 'none') !== (bot.engine === 'none')) {
    return {
      name: live.name,
      reason:
        live.engine === 'none'
          ? 'this install’s seat thinks with no model, and the archive’s did'
          : 'this install’s seat thinks with a model, and the archive’s did not',
    };
  }
  const account = bot.modelAccountId ?? null;
  if (account && !(contents.accounts ?? []).some((one) => one.id === account) && !(current.accounts ?? []).includes(account)) {
    return { name: live.name, reason: 'its model account is not in the backup' };
  }
  return {
    name: live.name,
    engine: bot.engine,
    model: bot.model,
    modelAccountId: account,
    modelSetAt: bot.modelSetAt ?? null,
  };
}

/**
 * The color and avatar an archived bot gets back, when the archive recorded
 * them and they differ from this install's. A name this version of OpenADLC does
 * not draw is the default, as the store reads it, rather than a stored name
 * the console would draw as nothing.
 */
function lookFor(
  bot: ArchivedBot,
  live: InstallShape['bots'][number],
): { name: string; color: string | null; avatar: string | null } | null {
  if (!('color' in bot) && !('avatar' in bot)) return null;
  const color = 'color' in bot ? (isCrewColor(bot.color) ? bot.color : null) : (live.color ?? null);
  const avatar = 'avatar' in bot ? (isAvatar(bot.avatar) ? bot.avatar : null) : (live.avatar ?? null);
  if (color === (live.color ?? null) && avatar === (live.avatar ?? null)) return null;
  return { name: live.name, color, avatar };
}

/**
 * The seats whose color or avatar restoring `contents` writes: the same
 * decision as the plan's `bots.looks`, so an undo puts back exactly those.
 */
export function seatsWithRestoredLook(contents: Pick<BackupContents, 'bots'>, current: InstallShape): string[] {
  const seats: string[] = [];
  for (const bot of contents.bots) {
    const live = restoredOnto(bot, current);
    if (live && lookFor(bot, live)) seats.push(live.slot);
  }
  return seats;
}

/**
 * Exactly what a restore would change, decided before anything is written.
 *
 * The overwrite/create split is the whole point of `--dry-run`: an operator
 * restoring one lost bot needs to see that the archive is also about to put an
 * older App private key over the one this install is currently signing with.
 */
export function planRestore(contents: BackupContents, current: InstallShape): RestorePlan {
  const haveRef = new Set(current.secretRefs);
  const haveKey = new Set(current.settingKeys);
  const movedTo = restoredSecretRefs(contents, current);
  const written = writtenRefs(contents, current);
  const identities = restoredIdentities(contents, current);

  const plan: RestorePlan = {
    secrets: { overwrite: [], create: [], from: {}, remove: [], stale: [], skipped: [] },
    settings: { overwrite: [], create: [], unknown: [] },
    bots: {
      connect: [],
      replace: [],
      unchanged: [],
      absent: [],
      deviceFlow: [],
      signIns: [],
      rename: [],
      assign: [],
      looks: [],
      keep: [],
    },
    repositories: { overwrite: [], create: [], owners: {} },
    accounts: { overwrite: [], create: [] },
    logins: { overwrite: [], create: [] },
    spendingLimits: (contents.spendingLimits ?? [])
      .filter((cap) => cap.amountUsd != null)
      .map((cap) => `${spendingCapName(cap)}: ${spendingAmount(cap.amountUsd)}`),
    history: null,
    identities: identities.map((identity) => ({
      login: identity.login,
      githubUserId: identity.githubUserId,
      ns: identity.ns,
      names: identity.names,
    })),
  };

  for (const ref of Object.keys(contents.secrets).sort()) {
    const verdict = restorable(ref, contents);
    // An archive written before the sign-ins were a choice may still carry a
    // refresh token. Writing it back would put a token the live install has
    // since invalidated over whatever this install holds now.
    if (verdict === 'stale') {
      plan.secrets.stale.push(ref);
      continue;
    }
    if (verdict === 'never') {
      plan.secrets.skipped.push(ref);
      continue;
    }
    const target = movedTo.get(ref) ?? ref;
    if (target !== ref) plan.secrets.from[target] = ref;
    (haveRef.has(target) ? plan.secrets.overwrite : plan.secrets.create).push(target);
  }

  for (const key of Object.keys(contents.settings).sort()) {
    // An archive written by a newer install can carry a key this one has never
    // heard of. Reported and skipped: `setSetting` only takes the closed list.
    if (!settings.isSettingKey(key)) {
      plan.settings.unknown.push(key);
      continue;
    }
    (haveKey.has(key) ? plan.settings.overwrite : plan.settings.create).push(key);
  }

  for (const bot of contents.bots) {
    const existing = restoredOnto(bot, current);

    if (existing) {
      const assignment = assignmentFor(bot, existing, contents, current);
      if (assignment && 'reason' in assignment) plan.bots.keep.push(assignment);
      else if (assignment) plan.bots.assign.push(assignment);
      const look = lookFor(bot, existing);
      if (look) plan.bots.looks!.push(look);
    }

    // A bot the archive has no account for tells us nothing more worth writing.
    if (!bot.githubLogin) continue;

    // Found by seat, and named here by what it is called in this install.
    // Only what the archive holds is restorable: a seat this install does not
    // have has no row to put a login on (`ADD_THE_SEAT` says how to make one).
    if (!existing) {
      plan.bots.absent.push(bot.name);
      continue;
    }
    // Without case, as `changesAccount` compares them: one account either way.
    if (sameLogin(existing.githubLogin, bot.githubLogin)) plan.bots.unchanged.push(existing.name);
    else if (existing.githubLogin === null) plan.bots.connect.push({ name: existing.name, login: bot.githubLogin });
    else plan.bots.replace.push({ name: existing.name, from: existing.githubLogin, to: bot.githubLogin });

    // A sign-in comes back when a token for it does. Its record — the row the
    // console reads — comes with the token and never without it: a row saying
    // "active" over nothing would count the bot as connected when it cannot act.
    const ns = restoredIdentityOf(identities, existing.slot)?.ns ?? existing.name;
    if (written.has(refreshTokenRef(ns)) || written.has(accessTokenRef(ns))) {
      plan.bots.signIns.push({ name: existing.name, seat: existing.slot, login: bot.githubLogin, ns });
    }
  }

  plan.secrets.remove = credentialsForReplacedAccounts(contents, current);
  plan.bots.deviceFlow = botsNeedingDeviceFlow(contents, current);

  // Everyone who will hold a credential goes by the name the bridge gives a
  // connected bot once the restore is done: its account's handle, or its
  // seat's when it shares the account with other seats.
  const needing = new Set(plan.bots.deviceFlow.map((bot) => bot.name));
  for (const bot of contents.bots) {
    const existing = bot.githubLogin ? restoredOnto(bot, current) : undefined;
    if (!existing || !bot.githubLogin || needing.has(existing.name)) continue;
    const identity = restoredIdentityOf(identities, existing.slot);
    const to = identity ? restoredName(identity, existing.slot) : nameForLogin(bot.githubLogin);
    if (existing.name !== to) plan.bots.rename.push({ name: existing.name, to });
  }

  // By full name: the short name of one repository here is another's
  // elsewhere, and matching by it said `overwrite widgets` of a restore that
  // wrote other/widgets over acme/widgets' row. One whose name another
  // repository here has is refused before anything is asked.
  const haveRepos = new Set(current.repositories ?? []);
  const named = current.repositoryNames;
  for (const repo of contents.repositories ?? []) {
    const namesake = named ? namesakeOf(repo, named) : undefined;
    if (namesake) throw new BackupError(repositoryNameTaken(repo.fullName, namesake));
    const here = named
      ? named.some((one) => !one.removed && one.fullName.toLowerCase() === repo.fullName.toLowerCase())
      : haveRepos.has(repo.name);
    (here ? plan.repositories.overwrite : plan.repositories.create).push(repo.fullName);
    const owner = repo.ownerSeat ? current.bots.find((bot) => bot.slot === repo.ownerSeat) : undefined;
    plan.repositories.owners[repo.fullName] = owner?.name ?? null;
  }

  const haveAccounts = new Set(current.accounts ?? []);
  for (const account of contents.accounts ?? []) {
    (haveAccounts.has(account.id) ? plan.accounts.overwrite : plan.accounts.create).push(account.id);
  }

  const haveLogins = new Set(current.logins ?? []);
  for (const id of Object.keys(contents.logins ?? {}).sort()) {
    if (!(contents.accounts ?? []).some((account) => account.id === id) && !haveAccounts.has(id)) continue;
    (haveLogins.has(id) ? plan.logins.overwrite : plan.logins.create).push(id);
  }

  if (contents.history) {
    const seats = new Set(current.bots.map((bot) => bot.slot));
    const threads = contents.history.threads.filter((thread) => seats.has(thread.seat));
    const kept = new Set(threads.map((thread) => thread.id));
    const ledger = contents.history.ledger.filter((row) => seats.has(row.seat));
    const messages = contents.history.messages.filter((message) => kept.has(message.threadId));
    // Only the requests a restore writes, so the summary and the audit entry
    // count what was written.
    const requests = contents.history.requests.filter((request) => RESTORED_REQUEST_STATES.has(request.state));
    plan.history = {
      threads: threads.length,
      messages: messages.length,
      audit: contents.history.audit.length,
      ledger: ledger.length,
      requests: requests.length,
      attachments: contents.history.attachments?.length ?? 0,
      skipped:
        contents.history.threads.length -
        threads.length +
        (contents.history.ledger.length - ledger.length) +
        (contents.history.messages.length - messages.length) +
        (contents.history.requests.length - requests.length),
    };
  }

  return plan;
}

/** How many writes and deletions the plan amounts to, which decides whether to ask at all. */
export function changeCount(plan: RestorePlan): number {
  const history = plan.history
    ? plan.history.threads +
      plan.history.messages +
      plan.history.audit +
      plan.history.ledger +
      plan.history.requests +
      plan.history.attachments
    : 0;
  return (
    plan.secrets.remove.length +
    plan.secrets.overwrite.length +
    plan.secrets.create.length +
    plan.settings.overwrite.length +
    plan.settings.create.length +
    plan.bots.connect.length +
    plan.bots.replace.length +
    plan.bots.assign.length +
    (plan.bots.looks?.length ?? 0) +
    plan.bots.signIns.length +
    plan.repositories.overwrite.length +
    plan.repositories.create.length +
    plan.accounts.overwrite.length +
    plan.accounts.create.length +
    plan.logins.overwrite.length +
    plan.logins.create.length +
    plan.spendingLimits.length +
    history
  );
}
