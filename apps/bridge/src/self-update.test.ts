import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingKey } from '@openadlc/db';
import { releaseAssets, selfUpdatePaths, type SelfUpdateLast, type SelfUpdateRun } from '@openadlc/shared';

vi.mock('@openadlc/db', () => ({ audit: vi.fn(), settings: {} }));
// Each test makes and clones real repositories: a second on an idle machine,
// several on a loaded one.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { SelfUpdate, githubRepositoryOf, isRestartProcess, registerSelfUpdateRoutes, runCommand } = await import('./self-update.js');
const { Router } = await import('./router.js');

/**
 * Self-update against real git: a checkout cloned from an "origin" that
 * publishes a release. GitHub's API, the downloads, `gh`, `pnpm` and the
 * restart are stand-ins, so what is checked is the order the install trusts
 * things in, and that nothing the services run from is touched before the
 * restart.
 */
const REPO = 'acme/openadlc';
// Made up, and built here so that no credential-shaped literal is in the
// source for the secret scan to find (`.gitleaks.toml`).
const PAT = `ghp_${'a'.repeat(36)}`;
const DB_PASSWORD = 'hunter2';
const SIGN_IN = `http://127.0.0.1:47300/signin?token=${[1792600000, 'deadbeefcafe'].join('.')}`;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const made: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

interface Fixture {
  origin: string;
  checkout: string;
  home: string;
  first: string;
  release: string;
  tag: string;
  files: Map<string, Buffer>;
  releases: unknown[];
  calls: { command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }[];
  mutable?: boolean;
  pnpmSays?: string;
  engineAnswers: boolean;
  others: { home: string; record: string }[];
  spawnSees: (SelfUpdateRun | null)[];
  spawnFailed: ((error: Error) => void) | null;
  failWrite: string | null;
  /** GitHub's spelling of the repository, when it differs from the remote's. */
  fullName?: string;
  gh: { verify: 'pass' | 'fail'; help: string; trigger?: string; failTags?: string[] };
  pnpmFails: boolean;
  live: { id: string; bot: string; subjectRef: string; kind: string }[];
  engines: boolean;
  holds: string[];
  released: number;
  spawned: (readonly string[])[];
  alive: Set<number>;
  settings: Partial<Record<SettingKey, string>>;
  audits: { actor: string; action: string; payload?: Record<string, unknown> }[];
  now: Date;
}

