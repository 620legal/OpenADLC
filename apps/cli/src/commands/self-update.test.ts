import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRelease, builtRoots, NO_SIGN_IN_LINK, runForApply, writeResult, type ApplyOptions } from './self-update.js';

/**
 * The restart onto a prepared release, with the commands stood in for and the
 * files real: what runs, in what order, what is put back when a step before
 * the migration fails, and that nothing is stopped when the preflight finds
 * the checkout is not what the bridge prepared for.
 */
const FROM = 'f'.repeat(40);
const TO = 'e'.repeat(40);

let root: string;
let options: ApplyOptions;
let calls: string[];
let fail: RegExp | null;
let state: { head: string; branch: string; status: string; tree: string; running: string[]; others: { home: string; record: string }[] };
/** What the record of the restart under way said at each command, or that there was none. */
let records: Record<string, string | null>;
let envs: Record<string, NodeJS.ProcessEnv | undefined>;
const RUNNER = 'apps/hostd/dist/skill-runner.bundle.mjs';

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apply-'));
  options = { checkout: join(root, 'OpenADLC'), home: join(root, 'home'), staging: join(root, 'home/self-update/v0.2.0'), tag: 'v0.2.0', from: FROM, to: TO };
  // What the install runs now, and what the release brings.
  write(join(options.checkout, 'apps/bridge/dist/main.js'), 'old bridge');
  write(join(options.checkout, 'apps/console/.next/BUILD_ID'), 'old console');
  write(join(options.staging, 'tree/apps/bridge/dist/main.js'), 'new bridge');
  write(join(options.staging, 'tree/apps/console/.next/BUILD_ID'), 'new console');
  write(join(options.staging, 'tree/packages/shared/dist/index.js'), 'new shared');
  // The one file of the output a paused task's computer mounts on its own.
  write(join(options.checkout, RUNNER), 'old runner');
  write(join(options.staging, 'tree', RUNNER), 'new runner');
  calls = [];
  envs = {};
  records = {};
  fail = null;
  state = { head: FROM, branch: 'main', status: '', tree: TO, running: [], others: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function deps() {
  return {
    now: () => new Date('2026-10-25T18:10:00Z'),
    log: () => undefined,
    down: async () => {
      calls.push('down');
    },
    running: () => state.running,
    otherInstalls: () => state.others,
    run: async (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => {
      const name = command === process.execPath ? `node ${args[0]?.slice(options.checkout.length + 1)} ${args.slice(1).join(' ')}`.trim() : `${command} ${args.join(' ')}`;
      const where = cwd === options.checkout ? '' : ` (in ${cwd.slice(root.length + 1)})`;
      calls.push(`${name}${where}`);
      envs[name] = env;
      const record = join(options.home, 'run', 'self-update-applying.json');
      records[name] = existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as { step: string }).step : null;
      if (fail?.test(name)) throw new Error(`${name} failed`);
      if (command !== 'git') return '';
      if (args[0] === 'status') return state.status;
      if (args[0] === 'symbolic-ref') return state.branch;
      if (args[0] === 'rev-parse') return cwd === options.checkout ? state.head : state.tree;
      if (args[0] === 'merge') state.head = TO;
      if (args[0] === 'reset') state.head = args[2]!;
      return '';
    },
  };
}

const read = (path: string) => readFileSync(join(options.checkout, path), 'utf8');

describe('restarting onto a prepared release', () => {
  it('stops, fast-forwards, swaps the output in, installs offline, migrates and starts, in that order', async () => {
    const result = await applyRelease(options, deps());

    expect(result).toEqual({ format: 1, state: 'updated', tag: 'v0.2.0', from: FROM, to: TO, reason: 'on v0.2.0', finishedAt: '2026-10-25T18:10:00.000Z' });
    expect(calls).toEqual([
      'git status --porcelain --untracked-files=no',
      'git symbolic-ref --short -q HEAD',
      'git rev-parse HEAD',
      `git merge-base --is-ancestor ${FROM} ${TO}`,
      'git rev-parse HEAD (in home/self-update/v0.2.0/tree)',
      'down',
      `git merge --ff-only ${TO}`,
      'pnpm install --frozen-lockfile --offline',
      'node packages/db/dist/cli/migrate.js',
      'node apps/cli/dist/main.js up',
    ]);
    expect(read('apps/bridge/dist/main.js')).toBe('new bridge');
    expect(read('apps/console/.next/BUILD_ID')).toBe('new console');
    expect(read('packages/shared/dist/index.js')).toBe('new shared');
    expect(existsSync(join(options.staging, 'previous'))).toBe(false);
  });

  it('keeps a record of the restart while the checkout is between releases, and clears it once it is one again', async () => {
    await applyRelease(options, deps());
    expect(records[`git merge --ff-only ${TO}`]).toBe('merge');
    expect(records['pnpm install --frozen-lockfile --offline']).toBe('install');
    // Installed on the release: the migration and the start run with the checkout one release.
    expect(records['node packages/db/dist/cli/migrate.js']).toBeNull();
    expect(records['node apps/cli/dist/main.js up']).toBeNull();
    expect(existsSync(join(options.home, 'run', 'self-update-applying.json'))).toBe(false);
    expect(existsSync(join(options.checkout, '.openadlc', 'applying.json'))).toBe(false);
  });

  it('leaves the record when putting back fails too, for up to refuse', async () => {
    let installs = 0;
    const runner = deps().run;
    const result = await applyRelease(options, {
      ...deps(),
      run: async (command, args, cwd, env) => {
        if (command === 'pnpm' && ++installs <= 2) throw new Error('pnpm install exited 1');
        return runner(command, args, cwd, env);
      },
    });
    expect(result).toMatchObject({ state: 'failed', step: 'install' });
    expect(result).not.toHaveProperty('restoredTo');
    expect(result.reason).toMatch(/follow what openadlc up prints$/);
    expect(existsSync(join(options.home, 'run', 'self-update-applying.json'))).toBe(true);
    // In the checkout too, for another install that runs from it.
    expect(existsSync(join(options.checkout, '.openadlc', 'applying.json'))).toBe(true);
  });

  it('moves aside what the release no longer has, and puts it back with the rest', async () => {
    write(join(options.checkout, 'apps/bridge/dist/gone.js'), 'only the old build has this');
    await applyRelease(options, deps());
    expect(existsSync(join(options.checkout, 'apps/bridge/dist/gone.js'))).toBe(false);
  });

  it('puts everything back when the swap stops partway', async () => {
    write(join(options.checkout, 'apps/bridge/dist/gone.js'), 'only the old build has this');
    // A directory where the release has a file: the swap has written some files by the time it gets here.
    mkdirSync(join(options.checkout, 'apps/hostd/dist/skill-runner.bundle.mjs.d'), { recursive: true });
    write(join(options.staging, 'tree/apps/hostd/dist/skill-runner.bundle.mjs.d'), 'a file in the release');
    const runner = statSync(join(options.checkout, RUNNER)).ino;
    const result = await applyRelease(options, deps());

    expect(result).toMatchObject({ state: 'failed', step: 'output', restoredTo: FROM });
    expect(result.reason).toMatch(/skill-runner\.bundle\.mjs\.d in the checkout is in the way/);
    expect(read('apps/bridge/dist/main.js')).toBe('old bridge');
    expect(read('apps/console/.next/BUILD_ID')).toBe('old console');
    expect(read('apps/bridge/dist/gone.js')).toBe('only the old build has this');
    expect(read(RUNNER)).toBe('old runner');
    expect(statSync(join(options.checkout, RUNNER)).ino).toBe(runner);
    expect(existsSync(join(options.checkout, 'packages/shared/dist'))).toBe(false);
    expect(calls).toContain(`git reset --keep ${FROM}`);
    expect(existsSync(join(options.home, 'run', 'self-update-applying.json'))).toBe(false);
  });

  it('writes the skill runner over in place, so a paused task’s computer, which mounts that file, runs the new one', async () => {
    const before = statSync(join(options.checkout, RUNNER)).ino;
    await applyRelease(options, deps());
    expect(statSync(join(options.checkout, RUNNER)).ino).toBe(before);
    expect(read(RUNNER)).toBe('new runner');
  });

  it('installs with none of the services’ secrets, and starts without printing the sign-in link', async () => {
    process.env.OPENADLC_WEBHOOK_SECRET = 'whsec-of-this-install';
    try {
      await applyRelease(options, deps());
    } finally {
      delete process.env.OPENADLC_WEBHOOK_SECRET;
    }
    expect(envs['pnpm install --frozen-lockfile --offline']).not.toHaveProperty('OPENADLC_WEBHOOK_SECRET');
    expect(envs['pnpm install --frozen-lockfile --offline']?.PATH).toBe(process.env.PATH);
    expect(envs['node apps/cli/dist/main.js up']?.[NO_SIGN_IN_LINK]).toBe('1');
  });

  it('stops there, and starts the services again, when one would not stop', async () => {
    state.running = ['bridge'];
    const result = await applyRelease(options, deps());

    expect(result).toMatchObject({ state: 'failed', step: 'stop', to: FROM, restoredTo: FROM });
    expect(result.reason).toMatch(/^stop failed: bridge would not stop\./);
    expect(calls.slice(calls.indexOf('down'))).toEqual(['down', 'node apps/cli/dist/main.js up']);
    expect(read('apps/bridge/dist/main.js')).toBe('old bridge');
  });

  it.each([
    ['the fast-forward', /^git merge --ff-only/, 'merge'],
    ['the install', /^pnpm install/, 'install'],
  ])('puts back the commit, the output and the install when %s fails, and starts the old one', async (_what, step, name) => {
    const runner = statSync(join(options.checkout, RUNNER)).ino;
    const result = await applyRelease(options, { ...deps(), run: onceFailing(step) });

    expect(result).toMatchObject({ state: 'failed', step: name, to: FROM, restoredTo: FROM });
    expect(result.reason).toMatch(/The install was put back on fffffff and started$/);
    expect(read('apps/bridge/dist/main.js')).toBe('old bridge');
    expect(read('apps/console/.next/BUILD_ID')).toBe('old console');
    expect(read(RUNNER)).toBe('old runner');
    expect(statSync(join(options.checkout, RUNNER)).ino).toBe(runner);
    expect(existsSync(join(options.checkout, 'packages/shared/dist'))).toBe(false);
    const after = calls.slice(calls.indexOf('down'));
    if (name === 'install') expect(after).toContain(`git reset --keep ${FROM}`);
    else expect(after).not.toContain(`git reset --keep ${FROM}`);
    expect(after.slice(-2)).toEqual(['pnpm install --frozen-lockfile --offline', 'node apps/cli/dist/main.js up']);
    expect(after).not.toContain('node packages/db/dist/cli/migrate.js');
  });

  it('does not go back once a migration may have run', async () => {
    fail = /migrate/;
    const result = await applyRelease(options, deps());

    expect(result).toMatchObject({ state: 'failed', step: 'migrate', to: TO });
    expect(result).not.toHaveProperty('restoredTo');
    expect(result.reason).toMatch(/was not put back, since its migrations may have run/);
    expect(calls).not.toContain(`git reset --keep ${FROM}`);
    expect(read('apps/bridge/dist/main.js')).toBe('new bridge');
  });

  it.each([
    ['has changes of its own', () => (state.status = ' M README.md'), /has changes of its own now/],
    ['is on another branch', () => (state.branch = 'mine'), /on mine, not main/],
    ['moved since the update started', () => (state.head = 'd'.repeat(40)), /is at ddddddd, not fffffff/],
    ['was prepared at another commit', () => (state.tree = 'c'.repeat(40)), /is not at eeeeeee/],
    [
      'has another install running from it',
      () => (state.others = [{ home: '/Users/me/OpenADLC/.scratch/home', record: '/r.json' }]),
      /another install \(\/Users\/me\/OpenADLC\/\.scratch\/home\) runs from .*OPENADLC_HOME=\/Users\/me\/OpenADLC\/\.scratch\/home openadlc down/,
    ],
  ])('stops nothing when the checkout %s', async (_what, change, reason) => {
    change();
    const result = await applyRelease(options, deps());

    expect(result).toMatchObject({ state: 'failed', step: 'preflight', to: FROM });
    expect(result.reason).toMatch(reason);
    expect(result.reason).toMatch(/nothing was stopped/);
    expect(calls).not.toContain('down');
    expect(read('apps/bridge/dist/main.js')).toBe('old bridge');
  });

  it('knows the built output by its roots, and leaves the result where the bridge reads it', () => {
    expect(builtRoots(join(options.staging, 'tree'))).toEqual(['packages/shared/dist', 'apps/bridge/dist', 'apps/console/.next', 'apps/hostd/dist']);
    const path = writeResult(join(root, 'home'), { format: 1, state: 'updated', tag: 'v0.2.0', from: FROM, to: TO, reason: 'on v0.2.0', finishedAt: 't' });
    expect(path).toBe(join(root, 'home/run/self-update-result.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'updated', tag: 'v0.2.0' });
  });
});

describe('what a failed command leaves in the reason', () => {
  it('is its standard error alone, with no sign-in link or credential in it', async () => {
    // Made up, and built here so that no credential-shaped literal is in the
    // source for the secret scan to find (`.gitleaks.toml`).
    const pat = `ghp_${'a'.repeat(36)}`;
    const link = `http://127.0.0.1:47300/signin?token=${[1792600000, 'deadbeefcafe0123'].join('.')}`;
    const script = [
      `console.log("console   ${link}");`,
      `console.error("could not start the console; ${pat} and token=abc123");`,
      'process.exit(3);',
    ].join('');
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // As `up` does when a service does not start: the link on standard output, the trouble on standard error.
      writeFileSync(join(root, 'up.js'), script);
      const refused = await runForApply(process.execPath, [join(root, 'up.js'), 'up'], root).catch((error: Error) => error);
      expect(refused).toBeInstanceOf(Error);
      const reason = (refused as Error).message;
      expect(reason).toMatch(/^node .*up\.js up exited 3: could not start the console;/);
      expect(reason).not.toContain('deadbeefcafe0123');
      expect(reason).not.toContain('signin');
      expect(reason).not.toContain(pat);
      expect(reason).toContain('token=[redacted]');
    } finally {
      written.mockRestore();
      said.mockRestore();
    }
  });
});

/** The runner, failing the first command that matches and not the ones putting it back. */
function onceFailing(step: RegExp) {
  const runner = deps().run;
  let failed = false;
  return async (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => {
    const name = `${command} ${args.join(' ')}`;
    if (!failed && step.test(name)) {
      failed = true;
      calls.push(name);
      throw new Error(`${name} failed`);
    }
    fail = null;
    return runner(command, args, cwd, env);
  };
}
