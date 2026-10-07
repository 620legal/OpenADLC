import { closeSync, existsSync, fchmodSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  BackupError,
  EVERYTHING,
  GITHUB_TAKE_OVER,
  moveSignInIntoPlace,
  regularSignInPath,
  SIGN_IN_ROTATION,
  SIGN_INS_NOT_CHOSEN,
  SUBSCRIPTION_TAKE_OVER,
  VERDICT_WORDS,
  accountLoginDir,
  buildBackup,
  changeCount,
  choosable,
  cleanliness,
  counted,
  decryptBackup,
  defaultSignInChecks,
  defaultSignInChoices,
  describeContents,
  describeManifest,
  describeOmittedRefreshTokens,
  describePlan,
  describeUnrestoredRefreshTokens,
  encryptBackup,
  formatOf,
  generatePassphrase,
  gitHubTakeOver,
  installClientId,
  isEverything,
  judgeSignIns,
  liveSignInFacts,
  liveTarget,
  loginRoot,
  passphraseRefusal,
  passphraseWarning,
  planRestore,
  previewRestore,
  readInstall,
  readInstallFacts,
  readLoginFolder,
  readManifest,
  readPlain,
  readShape,
  runRestore,
  signInsByDefault,
  writePlain,
  type BackupContents,
  type BackupManifest,
  type BackupSelection,
  type InstallFacts,
  type InstallShape,
  type InstallSnapshot,
  type LeftOut,
  type LoginFiles,
  type RestoreOutcome,
  type RestorePlan,
  type RestoreTarget,
  type SignIn,
  type SignInChecks,
  type SignInChoices,
  type SignInFacts,
  type SignInLine,
  type TakeOverPorts,
} from '@fleetadlc/backup';
import { closePool, waitForDatabase } from '@fleetadlc/db';
import { stepNamed } from '@fleetadlc/shared';
import { getSecretStore, internalSecretRef } from '@fleetadlc/github';
import { databaseUnreachable } from '../database.js';
import { prompt, ui } from '../ui.js';

/**
 * `fleetadlc backup` and `fleetadlc restore`.
 *
 * Nothing reconstructs an install's durable credentials. The GitHub App private
 * key is shown once by GitHub, the signing keys were generated here, and the
 * webhook secret, the client id, the organization, the operator's email and the
 * bot-to-account mappings live only in this install. They are not in the
 * repository. A lost copy of them costs a new App key. This writes them
 * somewhere else, encrypted, and puts them back.
 *
 * What goes in the archive, and what a restore does with it, is not decided
 * here: `@fleetadlc/backup` decides, for this command, for the console's Backup
 * card and for the walkthrough's restore, so the three cannot drift. This file
 * is the terminal around it — where the file may be written, the passphrase
 * asked twice, the plan shown and `overwrite` typed before anything is written.
 *
 * Every decision is a pure function, and the two shells do the talking and the
 * writing through injected ports, so the tests exercise the real decisions
 * without a terminal, a database or a live secret store.
 */

/** Typed in full before a restore overwrites anything. */
export const CONFIRM_WORD = 'overwrite';

/** Who a restore is attributed to in the settings table and the audit log. */
const RESTORED_BY = 'fleetadlc restore';

// ---------------------------------------------------------------- the decisions

/**
 * The path with symlinks resolved as far down as it exists.
 *
 * `/tmp` is a link to `/private/tmp` on macOS and a checkout is often reached
 * through a link, so the repository check has to compare the path the
 * filesystem will actually write to rather than the one that was typed.
 */
