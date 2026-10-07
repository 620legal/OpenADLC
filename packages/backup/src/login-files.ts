import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fleetHome } from '@fleetadlc/github';
import { BackupError, type LoginFiles } from './archive.js';

/**
 * A subscription's sign-in folder, as files an archive can carry.
 *
 * An OpenAI or xAI subscription is signed in by its own CLI, and hostd keeps
 * the account a folder (`<login root>/<account id>`). The sign-in itself is
 * one file, `auth.json` for both CLIs, kept in a directory of its own in that
 * folder (`SIGN_IN_DIR`). No container has the account folder as its home or
 * mounts it: a task, a sign-in, a check, a model list and an engine call each
 * get a home of their own, and the sign-in file is mounted into it. A Grok
 * task is also given the sign-in directory, because Grok renames a new file
 * over `auth.json`; that directory holds nothing hostd reads but that file.
 *
 * So an archive carries the sign-in file and the sealed files, and only when
 * there is a sign-in. Whatever else a CLI or a task left in the folder is not
 * a sign-in and stays behind. hostd reads and writes a folder through these,
 * for the bridge; the CLI through them directly, on the same machine.
 */

/** The file whose presence means the folder is signed in — the one hostd checks. */
export const SIGN_IN_FILE = 'auth.json';
/**
 * The directory in an account's folder that holds `SIGN_IN_FILE`. A Grok task
 * mounts it read-write, so its rename of `auth.json` lands on the account; a
 * file it plants there lands beside the sign-in and nowhere else, and nothing
 * reads it. The whole account folder used to be that mount: planted files
 * piled up beside its other files, a backup carried them, and the restore
 * check used that copy as `GROK_HOME` and loaded a planted `CLAUDE.md` and
 * LSP server.
 */
export const SIGN_IN_DIR = 'sign-in';
/**
 * Codex and Grok's home config. The copy in the login folder is what a task
 * can replace; the sealed one lives beside that folder, not in it.
 */
export const LOGIN_CONFIG_FILE = 'config.toml';
/**
 * What Codex or Grok reads from its home as config, instructions, or an
 * environment file for every task on the account. Each is sealed beside the
 * login folder. Grok 1.0.41 loads `mcp_servers` from `managed_config.toml`
 * and `requirements.toml` as well as `config.toml`. Codex 0.155.1 loads
 * `$CODEX_HOME/.env` into the process before the model (`load_dotenv` in
 * its arg0). A task's home is not this folder, so a file it creates is not
 * the next task's.
 */
export const SEALED_LOGIN_FILES = [LOGIN_CONFIG_FILE, 'AGENTS.md', 'AGENTS.override.md', 'managed_config.toml', 'requirements.toml', '.env'] as const;
export type SealedLoginFile = (typeof SEALED_LOGIN_FILES)[number];
/** One file larger than this is not a sign-in. */
export const LOGIN_FILE_MAX = 1024 * 1024;
/** Nor a folder of them larger than this. */
export const LOGIN_FOLDER_MAX = 4 * 1024 * 1024;

/** A plain file name: no separators, no `..`, nothing hidden at the start. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** What a CLI appends to as it runs: history and logs, never a sign-in. */
const RUNNING_RECORD = /\.(jsonl|log)$/i;

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where hostd keeps sign-in folders: `FLEETADLC_LOGIN_ROOT`, or `logins` under the
 * install's home — the same answer hostd's own configuration gives.
 */
export function loginRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FLEETADLC_LOGIN_ROOT;
  if (configured && configured.length > 0) return resolve(configured);
  const home = env.FLEETADLC_HOME && env.FLEETADLC_HOME.length > 0 ? env.FLEETADLC_HOME : fleetHome();
  return resolve(join(home, 'logins'));
}

/** One account's folder. Refuses anything that is not an account id before a path is built from it. */
export function accountLoginDir(root: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new BackupError(`${JSON.stringify(accountId)} is not a model account id`);
  return join(resolve(root), accountId.toLowerCase());
}

