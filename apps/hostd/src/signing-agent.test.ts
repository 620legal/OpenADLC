import { describe, expect, it } from 'vitest';
import { signingKeyRef, type SecretStore } from '@fleetadlc/github';
import { DockerDriver, type DockerResult } from './drivers/docker.js';
import type { SigningAgent } from './drivers/types.js';
import { SessionEnvMinter, type SessionEnvInput } from './session-env.js';

/**
 * Where a bot's signing key is held, so that git in its session can sign.
 *
 * The agent was started beside hostd, on the host, and the session — inside
 * the bot's container — was handed a socket path that did not exist there.
 * Every `git commit` failed with "No private key found", and a builder that had
 * finished its change stopped at a branch that requires signed commits.
 */

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----';
const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFake fleetadlc-builder';

function memory(initial: Record<string, string> = {}): SecretStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(ref) {
      return data.get(ref) ?? null;
    },
    async set(ref, value) {
      data.set(ref, value);
    },
    async delete(ref) {
      data.delete(ref);
    },
    async list(prefix = '') {
      return [...data.keys()].filter((ref) => ref.startsWith(prefix)).sort();
    },
  };
}

function input(bot: string): SessionEnvInput {
  return {
    bot,
    githubLogin: 'fleetadlc-atlas-janedoe',
    taskId: `task-${bot}`,
    token: null,
    engine: 'claude',
    model: 'claude-opus-5',
    skill: 'implement',
    workdir: '/work/fleetadlc-testbed',
    bridgeUrl: 'http://bridge',
    hostdUrl: 'http://hostd',
    costCapUsd: 15,
    contextFiles: [],
    databaseUrl: null,
    declaredPaths: [],
    repoFullName: 'janedoe/fleetadlc-testbed',
    subjectRef: 'janedoe/fleetadlc-testbed#1',
  };
}

