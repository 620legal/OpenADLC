import { accessTokenRef, appPrivateKeyRef, engineKeyRef, modelAccountRef, refreshTokenRef, registryTokenRef, signingKeyRef, webhookSecretRef } from '@fleetadlc/github';
import type { ArchivedAccount, ArchivedBot, ArchivedCredential, ArchivedRepository, ArchivedSpendingLimit, BackupContents } from './archive.js';
import type { HistoryIds, RestoreDb } from './apply.js';
import type { Comparison } from './compare.js';
import { itemsOf, taken } from './compare.js';
import { ATTRIBUTION_KEY_REF, mergedAttributionKeys, signsInByFolder } from './contents.js';
import {
  archivedIdentities,
  archivedSeat,
  restoredIdentities,
  restoredIdentityOf,
  seatsWithRestoredLook,
  signInNsHere,
  type InstallShape,
} from './plan.js';
import {
  gitHubSignInKey,
  takeOverSignIns,
  type SignIn,
  type TakeOverPorts,
  type TakeOverResult,
  type TakeOverTarget,
} from './signins.js';

/**
 * Undoing a restore into an install that was already set up.
 *
 * Before such a restore writes anything, the whole install is backed up —
 * sign-ins, history and all — and what the restore is about to touch is
 * written down: settings by key, the app's secrets, seats, repositories by
 * full name, model accounts by id, and afterwards the history rows it added.
 * For a day, Undo puts exactly those back from that backup and takes away
 * what the restore added: a setting it set is set back or cleared, a seat gets
 * back its account, its model, its keys and its color and avatar, a repository
 * it added is removed from OpenADLC again, a model account it added is
 * removed, and the history rows it added are deleted. The key the crew's posts
 * are signed with goes back to this install's own, and the archive's is kept
 * among the retired keys that still check, so a post signed between the
 * restore and the undo still verifies. Nothing the restore did not touch is
 * looked at.
 *
 * The sign-ins it puts back are checked like any restore's: one the same as
 * here needs nothing, a key or token must still work, and a GitHub or
 * subscription sign-in is taken back by using it. One that no longer works is
 * not written over the one here that does — the undo says so instead.
 */

/** How long a restore can be undone. */
export const UNDO_FOR_MS = 24 * 60 * 60 * 1000;

/** Which parts of a seat a restore changed. An undo puts back those and nothing else of it. */
export interface SeatTouched {
  seat: string;
  account: boolean;
  model: boolean;
  signIn: boolean;
}

/** What a restore touched, by name: all an undo reads besides the backup taken before it. */
export interface RestoreJournal {
  id: string;
  restoredAt: string;
  /** When Undo stops being offered. */
  until: string;
  actor: string;
  /** When the archive that was restored was made. */
  backupMadeAt: string;
  settings: string[];
  /**
   * Which of `settings` the settings table held before the restore. The
   * backup Undo reads has the environment's values beside the stored ones,
   * so a key this lists not is cleared rather than set: set, it pinned the
   * environment's value over install.json for good. Absent from a journal
   * written before this was kept, which sets every one back as it was.
   */
  storedSettings?: string[];
  /**
   * The install's own secrets it wrote: the App's key and webhook secret, the
   * registry token, and the key the crew's posts are signed with
   * (`attribution-key`).
   */
  install: string[];
  /** Seats it changed, and which parts of each: the account and its signing key, the model and its key, the sign-in. */
  seats: SeatTouched[];
  /** Repositories it wrote, by full name. */
  repositories: string[];
  /** Model accounts whose row it wrote. */
  accounts: string[];
  /** Model accounts whose key, token or sign-in it wrote or took over. */
  accountCredentials: string[];
  /** The history rows it added. Null until the restore has written them. */
  history: HistoryIds | null;
  /**
   * Whether the restore replaced the spending caps. Absent from a journal
   * written before undo put them back, which leaves the table as the restore
   * wrote it.
   */
  spending?: boolean;
  /**
   * Seats whose color or avatar it wrote. Absent from a journal written
   * before undo put them back, which leaves them as the restore set them.
   */
  looks?: string[];
}

