import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every path hostd's code hands to `node:fs`, so a test can show that none is
// under the account's folder: hostd never opens, stats or resolves it.
const fsCalls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watched = [
    'openSync', 'readFileSync', 'writeFileSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync', 'mkdirSync', 'rmSync',
    'readdirSync', 'accessSync', 'readlinkSync', 'createReadStream', 'open', 'stat', 'lstat', 'realpath', 'readFile', 'copyFileSync',
  ] as const;
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of watched) {
    const original = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    if (typeof original !== 'function') continue;
    wrapped[name] = Object.assign((...args: unknown[]) => {
      fsCalls.paths.push(String(args[0]));
      return original(...args);
    }, original);
  }
  return { ...wrapped, default: wrapped };
});

import {
  ReleaseBusy,
  ReleaseRuns,
  releaseRunRequestFrom,
  type ReleaseProcesses,
  type ReleaseRunRequest,
  type ReleaseRunView,
} from './release-run.js';
import type { HostProcesses, ProcessResult } from './account-probe.js';
import type { ReleaseAccountProbe } from './release-account.js';

const ACCOUNT = 'openadlc-release';
const KEY = `-----BEGIN PRIVATE KEY-----planted-release-key-${'k'.repeat(20)}`;
const GH = `ghs_${'t'.repeat(36)}`;
const OK: ProcessResult = { code: 0, stdout: '', stderr: '' };
/** Exactly what `releaseEnv` gives, in order: a fixed list, so a name added there from hostd's environment fails here. */
const ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'CI', 'OPENADLC_RELEASE', 'OPENADLC_RELEASE_SHA', 'OPENADLC_RELEASE_VERSION'];

const dirs: string[] = [];
const saved = { ...process.env };

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `openadlc-release-${name}-`));
  dirs.push(dir);
  return dir;
}

const GIT_ID = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** A repository on disk that hostd fetches from as its remote. */
function remoteRepo() {
  const dir = temp('remote');
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { PATH: process.env.PATH ?? '', ...GIT_ID } }).toString().trim();
  git('init', '--quiet', '--initial-branch=main');
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    git('add', '-A');
    git('commit', '--quiet', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

interface Machine {
  processes: HostProcesses;
  reader: ReleaseProcesses;
  events: string[];
  /** Every argv run as the account, in order. */
  asAccount: string[][];
  ran: { argv: string[]; env?: Record<string, string> }[];
  piped: { from: { argv: string[] }; to: { argv: string[] } }[];
  started: { argv: string[]; finish: (code: number) => void; output: (text: string) => void }[];
}

/**
 * The machine as the tests see it: hostd's own git runs for real against the
 * remote; everything as the account is recorded, and answers as `account`
 * says. The build runs until a test finishes it, or `build` does.
 */
function machine(
  account: {
    build?: { code: number; output?: string } | 'hang';
    artifact?: { bytes?: Buffer; chunks?: Buffer[]; code?: number; stderr?: string };
  } = {},
): Machine {
  const events: string[] = [];
  const asAccount: string[][] = [];
  const ran: Machine['ran'] = [];
  const piped: Machine['piped'] = [];
  const started: Machine['started'] = [];
  const gitHome = temp('git-home');
  const processes: HostProcesses = {
    async run(argv, options = {}) {
      ran.push({ argv, ...(options.env ? { env: options.env } : {}) });
      if (argv[0] === 'git') {
        const result = spawnSync('git', argv.slice(1), { env: { PATH: process.env.PATH ?? '', HOME: gitHome, ...options.env }, maxBuffer: 10_000_000 });
        return { code: result.status ?? 1, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
      }
      if (argv[0] === 'sudo') {
        asAccount.push(argv);
        const kill = argv.indexOf('/bin/kill');
        if (kill >= 0) events.push(`clear ${argv[kill + 1]?.slice(1)}`);
        else if (argv.includes('/bin/rm')) events.push('rm');
        else events.push(`as account: ${argv.slice(-3).join(' ')}`);
      }
      return OK;
    },
    async pipe(from, to) {
      piped.push({ from, to });
      asAccount.push(to.argv);
      events.push('bundle');
      return OK;
    },
    start(argv, onOutput) {
      asAccount.push(argv);
      let finish: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        finish = resolve;
      });
      started.push({ argv, finish, output: onOutput });
      events.push('build');
      const build = account.build ?? { code: 0, output: 'built\n' };
      if (build !== 'hang') {
        queueMicrotask(() => {
          if (build.output) onOutput(build.output);
          finish(build.code);
        });
      }
      return {
        exited,
        async signalAll(signal) {
          events.push(`signal ${signal}`);
          if (signal === 'TERM') finish(143);
          if (signal === 'KILL') finish(137);
        },
      };
    },
  };
  const reader: ReleaseProcesses = {
    read(argv, onChunk) {
      asAccount.push(argv);
      events.push('cat');
      const artifact = account.artifact ?? {};
      const chunks = artifact.chunks ?? [artifact.bytes ?? Buffer.from('the artifact the account wrote')];
      let stopped = false;
      const done = (async () => {
        await Promise.resolve();
        for (const chunk of chunks) {
          if (stopped) break;
          if (!onChunk(chunk)) {
            stopped = true;
            break;
          }
        }
        return { code: stopped ? 143 : (artifact.code ?? 0), stderr: artifact.stderr ?? '', timedOut: false };
      })();
      return {
        done,
        stop() {
          stopped = true;
        },
      };
    },
  };
  return { processes, reader, events, asAccount, ran, piped, started };
}

