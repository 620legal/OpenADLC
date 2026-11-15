import { describe, expect, it } from 'vitest';
import { accountEnv, asAccount, probeAccount, type HostProcesses } from './account-probe.js';
import { hostCheckEnv } from './host-check.js';

const PLACES = { openadlcHome: '/Users/jane/.openadlc', workRoot: '/Users/jane/.openadlc', hostdHome: '/Users/jane', dockerSockets: [], uid: 501 };

/** A machine where `id -u` answers `uid` and everything else fails, so the probe stops early. */
function machine(uid: string | null): HostProcesses {
  return {
    async run(argv) {
      if (argv[0] === 'id') return uid === null ? { code: 1, stdout: '', stderr: 'no such user' } : { code: 0, stdout: `${uid}\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
    async pipe() {
      return { code: 1, stdout: '', stderr: '' };
    },
    start() {
      throw new Error('unused');
    },
  };
}

describe('the shared account probe', () => {
  it('names the setting the caller gives where the account name is not one', async () => {
    for (const setting of ['OPENADLC_HOST_CHECK_ACCOUNT', 'OPENADLC_RELEASE_ACCOUNT']) {
      await expect(probeAccount('two words', setting, PLACES, machine('502'), (home) => accountEnv('x', home))).resolves.toMatchObject({
        ok: false,
        problem: 'no_account',
        detail: `two words is not an account name; set ${setting} to the account you made`,
      });
    }
  });

  it('refuses root and hostd’s own user as an account of their own', async () => {
    await expect(probeAccount('builds', 'S', PLACES, machine('0'), (home) => accountEnv('builds', home))).resolves.toMatchObject({ problem: 'not_dedicated' });
    await expect(probeAccount('builds', 'S', PLACES, machine('501'), (home) => accountEnv('builds', home))).resolves.toMatchObject({ problem: 'not_dedicated' });
    await expect(probeAccount('builds', 'S', PLACES, machine(null), (home) => accountEnv('builds', home))).resolves.toMatchObject({ problem: 'no_account' });
  });

  it('runs a command as the account through sudo -n and env -i, with exactly the variables given', () => {
    expect(asAccount('builds', { PATH: '/usr/bin', HOME: '/Users/builds' }, ['/usr/bin/true'])).toEqual([
      'sudo',
      '-n',
      '-u',
      'builds',
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=/usr/bin',
      'HOME=/Users/builds',
      '/usr/bin/true',
    ]);
  });

  it('keeps the host check’s seven variables, in their order, on top of the shared five', () => {
    expect(Object.keys(accountEnv('builds', '/Users/builds'))).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG']);
    expect(Object.keys(hostCheckEnv('builds', '/Users/builds'))).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'CI', 'OPENADLC_HOST_CHECK']);
  });
});
