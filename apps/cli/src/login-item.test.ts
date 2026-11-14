import { describe, expect, it } from 'vitest';
import { launchAgentPlist, loginItemSpec, type LoginItemRun } from '@openadlc/shared';
import {
  DOCKER_DID_NOT_ANSWER,
  DOCKER_POLL_MS,
  DOCKER_WAIT_MS,
  openDockerApp,
  registerLoginItem,
  removeLoginItem,
  waitForDocker,
  type LoginItemMachine,
} from './login-item.js';

const PROGRAM = { node: '/usr/local/bin/node', cli: '/src/OpenADLC/apps/cli/dist/main.js' };
const PLIST = '/Users/me/Library/LaunchAgents/dev.openadlc.up.default.plist';
const UNIT = '/Users/me/.config/systemd/user/openadlc-up-default.service';

/** A machine of files in memory, whose launchctl and systemctl remember what they were told. */
function fakeMachine(platform: 'darwin' | 'linux', files: Record<string, string> = {}, extra: Partial<Record<string, LoginItemRun>> = {}) {
  const ran: string[] = [];
  const loaded = new Set<string>();
  const machine: LoginItemMachine = {
    platform,
    userHome: '/Users/me',
    uid: 501,
    user: 'me',
    readFile: (path) => files[path] ?? null,
    writeFile: (path, contents) => void (files[path] = contents),
    removeFile: (path) => void delete files[path],
    makeDir: () => undefined,
    exists: (path) => path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
    run: async (command, args) => {
      const line = [command, ...args].join(' ');
      ran.push(line);
      const given = extra[line];
      if (given) return given;
      // launchd by label: `gui/501/<label>`, from the plist's file name.
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        loaded.add(`${args[1]}/${(args[2] as string).split('/').pop()?.replace(/\.plist$/, '')}`);
        return { code: 0, output: '' };
      }
      if (command === 'launchctl' && args[0] === 'bootout') {
        loaded.delete(args[1] as string);
        return { code: 0, output: '' };
      }
      if (command === 'launchctl' && args[0] === 'print') {
        return loaded.has(args[1] as string) ? { code: 0, output: '' } : { code: 113, output: 'Could not find service' };
      }
      if (command === 'systemctl' && args[1] === 'enable') {
        loaded.add(args[2] as string);
        return { code: 0, output: '' };
      }
      if (command === 'systemctl' && args[1] === 'disable') {
        loaded.delete(args[2] as string);
        return { code: 0, output: '' };
      }
      if (command === 'systemctl' && args[1] === 'is-enabled') {
        return loaded.has(args[2] as string) ? { code: 0, output: 'enabled\n' } : { code: 1, output: 'disabled\n' };
      }
      if (command === 'loginctl') return { code: 0, output: 'Linger=yes\n' };
      return { code: 0, output: '' };
    },
  };
  return { machine, files, ran, loaded };
}