function runs(world: Machine, options: { home: string; workRoot?: string; probe?: ReleaseAccountProbe; extra?: Partial<ConstructorParameters<typeof ReleaseRuns>[0]> }) {
  const reports: ReleaseRunView[] = [];
  const workRoot = options.workRoot ?? temp('work');
  const releaseRuns = new ReleaseRuns({
    account: { account: ACCOUNT, probe: async () => options.probe ?? { ok: true, account: ACCOUNT, uid: 503, home: options.home } },
    installId: 'default',
    workRoot,
    remote: () => remoteDir,
    fetchAuth: async () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${GH}` }),
    report: async (run) => {
      world.events.push(`report ${run.state}`);
      reports.push(run);
    },
    processes: world.processes,
    reader: world.reader,
    killAfterMs: 0,
    ...options.extra,
  });
  return { releaseRuns, reports, workRoot };
}

let remoteDir = '';

function request(sha: string, extra: Partial<ReleaseRunRequest> = {}): ReleaseRunRequest {
  return {
    runId: 'run-1',
    repo: 'acme/app',
    sha,
    defaultBranch: 'main',
    versionFile: 'VERSION',
    versionKey: null,
    after: null,
    command: 'make release',
    artifact: 'build/App.zip',
    timeoutMinutes: 60,
    clean: false,
    bot: 'atlas',
    ...extra,
  };
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  // What hostd's own process holds, none of which may reach the account.
  process.env.OPENADLC_RELEASE_KEY = KEY;
  process.env.GH_TOKEN = GH;
  process.env.OPENADLC_INTERNAL_SECRET = 'install-secret';
  fsCalls.paths.length = 0;
});

afterEach(() => {
  process.env = { ...saved };
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a start as the bridge sends it', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ ...request('a'.repeat(40)), ...extra });

  it('is taken as it is', () => {
    expect(releaseRunRequestFrom(body())).toEqual(request('a'.repeat(40)));
  });

  it.each([
    ['a short sha', { sha: 'abc1234' }],
    ['a timeout of 0', { timeoutMinutes: 0 }],
    ['a timeout of 1441', { timeoutMinutes: 1441 }],
    ['an artifact with ..', { artifact: '../hostd/secret' }],
    ['an absolute artifact', { artifact: '/etc/passwd' }],
    ['an artifact in ~', { artifact: '~/x' }],
    ['a version file with a newline', { versionFile: 'VERSION\nx' }],
    ['a multi-line command', { command: 'make\nrm -rf /' }],
    ['a branch that is an option', { defaultBranch: '--upload-pack=x' }],
    ['an after that is no version', { after: '1.4.0-rc' }],
    ['a run id with a slash', { runId: '../x' }],
  ])('refuses %s', (_name, extra) => {
    expect(typeof releaseRunRequestFrom(body(extra))).toBe('string');
  });
});

describe('a release run', () => {
  let home: string;
  let remote: ReturnType<typeof remoteRepo>;
  let first: string;

  beforeEach(() => {
    home = temp('account-home');
    remote = remoteRepo();
    remoteDir = remote.dir;
    first = remote.commit({ VERSION: '1.4.0\n', Makefile: 'release:\n\ttrue\n' }, 'first');
  });

  it('builds the pinned SHA and reports what hostd computed', async () => {
    const world = machine({ artifact: { bytes: Buffer.from('zip bytes') } });
    const { releaseRuns, reports, workRoot } = runs(world, { home });
    releaseRuns.start(request(first, { after: '1.3.9' }));
    await releaseRuns.settled();

    expect(reports.at(-1)).toMatchObject({ state: 'built', sha: first, version: '1.4.0', sha256: sha256('zip bytes'), bytes: 9, artifactName: 'App.zip' });
    const bundle = world.piped[0];
    expect(bundle?.from.argv.slice(-2)).toEqual(['-', 'refs/openadlc/release/build']);
    expect(bundle?.to.argv.slice(-2)).toEqual([join(home, 'openadlc', 'default', 'acme__app'), first]);
    expect(bundle?.to.argv.join(' ')).toContain("'+refs/openadlc/release/*:refs/openadlc/release/*'");
    expect(readFileSync(join(workRoot, 'release', 'artifacts', 'run-1', 'App.zip'), 'utf8')).toBe('zip bytes');
  });

  it('builds the pinned SHA when the default branch has moved past it', async () => {
    const pinned = first;
    const moved = remote.commit({ VERSION: '9.0.0\n' }, 'moved on');
    const world = machine();
    const { releaseRuns, reports } = runs(world, { home });
    releaseRuns.start(request(pinned));
    await releaseRuns.settled();

    expect(reports.at(-1)).toMatchObject({ state: 'built', sha: pinned, version: '1.4.0' });
    const updated = world.ran.find((call) => call.argv.includes('update-ref'));
    expect(updated?.argv.slice(-2)).toEqual(['refs/openadlc/release/build', pinned]);
    expect(world.piped[0]?.to.argv.at(-1)).toBe(pinned);
    expect(JSON.stringify(world.asAccount)).not.toContain(moved);
  });

  it('refuses a SHA not on the default branch, with nothing but the clear run as the account', async () => {
    remote.git('checkout', '--quiet', '-b', 'feature');
    const elsewhere = remote.commit({ VERSION: '2.0.0\n' }, 'not merged');
    remote.git('checkout', '--quiet', 'main');
    const world = machine();
    const { releaseRuns, reports } = runs(world, { home });
    releaseRuns.start(request(elsewhere));
    await releaseRuns.settled();

    expect(reports.at(-1)).toMatchObject({ state: 'refused', reason: expect.stringContaining(`${elsewhere.slice(0, 7)} is not on main`) });
    expect(world.piped).toEqual([]);
    expect(world.started).toEqual([]);
    expect(world.events.filter((event) => !event.startsWith('clear') && !event.startsWith('report'))).toEqual([]);
  });

  it('refuses a version not above the last release, a different label, and an unparseable one, before any code reaches the account', async () => {
    const cases: [Record<string, string>, string | null, RegExp][] = [
      [{ VERSION: '1.4.0\n' }, '1.4.0', /1\.4\.0 is not above the last release, 1\.4\.0: raise it in VERSION/],
      [{ VERSION: '1.2.3.4-y.11\n' }, '1.2.3.4-x.10', /has the label y, and the last release, 1\.2\.3\.4-x\.10, has x: use x in VERSION/],
      [{ VERSION: '1.4.0-rc\n' }, null, /`1\.4\.0-rc` is not a release version.* in VERSION/],
    ];
    for (const [files, after, reason] of cases) {
      const sha = remote.commit(files, `version ${files.VERSION}`);
      const world = machine();
      const { releaseRuns, reports } = runs(world, { home });
      releaseRuns.start(request(sha, { after }));
      await releaseRuns.settled();
      expect(reports.at(-1)?.state).toBe('refused');
      expect(reports.at(-1)?.reason).toMatch(reason);
      expect(world.piped).toEqual([]);
      expect(world.started).toEqual([]);
    }
  });

  it('refuses a missing version file, naming it', async () => {
    const world = machine();
    const { releaseRuns, reports } = runs(world, { home });
    releaseRuns.start(request(first, { versionFile: 'Config/Version.xcconfig', versionKey: 'MARKETING_VERSION' }));
    await releaseRuns.settled();
    expect(reports.at(-1)).toMatchObject({ state: 'refused', reason: expect.stringContaining('Config/Version.xcconfig is not in') });
    expect(world.started).toEqual([]);
  });

  it('builds a version above the last release with the same label', async () => {
    const sha = remote.commit({ 'Config/Version.xcconfig': 'MARKETING_VERSION = 156.0.8078.79-abc.30\n' }, 'raise');
    const world = machine();
    const { releaseRuns, reports } = runs(world, { home });
    releaseRuns.start(request(sha, { versionFile: 'Config/Version.xcconfig', versionKey: 'MARKETING_VERSION', after: '156.0.8078.79-abc.29' }));
    await releaseRuns.settled();
    expect(reports.at(-1)).toMatchObject({ state: 'built', version: '156.0.8078.79-abc.30' });
  });

  it('takes no signed field from what the account prints or writes', async () => {
    const fake = 'f'.repeat(64);
    const world = machine({ build: { code: 0, output: `version 9.9.9\nsha256 ${fake}\n` }, artifact: { bytes: Buffer.from('real bytes') } });
    // The build rewrites VERSION in its own tree: hostd reads its mirror.
    const tree = join(home, 'openadlc', 'default', 'acme__app');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'VERSION'), '9.9.9\n');
    writeFileSync(join(tree, 'SHA256'), fake);
    const { releaseRuns, reports, workRoot } = runs(world, { home });
    releaseRuns.start(request(first));
    await releaseRuns.settled();

    const run = reports.at(-1);
    expect(run).toMatchObject({ state: 'built', version: '1.4.0', sha256: sha256('real bytes'), bytes: 10 });
    expect(run?.logTail).toContain('version 9.9.9');
    const kept = JSON.parse(readFileSync(join(workRoot, 'release', 'artifacts', 'run-1', 'run.json'), 'utf8'));
    expect(kept).toMatchObject({ version: '1.4.0', sha256: sha256('real bytes'), bytes: 10, sha: first });
    expect(JSON.stringify(kept)).not.toContain('9.9.9');
    expect(JSON.stringify(kept)).not.toContain(fake);
  });

  it('never reads through a symlinked artifact path: what it keeps is the stream cat wrote', async () => {
    const hostdHome = temp('hostd-home');
    writeFileSync(join(hostdHome, 'secret.txt'), 'hostd secret');
    const tree = join(home, 'openadlc', 'default', 'acme__app');
    mkdirSync(join(tree, 'build'), { recursive: true });
    symlinkSync(join(hostdHome, 'secret.txt'), join(tree, 'build', 'App.zip'));
    const world = machine({ artifact: { bytes: Buffer.from('what cat as the account could read') } });
    const { releaseRuns, reports, workRoot } = runs(world, { home });
    fsCalls.paths.length = 0;
    releaseRuns.start(request(first));
    await releaseRuns.settled();

    expect(reports.at(-1)).toMatchObject({ state: 'built', sha256: sha256('what cat as the account could read') });
    expect(readFileSync(join(workRoot, 'release', 'artifacts', 'run-1', 'App.zip'), 'utf8')).toBe('what cat as the account could read');
    const read = world.asAccount.find((argv) => argv.includes('/bin/cat'));
    expect(read?.slice(-3)).toEqual(['/bin/cat', '--', `${tree}/build/App.zip`]);
    expect(fsCalls.paths.filter((path) => path.startsWith(home))).toEqual([]);
    expect(fsCalls.paths.some((path) => path.startsWith(workRoot))).toBe(true);
  });

  it('gives the account no key and no token, and logs neither', async () => {
    const world = machine({ build: { code: 1, output: 'boom\n' } });
    const { releaseRuns, reports, workRoot } = runs(world, { home });
    releaseRuns.start(request(first));
    await releaseRuns.settled();
    const ok = machine();
    const second = runs(ok, { home, workRoot });
    second.releaseRuns.start(request(first, { runId: 'run-2' }));
    await second.releaseRuns.settled();

    for (const argv of [...world.asAccount, ...ok.asAccount]) {
      expect(argv.slice(0, 7)).toEqual(['sudo', '-n', '-u', ACCOUNT, '--', '/usr/bin/env', '-i']);
      const assignments = argv.slice(7).filter((part) => /^[A-Z_]+=/.test(part));
      expect(assignments.map((part) => part.split('=')[0])).toEqual(ENV_KEYS);
      for (const planted of [KEY, GH, 'install-secret']) expect(argv.join(' ')).not.toContain(planted);
    }
    const all = JSON.stringify([...reports, ...second.reports]) + readFileSync(join(workRoot, 'release', 'artifacts', 'run-2', 'run.json'), 'utf8');
    for (const planted of [KEY, GH, 'install-secret']) expect(all).not.toContain(planted);
  });

  it('keeps the tree: a second run sends a thin bundle and removes nothing', async () => {
    const world = machine();
    const { releaseRuns, workRoot } = runs(world, { home });
    releaseRuns.start(request(first, { runId: 'run-1' }));
    await releaseRuns.settled();
    const next = remote.commit({ VERSION: '1.5.0\n' }, 'next');
    releaseRuns.start(request(next, { runId: 'run-2', after: '1.4.0' }));
    await releaseRuns.settled();

    expect(world.piped[1]?.from.argv.slice(-3)).toEqual(['-', 'refs/openadlc/release/build', `^${first}`]);
    expect(world.events).not.toContain('rm');
    expect(existsSync(join(workRoot, 'release', 'artifacts', 'run-2', 'run.json'))).toBe(true);
  });

  it('removes the tree as the account first when asked for a clean build, and gives all of it', async () => {
    const world = machine();
    const { releaseRuns } = runs(world, { home });
    releaseRuns.start(request(first, { runId: 'run-1' }));
    await releaseRuns.settled();
    world.events.length = 0;
    const next = remote.commit({ VERSION: '1.5.0\n' }, 'next');
    releaseRuns.start(request(next, { runId: 'run-2', clean: true }));
    await releaseRuns.settled();

    expect(world.events.indexOf('rm')).toBeGreaterThan(-1);
    expect(world.events.indexOf('rm')).toBeLessThan(world.events.indexOf('bundle'));
    const rm = world.asAccount.find((argv) => argv.includes('/bin/rm'));
    expect(rm?.slice(-4)).toEqual(['/bin/rm', '-rf', '--', join(home, 'openadlc', 'default', 'acme__app')]);
    expect(world.piped[1]?.from.argv.slice(-2)).toEqual(['-', 'refs/openadlc/release/build']);
  });

  describe('leaves nothing of the account running', () => {
    const clearedBeforeReport = (events: string[], state: string) => {
      const report = events.indexOf(`report ${state}`);
      expect(report).toBeGreaterThan(-1);
      const before = events.slice(0, report);
      const lastTerm = before.lastIndexOf('clear TERM');
      expect(lastTerm).toBeGreaterThan(before.lastIndexOf('build'));
      expect(before.lastIndexOf('clear KILL')).toBeGreaterThan(lastTerm);
    };

    it('after a pass', async () => {
      const world = machine();
      const { releaseRuns } = runs(world, { home });
      releaseRuns.start(request(first));
      await releaseRuns.settled();
      clearedBeforeReport(world.events, 'built');
      expect(world.events.lastIndexOf('clear KILL')).toBeGreaterThan(world.events.indexOf('cat'));
    });

    it('after a failure', async () => {
      const world = machine({ build: { code: 2 } });
      const { releaseRuns, reports } = runs(world, { home });
      releaseRuns.start(request(first));
      await releaseRuns.settled();
      expect(reports.at(-1)).toMatchObject({ state: 'failed', exitCode: 2 });
      clearedBeforeReport(world.events, 'failed');
    });

    it('after a timeout, saying to raise the limit', async () => {
      const world = machine({ build: 'hang' });
      const { releaseRuns, reports } = runs(world, { home, extra: { msPerMinute: 20 } });
      releaseRuns.start(request(first, { timeoutMinutes: 1 }));
      await releaseRuns.settled();
      expect(reports.at(-1)).toMatchObject({ state: 'failed', reason: expect.stringContaining("raise the repository's release time limit") });
      expect(world.events).toContain('signal TERM');
      expect(world.events).toContain('signal KILL');
      clearedBeforeReport(world.events, 'failed');
    });

    it('after a cancel, and the next run clears the account before its code arrives', async () => {
      const world = machine({ build: 'hang' });
      const { releaseRuns, reports } = runs(world, { home });
      releaseRuns.start(request(first));
      await vi.waitFor(() => expect(world.started.length).toBe(1));
      expect(releaseRuns.cancel('run-1', 'a person cancelled it')).toBe(true);
      await releaseRuns.settled();
      expect(reports.at(-1)).toMatchObject({ state: 'cancelled', reason: 'a person cancelled it' });
      clearedBeforeReport(world.events, 'cancelled');

      world.events.length = 0;
      const ok = machine();
      const next = runs(ok, { home });
      next.releaseRuns.start(request(first, { runId: 'run-2' }));
      await next.releaseRuns.settled();
      expect(ok.events.indexOf('clear KILL')).toBeLessThan(ok.events.indexOf('bundle'));
    });
  });

  it('refuses with the fix when the account is not fit, and runs nothing as it', async () => {
    const world = machine();
    const { releaseRuns, reports } = runs(world, { home, probe: { ok: false, account: ACCOUNT, problem: 'no_sudo', detail: 'hostd cannot run a command as openadlc-release' } });
    releaseRuns.start(request(first));
    await releaseRuns.settled();
    expect(reports.at(-1)).toMatchObject({ state: 'refused', reason: expect.stringContaining('docs/self-hosting.md#the-release-account') });
    expect(world.asAccount).toEqual([]);
  });

  it('runs one release at a time', () => {
    const world = machine({ build: 'hang' });
    const { releaseRuns } = runs(world, { home });
    releaseRuns.start(request(first));
    expect(() => releaseRuns.start(request(first, { runId: 'run-2' }))).toThrow(ReleaseBusy);
    releaseRuns.cancel('run-1');
  });

  describe('the artifact', () => {
    it.each([
      ['empty', { bytes: Buffer.alloc(0) }, /is empty/],
      ['unreadable', { code: 1, stderr: 'cat: build/App.zip: No such file or directory' }, /could not be read as openadlc-release: cat: build\/App\.zip/],
      ['over the cap', { chunks: [Buffer.alloc(600), Buffer.alloc(600)] }, /is larger than/],
    ])('fails when %s, and leaves no file', async (_name, artifact, reason) => {
      const world = machine({ artifact });
      const { releaseRuns, reports, workRoot } = runs(world, { home, extra: { maxArtifactBytes: 1000 } });
      releaseRuns.start(request(first));
      await releaseRuns.settled();
      expect(reports.at(-1)?.state).toBe('failed');
      expect(reports.at(-1)?.reason).toMatch(reason);
      expect(reports.at(-1)?.sha256).toBeNull();
      expect(existsSync(join(workRoot, 'release', 'artifacts', 'run-1'))).toBe(false);
    });

    it('is kept with run.json, and served after hostd starts again', async () => {
      const world = machine({ artifact: { bytes: Buffer.from('kept') } });
      const { releaseRuns, workRoot } = runs(world, { home });
      releaseRuns.start(request(first));
      await releaseRuns.settled();

      const again = runs(machine(), { home, workRoot }).releaseRuns;
      expect(again.get('run-1')).toMatchObject({ state: 'built', sha: first, version: '1.4.0', sha256: sha256('kept'), bytes: 4 });
      const artifact = again.artifact('run-1');
      expect(artifact && readFileSync(artifact.path, 'utf8')).toBe('kept');
      expect(again.deleteArtifact('run-1')).toBe(true);
      expect(again.get('run-1')).toBeNull();
    });
  });
});
