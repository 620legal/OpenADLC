import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountCheck, EngineUpdateResult } from '@openadlc/shared';

vi.mock('@openadlc/db', () => ({
  bots: { getBotByName: vi.fn(), listBots: vi.fn(async () => []) },
  modelAccounts: { get: vi.fn(async () => null) },
}));

import {
  ANSWER_MAX,
  EngineUpdateRefused,
  EngineUpdater,
  ENGINES_LABEL,
  compareVersions,
  ghPackagesUrl,
  imageTags,
  newestOldEnough,
  newestGhVersion,
  newestNodeVersion,
  parseVersion,
  planUpdate,
  presentCredential,
  readEnginesLabel,
  runCommand,
  type CandidateCredential,
  type CommandResult,
  type CommandRunner,
  type CrewBot,
  type EngineUpdaterOptions,
} from './engine-updates.js';
import type { SessionModel } from './model-resolution.js';

/**
 * The weekly engine update against a Docker, an npm and a build script that
 * answer from memory. What is pinned is what the run decides and what it
 * leaves behind: which tag names which image afterwards, what was built with
 * which pins, and that a candidate that fails any check is gone while the
 * image in use is exactly as it was.
 */

const CLAUDE = '@anthropic-ai/claude-code';
const CODEX = '@openai/codex';
const GROK = '@xai-official/grok';

const PINS = { [CLAUDE]: '2.1.282', [CODEX]: '0.155.1', [GROK]: '1.0.41' };

/** The label as `build-bot-image.sh` stamped it on a real build, 2026-09-24. */
const LABEL_AS_BUILT = '{"@anthropic-ai/claude-code":"2.1.282","@openai/codex":"0.155.1","@xai-official/grok":"1.0.41"}';

const ANTHROPIC = '550e8400-e29b-41d4-a716-446655440000';
const OPENAI = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const KEY = 'sk-ant-api03-not-a-real-key-000000000000';

// ------------------------------------------------------------------ a fake world

interface Image {
  labels: Record<string, string> | null;
  /** What `claude --version` and the others print in it, per command. */
  says: Partial<Record<'claude' | 'codex' | 'grok' | 'node' | 'gh', string>>;
}

/** What each CLI prints for a version, measured in the bot image. */
function sayings(versions: Record<string, string | undefined>): Image['says'] {
  const says: Image['says'] = {};
  if (versions[CLAUDE]) says.claude = `${versions[CLAUDE]} (Claude Code)`;
  if (versions[CODEX]) says.codex = `codex-cli ${versions[CODEX]}`;
  if (versions[GROK]) says.grok = `grok ${versions[GROK]} (4220f3b224a6)`;
  if (versions.node) says.node = `v${versions.node}`;
  if (versions.gh) says.gh = `gh version ${versions.gh}`;
  return says;
}

class World {
  readonly images = new Map<string, Image>();
  readonly tags = new Map<string, string>();
  /** Image ids a container runs, which `docker image rm` refuses. */
  readonly running = new Set<string>();
  readonly calls: { command: string; args: string[]; env?: Record<string, string> }[] = [];
  npm: Record<string, string> = { ...PINS };
  nodeIndex = '[{"version":"v22.20.0"},{"version":"v22.19.0"}]';
  /** The gh apt repository's index, which lists only its newest package. */
  ghPackages = 'Package: gh\nVersion: 2.79.0\nArchitecture: amd64\nFilename: pool/main/g/gh/gh_2.79.0_amd64.deb\n';
  /** What nodejs.org or the gh index answers instead of `nodeIndex` and `ghPackages`. */
  fetchAnswers: Partial<Record<'node' | 'gh', (init?: RequestInit) => Promise<Response>>> = {};
  /** Every address fetched, in order. */
  readonly fetched: string[] = [];
  npmFails = false;
  /** What npm answers for a package instead of the answer made up from `npm` and `npmTimes`. */
  npmAnswers: Record<string, CommandResult> = {};
  /** When npm says each version was published; any version not named here is years old. */
  npmTimes: Record<string, Record<string, string>> = {};
  buildFails = false;
  /** A CLI the candidate is built without, or that says the wrong version. */
  breakCandidate: ((image: Image) => void) | null = null;
  private next = 1;

  image(versions: Record<string, string | undefined>, labelled = true): string {
    const id = `sha256:${String(this.next++).padStart(64, '0')}`;
    const label = JSON.stringify(Object.fromEntries(Object.entries(versions).filter(([, v]) => v)));
    this.images.set(id, { labels: labelled ? { [ENGINES_LABEL]: label } : null, says: sayings(versions) });
    return id;
  }

  private resolve(ref: string): string | null {
    if (this.images.has(ref)) return ref;
    return this.tags.get(ref) ?? null;
  }

  run = async (
    command: string,
    args: string[],
    options: { env?: Record<string, string> } = {},
  ): Promise<CommandResult> => {
    this.calls.push({ command, args, ...(options.env ? { env: options.env } : {}) });
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    const no = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

    // As in a release's service image, which purges curl once gh is installed.
    if (command === 'curl') return { code: 127, stdout: '', stderr: 'curl could not be started: spawn curl ENOENT\n' };

    if (command === 'npm') {
      if (this.npmFails) return { code: 1, stdout: '', stderr: 'npm error network request failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' };
      const pkg = args[1] ?? '';
      const answer = this.npmAnswers[pkg];
      if (answer) return answer;
      const latest = this.npm[pkg] ?? '';
      if (!args.includes('--json')) return ok(`${latest}\n`);
      const times = { created: '2019-01-01T00:00:00.000Z', modified: '2026-09-27T00:00:00.000Z', [latest]: '2020-01-01T00:00:00.000Z', ...this.npmTimes[pkg] };
      return ok(`${JSON.stringify({ 'dist-tags': { latest }, time: times })}\n`);
    }

    if (command === 'bash') {
      const env = options.env ?? {};
      if (this.buildFails) return { code: 1, stdout: 'building openadlc-bot:candidate\n', stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for @openai/codex@9.9.9.\n' };
      const pins: Record<string, string> = {};
      for (const spec of [env.CLAUDE_CLI, env.CODEX_CLI, env.GROK_CLI]) {
        const at = (spec ?? '').lastIndexOf('@');
        pins[(spec ?? '').slice(0, at)] = (spec ?? '').slice(at + 1);
      }
      if (env.NODE_VERSION) pins.node = env.NODE_VERSION;
      if (env.GH_VERSION) pins.gh = env.GH_VERSION;
      const id = this.image(pins);
      if (this.breakCandidate) this.breakCandidate(this.images.get(id) as Image);
      this.tags.set(env.IMAGE ?? '', id);
      return ok(`${env.IMAGE} is ready\n`);
    }

    if (command !== 'docker') return no(`${command}: not here`);
    const [verb, second] = args;

    if (verb === 'image' && second === 'inspect' && args[2] === '--format') {
      const id = this.resolve(args[4] ?? '');
      return id ? ok(`${id}\n`) : no(`Error: No such image: ${args[4]}`);
    }
    if (verb === 'image' && second === 'inspect') {
      const id = this.resolve(args[2] ?? '');
      if (!id) return no(`Error: No such image: ${args[2]}`);
      return ok(JSON.stringify([{ Id: id, Config: { Labels: this.images.get(id)?.labels ?? null } }]));
    }
    if (verb === 'image' && second === 'rm') {
      const ref = args[2] ?? '';
      if (this.tags.has(ref)) {
        const id = this.tags.get(ref) as string;
        this.tags.delete(ref);
        if (![...this.tags.values()].includes(id) && !this.running.has(id)) this.images.delete(id);
        return ok(`Untagged: ${ref}\n`);
      }
      if (!this.images.has(ref)) return no(`Error: No such image: ${ref}`);
      if ([...this.tags.values()].includes(ref)) return no('conflict: unable to delete (must be forced) - image is referenced in multiple repositories');
      if (this.running.has(ref)) return no('conflict: unable to delete (cannot be forced) - image is being used by running container');
      this.images.delete(ref);
      return ok(`Deleted: ${ref}\n`);
    }
    if (verb === 'tag') {
      const id = this.resolve(args[1] ?? '');
      if (!id) return no(`Error response from daemon: No such image: ${args[1]}`);
      this.tags.set(args[2] ?? '', id);
      return ok();
    }
    if (verb === 'rm') return ok();
    if (verb === 'run') {
      const image = args[args.indexOf('/usr/bin/env') + 1] ?? '';
      const found = this.images.get(this.resolve(image) ?? '');
      if (!found) return no(`Unable to find image '${image}' locally`);
      const lines = (['claude', 'codex', 'grok', 'node', 'gh'] as const).map((cli) => {
        const said = found.says[cli];
        return `${cli}\t${said ? `/home/bot/.local/bin/${cli}` : ''}\t${said ? `${said} ` : ''}`;
      });
      return ok(`${lines.join('\n')}\n`);
    }
    return no(`docker ${args.join(' ')}: not faked`);
  };

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.fetched.push(url);
    if (url === 'https://nodejs.org/dist/index.json') return (await this.fetchAnswers.node?.(init)) ?? new Response(`${this.nodeIndex}\n`);
    if (url.startsWith('https://cli.github.com/packages/dists/stable/main/binary-')) {
      return (await this.fetchAnswers.gh?.(init)) ?? new Response(`${this.ghPackages}\n`);
    }
    return new Response(`${url}: not faked`, { status: 404 });
  };

