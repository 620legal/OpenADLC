import { constants, type Dirent } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * How much of one file is served. A task can write two gigabytes, and a browser
 * asking for it must not be able to make hostd read that into memory — so the
 * bound is applied at the file handle rather than after the read, and the answer
 * says it was cut rather than passing a fragment off as the file.
 */
export const MAX_FILE_BYTES = 256 * 1024;

/** How many entries one listing carries. `node_modules` is the reason. */
export const MAX_ENTRIES = 500;

/**
 * Names never served, wherever they appear in a path.
 *
 * `.git` is the clone's plumbing rather than the bot's work: its config names
 * the remote and what hostd recorded about the task (`fleetadlc.repo`,
 * `fleetadlc.keep`, `fleetadlc.branch`), and is where a credential helper
 * would be. The rest are the
 * conventional places a session puts what it was handed — a task that runs
 * `printenv > .env` should not thereby publish its GitHub token to a browser.
 */
const NEVER_SERVED = new Set(['.git', '.env', '.ssh', '.npmrc', '.netrc']);

function neverServed(name: string): boolean {
  return NEVER_SERVED.has(name) || name.startsWith('.env.');
}

export type WorktreeEntryKind = 'file' | 'directory' | 'other';

export interface WorktreeEntry {
  name: string;
  kind: WorktreeEntryKind;
  /** Bytes, for a regular file; null for anything else. */
  size: number | null;
}

export interface WorktreeListing {
  kind: 'directory';
  /** Relative to the worktree root; `''` is the root itself. */
  path: string;
  entries: WorktreeEntry[];
  /** True when the directory holds more than `MAX_ENTRIES`. */
  truncated: boolean;
}

export interface WorktreeFile {
  kind: 'file';
  path: string;
  /** What the file is, which is not what was served when `truncated`. */
  size: number;
  bytes: number;
  truncated: boolean;
  content: string;
}

export interface WorktreeRefusal {
  status: number;
  error: string;
  remedy: string;
}

export type WorktreeView = WorktreeListing | WorktreeFile | WorktreeRefusal;

export function isWorktreeRefusal(view: WorktreeView): view is WorktreeRefusal {
  return 'error' in view;
}

/** True only for a path at or below `root`, which must already be resolved. */
function inside(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  // The separator is not decoration: without it `…/wt/task-1-stolen` reads as
  // being inside `…/wt/task-1`.
  return target === root || target.startsWith(prefix);
}

function segmentsOf(requested: string): string[] {
  return requested.split('/').filter((segment) => segment.length > 0 && segment !== '.');
}

const RELATIVE = 'ask for a path relative to the worktree root, or omit it for the root';

function notServed(name: string): WorktreeRefusal {
  return {
    status: 403,
    error: `${name} is not served`,
    remedy: 'this shows what the bot wrote, not the repository plumbing and not a file that holds a credential',
  };
}

function resolvesOutside(requested: string): WorktreeRefusal {
  return {
    status: 403,
    error: `${requested} resolves outside the worktree`,
    remedy: 'only what is inside the task’s own worktree is served',
  };
}

/** Where a path resolved to, and the resolved worktree root it was found in. */
interface Resolved {
  realRoot: string;
  target: string;
}

/**
 * The absolute path a request names, or the refusal that stops it.
 *
 * Path traversal is the attack this route exists to refuse: `../../etc/passwd`,
 * an absolute path, and a symlink the task itself planted are three ways of
 * asking hostd to read a file that is not the bot's work.
 */
async function resolveInside(root: string, requested: string): Promise<Resolved | WorktreeRefusal> {
  if (requested.includes('\0')) {
    return { status: 400, error: 'that is not a path', remedy: RELATIVE };
  }

  if (requested.startsWith('/') || requested.startsWith('\\')) {
    return { status: 400, error: `${requested} is absolute, not a path within the worktree`, remedy: RELATIVE };
  }

  const segments = segmentsOf(requested);
  if (segments.includes('..')) {
    return { status: 400, error: `${requested} climbs out of the worktree`, remedy: RELATIVE };
  }

  const forbidden = segments.find(neverServed);
  if (forbidden) return notServed(forbidden);

  let realRoot: string;
  let target: string;
  try {
    // Both sides are resolved: a work root reached through a symlink — /tmp on a
    // Mac is the everyday one — would otherwise never contain anything.
    realRoot = await realpath(root);
    target = await realpath(join(realRoot, ...segments));
  } catch {
    return { status: 404, error: `${requested || '.'} is not in this worktree`, remedy: RELATIVE };
  }

  // Everything above this line is a clearer message for a case this check would
  // have caught anyway. This is the check that holds: a symlink inside the
  // worktree pointing at /etc passes every syntactic test and is refused only by
  // resolving it and asking where it landed.
  if (!inside(realRoot, target)) return resolvesOutside(requested);

  // The names are checked again where the path landed: `notes -> .env` inside
  // the worktree passed the check on the name asked for and served the token.
  const landed = relative(realRoot, target).split(sep).find(neverServed);
  if (landed) return notServed(landed);

  return { realRoot, target };
}