/** The journal of a restore about to write `chosen` with these choices. */
export function journalOf(input: {
  id: string;
  now: Date;
  actor: string;
  contents: BackupContents;
  chosen: BackupContents;
  comparison: Comparison;
  choices: Record<string, boolean>;
  /** The keys the settings table holds now (`InstallShape.settingKeys`). */
  storedSettings?: readonly string[];
  /** The install as it is now, which says whose color or avatar the restore changes. */
  shape?: InstallShape;
}): RestoreJournal {
  const { comparison, choices, chosen } = input;
  const seats = new Map<string, SeatTouched>();
  const touch = (seat: string, part: 'account' | 'model' | 'signIn') => {
    const found = seats.get(seat) ?? { seat, account: false, model: false, signIn: false };
    found[part] = true;
    // A seat that changes account lets go of the sign-in it had.
    if (part === 'account') found.signIn = true;
    seats.set(seat, found);
  };
  const accountCredentials = new Set<string>();
  for (const one of itemsOf(comparison)) {
    if (!taken(comparison, choices, one.key) || one.state === 'same') continue;
    // A shared account's sign-in touches every seat on it.
    if (one.group === 'sign-ins') for (const seat of one.seats ?? (one.seat ? [one.seat] : [])) touch(seat, 'signIn');
    if (!one.seat) continue;
    if (one.key === `seat:${one.seat}:account`) touch(one.seat, 'account');
    else if (one.key === `seat:${one.seat}:model`) touch(one.seat, 'model');
  }
  for (const one of itemsOf(comparison)) {
    if (one.group === 'sign-ins' && one.key.startsWith('signin:account:') && taken(comparison, choices, one.key)) {
      accountCredentials.add(one.key.slice('signin:account:'.length));
    }
  }
  return {
    id: input.id,
    restoredAt: input.now.toISOString(),
    until: new Date(input.now.getTime() + UNDO_FOR_MS).toISOString(),
    actor: input.actor,
    backupMadeAt: input.contents.manifest.createdAt,
    settings: Object.keys(chosen.settings).sort(),
    ...(input.storedSettings
      ? { storedSettings: Object.keys(chosen.settings).filter((key) => input.storedSettings?.includes(key)).sort() }
      : {}),
    // The webhook secret too when an older archive had it as a setting: the
    // restore writes that into the secret store (`applyRestore`).
    install: [appPrivateKeyRef(), webhookSecretRef(), registryTokenRef(), ATTRIBUTION_KEY_REF].filter(
      (ref) => chosen.secrets[ref] !== undefined || (ref === webhookSecretRef() && chosen.settings.webhookSecret !== undefined),
    ),
    seats: [...seats.values()].sort((a, b) => a.seat.localeCompare(b.seat)),
    repositories: (chosen.repositories ?? []).map((repo) => repo.fullName),
    accounts: (chosen.accounts ?? []).map((account) => account.id),
    accountCredentials: [...accountCredentials].sort(),
    history: null,
    spending: chosen.spendingLimits !== undefined,
    ...(input.shape ? { looks: seatsWithRestoredLook(chosen, input.shape) } : {}),
  };
}

/** Whether an undo is still on offer. */
export function undoOpen(journal: Pick<RestoreJournal, 'until'>, now: Date): boolean {
  return Date.parse(journal.until) > now.getTime();
}

// ------------------------------------------------------------------ the plan

/** What each touched seat goes back to: only the parts the restore changed. */
export interface SeatUndo {
  seat: string;
  /** What the bot in the seat is called now. */
  name: string;
  /** Its account as it was, when the restore changed it; undefined when it did not. */
  login?: string | null;
  /**
   * The GitHub account it goes back on, and the name that account's sign-in
   * is filed under here — the one its sign-in is taken back to — when the
   * restore changed its account and it had one.
   */
  identity?: { login: string; githubUserId: number | null; secretNs: string };
  /** Its model as it was, when the restore changed it. */
  assignment?: { engine: string; model: string; modelAccountId: string | null; modelSetAt: string | null };
  /**
   * The record of a sign-in it had no token for — one GitHub had refused or
   * that had expired — put back as it was: a record that is not active counts
   * nobody as connected, and says the bot needs reconnecting.
   */
  record?: ArchivedCredential;
}

