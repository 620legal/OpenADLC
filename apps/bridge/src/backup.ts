import { signInKind } from './sign-in.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  BackupError,
  EVERYTHING,
  NOT_CLEAN,
  buildBackup,
  cleanliness,
  decryptBackup,
  defaultSignInChecks,
  defaultSignInChoices,
  encryptBackup,
  fileUndoStore,
  formatOf,
  gitHubTakeOver,
  judgeSignIns,
  liveSignInFacts,
  liveTarget,
  passphraseRefusal,
  previewRestore,
  readHistoryHere,
  readInstall,
  readInventory,
  readPlain,
  readShape,
  runRestore,
  selectionFrom,
  summarizeArchive,
  type BackupContents,
  type BackupInventory,
  type BackupSelection,
  type InstallFacts,
  type InstallShape,
  type InstallSnapshot,
  type RestoreTarget,
  type SignIn,
  type SignInChecks,
  type SignInChoices,
  type SignInFacts,
  type TakeOverPorts,
} from '@fleetadlc/backup';
import { audit, bots, credentials, modelAccounts, repos, settings, tasks } from '@fleetadlc/db';
import { appPrivateKeyRef, credentialKind, getSecretStore } from '@fleetadlc/github';
import { holdsCredential } from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import type { BotNames } from './bot-names.js';
import type { BridgeConfig } from './config.js';
import type { DispatchGate } from './dispatch-gate.js';
import type { HealthRegistry } from './health/registry.js';
import { effectiveConfig } from './effective-config.js';
import type { HostdClient } from './hostd-client.js';
import { resyncPause } from './pause-work.js';
import { RestoreInto, type RestoreIntoDeps } from './restore-into.js';
import { HttpFailure, readBytes, STREAMING, type Router } from './router.js';

/**
 * Backing an install up from the console, and restoring one into a clean
 * install from the walkthrough.
 *
 * What a backup takes and how a restore puts it back are `@fleetadlc/backup`'s —
 * the same code `fleetadlc backup` and `fleetadlc restore` run, sign-in checks and
 * all. This is the part only the bridge can do: it reaches a subscription's
 * sign-in folder through hostd, which keeps it and checks it, and it renames
 * a restored bot through the one routine that moves a bot's computer, folder
 * and secrets with its name.
 *
 * Every sign-in in an archive is judged before anything is written, and the
 * preview says what became of each: an invalid one is never restored.
 */

/** A request larger than this is not an archive a restore should hold in memory at once. */
export const RESTORE_BODY_MAX = 96 * 1024 * 1024;

export interface BackupRouteDeps {
  /** What the Backup card offers, by name. */
  inventory(): Promise<BackupInventory>;
  /** Everything a choice may take, values and all. */
  snapshot(selection: BackupSelection): Promise<InstallSnapshot>;
  /** The install by name, which is all a restore reads before it writes. */
  shape(): Promise<InstallShape>;
  facts(): Promise<InstallFacts>;
  /** Where a restore writes, for the person asking. */
  target(actor: string): RestoreTarget;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  now(): Date;
  /** What this install holds, to compare an archive's sign-ins with by value. */
  signInFacts(): SignInFacts;
  /** The read-only checks: a key's models, a GitHub token's account. */
  checks: SignInChecks;
  /** The GitHub App client id this install refreshes sign-ins with now, or null. */
  clientId(): Promise<string | null>;
  /** Using a rotating sign-in: refreshing it with this client id, adopting a folder through hostd. */
  takeOver(clientId: string | null, actor: string): TakeOverPorts;
  /** Restoring into an install that is set up, and undoing that. Absent, those routes are not offered. */
  into?: RestoreInto;
  /** Puts the pauses a restore wrote on the dispatch gate (`resyncPause`). Absent where nothing dispatches. */
  resyncPause?(actor: string, source: string): Promise<void>;
}

/** Whether this install has nothing a restore would have to decide about. */
export async function installFacts(config: BridgeConfig): Promise<InstallFacts> {
  const live = await effectiveConfig(config);
  const [repoList, crew, accounts, appKey] = await Promise.all([
    repos.listRepos(),
    bots.listBots(),
    modelAccounts.list(),
    getSecretStore().get(appPrivateKeyRef()),
  ]);
  const connectedBots: string[] = [];
  for (const bot of crew) {
    // The walkthrough's own test for connected: a credential stored, or a
    // record of one that is active.
    const kind = await signInKind(bot).catch(() => null);
    const credential = await credentials.getCredential(bot.id).catch(() => null);
    if (holdsCredential(kind, credential)) connectedBots.push(bot.name);
  }
  return {
    appConfigured: live.clientIdConfigured || appKey !== null,
    repositories: repoList.map((repo) => repo.fullName),
    connectedBots,
    modelAccounts: accounts.map((account) => account.label),
  };
}

