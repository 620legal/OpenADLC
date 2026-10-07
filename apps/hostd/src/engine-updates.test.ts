import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountCheck, EngineUpdateResult } from '@fleetadlc/shared';

vi.mock('@fleetadlc/db', () => ({
  bots: { getBotByName: vi.fn(), listBots: vi.fn(async () => []) },
  modelAccounts: { get: vi.fn(async () => null) },
}));

import {
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
  type CandidateCredential,
  type CommandResult,
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
  npmFails = false;
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

    if (command === 'curl') {
      const url = args.at(-1) ?? '';
      if (url.includes('nodejs.org')) return ok(`${this.nodeIndex}\n`);
      if (url.startsWith('https://cli.github.com/packages/dists/stable/main/binary-')) return ok(`${this.ghPackages}\n`);
      return no(`curl ${url}: not faked`);
    }

    if (command === 'npm') {
      if (this.npmFails) return { code: 1, stdout: '', stderr: 'npm error network request failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' };
      const pkg = args[1] ?? '';
      const latest = this.npm[pkg] ?? '';
      if (!args.includes('--json')) return ok(`${latest}\n`);
      const times = { created: '2019-01-01T00:00:00.000Z', modified: '2026-09-27T00:00:00.000Z', [latest]: '2020-01-01T00:00:00.000Z', ...this.npmTimes[pkg] };
      return ok(`${JSON.stringify({ 'dist-tags': { latest }, time: times })}\n`);
    }

    if (command === 'bash') {
      const env = options.env ?? {};
      if (this.buildFails) return { code: 1, stdout: 'building fleetadlc-bot:candidate\n', stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for @openai/codex@9.9.9.\n' };
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

  /** Every docker call that changes which image a tag names. */
  retags(): string[][] {
    return this.calls.filter((call) => call.command === 'docker' && call.args[0] === 'tag').map((call) => call.args);
  }
}

const bot = (partial: Partial<CrewBot> = {}): CrewBot => ({
  name: 'fleetadlc-atlas-janedoe',
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
  scratch = mkdtempSync(join(tmpdir(), 'fleetadlc-engine-updates-'));
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
  const refresh = vi.fn(async () => ({ refreshed: ['fleetadlc-atlas-janedoe'], deferred: ['fleetadlc-cipher-janedoe'] }));
  let clock = Date.parse('2026-09-27T15:00:00.000Z');
  const service = new EngineUpdater({
    driver: 'docker',
    image: 'fleetadlc-bot:latest',
    buildScript: script,
    run: world.run,
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

/** A host whose `fleetadlc-bot:latest` carries today's pins, as the build script labels them. */
function pinnedHost(): { world: World; latest: string } {
  const world = new World();
  const latest = world.image(PINS);
  world.tags.set('fleetadlc-bot:latest', latest);
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
    expect(imageTags('fleetadlc-bot:latest')).toEqual({
      latest: 'fleetadlc-bot:latest',
      candidate: 'fleetadlc-bot:candidate',
      previous: 'fleetadlc-bot:previous',
    });
    expect(imageTags('scratch-eng-bot')?.candidate).toBe('scratch-eng-bot:candidate');
    expect(imageTags('registry.local:5000/fleetadlc/bot:latest')?.previous).toBe('registry.local:5000/fleetadlc/bot:previous');
  });

  it('is nothing for an image pinned to another tag or a digest, which is built somewhere else', () => {
    expect(imageTags('eu-docker.pkg.dev/p/fleetadlc/bot:2026-09-21')).toBeNull();
    expect(imageTags('fleetadlc-bot@sha256:abc')).toBeNull();
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
    expect(world.tags.get('fleetadlc-bot:latest')).toBe(latest);
    expect(calls).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says what it checked when it was for Node alone, not that every engine is the newest', async () => {
    const { world } = pinnedHost();
    const id = world.tags.get('fleetadlc-bot:latest') as string;
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

  it('fails, rather than taking the newest unchecked, when npm does not say when it was published', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    world.npmTimes[CODEX] = { '0.156.1': 'not a date' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(result.state).toBe('failed');
    expect(result.reason).toContain('could not read when npm published @openai/codex 0.156.1');
    expect(world.calls.some((call) => call.command === 'bash')).toBe(false);
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
      IMAGE: 'fleetadlc-bot:candidate',
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
    const id = world.tags.get('fleetadlc-bot:latest') as string;
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
      IMAGE: 'fleetadlc-bot:candidate',
    });
    expect(build?.env).not.toHaveProperty('GH_VERSION');
  });

  it('keeps the running image’s gh and Node in a Claude Code-only candidate built through the proxy', async () => {
    // The cloud path: every step leaves through the egress proxy, which does
    // not allow the github.com release downloads redirect to. A candidate
    // that is not moving gh copies the running image's instead of fetching it.
    const { world } = pinnedHost();
    const id = world.tags.get('fleetadlc-bot:latest') as string;
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
      GH_FROM: 'fleetadlc-bot:latest',
      BUILD_PROXY: 'http://host.docker.internal:3128',
      IMAGE: 'fleetadlc-bot:candidate',
    });
    // Nothing asked where gh or Node could come from: neither is moving.
    expect(world.calls.filter((call) => call.command === 'curl')).toEqual([]);
    expect(result.to).toMatchObject({ gh: '2.67.0', node: '22.14.0', [CLAUDE]: '2.1.290' });
  });

  it('installs a newer gh from its apt repository, at the version that repository lists', async () => {
    const { world } = pinnedHost();
    const id = world.tags.get('fleetadlc-bot:latest') as string;
    const image = world.images.get(id) as Image;
    image.labels = { [ENGINES_LABEL]: JSON.stringify({ ...PINS, node: '22.14.0', gh: '2.67.0' }) };
    image.says = { ...image.says, node: 'v22.14.0', gh: 'gh version 2.67.0 (2025-02-11)' };
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'console', only: ['gh'] });

    expect(result.state).toBe('updated');
    const asked = world.calls.filter((call) => call.command === 'curl').map((call) => call.args.at(-1));
    expect(asked).toEqual([ghPackagesUrl()]);
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
    expect(build?.env).toMatchObject({ BUILD_PROXY: 'http://host.docker.internal:3128', IMAGE: 'fleetadlc-bot:candidate' });
  });

  it('checks each CLI where a session looks for it: env -i, the session PATH, and the image’s entrypoint replaced', async () => {
    const { world } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule' });

    const probe = world.calls.find(
      (call) => call.command === 'docker' && call.args[0] === 'run' && call.args.includes('fleetadlc-engines-versions-candidate'),
    );
    // The image's entrypoint is `tini -- bot-init`, which ignores a command.
    expect(probe?.args.slice(0, 7)).toEqual([
      'run',
      '--rm',
      '--name',
      'fleetadlc-engines-versions-candidate',
      '--entrypoint',
      '/usr/bin/env',
      'fleetadlc-bot:candidate',
    ]);
    expect(probe?.args).toContain('-i');
    expect(probe?.args).toContain(
      'PATH=/opt/fleetadlc/bin:/home/bot/.local/share/pnpm:/home/bot/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
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
      bot({ name: 'fleetadlc-atlas-janedoe' }),
      // The same account and the same model: one call stands for both.
      bot({ name: 'fleetadlc-lead-janedoe', model: 'claude-opus-5-5' }),
      bot({ name: 'fleetadlc-cipher-janedoe', engine: 'codex', model: 'newest:codex', modelAccountId: OPENAI }),
      // The automation account thinks with nothing.
      bot({ name: 'automation', engine: 'none', model: 'none', modelAccountId: null }),
    ];
    const { service, calls } = updater(world, { crew });

    const result = await service.updateAndWait({ trigger: 'schedule' });

    expect(calls.map((call) => ({ model: call.model, image: call.image }))).toEqual([
      { model: 'claude-opus-5-5', image: 'fleetadlc-bot:candidate' },
      { model: 'gpt-5.5-codex', image: 'fleetadlc-bot:candidate' },
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
        bots: ['fleetadlc-atlas-janedoe', 'fleetadlc-lead-janedoe'],
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
    world.tags.set('fleetadlc-bot:previous', older);
    world.npm[CODEX] = '0.156.1';
    const { service } = updater(world);

    await service.updateAndWait({ trigger: 'schedule' });

    const now = world.tags.get('fleetadlc-bot:latest') as string;
    expect(now).not.toBe(latest);
    expect(readEnginesLabel(world.images.get(now)?.labels)).toEqual({ ...PINS, [CODEX]: '0.156.1' });
    expect(world.tags.get('fleetadlc-bot:previous')).toBe(latest);
    expect(world.tags.has('fleetadlc-bot:candidate')).toBe(false);
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
      refreshed: ['fleetadlc-atlas-janedoe'],
      deferred: ['fleetadlc-cipher-janedoe'],
    });
  });

  it('leaves a previous image that something still runs where it is', async () => {
    const { world } = pinnedHost();
    const older = world.image({ ...PINS, [CODEX]: '0.154.0' });
    world.tags.set('fleetadlc-bot:previous', older);
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
    expect(world.tags.get('fleetadlc-bot:latest')).toBe(latest);
    expect(world.tags.has('fleetadlc-bot:candidate')).toBe(false);
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
    expect(world.tags.get('fleetadlc-bot:latest')).toBe(latest);
    expect(world.tags.has('fleetadlc-bot:candidate')).toBe(false);
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
    expect(world.tags.get('fleetadlc-bot:latest')).toBe(latest);
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
    expect(result.reason).toMatch(/^could not tell which model fleetadlc-atlas-janedoe would call: nothing listed/);
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
    const { service } = updater(new World(), { image: 'eu-docker.pkg.dev/p/fleetadlc/bot:2026-09-21' });
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
    expect(world.tags.get('fleetadlc-bot:latest')).toBe(latest);
  });

  it('is current, saying so, when the only newer version is one a rollback undid', async () => {
    const { world } = pinnedHost();
    world.npm[CLAUDE] = '2.1.290';
    const { service } = updater(world);

    const result = await service.updateAndWait({ trigger: 'schedule', hold: { [CLAUDE]: '2.1.290' } });

    expect(result).toMatchObject({ state: 'current', reason: 'nothing newer to take: claude-code 2.1.290 is held back after a rollback' });
  });
});