export interface UndoPlan {
  settings: { set: Record<string, string>; clear: string[] };
  /** Secrets that are not sign-ins, under the names they have now: the App's key, signing keys, engine keys. */
  secrets: { set: Record<string, string>; remove: string[] };
  seats: SeatUndo[];
  /** `over`: the full name of the row a restore wrote this one over, which it goes back into. */
  repositories: { put: { repo: ArchivedRepository; owner: string | null; over?: string }[]; remove: string[] };
  accounts: { put: ArchivedAccount[]; remove: string[] };
  /**
   * The backup of this install, cut down to the sign-ins the restore replaced:
   * judged and put back the way any restore puts a sign-in back.
   */
  signIns: BackupContents;
  /** Sign-ins the restore added where there were none: taken away. */
  drop: { refs: string[]; credentials: string[]; folders: string[] };
  history: HistoryIds | null;
  /** The caps as they were, when the restore replaced them. Absent when it did not. */
  spendingLimits?: ArchivedSpendingLimit[];
  /** Each bot's color and avatar as they were, where the restore wrote them; null for the default. */
  looks: { name: string; color: string | null; avatar: string | null }[];
}

function botFor(contents: BackupContents, seat: string): ArchivedBot | undefined {
  return contents.bots.find((bot) => archivedSeat(bot) === seat);
}

/**
 * What an undo writes, decided from the backup taken before the restore, the
 * journal of what the restore touched, and the install as it is now.
 */