  /** Every docker call that changes which image a tag names. */
  retags(): string[][] {
    return this.calls.filter((call) => call.command === 'docker' && call.args[0] === 'tag').map((call) => call.args);
  }
}

const bot = (partial: Partial<CrewBot> = {}): CrewBot => ({
  name: 'openadlc-atlas-janedoe',
  engine: 'claude',
  model: 'newest:opus',
  modelAccountId: ANTHROPIC,
  sidecarDb: false,
  ...partial,
});

const ACCOUNTS: Record<string, { id: string; provider: 'anthropic' | 'openai' | 'xai'; kind: 'key' | 'subscription'; label: string }> = {
  [ANTHROPIC]: { id: ANTHROPIC, provider: 'anthropic', kind: 'subscription', label: 'Anthropic Max' },
  [OPENAI]: { id: OPENAI, provider: 'openai', kind: 'key', label: 'OpenAI API key' },
};

/** What a task would resolve: `newest:opus` is claude-opus-5-5 today; a pinned id is itself. */
function resolveAsTask(crewBot: CrewBot): SessionModel {
  const account = crewBot.modelAccountId ? ACCOUNTS[crewBot.modelAccountId] : null;
  const model = crewBot.model === 'newest:opus' ? 'claude-opus-5-5' : crewBot.model === 'newest:codex' ? 'gpt-5.5-codex' : crewBot.model;
  return {
    model,
    modelAlias: crewBot.model.startsWith('newest:') ? crewBot.model : null,
    account: account ? { id: account.id, provider: account.provider, kind: account.kind } : null,
  };
}

let scratch: string;
let script: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'openadlc-engine-updates-'));
  mkdirSync(join(scratch, 'infra/local'), { recursive: true });
  script = join(scratch, 'infra/local/build-bot-image.sh');
  writeFileSync(script, '#!/usr/bin/env bash\n');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function updater(
  world: World,
  { crew, answer, ...options }: Partial<Omit<EngineUpdaterOptions, 'crew'>> & {
    crew?: CrewBot[];
    answer?: (model: string) => AccountCheck;
  } = {},
) {
  const calls: { model: string; image: string; name: string; env: Record<string, string>; secret: string | null }[] = [];
  const refresh = vi.fn(async () => ({ refreshed: ['openadlc-atlas-janedoe'], deferred: ['openadlc-cipher-janedoe'] }));
  let clock = Date.parse('2026-09-27T15:00:00.000Z');
  const service = new EngineUpdater({
    driver: 'docker',
    image: 'openadlc-bot:latest',
    buildScript: script,
    run: world.run,
    fetch: world.fetch,
    crew: async () => crew ?? [bot()],
    account: async (id) => ACCOUNTS[id] ?? null,
    chooseModelFor: () => async (crewBot) => resolveAsTask(crewBot),
    credential: async (): Promise<CandidateCredential> => ({
      presented: { env: { CLAUDE_CODE_OAUTH_TOKEN: KEY }, mount: null, secret: KEY },
    }),
    callModel: async (call) => {
      calls.push({ model: call.model, image: call.image, name: call.name, env: call.env ?? {}, secret: call.credential.secret });
      return answer?.(call.model) ?? { ok: true, message: 'answered: OK', checkedAt: '2026-09-27T15:01:00.000Z' };
    },
    refresh,
    now: () => new Date((clock += 1000)),
    log: () => undefined,
    ...options,
  });
  return { service, calls, refresh };
}

/** A host whose `openadlc-bot:latest` carries today's pins, as the build script labels them. */
function pinnedHost(): { world: World; latest: string } {
  const world = new World();
  const latest = world.image(PINS);
  world.tags.set('openadlc-bot:latest', latest);
  return { world, latest };
}

// ------------------------------------------------------------------ versions

