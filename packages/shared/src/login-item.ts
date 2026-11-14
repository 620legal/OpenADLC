import { join, resolve } from 'node:path';

/**
 * The login item that brings a local install back after the computer restarts:
 * a LaunchAgent on macOS, a `systemd --user` unit on Linux, one per install,
 * running `openadlc up --at-login` for it
 * (docs/adr/0061-a-local-install-comes-back-by-a-login-item-that-runs-up.md).
 *
 * Its name, its contents, and how to read back what is registered. The CLI
 * writes it and `openadlc doctor` judges it; the bridge's `login-item` check
 * judges it too, and cannot import the CLI, so both read it through here. This
 * module starts no process and touches no file: the caller passes `readFile`
 * and `run`, so the tests say what `launchctl` or `systemctl` would.
 *
 * A restart once stopped a real install for about 28 hours. The database
 * container came back by its restart policy; hostd, the bridge and the
 * console are detached processes, and nothing started them.
 */

export type LoginItemPlatform = 'darwin' | 'linux';

/**
 * The variables the item carries, and nothing else. A second install on the
 * machine is told apart by the first four: started without them, `up` would
 * start the default install's names (`openadlc-db`, `task-*`). `PATH` because
 * launchd starts an agent with `/usr/bin:/bin:/usr/sbin:/sbin`, where neither
 * `docker` nor a Homebrew node is. Never a credential or `DATABASE_URL`: the
 * file sits in `~/Library/LaunchAgents` or `~/.config`, where a copy of the
 * whole shell would leave an exported model key.
 */
export const LOGIN_ITEM_VARIABLES = ['OPENADLC_HOME', 'OPENADLC_INSTALL_ID', 'OPENADLC_BOT_PREFIX', 'OPENADLC_BOT_IMAGE'] as const;

/** The id the item is named after: `OPENADLC_INSTALL_ID`, or `default`, in characters a label and a unit name take. */
export function loginItemId(env: NodeJS.ProcessEnv): string {
  const id = env.OPENADLC_INSTALL_ID?.trim();
  return id ? id.replace(/[^A-Za-z0-9_.-]/g, '-') : 'default';
}

/** The install's home, absolute, as `openadlcHome()` reads it. */
export function loginItemHome(env: NodeJS.ProcessEnv, userHome: string): string {
  return resolve(env.OPENADLC_HOME || join(userHome, '.openadlc'));
}

/** The launchd label, or the systemd unit's file name. */
export function loginItemName(platform: LoginItemPlatform, env: NodeJS.ProcessEnv): string {
  const id = loginItemId(env);
  return platform === 'darwin' ? `dev.openadlc.up.${id}` : `openadlc-up-${id}.service`;
}

/** Where the item's file is. */
export function loginItemPath(platform: LoginItemPlatform, env: NodeJS.ProcessEnv, userHome: string): string {
  const name = loginItemName(platform, env);
  if (platform === 'darwin') return join(userHome, 'Library', 'LaunchAgents', `${name}.plist`);
  return join(env.XDG_CONFIG_HOME || join(userHome, '.config'), 'systemd', 'user', name);
}

export interface LoginItemSpec {
  platform: LoginItemPlatform;
  /** The launchd label, or the unit's file name. */
  name: string;
  /** Where its file is written. */
  path: string;
  /** The install's home, absolute: what the item names. */
  home: string;
  /** What it runs: node, the CLI, `up --at-login`. */
  args: string[];
  /** What it runs with: `LOGIN_ITEM_VARIABLES` that are set, `PATH`, and no sign-in link. */
  environment: Record<string, string>;
  /** Where what it says goes: `<home>/run/login-item.log`. */
  log: string;
}

/**
 * The item for this install. `OPENADLC_HOME` is always written, absolute, even
 * for the default install, so a later change of what the default is cannot
 * move it. `OPENADLC_NO_SIGN_IN_LINK`, as self-update sets it: what `up` says
 * goes to a log, and whoever reads that has not signed in.
 */