export function planUndo(snapshot: BackupContents, journal: RestoreJournal, shape: InstallShape): UndoPlan {
  const plan: UndoPlan = {
    settings: { set: {}, clear: [] },
    secrets: { set: {}, remove: [] },
    seats: [],
    repositories: { put: [], remove: [] },
    accounts: { put: [], remove: [] },
    signIns: { ...snapshot, secrets: {}, bots: [], accounts: [], logins: {}, repositories: [], history: null, settings: snapshot.settings },
    drop: { refs: [], credentials: [], folders: [] },
    history: journal.history,
    ...(journal.spending ? { spendingLimits: snapshot.spendingLimits ?? [] } : {}),
    looks: [],
  };

  for (const key of journal.settings) {
    const before = journal.storedSettings && !journal.storedSettings.includes(key) ? undefined : snapshot.settings[key];
    if (before !== undefined) plan.settings.set[key] = before;
    else plan.settings.clear.push(key);
  }

  for (const ref of journal.install) {
    const before = snapshot.secrets[ref];
    if (before !== undefined) plan.secrets.set[ref] = before;
    // An install with no signing key before the restore goes back to none,
    // and posts the crew signed since the restore stop checking with it.
    else plan.secrets.remove.push(ref);
  }

  for (const seat of journal.looks ?? []) {
    const live = shape.bots.find((bot) => bot.slot === seat);
    const before = botFor(snapshot, seat);
    if (live) plan.looks.push({ name: live.name, color: before?.color ?? null, avatar: before?.avatar ?? null });
  }

  // The accounts the touched seats were on before, found on this install as
  // any restore finds them: where each one's sign-in goes back to, which the
  // seats go back on with it.
  const beforeAccounts = archivedIdentities(snapshot);
  const touchedBots = journal.seats
    .filter((touched) => touched.account || touched.signIn)
    .map((touched) => botFor(snapshot, touched.seat))
    .filter((bot): bot is ArchivedBot => Boolean(bot?.githubLogin));
  const goingBack = restoredIdentities({ bots: touchedBots, identities: snapshot.identities, secrets: snapshot.secrets }, shape);
  plan.signIns.bots = touchedBots;
  // Seats whose sign-in the restore gave them where they had none: what they
  // sign in with now goes, unless a seat the undo leaves alone shares it.
  const dropping = new Set<string>();
  for (const touched of journal.seats) {
    const live = shape.bots.find((bot) => bot.slot === touched.seat);
    const account = beforeAccounts.find((one) => one.seats.includes(touched.seat));
    const had = account?.from && (snapshot.secrets[refreshTokenRef(account.from)] !== undefined || snapshot.secrets[accessTokenRef(account.from)] !== undefined);
    if (live && touched.signIn && !had) dropping.add(live.name);
  }

  for (const touched of journal.seats) {
    const live = shape.bots.find((bot) => bot.slot === touched.seat);
    if (!live) continue;
    const before = botFor(snapshot, touched.seat);
    const name = before?.name;
    const back = (ref: (bot: string) => string) => {
      const value = name !== undefined ? snapshot.secrets[ref(name)] : undefined;
      if (value !== undefined) plan.secrets.set[ref(live.name)] = value;
      else plan.secrets.remove.push(ref(live.name));
    };
    const seat: SeatUndo = { seat: touched.seat, name: live.name };
    if (touched.account) {
      seat.login = before?.githubLogin ?? null;
      back(signingKeyRef);
      const account = restoredIdentityOf(goingBack, touched.seat);
      if (seat.login && account) seat.identity = { login: account.login, githubUserId: account.githubUserId, secretNs: account.ns };
    }
    if (touched.model) {
      back(engineKeyRef);
      if (before && before.model !== null) {
        seat.assignment = {
          engine: before.engine,
          model: before.model,
          modelAccountId: before.modelAccountId ?? null,
          modelSetAt: before.modelSetAt ?? null,
        };
      }
    }
    plan.seats.push(seat);
    if (!touched.signIn) continue;
    if (!dropping.has(live.name)) {
      // Its account's, wherever the backup filed it: once for all its seats.
      const from = beforeAccounts.find((one) => one.seats.includes(touched.seat))?.from as string;
      for (const ref of [refreshTokenRef(from), accessTokenRef(from)]) {
        const value = snapshot.secrets[ref];
        if (value !== undefined) plan.signIns.secrets[ref] = value;
      }
    } else {
      // What it signs in with now, unless a seat this leaves alone signs in with it too.
      const ns = signInNsHere(shape, live.name);
      const others = shape.identities?.find((identity) => identity.secretNs === ns)?.bots.filter((bot) => !dropping.has(bot)) ?? [];
      if (others.length === 0) {
        for (const ref of [refreshTokenRef(ns), accessTokenRef(ns)]) if (!plan.drop.refs.includes(ref)) plan.drop.refs.push(ref);
      }
      if (before?.credential && before.credential.status !== 'active') seat.record = before.credential;
      else plan.drop.credentials.push(live.name);
    }
  }

  const owners = new Map(shape.bots.map((bot) => [bot.slot, bot.name]));
  const ownerOf = (repo: ArchivedRepository) => (repo.ownerSeat ? (owners.get(repo.ownerSeat) ?? null) : null);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const fullName of journal.repositories) {
    const before = snapshot.repositories?.find((repo) => same(repo.fullName, fullName));
    if (before) {
      plan.repositories.put.push({ repo: before, owner: ownerOf(before) });
      continue;
    }
    // Not here before, unless a restore from before repositories were found
    // by full name wrote it over another's row: that row goes back to the
    // repository it was. Removed instead, acme/widgets' row was marked
    // removed as other/widgets and acme could not be added again.
    const row = shape.repositoryNames?.find((one) => !one.removed && same(one.fullName, fullName));
    const overwritten = row ? snapshot.repositories?.find((repo) => same(repo.name, row.name) && !same(repo.fullName, fullName)) : undefined;
    if (overwritten) plan.repositories.put.push({ repo: overwritten, owner: ownerOf(overwritten), over: fullName });
    else plan.repositories.remove.push(fullName);
  }

  for (const id of journal.accounts) {
    const before = snapshot.accounts?.find((account) => account.id === id);
    if (before) plan.accounts.put.push(before);
    else plan.accounts.remove.push(id);
  }

  const signInAccounts: ArchivedAccount[] = [];
  for (const id of journal.accountCredentials) {
    const account = snapshot.accounts?.find((one) => one.id === id);
    const key = snapshot.secrets[modelAccountRef(id)];
    const folder = snapshot.logins?.[id];
    if (account && (key !== undefined || folder)) {
      signInAccounts.push(account);
      if (key !== undefined) plan.signIns.secrets[modelAccountRef(id)] = key;
      if (folder) (plan.signIns.logins as Record<string, typeof folder>)[id] = folder;
      continue;
    }
    plan.drop.refs.push(modelAccountRef(id));
    if (!account || signsInByFolder(account)) plan.drop.folders.push(id);
  }
  plan.signIns.accounts = signInAccounts;
  return plan;
}

// ------------------------------------------------------------------ carrying it out