describe('reading a version', () => {
  it('finds it in what each CLI prints for --version, and in what npm prints', () => {
    expect(parseVersion('2.1.282 (Claude Code)')).toBe('2.1.282');
    expect(parseVersion('codex-cli 0.155.1')).toBe('0.155.1');
    expect(parseVersion('grok 1.0.41 (4220f3b224a6)')).toBe('1.0.41');
    expect(parseVersion('0.156.1\n')).toBe('0.156.1');
    expect(parseVersion('command not found')).toBeNull();
  });

  it('orders versions as semver does, not as text', () => {
    expect(compareVersions('2.1.290', '2.1.282')).toBeGreaterThan(0);
    // As text, "0.99.0" sorts after "0.155.1".
    expect(compareVersions('0.99.0', '0.155.1')).toBeLessThan(0);
    expect(compareVersions('1.0.41', '1.0.41')).toBe(0);
    expect(compareVersions('2.2.0-beta.1', '2.2.0')).toBeLessThan(0);
    expect(compareVersions('2.2.0-beta.2', '2.2.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('2.2.0-alpha', '2.2.0-beta')).toBeLessThan(0);
  });

  it('reads the label the build script stamps, and nothing that is not one', () => {
    expect(readEnginesLabel({ [ENGINES_LABEL]: LABEL_AS_BUILT })).toEqual(PINS);
    expect(readEnginesLabel({ [ENGINES_LABEL]: JSON.stringify({ ...PINS, node: '22.14.0', gh: '2.67.0' }) })).toEqual({
      ...PINS,
      node: '22.14.0',
      gh: '2.67.0',
    });
    expect(readEnginesLabel(null)).toBeNull();
    expect(readEnginesLabel({ [ENGINES_LABEL]: 'not json' })).toBeNull();
    expect(readEnginesLabel({ [ENGINES_LABEL]: '{"@openai/codex":"latest"}' })).toBeNull();
  });

  it('reads the newest Node and gh from the indexes those projects publish', () => {
    expect(newestNodeVersion('[{"version":"v22.20.0","lts":"Jod"},{"version":"v23.0.0-rc.1"}]')).toBe('22.20.0');
    // Current is first. An image on 22 stays on 22: Node 25 has no corepack.
    expect(
      newestNodeVersion('[{"version":"v25.1.0","lts":false},{"version":"v22.21.0","lts":"Jod"}]', '22.14.0'),
    ).toBe('22.21.0');
    expect(newestNodeVersion('[{"version":"v25.1.0","lts":false},{"version":"v22.21.0","lts":"Jod"}]')).toBe('22.21.0');
    expect(newestNodeVersion('not json')).toBeNull();
    // What cli.github.com/packages/dists/stable/main/binary-amd64/Packages said on 2026-09-30.
    expect(
      newestGhVersion(
        'Package: gh\nVersion: 2.102.0\nArchitecture: amd64\nDepends: git\nFilename: pool/main/g/gh/gh_2.102.0_amd64.deb\n',
      ),
    ).toBe('2.102.0');
    expect(newestGhVersion('Package: gh\nVersion: 2.79.0\n\nPackage: gh\nVersion: 2.80.1\n\nPackage: other\nVersion: 9.0.0\n')).toBe('2.80.1');
    expect(newestGhVersion('Package: gh\nVersion: latest\n')).toBeNull();
    expect(newestGhVersion('')).toBeNull();
    expect(ghPackagesUrl('x64')).toBe('https://cli.github.com/packages/dists/stable/main/binary-amd64/Packages');
    expect(ghPackagesUrl('arm64')).toBe('https://cli.github.com/packages/dists/stable/main/binary-arm64/Packages');
  });
});

describe('which tags an update moves', () => {
  it('is the latest tag of the image the bots run, and the candidate and previous beside it', () => {
    expect(imageTags('openadlc-bot:latest')).toEqual({
      latest: 'openadlc-bot:latest',
      candidate: 'openadlc-bot:candidate',
      previous: 'openadlc-bot:previous',
    });
    expect(imageTags('scratch-eng-bot')?.candidate).toBe('scratch-eng-bot:candidate');
    expect(imageTags('registry.local:5000/openadlc/bot:latest')?.previous).toBe('registry.local:5000/openadlc/bot:previous');
  });

  it('is nothing for an image pinned to another tag or a digest, which is built somewhere else', () => {
    expect(imageTags('eu-docker.pkg.dev/p/openadlc/bot:2026-09-21')).toBeNull();
    expect(imageTags('openadlc-bot@sha256:abc')).toBeNull();
  });
});

describe('the update decision', () => {
  it('takes nothing when npm has nothing newer', () => {
    expect(planUpdate(PINS, PINS)).toMatchObject({ newer: false, targets: PINS, changes: [] });
  });

  it('takes a newer version and pins the rest where they are', () => {
    const plan = planUpdate(PINS, { ...PINS, [CODEX]: '0.156.1' });
    expect(plan.newer).toBe(true);
    expect(plan.targets).toEqual({ ...PINS, [CODEX]: '0.156.1' });
    expect(plan.changes).toEqual([{ pkg: CODEX, from: '0.155.1', to: '0.156.1' }]);
  });

  it('never goes backwards to an older latest', () => {
    // An image pinned ahead of npm's `latest` — a `next` release somebody chose.
    const plan = planUpdate({ ...PINS, [CLAUDE]: '2.1.290' }, PINS);
    expect(plan).toMatchObject({ newer: false, targets: { ...PINS, [CLAUDE]: '2.1.290' } });
  });

  it('takes the newest when the version in use could not be told', () => {
    expect(planUpdate({ ...PINS, [GROK]: null }, PINS).changes).toEqual([{ pkg: GROK, from: null, to: '1.0.41' }]);
  });

  it('reports a pin and does not take the newer version', () => {
    const plan = planUpdate(PINS, { ...PINS, [CODEX]: '0.156.1' }, {}, { only: [CODEX], pins: { [CODEX]: '0.155.1' } });
    expect(plan.newer).toBe(false);
    expect(plan.pinned).toEqual([{ pkg: CODEX, installed: '0.155.1', latest: '0.156.1' }]);
    expect(plan.targets[CODEX]).toBe('0.155.1');
  });

  it('takes a newer Node and leaves the engines at the versions in use', () => {
    const plan = planUpdate({ ...PINS, node: '22.14.0' }, { ...PINS, node: '22.20.0', [CODEX]: '0.156.1' }, {}, { only: ['node'] });
    expect(plan.changes).toEqual([{ pkg: 'node', from: '22.14.0', to: '22.20.0' }]);
    expect(plan.targets[CODEX]).toBe(PINS[CODEX]);
  });

  it('does not take Node when the image does not say which Node it has', () => {
    const plan = planUpdate(PINS, { ...PINS, node: '22.20.0' }, {}, { only: ['node', CODEX] });
    expect(plan.changes).toEqual([]);
    expect(plan.targets.node).toBeUndefined();
  });

  it('does not take again the version a rollback undid, and takes the one after it', () => {
    const held = { [CLAUDE]: '2.1.290' };
    expect(planUpdate(PINS, { ...PINS, [CLAUDE]: '2.1.290' }, held)).toMatchObject({
      newer: false,
      held: [{ pkg: CLAUDE, version: '2.1.290' }],
    });
    expect(planUpdate(PINS, { ...PINS, [CLAUDE]: '2.1.291' }, held).targets[CLAUDE]).toBe('2.1.291');
  });
});

// ------------------------------------------------------------------ a run

describe('a run with nothing newer', () => {
  it('is current, builds nothing and moves no tag', async () => {
    const { world, latest } = pinnedHost();
    const { service, calls, refresh } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result).toMatchObject({ state: 'current', from: PINS, to: null, latest: PINS, checks: [] });
    expect(result.reason).toBe('every engine is already the newest version');
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
    expect(world.retags()).toEqual([]);
    expect(world.tags.get('openadlc-bot:latest')).toBe(latest);
    expect(calls).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says what it checked when it was for Node alone, not that every engine is the newest', async () => {
    const { world } = pinnedHost();
    const id = world.tags.get('openadlc-bot:latest') as string;
    const image = world.images.get(id) as Image;
    image.labels = { [ENGINES_LABEL]: JSON.stringify({ ...PINS, node: '22.20.0' }) };
    image.says = { ...image.says, node: 'v22.20.0' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', only: ['node'] });

    expect(result).toMatchObject({ state: 'current', reason: 'node is already the newest version' });
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
  });
});

describe('how old a release must be before a run takes it', () => {
  const NOW = new Date('2026-10-04T12:00:00.000Z');
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  it('takes the newest release old enough, never a prerelease or one newer than latest', () => {
    const times = {
      created: daysAgo(400),
      modified: daysAgo(0),
      '1.0.40': daysAgo(30),
      '1.0.41': daysAgo(5),
      '1.0.42-beta.1': daysAgo(10),
      '1.0.42': daysAgo(1),
      '1.1.0': daysAgo(20),
    };
    // 1.1.0 is older than three days but npm's latest is 1.0.42: a version
    // ahead of latest is somebody else's channel.
    expect(newestOldEnough(times, '1.0.42', 3, NOW)).toBe('1.0.41');
    expect(newestOldEnough(times, '1.0.42', 7, NOW)).toBe('1.0.40');
    expect(newestOldEnough(times, '1.0.42', 60, NOW)).toBeNull();
  });

  it('takes latest itself at a minimum of 0, as the update did before', () => {
    expect(newestOldEnough({}, '1.0.42', 0, NOW)).toBe('1.0.42');
  });
});

describe('a run with a release younger than the minimum age', () => {
  it('builds the older patch when the newest was published a day ago and the older five days ago', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.2';
    world.npmTimes[CODEX] = { '0.156.1': '2026-09-22T15:00:00.000Z', '0.156.2': '2026-09-26T15:00:00.000Z' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', minReleaseAgeDays: 3 });

    expect(result.state).toBe('updated');
    expect(world.calls.find((call) => call.command === 'bash')?.env).toMatchObject({ CODEX_CLI: '@openai/codex@0.156.1' });
    // What npm calls newest is still recorded, for Settings to show.
    expect(result.latest?.[CODEX]).toBe('0.156.2');
    expect(world.calls).toContainEqual(expect.objectContaining({ command: 'npm', args: ['view', CODEX, 'dist-tags', 'time', '--json'] }));
  });

  it('is current when nothing newer is old enough, and says which version is out and when it is taken', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    world.npmTimes[CODEX] = { '0.156.1': '2026-09-26T15:00:00.000Z' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', minReleaseAgeDays: 3 });

    expect(result.state).toBe('current');
    expect(result.reason).toBe('nothing old enough to take: codex 0.156.1 was published 2026-09-26, and is taken once it is 3 days old (2026-09-29)');
    expect(result.latest?.[CODEX]).toBe('0.156.1');
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
  });

  it('takes it at once with a minimum of 0', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    world.npmTimes[CODEX] = { '0.156.1': '2026-09-27T14:00:00.000Z' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', minReleaseAgeDays: 0 });

    expect(result.state).toBe('updated');
    expect(world.calls.find((call) => call.command === 'bash')?.env).toMatchObject({ CODEX_CLI: '@openai/codex@0.156.1' });
  });

  it('leaves it where it is, rather than taking the newest unchecked, when npm does not say when it was published', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    world.npmTimes[CODEX] = { '0.156.1': 'not a date' };
    world.npm[CLAUDE] = '2.1.290';
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('updated');
    expect(world.calls.find((call) => call.command === 'bash')?.env).toMatchObject({
      CLAUDE_CLI: '@anthropic-ai/claude-code@2.1.290',
      CODEX_CLI: '@openai/codex@0.155.1',
    });
    expect(result.unchecked).toEqual({
      [CODEX]: 'could not read when npm published @openai/codex 0.156.1, so it is not taken without its minimum release age',
    });
    expect(result.reason).toContain('codex was not checked: could not read when npm published @openai/codex 0.156.1');
  });
});

describe('a run with a newer engine', () => {
  it('builds a candidate pinned to the newer version and the rest as they were', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    await service.updateAndWait({ trigger: 'schedule' });

    const build = world.calls.find((call) => call.command === 'bash');
    expect(build?.args).toEqual([script]);
    expect(build?.env).toMatchObject({
      CLAUDE_CLI: '@anthropic-ai/claude-code@2.1.282',
      CODEX_CLI: '@openai/codex@0.156.1',
      GROK_CLI: '@xai-official/grok@1.0.41',
      IMAGE: 'openadlc-bot:candidate',
    });
    expect(build?.env).not.toHaveProperty('BUILD_PROXY');
  });

  it('takes no pin from hostd’s own environment, which a node:* image fills with its NODE_VERSION', async () => {
    // hostd's service image is FROM node:22, which exports NODE_VERSION; the
    // build read it as a pin the running image never said it was on.
    vi.stubEnv('NODE_VERSION', '22.23.3');
    vi.stubEnv('GH_VERSION', '2.1.0');
    vi.stubEnv('GH_FROM', 'some-other-image');
    vi.stubEnv('BUILD_PROXY', 'http://elsewhere:3128');
    try {
      const { world } = pinnedHost();
      world.npm[CODEX] = '0.156.1';
      const { service } = updater(world);

      await service.updateAndWait({ trigger: 'schedule' });

      const build = world.calls.find((call) => call.command === 'bash');
      for (const name of ['NODE_VERSION', 'GH_VERSION', 'GH_FROM', 'BUILD_PROXY']) expect(build?.env).not.toHaveProperty(name);
      // The rest of hostd's environment still reaches the script: it needs PATH and the docker client's.
      expect(build?.env?.PATH).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('builds a candidate that moves Node and leaves the engine pins where they are', async () => {
    const { world } = pinnedHost();
    const id = world.tags.get('openadlc-bot:latest') as string;
    const image = world.images.get(id) as Image;
    image.labels = { [ENGINES_LABEL]: JSON.stringify({ ...PINS, node: '22.14.0' }) };
    image.says = { ...image.says, node: 'v22.14.0' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', only: ['node'] });

    expect(result.state).toBe('updated');
    const build = world.calls.find((call) => call.command === 'bash');
    expect(build?.env).toMatchObject({
      CLAUDE_CLI: '@anthropic-ai/claude-code@2.1.282',
      CODEX_CLI: '@openai/codex@0.155.1',
      GROK_CLI: '@xai-official/grok@1.0.41',
      NODE_VERSION: '22.20.0',
      IMAGE: 'openadlc-bot:candidate',
    });
    expect(build?.env).not.toHaveProperty('GH_VERSION');
  });

  it('keeps the running image’s gh and Node in a Claude Code-only candidate built through the proxy', async () => {
    // The cloud path: every step leaves through the egress proxy, which does
    // not allow the github.com release downloads redirect to. A candidate
    // that is not moving gh copies the running image's instead of fetching it.
    const { world } = pinnedHost();
    const id = world.tags.get('openadlc-bot:latest') as string;
    const image = world.images.get(id) as Image;
    image.labels = { [ENGINES_LABEL]: JSON.stringify({ ...PINS, node: '22.14.0', gh: '2.67.0' }) };
    image.says = { ...image.says, node: 'v22.14.0', gh: 'gh version 2.67.0 (2025-02-11)' };
    world.npm[CLAUDE] = '2.1.290';
    const { service } = updater(world, { buildProxy: 'http://host.docker.internal:3128' });

    const result = await service.updateAndWait({ trigger: 'console', only: [CLAUDE] });

    expect(result.state).toBe('updated');
    const build = world.calls.find((call) => call.command === 'bash');
    expect(build?.env).toMatchObject({
      CLAUDE_CLI: '@anthropic-ai/claude-code@2.1.290',
      CODEX_CLI: '@openai/codex@0.155.1',
      GROK_CLI: '@xai-official/grok@1.0.41',
      NODE_VERSION: '22.14.0',
      GH_VERSION: '2.67.0',
      GH_FROM: 'openadlc-bot:latest',
      BUILD_PROXY: 'http://host.docker.internal:3128',
      IMAGE: 'openadlc-bot:candidate',
    });
    // Nothing asked where gh or Node could come from: neither is moving.
    expect(world.fetched).toEqual([]);
    expect(result.to).toMatchObject({ gh: '2.67.0', node: '22.14.0', [CLAUDE]: '2.1.290' });
  });

  it('installs a newer gh from its apt repository, at the version that repository lists', async () => {
    const { world } = pinnedHost();
    const id = world.tags.get('openadlc-bot:latest') as string;
    const image = world.images.get(id) as Image;
    image.labels = { [ENGINES_LABEL]: JSON.stringify({ ...PINS, node: '22.14.0', gh: '2.67.0' }) };
    image.says = { ...image.says, node: 'v22.14.0', gh: 'gh version 2.67.0 (2025-02-11)' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'console', only: ['gh'] });

    expect(result.state).toBe('updated');
    expect(world.fetched).toEqual([ghPackagesUrl()]);
    const build = world.calls.find((call) => call.command === 'bash');
    expect(build?.env).toMatchObject({ GH_VERSION: '2.79.0', NODE_VERSION: '22.14.0' });
    expect(build?.env).not.toHaveProperty('GH_FROM');
  });

  it('reports a pinned engine and builds nothing', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', only: [CODEX], pins: { [CODEX]: '0.155.1' } });

    expect(result.state).toBe('current');
    expect(result.reason).toContain('codex is pinned at 0.155.1; newest is 0.156.1');
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
  });

  it('builds through the bots’ proxy on a host that has one, or its steps are refused at the firewall', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world, { buildProxy: 'http://host.docker.internal:3128' });

    await service.updateAndWait({ trigger: 'schedule' });

    const build = world.calls.find((call) => call.command === 'bash');
    expect(build?.env).toMatchObject({ BUILD_PROXY: 'http://host.docker.internal:3128', IMAGE: 'openadlc-bot:candidate' });
  });

  it('checks each CLI where a session looks for it: env -i, the session PATH, and the image’s entrypoint replaced', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    const probe = world.calls.find(
      (call) => call.command === 'docker' && call.args[0] === 'run' && call.args.includes('openadlc-engines-versions-candidate'),
    );
    // The image's entrypoint is `tini -- bot-init`, which ignores a command.
    expect(probe?.args.slice(0, 7)).toEqual([
      'run',
      '--rm',
      '--name',
      'openadlc-engines-versions-candidate',
      '--entrypoint',
      '/usr/bin/env',
      'openadlc-bot:candidate',
    ]);
    expect(probe?.args).toContain('-i');
    expect(probe?.args).toContain(
      'PATH=/opt/openadlc/bin:/home/bot/.local/share/pnpm:/home/bot/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
    expect(result.checks.filter((check) => check.kind === 'cli')).toEqual([
      { kind: 'cli', cli: 'claude', state: 'passed', detail: 'claude 2.1.282 at /home/bot/.local/bin/claude' },
      { kind: 'cli', cli: 'codex', state: 'passed', detail: 'codex 0.156.1 at /home/bot/.local/bin/codex' },
      { kind: 'cli', cli: 'grok', state: 'passed', detail: 'grok 1.0.41 at /home/bot/.local/bin/grok' },
    ]);
  });

  it('calls each distinct engine, account and model the crew uses once, from the candidate, as a session would', async () => {
    const { world } = pinnedHost();
    world.npm[CLAUDE] = '2.1.290';
    const crew = [
      bot({ name: 'openadlc-atlas-janedoe' }),
      // The same account and the same model: one call stands for both.
      bot({ name: 'openadlc-lead-janedoe', model: 'claude-opus-5-5' }),
      bot({ name: 'openadlc-cipher-janedoe', engine: 'codex', model: 'newest:codex', modelAccountId: OPENAI }),
      // The automation account thinks with nothing.
      bot({ name: 'automation', engine: 'none', model: 'none', modelAccountId: null }),
    ];
    const { service, calls } = updater(world, { crew });

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(calls.map((call) => ({ model: call.model, image: call.image }))).toEqual([
      { model: 'claude-opus-5-5', image: 'openadlc-bot:candidate' },
      { model: 'gpt-5.5-codex', image: 'openadlc-bot:candidate' },
    ]);
    // What a session has before its credential.
    expect(calls[0]?.env).toMatchObject({ HOME: '/home/bot', USER: 'bot' });
    expect(result.checks.filter((check) => check.kind === 'model')).toEqual([
      {
        kind: 'model',
        cli: 'claude',
        state: 'passed',
        model: 'claude-opus-5-5',
        configured: ['newest:opus', 'claude-opus-5-5'],
        account: { id: ANTHROPIC, label: 'Anthropic Max', provider: 'anthropic', kind: 'subscription' },
        bots: ['openadlc-atlas-janedoe', 'openadlc-lead-janedoe'],
        detail: 'claude-opus-5-5 (newest:opus, claude-opus-5-5) on Anthropic Max: answered: OK',
      },
      expect.objectContaining({
        cli: 'codex',
        state: 'passed',
        configured: ['newest:codex'],
        account: expect.objectContaining({ label: 'OpenAI API key' }),
      }),
    ]);
  });

  it('keeps the image in use as previous, makes the candidate latest, and drops what previous held before', async () => {
    const { world, latest } = pinnedHost();
    const older = world.image({ ...PINS, [CODEX]: '0.154.0' });
    world.tags.set('openadlc-bot:previous', older);
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    await service.updateAndWait({ trigger: 'schedule' });

    const now = world.tags.get('openadlc-bot:latest') as string;
    expect(now).not.toBe(latest);
    expect(readEnginesLabel(world.images.get(now)?.labels)).toEqual({ ...PINS, [CODEX]: '0.156.1' });
    expect(world.tags.get('openadlc-bot:previous')).toBe(latest);
    expect(world.tags.has('openadlc-bot:candidate')).toBe(false);
    // Two images are kept, not one a week.
    expect(world.images.has(older)).toBe(false);
  });

  it('moves the idle bots now, and says which wait for their next task', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service, refresh } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: 'updated',
      from: PINS,
      to: { ...PINS, [CODEX]: '0.156.1' },
      latest: { ...PINS, [CODEX]: '0.156.1' },
      reason: 'codex 0.155.1 → 0.156.1',
      refreshed: ['openadlc-atlas-janedoe'],
      deferred: ['openadlc-cipher-janedoe'],
    });
  });

  it('leaves a previous image that something still runs where it is', async () => {
    const { world } = pinnedHost();
    const older = world.image({ ...PINS, [CODEX]: '0.154.0' });
    world.tags.set('openadlc-bot:previous', older);
    world.running.add(older);
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('updated');
    expect(world.images.has(older)).toBe(true);
  });
});