/** The stored pauses onto this gate, audited as `source`'s. */
function pauseResync(gate: DispatchGate): (actor: string, source: string) => Promise<void> {
  return (actor, source) =>
    resyncPause(
      { gate, read: () => settings.getSetting('workPaused'), readRepos: () => settings.getSetting('workPausedRepos'), audit },
      { actor, source },
    );
}

/** A take-over with no client id refreshes nothing; judging blocks such a sign-in before it gets here. */
const NO_APP: Pick<TakeOverPorts, 'refreshGitHub' | 'gitHubUser'> = {
  refreshGitHub: async () => {
    throw new Error('this install has no GitHub App client id to refresh it with');
  },
  gitHubUser: async () => {
    throw new Error('this install has no GitHub App client id');
  },
};

export interface BackupWiring {
  config: BridgeConfig;
  hostd: HostdClient;
  /**
   * With names, actors and dispatchGate, an install that is set up can be
   * restored into, and that undone; health, when given, is checked again
   * afterwards. Names alone lets a restore rename a bot.
   */
  names?: BotNames;
  actors?: Actors;
  dispatchGate?: DispatchGate;
  health?: HealthRegistry;
}

/**
 * What restoring into a set-up install reads and holds: the install through
 * `@fleetadlc/backup`, a subscription's sign-in through hostd, the crew's queues
 * through the one routine that renames bots, their tokens through the one
 * broker, the dispatcher through its gate, and afterwards the health checks.
 */
export function defaultRestoreIntoDeps(input: Required<Pick<BackupWiring, 'config' | 'hostd' | 'names' | 'actors' | 'dispatchGate'>> & Pick<BackupWiring, 'health'>): RestoreIntoDeps {
  const { config, hostd, names, actors, dispatchGate, health } = input;
  return {
    // A folder hostd cannot read now is compared as absent: it is checked by
    // using it anyway, and hostd not answering then says so.
    here: () => readInstall({ ...EVERYTHING, history: false }, { readLogin: (id) => hostd.signInFiles(id).catch(() => null) }),
    shape: () => readShape({ hasLogin: async (id) => (await hostd.loginStatus(id)).state === 'signed-in' }),
    historyHere: (history) => readHistoryHere(history),
    signInFacts: () => liveSignInFacts({ folder: (id) => hostd.signInFiles(id) }),
    checks: defaultSignInChecks(),
    clientId: async () => (await effectiveConfig(config)).gitHubClientId.trim() || null,
    // What Undo puts back, so nothing may be missing from it: a sign-in hostd
    // cannot hand over stops the restore before it writes anything. History is
    // left out: Undo deletes the rows the restore added, by the ids in its
    // journal, and never reads history from here, while an install with a few
    // hundred MiB of attachments is too large to seal and so could not be
    // restored into at all.
    snapshot: async () => {
      const selection = { ...EVERYTHING, history: false };
      return buildBackup(await readInstall(selection, { readLogin: (id) => hostd.signInFiles(id) }), selection, new Date()).contents;
    },
    target: (actor) => liveTarget({ forgetLogin: async (id) => hostd.forgetLogin(id, actor) }),
    takeOver: (clientId, actor) => ({
      ...(clientId ? gitHubTakeOver(clientId) : NO_APP),
      adoptLogin: async (id, files) => hostd.adoptSignIn(id, files, actor),
    }),
    undo: fileUndoStore(),
    busy: async (seats) => {
      const found: { seat: string; name: string }[] = [];
      for (const seat of seats) {
        const bot = await bots.getBotBySlot(seat);
        if (bot && (await tasks.countActiveTasksForBot(bot.id)) > 0) found.push({ seat, name: bot.name });
      }
      return found;
    },
    hold: async <T>(seats: readonly string[], fn: () => Promise<T>): Promise<T> => {
      const release = dispatchGate.hold('paused while a backup is restored into this install; it starts again once that is done');
      try {
        const crew = (await Promise.all(seats.map((seat) => bots.getBotBySlot(seat))))
          .filter((bot): bot is NonNullable<typeof bot> => bot !== null)
          .sort((a, b) => a.id.localeCompare(b.id));
        // Each bot's queue, in one order, so two holders cannot wait on each
        // other; then their tokens, under the names they have once held.
        const holdFrom = async (index: number): Promise<T> => {
          const bot = crew[index];
          if (bot) return names.withBot(bot.id, () => holdFrom(index + 1));
          const current = (await Promise.all(crew.map((one) => bots.getBotById(one.id)))).filter(
            (one): one is NonNullable<typeof one> => one !== null,
          );
          return actors.exclusive(
            current.map((one) => one.name),
            fn,
          );
        };
        return await holdFrom(0);
      } finally {
        release();
      }
    },
    reconcileNames: async (actor) => {
      await names.reconcile(actor);
    },
    checkHealth: () => {
      void health?.run({ force: true }).catch(() => undefined);
    },
    resyncPause: pauseResync(dispatchGate),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newId: () => randomUUID(),
  };
}