/** An archive as release.yml packs one, made with the system's tar. */
function packRelease(tag: string, commitSha: string, tree: string, manifest?: Record<string, unknown>): Buffer {
  const dir = scratch('release-src-');
  mkdirSync(join(dir, 'apps/cli/dist'), { recursive: true });
  mkdirSync(join(dir, 'apps/bridge/dist'), { recursive: true });
  writeFileSync(join(dir, 'apps/cli/dist/main.js'), 'console.log("the release’s cli")');
  writeFileSync(join(dir, 'apps/bridge/dist/main.js'), 'console.log("the release’s bridge")');
  writeFileSync(join(dir, 'openadlc-release.json'), JSON.stringify(manifest ?? { format: 1, tag, commit: commitSha, tree }));
  const out = join(scratch('release-out-'), 'a.tar.gz');
  execFileSync('tar', ['--format=pax', '-czf', out, 'openadlc-release.json', 'apps/cli/dist', 'apps/bridge/dist'], {
    cwd: dir,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return readFileSync(out);
}

function publish(f: Fixture, tag: string, archive: Buffer, sums?: string): void {
  const names = releaseAssets(tag);
  f.files.set(names.archive, archive);
  f.files.set(names.bundle, Buffer.from('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}'));
  f.files.set(names.checksums, Buffer.from(sums ?? `${createHash('sha256').update(archive).digest('hex')}  ${names.archive}\n`));
  f.releases = [
    { tag_name: tag, draft: false, prerelease: false, immutable: !f.mutable, published_at: '2026-10-18T12:00:00Z', assets: Object.values(names).map((name) => ({ name })) },
  ];
}

let fixture: Fixture;

function setUp(): Fixture {
  const origin = scratch('origin-');
  git(origin, 'init', '-q', '-b', 'main');
  const first = commit(origin, 'README.md', 'one\n', 'First');
  const checkout = join(scratch('checkout-'), 'OpenADLC');
  execFileSync('git', ['clone', '-q', origin, checkout], { env: GIT_ENV });
  // The checkout names GitHub, as an install's does; git reaches the local origin instead.
  git(checkout, 'remote', 'set-url', 'origin', `https://github.com/${REPO}.git`);
  git(checkout, 'config', `url.${origin}.insteadOf`, `https://github.com/${REPO}.git`);
  const release = commit(origin, 'README.md', 'two\n', 'Second');
  git(origin, 'tag', 'v0.2.0', release);
  const tree = git(origin, 'rev-parse', `${release}^{tree}`);
  const made: Fixture = {
    origin,
    checkout,
    home: scratch('home-'),
    first,
    release,
    tag: 'v0.2.0',
    files: new Map(),
    releases: [],
    calls: [],
    gh: { verify: 'pass', help: '--bundle --cert-identity --source-ref --source-digest --deny-self-hosted-runners' },
    pnpmFails: false,
    live: [],
    engines: false,
    engineAnswers: true,
    others: [],
    spawnSees: [],
    spawnFailed: null,
    failWrite: null,
    holds: [],
    released: 0,
    spawned: [],
    alive: new Set(),
    settings: {},
    audits: [],
    now: new Date('2026-10-21T10:00:00Z'),
  };
  publish(made, 'v0.2.0', packRelease('v0.2.0', release, tree));
  return made;
}

function updater(f: Fixture): InstanceType<typeof SelfUpdate> {
  return new SelfUpdate({
    repoRoot: f.checkout,
    home: f.home,
    timeZone: 'UTC',
    pollMs: 5,
    resultPollMs: 5,
    now: () => f.now,
    run: async (command, args, options) => {
      f.calls.push({ command, args, cwd: options.cwd, ...(options.env ? { env: options.env } : {}) });
      if (command === 'git') return runCommand('git', args, { ...options, env: GIT_ENV });
      if (command === 'gh') {
        if (args.includes('--help')) return f.gh.help;
        const tag = (args[args.indexOf('--source-ref') + 1] ?? '').replace('refs/tags/', '');
        if (f.gh.verify === 'fail' || f.gh.failTags?.includes(tag)) throw new Error('gh attestation verify exited 1: no attestation matched the identity');
        // What gh prints with --format json: Fulcio's fields of the certificate.
        return JSON.stringify([
          {
            verificationResult: {
              signature: {
                certificate: { buildTrigger: f.gh.trigger ?? 'push', buildConfigURI: `https://github.com/${args[args.indexOf('--repo') + 1]}/.github/workflows/release.yml@refs/tags/${tag}` },
              },
            },
          },
        ]);
      }
      if (command === 'pnpm') {
        if (f.pnpmFails) throw new Error(f.pnpmSays ?? 'pnpm install exited 1: ERR_PNPM_OUTDATED_LOCKFILE');
        return '';
      }
      if (command === process.execPath) return 'usage';
      throw new Error(`unexpected ${command}`);
    },
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/${REPO}`) return Response.json({ full_name: f.fullName ?? REPO });
      if (url === `https://api.github.com/repos/${f.fullName ?? REPO}/releases?per_page=30`) return Response.json(f.releases);
      if (url.startsWith(`https://api.github.com/repos/${REPO}/commits/`)) return Response.json({ sha: f.release });
      const download = /^https:\/\/github\.com\/acme\/openadlc\/releases\/download\/([^/]+)\/(.+)$/.exec(url);
      const body = download ? f.files.get(decodeURIComponent(download[2]!)) : undefined;
      if (body) return new Response(body);
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
    store: {
      all: async () => ({ ...f.settings }),
      set: async (key, value) => {
        if (f.failWrite === key) {
          f.failWrite = null;
          throw new Error('the database went away');
        }
        if (value === '') delete f.settings[key];
        else f.settings[key] = value;
      },
    },
    audit: async (entry) => {
      f.audits.push(entry);
    },
    liveTasks: async () => [...f.live],
    engineUpdateRunning: async () => {
      if (!f.engineAnswers) throw new Error('hostd did not answer');
      return f.engines;
    },
    otherInstalls: () => f.others,
    gate: {
      hold: (reason) => {
        f.holds.push(reason);
        return () => {
          f.released += 1;
        };
      },
    },
    spawnApply: (args, _log, failed) => {
      f.spawnFailed = failed;
      f.spawned.push(args);
      f.spawnSees.push(f.settings.selfUpdateRun ? (JSON.parse(f.settings.selfUpdateRun) as SelfUpdateRun) : null);
      return 4242;
    },
    isAlive: (pid) => f.alive.has(pid),
    log: () => undefined,
  });
}

async function until(what: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const run = (): SelfUpdateRun | null => (fixture.settings.selfUpdateRun ? (JSON.parse(fixture.settings.selfUpdateRun) as SelfUpdateRun) : null);
const last = (): SelfUpdateLast | null => (fixture.settings.selfUpdateLast ? (JSON.parse(fixture.settings.selfUpdateLast) as SelfUpdateLast) : null);

/** Whether anything ran in the checkout that writes more than refs: only git, and only these. */
function checkoutCommands(): string[] {
  return fixture.calls.filter((call) => call.cwd === fixture.checkout).map((call) => `${call.command} ${call.args.join(' ')}`);
}
const READ_ONLY_IN_CHECKOUT = /^git (rev-parse|log|tag --points-at|config --get|status --porcelain|symbolic-ref|merge-base --is-ancestor|rev-list|cat-file|fetch --no-tags origin|worktree (add|remove|prune))/;

beforeEach(() => {
  fixture = setUp();
});
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('what System shows', () => {
  it('names the commit in use, the schedule it starts on, and whether it can update', async () => {
    const view = await updater(fixture).view();
    expect(view.inUse).toMatchObject({ sha: fixture.first, tag: null });
    expect(view.repository).toBe(REPO);
    expect(view.applicable).toBe(true);
    expect(view.schedule).toEqual({ mode: 'schedule', day: 'sunday', time: '18:00' });
    expect(view.nextRun).toBe('2026-10-25T18:00:00.000Z');
    expect(view.running).toBeNull();
  });

  it('reads the release a run would take, at most every quarter hour', async () => {
    const update = updater(fixture);
    expect((await update.refreshCandidate())?.tag).toBe('v0.2.0');
    fixture.releases = [];
    expect((await update.refreshCandidate())?.tag).toBe('v0.2.0');
    expect((await update.view()).candidate).toMatchObject({ tag: 'v0.2.0', sha: fixture.release });
    expect(JSON.parse(fixture.settings.selfUpdateCandidate ?? '{}')).toMatchObject({ forHead: fixture.first });
  });

  /** The checkout moved onto the release, as an update leaves it. */
  function moveOntoRelease(): void {
    git(fixture.checkout, 'fetch', '-q', 'origin', 'main');
    git(fixture.checkout, 'merge', '-q', '--ff-only', fixture.release);
  }

  it('asks again once the checkout’s head moved, within the quarter hour', async () => {
    const update = updater(fixture);
    expect((await update.refreshCandidate())?.tag).toBe('v0.2.0');
    moveOntoRelease();
    expect(await update.refreshCandidate()).toMatchObject({ tag: null, reason: 'on v0.2.0, the newest release', forHead: fixture.release });
  });

  it('asks again once for a candidate kept before it named its commit', async () => {
    let asked = 0;
    const update = updater(fixture);
    fixture.settings.selfUpdateCandidate = JSON.stringify({ tag: 'v0.1.9', sha: null, publishedAt: null, reason: 'v0.1.9 is the newest release', checkedAt: fixture.now.toISOString() });
    const releases = fixture.releases;
    Object.defineProperty(fixture, 'releases', {
      get: () => {
        asked += 1;
        return releases;
      },
      configurable: true,
    });
    expect(await update.refreshCandidate()).toMatchObject({ tag: 'v0.2.0', forHead: fixture.first });
    expect(asked).toBe(1);
    expect((await update.refreshCandidate())?.tag).toBe('v0.2.0');
    expect(asked).toBe(1);
  });

  it('names no release from before the head moved when GitHub cannot be asked', async () => {
    const update = updater(fixture);
    expect((await update.refreshCandidate())?.tag).toBe('v0.2.0');
    moveOntoRelease();
    Object.defineProperty(fixture, 'releases', {
      get: () => {
        throw new Error('GitHub is down');
      },
      configurable: true,
    });
    const candidate = await update.refreshCandidate();
    expect(candidate).toMatchObject({ tag: null, sha: null, forHead: fixture.release });
    expect(candidate?.reason).toMatch(/^could not ask GitHub for releases/);
  });

  it('shows no candidate asked on another commit', async () => {
    fixture.settings.selfUpdateCandidate = JSON.stringify({
      tag: 'v0.2.0',
      sha: fixture.release,
      publishedAt: null,
      reason: 'v0.2.0 is the newest release',
      checkedAt: fixture.now.toISOString(),
      forHead: fixture.release,
    });
    const view = await updater(fixture).view();
    expect(view.candidate).toBeNull();
    expect(view.checkedAt).toBeNull();
    expect(view.candidateReason).toBe(`not asked yet on ${fixture.first.slice(0, 7)}`);
  });

  it('knows a GitHub remote by its address', () => {
    expect(githubRepositoryOf('https://github.com/620legal/OpenADLC.git')).toBe('620legal/OpenADLC');
    expect(githubRepositoryOf('git@github.com:620legal/OpenADLC.git')).toBe('620legal/OpenADLC');
    expect(githubRepositoryOf('https://gitlab.com/620legal/OpenADLC.git')).toBeNull();
    expect(githubRepositoryOf('/srv/mirror/openadlc')).toBeNull();
  });
});

describe('what a run found', () => {
  /** What the last look said five minutes ago: the release in use was the newest then. */
  function lookedBefore(f: Fixture): string {
    const stored = JSON.stringify({ tag: null, sha: null, publishedAt: null, reason: 'on v0.1.16, the newest release', checkedAt: new Date(f.now.getTime() - 5 * 60_000).toISOString(), forHead: f.first });
    f.settings.selfUpdateCandidate = stored;
    return stored;
  }
  const stored = () => JSON.parse(fixture.settings.selfUpdateCandidate ?? '{}') as Record<string, unknown>;

  it('keeps the release a run chose as the candidate, through a run that then fails', async () => {
    lookedBefore(fixture);
    fixture.pnpmFails = true;
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    expect(stored()).toMatchObject({ tag: 'v0.2.0', sha: fixture.release, publishedAt: '2026-10-18T12:00:00Z', reason: 'v0.2.0 is the newest release', forHead: fixture.first, checkedAt: fixture.now.toISOString() });
    await until(() => last() !== null);
    await update.removing;
    expect(last()).toMatchObject({ state: 'failed', step: 'install' });
    expect(stored()).toMatchObject({ tag: 'v0.2.0', forHead: fixture.first });
    expect((await update.view()).candidate).toMatchObject({ tag: 'v0.2.0' });
  });

  it('keeps a run’s finding that there is nothing newer, with its reason', async () => {
    git(fixture.checkout, 'pull', '-q', '--ff-only', 'origin', 'main');
    fixture.settings.selfUpdateCandidate = JSON.stringify({ tag: 'v0.2.0', sha: fixture.release, publishedAt: null, reason: 'v0.2.0 is the newest release', checkedAt: fixture.now.toISOString(), forHead: fixture.release });
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    expect(stored()).toEqual({ tag: null, sha: null, publishedAt: null, reason: 'on v0.2.0, the newest release', checkedAt: fixture.now.toISOString(), forHead: fixture.release });
  });

  it('leaves the candidate as it was when the run could not read the releases', async () => {
    const before = lookedBefore(fixture);
    Object.defineProperty(fixture, 'releases', {
      get: () => {
        throw new Error('GitHub is down');
      },
      configurable: true,
    });
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    expect(last()).toMatchObject({ state: 'failed', step: 'releases' });
    expect(fixture.settings.selfUpdateCandidate).toBe(before);
  });
});

describe('Check again', () => {
  /** Counts the reads of the releases, which are what asks GitHub. */
  function countReads(f: Fixture): () => number {
    let reads = 0;
    const releases = f.releases;
    Object.defineProperty(f, 'releases', {
      get: () => {
        reads += 1;
        return releases;
      },
      configurable: true,
    });
    return () => reads;
  }
  function lookedAgo(f: Fixture, ms: number): void {
    f.settings.selfUpdateCandidate = JSON.stringify({ tag: null, sha: null, publishedAt: null, reason: 'on v0.1.16, the newest release', checkedAt: new Date(f.now.getTime() - ms).toISOString(), forHead: f.first });
  }

  it('is refused within a minute of the last look, naming the seconds, and asks GitHub nothing', async () => {
    lookedAgo(fixture, 30_000);
    const reads = countReads(fixture);
    const refused = await updater(fixture).checkAgain().catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 429, message: 'looked for a release 30 seconds ago; check again in 30 seconds' });
    expect(reads()).toBe(0);
  });

  it('is refused within a minute of a look asked on another commit too', async () => {
    lookedAgo(fixture, 10_000);
    fixture.settings.selfUpdateCandidate = JSON.stringify({ ...JSON.parse(fixture.settings.selfUpdateCandidate!), forHead: fixture.release });
    await expect(updater(fixture).checkAgain()).rejects.toMatchObject({ status: 429 });
  });

  it('asks at once after a minute, and two presses together ask once', async () => {
    lookedAgo(fixture, 61_000);
    const reads = countReads(fixture);
    const update = updater(fixture);
    const [one, two] = await Promise.all([update.checkAgain(), update.checkAgain()]);
    expect(reads()).toBe(1);
    expect(one.candidate).toMatchObject({ tag: 'v0.2.0' });
    expect(two.candidate).toMatchObject({ tag: 'v0.2.0' });
    expect(one.checkedAt).toBe(fixture.now.toISOString());
    // The look it just made is under a minute old.
    await expect(update.checkAgain()).rejects.toMatchObject({ status: 429, message: 'looked for a release 0 seconds ago; check again in 60 seconds' });
    expect(reads()).toBe(1);
  });
});

describe('the schedule', () => {
  it('claims this week’s slot on the first look and starts nothing', async () => {
    const lines = await updater(fixture).tick();
    expect(lines.at(-1)).toMatch(/the first is at 2026-10-25T18:00/);
    expect(JSON.parse(fixture.settings.selfUpdateSchedule ?? '{}')).toMatchObject({ slot: '2026-10-18T18:00:00.000Z' });
    expect(run()).toBeNull();
    expect(fixture.audits).toEqual([]);
  });

  it('starts exactly one run once the slot has passed, and none again in that slot', async () => {
    const update = updater(fixture);
    await update.tick();
    fixture.now = new Date('2026-10-25T18:03:00Z');
    fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await update.tick();
    await until(() => run()?.phase === 'waiting');
    expect(run()).toMatchObject({ trigger: 'schedule', actor: 'schedule', tag: 'v0.2.0' });
    expect(JSON.parse(fixture.settings.selfUpdateSchedule ?? '{}').slot).toBe('2026-10-25T18:00:00.000Z');
    await update.tick();
    expect(fixture.calls.filter((call) => call.command === 'pnpm')).toHaveLength(1);
  });

  it('counts a schedule moved or turned on from now, and stays put when Manual', async () => {
    const update = updater(fixture);
    await update.setSchedule({ mode: 'manual' }, 'jane@example.com');
    expect((await update.tick()).at(-1)).toMatch(/only when somebody presses Update now/);
    const view = await update.setSchedule({ mode: 'schedule', day: 'wednesday', time: '09:30' }, 'jane@example.com');
    expect(view.schedule).toEqual({ mode: 'schedule', day: 'wednesday', time: '09:30' });
    expect(JSON.parse(fixture.settings.selfUpdateSchedule ?? '{}').slot).toBe('2026-10-21T09:30:00.000Z');
    expect(view.due).toBe(false);
    await expect(update.setSchedule({ day: 'someday' }, 'jane@example.com')).rejects.toThrow(/day is one of/);
    expect(fixture.audits.map((entry) => entry.action)).toEqual(['openadlc.schedule_changed', 'openadlc.schedule_changed']);
  });
});

describe('an update', () => {
  it('checks the archive, then its attestation, before it unpacks anything, and touches only refs in the checkout', async () => {
    const update = updater(fixture);
    fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'waiting');

    const paths = selfUpdatePaths(fixture.home, 'v0.2.0');
    const names = releaseAssets('v0.2.0');
    const gh = fixture.calls.filter((call) => call.command === 'gh' && !call.args.includes('--help'));
    expect(gh.map((call) => call.args)).toEqual([
      [
        'attestation',
        'verify',
        join(paths.download, names.archive),
        '--bundle',
        join(paths.download, names.bundle),
        '--repo',
        REPO,
        '--cert-identity',
        `https://github.com/${REPO}/.github/workflows/release-build.yml@refs/heads/main`,
        '--source-ref',
        'refs/tags/v0.2.0',
        '--source-digest',
        fixture.release,
        '--deny-self-hosted-runners',
        '--predicate-type',
        'https://slsa.dev/provenance/v1',
        '--format',
        'json',
      ],
    ]);
    // The worktree is added only after the check, and is the release's commit with its output in it.
    const order = fixture.calls.map((call) => `${call.command} ${call.args[0]} ${call.args[1] ?? ''}`);
    expect(order.indexOf('gh attestation verify')).toBeLessThan(order.indexOf('git worktree add'));
    expect(git(paths.tree, 'rev-parse', 'HEAD')).toBe(fixture.release);
    expect(readFileSync(join(paths.tree, 'apps/bridge/dist/main.js'), 'utf8')).toContain('the release’s bridge');
    expect(fixture.calls.find((call) => call.command === 'pnpm')).toMatchObject({ args: ['install', '--frozen-lockfile'], cwd: paths.tree });

    // The checkout is where it was: same commit, nothing changed, no output written.
    expect(git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(fixture.first);
    expect(git(fixture.checkout, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(fixture.checkout, 'apps'))).toBe(false);
    for (const line of checkoutCommands()) expect(line).toMatch(READ_ONLY_IN_CHECKOUT);
  });

  it('waits for the running tasks, holding new work, and restarts once after two empty looks', async () => {
    fixture.alive.add(4242);
    const update = updater(fixture);
    fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'waiting');
    expect(update.restartPending()).toBe('OpenADLC restarts onto v0.2.0 once the running tasks end');
    expect(fixture.holds).toEqual(['OpenADLC restarts onto v0.2.0 once the running tasks end']);
    expect((await update.view()).running?.waitingFor).toEqual(fixture.live);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fixture.spawned).toEqual([]);

    // An engine update on hostd holds it too.
    fixture.live = [];
    fixture.engines = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fixture.spawned).toEqual([]);

    fixture.engines = false;
    await until(() => run()?.phase === 'restarting');
    const paths = selfUpdatePaths(fixture.home, 'v0.2.0');
    expect(fixture.spawned).toEqual([
      [
        join(paths.tree, 'apps/cli/dist/main.js'),
        'self-update',
        'apply',
        '--checkout',
        fixture.checkout,
        '--staging',
        paths.root,
        '--tag',
        'v0.2.0',
        '--from',
        fixture.first,
        '--to',
        fixture.release,
      ],
    ]);
    expect(run()?.pid).toBe(4242);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fixture.spawned).toHaveLength(1);
  });

  it('lets the hold go when the restart refuses before it stops anything', async () => {
    fixture.alive.add(4242);
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'restarting');
    mkdirSync(join(fixture.home, 'run'), { recursive: true });
    writeFileSync(
      selfUpdatePaths(fixture.home, 'v0.2.0').result,
      JSON.stringify({ format: 1, state: 'failed', tag: 'v0.2.0', from: fixture.first, to: fixture.first, step: 'preflight', reason: 'the checkout has changes of its own now; nothing was stopped', finishedAt: 't' }),
    );
    await until(() => last() !== null);
    expect(last()).toMatchObject({ state: 'failed', step: 'preflight', actor: 'jane@example.com' });
    expect(fixture.released).toBe(1);
    expect(update.restartPending()).toBeNull();
    await update.removing;
    expect(existsSync(selfUpdatePaths(fixture.home, 'v0.2.0').root)).toBe(false);
  });

  it('runs the release’s install with none of the bridge’s secrets', async () => {
    process.env.OPENADLC_WEBHOOK_SECRET = 'whsec-of-this-install';
    process.env.DATABASE_URL = `postgres://openadlc:${DB_PASSWORD}@127.0.0.1:47432/openadlc_db`;
    try {
      fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
      await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
      await until(() => run()?.phase === 'waiting');
      const install = fixture.calls.find((call) => call.command === 'pnpm');
      expect(install?.env?.PATH).toBe(process.env.PATH);
      expect(install?.env?.HOME).toBe(process.env.HOME);
      expect(install?.env).not.toHaveProperty('DATABASE_URL');
      expect(install?.env).not.toHaveProperty('OPENADLC_WEBHOOK_SECRET');
      expect(JSON.stringify(install?.env)).not.toContain(DB_PASSWORD);
    } finally {
      delete process.env.OPENADLC_WEBHOOK_SECRET;
      delete process.env.DATABASE_URL;
    }
  });

  it('writes the restart down before it starts it, so the bridge that comes up finds a restart', async () => {
    fixture.alive.add(4242);
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.pid === 4242);
    expect(fixture.spawnSees).toEqual([expect.objectContaining({ phase: 'restarting', pid: null })]);
  });

  it('counts hostd not answering as an engine update in flight, and does not restart under it', async () => {
    fixture.engineAnswers = false;
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'waiting');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fixture.spawned).toEqual([]);
    fixture.engineAnswers = true;
    fixture.alive.add(4242);
    await until(() => run()?.phase === 'restarting');
  });

  it('refuses a tag this checkout already has on another commit, rather than moving it', async () => {
    git(fixture.checkout, 'tag', 'v0.2.0', fixture.first);
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    expect(last()).toMatchObject({ state: 'failed', step: 'fetch', tag: 'v0.2.0' });
    expect(last()?.reason).toMatch(/the tag v0\.2\.0 on origin is not the commit this checkout has for it/);
    expect(git(fixture.checkout, 'rev-parse', 'refs/tags/v0.2.0')).toBe(fixture.first);
    expect(fixture.calls.some((call) => call.command === 'gh' && !call.args.includes('--help'))).toBe(false);
  });

  it('takes no release GitHub does not hold immutable', async () => {
    fixture.mutable = true;
    publish(fixture, 'v0.2.0', fixture.files.get('openadlc-v0.2.0.tar.gz')!);
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    expect(last()).toMatchObject({ state: 'current' });
    expect(last()?.reason).toMatch(/v0\.2\.0 is not an immutable release, so its files could still be replaced/);
    expect(fixture.calls.some((call) => call.args[0] === 'fetch')).toBe(false);
  });

  it('keeps no credential a command printed in the reason, the audit log or the card', async () => {
    fixture.pnpmFails = true;
    fixture.pnpmSays = `pnpm install exited 1: see ${SIGN_IN} and ${PAT}`;
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => last() !== null);
    const kept = JSON.stringify([fixture.settings.selfUpdateLast, fixture.audits]);
    expect(kept).not.toContain('deadbeefcafe');
    expect(kept).not.toContain(PAT);
    expect(last()?.reason).toContain('signin?token=[redacted]');
  });

  it('passes over a newest release that fails its check, takes the next, and says so', async () => {
    const tree = git(fixture.origin, 'rev-parse', `${fixture.release}^{tree}`);
    const newer = commit(fixture.origin, 'README.md', 'three\n', 'Third');
    git(fixture.origin, 'tag', 'v0.3.0', newer);
    const older = { archive: fixture.files.get('openadlc-v0.2.0.tar.gz')!, sums: fixture.files.get('SHA256SUMS')! };
    publish(fixture, 'v0.3.0', packRelease('v0.3.0', newer, git(fixture.origin, 'rev-parse', `${newer}^{tree}`)));
    const v3 = fixture.releases;
    fixture.files.set('openadlc-v0.2.0.tar.gz', older.archive);
    fixture.files.set('openadlc-v0.2.0.tar.gz.sigstore.json', Buffer.from('{}'));
    // Each release's own SHA256SUMS: the fake serves one file by name, so v0.2.0's is checked against its own line.
    const sums = `${older.sums.toString()}${fixture.files.get('SHA256SUMS')!.toString()}`;
    fixture.files.set('SHA256SUMS', Buffer.from(sums));
    fixture.releases = [...v3, { tag_name: 'v0.2.0', draft: false, prerelease: false, immutable: true, published_at: 'x', assets: Object.values(releaseAssets('v0.2.0')).map((name) => ({ name })) }];
    fixture.gh.failTags = ['v0.3.0'];
    fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'waiting');
    expect(run()).toMatchObject({ tag: 'v0.2.0', to: fixture.release });
    expect(tree).toBe(git(selfUpdatePaths(fixture.home, 'v0.2.0').tree, 'rev-parse', 'HEAD^{tree}'));
    expect(fixture.audits).toContainEqual(expect.objectContaining({ action: 'openadlc.release_refused', payload: expect.objectContaining({ tag: 'v0.3.0' }) }));
  });

  it('refuses an attestation whose run was not the tag’s push by release.yml', async () => {
    fixture.gh.trigger = 'workflow_dispatch';
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => last() !== null);
    expect(last()).toMatchObject({ state: 'failed', step: 'attestation' });
    expect(last()?.reason).toMatch(/started by workflow_dispatch, not by the push of v0\.2\.0, so openadlc-v0\.2\.0\.tar\.gz is not unpacked/);
  });

  it('lets the hold go and starts work again when the settings cannot be written as a run ends', async () => {
    fixture.alive.add(4242);
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'restarting');
    fixture.failWrite = 'selfUpdateLast';
    fixture.spawnFailed?.(new Error('spawn EMFILE'));
    await until(() => update.restartPending() === null);
    expect(fixture.released).toBe(1);
  });

  it('records a restart whose process could not start, and lets the hold go', async () => {
    fixture.alive.add(4242);
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'restarting');
    fixture.spawnFailed?.(new Error('spawn EAGAIN'));
    await until(() => last() !== null);
    expect(last()).toMatchObject({ state: 'failed', step: 'restart' });
    expect(last()?.reason).toMatch(/the restart could not start \(spawn EAGAIN\)/);
    expect(update.restartPending()).toBeNull();
    expect(fixture.released).toBe(1);
  });

  it('refuses Update now while one is in flight, naming it', async () => {
    const update = updater(fixture);
    fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'waiting');
    await expect(update.start({ trigger: 'console', actor: 'bob@example.com' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/an OpenADLC update to v0\.2\.0 is waiting for 1 task, started by jane@example\.com at 2026-10-21T10:00:00\.000Z/),
    });
  });

  it.each([
    ['its checksum', () => publish(fixture, 'v0.2.0', fixture.files.get('openadlc-v0.2.0.tar.gz')!, `${'0'.repeat(64)}  openadlc-v0.2.0.tar.gz\n`), 'checksum', /SHA256SUMS says 0000/],
    ['its attestation', () => (fixture.gh.verify = 'fail'), 'attestation', /refused openadlc-v0\.2\.0\.tar\.gz, so it is not unpacked: .*no attestation matched/],
    [
      'a manifest naming another commit',
      () => publish(fixture, 'v0.2.0', packRelease('v0.2.0', fixture.first, git(fixture.origin, 'rev-parse', `${fixture.first}^{tree}`))),
      'archive',
      /built from v0\.2\.0 at .* not v0\.2\.0 at/,
    ],
  ])('fails on %s, unpacks nothing, and leaves the install as it was', async (_what, spoil, step, reason) => {
    spoil();
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => last() !== null);
    await update.removing;
    expect(last()).toMatchObject({ state: 'failed', step, from: fixture.first, to: fixture.first, tag: 'v0.2.0' });
    expect(last()?.reason).toMatch(reason);
    expect(last()?.reason).toMatch(/The install is as it was$/);
    expect(fixture.calls.some((call) => call.command === 'git' && call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(false);
    expect(existsSync(selfUpdatePaths(fixture.home, 'v0.2.0').root)).toBe(false);
    expect(fixture.audits.at(-1)).toMatchObject({ action: 'openadlc.update_failed', payload: { outcome: 'failed', step, trigger: 'console', actor: 'jane@example.com' } });
    expect((await update.view()).attention?.kind).toBe('self-update-failed');
    expect(fixture.holds).toEqual([]);
    for (const line of checkoutCommands()) expect(line).toMatch(READ_ONLY_IN_CHECKOUT);
  });

  it('fails when the install in the worktree fails, removing the worktree and running nothing in the checkout', async () => {
    fixture.pnpmFails = true;
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => last() !== null);
    await update.removing;
    expect(last()).toMatchObject({ state: 'failed', step: 'install' });
    expect(existsSync(selfUpdatePaths(fixture.home, 'v0.2.0').tree)).toBe(false);
    expect(git(fixture.checkout, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(fixture.first);
    for (const line of checkoutCommands()) expect(line).toMatch(READ_ONLY_IN_CHECKOUT);
  });

  it('takes nothing when the checkout is on the newest release, or ahead of it', async () => {
    git(fixture.checkout, 'pull', '-q', '--ff-only', 'origin', 'main');
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    expect(last()).toMatchObject({ state: 'current', reason: 'on v0.2.0, the newest release' });
    expect(fixture.audits.at(-1)).toMatchObject({ action: 'openadlc.update_checked', payload: { outcome: 'current' } });
    expect(fixture.calls.some((call) => call.command === 'pnpm')).toBe(false);
  });

  it('refuses a tag that is not on main’s own history', async () => {
    git(fixture.origin, 'checkout', '-q', '-b', 'side', fixture.release);
    const side = commit(fixture.origin, 'side.md', 'side\n', 'Side');
    git(fixture.origin, 'checkout', '-q', 'main');
    git(fixture.origin, 'tag', 'v0.3.0', side);
    publish(fixture, 'v0.3.0', packRelease('v0.3.0', side, git(fixture.origin, 'rev-parse', `${side}^{tree}`)));
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    expect(last()).toMatchObject({ state: 'failed', step: 'tag', tag: 'v0.3.0' });
    expect(last()?.reason).toMatch(/not a commit of main's own history/);
    expect(fixture.calls.some((call) => call.command === 'gh' && !call.args.includes('--help'))).toBe(false);
  });
});

describe('an install it leaves alone', () => {
  it.each([
    ['has changes of its own', () => writeFileSync(join(fixture.checkout, 'README.md'), 'mine\n'), /has changes of its own \(1 file\), which an update never writes over/],
    ['is on another branch', () => git(fixture.checkout, 'checkout', '-q', '-b', 'mine'), /on mine, not main/],
    ['has no GitHub CLI that can check a release', () => (fixture.gh.help = '--bundle --repo'), /cannot check a release's attestation .*--source-digest/],
  ])('when the checkout %s: says why, records skipped, and adds no worktree', async (_what, change, reason) => {
    const update = updater(fixture);
    change();
    const view = await update.view();
    expect(view.applicable).toBe(false);
    expect(view.reason).toMatch(reason);
    await update.start({ trigger: 'schedule', actor: 'schedule' });
    expect(last()).toMatchObject({ state: 'skipped' });
    expect(fixture.audits.at(-1)).toMatchObject({ action: 'openadlc.update_checked', payload: { outcome: 'skipped', trigger: 'schedule' } });
    expect(fixture.calls.some((call) => call.args[0] === 'fetch' || call.args[0] === 'worktree')).toBe(false);
  });

  it('keeps a failure as the last result, and its card, through a run it skipped', async () => {
    fixture.settings.selfUpdateLast = JSON.stringify({ state: 'failed', trigger: 'schedule', actor: 'schedule', from: fixture.first, to: fixture.first, tag: 'v0.2.0', step: 'attestation', reason: 'refused', startedAt: 't0', finishedAt: 't1' });
    writeFileSync(join(fixture.checkout, 'README.md'), 'mine\n');
    const update = updater(fixture);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    expect(last()).toMatchObject({ state: 'failed', step: 'attestation' });
    expect(fixture.audits.at(-1)).toMatchObject({ action: 'openadlc.update_checked', payload: { outcome: 'skipped' } });
    expect((await update.view()).attention?.kind).toBe('self-update-failed');
  });

  it('when another install runs from the same checkout', async () => {
    fixture.others = [{ home: '/Users/me/OpenADLC/.scratch/home', record: '/Users/me/OpenADLC/.openadlc/installs/abc.json' }];
    const update = updater(fixture);
    expect((await update.view()).reason).toBe(
      `another install (/Users/me/OpenADLC/.scratch/home) runs from ${fixture.checkout} too, and an update would change the files under its running services: give each install its own clone, or stop it (OPENADLC_HOME=/Users/me/OpenADLC/.scratch/home openadlc down), or, if it is not running, delete /Users/me/OpenADLC/.openadlc/installs/abc.json`,
    );
    await update.start({ trigger: 'schedule', actor: 'schedule' });
    expect(last()).toMatchObject({ state: 'skipped' });
    expect(fixture.calls.some((call) => call.args[0] === 'fetch')).toBe(false);
  });

  it('when the checkout moved after the services started', async () => {
    const update = updater(fixture);
    await update.view();
    commit(fixture.checkout, 'local.md', 'local\n', 'Local');
    expect((await update.view()).reason).toMatch(/the services started on .*: run openadlc down && openadlc up/);
  });

  it('when it cannot fast-forward to the release', async () => {
    commit(fixture.checkout, 'local.md', 'local\n', 'Local');
    await updater(fixture).start({ trigger: 'console', actor: 'jane@example.com' });
    expect(last()).toMatchObject({ state: 'skipped' });
    expect(last()?.reason).toMatch(/cannot fast-forward from .* to v0\.2\.0/);
  });
});

describe('a bridge that restarts', () => {
  function persist(phase: SelfUpdateRun['phase'], pid: number | null = null): void {
    fixture.settings.selfUpdateRun = JSON.stringify({
      phase,
      tag: 'v0.2.0',
      from: fixture.first,
      to: fixture.release,
      trigger: 'console',
      actor: 'jane@example.com',
      startedAt: '2026-10-21T09:00:00.000Z',
      pid,
    } satisfies SelfUpdateRun);
  }

  it('records the restart’s result once, with who started the run', async () => {
    persist('restarting', 999);
    const paths = selfUpdatePaths(fixture.home, 'v0.2.0');
    mkdirSync(join(fixture.home, 'run'), { recursive: true });
    writeFileSync(
      paths.result,
      JSON.stringify({ format: 1, state: 'updated', tag: 'v0.2.0', from: fixture.first, to: fixture.release, reason: 'on v0.2.0', finishedAt: '2026-10-21T09:20:00.000Z' }),
    );
    const update = updater(fixture);
    expect(await update.resume()).toEqual(['recorded the OpenADLC update to v0.2.0']);
    expect(await update.resume()).toEqual([]);
    expect(last()).toMatchObject({ state: 'updated', trigger: 'console', actor: 'jane@example.com', from: fixture.first, to: fixture.release });
    expect(fixture.audits.filter((entry) => entry.action === 'openadlc.updated')).toHaveLength(1);
    expect(run()).toBeNull();
    expect(existsSync(paths.result)).toBe(false);
  });

  it('keeps the result file until the result is recorded', async () => {
    persist('restarting', 999);
    const paths = selfUpdatePaths(fixture.home, 'v0.2.0');
    mkdirSync(join(fixture.home, 'run'), { recursive: true });
    writeFileSync(
      paths.result,
      JSON.stringify({ format: 1, state: 'updated', tag: 'v0.2.0', from: fixture.first, to: fixture.release, reason: 'on v0.2.0', finishedAt: 't' }),
    );
    fixture.failWrite = 'selfUpdateLast';
    await expect(updater(fixture).resume()).rejects.toThrow(/database went away/);
    expect(existsSync(paths.result)).toBe(true);
    expect(await updater(fixture).resume()).toEqual(['recorded the OpenADLC update to v0.2.0']);
    expect(existsSync(paths.result)).toBe(false);
  });

  it('follows a restart still running until it leaves its result', async () => {
    persist('restarting', 4242);
    fixture.alive.add(4242);
    const update = updater(fixture);
    expect(await update.resume()).toEqual(['the OpenADLC restart onto v0.2.0 is still running (pid 4242)']);
    const paths = selfUpdatePaths(fixture.home, 'v0.2.0');
    mkdirSync(join(fixture.home, 'run'), { recursive: true });
    writeFileSync(
      paths.result,
      JSON.stringify({ format: 1, state: 'failed', tag: 'v0.2.0', from: fixture.first, to: fixture.first, step: 'install', reason: 'pnpm install failed', restoredTo: fixture.first, finishedAt: 't' }),
    );
    await until(() => last() !== null);
    expect(last()).toMatchObject({ state: 'failed', step: 'install', restoredTo: fixture.first });
  });

  it('fails a restart that ended with no result, and one that was being prepared', async () => {
    persist('restarting', 31337);
    await updater(fixture).resume();
    expect(last()).toMatchObject({ state: 'failed', step: 'restart' });
    expect(last()?.reason).toMatch(/self-update\.log/);

    persist('preparing');
    await updater(fixture).resume();
    expect(last()).toMatchObject({ state: 'failed', step: 'prepare' });
    expect(last()?.reason).toMatch(/the bridge restarted while it prepared v0\.2\.0/);
  });

  it('goes on waiting for a run that was prepared, holding new work again', async () => {
    persist('waiting');
    fixture.alive.add(4242);
    const paths = selfUpdatePaths(fixture.home, 'v0.2.0');
    mkdirSync(join(paths.tree, 'apps/cli/dist'), { recursive: true });
    writeFileSync(join(paths.tree, 'apps/cli/dist/main.js'), '');
    fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    const update = updater(fixture);
    expect(await update.resume()).toEqual(['the OpenADLC update to v0.2.0 goes on waiting for the running tasks']);
    await until(() => fixture.holds.length === 1);
    expect(update.restartPending()).toMatch(/restarts onto v0\.2\.0/);
    fixture.live = [];
    await until(() => run()?.phase === 'restarting');
    expect(readdirSync(paths.root)).toContain('tree');
  });
});

describe('the restart’s process', () => {
  it('is told from another program a reboot gave its pid, by its command line', () => {
    expect(isRestartProcess(4242, () => 'node /h/self-update/v0.2.0/tree/apps/cli/dist/main.js self-update apply --checkout /c')).toBe(true);
    expect(isRestartProcess(4242, () => '/usr/sbin/cupsd -l')).toBe(false);
    expect(isRestartProcess(4242, () => '')).toBe(false);
    expect(isRestartProcess(process.pid, () => null)).toBe(true);
  });
});

describe('the repository’s name', () => {
  it('is GitHub’s spelling, which the certificate carries, whatever case the remote has', async () => {
    fixture.fullName = 'Acme/OpenADLC';
    // The fake API and downloads answer under GitHub's spelling.
    const files = new Map(fixture.files);
    fixture.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    const update = new SelfUpdate({ ...(updater(fixture) as unknown as { deps: object }).deps, fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/acme/openadlc') return Response.json({ full_name: 'Acme/OpenADLC' });
      if (url === 'https://api.github.com/repos/Acme/OpenADLC/releases?per_page=30') return Response.json(fixture.releases);
      const download = /^https:\/\/github\.com\/Acme\/OpenADLC\/releases\/download\/([^/]+)\/(.+)$/.exec(url);
      const body = download ? files.get(decodeURIComponent(download[2]!)) : undefined;
      return body ? new Response(body) : new Response('not found', { status: 404 });
    }) as typeof fetch } as never);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => run()?.phase === 'waiting');
    const verify = fixture.calls.find((call) => call.command === 'gh' && !call.args.includes('--help'));
    expect(verify?.args).toContain('https://github.com/Acme/OpenADLC/.github/workflows/release-build.yml@refs/heads/main');
  });
});

describe('the routes', () => {
  it('serves the view, Update now and the schedule at /v1/self-update', async () => {
    const router = new Router();
    registerSelfUpdateRoutes(router, updater(fixture));
    const routes = (router as unknown as { routes: { method: string; path: string }[] }).routes;
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(['GET /v1/self-update', 'POST /v1/self-update', 'PATCH /v1/self-update', 'POST /v1/self-update/check']),
    );
  });
});