describe('a candidate that fails a check', () => {
  it('is discarded when a model refuses the call, with the model, the account and the CLI’s words', async () => {
    const { world, latest } = pinnedHost();
    world.npm[CLAUDE] = '2.1.290';
    const { service, refresh } = updater(world, {
      answer: () => ({ ok: false, message: 'Invalid API key · Fix external API key', checkedAt: '2026-09-27T15:01:00.000Z' }),
    });

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('failed');
    expect(result.reason).toBe('claude-opus-5-5 (newest:opus) on Anthropic Max: Invalid API key · Fix external API key');
    expect(result.to).toEqual({ ...PINS, [CLAUDE]: '2.1.290' });
    // The image in use is exactly as it was, and the candidate is gone.
    expect(world.retags()).toEqual([]);
    expect(world.tags.get('openadlc-bot:latest')).toBe(latest);
    expect(world.tags.has('openadlc-bot:candidate')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('is discarded when a CLI is not on a session’s PATH, and no model is called from it', async () => {
    const { world, latest } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    world.breakCandidate = (image) => delete image.says.codex;
    const { service, calls } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^codex is not on the PATH a session gets in the candidate/);
    expect(calls).toEqual([]);
    expect(world.tags.get('openadlc-bot:latest')).toBe(latest);
    expect(world.tags.has('openadlc-bot:candidate')).toBe(false);
  });

  it('is discarded when a CLI says another version than the one it was built with', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    world.breakCandidate = (image) => void (image.says.codex = 'codex-cli 0.155.1');
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.reason).toBe('codex in the candidate says "codex-cli 0.155.1", not 0.156.1');
  });

  it('is never tagged when it did not build, and says what the build said', async () => {
    const { world, latest } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    world.buildFails = true;
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^the candidate did not build: .*No matching version found/s);
    expect(world.tags.get('openadlc-bot:latest')).toBe(latest);
  });

  it('fails when a bot’s model cannot be told, as a task on it would', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world, {
      chooseModelFor: () => async () => {
        throw new Error('nothing listed what subscription account x can call, so newest:grok cannot be resolved');
      },
    });

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^could not tell which model openadlc-atlas-janedoe would call: nothing listed/);
  });

  it('never carries the credential it called with', async () => {
    const { world } = pinnedHost();
    world.npm[CLAUDE] = '2.1.290';
    const { service, calls } = updater(world, {
      answer: () => ({ ok: false, message: 'Failed to authenticate. API Error: 401', checkedAt: 'x' }),
    });

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(calls[0]?.secret).toBe(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('what a check cannot ask', () => {
  it('skips a bot with no credential at all, which no image would let think, and still updates', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service, calls } = updater(world, {
      credential: async () => ({ skip: 'no credential is stored for it' }),
    });

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('updated');
    expect(calls).toEqual([]);
    expect(result.checks.at(-1)).toMatchObject({
      kind: 'model',
      state: 'skipped',
      detail: 'claude-opus-5-5 (newest:opus) on Anthropic Max: not called — no credential is stored for it',
    });
  });
});

describe('asking while a run is going', () => {
  it('joins the run rather than starting a second', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    const first = service.update({ trigger: 'schedule' });
    const second = service.update({ trigger: 'console', requestedBy: 'ada' });

    expect(first).toMatchObject({ running: true, joined: false });
    expect(second).toMatchObject({ running: true, joined: true, startedAt: first.startedAt });
    expect((await service.status()).running).toEqual({ startedAt: first.startedAt, trigger: 'schedule' });

    const result = await service.updateAndWait({ trigger: 'console' });
    expect(result.startedAt).toBe(first.startedAt);
    expect(world.calls.filter((call) => call.command === 'bash')).toHaveLength(1);
    expect((await service.status()).last).toEqual(result);
  });
});