export function defaultBackupDeps(input: BackupWiring): BackupRouteDeps {
  const { config, hostd, names } = input;
  const signedIn = async (id: string): Promise<boolean> => (await hostd.loginStatus(id)).state === 'signed-in';
  return {
    inventory: () => readInventory({ signedIn: (id) => signedIn(id).catch(() => null) }),
    // A chosen sign-in hostd cannot hand over fails the backup rather than
    // leaving it out in silence: the person asked for it.
    snapshot: (selection) =>
      readInstall(selection, {
        readLogin: (id) =>
          hostd.signInFiles(id).catch((error: unknown) => {
            throw new HttpFailure(
              502,
              `the subscription sign-ins could not be read (${error instanceof Error ? error.message : 'hostd did not answer'}); try again, or leave them out`,
            );
          }),
      }),
    shape: () => readShape({ hasLogin: (id) => signedIn(id) }),
    facts: () => installFacts(config),
    target: (actor) =>
      liveTarget({
        ...(names
          ? {
              rename: async ({ name, to, reason }: { name: string; to: string; reason: string }) => {
                const bot = await bots.getBotByName(name);
                if (!bot) return { state: 'refused', reason: `there is no bot named ${name}` };
                return names.rename({ botId: bot.id, to, reason, actor });
              },
            }
          : {}),
      }),
    audit: (entry) => audit(entry),
    now: () => new Date(),
    signInFacts: () => liveSignInFacts({ folder: (id) => hostd.signInFiles(id) }),
    checks: defaultSignInChecks(),
    clientId: async () => (await effectiveConfig(config)).gitHubClientId.trim() || null,
    takeOver: (clientId, actor) => ({
      ...(clientId ? gitHubTakeOver(clientId) : NO_APP),
      adoptLogin: async (id, files) => hostd.adoptSignIn(id, files, actor),
    }),
    ...(input.dispatchGate ? { resyncPause: pauseResync(input.dispatchGate) } : {}),
    ...(names && input.actors && input.dispatchGate
      ? {
          into: new RestoreInto(
            defaultRestoreIntoDeps({
              config,
              hostd,
              names,
              actors: input.actors,
              dispatchGate: input.dispatchGate,
              ...(input.health ? { health: input.health } : {}),
            }),
          ),
        }
      : {}),
  };
}

/** `fleetadlc-backup-2026-09-24.fleetbak`, the name `fleetadlc backup` gives it too. */
export function backupFilename(now: Date): string {
  return `fleetadlc-backup-${now.toISOString().slice(0, 10)}.fleetbak`;
}

function refused(error: unknown): never {
  if (error instanceof BackupError) throw new HttpFailure(400, error.message);
  throw error;
}

