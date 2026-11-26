import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { HostChecks, RECEIVE, dockerSocketsOf, receiveScript, hostCheckRequestFrom, nodeProcesses, type HostCheckRun, type HostProcesses, type ProcessResult } from './host-check.js';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const ACCOUNT = 'openadlc-hostcheck';
const HOME = '/Users/openadlc-hostcheck';
const OPENADLC_HOME = '/Users/jane/.openadlc';
const TOKEN = `ghs_${'t'.repeat(36)}`;

const OK: ProcessResult = { code: 0, stdout: '', stderr: '' };

/**
 * The machine as the tests see it: every command hostd would run is recorded,
 * and the account is as `fit` says. The long command runs until `finish` is
 * called for it, or it is signalled.
 */
function machine(
  fit: { uid?: string; sudo?: boolean; readable?: readonly string[]; enterable?: readonly string[]; sockets?: readonly string[]; groups?: string; nopasswd?: string; ignoresTerm?: boolean } = {},
) {
  /** Starts and signals in the order they happened; a signal goes to the whole account, like `kill -1` as it. */
  const events: string[] = [];
  const ran: { argv: string[]; env?: Record<string, string> }[] = [];
  const piped: { from: { argv: string[]; env?: Record<string, string> }; to: { argv: string[] } }[] = [];
  const started: { argv: string[]; signals: string[]; finish: (code: number) => void; output: (text: string) => void }[] = [];
  const processes: HostProcesses = {
    async run(argv, options = {}) {
      ran.push({ argv, ...(options.env ? { env: options.env } : {}) });
      if (argv[0] === 'id' && argv[1] === '-Gn') return { code: 0, stdout: `${fit.groups ?? 'staff'}\n`, stderr: '' };
      if (argv[0] === 'id') return fit.uid === undefined ? { code: 0, stdout: '502\n', stderr: '' } : fit.uid === '' ? { code: 1, stdout: '', stderr: 'no such user' } : { code: 0, stdout: `${fit.uid}\n`, stderr: '' };
      if (argv[0] === '/bin/sh' && argv[2]?.includes('eval')) return { code: 0, stdout: `${HOME}\n`, stderr: '' };
      if (argv[0] === 'sudo') {
        if (fit.sudo === false) return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
        const kill = argv.indexOf('/bin/kill');
        if (kill >= 0 && argv[kill + 2] === '-1') events.push(`clear ${argv[kill + 1]?.slice(1)}`);
        const path = argv[argv.length - 1] ?? '';
        if (argv.includes('test -r "$1" || ls "$1" >/dev/null 2>&1')) return { code: (fit.readable ?? []).includes(path) ? 0 : 1, stdout: '', stderr: '' };
        if (argv.includes('test -d "$1" && test -x "$1"')) return { code: (fit.enterable ?? []).includes(path) ? 0 : 1, stdout: '', stderr: '' };
        if (argv.includes('[ -S "$1" ] && [ -w "$1" ]')) return { code: (fit.sockets ?? []).includes(path) ? 0 : 1, stdout: '', stderr: '' };
        if (argv.slice(-3).join(' ') === 'sudo -n -l') {
          return fit.nopasswd === undefined ? { code: 1, stdout: '', stderr: 'sudo: a password is required' } : { code: 0, stdout: fit.nopasswd, stderr: '' };
        }
        return OK;
      }
      if (argv[0] === 'git' && argv.includes('rev-parse')) {
        const ref = argv[argv.length - 1] ?? '';
        return { code: 0, stdout: `${lastFetched.get(ref.replace('^{commit}', '')) ?? ''}\n`, stderr: '' };
      }
      if (argv[0] === 'git' && argv.includes('fetch')) {
        const spec = argv[argv.length - 1] ?? '';
        const [sha, ref] = spec.replace(/^\+/, '').split(':');
        if (ref && sha) lastFetched.set(ref, sha);
        return OK;
      }
      return OK;
    },
    async pipe(from, to) {
      piped.push({ from, to });
      return OK;
    },
    start(argv, onOutput) {
      let finish: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        finish = resolve;
      });
      const entry = { argv, signals: [] as string[], finish, output: onOutput };
      started.push(entry);
      events.push(`start ${started.length}`);
      return {
        exited,
        async signalAll(signal) {
          entry.signals.push(signal);
          events.push(`${signal} from ${started.indexOf(entry) + 1}`);
          if (signal === 'TERM' && !fit.ignoresTerm) finish(143);
          if (signal === 'KILL') finish(137);
        },
      };
    },
  };
  const lastFetched = new Map<string, string>();
  return { processes, ran, piped, started, events };
}