describe('the versions in use', () => {
  it('are read from the label without starting a container when the label names every tool', async () => {
    const world = new World();
    const versions = { ...PINS, node: '22.14.0', gh: '2.67.0' };
    world.tags.set('fleetadlc-bot:latest', world.image(versions));
    const { service } = updater(world);

    const status = await service.status();

    expect(status).toMatchObject({ applicable: true, image: 'fleetadlc-bot:latest', inUse: versions, inUseSource: 'label', previous: null });
    expect(world.calls.some((call) => call.args[0] === 'run')).toBe(false);
  });

  it('asks once for Node and gh when the label is from before they were stamped', async () => {
    const { world } = pinnedHost();
    const id = world.tags.get('fleetadlc-bot:latest') as string;
    const image = world.images.get(id) as Image;
    image.says = { ...image.says, node: 'v22.14.0', gh: 'gh version 2.67.0' };
    const { service } = updater(world);

    const first = await service.status();
    await service.status();

    expect(first.inUse).toEqual({ ...PINS, node: '22.14.0', gh: '2.67.0' });
    const probes = world.calls.filter((call) => call.args[0] === 'run');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.args).toContain('fleetadlc-engines-versions-in-use');
  });

  it('are asked of the CLIs themselves in an image built before the label, once per image', async () => {
    const world = new World();
    world.tags.set('fleetadlc-bot:latest', world.image(PINS, false));
    const { service } = updater(world);

    const first = await service.status();
    await service.status();

    expect(first).toMatchObject({ inUse: PINS, inUseSource: 'cli' });
    const probes = world.calls.filter((call) => call.args[0] === 'run');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.args).toContain('fleetadlc-engines-versions-in-use');
  });
});