/**
 * A file a container must not be able to change for the next one.
 *
 * Codex and Grok read `config.toml` before the model (`mcp_servers`, the
 * approval policy). Grok also reads `managed_config.toml` and
 * `requirements.toml` for `mcp_servers`, and Codex reads `AGENTS.md`,
 * `AGENTS.override.md` and `.env`. A writable copy in a shared home set
 * those for the next task, which loads them with that task's token. The
 * file that is kept is `<login root>/.published/<account>/<name>`. A task's
 * home and a sign-in container bind-mount it read-only over the name.
 * rename(2) onto a bind-mounted file fails with EBUSY, so that mount holds;
 * a writable copy would still take an in-place write.
 */
export function publishedLoginFilePath(loginDir: string, name: SealedLoginFile): string | null {
  const id = basename(resolve(loginDir)).toLowerCase();
  if (!ACCOUNT_ID.test(id)) return null;
  return join(resolve(loginDir, '..'), '.published', id, name);
}

/** The sealed `config.toml`. */
export function publishedLoginConfigPath(loginDir: string): string | null {
  return publishedLoginFilePath(loginDir, LOGIN_CONFIG_FILE);
}

/**
 * The sealed file, made from the folder's own copy the first time and not
 * from it again. A later write in the folder is how a task replaces the
 * shared file; a restore updates the sealed one (`writeLoginFolder`,
 * `replaceLoginFiles`). A link is not followed: a file pointing out of the
 * folder would otherwise be sealed and handed to the next task. One that
 * is not there yet is sealed empty, so the mount point exists before a task
 * can create it.
 */
export function ensurePublishedLoginFile(loginDir: string, name: SealedLoginFile): string | null {
  const path = publishedLoginFilePath(loginDir, name);
  if (!path) return null;
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(dirname(folder), 0o700);
  chmodSync(folder, 0o700);
  const there = lstatSync(path, { throwIfNoEntry: false });
  if (there?.isFile()) return path;
  if (there) rmSync(path, { force: true });
  const bytes = readPlainFile(join(loginDir, name), LOGIN_FILE_MAX) ?? Buffer.alloc(0);
  try {
    writeOwnFile(path, bytes, constants.O_EXCL);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw cause;
    const now = lstatSync(path, { throwIfNoEntry: false });
    if (!now?.isFile()) throw cause;
  }
  return path;
}

/** The sealed `config.toml`. */
export function ensurePublishedLoginConfig(loginDir: string): string | null {
  return ensurePublishedLoginFile(loginDir, LOGIN_CONFIG_FILE);
}

/** A slot directory's name, or null when it would not be a single path segment. */
function slotKey(slotDir: string): string | null {
  const slot = basename(resolve(slotDir));
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(slot) ? slot : null;
}

/**
 * This task's home, beside the login root and not inside the slot.
 *
 * The slot is mounted into the container at its host path, so a directory
 * there can be replaced with a link. A release that then read `auth.json`
 * through that link wrote another directory's sign-in onto the account.
 */
export function taskLoginHome(loginRoot: string, slotDir: string): string | null {
  const slot = slotKey(slotDir);
  if (!slot) return null;
  return join(resolve(loginRoot), '.homes', slot);
}

/** Where the sign-in file lives in a folder: an account's, or a copy of one being checked. */
export function signInDir(loginDir: string): string {
  return join(resolve(loginDir), SIGN_IN_DIR);
}

/**
 * The sign-in file when it is a regular file in a real sign-in directory, or
 * null when it is missing, a link, or a directory.
 *
 * A link is not followed. One a task planted where the sign-in goes would
 * otherwise be the file the next computer's mount opened.
 */
export function regularSignInPath(loginDir: string): string | null {
  const dir = signInDir(loginDir);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const path = join(dir, SIGN_IN_FILE);
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ? path : null;
}

/**
 * The sign-in directory, made by hostd and closed to everyone else. Something
 * other than a directory at its name is removed first: Docker would otherwise
 * mount whatever a link there pointed at.
 */