/** Docker as a script: what was asked, what it was given on stdin, and its answers. */
function fakeDocker(answers: { add?: number } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const answer = async (args: string[], stdin?: string): Promise<DockerResult> => {
    calls.push({ args, ...(stdin !== undefined ? { input: stdin } : {}) });
    const command = args.join(' ');
    if (command.includes('ssh-add -L')) return { code: 0, stdout: `${PUBLIC}\n`, stderr: '' };
    if (command.includes('ssh-add -')) return { code: answers.add ?? 0, stdout: '', stderr: answers.add ? 'Error loading key' : '' };
    if (command.includes('command -v ssh-keygen')) return { code: 0, stdout: '/usr/bin/ssh-keygen\n', stderr: '' };
    if (command.includes('ssh-agent -s -a')) return { code: 0, stdout: 'SSH_AUTH_SOCK=/tmp/x/agent.sock; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=4242; export SSH_AGENT_PID;\necho Agent pid 4242;\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, answer };
}

function driverWith(answer: (args: string[], input?: string) => Promise<DockerResult>): DockerDriver {
  return new DockerDriver({
    image: 'fleetadlc-bot:latest',
    networkPrefix: 'fleetadlc-bot',
    runnerBundle: '/tmp/skill-runner.bundle.mjs',
    workRoot: '/tmp/fleetadlc-work',
    loginRoot: '/tmp/fleetadlc-logins',
    docker: answer,
  } as never);
}

/** A task's computer as the docker driver hands it out: the bot's container, for now. */
const COMPUTER = {
  taskId: 'task-1',
  bot: 'fleetadlc-atlas-janedoe',
  container: 'bot-fleetadlc-atlas-janedoe',
  databaseUrl: null,
  slotDir: '/tmp/fleetadlc-work/slots/task-1',
};

describe('the signing agent under docker', () => {
  it('runs inside the bot’s container, and its socket is a path the container has', async () => {
    const { calls, answer } = fakeDocker();

    const agent = await driverWith(answer).startSigningAgent(COMPUTER, KEY);

    expect(agent).not.toBeNull();
    expect(agent!.socket).toMatch(/^\/tmp\/fleetadlc-agent-[0-9a-f]{16}\/agent\.sock$/);
    expect(agent!.publicKey).toBe(PUBLIC);
    expect(agent!.signer).toBe('/usr/bin/ssh-keygen');
    // Every step is a `docker exec` into the bot's own container.
    for (const call of calls) {
      expect(call.args[0]).toBe('exec');
      expect(call.args).toContain('bot-fleetadlc-atlas-janedoe');
    }
    expect(calls[0]!.args.join(' ')).toContain(`ssh-agent -s -a ${agent!.socket}`);
  });

  it('hands the key to ssh-add on stdin, never as an argument or a file', async () => {
    const { calls, answer } = fakeDocker();

    await driverWith(answer).startSigningAgent(COMPUTER, KEY);

    const add = calls.find((call) => call.args.includes('-') && call.args.includes('ssh-add'));
    expect(add?.args).toEqual(['exec', '-i', '-e', expect.stringMatching(/^SSH_AUTH_SOCK=\/tmp\/fleetadlc-agent-/), 'bot-fleetadlc-atlas-janedoe', 'ssh-add', '-']);
    expect(add?.input).toBe(`${KEY}\n`);
    for (const call of calls) expect(call.args.join(' ')).not.toContain('not-a-real-key');
  });

  it('stops the agent it started when the key will not load, and says there is none', async () => {
    const { calls, answer } = fakeDocker({ add: 1 });

    expect(await driverWith(answer).startSigningAgent(COMPUTER, KEY)).toBeNull();
    // That agent by its PID: `-k` with only the socket set refuses and stops nothing.
    const stop = calls.find((call) => call.args.includes('ssh-agent') && call.args.includes('-k'));
    expect(stop?.args).toEqual(['exec', '-e', expect.stringMatching(/^SSH_AUTH_SOCK=\/tmp\/fleetadlc-agent-/), '-e', 'SSH_AGENT_PID=4242', 'bot-fleetadlc-atlas-janedoe', 'ssh-agent', '-k']);
  });

  it('stops the agent it started when the task ends, by that agent’s PID', async () => {
    const { calls, answer } = fakeDocker();
    const agent = await driverWith(answer).startSigningAgent(COMPUTER, KEY);
    calls.length = 0;

    await agent!.stop();

    expect(calls.map((call) => call.args)).toEqual([
      ['exec', '-e', `SSH_AUTH_SOCK=${agent!.socket}`, '-e', 'SSH_AGENT_PID=4242', 'bot-fleetadlc-atlas-janedoe', 'ssh-agent', '-k'],
      ['exec', 'bot-fleetadlc-atlas-janedoe', 'rm', '-rf', agent!.socket.replace(/\/agent\.sock$/, '')],
    ]);
  });
});

describe('a session’s signing', () => {
  it('uses the agent the driver started, and signs with the ssh-keygen where the session runs', async () => {
    const started: string[] = [];
    const agent: SigningAgent = {
      socket: '/tmp/fleetadlc-agent-0123456789abcdef/agent.sock',
      publicKey: PUBLIC,
      signer: '/usr/bin/ssh-keygen',
      stop: async () => undefined,
    };
    const minter = new SessionEnvMinter(
      memory({ [signingKeyRef('fleetadlc-atlas-janedoe')]: KEY }),
      async () => null,
      undefined,
      async (bot, key) => {
        started.push(`${bot}:${key === KEY}`);
        return agent;
      },
    );

    const { env } = await minter.mint(input('fleetadlc-atlas-janedoe'));

    expect(started).toEqual(['fleetadlc-atlas-janedoe:true']);
    expect(env.SSH_AUTH_SOCK).toBe(agent.socket);
    expect(env.GIT_CONFIG_VALUE_1).toBe(`key::${PUBLIC}`);
    expect(env.GIT_CONFIG_KEY_3).toBe('gpg.ssh.program');
    expect(env.GIT_CONFIG_VALUE_3).toBe('/usr/bin/ssh-keygen');
  });

  it('starts no agent for a bot with no signing key', async () => {
    const started: string[] = [];
    const minter = new SessionEnvMinter(memory(), async () => null, undefined, async (bot) => {
      started.push(bot);
      return null;
    });

    const { env } = await minter.mint(input('fleetadlc-atlas-janedoe'));

    expect(started).toEqual([]);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});