export function loginItemSpec(input: {
  platform: LoginItemPlatform;
  env: NodeJS.ProcessEnv;
  userHome: string;
  node: string;
  cli: string;
}): LoginItemSpec {
  const { platform, env, userHome } = input;
  const home = loginItemHome(env, userHome);
  const environment: Record<string, string> = { OPENADLC_HOME: home };
  for (const key of LOGIN_ITEM_VARIABLES) {
    if (key === 'OPENADLC_HOME') continue;
    const value = env[key];
    if (value) environment[key] = value;
  }
  environment.PATH = env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  environment.OPENADLC_NO_SIGN_IN_LINK = '1';
  return {
    platform,
    name: loginItemName(platform, env),
    path: loginItemPath(platform, env, userHome),
    home,
    args: [input.node, input.cli, 'up', '--at-login'],
    environment,
    log: join(home, 'run', 'login-item.log'),
  };
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unxml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The LaunchAgent. `RunAtLoad` and no `KeepAlive`: it runs once at login,
 * and the keepers it starts keep the services. `AbandonProcessGroup`, because
 * `up` exits once it has started them, and launchd otherwise kills what is
 * left in the job's process group when it does.
 */
export function launchAgentPlist(spec: LoginItemSpec): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${string(spec.name)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...spec.args.map((arg) => `    ${string(arg)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(spec.environment).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    ${string(value)}`]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>AbandonProcessGroup</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  ${string(spec.log)}`,
    '  <key>StandardErrorPath</key>',
    `  ${string(spec.log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** A value inside a double-quoted systemd word: `\` and `"` escaped, `%` (a specifier) doubled. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** An `ExecStart` word: as `quoted`, and `$`, which systemd expands there, doubled. */
function execWord(value: string): string {
  return quoted(value.replace(/\$/g, '$$$$'));
}

function unquoted(value: string): string {
  return value.replace(/%%/g, '%').replace(/\\(["\\])/g, '$1');
}

/**
 * The `systemd --user` unit. Oneshot, staying "active" after `up` exits, and
 * `KillMode=process`, so that stopping or disabling the unit never takes the
 * keepers `up` started with it.
 */
export function systemdUnit(spec: LoginItemSpec): string {
  return [
    '[Unit]',
    `Description=OpenADLC (${spec.home}): openadlc up after this computer starts`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'KillMode=process',
    ...Object.entries(spec.environment).map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}`),
    `ExecStart=${spec.args.map(execWord).join(' ')}`,
    `StandardOutput=append:${spec.log.replace(/%/g, '%%')}`,
    `StandardError=append:${spec.log.replace(/%/g, '%%')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The item's file for this platform. */
export function loginItemContents(spec: LoginItemSpec): string {
  return spec.platform === 'darwin' ? launchAgentPlist(spec) : systemdUnit(spec);
}

/** The `OPENADLC_HOME` an item's file names, or null when it names none. */
export function homeNamedBy(platform: LoginItemPlatform, contents: string): string | null {
  if (platform === 'darwin') {
    const found = /<key>OPENADLC_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents);
    return found ? unxml(found[1] ?? '') : null;
  }
  const found = /^Environment="OPENADLC_HOME=((?:[^"\\]|\\.)*)"\s*$/m.exec(contents);
  return found ? unquoted(found[1] ?? '') : null;
}

/** What running a command said: `code` null when it could not be run at all. */
export interface LoginItemRun {
  code: number | null;
  output: string;
}

export type LoginItemState =
  /** The file names this home, and launchd has it loaded or systemd has it enabled. */
  | { state: 'registered'; path: string; linger?: boolean }
  /** No file. */
  | { state: 'missing'; path: string }
  /** A file, but launchd has not loaded it, or systemd has not enabled it. */
  | { state: 'not-loaded'; path: string }
  /** macOS: turned off under System Settings > General > Login Items. */
  | { state: 'disabled'; path: string }
  /** The file names another install's home: two installs with no `OPENADLC_INSTALL_ID` share the name. */
  | { state: 'other-install'; path: string; home: string }
  /** Nothing here can hold one. */
  | { state: 'unsupported'; reason: string };

/**
 * What is registered for this install, judged by the file and by what launchd
 * or systemd holds, never by a setting that says it was done. On Linux a
 * registered unit also says whether the user lingers: without it, a user unit
 * starts at the next login, not at boot.
 */
export async function inspectLoginItem(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  userHome: string;
  uid: number;
  user: string;
  readFile: (path: string) => string | null;
  run: (command: string, args: string[]) => Promise<LoginItemRun>;
}): Promise<LoginItemState> {
  const { platform, env, userHome } = input;
  if (platform !== 'darwin' && platform !== 'linux') {
    return { state: 'unsupported', reason: `a login item is written on macOS and Linux, and this is ${platform}` };
  }
  const name = loginItemName(platform, env);
  const path = loginItemPath(platform, env, userHome);

  let enabled: LoginItemRun | null = null;
  if (platform === 'linux') {
    enabled = await input.run('systemctl', ['--user', 'is-enabled', name]);
    if (enabled.code === null) return { state: 'unsupported', reason: 'systemctl is not on this machine, so there is no systemd --user to hold a login item' };
    if (/failed to connect to (user )?bus|no medium found/i.test(enabled.output)) {
      return { state: 'unsupported', reason: 'systemd --user is not running for this user, so it cannot hold a login item' };
    }
  }

  const contents = input.readFile(path);
  if (contents === null) return { state: 'missing', path };
  const named = homeNamedBy(platform, contents);
  const home = loginItemHome(env, userHome);
  if (named !== null && resolve(named) !== home) return { state: 'other-install', path, home: named };

  if (platform === 'darwin') {
    const disabled = await input.run('launchctl', ['print-disabled', `gui/${input.uid}`]);
    const label = name.replace(/[.]/g, '\\.');
    if (new RegExp(`"${label}"\\s*=>\\s*(disabled|true)`).test(disabled.output)) return { state: 'disabled', path };
    const loaded = await input.run('launchctl', ['print', `gui/${input.uid}/${name}`]);
    return loaded.code === 0 ? { state: 'registered', path } : { state: 'not-loaded', path };
  }

  if (enabled?.output.trim().split('\n')[0]?.trim() !== 'enabled') return { state: 'not-loaded', path };
  const linger = await input.run('loginctl', ['show-user', input.user, '-p', 'Linger']);
  return { state: 'registered', path, linger: /Linger=yes/.test(linger.output) };
}

/** A word for a POSIX shell, quoted only when it has to be. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that registers the item again, for doctor and the bridge's
 * card. For an install other than the default one it is prefixed with that
 * install's own variables: run bare, it would act on `~/.openadlc`.
 */
export function loginItemCommand(env: NodeJS.ProcessEnv, userHome: string): string {
  const defaultHome = resolve(join(userHome, '.openadlc'));
  const other = loginItemId(env) !== 'default' || loginItemHome(env, userHome) !== defaultHome;
  if (!other) return 'openadlc up --login-item';
  const prefix = (['OPENADLC_HOME', 'OPENADLC_INSTALL_ID', 'OPENADLC_BOT_PREFIX'] as const)
    .filter((key) => env[key])
    .map((key) => `${key}=${shellWord(key === 'OPENADLC_HOME' ? loginItemHome(env, userHome) : (env[key] as string))}`);
  return [...prefix, 'openadlc up --login-item'].join(' ');
}

/** Where macOS turns a background item on: System Settings > General > Login Items. */
export const LOGIN_ITEMS_SETTING = 'System Settings > General > Login Items';
export const LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

/** What to do about a Linux user unit without linger. */
export function lingerNote(user: string): string {
  return `starts at your next login, not at boot: loginctl enable-linger ${user}`;
}