describe('where there is nothing to update', () => {
  it('is not applicable under the local driver, and runs nothing', async () => {
    const world = new World();
    const { service } = updater(world, { driver: 'local' });

    const started = service.update({ trigger: 'schedule' });

    expect(started).toMatchObject({
      running: false,
      last: { state: 'skipped', reason: 'not applicable: the local driver runs the host’s own CLIs' },
    });
    expect(world.calls).toEqual([]);
  });

  it('is skipped for an image pinned to a tag this install does not build', async () => {
    const { service } = updater(new World(), { image: 'eu-docker.pkg.dev/p/openadlc/bot:2026-09-21' });
    expect(service.update({ trigger: 'schedule' }).last?.reason).toMatch(/pinned to a tag this install does not build/);
  });

  it('is skipped where the build script is not, as in a hostd image', async () => {
    const { service } = updater(new World(), { buildScript: join(scratch, 'nowhere.sh') });
    expect(service.update({ trigger: 'schedule' }).last?.reason).toMatch(/cannot build the bot image/);
  });

  it('fails, touching nothing, when npm cannot be asked', async () => {
    const { world, latest } = pinnedHost();
    world.npmFails = true;
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^could not ask npm which @anthropic-ai\/claude-code is newest: .*ENOTFOUND/s);
    // Each tool's row says its own.
    expect(Object.keys(result.unchecked ?? {})).toEqual([CLAUDE, CODEX, GROK]);
    expect(result.unchecked?.[GROK]).toMatch(/^could not ask npm which @xai-official\/grok is newest: .*ENOTFOUND/s);
    expect(world.tags.get('openadlc-bot:latest')).toBe(latest);
  });

  it('is current, saying so, when the only newer version is one a rollback undid', async () => {
    const { world } = pinnedHost();
    world.npm[CLAUDE] = '2.1.290';
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', hold: { [CLAUDE]: '2.1.290' } });

    expect(result).toMatchObject({ state: 'current', reason: 'nothing newer to take: claude-code 2.1.290 is held back after a rollback' });
  });
});