/** The database half of an undo, besides a restore's: what only an undo takes away. */
export interface UndoDb extends RestoreDb {
  clearSetting(key: string): Promise<void>;
  /** Takes a repository out of OpenADLC again, as removing it from Settings does. */
  removeRepository(fullName: string): Promise<void>;
  /** Removes a model account, unless a bot still uses it: then says which. */
  removeAccount(id: string): Promise<string[]>;
  /** Takes the bot of this name off its GitHub account, and deletes the account once no other bot is on it. */
  releaseLogin(name: string): Promise<void>;
  deleteHistory(ids: HistoryIds): Promise<void>;
}

export interface UndoTarget extends Omit<TakeOverTarget, 'transaction'> {
  transaction<T>(fn: (db: UndoDb) => Promise<T>): Promise<T>;
  /** Forgets a subscription's sign-in folder, where hostd keeps it. */
  forgetLogin?(accountId: string): Promise<void>;
}

export interface UndoOutcome {
  /** Sign-ins put back, taken back by using them, or left as they are and why. */
  signIns: { key: string; who: string; state: 'restored' | 'taken-over' | 'same' | 'kept'; reason?: string }[];
  /** Model accounts the restore added that are still used, and so were kept. */
  keptAccounts: { id: string; usedBy: string[] }[];
  /**
   * Seats left on the account the restore gave them: the sign-in they had
   * before was not accepted when it was taken back, and the one they have now
   * works — a working sign-in is never put over by one that failed.
   */
  keptSeats: { seat: string; login: string | null; reason: string }[];
}

/** Whether the bot holds a GitHub sign-in now, wherever its account files it. */
async function holdsSignIn(target: UndoTarget, shape: InstallShape, name: string): Promise<boolean> {
  for (const ns of new Set([signInNsHere(shape, name), name])) {
    if ((await target.secrets.get(refreshTokenRef(ns))) !== null || (await target.secrets.get(accessTokenRef(ns))) !== null) return true;
  }
  return false;
}

/**
 * Puts the install back as the plan says, in the order a restore writes:
 * every row, and the secrets last, in one transaction whose secrets are put
 * back if it fails; then each sign-in the restore replaced, checked as any
 * restore checks one; then what could only go once nothing used it.
 *
 * A seat going back to its own account whose sign-in can only be taken back
 * by using it goes back with that sign-in or not at all: its account and its
 * signing key are put back once the sign-in has been taken back — or, when
 * GitHub refuses it, only if the seat holds no sign-in that works now. A seat
 * whose old sign-in was judged refused before anything is written stays on
 * its account the same way.
 */