export function ensureSignInDir(loginDir: string): string {
  const dir = signInDir(loginDir);
  const there = lstatSync(dir, { throwIfNoEntry: false });
  if (there && !there.isDirectory()) rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Moves a sign-in from where an earlier build kept it, the top of the account
 * folder, into the sign-in directory.
 *
 * Only a regular file is moved, and only over a missing or older one: a task
 * computer started before the upgrade still renames its refreshed sign-in
 * into the top of the folder, and that refresh is the one that works. Nothing
 * else writes there now.
 */
export function moveSignInIntoPlace(loginDir: string): void {
  const legacy = join(resolve(loginDir), SIGN_IN_FILE);
  const old = lstatSync(legacy, { throwIfNoEntry: false });
  if (!old?.isFile()) return;
  const dest = join(ensureSignInDir(loginDir), SIGN_IN_FILE);
  const now = lstatSync(dest, { throwIfNoEntry: false });
  if (now?.isFile() && now.mtimeMs >= old.mtimeMs) return;
  if (now && !now.isFile()) removeTree(dest);
  renameSync(legacy, dest);
}

/**
 * A task's home: a new directory, with a file where `auth.json` will be
 * mounted and a mount point for each sealed file. It does not hold a copy of
 * the sign-in.
 *
 * The account's `auth.json` stays the sign-in every task uses. Codex writes
 * that file in place, so a file mount shares the inode. Grok renames a new
 * file over it, so the sign-in directory is mounted where `GROK_AUTH_PATH`
 * points, and the rename lands on the shared file. A copy per task went stale
 * the moment one task spent the refresh token, and a hostd crash before the
 * copy was put back lost the refresh.
 *
 * An adopt copy is laid out like an account folder and gets a home the same
 * way; it has no sealed files, so its home has no mount point for them.
 */
export function prepareTaskLoginHome(loginDir: string, slotDir: string): string | null {
  const home = taskLoginHome(resolve(loginDir, '..'), slotDir);
  if (!home) return null;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(resolve(home, '..'), 0o700);
  chmodSync(home, 0o700);
  // An empty file, and only when the account's auth.json will be mounted
  // over it. Docker makes a missing mount point a directory, and a directory
  // there hides the file mount. No sign-in, or a link, leaves the name
  // absent: the home must not hold a copy.
  if (regularSignInPath(loginDir)) {
    const signIn = join(home, SIGN_IN_FILE);
    const existing = lstatSync(signIn, { throwIfNoEntry: false });
    if (!existing?.isFile()) {
      if (existing) removeTree(signIn);
      writeOwnFile(signIn, Buffer.alloc(0), constants.O_EXCL);
    }
  }
  if (publishedLoginConfigPath(loginDir)) {
    for (const name of SEALED_LOGIN_FILES) {
      if (!ensurePublishedLoginFile(loginDir, name)) continue;
      const point = join(home, name);
      const there = lstatSync(point, { throwIfNoEntry: false });
      if (there?.isFile()) continue;
      if (there) removeTree(point);
      writeOwnFile(point, Buffer.alloc(0), constants.O_EXCL);
    }
  }
  return home;
}

/**
 * Removes this computer's home. It does not throw: a home a task replaced
 * with a file used to make `release` throw, the container stayed, and the
 * reaper left it because it was still held.
 */
export function forgetTaskLogin(loginRoot: string, slotDir: string): void {
  const slot = slotKey(slotDir);
  if (!slot) return;
  try {
    removeTree(join(resolve(loginRoot), '.homes', slot));
  } catch {
    // The container is already gone. A home left behind holds no sign-in,
    // and the leftover sweep tries it again.
  }
}

/**
 * A sign-in written into a fresh home, moved onto the account when the
 * account has no regular `auth.json` yet.
 *
 * The first sign-in has nothing to mount, so the CLI creates the file in
 * its home. A file already on the account is the one a mount is writing
 * through; the home's copy of that name is the empty mount point and must
 * not replace it. Anything else at the name is removed first: a Grok task
 * has the sign-in directory, and a link or a directory it made there is not
 * a sign-in. `rmSync` without `recursive` threw on a directory, the throw
 * was swallowed, and every later sign-in was dropped while the console said
 * "signed in".
 */
export function publishFreshSignIn(loginDir: string, home: string): void {
  const id = basename(resolve(loginDir)).toLowerCase();
  if (!ACCOUNT_ID.test(id)) return;
  const src = join(home, SIGN_IN_FILE);
  if (!lstatSync(src, { throwIfNoEntry: false })?.isFile()) return;
  const dest = join(ensureSignInDir(loginDir), SIGN_IN_FILE);
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  if (existing?.isFile()) return;
  if (existing) removeTree(dest);
  renameSync(src, dest);
}

/**
 * Homes whose slot directory is gone.
 *
 * The home is outside the slot, so `pruneSlots` removing the slot leaves it.
 * A name starting with `once-` is a sign-in or a check; one newer than twenty
 * minutes is still running (a sign-in is allowed fifteen). A home that cannot
 * be removed is left for the next sweep: one that threw used to stop the
 * sweep there, and every home after it stayed.
 */
export function sweepTaskHomes(loginRoot: string, slotRoots: string[], now = Date.now()): number {
  const homes = join(resolve(loginRoot), '.homes');
  let names: string[];
  try {
    names = readdirSync(homes);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) continue;
    try {
      if (name.startsWith('once-')) {
        const age = now - (lstatSync(join(homes, name), { throwIfNoEntry: false })?.mtimeMs ?? now);
        if (age < 20 * 60 * 1000) continue;
      } else if (slotRoots.some((root) => existsSync(join(root, name)))) {
        continue;
      }
      removeTree(join(homes, name));
      removed += 1;
    } catch {
      // Tried again on the next sweep.
    }
  }
  return removed;
}