// ------------------------------------------------------------------ lookups

/**
 * npm's answer about @openai/codex in the shape it had on 2026-10-22, when it
 * was 337 KB: `dist-tags` first, then a publish time for each version, most
 * of them per-platform alphas.
 */
function codexAnswer(latest: string, published: string): string {
  const platforms = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
  const time: Record<string, string> = { created: '2025-04-16T00:00:00.000Z', modified: '2026-10-22T02:11:09.000Z' };
  for (let minor = 100; minor < 160; minor += 1) {
    for (let alpha = 1; alpha <= 18; alpha += 1) {
      for (const platform of platforms) time[`0.${minor}.0-alpha.${alpha}-${platform}`] = '2026-01-01T00:00:00.000Z';
    }
  }
  time[latest] = published;
  const tags = { latest, beta: '0.1.2505172116', 'release-0.159.0-alpha.12-linux-x64': '0.159.0-alpha.12-linux-x64' };
  return `${JSON.stringify({ 'dist-tags': tags, time }, null, 2)}\n`;
}

/** What hostd kept of that answer: its last 256 KB, which start in the middle of `time`. */
const CODEX_TAIL =
  '-alpha.12-linux-x64": "2026-10-21T19:04:11.000Z",\n  "0.159.0-alpha.12-darwin-arm64": "2026-10-21T19:04:12.000Z",\n  "modified": "2026-10-22T02:11:09.000Z"\n }\n}\n';

