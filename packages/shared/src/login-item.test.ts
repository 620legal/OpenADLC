import { describe, expect, it } from 'vitest';
import {
  homeNamedBy,
  inspectLoginItem,
  launchAgentPlist,
  loginItemCommand,
  loginItemContents,
  loginItemSpec,
  systemdUnit,
  type LoginItemRun,
} from './login-item.js';

const USER_HOME = '/Users/me';
const DEFAULT_HOME = '/Users/me/.openadlc';
const SECOND = {
  OPENADLC_HOME: '/tmp/a b&c/.openadlc-scratch',
  OPENADLC_INSTALL_ID: 'scratch',
  OPENADLC_BOT_PREFIX: 'scratch-',
  OPENADLC_BOT_IMAGE: 'img:x',
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
};

const spec = (platform: 'darwin' | 'linux', env: NodeJS.ProcessEnv) =>
  loginItemSpec({ platform, env, userHome: USER_HOME, node: '/opt/homebrew/bin/node', cli: '/src/OpenADLC/apps/cli/dist/main.js' });

/** The default install's home, as a whole path: `.openadlc-scratch` starts with it. */
const NAMES_DEFAULT_HOME = /\/Users\/me\/\.openadlc(?=[/"<\s]|$)/m;

describe('the login item for the default install', () => {
  it('is a LaunchAgent that runs up --at-login for ~/.openadlc, named after the install', () => {
    const item = spec('darwin', { PATH: '/usr/local/bin:/usr/bin' });
    expect(item.name).toBe('dev.openadlc.up.default');
    expect(item.path).toBe('/Users/me/Library/LaunchAgents/dev.openadlc.up.default.plist');
    expect(item.args).toEqual(['/opt/homebrew/bin/node', '/src/OpenADLC/apps/cli/dist/main.js', 'up', '--at-login']);
    expect(item.environment).toEqual({ OPENADLC_HOME: DEFAULT_HOME, PATH: '/usr/local/bin:/usr/bin', OPENADLC_NO_SIGN_IN_LINK: '1' });
    expect(item.log).toBe(`${DEFAULT_HOME}/run/login-item.log`);

    const plist = launchAgentPlist(item);
    expect(plist).toContain('<key>Label</key>\n  <string>dev.openadlc.up.default</string>');
    expect(plist).toContain('<key>OPENADLC_HOME</key>\n    <string>/Users/me/.openadlc</string>');
    expect(plist).toContain('<key>OPENADLC_NO_SIGN_IN_LINK</key>\n    <string>1</string>');
    expect(plist).toContain('<string>up</string>\n    <string>--at-login</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    // up exits once the keepers run, and launchd must not take them with it.
    expect(plist).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(plist).not.toContain('KeepAlive');
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${DEFAULT_HOME}/run/login-item.log</string>`);
  });

  it('is a systemd user unit on Linux, oneshot, that never takes the keepers with it', () => {
    const item = spec('linux', { PATH: '/usr/bin' });
    expect(item.name).toBe('openadlc-up-default.service');
    expect(item.path).toBe('/Users/me/.config/systemd/user/openadlc-up-default.service');
    const unit = systemdUnit(item);
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('KillMode=process');
    expect(unit).toContain(`Environment="OPENADLC_HOME=${DEFAULT_HOME}"`);
    expect(unit).toContain('Environment="OPENADLC_NO_SIGN_IN_LINK=1"');
    expect(unit).toContain('Environment="PATH=/usr/bin"');
    expect(unit).toContain('ExecStart="/opt/homebrew/bin/node" "/src/OpenADLC/apps/cli/dist/main.js" "up" "--at-login"');
    expect(unit).toContain(`StandardOutput=append:${DEFAULT_HOME}/run/login-item.log`);
    expect(unit).toContain('WantedBy=default.target');
  });

  it('follows XDG_CONFIG_HOME for where the unit goes', () => {
    expect(spec('linux', { XDG_CONFIG_HOME: '/xdg' }).path).toBe('/xdg/systemd/user/openadlc-up-default.service');
  });
});

describe('the login item for a second install', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`names that install's home and its four variables, and never ~/.openadlc (${platform})`, () => {
      const item = spec(platform, SECOND);
      expect(item.name).toBe(platform === 'darwin' ? 'dev.openadlc.up.scratch' : 'openadlc-up-scratch.service');
      expect(item.environment).toMatchObject({
        OPENADLC_HOME: '/tmp/a b&c/.openadlc-scratch',
        OPENADLC_INSTALL_ID: 'scratch',
        OPENADLC_BOT_PREFIX: 'scratch-',
        OPENADLC_BOT_IMAGE: 'img:x',
      });
      const contents = loginItemContents(item);
      if (platform === 'darwin') {
        expect(contents).toContain('<string>/tmp/a b&amp;c/.openadlc-scratch</string>');
        expect(contents).toContain('<key>OPENADLC_INSTALL_ID</key>\n    <string>scratch</string>');
        expect(contents).toContain('<key>OPENADLC_BOT_PREFIX</key>\n    <string>scratch-</string>');
        expect(contents).toContain('<key>OPENADLC_BOT_IMAGE</key>\n    <string>img:x</string>');
        expect(contents).toContain('<string>/tmp/a b&amp;c/.openadlc-scratch/run/login-item.log</string>');
      } else {
        expect(contents).toContain('Environment="OPENADLC_HOME=/tmp/a b&c/.openadlc-scratch"');
        expect(contents).toContain('Environment="OPENADLC_INSTALL_ID=scratch"');
        expect(contents).toContain('Environment="OPENADLC_BOT_PREFIX=scratch-"');
        expect(contents).toContain('Environment="OPENADLC_BOT_IMAGE=img:x"');
      }
      expect(contents).not.toMatch(NAMES_DEFAULT_HOME);
      expect(homeNamedBy(platform, contents)).toBe('/tmp/a b&c/.openadlc-scratch');
    });
  }

  it('escapes what systemd would read as a quote, a specifier or a variable', () => {
    const unit = systemdUnit(spec('linux', { OPENADLC_HOME: '/h/50%"x', OPENADLC_BOT_IMAGE: 'a\\b' }));
    expect(unit).toContain('Environment="OPENADLC_HOME=/h/50%%\\"x"');
    expect(unit).toContain('Environment="OPENADLC_BOT_IMAGE=a\\\\b"');
    expect(homeNamedBy('linux', unit)).toBe('/h/50%"x');
    const dollar = systemdUnit(loginItemSpec({ platform: 'linux', env: {}, userHome: USER_HOME, node: '/n$x', cli: '/c' }));
    expect(dollar).toContain('ExecStart="/n$$x"');
  });

  it('keeps the id to characters a label and a unit name take', () => {
    expect(spec('darwin', { OPENADLC_INSTALL_ID: 'a b/c' }).name).toBe('dev.openadlc.up.a-b-c');
  });
});

describe('what the login item never carries', () => {
  it('leaves out every variable outside the allowlist, credentials and the database url above all', () => {
    const env = { ...SECOND, DATABASE_URL: 'postgres://u:secret@127.0.0.1/db', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x', HOME: '/Users/me' };
    for (const platform of ['darwin', 'linux'] as const) {
      const item = spec(platform, env);
      expect(Object.keys(item.environment).sort()).toEqual(
        ['OPENADLC_BOT_IMAGE', 'OPENADLC_BOT_PREFIX', 'OPENADLC_HOME', 'OPENADLC_INSTALL_ID', 'OPENADLC_NO_SIGN_IN_LINK', 'PATH'].sort(),
      );
      const contents = loginItemContents(item);
      for (const word of ['DATABASE_URL', 'secret', 'ANTHROPIC_API_KEY', 'sk-ant-x', 'OPENAI_API_KEY']) expect(contents).not.toContain(word);
    }
  });
});

/** A machine whose files and commands say what a test needs. */
function machine(files: Record<string, string>, answers: Record<string, LoginItemRun>) {
  const ran: string[] = [];
  return {
    ran,
    readFile: (path: string) => files[path] ?? null,
    run: async (command: string, args: string[]): Promise<LoginItemRun> => {
      const line = [command, ...args].join(' ');
      ran.push(line);
      return answers[line] ?? { code: 1, output: '' };
    },
  };
}

const inspect = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, m: ReturnType<typeof machine>) =>
  inspectLoginItem({ platform, env, userHome: USER_HOME, uid: 501, user: 'me', readFile: m.readFile, run: m.run });

describe('what is registered for an install', () => {
  const plist = launchAgentPlist(spec('darwin', {}));
  const plistPath = '/Users/me/Library/LaunchAgents/dev.openadlc.up.default.plist';
  const unit = systemdUnit(spec('linux', {}));
  const unitPath = '/Users/me/.config/systemd/user/openadlc-up-default.service';

  it('is registered on macOS when the plist names this home and launchd has it loaded', async () => {
    const m = machine({ [plistPath]: plist }, { 'launchctl print gui/501/dev.openadlc.up.default': { code: 0, output: 'state = not running' } });
    expect(await inspect('darwin', {}, m)).toEqual({ state: 'registered', path: plistPath });
  });

  it('is missing when there is no file', async () => {
    expect(await inspect('darwin', {}, machine({}, {}))).toEqual({ state: 'missing', path: plistPath });
  });

  it('is not loaded when the plist is there and launchd does not have it', async () => {
    expect(await inspect('darwin', {}, machine({ [plistPath]: plist }, {}))).toEqual({ state: 'not-loaded', path: plistPath });
  });

  it('is disabled when it was turned off under Login Items', async () => {
    const m = machine(
      { [plistPath]: plist },
      {
        'launchctl print-disabled gui/501': { code: 0, output: 'disabled services = {\n\t"dev.openadlc.up.default" => disabled\n\t"com.other" => enabled\n}' },
        'launchctl print gui/501/dev.openadlc.up.default': { code: 0, output: '' },
      },
    );
    expect(await inspect('darwin', {}, m)).toEqual({ state: 'disabled', path: plistPath });
  });

  it('is another install’s when the file names another home', async () => {
    const other = launchAgentPlist(spec('darwin', { OPENADLC_HOME: '/Users/me/elsewhere' }));
    expect(await inspect('darwin', {}, machine({ [plistPath]: other }, {}))).toEqual({ state: 'other-install', path: plistPath, home: '/Users/me/elsewhere' });
  });

  it('is registered on Linux when the unit is enabled, saying whether the user lingers', async () => {
    const m = machine(
      { [unitPath]: unit },
      {
        'systemctl --user is-enabled openadlc-up-default.service': { code: 0, output: 'enabled\n' },
        'loginctl show-user me -p Linger': { code: 0, output: 'Linger=no\n' },
      },
    );
    expect(await inspect('linux', {}, m)).toEqual({ state: 'registered', path: unitPath, linger: false });
  });

  it('is not loaded on Linux when the unit is there but disabled', async () => {
    const m = machine({ [unitPath]: unit }, { 'systemctl --user is-enabled openadlc-up-default.service': { code: 1, output: 'disabled\n' } });
    expect(await inspect('linux', {}, m)).toEqual({ state: 'not-loaded', path: unitPath });
  });

  it('is unsupported where nothing can hold one', async () => {
    expect(await inspect('win32', {}, machine({}, {}))).toMatchObject({ state: 'unsupported' });
    expect(await inspect('linux', {}, machine({}, { 'systemctl --user is-enabled openadlc-up-default.service': { code: null, output: '' } }))).toMatchObject({
      state: 'unsupported',
    });
    const noBus = machine({}, { 'systemctl --user is-enabled openadlc-up-default.service': { code: 1, output: 'Failed to connect to bus: No medium found' } });
    expect(await inspect('linux', {}, noBus)).toMatchObject({ state: 'unsupported', reason: expect.stringContaining('systemd --user is not running') });
  });
});

describe('the command that registers the item again', () => {
  it('is bare for the default install', () => {
    expect(loginItemCommand({}, USER_HOME)).toBe('openadlc up --login-item');
    expect(loginItemCommand({ OPENADLC_HOME: DEFAULT_HOME, OPENADLC_INSTALL_ID: 'default' }, USER_HOME)).toBe('openadlc up --login-item');
  });

  it('carries another install’s variables, quoted, so it does not act on ~/.openadlc', () => {
    expect(loginItemCommand(SECOND, USER_HOME)).toBe(
      "OPENADLC_HOME='/tmp/a b&c/.openadlc-scratch' OPENADLC_INSTALL_ID=scratch OPENADLC_BOT_PREFIX=scratch- openadlc up --login-item",
    );
  });
});