export async function applyUndo(input: {
  plan: UndoPlan;
  /** The backup's sign-ins that the restore replaced, judged against the install as it is now. */
  signIns: readonly SignIn[];
  shape: InstallShape;
  target: UndoTarget;
  takeOver: TakeOverPorts;
  actor: string;
  journal: RestoreJournal;
}): Promise<UndoOutcome> {
  const { plan, target } = input;
  const outcome: UndoOutcome = { signIns: [], keptAccounts: [], keptSeats: [] };

  // What judging found written as it was — a key, a token, a non-expiring
  // GitHub token — goes in with the rows. What rotates is taken back after.
  const writes = new Map<string, string>(Object.entries(plan.secrets.set));
  // The crew's signing key the way a restore merges it, the other way round:
  // this install's own signs again, and the archive's, which signed what was
  // posted since the restore, is retired as of now rather than dropped.
  const keyring = writes.get(ATTRIBUTION_KEY_REF);
  if (keyring !== undefined) writes.set(ATTRIBUTION_KEY_REF, mergedAttributionKeys(keyring, await target.secrets.get(ATTRIBUTION_KEY_REF)));
  const credentials: { name: string; credential: ArchivedCredential; ref: string }[] = [];
  const takeBack: SignIn[] = [];
  /** Refs the transaction also deletes: another sign-in filed where one is put back. */
  const replaced = new Set<string>();
  /** Seats whose sign-in from before was refused, and why. */
  const refused = new Map<string, string>();
  const accounts = restoredIdentities(plan.signIns, input.shape);
  for (const signIn of input.signIns) {
    const { verdict } = signIn;
    if (verdict.state === 'same') {
      outcome.signIns.push({ key: signIn.key, who: signIn.who, state: 'same' });
    } else if (verdict.state === 'blocked') {
      outcome.signIns.push({ key: signIn.key, who: signIn.who, state: 'kept', reason: verdict.reason });
      for (const seat of signIn.seats) refused.set(seat, verdict.reason);
    } else if (verdict.state === 'check-by-use') {
      takeBack.push(signIn);
    } else if (signIn.accountId) {
      const value = plan.signIns.secrets[modelAccountRef(signIn.accountId)];
      if (value !== undefined) writes.set(modelAccountRef(signIn.accountId), value);
      outcome.signIns.push({ key: signIn.key, who: signIn.who, state: 'restored' });
    } else {
      // A non-expiring token, back where its account is filed, with each of
      // its seats' records pointing at it.
      const account = accounts.find((one) => gitHubSignInKey(one) === signIn.key);
      const value = account?.from ? plan.signIns.secrets[accessTokenRef(account.from)] : undefined;
      if (account && value !== undefined) {
        writes.set(accessTokenRef(account.ns), value);
        // The restored account's refresh token under the same name goes with
        // it: the broker reads a refresh token before a token, and the seat
        // went on acting as the restored account while recorded as this one.
        replaced.add(refreshTokenRef(account.ns));
        for (const [index, seat] of account.seats.entries()) {
          const credential = plan.signIns.bots.find((one) => archivedSeat(one) === seat)?.credential;
          if (credential) credentials.push({ name: account.names[index] as string, credential, ref: accessTokenRef(account.ns) });
        }
      }
      outcome.signIns.push({ key: signIn.key, who: signIn.who, state: 'restored' });
    }
  }

  // Seats whose account follows a sign-in still to be taken back: their
  // account and signing key wait for its answer.
  const deferred = plan.seats.filter((seat) => seat.login !== undefined && takeBack.some((one) => one.seats.includes(seat.seat)));
  const waiting = new Map<string, { signing: string | null }>();
  for (const seat of deferred) {
    const ref = signingKeyRef(seat.name);
    waiting.set(seat.seat, { signing: writes.get(ref) ?? null });
    writes.delete(ref);
  }
  const later = new Set(deferred.map((seat) => signingKeyRef(seat.name)));

  // Seats whose account went back to one whose sign-in was refused stay on
  // the account the restore gave them, when they hold a sign-in now: their
  // login, account, record and signing key are left as they are. Reverted,
  // the seat was recorded as the old account while its sign-in was the new
  // one's, so its posts were not recognised as the crew's.
  const stay = new Set<string>();
  const stayingNames = new Set<string>();
  for (const seat of plan.seats) {
    const reason = refused.get(seat.seat);
    if (seat.login === undefined || reason === undefined) continue;
    if (!(await holdsSignIn(target, input.shape, seat.name))) continue;
    stay.add(seat.seat);
    stayingNames.add(seat.name);
    const ref = signingKeyRef(seat.name);
    writes.delete(ref);
    later.add(ref);
    outcome.keptSeats.push({ seat: seat.seat, login: input.shape.bots.find((one) => one.slot === seat.seat)?.githubLogin ?? null, reason });
  }
  const removals = [...plan.secrets.remove, ...plan.drop.refs, ...replaced].filter(
    (ref, index, all) => !writes.has(ref) && !later.has(ref) && all.indexOf(ref) === index,
  );

  const before = new Map<string, string | null>();
  for (const ref of new Set([...writes.keys(), ...removals])) before.set(ref, await target.secrets.get(ref));

  try {
    await target.transaction(async (db) => {
      for (const [key, value] of Object.entries(plan.settings.set)) await db.setSetting(key, value);
      for (const key of plan.settings.clear) await db.clearSetting(key);
      for (const account of plan.accounts.put) await db.putAccount(account, { keepCheck: true });
      // A repository that cannot be put back fails the whole undo, and the
      // backup it reads from stays for another try.
      for (const { repo, owner, over } of plan.repositories.put) await db.putRepository(repo, owner, over ? { over } : undefined);
      for (const fullName of plan.repositories.remove) await db.removeRepository(fullName);
      if (plan.spendingLimits) await db.replaceSpendingLimits(plan.spendingLimits);
      for (const seat of plan.seats) {
        if (!waiting.has(seat.seat) && !stay.has(seat.seat)) {
          if (seat.login) await db.setBotLogin(seat.name, seat.login);
          else if (seat.login === null) await db.releaseLogin(seat.name);
          if (seat.login && seat.identity) await db.putIdentity(seat.identity, [seat.name]);
        }
        if (seat.assignment) await db.setAssignment(seat.name, seat.assignment);
      }
      for (const look of plan.looks) await db.setLook(look.name, { color: look.color, avatar: look.avatar });
      for (const name of plan.drop.credentials) await db.deleteCredential(name);
      for (const seat of plan.seats) {
        if (seat.record && !stay.has(seat.seat)) await db.putCredential(seat.name, seat.record, refreshTokenRef(seat.identity?.secretNs ?? seat.name));
      }
      for (const one of credentials) {
        if (!stayingNames.has(one.name)) await db.putCredential(one.name, one.credential, one.ref);
      }
      if (plan.history) await db.deleteHistory(plan.history);
      await db.audit({
        actor: input.actor,
        action: 'install.restore_undone',
        target: 'install',
        // What went back, by name. Never a value.
        payload: {
          restoredAt: input.journal.restoredAt,
          settings: input.journal.settings,
          seats: input.journal.seats.map((seat) => seat.seat),
          repositories: input.journal.repositories,
          accounts: input.journal.accounts,
        },
      });
      for (const ref of removals) await target.secrets.delete(ref);
      for (const [ref, value] of writes) await target.secrets.set(ref, value);
    });
  } catch (error) {
    for (const [ref, value] of before) {
      await (value === null ? target.secrets.delete(ref) : target.secrets.set(ref, value)).catch(() => undefined);
    }
    throw error;
  }

  const results: TakeOverResult[] = await takeOverSignIns({
    contents: plan.signIns,
    signIns: takeBack,
    shape: input.shape,
    target: {
      secrets: target.secrets,
      transaction: (fn) => target.transaction((db) => fn(db)),
      ...(target.forgetCheck ? { forgetCheck: target.forgetCheck } : {}),
      ...(target.recordCheck ? { recordCheck: target.recordCheck } : {}),
    },
    ports: input.takeOver,
    actor: input.actor,
  });
  for (const result of results) {
    const signIn = takeBack.find((one) => one.key === result.key);
    outcome.signIns.push({
      key: result.key,
      who: signIn?.who ?? result.key,
      state: result.state === 'taken-over' ? 'taken-over' : 'kept',
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }

  for (const seat of deferred) {
    const result = results.find((one) => takeBack.find((signIn) => signIn.key === one.key)?.seats.includes(seat.seat));
    const takenBack = result?.state === 'taken-over';
    if (!takenBack) {
      if (await holdsSignIn(target, input.shape, seat.name)) {
        outcome.keptSeats.push({
          seat: seat.seat,
          login: input.shape.bots.find((one) => one.slot === seat.seat)?.githubLogin ?? null,
          reason: result?.reason ?? 'the sign-in it had before was not accepted',
        });
        continue;
      }
    }
    // Back to its own account, with its signing key — and, when its sign-in
    // could not be taken back, the record of how that sign-in last stood.
    const record = takenBack ? undefined : plan.signIns.bots.find((one) => archivedSeat(one) === seat.seat)?.credential;
    const signing = waiting.get(seat.seat)?.signing ?? null;
    const signingRef = signingKeyRef(seat.name);
    const was = await target.secrets.get(signingRef);
    try {
      await target.transaction(async (db) => {
        if (seat.login) await db.setBotLogin(seat.name, seat.login);
        else await db.releaseLogin(seat.name);
        if (seat.login && seat.identity) await db.putIdentity(seat.identity, [seat.name]);
        if (record && record.status !== 'active') {
          await db.putCredential(seat.name, record, refreshTokenRef(seat.identity?.secretNs ?? seat.name));
        }
        if (signing === null) await target.secrets.delete(signingRef);
        else await target.secrets.set(signingRef, signing);
      });
    } catch (error) {
      await (was === null ? target.secrets.delete(signingRef) : target.secrets.set(signingRef, was)).catch(() => undefined);
      throw error;
    }
  }

  // Last, once no seat names them any more.
  for (const id of plan.accounts.remove) {
    const usedBy = await target.transaction((db) => db.removeAccount(id));
    if (usedBy.length > 0) outcome.keptAccounts.push({ id, usedBy });
  }
  for (const id of plan.drop.folders) await target.forgetLogin?.(id).catch(() => undefined);
  return outcome;
}
