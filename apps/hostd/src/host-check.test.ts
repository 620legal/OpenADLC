import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostChecks, hostCheckEnv, hostCheckRequestFrom, nodeProcesses, type HostCheckRun, type HostProcesses, type ProcessResult } from './host-check.js';

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
function machine(fit: { uid?: string; sudo?: boolean; readable?: string[] } = {}) {
  const ran: { argv: string[]; env?: Record<string, string> }[] = [];
  const piped: { from: { argv: string[]; env?: Record<string, string> }; to: { argv: string[] } }[] = [];
  const started: { argv: string[]; signals: string[]; finish: (code: number) => void; output: (text: string) => void }[] = [];
  const processes: HostProcesses = {
    async run(argv, options = {}) {
      ran.push({ argv, ...(options.env ? { env: options.env } : {}) });
      if (argv[0] === 'id') return fit.uid === undefined ? { code: 0, stdout: '502\n', stderr: '' } : fit.uid === '' ? { code: 1, stdout: '', stderr: 'no such user' } : { code: 0, stdout: `${fit.uid}\n`, stderr: '' };
      if (argv[0] === '/bin/sh' && argv[2]?.includes('eval')) return { code: 0, stdout: `${HOME}\n`, stderr: '' };
      if (argv[0] === 'sudo') {
        if (fit.sudo === false) return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
        const path = argv[argv.length - 1] ?? '';
        if (argv.includes('test -r "$1" || ls "$1" >/dev/null 2>&1')) return { code: (fit.readable ?? []).includes(path) ? 0 : 1, stdout: '', stderr: '' };
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
      return {
        exited,
        async signalAll(signal) {
          entry.signals.push(signal);
          if (signal === 'TERM') finish(143);
        },
      };
    },
  };
  const lastFetched = new Map<string, string>();
  return { processes, ran, piped, started };
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    expect(Object.fromEntries(assignments.map((part) => part.split(/=(.*)/s).slice(0, 2)))).toEqual(hostCheckEnv(ACCOUNT, HOME));
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

  it('refuses the run, with the fix, and never runs the command, when the probe fails', async () => {
    const world = machine({ readable: [OPENADLC_HOME] });
    const { hostChecks, reports } = checks(world);
    hostChecks.start(START);
    await hostChecks.settled();
    expect(world.started).toHaveLength(0);
    expect(reports.at(-1)).toMatchObject({ state: 'refused', reason: expect.stringContaining('docs/self-hosting.md#host-checks') });
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
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