describe('registering the login item', () => {
  it('writes the LaunchAgent and has launchd load it, replacing one already loaded', async () => {
    const { machine, files, ran } = fakeMachine('darwin');
    const outcome = await registerLoginItem({}, PROGRAM, machine);
    expect(outcome).toEqual({ done: 'registered', path: PLIST });
    expect(files[PLIST]).toContain('<string>--at-login</string>');
    expect(ran).toContain('launchctl bootout gui/501/dev.openadlc.up.default');
    expect(ran).toContain(`launchctl bootstrap gui/501 ${PLIST}`);
    expect(ran.indexOf('launchctl bootout gui/501/dev.openadlc.up.default')).toBeLessThan(ran.indexOf(`launchctl bootstrap gui/501 ${PLIST}`));
  });

  it('writes the unit and enables it on Linux, without starting it', async () => {
    const { machine, files, ran } = fakeMachine('linux');
    const outcome = await registerLoginItem({}, PROGRAM, machine);
    expect(outcome).toEqual({ done: 'registered', path: UNIT, linger: true });
    expect(files[UNIT]).toContain('Type=oneshot');
    expect(ran).toContain('systemctl --user daemon-reload');
    expect(ran).toContain('systemctl --user enable openadlc-up-default.service');
    expect(ran.some((line) => line.includes(' start '))).toBe(false);
  });

  it('says why when launchd will not load it', async () => {
    const { machine } = fakeMachine('darwin', {}, { [`launchctl bootstrap gui/501 ${PLIST}`]: { code: 5, output: 'Bootstrap failed: 5: Input/output error\n' } });
    expect(await registerLoginItem({}, PROGRAM, machine)).toEqual({ done: 'failed', path: PLIST, reason: 'launchctl bootstrap said Bootstrap failed: 5: Input/output error' });
  });

  it('refuses to overwrite another install’s item that has the same name, and writes nothing', async () => {
    const other = launchAgentPlist(loginItemSpec({ platform: 'darwin', env: { OPENADLC_HOME: '/Users/me/.openadlc-two' }, userHome: '/Users/me', ...PROGRAM }));
    const { machine, files, ran } = fakeMachine('darwin', { [PLIST]: other });
    expect(await registerLoginItem({}, PROGRAM, machine)).toEqual({ done: 'refused', path: PLIST, home: '/Users/me/.openadlc-two' });
    expect(files[PLIST]).toBe(other);
    expect(ran.some((line) => line.startsWith('launchctl bootstrap') || line.startsWith('launchctl bootout'))).toBe(false);
  });

  it('names a second install’s own item, never the default one', async () => {
    const env = { OPENADLC_HOME: '/tmp/two', OPENADLC_INSTALL_ID: 'two', OPENADLC_BOT_PREFIX: 'two-' };
    const { machine, files } = fakeMachine('darwin');
    const outcome = await registerLoginItem(env, PROGRAM, machine);
    expect(outcome).toEqual({ done: 'registered', path: '/Users/me/Library/LaunchAgents/dev.openadlc.up.two.plist' });
    expect(Object.keys(files)).toEqual(['/Users/me/Library/LaunchAgents/dev.openadlc.up.two.plist']);
    expect(files['/Users/me/Library/LaunchAgents/dev.openadlc.up.two.plist']).not.toMatch(/\/Users\/me\/\.openadlc(?=[/"<]|$)/m);
  });
});

describe('removing the login item', () => {
  it('unloads and deletes this install’s item', async () => {
    const { machine, files, ran } = fakeMachine('darwin');
    await registerLoginItem({}, PROGRAM, machine);
    expect(await removeLoginItem({}, machine)).toBe('removed');
    expect(files[PLIST]).toBeUndefined();
    expect(ran.filter((line) => line === 'launchctl bootout gui/501/dev.openadlc.up.default')).toHaveLength(2);
  });

  it('disables and deletes the unit on Linux', async () => {
    const { machine, files, ran } = fakeMachine('linux');
    await registerLoginItem({}, PROGRAM, machine);
    expect(await removeLoginItem({}, machine)).toBe('removed');
    expect(files[UNIT]).toBeUndefined();
    expect(ran).toContain('systemctl --user disable openadlc-up-default.service');
  });

  it('leaves another install’s item alone', async () => {
    const other = launchAgentPlist(loginItemSpec({ platform: 'darwin', env: { OPENADLC_HOME: '/Users/me/.openadlc-two' }, userHome: '/Users/me', ...PROGRAM }));
    const { machine, files } = fakeMachine('darwin', { [PLIST]: other });
    expect(await removeLoginItem({}, machine)).toBe('other-install');
    expect(files[PLIST]).toBe(other);
  });

  it('has nothing to do when there is none', async () => {
    expect(await removeLoginItem({}, fakeMachine('darwin').machine)).toBe('none');
  });
});

/** A clock that moves only when slept on, and a Docker that answers after `after` ms, if ever. */
function clock(after: number | null, installed = true) {
  let now = 0;
  const opened: string[] = [];
  return {
    opened,
    elapsed: () => now,
    wait: {
      installed: async () => installed,
      answers: async () => after !== null && now >= after,
      open: async () => {
        opened.push('Docker Desktop');
        return 'Docker Desktop';
      },
      sleep: async (ms: number) => void (now += ms),
      now: () => now,
    },
  };
}

describe('waiting for Docker after the computer starts', () => {
  it('goes on at once when Docker answers, opening nothing', async () => {
    const { wait, opened } = clock(0);
    expect(await waitForDocker(wait)).toEqual({ answered: true, opened: null, installed: true });
    expect(opened).toEqual([]);
  });

  it('opens the Docker app and waits for it, asking every 5 seconds', async () => {
    const { wait, opened, elapsed } = clock(42_000);
    expect(await waitForDocker(wait)).toEqual({ answered: true, opened: 'Docker Desktop', installed: true });
    expect(opened).toEqual(['Docker Desktop']);
    expect(elapsed()).toBe(45_000);
    expect(DOCKER_POLL_MS).toBe(5_000);
  });

  it('gives up after 5 minutes when Docker never answers', async () => {
    const { wait, elapsed } = clock(null);
    expect(await waitForDocker(wait)).toEqual({ answered: false, opened: 'Docker Desktop', installed: true });
    expect(elapsed()).toBe(DOCKER_WAIT_MS);
    expect(DOCKER_DID_NOT_ANSWER).toContain('open Docker Desktop (or OrbStack), then run openadlc up');
  });

  it('does not wait where Docker is not installed', async () => {
    const { wait, elapsed } = clock(null, false);
    expect(await waitForDocker(wait)).toEqual({ answered: false, opened: null, installed: false });
    expect(elapsed()).toBe(0);
  });
});

describe('the Docker app it opens', () => {
  it('is Docker Desktop when it is in /Applications', async () => {
    const { machine, ran } = fakeMachine('darwin', { '/Applications/Docker.app/Contents/Info.plist': '' });
    expect(await openDockerApp(machine)).toBe('Docker Desktop');
    expect(ran).toContain('open -a Docker');
  });

  it('is OrbStack when that is what is installed, in ~/Applications too', async () => {
    const { machine, ran } = fakeMachine('darwin', { '/Users/me/Applications/OrbStack.app/x': '' });
    expect(await openDockerApp(machine)).toBe('OrbStack');
    expect(ran).toContain('open -a OrbStack');
  });

  it('is none when neither is there', async () => {
    expect(await openDockerApp(fakeMachine('darwin').machine)).toBeNull();
  });

  it('is Docker Desktop’s user unit on Linux when it has one', async () => {
    const { machine, ran } = fakeMachine('linux');
    expect(await openDockerApp(machine)).toBe('Docker Desktop');
    expect(ran).toContain('systemctl --user start docker-desktop.service');
    const without = fakeMachine('linux', {}, { 'systemctl --user cat docker-desktop.service': { code: 1, output: 'No files found' } });
    expect(await openDockerApp(without.machine)).toBeNull();
  });
});
