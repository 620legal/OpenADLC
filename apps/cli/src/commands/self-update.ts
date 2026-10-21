import { execFile } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  checkoutApplyingPath,
  isBuiltRoot,
  releaseInstallEnv,
  safeWords,
  selfUpdateApplyingPath,
  selfUpdatePaths,
  sharedCheckoutReason,
  writeFileDurably,
  type CheckoutInstall,
  type SelfUpdateApplying,
  type SelfUpdateResultFile,
} from '@openadlc/shared';

/**
 * `openadlc self-update apply`: the restart onto a release the bridge has
 * prepared (apps/bridge/src/self-update.ts). Not for a person to run: the
 * bridge starts it, detached, from the release's own CLI in the prepared
 * worktree, once no task runs, and reads the result file it leaves.
 *
 * The checkout the services run from stays the install. In order:
 *
 * 1. Preflight: the checkout is clean, on main, at `--from`, and `--from` is
 *    an ancestor of `--to`; the worktree is at `--to`; no other install runs
 *    from this checkout. Nothing is stopped if any of it fails.
 * 2. Stop the services, and see that every keeper has gone.
 * 3. `git merge --ff-only` the checkout to `--to`. `apps/hostd/bin`, which
 *    task computers mount read-only from the checkout, changes in place with
 *    it, so a paused task's computer sees the release's `gh` and `git`.
 * 4. Swap the built output in, file by file, written over in place and
 *    flushed. A paused task's computer bind-mounts one file of it, the skill
 *    runner's bundle, and a mount of a file follows its inode: a file renamed
 *    aside and replaced would leave that computer running the old runner
 *    under the new hostd. Each file it writes over is kept in `previous/`
 *    first, and each the release no longer has is moved there, so the output
 *    is the release's and nothing else.
 * 5. `pnpm install --frozen-lockfile --offline`, from the store the worktree's
 *    install filled, with none of the services' environment.
 * 6. Migrate, with the release's migrator.
 * 7. Start the services with the checkout's `openadlc up`, the release's,
 *    told not to print its sign-in link.
 *
 * A failure at 2 to 5 puts back what was: `git reset --keep` to `--from`,
 * the files written over written back, the ones added removed, the ones moved
 * aside moved back, `pnpm install` against the old lockfile, and `up`. A
 * failure at 6 or 7 does not: migrations are forward-only, and the old code may
 * not run on a schema a migration moved.
 *
 * A process killed partway (power lost, out of memory) can put nothing back,
 * so before anything stops it writes `run/self-update-applying.json`, and the
 * same in the checkout's `.openadlc/applying.json` for any other install that
 * runs from it, and clears both only once the checkout is one release again: installed on the
 * release, or put back. While it is there `openadlc up` refuses, saying how to
 * finish or go back (`applyingRefusal`), rather than start a mix of two.
 */

export interface ApplyOptions {
  checkout: string;
  /** `$OPENADLC_HOME`, where the record of a restart under way is kept. */
  home: string;
  /** The run's directory under the home: its worktree is `tree/`, what it writes over is kept in `previous/`. */
  staging: string;
  tag: string;
  from: string;
  to: string;
}

export interface ApplyDeps {
  /** Runs a command; a failure is thrown, in words safe to keep. */
  run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string>;
  /** Stops the services: `openadlc down`, which says but does not throw when one will not stop. */
  down(): Promise<void>;
  /** The services whose keeper still runs. */
  running(): string[];
  /** Other installs running from this checkout; see `otherInstallsRunning`. */
  otherInstalls(): CheckoutInstall[];
  now?: () => Date;
  log?: (line: string) => void;
}

const STEPS = ['preflight', 'stop', 'merge', 'output', 'install', 'migrate', 'start'] as const;
type Step = (typeof STEPS)[number];

/** What `up` reads to leave its sign-in link out: what it prints here goes to a log. */
export const NO_SIGN_IN_LINK = 'OPENADLC_NO_SIGN_IN_LINK';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The roots of the built output a tree has: `apps/bridge/dist`, `apps/console/.next`, … */
export function builtRoots(tree: string): string[] {
  const roots: string[] = [];
  for (const group of ['packages', 'apps']) {
    const dir = join(tree, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      for (const output of ['dist', '.next']) {
        const root = `${group}/${name}/${output}`;
        if (isBuiltRoot(root) && existsSync(join(tree, root))) roots.push(root);
      }
    }
  }
  return roots;
}

/** Every file under a root of the tree, relative to the tree, directories first. */
function filesUnder(tree: string, root: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  const walk = (relative: string): void => {
    dirs.push(relative);
    for (const name of readdirSync(join(tree, relative)).sort()) {
      const child = `${relative}/${name}`;
      const stat = lstatSync(join(tree, child));
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) files.push(child);
      else throw new Error(`${child} in the prepared worktree is neither a file nor a directory`);
    }
  };
  walk(root);
  return { dirs, files };
}

