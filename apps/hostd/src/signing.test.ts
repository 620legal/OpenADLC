import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * git accepts `user.signingkey` either as a path to a public key file or as the
 * literal `key::ssh-ed25519 …` form; hostd uses the literal form, with the
 * private key held only in an agent. git's own documentation for
 * `user.signingKey` says the form is supported — "Alternatively it can contain
 * a public key prefixed with key:: directly".
 *
 * This checks both forms by doing what hostd does: the private key exists only
 * inside an agent, and the commit's signature is then verified against an
 * allowed-signers file. A future git that drops the literal form fails here.
 */
let dir: string;
let repo: string;
let socket: string;
let publicKey: string;
/** The agent this suite started, stopped by its PID: `ssh-agent -k` with only the socket set refused, and one agent leaked per run. */
let agentPid: number | null = null;

async function agent(...args: string[]): Promise<{ stdout: string }> {
  return run(args[0]!, args.slice(1), { env: { ...process.env, SSH_AUTH_SOCK: socket } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleetadlc-signing-'));
  repo = join(dir, 'repo');
  socket = join(dir, 'agent.sock');

  await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', join(dir, 'id'), '-q']);
  const started = await run('ssh-agent', ['-s', '-a', socket]);
  agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(started.stdout)?.[1]) || null;
  await agent('ssh-add', join(dir, 'id'));

  // Exactly hostd's arrangement: the private half is in the agent and nowhere
  // else. If the literal form needed a file, this is where it would break.
  rmSync(join(dir, 'id'));

  publicKey = (await agent('ssh-add', '-L')).stdout.trim().split('\n')[0] ?? '';

  await run('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  await run('git', ['-C', repo, 'add', 'a.txt']);
}, 30_000);

afterAll(async () => {
  if (agentPid !== null) {
    try {
      process.kill(agentPid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Commits with the config hostd sets, and returns the signature verdict. */
async function commitAndVerify(signingKey: string, message: string): Promise<string> {
  const env = {
    ...process.env,
    SSH_AUTH_SOCK: socket,
    GIT_AUTHOR_NAME: 'bot',
    GIT_AUTHOR_EMAIL: 'bot@example.com',
    GIT_COMMITTER_NAME: 'bot',
    GIT_COMMITTER_EMAIL: 'bot@example.com',
  };

  await run(
    'git',
    [
      '-C', repo,
      '-c', 'gpg.format=ssh',
      '-c', `user.signingkey=${signingKey}`,
      '-c', 'commit.gpgsign=true',
      'commit', '-q', '--allow-empty', '-m', message,
    ],
    { env },
  );

  const allowed = join(dir, 'allowed_signers');
  writeFileSync(allowed, `bot@example.com ${publicKey}\n`);

  const { stdout } = await run(
    'git',
    [
      '-C', repo,
      '-c', 'gpg.format=ssh',
      '-c', `gpg.ssh.allowedSignersFile=${allowed}`,
      'log', '--show-signature', '-1', '--format=%H',
    ],
    { env },
  );
  return stdout;
}

describe('how hostd tells git which key to sign with', () => {
  it('signs with the literal key:: form, from a key that exists only in the agent', async () => {
    // hostd relies on this: `apps/hostd/src/session-env.ts` sets exactly this.
    const output = await commitAndVerify(`key::${publicKey}`, 'the literal form');
    expect(output).toContain('Good "git" signature for bot@example.com');
  }, 30_000);

  it('also signs when given a file', async () => {
    const path = join(dir, 'signer.pub');
    writeFileSync(path, `${publicKey}\n`);
    const output = await commitAndVerify(path, 'the file form');
    expect(output).toContain('Good "git" signature for bot@example.com');
  }, 30_000);

  it('is the form the session environment actually sets', async () => {
    // A test that proves git's behaviour but not hostd's would let the two
    // drift apart again.
    const source = readFileSync(new URL('./session-env.ts', import.meta.url), 'utf8');
    expect(source).toContain('`key::${agent.publicKey}`');
  });
});
