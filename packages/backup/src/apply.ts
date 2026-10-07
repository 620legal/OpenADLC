import { accessTokenRef, modelAccountRef, refreshTokenRef, webhookSecretRef } from '@fleetadlc/github';
import type { ArchivedAccount, ArchivedCredential, ArchivedHistory, ArchivedRepository, ArchivedSpendingLimit, BackupContents } from './archive.js';
import { ATTRIBUTION_KEY_REF, mergedAttributionKeys, signsInByFolder } from './contents.js';
import { archivedSeat, type RestorePlan } from './plan.js';
import type { HistoryCounts } from './summary.js';

/**
 * Carrying out a restore plan: exactly what it says, in an order that leaves
 * nothing half-written.
 *
 * Every row goes in one transaction, and the secrets are written inside it, at
 * the end: if a secret cannot be written the rows are rolled back, and if the
 * rows cannot be written no secret is left behind — each one is put back as it
 * was before the restore began.
 *
 * A plan only ever holds sign-ins that were judged and chosen: `runRestore`
 * takes every other one out of the archive before it is planned. A sign-in
 * that rotates is never written from here at all — it is checked by using it,
 * and taken over, after this (`takeOverSignIns`) — and nor are the renames
 * that follow a bot's sign-in, which come last.
 */

/** The database half of a restore, all inside one transaction. Bots are named as they are called here now. */
export interface RestoreDb {
  setSetting(key: string, value: string): Promise<void>;
  /** Replaces the spending caps. Called only when the archive carried the list, restoring onto a clean install, and by Undo. */
  replaceSpendingLimits(rows: ArchivedSpendingLimit[]): Promise<void>;
  /**
   * Sets each cap these rows name and deletes none, under the lock saving
   * from Settings takes, with a `spending.limit_changed` audit row for each
   * one it changes. Refuses, with a BackupError naming it, a repository cap
   * that would end above the global one of its kind.
   */
  mergeSpendingLimits(rows: ArchivedSpendingLimit[], actor: string): Promise<void>;
  /** The row, with its last check kept only when the credential it checked came back with it. */
  putAccount(account: ArchivedAccount, options: { keepCheck: boolean }): Promise<void>;
  /**
   * The repository's row, found by its full name and written by id. One with
   * no row of its own whose name another repository here has is refused with
   * a BackupError: written over that row, it took the other's issues and
   * tasks. `over` names the full name of a row an earlier restore wrote it
   * over, which Undo puts it back into.
   */
  putRepository(repo: ArchivedRepository, ownerName: string | null, options?: { over?: string }): Promise<void>;
  /**
   * Which account a bot is. Any other row that merely names the account lets
   * go of it first; one that shares it — on the same identity — keeps it.
   */
  setBotLogin(name: string, login: string): Promise<void>;
  /**
   * Puts these bots on a GitHub account (`github_identities`), filed under
   * `secretNs` unless this install has the account already, which keeps the
   * name it has. Seats that shared an account share it again; an account one
   * of them leaves that nobody else uses is let go.
   */
  putIdentity(identity: { login: string; githubUserId: number | null; secretNs: string }, names: readonly string[]): Promise<void>;
  setAssignment(
    name: string,
    assignment: { engine: string; model: string; modelAccountId: string | null; modelSetAt: string | null },
  ): Promise<void>;
  /** How a bot's avatar looks: the color and the avatar a person chose, null for the default. */
  setLook(name: string, look: { color: string | null; avatar: string | null }): Promise<void>;
  /** The record of a bot's sign-in, pointing at the secret it is kept under. */
  putCredential(name: string, credential: ArchivedCredential, secretRef: string): Promise<void>;
  /** Forgets the record of a bot's sign-in: the account it was for is not the bot's any more. */
  deleteCredential(name: string): Promise<void>;
  /**
   * Threads, messages, the audit log, the ledger and requests, found by seat
   * and repository name. Added beside what is there, never over it; what was
   * added is named by id, so an undo can take exactly that away again.
   */
  putHistory(history: ArchivedHistory): Promise<HistoryCounts & { ids?: HistoryIds }>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
}

/** The rows a restore added to the history, by id. */
export interface HistoryIds {
  threads: string[];
  messages: string[];
  requests: string[];
  audit: string[];
  ledger: string[];
  /** Absent from an undo written before attachments were restored. */
  attachments?: string[];
}