/**
 * Removes a file or a directory tree, a tree a task made unreadable included.
 *
 * A task owns what it writes in its home and in the sign-in directory, and a
 * `chmod 000` directory there made `rmSync` throw. Each directory is opened
 * to its owner first, found by `lstat` so a link is never followed; this runs
 * only once the container that could swap one in is gone.
 */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch {
    openTree(path);
  }
  rmSync(path, { recursive: true, force: true });
}

function openTree(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
  try {
    chmodSync(path, 0o700);
  } catch {
    return;
  }
  for (const name of readdirSync(path)) openTree(join(path, name));
}

/** Drops the account's sealed files. Only that account's. */
export function removePublishedLoginConfig(loginDir: string): void {
  const path = publishedLoginConfigPath(loginDir);
  if (!path) return;
  const home = dirname(path);
  const publishedRoot = join(resolve(loginDir, '..'), '.published');
  if (relativeSafe(publishedRoot, home) !== basename(home)) return;
  rmSync(home, { recursive: true, force: true });
}

/**
 * Rewrites each sealed file in the login folder from `.published`, and
 * returns those published paths, in `SEALED_LOGIN_FILES` order.
 *
 * A container bind-mounts each one read-only over the name in the login
 * directory. rename(2) onto a bind-mounted file fails with EBUSY, so the
 * CLI cannot replace the mount by renaming a new file over it, and the
 * read-only mount cannot be written in place. A writable per-task copy
 * would still take that in-place write, which is the config this task's
 * CLI loads. The published file is not given to the container except as
 * that mount.
 *
 * The first seal is whatever the folder holds then, a planted
 * `mcp_servers` included. A later write in the folder does not change it.
 */
export function materialiseLoginConfig(loginDir: string): string[] {
  if (!publishedLoginConfigPath(loginDir)) {
    throw new BackupError(`${JSON.stringify(loginDir)} is not an account's login directory`);
  }
  const login = resolve(loginDir);
  // The mount point has to be a file hostd made. Docker would otherwise
  // create a missing path as a directory, and the file mount would not land.
  mkdirSync(login, { recursive: true, mode: 0o700 });
  const published: string[] = [];
  for (const name of SEALED_LOGIN_FILES) {
    const path = ensurePublishedLoginFile(login, name);
    if (!path) throw new BackupError(`${JSON.stringify(loginDir)} is not an account's login directory`);
    const bytes = readPlainFile(path, LOGIN_FILE_MAX);
    if (!bytes) throw new BackupError(`the sealed ${name} at ${path} is not a file hostd can copy`);
    writeRegularFile(join(login, name), bytes);
    published.push(path);
  }
  return published;
}

/** A path strictly inside `root`, or null when it is the root or outside it. */
function relativeSafe(root: string, path: string): string | null {
  const base = resolve(root);
  const resolved = resolve(path);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  if (!resolved.startsWith(prefix)) return null;
  const relative = resolved.slice(prefix.length);
  if (relative === '' || relative.split(sep).includes('..')) return null;
  return relative;
}