function settled(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

export interface PathRefusal {
  /** The path as it was understood, which is what a person needs to see. */
  path: string;
  reason: string;
  notes: string[];
}

/** Where `fleetadlc backup` writes when nobody says where. */
export function defaultBackupPath(now: Date, home = homedir(), unencrypted = false): string {
  // The home directory rather than the working directory: the working directory
  // is usually the repository, which is the one place this file must not be.
  //
  // A different extension for the unencrypted form, so the two are never
  // confused at a glance in a directory listing or a file picker: `.fleetbak` is
  // a sealed archive and always was, and this one says what it is.
  const name = `fleetadlc-backup-${now.toISOString().slice(0, 10)}`;
  return join(home, unencrypted ? `${name}.plain.json` : `${name}.fleetbak`);
}

const ALREADY_THERE_NOTE = 'Overwriting a backup loses it. Move that file aside, or pass --out.';

/**
 * Whether the archive may be written here, and why not.
 *
 * Anywhere inside the repository working tree is refused. The archive holds the
 * GitHub App private key and the signing keys, so a copy inside the tree is one
 * `git add -A` away from being published — and a `.gitignore` line is not the
 * fix, because the rule travels with the repository while the habit of running
 * `fleetadlc backup` from the checkout travels with the operator.
 *
 * An existing file is also refused. The default path carries the date, so the
 * file it would land on is either today's archive or a backup somebody put
 * there deliberately; overwriting either is worse than asking for `--out`.
 */
export function outputRefusal(target: string, repoRoot: string): PathRefusal | null {
  const path = settled(target);
  const root = settled(repoRoot);

  if (path === root || path.startsWith(`${root}${sep}`)) {
    return {
      path,
      reason: `refusing to write ${path}: it is inside the repository at ${root}`,
      notes: [
        'This archive holds the App key, signing keys, webhook secret, any non-expiring bot tokens and API keys.',
        'A file like that must never be committable, so it cannot live in the tree.',
        'Pass --out with a path outside the repository.',
      ],
    };
  }

  if (existsSync(path)) {
    return {
      path,
      reason: `refusing to write ${path}: something is already there`,
      notes: [ALREADY_THERE_NOTE],
    };
  }

  return null;
}

/** The groups `--without` can leave out, as a person names them. */
const GROUPS = ['install', 'repositories', 'crew', 'accounts'] as const;

export interface BackupFlags {
  /** `--without install,repositories,crew,accounts` */
  without?: string;
  /** `--bots builder,qa`: these seats only. */
  bots?: string;
  /** `--accounts <id or label>,…`: these model accounts only. */
  accounts?: string;
  /** `--history` */
  history?: boolean;
  /** `--sign-ins` true, `--no-sign-ins` false, neither undefined. */
  signIns?: boolean;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * What the flags choose, or why they cannot be read. Seats and accounts are
 * checked against the install once it has been read; this only says what was
 * asked for. The sign-ins follow the same rule as the console's card: on when
 * the whole install is taken, off when part of it is, unless a flag says.
 */
export function selectionFromFlags(flags: BackupFlags): BackupSelection | { error: string } {
  const without = flags.without === undefined ? [] : list(flags.without);
  if (flags.without !== undefined && without.length === 0) return { error: '--without needs a group: install, repositories, crew or accounts' };
  const unknown = without.filter((group) => !(GROUPS as readonly string[]).includes(group));
  if (unknown.length > 0) return { error: `--without takes install, repositories, crew or accounts, not ${unknown.join(', ')}` };
  if (flags.bots !== undefined && list(flags.bots).length === 0) return { error: '--bots needs the seats to take, like --bots builder,qa' };
  if (flags.accounts !== undefined && list(flags.accounts).length === 0) {
    return { error: '--accounts needs the accounts to take, by id or label' };
  }

  const bots: BackupSelection['bots'] = without.includes('crew') ? [] : flags.bots !== undefined ? list(flags.bots) : 'all';
  const accounts: BackupSelection['accounts'] = without.includes('accounts')
    ? []
    : flags.accounts !== undefined
      ? list(flags.accounts)
      : 'all';
  const partial = {
    install: !without.includes('install'),
    repositories: !without.includes('repositories'),
    bots,
    accounts,
  };
  const signIns = flags.signIns ?? signInsByDefault(partial);
  return { ...partial, botSignIns: signIns, accountSignIns: signIns, history: flags.history === true };
}

/**
 * The seats and accounts a selection names, checked against what the install
 * has, with accounts named by label turned into ids. An `{ error }` with the
 * reason when something named is not there.
 */
export function resolveSelection(
  selection: BackupSelection,
  found: Pick<InstallSnapshot, 'bots' | 'accounts'>,
): BackupSelection | { error: string } {
  if (selection.bots !== 'all') {
    const missing = selection.bots.filter((seat) => !found.bots.some((bot) => bot.slot === seat));
    if (missing.length > 0) return { error: `this install has no seat ${missing.join(', ')}` };
  }
  if (selection.accounts === 'all') return selection;
  const ids: string[] = [];
  for (const wanted of selection.accounts) {
    const matches = found.accounts.filter((account) => account.id === wanted || account.label === wanted);
    if (matches.length === 0) return { error: `this install has no model account ${wanted}` };
    if (matches.length > 1) return { error: `more than one model account is called ${wanted}; name it by id` };
    ids.push(matches[0]!.id);
  }
  return { ...selection, accounts: ids };
}

/** Nothing but the word, so a stray `y` cannot overwrite live credentials. */
export function confirmed(typed: string): boolean {
  return typed.trim().toLowerCase() === CONFIRM_WORD;
}

/**
 * Turns "this database has no schema" into something to act on.
 *
 * A restore reads the settings table to work out what it would change, and on a
 * database that has never been migrated that read fails with `relation
 * "settings" does not exist`. `safeMessage` repeats only `BackupError`, so the
 * whole recovery path — fresh machine, fresh database, archive in hand, which
 * is exactly when this runs — ended at "unexpected error, reported without its
 * message". The remedy is one command, and it is worth naming.
 */
export function asMissingSchema(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/relation "[^"]+" does not exist/.test(message)) {
    throw new BackupError(
      'this install has no database schema yet, so there is nothing to restore into — ' +
        'run `fleetadlc up` first, then restore',
    );
  }
  throw error;
}

