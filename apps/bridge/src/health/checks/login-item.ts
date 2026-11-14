import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import {
  LOGIN_ITEMS_SETTING,
  LOGIN_ITEMS_SETTINGS_URL,
  inspectLoginItem,
  lingerNote,
  loginItemCommand,
  type LoginItemRun,
  type LoginItemState,
} from '@openadlc/shared';
import type { HealthCheck } from '../types.js';

export const LOGIN_ITEM_CHECK = 'login-item';

export interface LoginItemReader {
  /**
   * Whether this install keeps a login item: `OPENADLC_LOGIN_ITEM=on`, which
   * `openadlc up` starts the bridge with. Off for an install that opted out
   * and for a scratch one; unset under the compose stack and the cloud, which
   * start the bridge another way.
   */
  wanted(): boolean;
  /** What launchd or systemd holds for this install, read as the user that ran `up`. */
  inspect(): Promise<LoginItemState>;
  /** What to run to register it again, with another install's variables in front. */
  command(): string;
  /** This user's login name, for the linger note. */
  user(): string;
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

function userName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? '';
  }
}

/** The reader on this machine, from the bridge's own environment, which `up` gave it. */
export function defaultLoginItemReader(env: NodeJS.ProcessEnv = process.env): LoginItemReader {
  return {
    wanted: () => env.OPENADLC_LOGIN_ITEM === 'on',
    inspect: () =>
      inspectLoginItem({
        platform: process.platform,
        env,
        userHome: homedir(),
        uid: process.getuid?.() ?? 0,
        user: userName(),
        readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
        run: runCommand,
      }),
    command: () => loginItemCommand(env, homedir()),
    user: userName,
  };
}

/**
 * Whether this install comes back by itself after the computer restarts:
 * its login item is there and loaded (docs/adr/0061-a-local-install-comes-back-by-a-login-item-that-runs-up.md).
 *
 * Judged by what launchd or systemd holds, never by the choice in
 * install.json: a person can turn a background item off under Login Items,
 * or delete the plist, and nothing else would notice until a restart left
 * the crew stopped, as one did for about 28 hours. An install that opted out
 * returns no subject, so a card from before the opt-out is forgotten.
 */
export function loginItemCheck(reader: LoginItemReader): HealthCheck {
  return {
    id: LOGIN_ITEM_CHECK,
    proves: 'This install starts again by itself after the computer restarts',
    how: 'reads its LaunchAgent or systemd user unit, checks it names this install’s home, and asks launchctl or systemctl whether it is loaded',
    everyMinutes: 10,
    steps: [],
    async run() {
      if (!reader.wanted()) return [];
      const state = await reader.inspect();
      const command = reader.command();
      const rerun = { label: 'Run in a terminal', command };
      switch (state.state) {
        case 'registered':
          return [{ ok: true, says: `${state.path}${state.linger === false ? `; it ${lingerNote(reader.user())}` : ''}`, fixed: 'This install starts again after a restart' }];
        case 'missing':
          return [
            {
              ok: false,
              severity: 'warning',
              title: 'Nothing starts OpenADLC again after this computer restarts',
              detail: `This install has no login item, so after a restart the crew stays stopped until someone runs openadlc up. Run \`${command}\` in a terminal.`,
              action: rerun,
            },
          ];
        case 'not-loaded':
          return [
            {
              ok: false,
              severity: 'warning',
              title: 'OpenADLC’s login item is not loaded',
              detail: `${state.path} is there, but it is not loaded, so nothing starts this install after a restart. Run \`${command}\` in a terminal.`,
              action: rerun,
            },
          ];
        case 'disabled':
          return [
            {
              ok: false,
              severity: 'warning',
              title: 'OpenADLC’s login item is turned off in macOS',
              detail: `macOS keeps it from running, so nothing starts this install after a restart. Turn on OpenADLC under ${LOGIN_ITEMS_SETTING}, then run \`${command}\`.`,
              action: { label: 'Open Login Items', url: LOGIN_ITEMS_SETTINGS_URL },
            },
          ];
        case 'other-install':
          return [
            {
              ok: false,
              severity: 'warning',
              title: 'The login item here starts another install',
              detail: `${state.path} starts the install at ${state.home}, so nothing starts this one after a restart. Set OPENADLC_INSTALL_ID (and OPENADLC_BOT_PREFIX) for this install and run \`${command}\` with them.`,
              action: rerun,
            },
          ];
        case 'unsupported':
          return [{ ok: null, reason: state.reason }];
      }
    },
  };
}