export interface RestoreTarget {
  secrets: {
    get(ref: string): Promise<string | null>;
    set(ref: string, value: string): Promise<void>;
    delete(ref: string): Promise<void>;
  };
  /** Runs `fn` in one database transaction, committed only when it resolves. */
  transaction<T>(fn: (db: RestoreDb) => Promise<T>): Promise<T>;
  /** Forgets an account's last check, when the sign-in it was about did not come back. */
  forgetCheck?(accountId: string): Promise<void>;
  /** Records that an account's sign-in was just checked and answered. */
  recordCheck?(accountId: string, checkedAt: string): Promise<void>;
  /** Renames a bot through the one routine that renames bots. Absent, the bridge does it when it next starts. */
  rename?(input: { name: string; to: string; reason: string }): Promise<{ state: string; reason?: string }>;
}

export interface RestoreOutcome {
  secrets: string[];
  deleted: string[];
  settings: string[];
  repositories: string[];
  accounts: string[];
  bots: { logins: string[]; assignments: string[]; signIns: string[] };
  history: (HistoryCounts & { ids?: HistoryIds }) | null;
}

/**
 * Whether an account's last check still describes it once restored: only
 * when the credential that check was about came back too.
 */
function checkTravels(account: ArchivedAccount, contents: BackupContents): boolean {
  if (signsInByFolder(account)) return Boolean(contents.logins?.[account.id]);
  return contents.secrets[modelAccountRef(account.id)] !== undefined;
}