function checks(world: ReturnType<typeof machine>, extra: Partial<ConstructorParameters<typeof HostChecks>[0]> = {}) {
  const reports: HostCheckRun[] = [];
  const work = mkdtempSync(join(tmpdir(), 'openadlc-host-check-'));
  dirs.push(work);
  const hostChecks = new HostChecks({
    account: ACCOUNT,
    installId: 'default',
    openadlcHome: OPENADLC_HOME,
    hostdHome: '/Users/jane',
    // Inside OPENADLC_HOME, so it adds no folder to the probe unless a test moves it.
    workRoot: OPENADLC_HOME,
    dockerSockets: [],
    mirrorRoot: join(work, 'mirrors'),
    remote: (repo) => `https://github.com/${repo}.git`,
    fetchAuth: async () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${TOKEN}` }),
    report: async (run) => void reports.push(run),
    processes: world.processes,
    uid: 501,
    killAfterMs: 0,
    ...extra,
  });
  return { hostChecks, reports };
}

const dirs: string[] = [];
const saved = { ...process.env };

beforeEach(() => {
  // What hostd's own process holds, none of which may reach the command.
  process.env.OPENADLC_TASK_TOKEN = 'task-token-of-some-task';
  process.env.GH_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://openadlc:secret@127.0.0.1/openadlc';
  process.env.OPENADLC_INTERNAL_SECRET = 'install-secret';
});

afterEach(() => {
  process.env = { ...saved };
  // GitHub's runner image 20261122 (git 2.56) failed this cleanup with
  // ENOTEMPTY on a submodule fixture's .git and .git/objects/pack: a git the
  // test started (background maintenance, most likely) was still writing
  // there as the folder was removed. Retrying waits for that writer to finish
  // rather than failing a test whose assertions had already passed. The
  // receive script no longer starts that maintenance (#411); the retry stays
  // for a git the tests' own fixtures run, and for the #411 test without its fix.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const START = { runId: 'run-1', repo: 'acme/mac-app', pr: 7, head: HEAD, command: 'make host-ci', timeoutMinutes: 90, bot: 'atlas' };

/** Waits until hostd has started the long command `count` times. */
async function untilStarted(world: ReturnType<typeof machine>, count: number): Promise<void> {
  await vi.waitFor(() => expect(world.started.length).toBeGreaterThanOrEqual(count));
}

describe('the command a host check runs', () => {
  it('runs as the account with a cleared environment, and only the allowlisted variables', async () => {
    const world = machine();
    const { hostChecks, reports } = checks(world);
    hostChecks.start(START);
    await untilStarted(world, 1);

    const argv = world.started[0]?.argv ?? [];
    expect(argv.slice(0, 7)).toEqual(['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/env', '-i']);
    const assignments = argv.slice(7).filter((part) => /^[A-Z_]+=/.test(part));
    // A fixed list, not `hostCheckEnv` itself: a name added there from
    // hostd's environment, as `SSH_AUTH_SOCK`, has to fail here.
    expect(assignments.map((part) => part.split('=')[0])).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'CI', 'OPENADLC_HOST_CHECK']);
    expect(Object.fromEntries(assignments.map((part) => part.split(/=(.*)/s).slice(0, 2)))).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
      HOME,
      USER: ACCOUNT,
      LOGNAME: ACCOUNT,
      LANG: 'en_US.UTF-8',
      CI: '1',
      OPENADLC_HOST_CHECK: '1',
    });
    expect(argv[argv.length - 1]).toBe('make host-ci');
    expect(argv).toContain(join(HOME, 'openadlc', 'default', 'acme__mac-app'));
    for (const secret of [TOKEN, 'task-token-of-some-task', 'install-secret', 'postgres://']) expect(argv.join(' ')).not.toContain(secret);

    world.started[0]?.output('built\n');
    world.started[0]?.finish(0);
    await hostChecks.settled();
    expect(reports.at(-1)).toMatchObject({ runId: 'run-1', state: 'passed', exitCode: 0, logTail: 'built\n' });
  });

  it('hands the code over as a bundle, whose steps hold no token; only hostd’s own fetch into its mirror does', async () => {
    const world = machine();
    const { hostChecks } = checks(world);
    hostChecks.start(START);
    await untilStarted(world, 1);

    const bundle = world.piped[0];
    expect(bundle?.from.argv.slice(0, 5)).toEqual(['git', '-C', expect.stringContaining('acme__mac-app.git'), 'bundle', 'create']);
    expect(bundle?.to.argv.slice(0, 7)).toEqual(['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/env', '-i']);
    expect(JSON.stringify(bundle)).not.toContain(TOKEN);
    const fetches = world.ran.filter((call) => call.argv.includes('fetch'));
    expect(fetches.length).toBeGreaterThan(0);
    for (const call of world.ran.filter((one) => one.argv[0] === 'sudo')) expect(JSON.stringify(call)).not.toContain(TOKEN);
  });

  it('sends only what the folder lacks the next time, from the head it was last given', async () => {
    const world = machine();
    const { hostChecks } = checks(world);
    hostChecks.start(START);
    await untilStarted(world, 1);
    world.started[0]?.finish(0);
    await hostChecks.settled();
    hostChecks.start({ ...START, runId: 'run-2', head: NEXT });
    await untilStarted(world, 2);
    expect(world.piped[1]?.from.argv.at(-1)).toBe(`^${HEAD}`);
  });

  it('takes the command and limit it was given, which the bridge read from the repository’s settings', () => {
    expect(hostCheckRequestFrom({ ...START })).toEqual(START);
    expect(hostCheckRequestFrom({ ...START, command: 'make host-ci\nrm -rf ~' })).toMatch(/one line/);
    expect(hostCheckRequestFrom({ ...START, timeoutMinutes: 2000 })).toMatch(/1 to 1440/);
    expect(hostCheckRequestFrom({ ...START, head: 'main' })).toMatch(/full commit/);
  });
});

describe('one host check at a time', () => {
  it('runs two pull requests’ checks one after the other, never at once', async () => {
    const world = machine();
    const { hostChecks } = checks(world);
    hostChecks.start(START);
    hostChecks.start({ ...START, runId: 'run-2', pr: 8, head: NEXT });
    await untilStarted(world, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.started).toHaveLength(1);
    expect(hostChecks.get('run-2')?.state).toBe('queued');
    world.started[0]?.finish(0);
    await untilStarted(world, 2);
    expect(world.started[1]?.argv.at(-1)).toBe('make host-ci');
  });

  it('stops the going run of a pull request when a newer head of it starts, and runs the newer one', async () => {
    const world = machine();
    const { hostChecks, reports } = checks(world);
    hostChecks.start(START);
    await untilStarted(world, 1);
    hostChecks.start({ ...START, runId: 'run-2', head: NEXT });
    await untilStarted(world, 2);
    expect(world.started[0]?.signals).toEqual(['TERM', 'KILL']);
    expect(reports.find((run) => run.runId === 'run-1')).toMatchObject({ state: 'cancelled', reason: expect.stringContaining(NEXT.slice(0, 7)) });
    expect(hostChecks.get('run-2')?.state).toBe('running');
  });

  it('sends the stopped run’s KILL before the next run starts, so it never reaches the next build', async () => {
    const world = machine();
    const { hostChecks, reports } = checks(world, { killAfterMs: 60_000 });
    hostChecks.start(START);
    await untilStarted(world, 1);
    hostChecks.start({ ...START, runId: 'run-2', head: NEXT });
    await untilStarted(world, 2);
    // The build obeyed TERM, so its KILL went at once rather than a minute later, into run-2.
    expect(world.events).toEqual(['clear TERM', 'clear KILL', 'start 1', 'TERM from 1', 'KILL from 1', 'clear TERM', 'clear KILL', 'start 2']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.started[1]?.signals).toEqual([]);
    expect(world.events.at(-1)).toBe('start 2');
    world.started[1]?.finish(0);
    await hostChecks.settled();
    expect(reports.find((run) => run.runId === 'run-2')).toMatchObject({ state: 'passed' });
  });

  it('waits for the KILL of a build that ignores TERM before the next run starts', async () => {
    const world = machine({ ignoresTerm: true });
    const { hostChecks, reports } = checks(world, { killAfterMs: 50 });
    hostChecks.start(START);
    await untilStarted(world, 1);
    hostChecks.start({ ...START, runId: 'run-2', head: NEXT });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(world.started).toHaveLength(1);
    await untilStarted(world, 2);
    expect(world.events).toEqual(['clear TERM', 'clear KILL', 'start 1', 'TERM from 1', 'KILL from 1', 'clear TERM', 'clear KILL', 'start 2']);
    expect(reports.find((run) => run.runId === 'run-1')).toMatchObject({ state: 'cancelled', exitCode: 137 });
  });

  it('clears everything the account runs when a run passes, not only when it is stopped', async () => {
    const world = machine();
    const { hostChecks, reports } = checks(world, { killAfterMs: 60_000 });
    hostChecks.start(START);
    await untilStarted(world, 1);
    // The build exits 0, leaving a `nohup … &` behind it, as the account.
    world.started[0]?.finish(0);
    await hostChecks.settled();
    expect(world.started[0]?.signals).toEqual(['TERM', 'KILL']);
    expect(world.events).toEqual(['clear TERM', 'clear KILL', 'start 1', 'TERM from 1', 'KILL from 1']);
    expect(reports.at(-1)).toMatchObject({ state: 'passed', exitCode: 0 });
  });

  it('clears the account before each run starts, before the head reaches its folder', async () => {
    const world = machine();
    const { hostChecks } = checks(world);
    hostChecks.start(START);
    await untilStarted(world, 1);
    const clears = world.ran.findIndex((call) => call.argv.includes('/bin/kill'));
    expect(world.ran[clears]?.argv.slice(0, 7)).toEqual(['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/env', '-i']);
    expect(world.ran[clears]?.argv.slice(-3)).toEqual(['/bin/kill', '-TERM', '-1']);
    expect(world.ran[clears + 1]?.argv.slice(-3)).toEqual(['/bin/kill', '-KILL', '-1']);
    expect(world.piped).toHaveLength(1);
    expect(world.events.slice(0, 3)).toEqual(['clear TERM', 'clear KILL', 'start 1']);
  });

  it('clears the account when a run ends before its command starts, since the git steps ran as it', async () => {
    const world = machine();
    world.processes.pipe = async (from, to) => {
      world.piped.push({ from, to });
      return { code: 1, stdout: '', stderr: 'fatal: bad bundle' };
    };
    const { hostChecks, reports } = checks(world);
    hostChecks.start(START);
    await hostChecks.settled();
    expect(world.started).toHaveLength(0);
    expect(reports.at(-1)).toMatchObject({ state: 'refused' });
    expect(world.events).toEqual(['clear TERM', 'clear KILL', 'clear TERM', 'clear KILL']);
  });

  it('replaces a queued run of the same pull request rather than run an old head', async () => {
    const world = machine();
    const { hostChecks, reports } = checks(world);
    hostChecks.start({ ...START, pr: 99, runId: 'run-0' });
    hostChecks.start(START);
    hostChecks.start({ ...START, runId: 'run-2', head: NEXT });
    expect(reports.find((run) => run.runId === 'run-1')).toMatchObject({ state: 'cancelled' });
    expect(hostChecks.get('run-2')?.state).toBe('queued');
  });

  it('is stopped as failed at its time limit, TERM then KILL', async () => {
    const world = machine();
    const { hostChecks, reports } = checks(world, { msPerMinute: 30 });
    hostChecks.start({ ...START, timeoutMinutes: 1 });
    await untilStarted(world, 1);
    await hostChecks.settled();
    expect(world.started[0]?.signals).toEqual(['TERM', 'KILL']);
    expect(reports.at(-1)).toMatchObject({ state: 'failed', reason: expect.stringContaining('did not finish within 1 minute') });
  });

  it('is cancelled for a pull request that closed, and says it had one', async () => {
    const world = machine();
    const { hostChecks, reports } = checks(world);
    hostChecks.start(START);
    await untilStarted(world, 1);
    expect(hostChecks.cancel('ACME/mac-app', 7)).toBe(true);
    await hostChecks.settled();
    expect(reports.at(-1)).toMatchObject({ state: 'cancelled' });
    expect(hostChecks.cancel('acme/mac-app', 7)).toBe(false);
  });
});

describe('the account, proved before every run', () => {
  it('passes when the account exists, hostd may run as it, and it reads none of hostd’s files', async () => {
    const { hostChecks } = checks(machine());
    await expect(hostChecks.probe()).resolves.toEqual({ ok: true, account: ACCOUNT, uid: 502, home: HOME });
  });

  it.each([
    ['no account', { uid: '' }, 'no_account'],
    ['root', { uid: '0' }, 'not_dedicated'],
    ['hostd’s own user', { uid: '501' }, 'not_dedicated'],
    ['no sudo rule', { sudo: false }, 'no_sudo'],
  ] as const)('fails for %s', async (_name, fit, problem) => {
    const { hostChecks } = checks(machine(fit));
    await expect(hostChecks.probe()).resolves.toMatchObject({ ok: false, problem });
  });

  it.each([OPENADLC_HOME, `${OPENADLC_HOME}/install.json`, '/Users/jane'])('fails while the account can read %s', async (path) => {
    const { hostChecks } = checks(machine({ readable: [path] }));
    await expect(hostChecks.probe()).resolves.toMatchObject({ ok: false, problem: 'can_read', path });
  });

  describe('reaches nothing the install guards (#335)', () => {
    const WORK_ROOT = '/Volumes/work/openadlc';

    it('fails while it can enter a folder it cannot list, as a home at 0711', async () => {
      const { hostChecks } = checks(machine({ enterable: ['/Users/jane'] }));
      await expect(hostChecks.probe()).resolves.toMatchObject({ ok: false, problem: 'can_enter', path: '/Users/jane', detail: expect.stringContaining('can enter /Users/jane') });
    });

    it('fails while it can enter OPENADLC_HOME', async () => {
      const { hostChecks } = checks(machine({ enterable: [OPENADLC_HOME] }));
      await expect(hostChecks.probe()).resolves.toMatchObject({ ok: false, problem: 'can_enter', path: OPENADLC_HOME });
    });

    it('fails while it can enter or read a work root set outside OPENADLC_HOME', async () => {
      const entered = checks(machine({ enterable: [WORK_ROOT] }), { workRoot: WORK_ROOT }).hostChecks;
      await expect(entered.probe()).resolves.toMatchObject({ ok: false, problem: 'can_enter', path: WORK_ROOT });
      const read = checks(machine({ readable: [WORK_ROOT] }), { workRoot: WORK_ROOT }).hostChecks;
      await expect(read.probe()).resolves.toMatchObject({ ok: false, problem: 'can_read', path: WORK_ROOT });
    });

    it('fails while it can connect to a Docker socket', async () => {
      const { hostChecks } = checks(machine({ sockets: ['/var/run/docker.sock'] }), { dockerSockets: ['/var/run/docker.sock', '/run/docker.sock'] });
      await expect(hostChecks.probe()).resolves.toMatchObject({ ok: false, problem: 'docker', path: '/var/run/docker.sock', detail: expect.stringContaining('controls Docker as root') });
    });

    it('fails while it is in the docker group, asked as hostd', async () => {
      const world = machine({ groups: 'staff docker' });
      const { hostChecks } = checks(world);
      const probe = await hostChecks.probe();
      expect(probe).toMatchObject({ ok: false, problem: 'docker', detail: `${ACCOUNT} is in the docker group` });
      expect(probe).not.toHaveProperty('path');
      expect(world.ran.find((call) => call.argv[1] === '-Gn')?.argv).toEqual(['id', '-Gn', ACCOUNT]);
    });

    it('fails while it can run sudo without a password, one command’s NOPASSWD rule included, and quotes the rule', async () => {
      const { hostChecks } = checks(machine({ nopasswd: 'User openadlc-hostcheck may run the following commands:\n    (root) NOPASSWD: /usr/bin/xcodebuild\n' }));
      await expect(hostChecks.probe()).resolves.toMatchObject({ ok: false, problem: 'can_sudo', detail: expect.stringContaining('NOPASSWD: /usr/bin/xcodebuild') });
    });

    it('asks each one as the account, of every folder and socket it is given', async () => {
      const world = machine();
      const { hostChecks } = checks(world, { workRoot: WORK_ROOT, dockerSockets: ['/var/run/docker.sock'] });
      await expect(hostChecks.probe()).resolves.toMatchObject({ ok: true });
      const asked = (script: string) => world.ran.filter((call) => call.argv.includes(script)).map((call) => [call.argv.slice(0, 4), call.argv.at(-1)]);
      const as = ['sudo', '-n', '-u', ACCOUNT];
      expect(asked('test -d "$1" && test -x "$1"')).toEqual([OPENADLC_HOME, WORK_ROOT, '/Users/jane'].map((path) => [as, path]));
      expect(asked('[ -S "$1" ] && [ -w "$1" ]')).toEqual([[as, '/var/run/docker.sock']]);
      expect(world.ran.filter((call) => call.argv.slice(-3).join(' ') === 'sudo -n -l').map((call) => call.argv.slice(0, 4))).toEqual([as]);
    });

    it.each([
      ['entering hostd’s home', { enterable: ['/Users/jane'] }],
      ['the Docker socket', { sockets: ['/var/run/docker.sock'] }],
      ['the docker group', { groups: 'docker' }],
      ['passwordless sudo', { nopasswd: '(ALL) NOPASSWD: ALL' }],
    ] as const)('refuses the run, and never runs the command, for %s', async (_name, fit) => {
      const world = machine(fit);
      const { hostChecks, reports } = checks(world, { dockerSockets: ['/var/run/docker.sock'] });
      hostChecks.start(START);
      await hostChecks.settled();
      expect(world.started).toHaveLength(0);
      expect(world.piped).toHaveLength(0);
      expect(reports.at(-1)).toMatchObject({ state: 'refused' });
    });

    it('lists the Docker sockets the account must not reach', () => {
      expect(dockerSocketsOf({ DOCKER_HOST: 'unix:///x.sock', XDG_RUNTIME_DIR: '/run/user/501' }, '/Users/jane')).toEqual([
        '/x.sock',
        '/var/run/docker.sock',
        '/run/docker.sock',
        '/Users/jane/.docker/run/docker.sock',
        '/Users/jane/.orbstack/run/docker.sock',
        '/run/user/501/docker.sock',
      ]);
      expect(dockerSocketsOf({ DOCKER_HOST: 'tcp://127.0.0.1:2375' }, '/Users/jane')).toEqual([
        '/var/run/docker.sock',
        '/run/docker.sock',
        '/Users/jane/.docker/run/docker.sock',
        '/Users/jane/.orbstack/run/docker.sock',
      ]);
      expect(dockerSocketsOf({ DOCKER_HOST: 'unix:///var/run/docker.sock' }, '/Users/jane')).toHaveLength(4);
    });
  });

  it('refuses the run, with the fix, and never runs the command, when the probe fails', async () => {
    const world = machine({ readable: [OPENADLC_HOME] });
    const { hostChecks, reports } = checks(world);
    hostChecks.start(START);
    await hostChecks.settled();
    expect(world.started).toHaveLength(0);
    expect(reports.at(-1)).toMatchObject({ state: 'refused', reason: expect.stringContaining('docs/self-hosting.md#host-checks') });
  });
});

describe('the git steps the account runs', () => {
  const clean = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: clean, encoding: 'utf8' }).trim();

  /**
   * A pull request's repository, the account's home with its kept working
   * folder, and a planted program that leaves a mark in `marks` when it runs.
   */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'openadlc-host-check-receive-'));
    dirs.push(root);
    const marks = join(root, 'marks');
    mkdirSync(marks);
    const source = join(root, 'source');
    mkdirSync(source);
    git(source, 'init', '--quiet', '.');
    const planted = join(root, 'planted.sh');
    writeFileSync(planted, `#!/bin/sh\ntouch "${marks}/$(basename "$0")-ran"\ncat\n`);
    chmodSync(planted, 0o755);
    const home = join(root, 'home');
    mkdirSync(home);
    const folder = join(home, 'openadlc', 'default', 'acme__mac-app');
    mkdirSync(folder, { recursive: true });
    let bundles = 0;
    return {
      root,
      marks,
      planted,
      home,
      folder,
      source,
      /**
       * The repository's own command, as its Makefile would run it in the
       * folder: git as the account, which reads the folder's git dirs.
       */
      update() {
        return spawnSync('/bin/sh', ['-c', 'git -c protocol.file.allow=always submodule update --init --recursive'], {
          cwd: folder,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8' },
          encoding: 'utf8',
        });
      },
      filterConfig: `[filter "planted"]\n\tsmudge = ${planted}\n\tclean = ${planted}\n`,
      /** A commit on the pull request's ref with these files; its sha. */
      commit(files: Record<string, string>): string {
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(join(source, path, '..'), { recursive: true });
          writeFileSync(join(source, path), content);
        }
        git(source, 'add', '.');
        git(source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'head');
        const head = git(source, 'rev-parse', 'HEAD');
        git(source, 'update-ref', 'refs/openadlc/host-check/7', head);
        return head;
      },
      /** The bundle hostd sends: all of it, or only what a folder given `since` lacks. */
      bundle(since?: string): Buffer {
        bundles += 1;
        const path = join(root, `head-${bundles}.bundle`);
        git(source, 'bundle', 'create', path, 'refs/openadlc/host-check/7', ...(since ? [`^${since}`] : []));
        return readFileSync(path);
      },
      /** RECEIVE as hostd runs it, with only the command's environment. */
      receive(head: string, bundle: Buffer, env: Record<string, string> = {}) {
        return spawnSync('/bin/sh', ['-c', RECEIVE, 'sh', folder, head], {
          input: bundle,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', ...env },
          encoding: 'utf8',
        });
      },
      ran: () => readdirSync(marks),
    };
  }

  it('runs no hook, fsmonitor or global config an earlier run left, and checks the head out', () => {
    const f = fixture();
    // The pull request's head, whose .gitattributes names a filter only config defines.
    const head = f.commit({ Makefile: 'host-ci:\n\ttrue\n', '.gitattributes': '* filter=planted\n' });

    // What an earlier run, as the account, could have left: a planted program,
    // named by the account's ~/.gitconfig and by the folder's own config and hooks.
    const hooks = join(f.root, 'hooks');
    mkdirSync(hooks);
    for (const hook of ['post-checkout', 'reference-transaction']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch "${f.marks}/${hook}"\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    writeFileSync(join(f.home, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n${f.filterConfig}`);
    git(f.folder, 'init', '--quiet', '.');
    git(f.folder, 'config', 'core.hooksPath', hooks);
    git(f.folder, 'config', 'core.fsmonitor', f.planted);
    for (const hook of ['post-checkout', 'reference-transaction']) {
      writeFileSync(join(f.folder, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${f.marks}/local-${hook}"\n`);
      chmodSync(join(f.folder, '.git', 'hooks', hook), 0o755);
    }

    const received = f.receive(head, f.bundle());
    expect(received.stderr).toBe('');
    expect(received.status).toBe(0);
    expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(f.folder, 'Makefile'), 'utf8')).toBe('host-ci:\n\ttrue\n');
    expect(existsSync(join(f.folder, '.git', 'openadlc-incoming.bundle'))).toBe(false);
    expect(f.ran()).toEqual([]);
  });

  it("runs no filter the folder's own config and info/attributes define, and keeps only git's objects, refs and index", () => {
    const f = fixture();
    const head = f.commit({ Makefile: 'host-ci:\n\ttrue\n' });
    git(f.folder, 'init', '--quiet', '.');
    const gitDir = join(f.folder, '.git');
    writeFileSync(join(gitDir, 'config'), `${readFileSync(join(gitDir, 'config'), 'utf8')}${f.filterConfig}`);
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(join(gitDir, 'info', 'attributes'), '* filter=planted\n');
    // And what git reads through the layout when config points at it.
    writeFileSync(join(gitDir, 'config.worktree'), f.filterConfig);
    mkdirSync(join(gitDir, 'worktrees', 'other'), { recursive: true });
    mkdirSync(join(gitDir, 'modules', 'sub'), { recursive: true });
    mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true });
    mkdirSync(join(f.root, 'elsewhere'));
    writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), `${join(f.root, 'elsewhere')}\n`);

    const received = f.receive(head, f.bundle());
    expect(received.stderr).toBe('');
    expect(received.status).toBe(0);
    expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(head);
    expect(f.ran()).toEqual([]);
    expect(lstatSync(gitDir).isDirectory()).toBe(true);
    const kept = /^(objects|refs|packed-refs|HEAD|index|sharedindex\..+|shallow|modules|config|description|info)$/;
    expect(readdirSync(gitDir).filter((name) => !kept.test(name))).toEqual([]);
    expect(readFileSync(join(gitDir, 'config'), 'utf8')).not.toContain('planted');
    expect(existsSync(join(gitDir, 'info', 'attributes'))).toBe(false);
    expect(existsSync(join(gitDir, 'hooks'))).toBe(false);
    expect(existsSync(join(gitDir, 'objects', 'info', 'alternates'))).toBe(false);
  });

  it.each(['a gitfile', 'a symlink'])('starts a new repository when .git is %s pointing elsewhere, and leaves that one alone', (kind) => {
    const f = fixture();
    const head = f.commit({ Makefile: 'host-ci:\n\ttrue\n' });
    const other = join(f.root, 'other');
    mkdirSync(other);
    git(other, 'init', '--quiet', '.');
    const otherGit = join(other, '.git');
    writeFileSync(join(otherGit, 'config'), `${readFileSync(join(otherGit, 'config'), 'utf8')}${f.filterConfig}`);
    mkdirSync(join(otherGit, 'info'), { recursive: true });
    writeFileSync(join(otherGit, 'info', 'attributes'), '* filter=planted\n');
    const otherConfig = readFileSync(join(otherGit, 'config'), 'utf8');
    if (kind === 'a gitfile') writeFileSync(join(f.folder, '.git'), `gitdir: ${otherGit}\n`);
    else symlinkSync(otherGit, join(f.folder, '.git'));

    const received = f.receive(head, f.bundle());
    expect(received.stderr).toBe('');
    expect(received.status).toBe(0);
    expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(head);
    expect(f.ran()).toEqual([]);
    expect(lstatSync(join(f.folder, '.git')).isDirectory()).toBe(true);
    expect(readFileSync(join(otherGit, 'config'), 'utf8')).toBe(otherConfig);
    expect(existsSync(join(otherGit, 'refs', 'openadlc'))).toBe(false);
  });

  it('reads no config through .git/commondir', () => {
    const f = fixture();
    const head = f.commit({ Makefile: 'host-ci:\n\ttrue\n' });
    const common = join(f.root, 'common');
    mkdirSync(common);
    git(common, 'init', '--quiet', '--bare', '.');
    writeFileSync(join(common, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${f.filterConfig}`);
    mkdirSync(join(common, 'info'), { recursive: true });
    writeFileSync(join(common, 'info', 'attributes'), '* filter=planted\n');
    git(f.folder, 'init', '--quiet', '.');
    writeFileSync(join(f.folder, '.git', 'commondir'), `${common}\n`);

    const received = f.receive(head, f.bundle());
    expect(received.stderr).toBe('');
    expect(received.status).toBe(0);
    expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(head);
    expect(f.ran()).toEqual([]);
    expect(existsSync(join(f.folder, '.git', 'commondir'))).toBe(false);
  });

  it("keeps the build's untracked and ignored files, and the files the new head does not change, across a thin bundle", () => {
    const f = fixture();
    const first = f.commit({ Makefile: 'host-ci:\n\ttrue\n', '.gitignore': '*.log\n', 'src/a.c': 'int a;\n', 'src/b.c': 'int b;\n' });
    const firstReceived = f.receive(first, f.bundle());
    expect(firstReceived.stderr).toBe('');
    expect(firstReceived.status).toBe(0);
    mkdirSync(join(f.folder, 'build'));
    writeFileSync(join(f.folder, 'build', 'out.o'), 'object\n');
    writeFileSync(join(f.folder, 'build.log'), 'log\n');
    const unchanged = statSync(join(f.folder, 'src', 'a.c'), { bigint: true });

    // Only what the folder lacks, as hostd sends it after a head it gave: it
    // fetches only while the kept objects still hold the first head.
    const second = f.commit({ 'src/b.c': 'int b = 1;\n' });
    const received = f.receive(second, f.bundle(first));
    expect(received.stderr).toBe('');
    expect(received.status).toBe(0);
    expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(second);
    expect(readFileSync(join(f.folder, 'src', 'b.c'), 'utf8')).toBe('int b = 1;\n');
    expect(readFileSync(join(f.folder, 'build', 'out.o'), 'utf8')).toBe('object\n');
    expect(readFileSync(join(f.folder, 'build.log'), 'utf8')).toBe('log\n');
    const after = statSync(join(f.folder, 'src', 'a.c'), { bigint: true });
    expect(after.ino).toBe(unchanged.ino);
    expect(after.mtimeNs).toBe(unchanged.mtimeNs);
  });

  it('starts no git maintenance or gc that outlives the run (#411)', () => {
    const f = fixture();
    const first = f.commit({ Makefile: 'host-ci:\n\ttrue\n' });
    const firstReceived = f.receive(first, f.bundle());
    expect(firstReceived.stderr).toBe('');
    expect(firstReceived.status).toBe(0);

    // The kept objects after about 50 runs, each of which added a pack: past
    // gc.autoPackLimit (50), so a fetch with auto maintenance on starts it.
    const packs = join(f.folder, '.git', 'objects', 'pack');
    for (let n = 0; n < 51; n += 1) {
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.folder, env: clean, input: `planted ${n}\n`, encoding: 'utf8' }).trim();
      execFileSync('git', ['pack-objects', '--quiet', '.git/objects/pack/pack'], { cwd: f.folder, env: clean, input: `${oid}\n` });
    }
    const planted = readdirSync(packs).filter((name) => name.endsWith('.pack'));
    expect(planted.length).toBeGreaterThanOrEqual(52);

    // One trace2 file per git process: git writes the parent's child_start
    // before it spawns a detached child, so this fails without timing.
    const trace = join(f.root, 'trace');
    mkdirSync(trace);
    const second = f.commit({ 'src/a.c': 'int a;\n' });
    const received = f.receive(second, f.bundle(first), { GIT_TRACE2_EVENT: trace });
    expect(received.stderr).toBe('');
    expect(received.status).toBe(0);
    expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(second);

    const events = readdirSync(trace).flatMap((file) =>
      readFileSync(join(trace, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; sid: string; argv?: string[] }),
    );
    expect(events.some((event) => event.event === 'start')).toBe(true);
    const background = events.filter((event) => event.event === 'child_start' && (event.argv ?? []).some((arg) => arg === 'maintenance' || arg === 'gc'));
    expect(background.map((event) => event.argv)).toEqual([]);
    const started = new Set(events.filter((event) => event.event === 'start').map((event) => event.sid));
    const ended = new Set(events.filter((event) => event.event === 'exit' || event.event === 'atexit').map((event) => event.sid));
    expect([...started].filter((sid) => !ended.has(sid))).toEqual([]);

    const gitDir = join(f.folder, '.git');
    for (const left of ['gc.pid', 'gc.log', join('objects', 'maintenance.lock')]) expect(existsSync(join(gitDir, left))).toBe(false);
    const kept = /^(objects|refs|packed-refs|HEAD|index|sharedindex\..+|shallow|modules|config|description|info)$/;
    expect(readdirSync(gitDir).filter((name) => !kept.test(name))).toEqual([]);
    const after = readdirSync(packs).filter((name) => name.endsWith('.pack'));
    for (const pack of planted) expect(after).toContain(pack);
  });

  describe("a submodule's git dir (#365)", () => {
    /** What a module's git dir may hold once RECEIVE ends: `MODULE_KEEPS` and the config it wrote. */
    const moduleKept = /^(objects|refs|packed-refs|HEAD|index|sharedindex\..+|shallow|modules|config)$/;

    const commitIn = (dir: string, files: Record<string, string>): string => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      git(dir, 'add', '-A');
      git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'commit');
      return git(dir, 'rev-parse', 'HEAD');
    };

    /** A repository of its own, beside the pull request's, with these files. */
    const repository = (f: ReturnType<typeof fixture>, name: string, files: Record<string, string>): string => {
      const dir = join(f.root, name);
      mkdirSync(dir);
      git(dir, 'init', '--quiet', '.');
      commitIn(dir, files);
      return dir;
    };

    /** Adds `url` as a submodule at `path` of `dir`, which then has to be committed. */
    const addSubmodule = (dir: string, url: string, path: string) => git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', url, path);

    /** Moves the submodule at `path` of `dir` to its remote's newest commit; the gitlink then has to be committed. */
    const movePin = (dir: string, path: string) => {
      git(join(dir, path), 'fetch', '--quiet', 'origin');
      git(join(dir, path), 'checkout', '--quiet', 'FETCH_HEAD');
    };

    /** A head with a submodule `sub`, received and updated once, as a first build leaves it. */
    function built() {
      const f = fixture();
      const sub = repository(f, 'subsrc', { 'a.c': 'int a;\n', 'b.c': 'int b;\n' });
      addSubmodule(f.source, sub, 'sub');
      const first = f.commit({ Makefile: 'host-ci:\n\ttrue\n' });
      const received = f.receive(first, f.bundle());
      expect(received.stderr).toBe('');
      expect(received.status).toBe(0);
      const updated = f.update();
      expect(updated.status, updated.stderr).toBe(0);
      expect(readFileSync(join(f.folder, 'sub', 'b.c'), 'utf8')).toBe('int b;\n');
      /** A second head whose `sub` is pinned at a newer commit, which changes `b.c` only. */
      const next = () => {
        commitIn(sub, { 'b.c': 'int b = 1;\n' });
        movePin(f.source, 'sub');
        return f.commit({});
      };
      return { f, sub, first, next, gitDir: join(f.folder, '.git', 'modules', 'sub') };
    }

    it("keeps it across a second receive, so the repository's update succeeds and files it does not change keep their mtimes", () => {
      const { f, sub, first, next, gitDir } = built();
      const unchanged = statSync(join(f.folder, 'sub', 'a.c'), { bigint: true });
      const top = statSync(join(f.folder, 'Makefile'), { bigint: true });

      const second = next();
      const received = f.receive(second, f.bundle(first));
      expect(received.stderr).toBe('');
      expect(received.status).toBe(0);
      expect(readdirSync(gitDir).filter((name) => !moduleKept.test(name))).toEqual([]);
      expect(readFileSync(join(f.folder, 'sub', '.git'), 'utf8')).toBe('gitdir: ../.git/modules/sub\n');
      expect(git(f.root, 'config', '--file', join(gitDir, 'config'), '--get', 'remote.origin.url')).toBe(sub);
      expect(existsSync(join(f.folder, '.git', 'openadlc-modules'))).toBe(false);

      const updated = f.update();
      expect(updated.status, updated.stderr).toBe(0);
      expect(readFileSync(join(f.folder, 'sub', 'b.c'), 'utf8')).toBe('int b = 1;\n');
      const after = statSync(join(f.folder, 'sub', 'a.c'), { bigint: true });
      expect(after.ino).toBe(unchanged.ino);
      expect(after.mtimeNs).toBe(unchanged.mtimeNs);
      expect(statSync(join(f.folder, 'Makefile'), { bigint: true }).mtimeNs).toBe(top.mtimeNs);
      expect(f.ran()).toEqual([]);
    });

    it('runs no filter, hook, fsmonitor, config.worktree, commondir or alternates an earlier run left in it', () => {
      const { f, first, next, gitDir } = built();
      const hooks = join(f.root, 'hooks');
      mkdirSync(hooks);
      for (const hook of ['post-checkout', 'reference-transaction']) {
        writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch "${f.marks}/${hook}"\n`);
        chmodSync(join(hooks, hook), 0o755);
        mkdirSync(join(gitDir, 'hooks'), { recursive: true });
        writeFileSync(join(gitDir, 'hooks', hook), `#!/bin/sh\ntouch "${f.marks}/local-${hook}"\n`);
        chmodSync(join(gitDir, 'hooks', hook), 0o755);
      }
      writeFileSync(
        join(gitDir, 'config'),
        `${readFileSync(join(gitDir, 'config'), 'utf8')}${f.filterConfig}[core]\n\tfsmonitor = ${f.planted}\n\thooksPath = ${hooks}\n[extensions]\n\tworktreeConfig = true\n`,
      );
      mkdirSync(join(gitDir, 'info'), { recursive: true });
      writeFileSync(join(gitDir, 'info', 'attributes'), '* filter=planted\n');
      writeFileSync(join(gitDir, 'config.worktree'), f.filterConfig);
      const common = join(f.root, 'common');
      mkdirSync(common);
      git(common, 'init', '--quiet', '--bare', '.');
      writeFileSync(join(common, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${f.filterConfig}`);
      writeFileSync(join(gitDir, 'commondir'), `${common}\n`);
      mkdirSync(join(f.root, 'elsewhere'));
      writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), `${join(f.root, 'elsewhere')}\n`);

      const second = next();
      const received = f.receive(second, f.bundle(first));
      expect(received.stderr).toBe('');
      expect(received.status).toBe(0);
      expect(readdirSync(gitDir).filter((name) => !moduleKept.test(name))).toEqual([]);
      expect(readFileSync(join(gitDir, 'config'), 'utf8')).not.toContain('planted');
      expect(readFileSync(join(gitDir, 'config'), 'utf8')).not.toContain(hooks);
      expect(existsSync(join(gitDir, 'objects', 'info', 'alternates'))).toBe(false);

      const updated = f.update();
      expect(updated.status, updated.stderr).toBe(0);
      expect(readFileSync(join(f.folder, 'sub', 'b.c'), 'utf8')).toBe('int b = 1;\n');
      expect(f.ran()).toEqual([]);
    });

    it.each(['a directory with a planted config', 'a gitfile pointing at a planted repository', 'a symlink to a planted repository'])(
      "writes the submodule folder's .git afresh when an earlier run left it as %s",
      (kind) => {
        const { f, first, next } = built();
        const outside = join(f.root, 'outside');
        mkdirSync(outside);
        git(outside, 'init', '--quiet', '.');
        const outsideGit = join(outside, '.git');
        writeFileSync(join(outsideGit, 'config'), `${readFileSync(join(outsideGit, 'config'), 'utf8')}${f.filterConfig}[core]\n\tfsmonitor = ${f.planted}\n`);
        mkdirSync(join(outsideGit, 'info'), { recursive: true });
        writeFileSync(join(outsideGit, 'info', 'attributes'), '* filter=planted\n');
        const outsideConfig = readFileSync(join(outsideGit, 'config'), 'utf8');
        const dotGit = join(f.folder, 'sub', '.git');
        rmSync(dotGit, { recursive: true, force: true });
        if (kind.startsWith('a directory')) {
          git(join(f.folder, 'sub'), 'init', '--quiet', '.');
          writeFileSync(join(dotGit, 'config'), `${readFileSync(join(dotGit, 'config'), 'utf8')}${f.filterConfig}[core]\n\tfsmonitor = ${f.planted}\n`);
          mkdirSync(join(dotGit, 'info'), { recursive: true });
          writeFileSync(join(dotGit, 'info', 'attributes'), '* filter=planted\n');
        } else if (kind.startsWith('a gitfile')) {
          writeFileSync(dotGit, `gitdir: ${outsideGit}\n`);
        } else {
          symlinkSync(outsideGit, dotGit);
        }

        const second = next();
        const received = f.receive(second, f.bundle(first));
        expect(received.stderr).toBe('');
        expect(received.status).toBe(0);
        expect(lstatSync(dotGit).isFile()).toBe(true);
        expect(readFileSync(dotGit, 'utf8')).toBe('gitdir: ../.git/modules/sub\n');
        const updated = f.update();
        expect(updated.status, updated.stderr).toBe(0);
        expect(readFileSync(join(f.folder, 'sub', 'b.c'), 'utf8')).toBe('int b = 1;\n');
        expect(f.ran()).toEqual([]);
        expect(readFileSync(join(outsideGit, 'config'), 'utf8')).toBe(outsideConfig);
      },
    );

    /** A head with a submodule `a` that has a submodule `b`, received and updated once. */
    function nested() {
      const f = fixture();
      const inner = repository(f, 'innersrc', { 'x.c': 'int x;\n', 'y.c': 'int y;\n' });
      const middle = repository(f, 'middlesrc', { 'm.c': 'int m;\n' });
      addSubmodule(middle, inner, 'b');
      commitIn(middle, {});
      addSubmodule(f.source, middle, 'a');
      const first = f.commit({ Makefile: 'host-ci:\n\ttrue\n' });
      expect(f.receive(first, f.bundle()).status).toBe(0);
      const updated = f.update();
      expect(updated.status, updated.stderr).toBe(0);
      expect(readFileSync(join(f.folder, 'a', 'b', 'y.c'), 'utf8')).toBe('int y;\n');
      /** A second head whose `a` pins a commit that moves `b`, which changes `y.c` only. */
      const next = () => {
        commitIn(inner, { 'y.c': 'int y = 1;\n' });
        movePin(middle, 'b');
        commitIn(middle, {});
        movePin(f.source, 'a');
        return f.commit({});
      };
      return { f, first, next, innerGitDir: join(f.folder, '.git', 'modules', 'a', 'modules', 'b') };
    }

    it("cleans a nested submodule's git dir too, and points its folder at it", () => {
      const { f, first, next, innerGitDir } = nested();
      const unchanged = statSync(join(f.folder, 'a', 'b', 'x.c'), { bigint: true });
      writeFileSync(join(innerGitDir, 'config'), `${readFileSync(join(innerGitDir, 'config'), 'utf8')}${f.filterConfig}`);
      mkdirSync(join(innerGitDir, 'info'), { recursive: true });
      writeFileSync(join(innerGitDir, 'info', 'attributes'), '* filter=planted\n');

      const second = next();
      const received = f.receive(second, f.bundle(first));
      expect(received.stderr).toBe('');
      expect(received.status).toBe(0);
      expect(readdirSync(innerGitDir).filter((name) => !moduleKept.test(name))).toEqual([]);
      expect(readFileSync(join(f.folder, 'a', 'b', '.git'), 'utf8')).toBe('gitdir: ../../.git/modules/a/modules/b\n');
      const updated = f.update();
      expect(updated.status, updated.stderr).toBe(0);
      expect(readFileSync(join(f.folder, 'a', 'b', 'y.c'), 'utf8')).toBe('int y = 1;\n');
      expect(statSync(join(f.folder, 'a', 'b', 'x.c'), { bigint: true }).mtimeNs).toBe(unchanged.mtimeNs);
      expect(f.ran()).toEqual([]);
    });

    it("removes a planted .git inside a kept submodule's folder that its kept index leaves out", () => {
      const { f, first, next } = nested();
      // The middle module's index is the earlier run's: here it no longer
      // lists `b`, whose folder now holds a git dir with a planted filter.
      git(f.root, '--git-dir', join(f.folder, '.git', 'modules', 'a'), 'rm', '--quiet', '--cached', 'b');
      const dotGit = join(f.folder, 'a', 'b', '.git');
      rmSync(dotGit, { recursive: true, force: true });
      git(join(f.folder, 'a', 'b'), 'init', '--quiet', '.');
      writeFileSync(join(dotGit, 'config'), `${readFileSync(join(dotGit, 'config'), 'utf8')}${f.filterConfig}[core]\n\tfsmonitor = ${f.planted}\n`);
      mkdirSync(join(dotGit, 'info'), { recursive: true });
      writeFileSync(join(dotGit, 'info', 'attributes'), '* filter=planted\n');

      const second = next();
      const received = f.receive(second, f.bundle(first));
      expect(received.stderr).toBe('');
      expect(received.status).toBe(0);
      expect(existsSync(dotGit)).toBe(false);
      f.update();
      expect(f.ran()).toEqual([]);
    });

    it.each(['ext::sh -c touch% /tmp/openadlc-planted', '-oProxyCommand=touch /tmp/openadlc-planted', 'https://example.com/a b'])(
      'does not carry a remote.origin.url of %s over',
      (url) => {
        const { f, first, gitDir } = built();
        git(f.root, 'config', '--file', join(gitDir, 'config'), 'remote.origin.url', url);
        const received = f.receive(first, f.bundle());
        expect(received.stderr).toBe('');
        expect(received.status).toBe(0);
        expect(readFileSync(join(gitDir, 'config'), 'utf8')).not.toContain('remote "origin"');
      },
    );

    it('heals the layout the old receive left, a gitfile with no .git/modules, by cloning the submodule again', () => {
      const { f, first, next } = built();
      rmSync(join(f.folder, '.git', 'modules'), { recursive: true, force: true });
      expect(f.update().status).not.toBe(0);

      const second = next();
      const received = f.receive(second, f.bundle(first));
      expect(received.stderr).toBe('');
      expect(received.status).toBe(0);
      expect(readdirSync(join(f.folder, 'sub'))).toEqual([]);
      const updated = f.update();
      expect(updated.status, updated.stderr).toBe(0);
      expect(readFileSync(join(f.folder, 'sub', 'b.c'), 'utf8')).toBe('int b = 1;\n');
    });

    it('leaves nothing of a submodule the head no longer has', () => {
      const { f, first } = built();
      git(f.source, 'rm', '--quiet', 'sub');
      const second = f.commit({});
      const received = f.receive(second, f.bundle(first));
      // Git's own word that the folder, an untracked one now, stays.
      expect(received.stderr).toBe("warning: unable to rmdir 'sub': Directory not empty\n");
      expect(received.status).toBe(0);
      expect(existsSync(join(f.folder, '.git', 'modules', 'sub'))).toBe(false);
      expect(existsSync(join(f.folder, '.git', 'openadlc-modules'))).toBe(false);
    });

    it('stops, naming it, at a submodule path it cannot clean', () => {
      const { f, first } = built();
      const pin = git(f.folder, 'rev-parse', 'HEAD:sub');
      git(f.source, 'update-index', '--add', '--cacheinfo', `160000,${pin},we"ird`);
      git(f.source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'odd');
      const second = git(f.source, 'rev-parse', 'HEAD');
      git(f.source, 'update-ref', 'refs/openadlc/host-check/7', second);
      const received = f.receive(second, f.bundle(first));
      expect(received.status).not.toBe(0);
      expect(received.stderr).toContain('cannot keep the submodule at "we');
      expect(received.stderr).toContain('rename it');
    });
  });
});

