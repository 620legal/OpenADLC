import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import {
  inspectLoginItem,
  loginItemContents,
  loginItemSpec,
  type LoginItemPlatform,
  type LoginItemRun,
  type LoginItemState,
} from '@openadlc/shared';

/**
 * What writing, loading and removing the login item does to this machine
 * (`@openadlc/shared`'s login-item module says what it is). Node's own `fs`
 * and `execFile` outside the tests; the tests give a machine of their own.
 */
export interface LoginItemMachine {
  platform: NodeJS.Platform;
  userHome: string;
  uid: number;
  user: string;
  readFile(path: string): string | null;
  writeFile(path: string, contents: string): void;
  removeFile(path: string): void;
  /** Makes a folder of the owner's alone: the log's, under the install's home. */
  makeDir(path: string): void;
  exists(path: string): boolean;
  run(command: string, args: string[]): Promise<LoginItemRun>;
}

function runCommand(command: string, args: string[]): Promise<LoginItemRun> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`;
      if (!error) return resolve({ code: 0, output });
      const code = (error as { code?: unknown }).code;
      resolve({ code: typeof code === 'number' ? code : code === 'ENOENT' ? null : 1, output });
    });
  });
}

export function thisMachine(): LoginItemMachine {
  const info = (() => {
    try {
      return userInfo();
    } catch {
      return null;
    }
  })();
  return {
    platform: process.platform,
    userHome: homedir(),
    uid: process.getuid?.() ?? info?.uid ?? 0,
    user: info?.username ?? process.env.USER ?? '',
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    writeFile: (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: 0o644 });
    },
    removeFile: (path) => rmSync(path, { force: true }),
    makeDir: (path) => void mkdirSync(path, { recursive: true, mode: 0o700 }),
    exists: existsSync,
    run: runCommand,
  };
}

/** What is registered for the install `env` names, as doctor and the bridge judge it. */
export function inspect(env: NodeJS.ProcessEnv, machine: LoginItemMachine = thisMachine()): Promise<LoginItemState> {
  return inspectLoginItem({ ...machine, env });
}

export type RegisterOutcome =
  | { done: 'registered'; path: string; linger?: boolean }
  /** The name is held by another install's item, which was left alone. */
  | { done: 'refused'; path: string; home: string }
  | { done: 'unsupported'; reason: string }
  /** Written, but launchd or systemd would not take it. */
  | { done: 'failed'; path: string; reason: string };

function firstLine(output: string): string {
  return output.split('\n').map((line) => line.trim()).find(Boolean) ?? 'it said nothing';
}

/**
 * Writes this install's item and has launchd load it or systemd enable it.
 *
 * Not `systemctl start`: the unit runs `up`, which is what is running now. On
 * macOS `bootstrap` does run it at once (`RunAtLoad`), and that `up
 * --at-login` finds the keepers running and exits. The item already loaded is
 * booted out first, so a new node or `PATH` is what launchd holds.
 */
export async function registerLoginItem(
  env: NodeJS.ProcessEnv,
  program: { node: string; cli: string },
  machine: LoginItemMachine = thisMachine(),
): Promise<RegisterOutcome> {
  const state = await inspect(env, machine);
  if (state.state === 'unsupported') return { done: 'unsupported', reason: state.reason };
  if (state.state === 'other-install') return { done: 'refused', path: state.path, home: state.home };
  const platform = machine.platform as LoginItemPlatform;
  const spec = loginItemSpec({ platform, env, userHome: machine.userHome, ...program });
  mkdirLog(spec.log, machine);
  machine.writeFile(spec.path, loginItemContents(spec));

  if (platform === 'darwin') {
    const domain = `gui/${machine.uid}`;
    await machine.run('launchctl', ['bootout', `${domain}/${spec.name}`]);
    const loaded = await machine.run('launchctl', ['bootstrap', domain, spec.path]);
    if (loaded.code !== 0) return { done: 'failed', path: spec.path, reason: `launchctl bootstrap said ${firstLine(loaded.output)}` };
    return { done: 'registered', path: spec.path };
  }

  await machine.run('systemctl', ['--user', 'daemon-reload']);
  const enabled = await machine.run('systemctl', ['--user', 'enable', spec.name]);
  if (enabled.code !== 0) return { done: 'failed', path: spec.path, reason: `systemctl --user enable said ${firstLine(enabled.output)}` };
  const after = await inspect(env, machine);
  return { done: 'registered', path: spec.path, ...(after.state === 'registered' && after.linger !== undefined ? { linger: after.linger } : {}) };
}

/** The log's folder, made before launchd or systemd open the file in it. */
function mkdirLog(log: string, machine: LoginItemMachine): void {
  if (machine.exists(dirname(log))) return;
  try {
    machine.makeDir(dirname(log));
  } catch {
    // `up` makes the run folder itself; a log that cannot be opened is said by launchd.
  }
}

export type RemoveOutcome = 'removed' | 'none' | 'other-install' | 'unsupported';

/**
 * Takes this install's item off: unloaded first, then its file. Only an item
 * that names this install's home: another install with no
 * `OPENADLC_INSTALL_ID` has the same name, and is not this one's to remove.
 * Unloading never stops a service: the plist abandons its process group and
 * the unit kills only its own process, which `up` was and is long gone.
 */
export async function removeLoginItem(env: NodeJS.ProcessEnv, machine: LoginItemMachine = thisMachine()): Promise<RemoveOutcome> {
  const state = await inspect(env, machine);
  if (state.state === 'unsupported') return 'unsupported';
  if (state.state === 'other-install') return 'other-install';
  if (state.state === 'missing') return 'none';
  const platform = machine.platform as LoginItemPlatform;
  const spec = loginItemSpec({ platform, env, userHome: machine.userHome, node: '', cli: '' });
  if (platform === 'darwin') {
    await machine.run('launchctl', ['bootout', `gui/${machine.uid}/${spec.name}`]);
    machine.removeFile(spec.path);
  } else {
    await machine.run('systemctl', ['--user', 'disable', spec.name]);
    machine.removeFile(spec.path);
    await machine.run('systemctl', ['--user', 'daemon-reload']);
  }
  return 'removed';
}

/** How long `up --at-login` waits for Docker after the computer starts, and how often it asks. */
export const DOCKER_WAIT_MS = 5 * 60_000;
export const DOCKER_POLL_MS = 5_000;

export const DOCKER_DID_NOT_ANSWER =
  'Docker did not answer within 5 minutes after this computer started: open Docker Desktop (or OrbStack), then run openadlc up';

export interface DockerWait {
  /** Whether `docker` is on this machine at all. */
  installed(): Promise<boolean>;
  /** Whether `docker info` succeeds. */
  answers(): Promise<boolean>;
  /** Opens the Docker app found here, and says which; null when there is none to open. */
  open(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Waits for Docker after the computer starts, opening the app it finds when
 * the daemon does not answer: Docker Desktop and OrbStack start at login only
 * if someone ticked that, and the login item may run before either is up.
 * Returns whether Docker answered, and what was opened.
 */
export async function waitForDocker(wait: DockerWait): Promise<{ answered: boolean; opened: string | null; installed: boolean }> {
  if (!(await wait.installed())) return { answered: false, opened: null, installed: false };
  if (await wait.answers()) return { answered: true, opened: null, installed: true };
  const opened = await wait.open();
  const until = wait.now() + DOCKER_WAIT_MS;
  while (wait.now() < until) {
    await wait.sleep(DOCKER_POLL_MS);
    if (await wait.answers()) return { answered: true, opened, installed: true };
  }
  return { answered: false, opened, installed: true };
}

/** The Docker app on this machine, opened: Docker Desktop or OrbStack on macOS, Docker Desktop's user unit on Linux. */
export async function openDockerApp(machine: LoginItemMachine = thisMachine()): Promise<string | null> {
  if (machine.platform === 'darwin') {
    for (const app of ['Docker', 'OrbStack']) {
      const found = ['/Applications', join(machine.userHome, 'Applications')].some((dir) => machine.exists(join(dir, `${app}.app`)));
      if (!found) continue;
      const opened = await machine.run('open', ['-a', app]);
      if (opened.code === 0) return app === 'Docker' ? 'Docker Desktop' : app;
    }
    return null;
  }
  if (machine.platform === 'linux') {
    const unit = await machine.run('systemctl', ['--user', 'cat', 'docker-desktop.service']);
    if (unit.code !== 0) return null;
    const started = await machine.run('systemctl', ['--user', 'start', 'docker-desktop.service']);
    return started.code === 0 ? 'Docker Desktop' : null;
  }
  return null;
}