/**
 * What may be said about a failure.
 *
 * A refusal from the archive codec and a missing or unreadable file are worth
 * repeating; anything else is reported by its kind only. An error raised while
 * a secret is in hand can carry that secret in its message, and these two
 * commands are the only place in the CLI where every credential in the install
 * is in memory at once. A database that cannot be reached is said in words
 * of this module's own, which name the database and never a value.
 */
export function safeMessage(error: unknown): string {
  if (error instanceof BackupError) return error.message;
  const unreachable = databaseUnreachable(error);
  if (unreachable) return unreachable;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EISDIR') return 'that is a directory';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  return `unexpected ${error instanceof Error ? error.name : typeof error}, reported without its message`;
}

/** The refs left out, grouped by why, for the lines under "What this archive will hold". */
function leftOutLines(leftOut: LeftOut[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const entry of leftOut) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.ref]);
  return [...byReason.entries()].map(([reason, refs]) => `Left out, because ${reason}: ${refs.join(', ')}.`);
}

// ------------------------------------------------------------------- the ports

/**
 * Everything these commands read and write.
 *
 * Split by what it exposes: `shape()` is names only and is all a restore
 * reads, so no code path in a restore has a live credential in hand until it
 * writes the archive's. Only `snapshot()` reads values, and only `fleetadlc
 * backup` calls it. The tests pass a fake, which is what makes it impossible
 * for a unit test to reach `~/.fleetadlc` or a real database.
 */
export interface InstallAccess {
  snapshot(selection: BackupSelection): Promise<InstallSnapshot>;
  shape(): Promise<InstallShape>;
  /** Whether it is set up — an app, a repository, a connected bot, a model account — which decides what is ticked. */
  facts(): Promise<InstallFacts>;
  /** What it holds, for comparing an archive's sign-ins with by value. Read, never printed. */
  signInFacts(): SignInFacts;
  /** The GitHub App client id it refreshes sign-ins with now, or null. */
  clientId(): Promise<string | null>;
  target(): RestoreTarget;
  close(): Promise<void>;
}

/**
 * Who a sign-in is checked with. `checks` are read-only — a key's models, a
 * GitHub token's account — and `takeOver` uses a rotating sign-in, which is
 * the only way to check one: GitHub's token refresh, and hostd running the
 * subscription's CLI on a copy of its folder.
 */
export interface SignInProviders {
  checks: SignInChecks;
  takeOver(clientId: string | null): TakeOverPorts;
}

/** Where output goes and how a question is asked. `out` is the CLI's own `ui`. */
export interface BackupIo {
  out: Pick<typeof ui, 'heading' | 'step' | 'ok' | 'warn' | 'fail' | 'note' | 'plain'>;
  askSecret(question: string): Promise<string>;
  askLine(question: string): Promise<string>;
}

/**
 * Where a restore's bytes come from.
 *
 * A seam rather than a path so the flow above it — manifest first, then the
 * passphrase, then the plan, then the confirmation — is testable without the
 * archive codec and without a real archive to hand.
 */
export interface ArchiveSource {
  manifest(): BackupManifest;
  /** False for an archive written with `--unencrypted`, which needs no passphrase. */
  sealed(): boolean;
  open(passphrase: string): BackupContents | Promise<BackupContents>;
}

export interface BackupDeps {
  install: InstallAccess;
  io: BackupIo;
  now(): Date;
  seal(contents: BackupContents, passphrase: string): Buffer | Promise<Buffer>;
  /** The `--unencrypted` form. Separate port, so a test cannot get one for the other. */
  plain(contents: BackupContents): Buffer;
  write(path: string, bytes: Buffer): void;
}

export interface RestoreDeps {
  install: InstallAccess;
  io: BackupIo;
  archive(path: string): ArchiveSource;
  providers: SignInProviders;
  now?(): Date;
}

/**
 * Reads a line without echoing it.
 *
 * `prompt` echoes, which would leave the passphrase in the scrollback of
 * whatever terminal this ran in and in any recording of it. readline has no
 * option for that, so the write it echoes through is replaced once the question
 * is on screen and before the first keystroke can arrive.
 *
 * A pipe is refused rather than read: a passphrase supplied by a shell lives in
 * that shell's history, which is the thing this archive most needs not to
 * happen to it.
 */