/** Directories first, then by name, so the tree does not reorder under a poll. */
function byKindThenName(a: Dirent, b: Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function list(absolute: string, path: string): Promise<WorktreeListing> {
  const found = await readdir(absolute, { withFileTypes: true });

  // A denied name is left out rather than shown and then refused: a tree that
  // displays `.git` and will not open it is worse than one that never claimed to
  // hold it.
  const visible = found.filter((entry) => !neverServed(entry.name)).sort(byKindThenName);
  const shown = visible.slice(0, MAX_ENTRIES);

  const entries = await Promise.all(
    shown.map(async (entry): Promise<WorktreeEntry> => {
      // A symlink is classified from the directory entry and never followed, so
      // listing a directory cannot be used to ask whether a path outside the
      // worktree exists. The cost is that a symlink inside the worktree reads as
      // `other` and is not navigable, which is the conservative half of a trade
      // worth making here.
      const kind: WorktreeEntryKind = entry.isSymbolicLink()
        ? 'other'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other';

      const size =
        kind === 'file'
          ? await stat(join(absolute, entry.name))
              .then((stats) => stats.size)
              .catch(() => null)
          : null;

      return { name: entry.name, kind, size };
    }),
  );

  return { kind: 'directory', path, entries, truncated: visible.length > shown.length };
}

function notAFile(path: string): WorktreeRefusal {
  return {
    status: 415,
    error: `${path} is neither a file nor a directory`,
    remedy: 'sockets, devices and pipes are not the bot’s work and are not served',
  };
}

/**
 * Reads the file at `absolute`, found inside `realRoot`, from the descriptor
 * that was checked rather than from the name.
 *
 * The task owns the worktree, so between the check in `resolveInside` and an
 * open by name it can swap the file, or a directory above it, for a symlink
 * out, and hostd served its own secrets; or swap in a FIFO, whose open waited
 * for a writer and held one of Node's four filesystem threads per poll.
 * `O_NOFOLLOW` refuses a symlink as the last segment and `O_NONBLOCK` keeps a
 * FIFO from waiting; a swapped parent directory is caught after the open, by
 * resolving the path again and asking whether it is still the same file.
 * Exported for its test, which makes that swap happen.
 */
export async function readInside(realRoot: string, absolute: string, path: string): Promise<WorktreeView> {
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return resolvesOutside(path);
    return { status: 404, error: `${path || '.'} could not be read`, remedy: RELATIVE };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return notAFile(path);

    const again = await realpath(absolute).catch(() => null);
    if (again === null || !inside(realRoot, again)) return resolvesOutside(path);
    const landed = relative(realRoot, again).split(sep).find(neverServed);
    if (landed) return notServed(landed);
    const now = await stat(again).catch(() => null);
    if (now === null || now.dev !== opened.dev || now.ino !== opened.ino) return resolvesOutside(path);

    const size = opened.size;
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const served = buffer.subarray(0, bytesRead);

    // A browser shows text. Decoding a binary as UTF-8 produces a screenful of
    // replacement characters that reads as corruption rather than as "this is
    // not a text file", so it says which, and says how big it is.
    if (served.includes(0)) {
      return {
        status: 415,
        error: `${path} is not a text file (${size} bytes)`,
        remedy: 'the worktree browser shows text; read a binary from the branch on GitHub',
      };
    }

    return {
      kind: 'file',
      path,
      size,
      bytes: bytesRead,
      truncated: bytesRead < size,
      content: served.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

/**
 * One read of one path inside a task's worktree, for the console's Computer tab.
 *
 * There is no write path here and there is not meant to be one: this answers the
 * question "what has this bot actually written" without taking its keyboard, and
 * a browser that could also change the file would be a second author in a
 * worktree whose whole point is that one bot owns it.
 */
export async function readWorktree(root: string, requested: string): Promise<WorktreeView> {
  const resolved = await resolveInside(root, requested);
  if ('error' in resolved) return resolved;

  const path = segmentsOf(requested).join('/');

  let stats;
  try {
    stats = await stat(resolved.target);
  } catch {
    return { status: 404, error: `${path || '.'} could not be read`, remedy: RELATIVE };
  }

  if (stats.isDirectory()) return list(resolved.target, path);
  // Whether it is a file is decided from the descriptor `readInside` opens,
  // not from this look by name.
  return readInside(resolved.realRoot, resolved.target, path);
}