/** What the swap changed, so it can be put back. */
interface Swapped {
  /** Files written over, kept first under `previous/` with their mode. */
  overwritten: { path: string; mode: number }[];
  created: string[];
  createdDirs: string[];
  /** Files the release no longer has, moved under `previous/`. */
  removed: string[];
}

/** Writes over a file in place, its inode kept, and flushes it. */
function writeOver(path: string, data: Buffer, mode: number): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

/** Moves a file, across file systems if it has to. */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, to, { preserveTimestamps: true });
    rmSync(from, { force: true });
  }
}

/**
 * Writes the release's output into the checkout, each file over the one there
 * in place (same inode), keeping that one under `previous`. A link or a
 * directory where a file goes, or a file where a directory goes, stops it.
 * The checkout's files the release no longer has are left, unused.
 */
function swapIn(tree: string, checkout: string, previous: string, roots: readonly string[], done: Swapped): void {
  for (const root of roots) {
    // The package or app the root is in is the checkout's own, and exists.
    mkdirSync(dirname(join(checkout, root)), { recursive: true });
    const { dirs, files } = filesUnder(tree, root);
    for (const dir of dirs) {
      const here = join(checkout, dir);
      let stat: ReturnType<typeof lstatSync> | null = null;
      try {
        stat = lstatSync(here);
      } catch {
        mkdirSync(here);
        done.createdDirs.push(dir);
      }
      if (stat && !stat.isDirectory()) throw new Error(`${dir} in the checkout is in the way, and is not a directory`);
    }
    for (const file of files) {
      const here = join(checkout, file);
      const source = join(tree, file);
      const mode = lstatSync(source).mode & 0o777;
      let stat: ReturnType<typeof lstatSync> | null = null;
      try {
        stat = lstatSync(here);
      } catch {
        stat = null;
      }
      if (stat && !stat.isFile()) throw new Error(`${file} in the checkout is in the way, and is not a file`);
      if (stat) {
        const kept = join(previous, file);
        mkdirSync(dirname(kept), { recursive: true });
        copyFileSync(here, kept);
        done.overwritten.push({ path: file, mode: stat.mode & 0o777 });
      } else {
        done.created.push(file);
      }
      writeOver(here, readFileSync(source), mode);
    }
    // What the release no longer has: moved aside, so the output is the release's alone.
    const released = new Set(files);
    if (existsSync(join(checkout, root))) {
      for (const file of filesUnder(checkout, root).files) {
        if (released.has(file)) continue;
        move(join(checkout, file), join(previous, file));
        done.removed.push(file);
      }
    }
  }
}

/** Puts the checkout's own output back: each file written over, over again, in place; each added, removed. */
function swapBack(checkout: string, previous: string, done: Swapped): void {
  for (const file of done.created) rmSync(join(checkout, file), { force: true });
  for (const { path, mode } of done.overwritten) writeOver(join(checkout, path), readFileSync(join(previous, path)), mode);
  for (const file of done.removed) move(join(previous, file), join(checkout, file));
  for (const dir of [...done.createdDirs].reverse()) {
    try {
      rmdirSync(join(checkout, dir));
    } catch {
      // Not empty: something else wrote there, and it is left.
    }
  }
}