async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // A `BackupError`, because `safeMessage` repeats only those — and a refusal
    // that cannot explain itself is worse than useless here. Piping a passphrase
    // in is refused rather than read, so it cannot land in shell history; the
    // operator has to be told that is why, or the failure reads as a crash.
    throw new BackupError(
      'a passphrase has to be typed at a terminal, not piped in — run this without redirecting stdin',
    );
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const asked = rl.question(`  ${question}: `);
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    const answer = await asked;
    // The newline the operator typed was swallowed with everything else.
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

function terminalIo(): BackupIo {
  return { out: ui, askSecret: askHidden, askLine: (question) => prompt(question) };
}

/**
 * The install on this machine: its database and secret store, and hostd's
 * login root on disk — the CLI runs where hostd does, and with the stack
 * stopped as well as running.
 */
function liveInstall(): InstallAccess {
  const store = getSecretStore();
  const root = loginRoot();
  let connected: Promise<void> | undefined;
  // One wait for the whole command, whichever read reaches the database first.
  // A few seconds: this is a person at a terminal, not a service starting beside it.
  const ready = (): Promise<void> => (connected ??= waitForDatabase(5, 500));
  // An account no hostd of this version has started on still has its sign-in
  // at the top of its folder, where an earlier build kept it.
  const folderOf = (id: string): string => {
    const dir = accountLoginDir(root, id);
    try {
      moveSignInIntoPlace(dir);
    } catch {
      // Read as it is: signed out, which the backup says.
    }
    return dir;
  };

  return {
    async snapshot(selection) {
      await ready();
      return readInstall(selection, {
        store,
        readLogin: async (id) => readLoginFolder(folderOf(id)),
      }).catch(asMissingSchema);
    },

    async shape() {
      await ready();
      return readShape({
        store,
        hasLogin: async (id) => regularSignInPath(folderOf(id)) !== null,
      }).catch(asMissingSchema);
    },

    async facts() {
      await ready();
      return readInstallFacts({ store }).catch(asMissingSchema);
    },

    signInFacts: () => liveSignInFacts({ store, folder: async (id) => readLoginFolder(folderOf(id)) }),

    async clientId() {
      await ready();
      return installClientId().catch(asMissingSchema);
    },

    // No rename: moving a bot's computer is the bridge's, and the bridge
    // names every connected bot after its account when it starts. No sign-in
    // folder either: one comes back only by being checked, through hostd.
    target: () => liveTarget({ store }),

    close: closePool,
  };
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

/**
 * hostd checks a subscription's sign-in by using a copy of it, and keeps it
 * only if the CLI answers. The CLI runs where hostd does, and asks it: a
 * folder is never written here as the archive has it. With the stack stopped
 * there is nothing to check with, and so nothing is written.
 */
async function adoptThroughHostd(accountId: string, files: LoginFiles): Promise<{ ok: boolean; message: string }> {
  const base = process.env.FLEETADLC_HOSTD_URL || 'http://127.0.0.1:47312';
  const secret = await getSecretStore().get(internalSecretRef());
  const stopped = `hostd is not running, so this sign-in could not be checked by using it — start the stack with \`fleetadlc up\`, then restore again or sign in on ${stepNamed('models')}`;
  if (!secret) return { ok: false, message: stopped };
  let response: Response;
  try {
    response = await fetch(`${base}/model-accounts/${encodeURIComponent(accountId)}/login/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': secret, 'x-fleetadlc-on-behalf-of': RESTORED_BY },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(150_000),
    });
  } catch {
    return { ok: false, message: stopped };
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: unknown; message?: unknown; error?: unknown };
  if (!response.ok) return { ok: false, message: typeof body.error === 'string' ? body.error : `hostd refused with ${response.status}` };
  return { ok: body.ok === true, message: typeof body.message === 'string' ? body.message : '' };
}

function liveProviders(): SignInProviders {
  return {
    checks: defaultSignInChecks(),
    takeOver: (clientId) => ({ ...(clientId ? gitHubTakeOver(clientId) : NO_APP), adoptLogin: adoptThroughHostd }),
  };
}

/** The file the archive was to be written to was there by the time it was written. */
class OutputTaken extends Error {}

/**
 * Creates the file, refusing one that is there: `outputRefusal` looked before
 * the passphrase prompt, and a file can appear while it is typed. A link counts
 * as there, dangling or not, so the archive is never written where one points.
 */
export function writeArchive(path: string, bytes: Buffer): void {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OutputTaken(`refusing to write ${path}: something is already there`);
    throw error;
  }
  try {
    // 0600 twice: the mode on create is masked by the umask, so the fchmod is
    // the one that makes it true, and through the descriptor it cannot follow a
    // path somebody swapped.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/**
 * A file on disk, read as whichever of the two forms it actually is.
 *
 * The format is taken from the file rather than from its name: an extension is
 * a hint somebody can rename away, and opening a sealed archive as plain — or
 * asking for a passphrase that a plain file has no use for — are both worse
 * than looking.
 */
function fileArchive(path: string): ArchiveSource {
  const bytes = readFileSync(path);
  const sealed = formatOf(bytes) !== 'plain';

  return {
    manifest: () => (sealed ? readManifest(bytes) : readPlain(bytes).manifest),
    sealed: () => sealed,
    open: (passphrase) => (sealed ? decryptBackup(bytes, passphrase) : readPlain(bytes)),
  };
}

function liveBackupDeps(): BackupDeps {
  return {
    install: liveInstall(),
    io: terminalIo(),
    now: () => new Date(),
    seal: encryptBackup,
    plain: writePlain,
    write: writeArchive,
  };
}

function liveRestoreDeps(): RestoreDeps {
  return { install: liveInstall(), io: terminalIo(), archive: fileArchive, providers: liveProviders(), now: () => new Date() };
}

// ---------------------------------------------------------------- the commands

/** Whether an archive holds anything at all worth writing. */
function holdsNothing(contents: BackupContents): boolean {
  return (
    Object.keys(contents.secrets).length +
      Object.keys(contents.settings).length +
      contents.bots.length +
      (contents.repositories?.length ?? 0) +
      (contents.accounts?.length ?? 0) +
      (contents.history ? 1 : 0) ===
    0
  );
}

/**
 * Writes an encrypted copy of what was chosen — everything, unless told
 * otherwise.
 */
export async function backup(
  repoRoot: string,
  options: { out?: string; unencrypted?: boolean; selection?: BackupSelection },
  deps: BackupDeps = liveBackupDeps(),
): Promise<void> {
  const { install, io } = deps;
  const unencrypted = options.unencrypted === true;
  const target = options.out || defaultBackupPath(deps.now(), homedir(), unencrypted);

  // Before the database, the secret store and the passphrase: an operator who
  // aimed at the checkout should be told so immediately, not after typing a
  // passphrase twice.
  const refusal = outputRefusal(target, repoRoot);
  if (refusal) {
    io.out.fail(refusal.reason);
    for (const note of refusal.notes) io.out.note(note);
    process.exitCode = 1;
    return;
  }

  try {
    const asked = options.selection ?? EVERYTHING;
    const found = await install.snapshot(asked);
    const resolved = resolveSelection(asked, found);
    if ('error' in resolved) {
      io.out.fail(`${resolved.error}; nothing was written`);
      process.exitCode = 1;
      return;
    }
    const { contents, leftOut } = buildBackup(found, resolved, deps.now());
    const omitted = leftOut.filter((entry) => entry.reason === SIGN_INS_NOT_CHOSEN).map((entry) => entry.ref);

    if (holdsNothing(contents)) {
      io.out.fail('this install has nothing to back up yet');
      io.out.note('Run `fleetadlc up` and connect at least one bot first.');
      process.exitCode = 1;
      return;
    }

    io.out.heading(isEverything(resolved) ? 'What this archive will hold: the whole install' : 'What this archive will hold');
    for (const line of describeContents(contents)) io.out.plain(line ? `    ${line}` : '');
    io.out.plain();
    io.out.note('Names only. No value from any of these is printed, here or anywhere.');
    if (contents.manifest.includes?.botSignIns) io.out.note(`GitHub sign-ins are included. ${SIGN_IN_ROTATION}`);
    else if (contents.bots.length > 0) for (const line of describeOmittedRefreshTokens(omitted)) io.out.note(line);
    for (const line of leftOutLines(leftOut.filter((entry) => !omitted.includes(entry.ref)))) io.out.note(line);

    const summary = [
      counted(Object.keys(contents.secrets).length, 'secret'),
      counted(Object.keys(contents.settings).length, 'setting'),
      counted(contents.bots.length, 'bot'),
      counted(contents.repositories?.length ?? 0, 'repository').replace(/repositorys$/, 'repositories'),
      counted(contents.accounts?.length ?? 0, 'model account'),
    ].join(', ');

    if (unencrypted) {
      // Asked for explicitly, and said out loud anyway. Access control protects
      // the place a file is fetched from, never the file once it has been
      // fetched — and this one holds an App key that never expires.
      io.out.warn('Writing this archive UNENCRYPTED, because --unencrypted was passed.');
      const includes = contents.manifest.includes;
      const held = [
        'the App key',
        'signing keys',
        'webhook secret',
        'any package registry token',
        'any non-expiring bot tokens and API keys',
        'any Claude subscription tokens',
        ...(includes?.accountSignIns ? ['the OpenAI and xAI subscription sign-ins'] : []),
        ...(includes?.botSignIns ? ['the bots’ GitHub sign-ins'] : []),
        ...(includes?.history ? ['the history: messages, requests and attachments'] : []),
      ];
      io.out.note(`Anyone who reads the file holds this install: ${held.slice(0, -1).join(', ')}, and ${held.at(-1)}.`);
      io.out.note(
        'Recovering from a leak means a new App key, webhook secret and commit-signing keys, a new key for signing posts (fleetadlc attribution rotate --drop-old), revoking each bot’s GitHub authorization, revoking any non-expiring bot token, rotating every API key and the registry token, and signing each model subscription out and in again.',
      );

      deps.write(target, deps.plain(contents));

      io.out.heading('Written');
      io.out.ok(`${target} (mode 0600, unencrypted)`);
      io.out.note(`In the clear: ${summary}.`);
      io.out.note('Keep it somewhere only you can read, and delete it when it is no longer needed.');
      return;
    }

    io.out.heading('A passphrase for the archive');
    io.out.note('Nothing but this passphrase opens the file, and there is no recovery.');
    let passphrase = await io.askSecret('Passphrase (Enter makes one)');
    if (passphrase === '') {
      // A generated one is only useful seen, so it is printed — once, and the
      // operator is told to take it out of the scrollback.
      passphrase = generatePassphrase();
      io.out.ok(`Passphrase: ${passphrase}`);
      io.out.note('Put it in a password manager now: it is not shown again. Clear the terminal once it is stored.');
    } else {
      const second = await io.askSecret('Passphrase again');
      const bad = passphraseRefusal(passphrase, second);
      if (bad) {
        io.out.fail(`${bad}; nothing was written`);
        process.exitCode = 1;
        return;
      }
      // Said, never refused: the archive is still written with it.
      const short = passphraseWarning(passphrase);
      if (short) io.out.warn(short);
    }

    deps.write(target, await deps.seal(contents, passphrase));

    io.out.heading('Written');
    io.out.ok(`${target} (mode 0600)`);
    io.out.note(`Encrypted: ${summary}.`);
    io.out.note('Lose the passphrase and the archive is lost with it. Nothing can open it for you.');
    io.out.note('Keep both somewhere that is neither this machine nor this repository.');
  } catch (error) {
    if (error instanceof OutputTaken) {
      io.out.fail(error.message);
      io.out.note(ALREADY_THERE_NOTE);
    } else io.out.fail(`backup failed: ${safeMessage(error)}`);
    process.exitCode = 1;
  } finally {
    await install.close();
  }
}

/** What a restore wrote, said by name. */
function describeOutcome(plan: RestorePlan, outcome: RestoreOutcome, signIns: readonly SignInLine[]): string[] {
  const lines: string[] = [];
  for (const ref of outcome.deleted) lines.push(`deleted secret ${ref}`);
  for (const ref of outcome.secrets) {
    const archived = plan.secrets.from[ref];
    lines.push(archived ? `secret ${ref} (${archived} in the archive)` : `secret ${ref}`);
  }
  for (const key of outcome.settings) lines.push(`setting ${key}`);
  for (const id of outcome.accounts) lines.push(`model account ${id}`);
  for (const name of outcome.repositories) lines.push(`repository ${name}`);
  for (const bot of [...plan.bots.connect, ...plan.bots.replace.map((entry) => ({ name: entry.name, login: entry.to }))]) {
    lines.push(`bot ${bot.name} as ${bot.login}`);
  }
  for (const name of outcome.bots.assignments) lines.push(`model assignment of ${name}`);
  for (const name of outcome.bots.signIns) lines.push(`GitHub sign-in of ${name}`);
  for (const line of signIns) {
    if (line.state === 'taken-over') lines.push(`${signInLabel(line)}: checked by using it, and taken over`);
  }
  if (outcome.history) {
    const { threads, messages, audit, ledger, requests, attachments } = outcome.history;
    lines.push(
      `history: ${[
        counted(threads, 'thread'),
        counted(messages, 'message'),
        counted(audit, 'audit line'),
        counted(ledger, 'ledger row'),
        counted(requests, 'request'),
        ...(attachments ? [counted(attachments, 'attachment')] : []),
      ].join(', ')}`,
    );
  }
  return lines;
}

/**
 * A sign-in by whose it is: a bot's by its seat and account, an account's by
 * its label, a GitHub account seats share by the account and its seats — one
 * sign-in however many use it — and a bot's own engine key by the bot.
 */
function signInLabel(line: Pick<SignIn, 'seat' | 'seats' | 'who' | 'provider' | 'kind'>): string {
  if (line.provider === 'github' && line.seats.length > 1) return `${line.who}, shared by ${line.seats.join(', ')}`;
  if (line.provider === 'github') return `${line.seat ?? 'a bot'} as ${line.who}`;
  const what =
    { 'api-key': 'API key', 'claude-token': 'subscription token', subscription: 'subscription sign-in', 'engine-key': 'engine key' }[
      line.kind as 'api-key'
    ] ?? 'sign-in';
  return `${line.who} (${what})`;
}

/**
 * What `fleetadlc restore` says about each sign-in before it asks: its verdict,
 * and what this restore will do with it.
 */
function describeSignIns(lines: readonly SignInLine[], into: 'clean' | 'running'): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const { verdict } = line;
    const said =
      verdict.state === 'works'
        ? `${VERDICT_WORDS.works.toLowerCase()} (${verdict.said})`
        : verdict.state === 'blocked'
          ? `${VERDICT_WORDS.blocked.toLowerCase()}: ${verdict.reason}`
          : verdict.state === 'same'
            ? VERDICT_WORDS.same.toLowerCase()
            : VERDICT_WORDS['check-by-use'].toLowerCase();
    const then =
      verdict.state === 'same'
        ? 'nothing to do'
        : verdict.state === 'blocked'
          ? 'not restored'
          : line.chosen
            ? verdict.state === 'works'
              ? 'restored'
              : 'this restore checks it and takes it over'
            : into === 'running'
              ? 'left as this install has it; pass --take-over-sign-ins to take it'
              : 'left out';
    out.push(`${signInLabel(line)}: ${said} — ${then}`);
  }
  return out;
}

/**
 * Which sign-ins a restore takes: on a clean install every one that can come
 * back; into a set-up one only a working sign-in this install lacks, unless
 * `--take-over-sign-ins` asks for every one that can be taken.
 */
function restoreChoices(signIns: readonly SignIn[], into: 'clean' | 'running', takeOverAll = false): SignInChoices {
  const choices = defaultSignInChoices(signIns, into);
  if (takeOverAll) for (const signIn of signIns) if (choosable(signIn)) choices[signIn.key] = true;
  return choices;
}

/**
 * Puts an archive back.
 *
 * Says what it would do before it can do it, and then asks. The order is the
 * point: the manifest is readable without the passphrase, so what the archive
 * is gets established first; the plan is shown next, against this install,
 * with every sign-in in the archive judged — same as here, working, expired
 * or refused, or only to be checked by using it; and only a typed
 * confirmation after that writes anything. A sign-in that cannot be restored
 * is not written, whatever is typed.
 */
/**
 * Text from an archive, made safe to print: C0 and C1 controls and DEL are
 * what a terminal reads as commands, to move the cursor, rename the window or
 * write the clipboard, and a name or label in an archive is anybody's. A
 * line break inside one is a space, so a field stays on its line.
 */
export function printable(text: string): string {
  return text.replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** Everything a restore prints, through `printable`: most of it is the archive's words. */
function printableOut(out: BackupIo['out']): BackupIo['out'] {
  const clean =
    (say: (text: string) => void) =>
    (text: string): void =>
      say(printable(text));
  return {
    heading: clean(out.heading),
    step: clean(out.step),
    ok: clean(out.ok),
    warn: clean(out.warn),
    fail: clean(out.fail),
    note: clean(out.note),
    plain: (text?: string) => out.plain(text === undefined ? text : printable(text)),
  };
}

export async function restore(
  path: string,
  options: { dryRun?: boolean; takeOverSignIns?: boolean },
  deps: RestoreDeps = liveRestoreDeps(),
): Promise<void> {
  const { install } = deps;
  const io: BackupIo = { ...deps.io, out: printableOut(deps.io.out) };
  const now = deps.now ?? (() => new Date());

  try {
    const source = deps.archive(path);

    io.out.heading(`What ${path} says it is`);
    for (const line of describeManifest(source.manifest())) io.out.plain(`    ${line}`);

    io.out.plain();
    // A plain archive has no passphrase, so asking for one would be theatre —
    // and typing anything at that prompt would suggest the file was protected.
    // It is said instead, because reading one is worth noticing.
    if (!source.sealed()) {
      io.out.warn('This archive is UNENCRYPTED: anyone who has had the file has had these credentials.');
    }
    // The install first: with the database down, the passphrase was asked
    // and typed before the restore said it could not go on.
    const shape = await install.shape();
    const contents = await source.open(source.sealed() ? await io.askSecret('Passphrase for this archive') : '');
    const into = cleanliness(await install.facts()).clean ? 'clean' : 'running';

    // This writes the archive's settings over this install's, so a sign-in
    // is refreshed with the archive's app when it names one.
    const archiveClientId = contents.settings.githubClientId?.trim() || null;
    const clientId = archiveClientId ?? (await install.clientId());
    const signIns = await judgeSignIns({
      contents,
      shape,
      facts: install.signInFacts(),
      checks: deps.providers.checks,
      now: now(),
      clientId: { after: clientId, archive: archiveClientId },
    });
    const choices = restoreChoices(signIns, into, options.takeOverSignIns === true);
    const preview = previewRestore({ contents, shape, signIns, choices });
    const pending = preview.signIns.filter((line) => line.state === 'take-over');
    const pendingBots = new Set(
      pending.flatMap((line) => shape.bots.filter((bot) => line.seats.includes(bot.slot)).map((bot) => bot.name)),
    );
    // A bot whose sign-in is to be taken over is not one to connect again —
    // unless the take-over fails, which is said once it has been tried.
    const shown: RestorePlan = {
      ...preview.plan,
      bots: { ...preview.plan.bots, deviceFlow: preview.plan.bots.deviceFlow.filter((bot) => !pendingBots.has(bot.name)) },
    };

    io.out.heading(options.dryRun ? 'What a restore would change' : 'What this restore will change');
    const lines = describePlan(shown);
    if (lines.length === 0) io.out.plain('    nothing');
    for (const line of lines) io.out.plain(line ? `    ${line}` : '');

    if (preview.signIns.length > 0) {
      io.out.heading(`Sign-ins in this archive (${preview.signIns.length})`);
      for (const line of describeSignIns(preview.signIns, into)) io.out.plain(`    ${line}`);
    }

    // Said whether or not anybody has to sign in again: the lists above name
    // who does, and these say why.
    io.out.plain();
    const stale = planRestore(contents, shape).secrets.stale;
    if (!contents.manifest.includes || stale.length > 0) {
      for (const line of describeUnrestoredRefreshTokens(stale)) io.out.note(line);
    }
    if (pending.some((line) => line.provider === 'github')) io.out.note(GITHUB_TAKE_OVER);
    if (pending.some((line) => line.provider !== 'github')) io.out.note(SUBSCRIPTION_TAKE_OVER);
    if (shown.bots.deviceFlow.length > 0) {
      io.out.note('Each bot named above will need to connect again: `fleetadlc auth login --bot <name>`.');
    }

    if (options.dryRun) {
      io.out.plain();
      io.out.ok('dry run: nothing was written, and no sign-in was used');
      return;
    }

    if (changeCount(preview.plan) === 0 && pending.length === 0) {
      io.out.plain();
      io.out.ok('this install already matches the archive; nothing to write');
      return;
    }

    io.out.plain();
    io.out.warn('This overwrites live credentials.');
    io.out.note('A wrong restore costs a new App key and one GitHub sign-in per bot.');
    if (!confirmed(await io.askLine(`Type ${CONFIRM_WORD} to go ahead`))) {
      io.out.warn('nothing was written');
      return;
    }

    const report = await runRestore({
      contents,
      shape,
      signIns,
      choices,
      target: install.target(),
      takeOver: deps.providers.takeOver(clientId),
      actor: RESTORED_BY,
      // Into an install in use, the archive's caps are set and this one's
      // others kept; onto a clean one, the archive's list is the table.
      spending: into === 'running' ? 'merge' : 'replace',
      now,
    });

    io.out.heading('Written');
    for (const line of describeOutcome(report.plan, report.outcome, report.signIns)) io.out.ok(line);
    for (const line of report.signIns) {
      if (line.state !== 'refused') continue;
      const reason = (line.reason ?? 'it was not accepted').replace(/[.\s]+$/, '');
      io.out.warn(`${signInLabel(line)} was not restored — nothing was stored for it: ${reason}`);
    }

    if (report.summary.next.length > 0) {
      io.out.heading('Still to do');
      for (const line of report.summary.next) io.out.note(line);
    }

    io.out.plain();
    io.out.note('Restart the stack so the services read the restored credentials:');
    io.out.note('fleetadlc down && fleetadlc up');
    io.out.note('A bot holding a credential again takes its account’s handle as its name when the bridge starts.');
  } catch (error) {
    io.out.fail(`restore failed: ${safeMessage(error)}`);
    process.exitCode = 1;
  } finally {
    await install.close();
  }
}