/** Whether a set of files is one an archive may carry and a folder may be written from. */
export function checkLoginFiles(files: LoginFiles): void {
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    // `.env` fails the plain-name rule on purpose: a hidden name is not a
    // sign-in. Codex loads that one file from its home, so a backup has to
    // carry the sealed copy or a restore would leave the old environment.
    if ((!FILE_NAME.test(name) && !isSealedLoginFile(name)) || RUNNING_RECORD.test(name)) {
      throw new BackupError(`${JSON.stringify(name)} is not a file a sign-in folder carries`);
    }
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length > LOGIN_FILE_MAX) throw new BackupError(`${name} is too large to be a sign-in`);
    total += bytes.length;
  }
  if (total > LOGIN_FOLDER_MAX) throw new BackupError('that sign-in folder is too large to be a sign-in');
}

/**
 * The sign-in file and the sealed files, or null when the folder holds no
 * sign-in. Nothing else in the folder is carried: a Grok task can write in
 * the sign-in directory, and the top of the folder is what an earlier build
 * gave tasks as their home, so a file found there is not the account's.
 * Symbolic links are not followed.
 *
 * Each file is opened once, never through a link, and its type and size are
 * read from the descriptor. A look by path followed by a read by path let a
 * bot swap a file for a link between the two: a host file such as the App's
 * private key went into a backup, and a FIFO or `/dev/zero` blocked hostd or
 * got past the size caps. Once a sealed file exists, that is the one a backup
 * carries; until then it is the folder's own copy, which is what gets sealed.
 */
export function readLoginFolder(dir: string): LoginFiles | null {
  const signIn = regularSignInPath(dir);
  const bytes = signIn ? readPlainFile(signIn, LOGIN_FILE_MAX) : null;
  if (!bytes) return null;
  const files: LoginFiles = { [SIGN_IN_FILE]: bytes.toString('base64') };
  let total = bytes.length;
  for (const name of SEALED_LOGIN_FILES) {
    const published = publishedLoginFilePath(dir, name);
    const kept = (published ? readPlainFile(published, LOGIN_FILE_MAX) : null) ?? readPlainFile(join(dir, name), LOGIN_FILE_MAX);
    if (!kept || total + kept.length > LOGIN_FOLDER_MAX) continue;
    files[name] = kept.toString('base64');
    total += kept.length;
  }
  return files;
}

function isSealedLoginFile(name: string): name is SealedLoginFile {
  return (SEALED_LOGIN_FILES as readonly string[]).includes(name);
}

/**
 * A regular file's bytes, or null for anything else: a link, a FIFO, a
 * device, a file gone by the time it is opened, or one larger than a sign-in
 * or than `room`. Non-blocking, so a FIFO with no writer is refused at the
 * open rather than holding hostd's event loop.
 */
function readPlainFile(path: string, room: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // A link (ELOOP), a FIFO with no writer (ENXIO), or removed since the listing.
    if (code === 'ELOOP' || code === 'ENXIO' || code === 'ENOENT') return null;
    throw cause;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LOGIN_FILE_MAX || stat.size > room) return null;
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const got = readSync(fd, bytes, read, bytes.length - read, read);
      if (got === 0) break;
      read += got;
    }
    return bytes.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Refuses a name in the folder that is there and is not a plain file: a link, dangling or not, included. */
function refuseNonFile(path: string, name: string, done: string): void {
  const there = lstatSync(path, { throwIfNoEntry: false });
  if (there && !there.isFile()) throw new BackupError(`${name} in that sign-in folder is not a file, so it was not ${done}`);
}

/**
 * Writes a file its owner's alone without following a link at its name, and
 * sets the mode through the descriptor: a bot can write in a folder it has
 * mounted, and a link it put there between a look and a write, or a chmod by
 * path, would have sent either wherever the link pointed.
 */