/** What was taken, by name and count, for the audit log. Never a value. */
function describeTaken(contents: BackupContents, leftOut: { ref: string }[]): Record<string, unknown> {
  return {
    includes: contents.manifest.includes,
    settings: Object.keys(contents.settings).sort(),
    secrets: Object.keys(contents.secrets).sort(),
    repositories: (contents.repositories ?? []).map((repo) => repo.fullName),
    bots: contents.bots.map((bot) => bot.slot ?? bot.name),
    accounts: (contents.accounts ?? []).map((account) => account.label),
    signInFolders: Object.keys(contents.logins ?? {}).length,
    history: contents.history
      ? {
          threads: contents.history.threads.length,
          messages: contents.history.messages.length,
          audit: contents.history.audit.length,
          ledger: contents.history.ledger.length,
          requests: contents.history.requests.length,
        }
      : null,
    leftOut: leftOut.map((entry) => entry.ref),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The archive a restore was handed, as bytes. */
function archiveBytes(value: unknown): Buffer {
  const encoded = text(value).trim();
  if (!encoded) throw new HttpFailure(400, 'choose the backup file to restore');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) throw new HttpFailure(400, 'that file is empty');
  return bytes;
}

export function registerBackupRoutes(router: Router, deps: BackupRouteDeps): void {
  /** One restore at a time: two at once would both find the install clean. */
  let restoring = false;
  const busy = (): boolean => restoring || deps.into?.running === true;

  router.get('/v1/backup', async () => deps.inventory());

  /**
   * The archive, as a download. Sealed always: the console does not offer
   * the unencrypted form, which is `fleetadlc backup --unencrypted`'s alone.
   */
  router.post('/v1/backup', async ({ body, identity, res }) => {
    const input = await body<{ selection?: unknown; passphrase?: unknown; confirm?: unknown }>();
    const passphrase = text(input.passphrase);
    const problem = passphraseRefusal(passphrase, input.confirm === undefined ? passphrase : text(input.confirm));
    if (problem) throw new HttpFailure(400, problem);

    const shape = await deps.shape();
    let selection: BackupSelection;
    try {
      selection = selectionFrom(input.selection, {
        seats: shape.bots.map((bot) => bot.slot),
        accounts: shape.accounts ?? [],
      });
    } catch (error) {
      refused(error);
    }

    const now = deps.now();
    const { contents, leftOut } = buildBackup(await deps.snapshot(selection), selection, now);
    let archive: Buffer;
    try {
      archive = await encryptBackup(contents, passphrase);
    } catch (error) {
      refused(error);
    }

    await deps.audit({ actor: identity, action: 'install.backup', target: 'install', payload: describeTaken(contents, leftOut) });

    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${backupFilename(now)}"`,
      'content-length': String(archive.length),
      'cache-control': 'no-store',
    });
    res.end(archive);
    return STREAMING;
  });

  /** Whether this install can be restored into, and if not, what is set up. */
  router.get('/v1/restore', async () => cleanliness(await deps.facts()));

  /**
   * Opens an archive and says what it holds, what a restore would set up,
   * and what each sign-in in it is — checked now, read-only, where it can be.
   * Writes nothing.
   */
  router.post('/v1/restore/preview', async ({ raw }) => {
    const input = await restoreBody<{ archive?: unknown; passphrase?: unknown; signIns?: unknown }>(raw);
    await requireClean(deps);
    const bytes = archiveBytes(input.archive);
    const contents = await open(bytes, text(input.passphrase));
    const shape = await deps.shape();
    const { signIns } = await judged(deps, contents, shape);
    const preview = previewRestore({ contents, shape, signIns, choices: choicesFrom(input.signIns, signIns) });
    return {
      sealed: formatOf(bytes) === 'sealed',
      holds: summarizeArchive(contents),
      restores: preview.summary,
      signIns: preview.signIns,
    };
  });

  /**
   * Restores it, onto a clean install only. The sign-ins are judged again
   * here, not taken from the preview: what is written is what is true now.
   */
  router.post('/v1/restore', async ({ identity, raw }) => {
    const input = await restoreBody<{ archive?: unknown; passphrase?: unknown; signIns?: unknown }>(raw);
    if (busy()) throw new HttpFailure(409, 'a restore is already running');
    restoring = true;
    try {
      await requireClean(deps);
      const bytes = archiveBytes(input.archive);
      const contents = await open(bytes, text(input.passphrase));
      const shape = await deps.shape();
      const { signIns, clientId } = await judged(deps, contents, shape);
      const report = await runRestore({
        contents,
        shape,
        signIns,
        choices: choicesFrom(input.signIns, signIns),
        target: deps.target(identity),
        takeOver: deps.takeOver(clientId, identity),
        actor: identity,
      }).catch(refused);
      // A pause in the archive is a pause now, not at the next restart.
      await deps.resyncPause?.(identity, 'restore').catch((error: unknown) => {
        console.error(`[bridge] the restored pause was not put on the dispatcher: ${error instanceof Error ? error.message : error}`);
      });
      return {
        restored: report.summary,
        signIns: report.signIns,
        renames: report.renames,
        history: report.outcome.history,
      };
    } finally {
      restoring = false;
    }
  });

  const into = deps.into;
  if (!into) return;

  /**
   * Opens an archive and lays it beside this install, item by item, with
   * every sign-in in it checked. Writes nothing, uses nothing.
   */
  router.post('/v1/restore/into/preview', async ({ raw }) => {
    const input = await restoreBody<{ archive?: unknown; passphrase?: unknown }>(raw);
    const bytes = archiveBytes(input.archive);
    const contents = await open(bytes, text(input.passphrase));
    const compared = await into.compare(contents);
    return {
      sealed: formatOf(bytes) === 'sealed',
      holds: summarizeArchive(contents),
      comparison: compared.comparison,
      undo: await into.undoState(),
    };
  });

  /**
   * Starts restoring what was chosen into this install, once the choice has
   * been checked against the install as it is now. The answer is where the
   * restore has got to; `GET` says the rest.
   */
  router.post('/v1/restore/into', async ({ identity, raw }) => {
    const input = await restoreBody<{ archive?: unknown; passphrase?: unknown; choices?: unknown }>(raw);
    if (busy()) throw new HttpFailure(409, 'a restore is already running');
    // Held while it starts, as /v1/restore holds it: until the job begins,
    // nothing else says a restore is on its way, and a clean restore or an
    // undo let in meanwhile would run beside it.
    restoring = true;
    try {
      const bytes = archiveBytes(input.archive);
      const contents = await open(bytes, text(input.passphrase));
      const job = await into.start(contents, input.choices, identity).catch(refused);
      return { job };
    } finally {
      restoring = false;
    }
  });

  /** Where the last restore or undo has got to, and whether the last restore can be undone. */
  router.get('/v1/restore/into', async () => ({ job: into.view(), undo: await into.undoState() }));

  /** Starts putting back what the last restore changed, from the backup taken before it. */
  router.post('/v1/restore/undo', async ({ identity }) => {
    if (busy()) throw new HttpFailure(409, 'a restore is already running');
    restoring = true;
    try {
      return { job: await into.startUndo(identity).catch(refused) };
    } finally {
      restoring = false;
    }
  });
}

