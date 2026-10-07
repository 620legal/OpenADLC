import { execFile } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isBotName } from '@fleetadlc/shared';
import type { ExecDriver } from './drivers/types.js';

const run = promisify(execFile);

/**
 * hostd's half of renaming a bot: its computer and its work folder.
 *
 * A bot is renamed when an account connects — it takes the account's handle —
 * and what hostd keeps for it is named after it: the folder
 * `<workRoot>/<name>`, its task computers' sessions, and on the local driver
 * every `fleetadlc__<name>__` tmux session. Under docker a bot has no
 * container between tasks: renaming ends the tasks it holds, releases their
 * computers, retires any seat container, sidecar or network left from before,
 * and moves the folder. Nothing new is made; a task's computer, login and
 * database are given when it starts (`acquire`). On the local driver the old
 * sessions go and an idle shell is started under the new name.
 *
 * The bridge calls this first and moves the row and the secrets only once it
 * has succeeded. So every step here has to be safe to repeat: a bridge that
 * stopped after hostd finished calls it again with the same two names, and
 * finds the folder already moved.
 */

/** Why a rename cannot go ahead, with the status the route answers. */
export class RenameRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RenameRefused';
  }
}

/**
 * A name that is safe as a path segment. The old name only has to be that —
 * it is whatever the row was called, possibly by an older install — while the
 * new one has to be a bot name proper.
 */
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function holdsAnything(path: string): boolean {
  return existsSync(path) && readdirSync(path).length > 0;
}

/**
 * What the folder move would do, or why it cannot. Asked before anything is
 * taken down, so a refusal leaves the bot exactly as it was.
 */
function folderConflict(workRoot: string, from: string, to: string): string | null {
  const target = join(workRoot, to);
  if (holdsAnything(join(workRoot, from)) && holdsAnything(target)) {
    return `${target} already exists and is not empty, so ${from}'s folder cannot be moved there`;
  }
  return null;
}

/**
 * Moves `<workRoot>/<from>` to `<workRoot>/<to>`.
 *
 * Only an empty folder is ever given up: an empty target is replaced, and an
 * empty source — which is what hostd's own start makes for a bot the database
 * still calls by its old name — is what a move that already happened leaves.
 * Two folders that both hold something are refused, not merged.
 */
export function moveBotHome(workRoot: string, from: string, to: string): 'moved' | 'already moved' | 'nothing to move' {
  const conflict = folderConflict(workRoot, from, to);
  if (conflict) throw new RenameRefused(409, conflict);

  const source = join(workRoot, from);
  const target = join(workRoot, to);
  if (!holdsAnything(source)) {
    rmSync(source, { recursive: true, force: true });
    return holdsAnything(target) ? 'already moved' : 'nothing to move';
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(source, target);
  return 'moved';
}

/**
 * What tasks left in a bot's folder, cleared after a move.
 *
 * No task is running on the bot — the rename was refused otherwise — so each
 * clone belongs to a task that is over or paused, and a task resumed later
 * starts a fresh clone off its branch, as it always has. Their branches were
 * kept in the repositories' mirrors before this runs
 * (`HeldTasks.pruneAbandonedWorktrees`). The clones and the task briefings
 * go. A bot's own mirrors under `repos/` are from before mirrors were one per
 * repository; any worktree they still list is forgotten with `git worktree
 * prune`.
 */
export async function clearTaskDebris(home: string): Promise<void> {
  rmSync(join(home, 'wt'), { recursive: true, force: true });
  rmSync(join(home, 'context'), { recursive: true, force: true });

  const repos = join(home, 'repos');
  if (!existsSync(repos)) return;
  for (const entry of readdirSync(repos, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
    await run('git', ['worktree', 'prune'], { cwd: join(repos, entry.name) }).catch(() => undefined);
  }
}

/** What `TaskRunner` has to say about the tasks it holds. */
export interface HeldTasks {
  activeTaskIds(): string[];
  sessionOf(taskId: string): { bot: string } | null;
  end(taskId: string, reason: string): Promise<void>;
  /** Keeps the branches of the clones in a bot's folder in their mirrors, then removes the clones. */
  pruneAbandonedWorktrees?(bot: string): Promise<number>;
}

export interface RenameComputerInput {
  from: string;
  to: string;
  driver: ExecDriver;
  runner: HeldTasks;
  workRoot: string;
  /** A task's state as the database has it, or null for a task with no row. */
  taskState: (taskId: string) => Promise<string | null>;
}

export interface RenamedComputer {
  from: string;
  to: string;
  folder: ReturnType<typeof moveBotHome>;
}

/**
 * Renames a bot's computer: refuses while it is working, takes down what the
 * old name holds, and carries the folder across. On the local driver the bot
 * then has its idle shell under the new name, before the bridge says it has
 * been renamed; under docker nothing is made until its next task starts.
 *
 * A task that is queued or running refuses the rename; the bridge checks the
 * same thing and asks again later. A task hostd still holds for any other
 * reason — paused on a gate, or over and not yet released — is ended here: its
 * session is in the container about to go, and a resumption starts a new
 * session in a fresh worktree under whatever the bot is called by then.
 */
export async function renameBotComputer(input: RenameComputerInput): Promise<RenamedComputer> {
  const { from, to, driver, runner, workRoot } = input;
  if (!PATH_SEGMENT.test(from)) throw new RenameRefused(400, `${JSON.stringify(from)} is not a bot's name`);
  if (!isBotName(to)) {
    throw new RenameRefused(400, `${JSON.stringify(to)} cannot be a bot's name: a GitHub login, lowercased, or a seat`);
  }
  if (from === to) throw new RenameRefused(400, `${from} is already called ${to}`);

  const held = runner.activeTaskIds().filter((taskId) => runner.sessionOf(taskId)?.bot === from);
  for (const taskId of held) {
    const state = await input.taskState(taskId);
    if (state === 'queued' || state === 'running') {
      throw new RenameRefused(409, `${from} is ${state === 'queued' ? 'about to start' : 'running'} task ${taskId}; a bot is renamed between tasks`);
    }
  }

  const conflict = folderConflict(workRoot, from, to);
  if (conflict) throw new RenameRefused(409, conflict);

  for (const taskId of held) await runner.end(taskId, `${from} is being renamed ${to}`);

  await driver.removeBot(from);
  const folder = moveBotHome(workRoot, from, to);
  // A paused task's clone holds its unpushed commits, and its resume reads
  // them back from the mirror: kept there before the folder is cleared.
  await runner.pruneAbandonedWorktrees?.(to).catch(() => 0);
  await clearTaskDebris(join(workRoot, to));
  await driver.ensureBot(to);

  return { from, to, folder };
}