describe('hostd’s own processes', () => {
  it('stops a command’s background children with it, as a process group', async () => {
    const { start } = nodeProcesses();
    let printed = '';
    const child = start(['/bin/sh', '-c', 'sleep 300 & echo "$!"; wait'], (chunk) => {
      printed += chunk;
    });
    await vi.waitFor(() => expect(printed.trim()).toMatch(/^\d+$/));
    const sleeper = Number(printed.trim());
    expect(alive(sleeper)).toBe(true);
    await child.signalAll('TERM');
    await child.exited;
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false));
  });

  it('gives sudo and git none of hostd’s environment', async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = [];
    const fake = ((_command: string, _args: string[], options: SpawnOptions) => {
      seen.push(options.env);
      return spawn('/usr/bin/true', [], { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcess;
    }) as never;
    const processes = nodeProcesses(fake);
    await processes.run(['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/true']);
    await processes.pipe({ argv: ['git', 'bundle', 'create', '-'] }, { argv: ['sudo', '-n'] }, 5_000);
    for (const env of seen) {
      expect(Object.keys(env ?? {}).sort()).toEqual(['LANG', 'PATH']);
    }
  });

  it('starts every process in /, which the account can enter, not in hostd’s own folder (#365)', async () => {
    const seen: { command: string; cwd: unknown }[] = [];
    const fake = ((command: string, _args: string[], options: SpawnOptions) => {
      seen.push({ command, cwd: options.cwd });
      return spawn('/usr/bin/true', [], { stdio: ['pipe', 'pipe', 'pipe'], detached: true }) as ChildProcess;
    }) as never;
    const processes = nodeProcesses(fake);
    await processes.run(['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/env', '-i', '/usr/bin/true']);
    await processes.pipe({ argv: ['git', 'bundle', 'create', '-'] }, { argv: ['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/env', '-i', '/bin/sh'] }, 5_000);
    const child = processes.start(['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/env', '-i', '/bin/sh', '-c', 'true'], () => undefined);
    await child.exited;
    await child.signalAll('TERM');
    // run, both ends of the pipe, the build, and the killer `signalAll` sends as the account.
    expect(seen).toHaveLength(5);
    expect(seen.every((call) => call.cwd === '/')).toBe(true);
  });

  it('runs a command whose working folder is /, so the shell prints no getcwd error first', async () => {
    const { start } = nodeProcesses();
    let printed = '';
    const child = start(['/bin/sh', '-c', 'pwd'], (chunk) => {
      printed += chunk;
    });
    expect(await child.exited).toBe(0);
    expect(printed).toBe('/\n');
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the receive script, shared with the release run (#343)', () => {
  it('is the host check’s RECEIVE, byte for byte as it was last changed on purpose', () => {
    expect(RECEIVE).toBe(receiveScript('host-check'));
    // The sha256 of RECEIVE: a change to the host check's script has to
    // change this test on purpose. Last changed by #411, which stops git
    // starting background maintenance (docs/adr/0097); it was bf42cfe9…
    // before, after #365's submodule git dirs (docs/adr/0079).
    expect(createHash('sha256').update(RECEIVE).digest('hex')).toBe('6b5e64ae87cd8fbf9576c3a87785a1ea78a0805446dacad192f9c38973ec79f3');
  });

  it('fetches only the release refs for a release, and keeps the same .git cleaning', () => {
    const release = receiveScript('release');
    expect(release).toContain("'+refs/openadlc/release/*:refs/openadlc/release/*'");
    expect(release).not.toContain('host-check');
    expect(release.replaceAll('refs/openadlc/release/', 'refs/openadlc/host-check/')).toBe(RECEIVE);
  });
});