function writeOwnFile(path: string, bytes: Buffer, flag: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | flag, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/**
 * Where a carried file is written: the sign-in in the sign-in directory, a
 * sealed file at the top of the folder, and anything else nowhere. An older
 * backup carried every top-level file; the rest is not a sign-in, and no
 * container reads the folder as a home any more.
 */
function placesFor(dir: string, files: LoginFiles): Array<{ name: string; folder: string }> {
  const names = Object.keys(files)
    .filter((name) => name === SIGN_IN_FILE || isSealedLoginFile(name))
    .sort((a, b) => Number(a === SIGN_IN_FILE) - Number(b === SIGN_IN_FILE) || a.localeCompare(b));
  return names.map((name) => ({ name, folder: name === SIGN_IN_FILE ? signInDir(dir) : resolve(dir) }));
}

/** The sign-in directory, made when it is not there; something else at its name is refused. */
function signInFolderFor(dir: string, done: string): void {
  const there = lstatSync(signInDir(dir), { throwIfNoEntry: false });
  if (there && !there.isDirectory()) throw new BackupError(`${SIGN_IN_DIR} in that sign-in folder is not a directory, so it was not ${done}`);
  mkdirSync(signInDir(dir), { recursive: true, mode: 0o700 });
  chmodSync(signInDir(dir), 0o700);
}

/**
 * Writes a sign-in back. The folder is made closed to everyone else, as hostd
 * makes it, and each file is readable by its owner alone; a file already
 * there under another name is left as it is.
 */
export function writeLoginFolder(dir: string, files: LoginFiles): void {
  checkLoginFiles(files);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The root as well as the folder, as hostd sets them: `mkdir`'s mode is
  // filtered by the umask and ignored for a directory that is already there.
  chmodSync(resolve(dir, '..'), 0o700);
  chmodSync(dir, 0o700);
  for (const { name, folder } of placesFor(dir, files)) {
    if (name === SIGN_IN_FILE) signInFolderFor(dir, 'overwritten');
    const path = join(folder, name);
    // Never through a link that is already there. `existsSync` follows one,
    // so a dangling link read as nothing there and was written through.
    refuseNonFile(path, name, 'overwritten');
    const bytes = Buffer.from(files[name] as string, 'base64');
    writeOwnFile(path, bytes, constants.O_TRUNC);
    // A restore is the operator's config. The sealed file is what the next
    // computer copies; leaving it would keep serving the one from before.
    if (isSealedLoginFile(name)) mirrorPublishedFile(dir, name, bytes);
  }
}

/**
 * Puts a sign-in's files into a folder that is in use — its sign-in mounted
 * into every running bot on the account — without replacing the folder or
 * the sign-in directory, which a mount would go on holding. Each file is
 * written beside its place and moved over it by a rename, so a bot reading
 * it sees the old file or the new one and never half of either; the sign-in
 * file goes last. Anything else in the folder is left as it is.
 */
export function replaceLoginFiles(dir: string, files: LoginFiles): void {
  checkLoginFiles(files);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const { name, folder } of placesFor(dir, files)) {
    if (name === SIGN_IN_FILE) signInFolderFor(dir, 'replaced');
    const path = join(folder, name);
    refuseNonFile(path, name, 'replaced');
    const bytes = Buffer.from(files[name] as string, 'base64');
    const temporary = join(folder, `.${name}.${randomBytes(6).toString('hex')}.new`);
    try {
      // Made new, never opened through a link a bot swapped in under the
      // name, and chmodded through its descriptor: by path, a link put there
      // first made hostd chmod whatever it pointed at.
      writeOwnFile(temporary, bytes, constants.O_EXCL);
      renameSync(temporary, path);
      if (isSealedLoginFile(name)) mirrorPublishedFile(dir, name, bytes);
    } finally {
      // Removes a link without following it.
      rmSync(temporary, { force: true });
    }
  }
}

/** Writes `bytes` over `path` without following a link at that name. */
function writeRegularFile(path: string, bytes: Buffer): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    const there = lstatSync(path, { throwIfNoEntry: false });
    if (there && !there.isFile()) rmSync(path, { force: true });
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // Swapped for a link between the look and the open.
      if (code !== 'ELOOP' || attempt === 1) throw cause;
    }
  }
}

/** Replaces one sealed file. A restore, not a task: a task never has this directory. */
function mirrorPublishedFile(loginDir: string, name: SealedLoginFile, bytes: Buffer): void {
  const path = publishedLoginFilePath(loginDir, name);
  if (!path) return;
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(dirname(folder), 0o700);
  chmodSync(folder, 0o700);
  const temporary = join(folder, `.${name}.${randomBytes(6).toString('hex')}.new`);
  try {
    writeOwnFile(temporary, bytes, constants.O_EXCL);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
