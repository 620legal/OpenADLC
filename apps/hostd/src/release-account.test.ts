import { describe, expect, it } from 'vitest';
import { ENTERABLE, READABLE, type HostProcesses, type ProcessResult } from './account-probe.js';
import { ReleaseAccount } from './release-account.js';

const RELEASE = 'openadlc-release';
const HOST_CHECK = 'openadlc-hostcheck';
const HOMES: Record<string, string> = { [RELEASE]: '/Users/openadlc-release', [HOST_CHECK]: '/Users/openadlc-hostcheck' };
const RELEASE_HOME = HOMES[RELEASE] as string;
const OPENADLC_HOME = '/Users/jane/.openadlc';
const WORK_ROOT = '/Volumes/work/openadlc';
const HOSTD_HOME = '/Users/jane';
const SOCKET = '/var/run/docker.sock';

const NO: ProcessResult = { code: 1, stdout: '', stderr: '' };
const YES: ProcessResult = { code: 0, stdout: '', stderr: '' };

interface Fit {
  /** Each account's uid; one missing is no such account. */
  uids?: Record<string, number>;
  /** The accounts hostd may run a command as. */
  sudo?: readonly string[];
  /** What each account can read, or enter, or connect to. */
  readable?: Record<string, readonly string[]>;
  enterable?: Record<string, readonly string[]>;
  sockets?: readonly string[];
  groups?: string;
  nopasswd?: string;
}

/** The machine as the probe sees it, each command recorded with the account it ran as. */
function machine(fit: Fit = {}) {
  const uids = fit.uids ?? { [RELEASE]: 503, [HOST_CHECK]: 502 };
  const sudo = fit.sudo ?? [RELEASE, HOST_CHECK];
  const ran: string[][] = [];
  const processes: HostProcesses = {
    async run(argv) {
      ran.push(argv);
      if (argv[0] === 'id' && argv[1] === '-Gn') return { code: 0, stdout: `${fit.groups ?? 'staff'}\n`, stderr: '' };
      if (argv[0] === 'id') {
        const uid = uids[argv[2] ?? ''];
        return uid === undefined ? { code: 1, stdout: '', stderr: 'no such user' } : { code: 0, stdout: `${uid}\n`, stderr: '' };
      }
      if (argv[0] === '/bin/sh' && argv[2]?.includes('eval')) {
        const home = HOMES[argv[4] ?? ''];
        return { code: 0, stdout: `${home ?? `~${argv[4]}`}\n`, stderr: '' };
      }
      if (argv[0] === 'sudo') {
        const as = argv[3] ?? '';
        if (!sudo.includes(as)) return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
        const path = argv.at(-1) ?? '';
        if (argv.includes(READABLE)) return (fit.readable?.[as] ?? []).includes(path) ? YES : NO;
        if (argv.includes(ENTERABLE)) return (fit.enterable?.[as] ?? []).includes(path) ? YES : NO;
        if (argv.includes('[ -S "$1" ] && [ -w "$1" ]')) return (fit.sockets ?? []).includes(path) ? YES : NO;
        if (argv.slice(-3).join(' ') === 'sudo -n -l') return fit.nopasswd === undefined ? NO : { code: 0, stdout: fit.nopasswd, stderr: '' };
        return YES;
      }
      return YES;
    },
    async pipe() {
      return YES;
    },
    start() {
      throw new Error('the probe starts nothing long');
    },
  };
  return { processes, ran };
}

function release(world: ReturnType<typeof machine>, extra: { account?: string; hostCheckAccount?: string | null } = {}) {
  return new ReleaseAccount({
    account: extra.account ?? RELEASE,
    hostCheckAccount: extra.hostCheckAccount === undefined ? HOST_CHECK : extra.hostCheckAccount,
    places: { openadlcHome: OPENADLC_HOME, workRoot: WORK_ROOT, hostdHome: HOSTD_HOME, dockerSockets: [SOCKET], uid: 501 },
    processes: world.processes,
  });
}