export async function applyRelease(options: ApplyOptions, deps: ApplyDeps): Promise<SelfUpdateResultFile> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const tree = join(options.staging, 'tree');
  const previous = join(options.staging, 'previous');
  const git = (...args: string[]) => deps.run('git', args, options.checkout).then((out) => out.trim());
  // The release's lockfile's install scripts, here as in the worktree, get nothing of the services' environment.
  const install = () => deps.run('pnpm', ['install', '--frozen-lockfile', '--offline'], options.checkout, releaseInstallEnv());
  const up = () => deps.run(process.execPath, [join(options.checkout, 'apps/cli/dist/main.js'), 'up'], options.checkout, { ...process.env, [NO_SIGN_IN_LINK]: '1' });
  const result = (fields: Omit<SelfUpdateResultFile, 'format' | 'tag' | 'from' | 'finishedAt'>): SelfUpdateResultFile => ({
    format: 1,
    tag: options.tag,
    from: options.from,
    finishedAt: now().toISOString(),
    ...fields,
    reason: safeWords(fields.reason),
  });

  // 1. Before anything stops.
  try {
    const others = deps.otherInstalls();
    if (others.length > 0) throw new Error(sharedCheckoutReason(options.checkout, others));
    const changed = await git('status', '--porcelain', '--untracked-files=no');
    if (changed) throw new Error(`the checkout ${options.checkout} has changes of its own now`);
    const branch = await git('symbolic-ref', '--short', '-q', 'HEAD').catch(() => '');
    if (branch !== 'main') throw new Error(`the checkout is ${branch ? `on ${branch}` : 'not on a branch'}, not main`);
    const head = await git('rev-parse', 'HEAD');
    if (head !== options.from) throw new Error(`the checkout is at ${short(head)}, not ${short(options.from)}, where the update started`);
    await git('merge-base', '--is-ancestor', options.from, options.to).catch(() => {
      throw new Error(`${short(options.from)} is not an ancestor of ${short(options.to)}`);
    });
    const prepared = await deps.run('git', ['rev-parse', 'HEAD'], tree).then((out) => out.trim()).catch(() => '');
    if (prepared !== options.to) throw new Error(`the prepared worktree ${tree} is not at ${short(options.to)}`);
    if (builtRoots(tree).length === 0) throw new Error(`the prepared worktree ${tree} has no built output`);
  } catch (error) {
    log(`self-update: preflight: ${safeWords(message(error))}; nothing was stopped`);
    return result({ state: 'failed', to: options.from, step: 'preflight', reason: `${message(error)}; nothing was stopped, and the install is as it was` });
  }

  const roots = builtRoots(tree);
  const swapped: Swapped = { overwritten: [], created: [], createdDirs: [], removed: [] };
  let merged = false;
  let step: Step = 'stop';
  const records = [selfUpdateApplyingPath(options.home), checkoutApplyingPath(options.checkout)];
  const applying = (at: Step) => {
    const written: SelfUpdateApplying = { format: 1, tag: options.tag, from: options.from, to: options.to, checkout: options.checkout, step: at, startedAt: now().toISOString() };
    for (const record of records) {
      mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
      writeFileDurably(record, `${JSON.stringify(written)}\n`);
    }
  };
  // The checkout is one release again: nothing for any install's `up` to refuse.
  const settled = () => {
    for (const record of records) rmSync(record, { force: true });
  };
  try {
    applying('stop');
    log(`self-update: stopping the services to restart onto ${options.tag}`);
    await deps.down();
    // `down` says a service would not stop and goes on; nothing may change under one still running.
    const still = deps.running();
    if (still.length > 0) throw new Error(`${still.join(', ')} would not stop`);

    step = 'merge';
    applying(step);
    await git('merge', '--ff-only', options.to);
    merged = true;

    step = 'output';
    applying(step);
    rmSync(previous, { recursive: true, force: true });
    swapIn(tree, options.checkout, previous, roots, swapped);

    step = 'install';
    applying(step);
    await install();
    settled();
  } catch (error) {
    const reason = `${step} failed: ${message(error)}`;
    log(`self-update: ${safeWords(reason)}; putting ${short(options.from)} back`);
    const undone = await putBack(step);
    return result({
      state: 'failed',
      to: undone.ok ? options.from : (await git('rev-parse', 'HEAD').catch(() => options.to)),
      step,
      reason: undone.ok ? `${reason}. The install was put back on ${short(options.from)} and started` : `${reason}. Putting it back failed too: ${undone.reason}`,
      ...(undone.ok ? { restoredTo: options.from } : {}),
    });
  }

  try {
    step = 'migrate';
    await deps.run(process.execPath, [join(options.checkout, 'packages/db/dist/cli/migrate.js')], options.checkout);
    step = 'start';
    await up();
  } catch (error) {
    // Forward-only: the schema may have moved, so the old code does not come back.
    return result({
      state: 'failed',
      to: options.to,
      step,
      reason: `${step} failed: ${message(error)}. The checkout is on ${options.tag}, and was not put back, since its migrations may have run: see the services' logs, then run openadlc up`,
    });
  }
  rmSync(previous, { recursive: true, force: true });
  log(`self-update: on ${options.tag}`);
  return result({ state: 'updated', to: options.to, reason: `on ${options.tag}` });

  async function putBack(failed: Step): Promise<{ ok: boolean; reason: string }> {
    try {
      // Stopped and nothing changed: only start again what was stopped.
      if (failed !== 'stop') {
        if (merged) await git('reset', '--keep', options.from);
        swapBack(options.checkout, previous, swapped);
        await install();
      }
      settled();
      await up();
      return { ok: true, reason: '' };
    } catch (error) {
      return { ok: false, reason: `${message(error)}; the checkout may be between two releases: follow what openadlc up prints` };
    }
  }
}

/**
 * Runs a command, answering its output; what it prints goes to this process's
 * own output, the restart's log. A failure carries its standard error alone,
 * made safe: `up`'s standard output has the console's sign-in link, and the
 * reason goes to the audit log and a card.
 */
export function runForApply(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60_000 }, (error, stdout, stderr) => {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      if (!error) return resolve(String(stdout));
      const said = safeWords(String(stderr).trim()).slice(-800);
      const what = safeWords(`${command === process.execPath ? 'node' : command} ${args.slice(0, 2).join(' ')}`);
      reject(new Error(`${what} exited ${(error as { code?: unknown }).code ?? 'with an error'}${said ? `: ${said}` : ''}`));
    });
  });
}

/** Writes the result where the bridge that comes up reads it. */
export function writeResult(home: string, result: SelfUpdateResultFile): string {
  const path = selfUpdatePaths(home, result.tag).result;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Whole, or not there: the bridge reads it after a restart, and removes it once recorded.
  writeFileDurably(path, `${JSON.stringify(result)}\n`);
  return path;
}
