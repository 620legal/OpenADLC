import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { internalSecretRef, modelAccountRef, signingKeyRef, type SecretStore } from '@fleetadlc/github';
import { docker as runDocker, DockerDriver } from './drivers/docker.js';
import { LocalDriver } from './drivers/local.js';
import type { TaskComputer } from './drivers/types.js';
import { LoginService } from './logins.js';
import { PnpmStore } from './pnpm-store.js';
import { SessionEnvMinter } from './session-env.js';
import { TaskDatabases } from './task-db.js';

/**
 * A task's credentials never go on a command line, on the host or in its
 * computer, where `ps` shows them to every other process. Each way hostd
 * hands one over is run here through a stand-in `docker`, `tmux` and `curl`
 * that write down the arguments they were started with, as `ps` would see
 * them, and no credential may be among them.
 */

const TASK = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const ACCOUNT = '7d3c2b1a-0f9e-4d8c-a7b6-5e4d3c2b1a09';
const GITHUB_TOKEN = 'ghu_SECRETgithubTOKEN0001';
const MODEL_KEY = 'sk-ant-api03-SECRETmodelKEY0002';
const DB_PASSWORD = 'SECRETdbPASSWORD0003';
const REGISTRY_TOKEN = 'npm_SECRETregistryTOKEN0004';
const SIGNING_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETsigningKEY0005\n-----END OPENSSH PRIVATE KEY-----\n';
const BOOT_PASSWORD = 'SECRETbootPASSWORD0006';
const INSTALL_SECRET = 'SECRETinstall0007';
const DATABASE_URL = `postgres://t_x:${DB_PASSWORD}@host.docker.internal:47433/t_x`;

let dir: string;
let bin: string;
let argvLog: string;
let path: string | undefined;
let taskToken: string;
let sessionEnv: Record<string, string>;

/** Every value that must not be seen; the task token is derived, so it is added once minted. */
const secrets = (): string[] => [GITHUB_TOKEN, MODEL_KEY, DB_PASSWORD, REGISTRY_TOKEN, 'SECRETsigningKEY0005', BOOT_PASSWORD, INSTALL_SECRET, taskToken];

function expectNoSecretIn(text: string): void {
  for (const secret of secrets()) expect(text, `a credential is on a command line: ${secret}`).not.toContain(secret);
}

const argv = (): string => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '');

function stub(name: string, body: string[]): void {
  writeFileSync(join(bin, name), ['#!/bin/sh', `printf '%s ' "$0" "$@" >> ${JSON.stringify(argvLog)}`, `echo >> ${JSON.stringify(argvLog)}`, ...body, ''].join('\n'));
  chmodSync(join(bin, name), 0o755);
}

function memory(initial: Record<string, string>): SecretStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (ref) => data.get(ref) ?? null,
    set: async (ref, value) => void data.set(ref, value),
    delete: async (ref) => void data.delete(ref),
    list: async (prefix = '') => [...data.keys()].filter((ref) => ref.startsWith(prefix)),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleetadlc-argv-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  argvLog = join(dir, 'argv');
  // A docker that answers every call, reads what `exec -i` hands it, says
  // an inspected container is not there (so the task database server is
  // made), and answers the signing agent's calls as ssh-agent and ssh-add would.
  stub('docker', [
    '[ "$2" = -i ] && cat > /dev/null',
    'case "$1" in inspect) exit 1 ;; esac',
    'case "$*" in *"ssh-agent -s"*) echo "SSH_AGENT_PID=4242; export SSH_AGENT_PID;" ;; *"ssh-add -L"*) echo "ssh-ed25519 AAAAC3Nza test" ;; esac',
    'exit 0',
  ]);
  path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;

  const minter = new SessionEnvMinter(
    memory({ [internalSecretRef()]: INSTALL_SECRET, [modelAccountRef(ACCOUNT)]: MODEL_KEY, [signingKeyRef('atlas')]: SIGNING_KEY }),
    async () => null,
    () => '/fleetadlc/login',
    async () => ({ socket: '/tmp/agent.sock', publicKey: 'ssh-ed25519 AAAAC3Nza test', signer: null, stop: async () => {} }),
  );
  const minted = await minter.mint({
    bot: 'atlas',
    githubLogin: 'atlas-bot',
    taskId: TASK,
    token: GITHUB_TOKEN,
    engine: 'claude',
    model: 'claude-sonnet-4-5',
    account: { id: ACCOUNT, provider: 'anthropic', kind: 'key' },
    skill: 'implement',
    workdir: '/work',
    bridgeUrl: 'http://host.docker.internal:47311',
    hostdUrl: 'http://host.docker.internal:47312',
    costCapUsd: 5,
    contextFiles: [],
    databaseUrl: DATABASE_URL,
    declaredPaths: [],
    repoFullName: 'exampleco/widgets',
    subjectRef: 'exampleco/widgets#1',
  });
  sessionEnv = minted.env;
  taskToken = sessionEnv.FLEETADLC_TASK_TOKEN ?? '';
  expect(taskToken).not.toBe('');
  expect(sessionEnv).toMatchObject({ GH_TOKEN: GITHUB_TOKEN, ANTHROPIC_API_KEY: MODEL_KEY, DATABASE_URL });
});