describe('the release account, proved by its effect', () => {
  it('passes when it is an account of its own that reaches nothing, and the host check’s account cannot reach its home', async () => {
    const world = machine();
    await expect(release(world).probe()).resolves.toEqual({ ok: true, account: RELEASE, uid: 503, home: RELEASE_HOME });
    // The reach of the host check's account was asked, as that account.
    const asHostCheck = world.ran.filter((argv) => argv[0] === 'sudo' && argv[3] === HOST_CHECK);
    expect(asHostCheck.filter((argv) => argv.includes(READABLE) || argv.includes(ENTERABLE)).map((argv) => argv.at(-1))).toEqual([RELEASE_HOME, RELEASE_HOME]);
  });

  it.each([
    ['OPENADLC_HOME', 'can_read', { readable: { [RELEASE]: [OPENADLC_HOME] } }, OPENADLC_HOME],
    ['install.json', 'can_read', { readable: { [RELEASE]: [`${OPENADLC_HOME}/install.json`] } }, `${OPENADLC_HOME}/install.json`],
    ['the work root', 'can_read', { readable: { [RELEASE]: [WORK_ROOT] } }, WORK_ROOT],
    ['hostd’s home', 'can_read', { readable: { [RELEASE]: [HOSTD_HOME] } }, HOSTD_HOME],
    ['into OPENADLC_HOME', 'can_enter', { enterable: { [RELEASE]: [OPENADLC_HOME] } }, OPENADLC_HOME],
    ['into the work root', 'can_enter', { enterable: { [RELEASE]: [WORK_ROOT] } }, WORK_ROOT],
    ['into hostd’s home', 'can_enter', { enterable: { [RELEASE]: [HOSTD_HOME] } }, HOSTD_HOME],
    ['a Docker socket', 'docker', { sockets: [SOCKET] }, SOCKET],
  ] as const)('refuses an account that reaches %s', async (_name, problem, fit, path) => {
    await expect(release(machine(fit)).probe()).resolves.toMatchObject({ ok: false, account: RELEASE, problem, path });
  });

  it('refuses an account in the docker group', async () => {
    await expect(release(machine({ groups: 'staff docker' })).probe()).resolves.toMatchObject({ ok: false, problem: 'docker', detail: `${RELEASE} is in the docker group` });
  });

  it('refuses an account that can run sudo without a password', async () => {
    await expect(release(machine({ nopasswd: '(root) NOPASSWD: /usr/bin/codesign' })).probe()).resolves.toMatchObject({
      ok: false,
      problem: 'can_sudo',
      detail: expect.stringContaining('NOPASSWD: /usr/bin/codesign'),
    });
  });

  it.each([
    ['root', { uids: { [RELEASE]: 0, [HOST_CHECK]: 502 } }],
    ['hostd’s own user', { uids: { [RELEASE]: 501, [HOST_CHECK]: 502 } }],
  ] as const)('refuses %s', async (_name, fit) => {
    await expect(release(machine(fit)).probe()).resolves.toMatchObject({ ok: false, problem: 'not_dedicated' });
  });

  it('refuses an account that is not on the machine, or that hostd cannot run as, naming the setting where the name is wrong', async () => {
    await expect(release(machine({ uids: { [HOST_CHECK]: 502 } })).probe()).resolves.toMatchObject({ ok: false, problem: 'no_account' });
    await expect(release(machine({ sudo: [HOST_CHECK] })).probe()).resolves.toMatchObject({ ok: false, problem: 'no_sudo' });
    await expect(release(machine(), { account: 'not an account' }).probe()).resolves.toMatchObject({
      ok: false,
      problem: 'no_account',
      detail: expect.stringContaining('OPENADLC_RELEASE_ACCOUNT'),
    });
  });

  describe('apart from the host check’s account', () => {
    it('refuses the host check’s account by name, in any case, before running anything as it', async () => {
      const world = machine();
      await expect(release(world, { account: 'OpenADLC-HostCheck' }).probe()).resolves.toMatchObject({ ok: false, problem: 'host_check_account' });
      expect(world.ran).toEqual([]);
    });

    it('refuses a second name for the host check’s uid', async () => {
      await expect(release(machine({ uids: { [RELEASE]: 502, [HOST_CHECK]: 502 } })).probe()).resolves.toMatchObject({
        ok: false,
        problem: 'host_check_account',
        detail: expect.stringContaining('uid 502'),
      });
    });

    it.each([
      ['read', { readable: { [HOST_CHECK]: [RELEASE_HOME] } }],
      ['enter', { enterable: { [HOST_CHECK]: [RELEASE_HOME] } }],
    ] as const)('refuses a home the host check’s account can %s, as macOS makes one by default', async (verb, fit) => {
      await expect(release(machine(fit)).probe()).resolves.toMatchObject({
        ok: false,
        account: RELEASE,
        problem: 'host_check_reaches',
        path: RELEASE_HOME,
        detail: expect.stringContaining(`can ${verb} ${RELEASE_HOME}`),
      });
    });

    it('skips the reach where there is no host check account, or hostd cannot run as it, since no pull request code runs there', async () => {
      const reachable = { readable: { [HOST_CHECK]: [RELEASE_HOME] } };
      await expect(release(machine(reachable), { hostCheckAccount: null }).probe()).resolves.toMatchObject({ ok: true });
      await expect(release(machine({ ...reachable, uids: { [RELEASE]: 503 } })).probe()).resolves.toMatchObject({ ok: true });
      await expect(release(machine({ ...reachable, sudo: [RELEASE] })).probe()).resolves.toMatchObject({ ok: true });
    });
  });

  it('runs every command as the release account with PATH, HOME, USER, LOGNAME and LANG only', async () => {
    const world = machine();
    await release(world).probe();
    const asRelease = world.ran.filter((argv) => argv[0] === 'sudo' && argv[3] === RELEASE);
    expect(asRelease.length).toBeGreaterThan(0);
    for (const argv of asRelease) {
      const envAt = argv.indexOf('-i');
      expect(argv.slice(0, envAt + 1)).toEqual(['sudo', '-n', '-u', RELEASE, '--', '/usr/bin/env', '-i']);
      const vars = argv.slice(envAt + 1).filter((arg) => /^[A-Z_]+=/.test(arg));
      expect(vars.map((pair) => pair.split('=')[0])).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG']);
      expect(vars).toContain(`HOME=${RELEASE_HOME}`);
      expect(argv.join(' ')).not.toMatch(/OPENADLC_HOST_CHECK|CI=/);
    }
  });
});