describe('rolling back', () => {
  async function updated(): Promise<{ world: World; before: string; after: string; service: EngineUpdater; refresh: ReturnType<typeof vi.fn> }> {
    const { world, latest } = pinnedHost();
    world.npm[CODEX] = '0.156.1';
    const { service, refresh } = updater(world);
    await service.updateAndWait({ trigger: 'schedule' });
    return { world, before: latest, after: world.tags.get('fleetadlc-bot:latest') as string, service, refresh };
  }

  it('puts the previous image back as latest and keeps the one it replaced as previous', async () => {
    const { world, before, after, service, refresh } = await updated();

    const result = await service.rollback('ada');

    expect(world.tags.get('fleetadlc-bot:latest')).toBe(before);
    expect(world.tags.get('fleetadlc-bot:previous')).toBe(after);
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
    expect(world.tags.get('fleetadlc-bot:latest')).toBe(after);
  });

  it('refuses when there is nothing to go back to', async () => {
    const { world } = pinnedHost();
    const { service } = updater(world);
    await expect(service.rollback()).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/no fleetadlc-bot:previous/) });
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
        login: { envVar: 'CODEX_HOME', path: '/fleetadlc/login' },
        accountId: OPENAI,
      },
      loginRoot,
    );
    expect(presented).toEqual({
      presented: { env: { CODEX_HOME: '/fleetadlc/login' }, mount: join(loginRoot, OPENAI), secret: null },
    });
  });

  it('is nothing to call with for a subscription that is not signed in, or a bot with nothing stored', () => {
    const login = { source: 'account' as const, kind: 'subscription' as const, envVar: null, key: null, accountId: OPENAI };
    expect(presentCredential({ ...login, login: { envVar: 'CODEX_HOME', path: '/fleetadlc/login' } }, loginRoot)).toEqual({
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