export async function applyRestore(
  contents: BackupContents,
  plan: RestorePlan,
  target: RestoreTarget,
  options: {
    actor: string;
    auditAction?: string;
    /**
     * How the archive's caps are written: in place of the table, onto a clean
     * install; or cap by cap over this install's, keeping the rest, into one
     * that is set up.
     */
    spending?: 'replace' | 'merge';
  } = { actor: 'fleetadlc restore' },
): Promise<RestoreOutcome> {
  const writes = new Map<string, string>();
  for (const ref of [...plan.secrets.overwrite, ...plan.secrets.create]) {
    const archived = plan.secrets.from[ref] ?? ref;
    const value = contents.secrets[archived];
    if (value !== undefined) writes.set(ref, value);
  }
  // An archive from before the webhook secret moved to the secret store has
  // it as a setting. It goes into the store, where the bridge reads it: as a
  // row it would be in the database again, and the bridge's move at start
  // keeps a secret the store already has over it, which is not this app's.
  let settingsWritten = [...plan.settings.overwrite, ...plan.settings.create];
  const legacyHook = settingsWritten.includes('webhookSecret') ? contents.settings.webhookSecret : undefined;
  if (legacyHook !== undefined) {
    settingsWritten = settingsWritten.filter((key) => key !== 'webhookSecret');
    if (!writes.has(webhookSecretRef())) writes.set(webhookSecretRef(), legacyHook);
  }

  // What each secret was before, so a restore that fails part way can put it back.
  const before = new Map<string, string | null>();
  for (const ref of new Set([...plan.secrets.remove, ...writes.keys()])) before.set(ref, await target.secrets.get(ref));

  // The crew's signing key is merged, not written over: the archive's becomes
  // the one posts are signed with, and one this install had already made
  // stays among those that check, so nothing it signed turns into a stranger's.
  const keyring = writes.get(ATTRIBUTION_KEY_REF);
  if (keyring !== undefined) writes.set(ATTRIBUTION_KEY_REF, mergedAttributionKeys(keyring, before.get(ATTRIBUTION_KEY_REF) ?? null));

  const outcome: RestoreOutcome = {
    secrets: [...writes.keys()],
    deleted: [...plan.secrets.remove],
    settings: settingsWritten,
    repositories: [...plan.repositories.overwrite, ...plan.repositories.create],
    accounts: [...plan.accounts.overwrite, ...plan.accounts.create],
    bots: {
      logins: [...plan.bots.connect.map((bot) => bot.name), ...plan.bots.replace.map((bot) => bot.name)],
      assignments: plan.bots.assign.map((bot) => bot.name),
      signIns: plan.bots.signIns.map((bot) => bot.name),
    },
    history: null,
  };

  const accounts = new Map((contents.accounts ?? []).map((account) => [account.id, account]));
  const repositories = new Map((contents.repositories ?? []).map((repo) => [repo.fullName.toLowerCase(), repo]));
  // Each seat's own record, found by seat: seats on one account each have one,
  // with their own signing key, all pointing at the account's one sign-in.
  const credentials = new Map<string, ArchivedCredential>();
  for (const bot of contents.bots) {
    if (!bot.credential) continue;
    const signIn = plan.bots.signIns.find((one) => one.seat === archivedSeat(bot));
    if (signIn) credentials.set(signIn.name, bot.credential);
  }

  try {
    await target.transaction(async (db) => {
      for (const key of outcome.settings) {
        const value = contents.settings[key];
        if (value !== undefined) await db.setSetting(key, value);
      }
      // Before the bots, which reference them.
      for (const id of outcome.accounts) {
        const account = accounts.get(id);
        if (account) await db.putAccount(account, { keepCheck: checkTravels(account, contents) });
      }
      for (const fullName of outcome.repositories) {
        const repo = repositories.get(fullName.toLowerCase());
        if (repo) await db.putRepository(repo, plan.repositories.owners[fullName] ?? null);
      }
      // Names, not the ids the archive was taken from. The rows just written
      // are what those names are on this install.
      if (contents.spendingLimits) {
        if (options.spending === 'merge') await db.mergeSpendingLimits(contents.spendingLimits, options.actor);
        else await db.replaceSpendingLimits(contents.spendingLimits);
      }
      for (const bot of [
        ...plan.bots.connect,
        ...plan.bots.replace.map((entry) => ({ name: entry.name, login: entry.to })),
      ]) {
        await db.setBotLogin(bot.name, bot.login);
      }
      // Which account each seat is, and where its sign-in is filed: what the
      // bridge asks before it looks for a seat's sign-in.
      for (const identity of plan.identities) {
        await db.putIdentity({ login: identity.login, githubUserId: identity.githubUserId, secretNs: identity.ns }, identity.names);
      }
      // A bot made another account keeps no record of the old one's sign-in:
      // an active record over no token would count it as connected. One for
      // the new account comes with its token, here or when it is taken over.
      const signingIn = new Set(plan.bots.signIns.map((bot) => bot.name));
      for (const bot of plan.bots.replace) {
        if (!signingIn.has(bot.name)) await db.deleteCredential(bot.name);
      }
      for (const bot of plan.bots.assign) {
        await db.setAssignment(bot.name, {
          engine: bot.engine,
          model: bot.model,
          modelAccountId: bot.modelAccountId,
          modelSetAt: bot.modelSetAt,
        });
      }
      for (const bot of plan.bots.looks ?? []) await db.setLook(bot.name, { color: bot.color, avatar: bot.avatar });
      for (const bot of plan.bots.signIns) {
        const credential = credentials.get(bot.name);
        if (!credential) continue;
        // Where the token went: a refresh token when the archive had one,
        // the non-expiring token otherwise.
        const ref = writes.has(refreshTokenRef(bot.ns)) ? refreshTokenRef(bot.ns) : accessTokenRef(bot.ns);
        await db.putCredential(bot.name, credential, ref);
      }
      if (contents.history && plan.history) outcome.history = await db.putHistory(contents.history);

      await db.audit({
        actor: options.actor,
        action: options.auditAction ?? 'install.restored',
        target: 'install',
        // What came back, by name and count. Never a value.
        payload: {
          createdAt: contents.manifest.createdAt,
          version: contents.manifest.version,
          secrets: outcome.secrets,
          settings: outcome.settings,
          repositories: outcome.repositories,
          accounts: outcome.accounts,
          bots: contents.bots.map((bot) => archivedSeat(bot)),
          signIns: outcome.bots.signIns,
          history: plan.history,
        },
      });

      // Last, inside the transaction: a secret that cannot be written rolls
      // the rows back with it.
      for (const ref of plan.secrets.remove) await target.secrets.delete(ref);
      for (const [ref, value] of writes) await target.secrets.set(ref, value);
    });
  } catch (error) {
    for (const [ref, value] of before) {
      await (value === null ? target.secrets.delete(ref) : target.secrets.set(ref, value)).catch(() => undefined);
    }
    throw error;
  }

  return outcome;
}