// Each test reads only the calls it made.
beforeEach(() => rmSync(argvLog, { force: true }));

afterAll(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

describe('a task’s credentials on the docker driver', () => {
  const driver = (): DockerDriver =>
    new DockerDriver({
      image: 'fleetadlc-bot:latest',
      networkPrefix: 'fleetadlc-bot',
      runnerBundle: '/opt/fleetadlc/skill-runner.bundle.mjs',
      workRoot: join(dir, 'work'),
      skillsRoot: '/opt/fleetadlc/skills',
      rolesRoot: '/opt/fleetadlc/roles',
      hostdUrl: 'http://host.docker.internal:47312',
      loginRoot: join(dir, 'logins'),
      docker: runDocker,
    });
  const computer: TaskComputer = { taskId: TASK, bot: 'atlas', container: 'task-3f2a9c1e', databaseUrl: DATABASE_URL, slotDir: '/work' };

  it('are on no command line when its session starts, when `make setup` runs, or when its signing key is loaded', async () => {
    const docker = driver();
    await docker.startSession({ computer, name: 'implement-3f2a9c1e', cwd: '/work/wt', command: ['node', '/fleetadlc/skill-runner.mjs'], env: sessionEnv });
    await docker.exec(computer, ['make', '-s', 'setup'], {
      cwd: '/work/wt',
      env: { DATABASE_URL, FLEETADLC_REPO_HOME: '/work/home', FLEETADLC_HOSTD_URL: 'http://host.docker.internal:47312', FLEETADLC_TASK_ID: TASK, FLEETADLC_TASK_TOKEN: taskToken },
    });
    await docker.startSigningAgent(computer, SIGNING_KEY);

    const seen = argv();
    expect(seen).toContain('new-session');
    expect(seen).toContain('-e DATABASE_URL -e');
    expect(seen).toContain('-e FLEETADLC_TASK_TOKEN');
    expect(seen).toContain('ssh-add -');
    expectNoSecretIn(seen);
  });

  it('are on no command line when the task database server is made or a task’s role is', async () => {
    const databases = new TaskDatabases({
      docker: runDocker,
      container: 'fleetadlc-taskdb',
      image: 'pgvector/pgvector:pg16',
      installLabel: 'fleetadlc.install=default',
      bindAddress: '127.0.0.1',
      bootPassword: () => BOOT_PASSWORD,
      password: () => DB_PASSWORD,
    });
    expect(await databases.create(TASK)).toContain(DB_PASSWORD);

    expect(argv()).toContain('-e POSTGRES_PASSWORD -e');
    expectNoSecretIn(argv());
  });

  it('are on no command line when hostd fills a repository’s pnpm store from a private registry', async () => {
    const worktree = join(dir, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const store = new PnpmStore({
      docker: runDocker,
      image: 'fleetadlc-bot:latest',
      install: 'default',
      workRoot: join(dir, 'work'),
      cacheVolume: (repoKey) => `fleetadlc-cache-${repoKey}`,
      networkArgs: [],
      labels: ['fleetadlc.install=default'],
      registry: async () => ({ host: 'registry.example', token: REGISTRY_TOKEN }),
    });
    expect(await store.fill({ repoKey: 'exampleco__widgets', worktree })).toMatchObject({ filled: true });

    expect(argv()).toContain('-e FLEETADLC_REGISTRY_TOKEN');
    expectNoSecretIn(argv());
  });

  it('are on no command line when hostd checks a model account’s key', async () => {
    const logins = new LoginService({
      driver: 'docker',
      loginRoot: join(dir, 'logins'),
      image: 'fleetadlc-bot:latest',
      store: memory({ [modelAccountRef(ACCOUNT)]: MODEL_KEY }),
      account: async () => ({ id: ACCOUNT, provider: 'anthropic', kind: 'key' }),
      verifyTimeoutMs: 5_000,
    });
    await logins.verify(ACCOUNT);

    expect(argv()).toContain('-e ANTHROPIC_API_KEY');
    expectNoSecretIn(argv());
  });
});

describe('a task’s credentials on the local driver', () => {
  it('reach its session in a file it reads and removes, and on no command line', async () => {
    const out = join(dir, 'session-env');
    const tmux = join(bin, 'tmux');
    // A tmux with no sessions that runs a new session's command at once, after `new-session -d -s <name> -c <cwd>`.
    stub('tmux', ['case "$1" in has-session) exit 1 ;; new-session) shift 6; "$@" > ' + JSON.stringify(out) + ' 2>&1 ;; esac', 'exit 0']);
    const work = join(dir, 'local-work');
    const driver = new LocalDriver(tmux, work, join(dir, 'logins'));
    const computer = await driver.acquire({ taskId: TASK, bot: 'atlas', repoKey: 'exampleco__widgets', slotDir: join(work, 'slots', TASK), login: null, cpus: 2, memoryGb: 4, database: false });

    await driver.startSession({ computer, name: 'implement-3f2a9c1e', cwd: join(computer.slotDir, 'wt'), command: ['/usr/bin/env'], env: sessionEnv });

    const started = argv().split('\n').find((line) => line.includes('new-session')) ?? '';
    expect(started).toContain('/usr/bin/env -i /bin/sh -c');
    const file = /(\S*fleetadlc-env-[0-9a-f]{16})/.exec(started)?.[1] ?? '';
    expect(file).not.toBe('');
    expect(existsSync(file)).toBe(false);
    const seenBySession = readFileSync(out, 'utf8');
    expect(seenBySession).toContain(`GH_TOKEN=${GITHUB_TOKEN}`);
    expect(seenBySession).toContain(`ANTHROPIC_API_KEY=${MODEL_KEY}`);
    expect(seenBySession).toContain(`FLEETADLC_TASK_TOKEN=${taskToken}`);
    expectNoSecretIn(argv());
  });
});

describe('a task’s token inside its computer', () => {
  /** A curl that writes down its arguments and what it read on stdin, and answers as hostd would. */
  function fakeCurl(stdin: string): void {
    stub('curl', [
      `cat > ${JSON.stringify(stdin)}`,
      'case "$*" in *registry-token*) printf \'{"host":"registry.example","token":"' + REGISTRY_TOKEN + '"}\\n200\' ;; *) printf 200 ;; esac',
    ]);
  }

  function run(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('close', resolve);
    });
  }

  const taskEnv = (): Record<string, string> => ({
    PATH: [join(import.meta.dirname, '..', 'bin'), join(dir, 'real'), bin, '/usr/bin', '/bin'].join(':'),
    HOME: join(dir, 'home'),
    FLEETADLC_HOSTD_URL: 'http://host.docker.internal:47312',
    FLEETADLC_TASK_ID: TASK,
    FLEETADLC_TASK_TOKEN: taskToken,
  });

  it('goes to curl on stdin when fleetadlc-install asks hostd for the registry’s credential', async () => {
    const stdin = join(dir, 'curl-stdin-install');
    fakeCurl(stdin);
    const code = await run(join(import.meta.dirname, '..', '..', '..', 'infra', 'local', 'fleetadlc-install'), ['true'], dir, taskEnv());

    expect(code).toBe(0);
    expect(readFileSync(stdin, 'utf8')).toBe(`x-fleetadlc-task-token: ${taskToken}\n`);
    expect(argv()).toContain('--header @-');
    expectNoSecretIn(argv());
  });

  it('goes to curl on stdin when OpenADLC’s pnpm asks hostd to fill the shared store', async () => {
    const stdin = join(dir, 'curl-stdin-pnpm');
    fakeCurl(stdin);
    const wt = join(dir, 'pnpm-wt');
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'home'), { recursive: true });
    mkdirSync(join(dir, 'real'), { recursive: true });
    writeFileSync(join(wt, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(join(wt, 'node_modules', '.modules.yaml'), 'storeDir: /pnpm-store/v10\n');
    writeFileSync(join(dir, 'real', 'pnpm'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'real', 'pnpm'), 0o755);
    const code = await run(join(import.meta.dirname, '..', 'bin', 'pnpm'), ['add', '-D', 'left-pad'], wt, {
      ...taskEnv(),
      FLEETADLC_PNPM_STORE: '/pnpm-store',
      PNPM_STORE_DIR: '/pnpm-store',
      npm_config_store_dir: '/pnpm-store',
    });

    expect(code).toBe(0);
    expect(readFileSync(stdin, 'utf8')).toBe(`x-fleetadlc-task-token: ${taskToken}\n`);
    expectNoSecretIn(argv());
  });
});