describe('what a command’s output keeps', () => {
  const print = (script: string, options: Parameters<CommandRunner>[2] = {}) => runCommand(process.execPath, ['-e', script], options);

  it('is the end of a log, and the whole of an answer from its start, cut only past ANSWER_MAX', async () => {
    const log = await print('process.stdout.write("x".repeat(300 * 1024) + "END")');
    expect(log.stdout).toHaveLength(256 * 1024);
    expect(log.stdout.endsWith('END')).toBe(true);

    const answer = await print('process.stdout.write("START" + "x".repeat(300 * 1024))', { answer: true });
    expect(answer.stdout).toHaveLength(5 + 300 * 1024);
    expect(answer.stdout.startsWith('START')).toBe(true);
    expect(answer.cut).toBeUndefined();

    // A command that would go on printing, or hang, past the cut is stopped there, not at its timeout.
    const started = Date.now();
    const huge = await print(`process.stdout.write("START" + "x".repeat(${ANSWER_MAX + 1024 * 1024})); setInterval(() => {}, 1000)`, {
      answer: true,
      timeoutMs: 60_000,
    });
    expect(huge.cut).toBe(true);
    expect(huge.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(huge.stdout.startsWith('START')).toBe(true);
    expect(huge.stdout).toHaveLength(ANSWER_MAX);
  });
});

describe('a tool’s newest version', () => {
  it('is read however long npm’s answer is: past 256 KB, dist-tags first, as Codex’s was on 2026-10-22', async () => {
    const { world } = pinnedHost();
    const answer = codexAnswer('0.156.1', '2026-09-20T00:00:00.000Z');
    expect(Buffer.byteLength(answer)).toBeGreaterThan(256 * 1024);
    const file = join(scratch, 'codex.json');
    writeFileSync(file, answer);
    // npm, as far as hostd can tell: a process whose stdout is that answer, read by the real runner.
    const run: CommandRunner = (command, args, options) =>
      command === 'npm' && args[1] === CODEX
        ? runCommand(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', file], options)
        : world.run(command, args, options);
    const { service } = updater(world, { run });

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('updated');
    expect(result.latest?.[CODEX]).toBe('0.156.1');
    expect(result.unchecked).toBeUndefined();
    expect(world.calls.find((call) => call.command === 'bash')?.env).toMatchObject({ CODEX_CLI: '@openai/codex@0.156.1' });
  });

  it('stays at the version in use when it cannot be read, while the others update, and the run says so', async () => {
    const { world } = pinnedHost();
    world.npm[CLAUDE] = '2.1.290';
    world.npmAnswers[CODEX] = { code: 0, stdout: CODEX_TAIL, stderr: '' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('updated');
    expect(world.calls.find((call) => call.command === 'bash')?.env).toMatchObject({
      CLAUDE_CLI: '@anthropic-ai/claude-code@2.1.290',
      CODEX_CLI: '@openai/codex@0.155.1',
      GROK_CLI: '@xai-official/grok@1.0.41',
    });
    expect(result.to).toEqual({ ...PINS, [CLAUDE]: '2.1.290' });
    expect(result.latest).toEqual({ [CLAUDE]: '2.1.290', [GROK]: '1.0.41' });
    expect(Object.keys(result.unchecked ?? {})).toEqual([CODEX]);
    const why = result.unchecked?.[CODEX] ?? '';
    expect(why).toMatch(/^could not read npm's answer about @openai\/codex \(\d+ bytes\) as JSON: /);
    expect(result.reason).toBe(`claude-code 2.1.282 → 2.1.290; codex was not checked: ${why}`);
    expect(world.tags.has('openadlc-bot:candidate')).toBe(false);
  });

  it('leaves the run current when nothing else is newer, saying it was not checked', async () => {
    const { world, latest } = pinnedHost();
    world.npmAnswers[CODEX] = { code: 0, stdout: CODEX_TAIL, stderr: '' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('current');
    expect(result.reason).toBe(`claude-code, grok are already the newest version; codex was not checked: ${result.unchecked?.[CODEX]}`);
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
    expect(world.tags.get('openadlc-bot:latest')).toBe(latest);
  });

  it('builds nothing when the image does not say which version it has either, since no candidate could keep it', async () => {
    // The build script would stop on `@openai/codex@` ("is not pinned to a
    // version"); the run stops before building, and says which and why.
    const world = new World();
    const id = world.image(PINS, false);
    delete (world.images.get(id) as Image).says.codex;
    world.tags.set('openadlc-bot:latest', id);
    world.npm[CLAUDE] = '2.1.290';
    world.npmAnswers[CODEX] = { code: 0, stdout: CODEX_TAIL, stderr: '' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^nothing was built: the image does not say which codex it has, /);
    expect(result.reason).toContain(`codex was not checked: ${result.unchecked?.[CODEX]}`);
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
  });

  it('that cannot be read says which tool, which source and how big the answer was, and never what it said', async () => {
    const answers: { only: string[]; set: (world: World) => void; says: RegExp; never: string[] }[] = [
      {
        only: [CODEX],
        set: (world) => void (world.npmAnswers[CODEX] = { code: 0, stdout: CODEX_TAIL, stderr: '' }),
        says: /^could not read npm's answer about @openai\/codex \(\d+ bytes\) as JSON: No number after minus sign in JSON at position 1\b/,
        never: ['2026-10-21', 'modified', 'alpha'],
      },
      {
        // npm --json prints its error as JSON on stdout, beside its words on stderr.
        only: [CODEX],
        set: (world) =>
          void (world.npmAnswers[CODEX] = {
            code: 1,
            stdout: JSON.stringify({
              error: {
                code: 'E404',
                summary: 'Not Found - GET https://registry.npmjs.org/@openai%2fcodex - Not found',
                detail: "The requested resource '@openai/codex@*' could not be found or you do not have permission to access it.",
              },
            }),
            stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@openai%2fcodex - Not found\n',
          }),
        says: /^could not ask npm which @openai\/codex is newest: Not Found - GET https:\/\/registry\.npmjs\.org\/@openai%2fcodex - Not found$/,
        never: ['requested resource', 'E404'],
      },
      {
        // A captive portal or a proxy's refusal, answered with 200.
        only: ['node'],
        set: (world) => void (world.nodeIndex = '<!doctype html><html><body>{"blocked": "nodejs.org"}</body></html>'),
        says: /^could not read nodejs\.org's index of Node releases \(\d+ bytes\) as JSON: Unexpected token '<'$/,
        never: ['doctype', 'blocked', 'body'],
      },
      {
        only: ['gh'],
        set: (world) => void (world.ghPackages = '{"message": "Not Found", "documentation_url": "https://docs.github.com"}'),
        says: /^the GitHub CLI's apt repository's package index \(\d+ bytes\) lists no gh package$/,
        never: ['message', 'documentation_url'],
      },
    ];

    for (const answer of answers) {
      const { world } = pinnedHost();
      answer.set(world);
      const { service } = updater(world);

      const result = await service.updateAndWait({ trigger: 'console', only: answer.only });

      expect(result.state).toBe('failed');
      expect(result.reason).toMatch(answer.says);
      expect(result.reason).not.toMatch(/[{}"]/);
      for (const words of answer.never) expect(result.reason).not.toContain(words);
    }
  });

  it('that ran past ANSWER_MAX is not read at all, though its start might parse, and the stopped command is not blamed', async () => {
    // What the runner hands back once it has stopped a command at the cut:
    // the start of the answer, and the exit code of a killed process.
    const { world } = pinnedHost();
    world.npmAnswers[CODEX] = { code: 1, stdout: codexAnswer('0.156.1', '2026-09-20T00:00:00.000Z'), stderr: '', cut: true };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'console', only: [CODEX] });

    expect(result).toMatchObject({ state: 'failed', reason: "could not read npm's answer about @openai/codex: it is over the 8 MB hostd reads" });
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
  });
});

/** A host whose image says which Node and gh it has, so a lookup of either can move it. */
function toolHost(): World {
  const { world } = pinnedHost();
  const image = world.images.get(world.tags.get('openadlc-bot:latest') as string) as Image;
  image.labels = { [ENGINES_LABEL]: JSON.stringify({ ...PINS, node: '22.14.0', gh: '2.67.0' }) };
  image.says = { ...image.says, node: 'v22.14.0', gh: 'gh version 2.67.0 (2025-02-11)' };
  return world;
}

describe('asking nodejs.org and the GitHub CLI’s apt repository', () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const lookups = [
    {
      tool: 'node' as const,
      host: 'nodejs.org',
      start: '[{"version":"v22.20.0","lts":"Jod"},',
      pin: { NODE_VERSION: '22.20.0' },
      asks: 'could not ask nodejs.org which Node is newest',
      what: "nodejs.org's index of Node releases",
    },
    {
      // A Packages index is read line by line: its start alone names a gh to install.
      tool: 'gh' as const,
      host: 'cli.github.com',
      start: 'Package: gh\nVersion: 2.79.0\nArchitecture: amd64\n',
      pin: { GH_VERSION: '2.79.0' },
      asks: "could not ask the GitHub CLI's apt repository which gh is newest",
      what: "the GitHub CLI's apt repository's package index",
    },
  ];

  /** A failed lookup fails the run that asked only for it, with the lookup's reason, and builds nothing. */
  async function failsWith(world: World, tool: 'node' | 'gh', reason: string, options: Pick<EngineUpdaterOptions, 'lookupTimeoutMs'> = {}) {
    const { service } = updater(world, options);
    const result = await service.updateAndWait({ trigger: 'console', only: [tool] });
    expect(result).toMatchObject({ state: 'failed', reason });
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
  }

  it.each(lookups)('asks for $tool with Node’s own fetch, within 60 s, and never spawns curl, which a release’s service image does not have', async ({ tool, pin }) => {
    const world = toolHost();
    let given: RequestInit | undefined;
    world.fetchAnswers[tool] = async (init?: RequestInit) => ((given = init), new Response(tool === 'node' ? world.nodeIndex : world.ghPackages));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'console', only: [tool] });

    const timeouts = timeout.mock.calls.map(([ms]) => ms);
    timeout.mockRestore();
    expect(result.state).toBe('updated');
    expect(world.calls.filter((call) => call.command === 'curl')).toEqual([]);
    expect(world.fetched).toEqual([tool === 'node' ? 'https://nodejs.org/dist/index.json' : ghPackagesUrl()]);
    expect(given?.signal).toBeInstanceOf(AbortSignal);
    expect(timeouts).toEqual([60_000]);
    expect(world.calls.find((call) => call.command === 'bash')?.env).toMatchObject(pin);
  });

  it.each(lookups)('says the status when $host answers with a failure', async ({ tool, asks }) => {
    const world = toolHost();
    world.fetchAnswers[tool] = async () => new Response('<html><body>Service Unavailable</body></html>', { status: 503 });
    await failsWith(world, tool, `${asks}: HTTP 503`);
  });

  it.each(lookups)('says what went wrong when $host cannot be reached, not just that fetch failed', async ({ tool, host, asks }) => {
    const unknown = toolHost();
    unknown.fetchAnswers[tool] = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }) });
    };
    await failsWith(unknown, tool, `${asks}: fetch failed: getaddrinfo ENOTFOUND ${host}`);

    // What Node 25's fetch threw when a proxy refused the CONNECT, as the egress proxy refuses a host not on its list.
    const refused = toolHost();
    refused.fetchAnswers[tool] = async () => {
      const tunnel = Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' });
      throw new TypeError('fetch failed', { cause: Object.assign(new DOMException('Request was cancelled.'), { cause: tunnel }) });
    };
    await failsWith(refused, tool, `${asks}: fetch failed: Proxy response (403) !== 200 when HTTP Tunneling`);
  });

  it.each(lookups)('stops reading $host past ANSWER_MAX, though its start might parse', async ({ tool, start, what }) => {
    const world = toolHost();
    let pulled = 0;
    let cancelled = false;
    // An answer that never ends: the run finishing at all is the cap holding.
    world.fetchAnswers[tool] = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(encode(start)),
          pull: (controller) => void ((pulled += 1), controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20))),
          cancel: () => void (cancelled = true),
        }),
      );
    await failsWith(world, tool, `could not read ${what}: it is over the 8 MB hostd reads`);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(ANSWER_MAX / (1024 * 1024) + 2);
  });

  it.each(lookups)('gives up on $host at the timeout, before it answers and while its answer is still arriving', async ({ tool, host, start, asks }) => {
    const late = `${asks}: ${host} did not answer within 0.05 s`;
    const silent = toolHost();
    silent.fetchAnswers[tool] = (init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    await failsWith(silent, tool, late, { lookupTimeoutMs: 50 });

    const stalled = toolHost();
    stalled.fetchAnswers[tool] = async (init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(encode(start));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
      );
    await failsWith(stalled, tool, late, { lookupTimeoutMs: 50 });
  });
});