/**
 * Every sign-in in the archive, judged against this install. On a clean
 * install the archive's settings are what the install will have, so its
 * GitHub App is the one a sign-in is refreshed with.
 */
async function judged(
  deps: BackupRouteDeps,
  contents: BackupContents,
  shape: InstallShape,
): Promise<{ signIns: SignIn[]; clientId: string | null }> {
  const archive = contents.settings.githubClientId?.trim() || null;
  const clientId = archive ?? (await deps.clientId());
  const signIns = await judgeSignIns({
    contents,
    shape,
    facts: deps.signInFacts(),
    checks: deps.checks,
    now: deps.now(),
    clientId: { after: clientId, archive },
  });
  return { signIns, clientId };
}

/**
 * Which sign-ins to restore: what is ticked on a clean install unless a
 * person said otherwise, sign-in by sign-in. Only known sign-ins and only
 * true or false are read; `runRestore` refuses one that cannot be ticked.
 */
export function choicesFrom(value: unknown, signIns: readonly SignIn[], into: 'clean' | 'running' = 'clean'): SignInChoices {
  const choices = defaultSignInChoices(signIns, into);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return choices;
  for (const signIn of signIns) {
    const said = (value as Record<string, unknown>)[signIn.key];
    if (typeof said === 'boolean') choices[signIn.key] = said;
  }
  return choices;
}

/**
 * A restore's body, refused at RESTORE_BODY_MAX as it arrives. Checking only
 * the declared length let a chunked request, which declares none, be read
 * whole into memory however large it was.
 */
async function restoreBody<T>(raw: IncomingMessage): Promise<T> {
  let bytes: Buffer;
  try {
    bytes = await readBytes(raw, { limit: RESTORE_BODY_MAX });
  } catch (error) {
    if (error instanceof HttpFailure && error.status === 413) {
      throw new HttpFailure(413, 'that file is too large to be an OpenADLC backup this install can restore');
    }
    throw error;
  }
  try {
    return (bytes.length > 0 ? JSON.parse(bytes.toString('utf8')) : {}) as T;
  } catch {
    throw new HttpFailure(400, 'that request is not JSON');
  }
}

async function requireClean(deps: BackupRouteDeps): Promise<void> {
  const state = cleanliness(await deps.facts());
  if (!state.clean) throw new HttpFailure(409, NOT_CLEAN);
}

async function open(bytes: Buffer, passphrase: string): Promise<BackupContents> {
  const form = formatOf(bytes);
  if (form === 'unknown') throw new HttpFailure(400, 'that file is not an OpenADLC backup');
  if (form === 'sealed' && !passphrase) throw new HttpFailure(400, 'give the passphrase the backup was made with');
  try {
    return form === 'plain' ? readPlain(bytes) : await decryptBackup(bytes, passphrase);
  } catch (error) {
    refused(error);
  }
}