describe('the versions in use', () => {
  it('are read from the label without starting a container when the label names every tool', async () => {
    const world = new World();
    const versions = { ...PINS, node: '22.14.0', gh: '2.67.0' };
    world.tags.set('openadlc-bot:latest', world.image(versions));
    const { service } = updater(world);

    const status = await service.status();

    expect(status).toMatchObject({ applicable: true, image: 'openadlc-bot:latest', inUse: versions, inUseSource: 'label', previous: null });
    expect(world.calls.some((call) => call.args[0] === 'run')).toBe(false);
  });

  it('asks once for Node and gh when the label is from before they were stamped', async () => {
    const { world } = pinnedHost();
    const id = world.tags.get('openadlc-bot:latest') as string;
    const image = world.images.get(id) as Image;
    image.says = { ...image.says, node: 'v22.14.0', gh: 'gh version 2.67.0' };
    const { service } = updater(world);

    const first = await service.status();
    await service.status();

    expect(first.inUse).toEqual({ ...PINS, node: '22.14.0', gh: '2.67.0' });
    const probes = world.calls.filter((call) => call.args[0] === 'run');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.args).toContain('openadlc-engines-versions-in-use');
  });

  it('are asked of the CLIs themselves in an image built before the label, once per image', async () => {
    const world = new World();
    world.tags.set('openadlc-bot:latest', world.image(PINS, false));
    const { service } = updater(world);

    const first = await service.status();
    await service.status();

    expect(first).toMatchObject({ inUse: PINS, inUseSource: 'cli' });
    const probes = world.calls.filter((call) => call.args[0] === 'run');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.args).toContain('openadlc-engines-versions-in-use');
  });
});

describe('rolling back', () => {
  async function updated(): Promise<{ world: World; before: string; after: string; service: EngineUpdater; refresh: ReturnType<typeof vi.fn> }> {
    const { world, latest } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service, refresh } = updater(world);
    await service.updateAndWait({ trigger: 'schedule' });
    return { world, before: latest, after: world.tags.get('openadlc-bot:latest') as string, service, refresh };
  }

  it('puts the previous image back as latest and keeps the one it replaced as previous', async () => {
    const { world, before, after, service, refresh } = await updated();

    const result = await service.rollback('ada');

    expect(world.tags.get('openadlc-bot:latest')).toBe(before);
    expect(world.tags.get('openadlc-bot:previous')).toBe(after);
    expect(result).toMatchObject({
      state: 'rolled-back',
      trigger: 'rollback',
      requestedBy: 'ada',
      from: { ...PINS, [CODEX]: '0.156.1' },
      to: PINS,
      reason: 'codex 0.156.1 → 0.155.1',
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect((await service.status()).last).toEqual(result);
  });

  it('is undone by rolling back again', async () => {
    const { world, after, service } = await updated();
    await service.rollback();
    await service.rollback();
    expect(world.tags.get('openadlc-bot:latest')).toBe(after);
  });

  it('refuses when there is nothing to go back to', async () => {
    const { world } = pinnedHost();
    const { service } = updater(world);
    await expect(service.rollback()).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/no openadlc-bot:previous/) });
  });

  it('refuses while an update is running', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);
    service.update({ trigger: 'schedule' });
    await expect(service.rollback()).rejects.toBeInstanceOf(EngineUpdateRefused);
  });
});

// ------------------------------------------------------------------ credentials

describe('the credential a candidate is called with', () => {
  let loginRoot: string;
  beforeEach(() => {
    loginRoot = join(scratch, 'logins');
  });

  it('is a key, passed by value in the environment and never named on a command line, as session-env gives it', () => {
    const presented = presentCredential(
      { source: 'account', kind: 'key', envVar: 'OPENAI_API_KEY', key: 'sk-proj-x', login: null, accountId: OPENAI },
      loginRoot,
    );
    expect(presented).toEqual({
      presented: { env: { OPENAI_API_KEY: 'sk-proj-x', CODEX_API_KEY: 'sk-proj-x' }, mount: null, secret: 'sk-proj-x' },
    });
  });

  it('is a signed-in subscription’s login directory, mounted where a bot has it', () => {
    mkdirSync(join(loginRoot, OPENAI, 'sign-in'), { recursive: true });
    writeFileSync(join(loginRoot, OPENAI, 'sign-in', 'auth.json'), '{}');
    const presented = presentCredential(
      {
        source: 'account',
        kind: 'subscription',
        envVar: null,
        key: null,
        login: { envVar: 'CODEX_HOME', path: '/openadlc/login' },
        accountId: OPENAI,
      },
      loginRoot,
    );
    expect(presented).toEqual({
      presented: { env: { CODEX_HOME: '/openadlc/login' }, mount: join(loginRoot, OPENAI), secret: null },
    });
  });

  it('is nothing to call with for a subscription that is not signed in, or a bot with nothing stored', () => {
    const login = { source: 'account' as const, kind: 'subscription' as const, envVar: null, key: null, accountId: OPENAI };
    expect(presentCredential({ ...login, login: { envVar: 'CODEX_HOME', path: '/openadlc/login' } }, loginRoot)).toEqual({
      skip: 'the subscription is not signed in',
    });
    expect(
      presentCredential({ source: 'fallback', kind: null, envVar: null, key: null, login: null, accountId: null }, loginRoot),
    ).toEqual({ skip: 'no credential is stored for it' });
  });

  it('is refused for a bot whose own key is another provider’s, as its task is', () => {
    expect(
      presentCredential(
        { source: 'fallback', kind: null, envVar: null, key: null, login: null, accountId: null, foreignKey: 'openai' },
        loginRoot,
      ),
    ).toEqual({ refuse: 'its own key is an OpenAI key, so a task on it refuses to start' });
  });
});

// Keeps the fixture honest: a result is what the shared type says it is.
export type _Result = EngineUpdateResult;
