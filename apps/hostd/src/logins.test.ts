import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelAccountRef, type SecretStore } from '@fleetadlc/github';
import {
  LoginRefused,
  LoginService,
  credentialRefusal,
  MESSAGE_MAX,
  ensureLoginDir,
  hasLogin,
  moveSignInsIntoPlace,
  loginConfigVolume,
  judgeProbe,
  lastWords,
  loginDir,
  loginFor,
  parseDeviceAuth,
  parseGrokModels,
  removeAdoptCopies,
  removeLoginDir,
  scrubOutput,
  stripAnsi,
  type CliExit,
  type CliSpawner,
  type LoginAccount,
  type RunningCli,
} from './logins.js';
import { TELEMETRY_OPT_OUTS } from './drivers/base-env.js';

/** The vendors' telemetry switches, as every docker run of a CLI here passes them. */
const OPT_OUTS = Object.entries(TELEMETRY_OPT_OUTS).flatMap(([variable, value]) => ['-e', `${variable}=${value}`]);

/** The fresh home a sign-in, check or model list mounts, with that mount taken out of `args`. */
function withoutFreshHome(args: string[]): string[] {
  const home = args.findIndex((arg) => arg.endsWith(':/fleetadlc/login'));
  return home < 1 ? args : args.filter((_, index) => index !== home && index !== home - 1);
}

/** Where hostd keeps the account's sign-in. */
const signInFile = (): string => join(loginRoot, SEAT, 'sign-in', 'auth.json');

/** Writes the account's sign-in there. */
function writeSignIn(content: string): void {
  mkdirSync(join(loginRoot, SEAT, 'sign-in'), { recursive: true });
  writeFileSync(signInFile(), content);
}

/** The host side of the `-v` that lands at `target`. */
function mountAt(args: string[], target: string): string {
  return args.find((arg) => arg.endsWith(`:${target}`))?.split(':')[0] ?? '';
}

/** What is left under the login root, an empty `.homes` (every home is gone) aside. */
function besideAccounts(): string[] {
  const homes = join(loginRoot, '.homes');
  if (existsSync(homes)) expect(readdirSync(homes)).toEqual([]);
  return readdirSync(loginRoot).filter((name) => name !== '.homes');
}

function expectOwnHome(args: string[]): void {
  const home = args.find((arg) => arg.endsWith(':/fleetadlc/login'));
  expect(home?.startsWith(`${join(loginRoot, '.homes')}/once-`)).toBe(true);
  expect(args).not.toContain(`${join(loginRoot, SEAT)}:/fleetadlc/login`);
}

// ------------------------------------------------------------ what the CLIs print

/** `codex login --device-auth`, 0.155.1, in a container, ANSI stripped. */
const CODEX_DEVICE = `Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   URPK-DI1GG
`;

/** `grok login --device-auth`, 1.0.41, in a container. */
const GROK_DEVICE = `To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=NAEV-43ZB

  (Could not open browser automatically — open the URL above manually.)

Confirm this code in your browser:

  NAEV-43ZB

Only continue with a code you requested. Don't share it with anyone.

Waiting for authorization...
`;

/** `claude -p … --output-format json` with no credential, 2.1.278. Trimmed of usage fields. */
const CLAUDE_NOT_LOGGED_IN = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: null,
  num_turns: 1,
  result: 'Not logged in · Please run /login',
  terminal_reason: 'api_error',
});

/** The same, with a token that is not one. */
const CLAUDE_BAD_TOKEN = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 401,
  result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
});

const CLAUDE_ANSWERED = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });

/** `codex exec --json` with no login, 0.155.1, abridged: it retries, then fails the turn. */
const CODEX_REFUSED = [
  'WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"',
  'Reading additional input from stdin...',
  '{"type":"thread.started","thread_id":"01a0d1dc-71d7-7c32-93c8-182df94f8401"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}',
  '{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}',
  '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}',
].join('\n');

const CODEX_ANSWERED = [
  '{"type":"thread.started","thread_id":"01a0d1dc"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion)"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":2}}',
].join('\n');

/** `grok -p … --output-format json` with no login, 1.0.41. */
const GROK_NOT_SIGNED_IN = [
  '{"type":"error","message":"Not signed in. To authenticate without a browser, run:\\n  grok login --device-code\\n\\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser."}',
  'Error: Not signed in. To authenticate without a browser, run:',
  '  grok login --device-code',
].join('\n');

/** `grok models`, 1.0.41, signed in to a SuperGrok seat. */
const GROK_MODELS = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
  - grok-4.5
`;

/** The same command signed out, in the bot image on 2026-09-24. It exits 0 and still lists models. */
const GROK_MODELS_SIGNED_OUT = `You are not authenticated.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`;

// ------------------------------------------------------------ fakes

const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TOKEN = 'sk-ant-oat01-Zm9vYmFyYmF6cXV4LXRoZS10b2tlbg';
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

class FakeCli implements RunningCli {
  private readonly listeners: ((text: string) => void)[] = [];
  private finish: (exit: CliExit) => void = () => undefined;
  readonly exited = new Promise<CliExit>((resolve) => {
    this.finish = resolve;
  });
  killed = false;

  onOutput(listener: (text: string) => void): void {
    this.listeners.push(listener);
  }

  say(text: string): void {
    for (const listener of this.listeners) listener(text);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.finish({ code, signal });
  }

  kill(): void {
    this.killed = true;
    this.exit(null, 'SIGTERM');
  }
}

interface Spawned {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | undefined;
  cli: FakeCli;
}

/** A spawner whose CLI is `behave`. `docker rm -f` always just succeeds. */
function spawner(behave: (cli: FakeCli, call: Spawned) => void = () => undefined) {
  const calls: Spawned[] = [];
  const spawn: CliSpawner = (command, args, options) => {
    const cli = new FakeCli();
    const call = { command, args, env: options.env, cwd: options.cwd, cli };
    calls.push(call);
    // After the caller has had the chance to listen, as a real process would.
    setTimeout(() => (command === 'docker' && args[0] === 'rm' ? cli.exit(0) : behave(cli, call)), 0);
    return cli;
  };
  const runs = () => calls.filter((call) => !(call.command === 'docker' && call.args[0] === 'rm'));
  const removals = () => calls.filter((call) => call.command === 'docker' && call.args[0] === 'rm').map((call) => call.args);
  return { calls, spawn, runs, removals };
}

function memory(initial: Record<string, string> = {}): SecretStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (ref) => data.get(ref) ?? null,
    set: async (ref, value) => void data.set(ref, value),
    delete: async (ref) => void data.delete(ref),
    list: async (prefix = '') => [...data.keys()].filter((ref) => ref.startsWith(prefix)),
  };
}

let loginRoot: string;

beforeEach(() => {
  loginRoot = join(mkdtempSync(join(tmpdir(), 'fleetadlc-logins-')), 'logins');
});

afterEach(() => {
  rmSync(join(loginRoot, '..'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

function service(
  account: LoginAccount | null,
  spawn: CliSpawner,
  options: {
    driver?: 'docker' | 'local';
    store?: SecretStore;
    codeWaitMs?: number;
    loginTimeoutMs?: number;
    verifyTimeoutMs?: number;
    modelsTimeoutMs?: number;
  } = {},
): LoginService {
  return new LoginService({
    driver: options.driver ?? 'docker',
    loginRoot,
    image: 'fleetadlc-bot:latest',
    store: options.store ?? memory(),
    account: async (id) => (account && account.id === id ? account : null),
    spawn,
    now: () => new Date('2026-09-24T08:00:00.000Z'),
    codeWaitMs: options.codeWaitMs ?? 2_000,
    loginTimeoutMs: options.loginTimeoutMs,
    verifyTimeoutMs: options.verifyTimeoutMs,
    modelsTimeoutMs: options.modelsTimeoutMs,
  });
}

const openai: LoginAccount = { id: SEAT, provider: 'openai', kind: 'subscription' };
const xai: LoginAccount = { id: SEAT, provider: 'xai', kind: 'subscription' };
const claude: LoginAccount = { id: SEAT, provider: 'anthropic', kind: 'subscription' };

// ------------------------------------------------------------ tests

describe('reading a device sign-in', () => {
  it('finds codex’s link and one-time code', () => {
    expect(parseDeviceAuth(CODEX_DEVICE)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'URPK-DI1GG' });
  });

  it('finds grok’s link and code', () => {
    expect(parseDeviceAuth(GROK_DEVICE)).toEqual({
      url: 'https://accounts.x.ai/oauth2/device?user_code=NAEV-43ZB',
      code: 'NAEV-43ZB',
    });
  });

  it('reads through the colour a terminal CLI prints', () => {
    const coloured = CODEX_DEVICE.replace(
      'https://auth.openai.com/codex/device',
      '\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
    ).replace('URPK-DI1GG', '\u001b[1;94mURPK-DI1GG\u001b[0m');

    expect(stripAnsi(coloured)).toBe(CODEX_DEVICE);
    expect(parseDeviceAuth(coloured)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'URPK-DI1GG' });
  });

  it('waits for the rest of a code or a link that arrived cut short', () => {
    // `URPK-DI1G` would pass for a code; it is the first nine of ten.
    expect(parseDeviceAuth(CODEX_DEVICE.slice(0, CODEX_DEVICE.length - 2))).toBeNull();
    expect(parseDeviceAuth('To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/dev')).toBeNull();
  });

  it('takes only an https link, because the console renders it as one', () => {
    expect(parseDeviceAuth('open http://auth.example/device\n  URPK-DI1GG\n')).toBeNull();
  });
});

describe('what leaves hostd of a CLI’s words', () => {
  it('has the account’s secret and anything shaped like one taken out', () => {
    const said = `refused ${TOKEN}; also saw sk-ant-api03-${'x'.repeat(40)} and Bearer abcdefgh12345678 and ${['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXNpZw'].join('.')}`;
    const scrubbed = scrubOutput(said, ['some-custom-secret-value']);

    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).not.toContain('sk-ant-api03');
    expect(scrubbed).not.toContain('abcdefgh12345678');
    expect(scrubbed).not.toContain('eyJhbGciOi');
    expect(scrubOutput('it was some-custom-secret-value', ['some-custom-secret-value'])).toBe('it was [redacted]');
  });

  it('takes out every shape the shared redaction knows, a GitHub token and a private key among them', () => {
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    const scrubbed = scrubOutput(`pushed with ghp_${'a'.repeat(36)}, key ${pem}`);

    expect(scrubbed).toBe('pushed with [redacted], key [redacted]');
  });

  it('is the last lines, no more than 400 characters, scrubbed before they are cut', () => {
    const long = `${'noise line\n'.repeat(100)}the real reason, with ${TOKEN}`;
    const said = lastWords(long, [TOKEN]);

    expect(said.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(said).toContain('the real reason');
    expect(said).not.toContain(TOKEN.slice(10));
  });
});

describe('judging a one-line prompt', () => {
  it('fails Claude with no credential, in its own words', () => {
    expect(judgeProbe(CLAUDE_NOT_LOGGED_IN, 1)).toEqual({ ok: false, message: 'Not logged in · Please run /login' });
  });

  it('fails a token Claude refuses, in its own words', () => {
    expect(judgeProbe(CLAUDE_BAD_TOKEN, 1).message).toBe(
      'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    );
  });

  it('fails codex on the turn it failed, not on a retry', () => {
    const verdict = judgeProbe(CODEX_REFUSED, 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/^unexpected status 401 Unauthorized: Missing bearer/);
    expect(verdict.message).not.toContain('Reconnecting');
  });

  it('fails grok with what it said about signing in', () => {
    const verdict = judgeProbe(GROK_NOT_SIGNED_IN, 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/^Not signed in\./);
  });

  it('reads a failure carried as a list of errors', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, errors: ['Not signed in. Run grok login.'] });
    expect(judgeProbe(line, 1).message).toBe('Not signed in. Run grok login.');
  });

  it('fails an answer marked as an error even when the process exited 0', () => {
    expect(judgeProbe(CLAUDE_NOT_LOGGED_IN, 0).ok).toBe(false);
  });

  it('passes an answer, and says what it was', () => {
    expect(judgeProbe(CLAUDE_ANSWERED, 0)).toEqual({ ok: true, message: 'answered: OK' });
    expect(judgeProbe(CODEX_ANSWERED, 0)).toEqual({ ok: true, message: 'answered: OK' });
  });

  it('never repeats the credential it was given', () => {
    const echoed = JSON.stringify({ type: 'result', is_error: true, result: `token ${TOKEN} was rejected` });
    expect(judgeProbe(echoed, 1, [TOKEN]).message).toBe('token [redacted] was rejected');
  });

  it('takes out a credential no shape matches before its last words are cut, so no tail of it is left', () => {
    // Cut first and scrubbed after, the end of this one reached the console.
    const secret = 'proxytok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const printed = `rejected ${secret}\n${'x'.repeat(380)}`;

    const message = judgeProbe(printed, 1, [secret]).message;

    expect(message).not.toMatch(/STUVWXYZ0123456789|0123456789/);
    expect(message).toContain('[redacted]');
  });
});

describe('an account’s login directory', () => {
  it('is one directory per account, made 0700 by hostd', () => {
    const dir = ensureLoginDir(loginRoot, SEAT);

    expect(dir).toBe(join(loginRoot, SEAT));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(loginRoot).mode & 0o777).toBe(0o700);
  });

  it('is closed again when it was left open', () => {
    mkdirSync(join(loginRoot, SEAT), { recursive: true });
    chmodSync(join(loginRoot, SEAT), 0o755);

    ensureLoginDir(loginRoot, SEAT);

    expect(statSync(join(loginRoot, SEAT)).mode & 0o777).toBe(0o700);
  });

  it('is never built from something that is not an account id', () => {
    expect(() => loginDir(loginRoot, '..')).toThrow(/not a model account id/);
    expect(() => loginDir(loginRoot, `${SEAT}/../..`)).toThrow(/not a model account id/);
    expect(() => removeLoginDir(loginRoot, '../logins')).toThrow(/not a model account id/);
  });

  it('is removed on its own, leaving every other account’s', () => {
    const other = '550e8400-e29b-41d4-a716-446655440000';
    ensureLoginDir(loginRoot, SEAT);
    ensureLoginDir(loginRoot, other);

    mkdirSync(join(loginRoot, '.published', SEAT), { recursive: true });
    writeFileSync(join(loginRoot, '.published', SEAT, 'config.toml'), 'model = "gpt-5"\n');
    mkdirSync(join(loginRoot, '.published', other), { recursive: true });
    writeFileSync(join(loginRoot, '.published', other, 'config.toml'), 'model = "kept"\n');

    removeLoginDir(loginRoot, SEAT);

    expect(existsSync(join(loginRoot, SEAT))).toBe(false);
    expect(existsSync(join(loginRoot, '.published', SEAT))).toBe(false);
    expect(existsSync(join(loginRoot, other))).toBe(true);
    expect(readFileSync(join(loginRoot, '.published', other, 'config.toml'), 'utf8')).toBe('model = "kept"\n');
  });

  it('is not signed in when auth.json is a link or a directory', () => {
    ensureLoginDir(loginRoot, SEAT);
    symlinkSync(join(loginRoot, 'elsewhere.json'), signInFile());
    writeFileSync(join(loginRoot, 'elsewhere.json'), '{"tokens":"not-this-account"}');

    expect(hasLogin(loginRoot, SEAT)).toBe(false);

    rmSync(signInFile());
    mkdirSync(signInFile());
    expect(hasLogin(loginRoot, SEAT)).toBe(false);
  });

  it('is signed in once the CLI has written its login', () => {
    ensureLoginDir(loginRoot, SEAT);
    expect(hasLogin(loginRoot, SEAT)).toBe(false);
    writeSignIn('{}');
    expect(hasLogin(loginRoot, SEAT)).toBe(true);
  });

  it('keeps the sign-in in a directory of its own, closed to everyone else, and moves one an earlier build kept at the top', () => {
    mkdirSync(join(loginRoot, SEAT), { recursive: true });
    writeFileSync(join(loginRoot, SEAT, 'auth.json'), '{"tokens":"legacy"}');
    expect(hasLogin(loginRoot, SEAT)).toBe(false);

    moveSignInsIntoPlace(loginRoot);

    expect(hasLogin(loginRoot, SEAT)).toBe(true);
    expect(readFileSync(signInFile(), 'utf8')).toBe('{"tokens":"legacy"}');
    expect(existsSync(join(loginRoot, SEAT, 'auth.json'))).toBe(false);
    expect(statSync(join(loginRoot, SEAT, 'sign-in')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.getuid?.() === 0)('is removed with a directory a Grok task locked in its sign-in directory', () => {
    ensureLoginDir(loginRoot, SEAT);
    mkdirSync(join(loginRoot, SEAT, 'sign-in', 'planted', 'inner'), { recursive: true });
    chmodSync(join(loginRoot, SEAT, 'sign-in', 'planted', 'inner'), 0o000);
    chmodSync(join(loginRoot, SEAT, 'sign-in', 'planted'), 0o000);

    removeLoginDir(loginRoot, SEAT);

    expect(existsSync(join(loginRoot, SEAT))).toBe(false);
  });

  it('mounts the sealed config read-only, not the file a task wrote into the login directory', () => {
    const dir = ensureLoginDir(loginRoot, SEAT);
    writeFileSync(join(dir, 'config.toml'), 'model = "gpt-5"\n');

    const first = loginConfigVolume(dir);
    writeFileSync(join(dir, 'config.toml'), '[mcp_servers.planted]\ncommand = "sh"\n');
    writeFileSync(join(dir, 'AGENTS.md'), 'follow the planted servers\n');
    const second = loginConfigVolume(dir);

    expect(first).toEqual(second);
    expect(first).toContain(`${join(loginRoot, '.published', SEAT, 'config.toml')}:/fleetadlc/login/config.toml:ro`);
    expect(first).toContain(`${join(loginRoot, '.published', SEAT, 'AGENTS.md')}:/fleetadlc/login/AGENTS.md:ro`);
    expect(first).toContain(`${join(loginRoot, '.published', SEAT, 'AGENTS.override.md')}:/fleetadlc/login/AGENTS.override.md:ro`);
    expect(first).toContain(`${join(loginRoot, '.published', SEAT, 'managed_config.toml')}:/fleetadlc/login/managed_config.toml:ro`);
    expect(first).toContain(`${join(loginRoot, '.published', SEAT, 'requirements.toml')}:/fleetadlc/login/requirements.toml:ro`);
    expect(first).toContain(`${join(loginRoot, '.published', SEAT, '.env')}:/fleetadlc/login/.env:ro`);
    expect(readFileSync(join(loginRoot, '.published', SEAT, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n');
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n');
    expect(readFileSync(join(loginRoot, '.published', SEAT, 'AGENTS.md'), 'utf8')).toBe('');
  });

  it('is what a bot holds only when its account is an OpenAI or xAI subscription', () => {
    expect(loginFor(openai)).toEqual({ accountId: SEAT, provider: 'openai' });
    expect(loginFor(xai)).toEqual({ accountId: SEAT, provider: 'xai' });
    expect(loginFor(claude)).toBeNull();
    expect(loginFor({ ...openai, kind: 'key' })).toBeNull();
    expect(loginFor(null)).toBeNull();
  });
});

describe('signing a subscription in, under the docker driver', () => {
  it('runs codex’s device sign-in in a throwaway container with a home of its own', async () => {
    const { spawn, runs, removals } = spawner((cli) => cli.say(CODEX_DEVICE));

    const state = await service(openai, spawn).start(SEAT);

    expect(state).toEqual({
      state: 'waiting',
      url: 'https://auth.openai.com/codex/device',
      code: 'URPK-DI1GG',
      startedAt: '2026-09-24T08:00:00.000Z',
    });
    // A container left by a sign-in hostd no longer knows about goes first.
    expect(removals()).toEqual([['rm', '-f', `fleetadlc-login-${SEAT}`]]);
    const signIn = runs()[0]?.args ?? [];
    expectOwnHome(signIn);
    expect(withoutFreshHome(signIn)).toEqual([
      'run',
      '--rm',
      '-i',
      '--init',
      '--name',
      `fleetadlc-login-${SEAT}`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'config.toml')}:/fleetadlc/login/config.toml:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'AGENTS.md')}:/fleetadlc/login/AGENTS.md:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'AGENTS.override.md')}:/fleetadlc/login/AGENTS.override.md:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'managed_config.toml')}:/fleetadlc/login/managed_config.toml:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'requirements.toml')}:/fleetadlc/login/requirements.toml:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, '.env')}:/fleetadlc/login/.env:ro`,
      '-e',
      'CODEX_HOME=/fleetadlc/login',
      ...OPT_OUTS,
      '--entrypoint',
      'codex',
      'fleetadlc-bot:latest',
      'login',
      '--device-auth',
    ]);
    expect(statSync(join(loginRoot, SEAT)).mode & 0o777).toBe(0o700);
  });

  it('runs grok’s with GROK_HOME, and with its self-update off', async () => {
    const { spawn, runs } = spawner((cli) => cli.say(GROK_DEVICE));

    const state = await service(xai, spawn).start(SEAT);

    expect(state).toMatchObject({ state: 'waiting', code: 'NAEV-43ZB' });
    const args = runs()[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining(['-e', 'GROK_HOME=/fleetadlc/login', '-e', 'GROK_DISABLE_AUTOUPDATER=1', '--entrypoint', 'grok']),
    );
    expect(args.slice(-3)).toEqual(['fleetadlc-bot:latest', 'login', '--device-auth']);
  });

  it('runs it with the vendors’ telemetry left on when the operator opted in, and its self-update still off', async () => {
    vi.stubEnv('FLEETADLC_ENGINE_TELEMETRY', 'on');
    try {
      const { spawn, runs } = spawner((cli) => cli.say(GROK_DEVICE));
      await service(xai, spawn).start(SEAT);
      const args = runs()[0]?.args ?? [];
      expect(args).toEqual(expect.arrayContaining(['-e', 'GROK_DISABLE_AUTOUPDATER=1']));
      expect(args.join(' ')).not.toContain('GROK_TELEMETRY_ENABLED');
      expect(args.join(' ')).not.toContain('DISABLE_TELEMETRY');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('answers a second start with the sign-in already running, not another one', async () => {
    const { spawn, runs } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn);

    const [first, second] = await Promise.all([logins.start(SEAT), logins.start(SEAT)]);
    const third = await logins.start(SEAT);

    expect(runs()).toHaveLength(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('is signed in once the CLI exits 0 with its sign-in written, which moves onto the account', async () => {
    const { spawn, runs } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn);
    await logins.start(SEAT);

    expect(await logins.status(SEAT)).toMatchObject({ state: 'waiting', code: 'URPK-DI1GG' });
    const home = mountAt(runs()[0]?.args ?? [], '/fleetadlc/login');
    writeFileSync(join(home, 'auth.json'), '{"tokens":"new"}');
    runs()[0]?.cli.exit(0);
    await runs()[0]?.cli.exited;

    expect(await logins.status(SEAT)).toEqual({ state: 'signed-in' });
    expect(readFileSync(signInFile(), 'utf8')).toBe('{"tokens":"new"}');
    expect(existsSync(home)).toBe(false);
  });

  it('is signed out when the CLI exits 0 but no sign-in reached the account', async () => {
    // The exit code alone said "signed in" while every task got no sign-in.
    const { spawn, runs } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn);
    await logins.start(SEAT);

    runs()[0]?.cli.exit(0);
    await runs()[0]?.cli.exited;

    expect(await logins.status(SEAT)).toEqual({ state: 'signed-out' });
  });

  it.skipIf(process.getuid?.() === 0)('signs in over a directory a task made where the sign-in goes', async () => {
    // A Grok task ran `mkdir auth.json` in its sign-in directory. Every sign-in
    // after it was dropped, and the console said "signed in".
    ensureLoginDir(loginRoot, SEAT);
    mkdirSync(join(signInFile(), 'locked'), { recursive: true });
    chmodSync(join(signInFile(), 'locked'), 0o000);
    const { spawn, runs } = spawner((cli) => cli.say(GROK_DEVICE));
    const logins = service(xai, spawn);
    expect(await logins.status(SEAT)).toEqual({ state: 'signed-out' });
    await logins.start(SEAT);

    // No sign-in to share, so grok gets no sign-in directory and writes into its home.
    const args = runs()[0]?.args ?? [];
    expect(args.some((arg) => arg.endsWith(':/fleetadlc/auth'))).toBe(false);
    writeFileSync(join(mountAt(args, '/fleetadlc/login'), 'auth.json'), '{"tokens":"new"}');
    runs()[0]?.cli.exit(0);
    await runs()[0]?.cli.exited;

    expect(await logins.status(SEAT)).toEqual({ state: 'signed-in' });
    expect(readFileSync(signInFile(), 'utf8')).toBe('{"tokens":"new"}');
  });

  it('fails with the CLI’s last words when it exits otherwise, and not the code', async () => {
    const { spawn, runs } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn);
    await logins.start(SEAT);

    runs()[0]?.cli.say('Error: device code URPK-DI1GG was declined at https://auth.openai.com/codex/device\n');
    runs()[0]?.cli.exit(1);
    await runs()[0]?.cli.exited;
    const state = await logins.status(SEAT);

    expect(state.state).toBe('failed');
    const message = state.state === 'failed' ? state.message : '';
    expect(message).toContain('was declined');
    expect(message).not.toContain('URPK-DI1GG');
    expect(message).not.toContain('auth.openai.com');
    expect(message.length).toBeLessThanOrEqual(MESSAGE_MAX);
  });

  it('counts a login already in the directory as signed in, whatever the last attempt did', async () => {
    const { spawn, runs } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn);
    await logins.start(SEAT);
    writeSignIn('{"tokens":"not read by anything here"}');

    runs()[0]?.cli.exit(1);
    await runs()[0]?.cli.exited;
    const state = await logins.status(SEAT);

    expect(state).toEqual({ state: 'signed-in' });
    expect(JSON.stringify(state)).not.toContain('not read by anything here');
  });

  it('is signed out when nothing has been started and nothing is there', async () => {
    const { spawn } = spawner();

    expect(await service(openai, spawn).status(SEAT)).toEqual({ state: 'signed-out' });
  });

  it('is stopped after fifteen minutes, when the code has expired anyway', async () => {
    const { spawn, runs, removals } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn, { loginTimeoutMs: 30 });
    await logins.start(SEAT);

    await runs()[0]?.cli.exited;
    const state = await logins.status(SEAT);

    expect(runs()[0]?.cli.killed).toBe(true);
    expect(removals()).toContainEqual(['rm', '-f', `fleetadlc-login-${SEAT}`]);
    expect(state).toMatchObject({ state: 'failed', message: expect.stringMatching(/not finished within 15 minutes/) });
  });

  it('is stopped when the CLI prints no link to show anyone', async () => {
    const { spawn, runs } = spawner((cli) => cli.say('Updating codex…\n'));

    const state = await service(openai, spawn, { codeWaitMs: 30 }).start(SEAT);

    expect(runs()[0]?.cli.killed).toBe(true);
    expect(state).toMatchObject({ state: 'failed', message: expect.stringMatching(/printed no sign-in link/) });
  });

  it('decides what to run from the account row, and refuses anything that is not an OpenAI or xAI seat', async () => {
    const { spawn, runs } = spawner((cli) => cli.say(CODEX_DEVICE));

    await expect(service({ ...openai, kind: 'key' }, spawn).start(SEAT)).rejects.toMatchObject({ status: 400 });
    await expect(service(claude, spawn).start(SEAT)).rejects.toThrow(/claude setup-token/);
    await expect(service(null, spawn).start(SEAT)).rejects.toMatchObject({ status: 404 });
    await expect(service(openai, spawn).start('../../etc')).rejects.toBeInstanceOf(LoginRefused);
    expect(runs()).toHaveLength(0);
  });

  it('writes nothing of the sign-in to a log', async () => {
    const said = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const { spawn, runs } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn);

    await logins.start(SEAT);
    await logins.status(SEAT);
    runs()[0]?.cli.exit(1);
    await runs()[0]?.cli.exited;
    await logins.status(SEAT);

    for (const spy of said) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('URPK-DI1GG');
    }
  });
});

describe('forgetting a login', () => {
  it('stops the sign-in, removes its container and deletes the directory, with the account already gone', async () => {
    const { spawn, runs, removals } = spawner((cli) => cli.say(CODEX_DEVICE));
    const logins = service(openai, spawn);
    await logins.start(SEAT);
    writeSignIn('{}');

    // The bridge removes the row first, so the lookup finds nothing now.
    const after = service(null, spawn);
    await logins.forget(SEAT);
    await after.forget(SEAT);

    expect(runs()[0]?.cli.killed).toBe(true);
    expect(removals().filter((args) => args[2] === `fleetadlc-login-${SEAT}`).length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(loginRoot, SEAT))).toBe(false);
  });

  it('refuses an id that is not an account’s, before a path is built from it', async () => {
    await expect(service(null, spawner().spawn).forget('..')).rejects.toMatchObject({ status: 404 });
  });

  it('waits for a backup’s sign-in being checked, and leaves neither its folder nor its scratch copy behind', async () => {
    let answer: (() => void) | null = null;
    const { spawn } = spawner((cli) => {
      answer = () => {
        cli.say(CODEX_ANSWERED);
        cli.exit(0);
      };
    });
    let present: LoginAccount | null = openai;
    const logins = new LoginService({
      driver: 'docker',
      loginRoot,
      image: 'fleetadlc-bot:latest',
      store: memory(),
      account: async (id) => (present && present.id === id ? present : null),
      spawn,
      now: () => new Date('2026-09-24T08:00:00.000Z'),
    });
    // One a stopped hostd left behind, from before.
    mkdirSync(join(loginRoot, `.adopt-${SEAT}-left`), { recursive: true });

    const adopting = logins.adoptSignIn(SEAT, { 'auth.json': 'e30=' });
    await vi.waitFor(() => expect(answer).not.toBeNull());
    // The bridge removes the row, then asks hostd to forget the login.
    present = null;
    const forgetting = logins.forget(SEAT);
    answer!();

    await expect(adopting).rejects.toMatchObject({ status: 404 });
    await forgetting;
    expect(besideAccounts()).toEqual([]);
  });
});

describe('a backup’s sign-in left mid-check by a hostd that stopped', () => {
  it('is removed at hostd’s start, for every account, and nothing else is', () => {
    mkdirSync(join(loginRoot, `.adopt-${SEAT}-abc123`), { recursive: true });
    writeFileSync(join(loginRoot, `.adopt-${SEAT}-abc123`, 'auth.json'), '{"tokens":"zzz"}');
    ensureLoginDir(loginRoot, SEAT);

    removeAdoptCopies(loginRoot);

    expect(readdirSync(loginRoot)).toEqual([SEAT]);
    expect(() => removeAdoptCopies(join(loginRoot, 'not-there'))).not.toThrow();
  });
});

describe('a sign-in folder, into a backup and back', () => {
  it('is the sign-in file once it is signed in, and nothing before', async () => {
    const logins = service(openai, spawner().spawn);
    ensureLoginDir(loginRoot, SEAT);
    expect(await logins.signInFiles(SEAT)).toBeNull();

    writeSignIn('{"tokens":"zzz"}');
    writeFileSync(join(loginRoot, SEAT, 'history.jsonl'), '{"prompt":"what the crew was asked"}');
    // What a Grok task can plant beside the sign-in, and what an earlier
    // build let one plant at the top of the folder.
    writeFileSync(join(loginRoot, SEAT, 'sign-in', 'CLAUDE.md'), 'PLANTED');
    writeFileSync(join(loginRoot, SEAT, 'lsp.json'), 'PLANTED');
    const files = await logins.signInFiles(SEAT);

    expect(Object.keys(files ?? {})).toEqual(['auth.json']);
    expect(Buffer.from(files?.['auth.json'] ?? '', 'base64').toString()).toBe('{"tokens":"zzz"}');
  });

  it('is taken over by checking a copy of it: what the CLI leaves there moves into the folder the bots mount', async () => {
    const dir = ensureLoginDir(loginRoot, SEAT);
    writeFileSync(join(dir, 'history.jsonl'), '{"prompt":"kept"}');
    const { spawn, runs } = spawner((cli, call) => {
      // The CLI refreshes its sign-in in place, through the file it was given.
      writeFileSync(mountAt(call.args, '/fleetadlc/login/auth.json'), '{"tokens":"zzz-refreshed-zzz"}');
      cli.say(CODEX_ANSWERED);
      cli.exit(0);
    });

    const check = await service(openai, spawn).adoptSignIn(SEAT, { 'auth.json': Buffer.from('{"tokens":"zzz"}').toString('base64') });

    expect(check).toEqual({ ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:00:00.000Z' });
    const run = runs()[0];
    // A home of its own, as every other sign-in container gets, and the
    // copy's sign-in file mounted into it: never the copy as the home.
    expectOwnHome(run?.args ?? []);
    const mounted = mountAt(run?.args ?? [], '/fleetadlc/login/auth.json');
    expect(mounted.startsWith(join(loginRoot, `.adopt-${SEAT}-`))).toBe(true);
    expect(mounted.endsWith(join('sign-in', 'auth.json'))).toBe(true);
    expect(run?.args).toContain(`fleetadlc-adopt-${SEAT}`);
    expect(readFileSync(signInFile(), 'utf8')).toBe('{"tokens":"zzz-refreshed-zzz"}');
    expect(readFileSync(join(dir, 'history.jsonl'), 'utf8')).toBe('{"prompt":"kept"}');
    expect(statSync(signInFile()).mode & 0o777).toBe(0o600);
    // The copy and the home are gone, and nothing else was left beside the folder.
    expect(existsSync(mounted)).toBe(false);
    expect(besideAccounts()).toEqual([SEAT]);
    expect(hasLogin(loginRoot, SEAT)).toBe(true);
  });

  it('checks a Grok sign-in from a backup with a fresh home, and does not load or keep a file planted beside it', async () => {
    // The copy used to be GROK_HOME, and it loaded the CLAUDE.md and LSP
    // server a task had planted beside the account's sign-in.
    const dir = ensureLoginDir(loginRoot, SEAT);
    let seen: { home: string[]; auth: string[]; env: string[] } | null = null;
    const { spawn } = spawner((cli, call) => {
      const home = mountAt(call.args, '/fleetadlc/login');
      const auth = mountAt(call.args, '/fleetadlc/auth');
      seen = {
        home: readdirSync(home),
        auth: readdirSync(auth),
        env: call.args.filter((arg) => /^(GROK_HOME|GROK_AUTH_PATH)=/.test(arg)),
      };
      // Grok refreshes by renaming a new file over auth.json.
      writeFileSync(join(auth, '.auth.json.tmp'), '{"tokens":"grok-refreshed"}');
      renameSync(join(auth, '.auth.json.tmp'), join(auth, 'auth.json'));
      cli.say('{"result":"OK"}');
      cli.exit(0);
    });
    const planted = Buffer.from('PLANTED').toString('base64');

    const check = await service(xai, spawn).adoptSignIn(SEAT, {
      'auth.json': Buffer.from('{"tokens":"grok"}').toString('base64'),
      'CLAUDE.md': planted,
      'lsp.json': planted,
      'trusted_folders.toml': planted,
    });

    expect(check.ok).toBe(true);
    expect(seen).toEqual({ home: ['auth.json'], auth: ['auth.json'], env: ['GROK_HOME=/fleetadlc/login', 'GROK_AUTH_PATH=/fleetadlc/auth/auth.json'] });
    expect(readFileSync(signInFile(), 'utf8')).toBe('{"tokens":"grok-refreshed"}');
    expect(readdirSync(join(dir, 'sign-in'))).toEqual(['auth.json']);
    expect(readdirSync(dir).sort()).toEqual(['sign-in']);
    expect(besideAccounts()).toEqual([SEAT]);
  });

  it('keeps nothing of a sign-in the CLI refuses, and leaves the folder the bots use as it was', async () => {
    ensureLoginDir(loginRoot, SEAT);
    writeSignIn('{"tokens":"zzz-working-zzz"}');
    const { spawn } = spawner((cli) => {
      cli.say(CODEX_REFUSED);
      cli.exit(1);
    });

    const check = await service(openai, spawn).adoptSignIn(SEAT, { 'auth.json': Buffer.from('{"tokens":"zzz-spent-zzz"}').toString('base64') });

    expect(check.ok).toBe(false);
    expect(check.message).toContain('401 Unauthorized');
    expect(readFileSync(signInFile(), 'utf8')).toBe('{"tokens":"zzz-working-zzz"}');
    expect(besideAccounts()).toEqual([SEAT]);
  });

  it('checks a copy on the host under the local driver, with the CLI’s home pointed at it', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(CODEX_ANSWERED);
      cli.exit(0);
    });

    await service(openai, spawn, { driver: 'local' }).adoptSignIn(SEAT, { 'auth.json': 'e30=' });

    const run = runs()[0];
    expect(run?.command).toBe('codex');
    expect(run?.env.CODEX_HOME?.startsWith(join(loginRoot, `.adopt-${SEAT}-`))).toBe(true);
    expect(run?.env.CODEX_HOME?.endsWith('sign-in')).toBe(true);
    expect(readFileSync(signInFile(), 'utf8')).toBe('{}');
  });

  it('is refused for an account with no folder, a file a sign-in is not, and while a sign-in runs', async () => {
    await expect(service(claude, spawner().spawn).adoptSignIn(SEAT, { 'auth.json': 'e30=' })).rejects.toMatchObject({ status: 400 });
    await expect(service(openai, spawner().spawn).adoptSignIn(SEAT, { '../x.json': 'e30=' })).rejects.toMatchObject({ status: 400 });

    const running = service(openai, spawner((cli) => cli.say(CODEX_DEVICE)).spawn);
    await running.start(SEAT);
    await expect(running.adoptSignIn(SEAT, { 'auth.json': 'e30=' })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a sign-in started while it is checked, which the adopted files would write over', async () => {
    let answer: (() => void) | null = null;
    const { spawn, runs } = spawner((cli, call) => {
      if (call.args.includes('--device-auth')) return cli.say(CODEX_DEVICE);
      answer = () => {
        cli.say(CODEX_ANSWERED);
        cli.exit(0);
      };
    });
    const logins = service(openai, spawn);

    const adopting = logins.adoptSignIn(SEAT, { 'auth.json': 'e30=' });
    await vi.waitFor(() => expect(answer).not.toBeNull());
    await expect(logins.start(SEAT)).rejects.toMatchObject({ status: 409 });
    answer!();
    expect((await adopting).ok).toBe(true);

    // Once it has finished, a sign-in starts as before.
    await expect(logins.start(SEAT)).resolves.toMatchObject({ code: 'URPK-DI1GG' });
    expect(runs().filter((run) => run.args.includes('--device-auth'))).toHaveLength(1);
  });
});

describe('verifying an account, under the docker driver', () => {
  it('asks Claude one line with the stored token, named on the command line but valued only in the environment', async () => {
    const { spawn, runs, removals } = spawner((cli) => {
      cli.say(CLAUDE_ANSWERED);
      cli.exit(0);
    });
    const store = memory({ [modelAccountRef(SEAT)]: TOKEN });

    const check = await service(claude, spawn, { store }).verify(SEAT);

    expect(check).toEqual({ ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:00:00.000Z' });
    expect(removals()).toEqual([['rm', '-f', `fleetadlc-verify-${SEAT}`]]);
    const run = runs()[0];
    expect(run?.args).toEqual([
      'run',
      '--rm',
      '--init',
      '--name',
      `fleetadlc-verify-${SEAT}`,
      '-w',
      '/tmp',
      ...OPT_OUTS,
      '-e',
      'CLAUDE_CODE_OAUTH_TOKEN',
      '--entrypoint',
      'claude',
      'fleetadlc-bot:latest',
      '-p',
      'Reply with exactly: OK',
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--model',
      'claude-haiku-4-5',
    ]);
    expect(run?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(run?.args)).not.toContain(TOKEN);
  });

  it('asks codex with the account’s login mounted, as a bot on it would have it', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(CODEX_ANSWERED);
      cli.exit(0);
    });

    const check = await service(openai, spawn).verify(SEAT);

    expect(check.ok).toBe(true);
    const args = runs()[0]?.args ?? [];
    expectOwnHome(args);
    expect(args).toEqual(expect.arrayContaining(['-e', 'CODEX_HOME=/fleetadlc/login']));
    expect(args.slice(args.indexOf('fleetadlc-bot:latest'))).toEqual([
      'fleetadlc-bot:latest',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      'Reply with exactly: OK',
    ]);
  });

  it('asks grok on a leader socket of its own, with its self-update off', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(GROK_NOT_SIGNED_IN);
      cli.exit(1);
    });

    const check = await service(xai, spawn).verify(SEAT);

    expect(check).toMatchObject({ ok: false, message: expect.stringMatching(/^Not signed in\./) });
    const args = runs()[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining(['-e', 'GROK_HOME=/fleetadlc/login', '-e', 'GROK_DISABLE_AUTOUPDATER=1', '--entrypoint', 'grok']),
    );
    expect(args.slice(args.indexOf('fleetadlc-bot:latest') + 1)).toEqual([
      '-p',
      'Reply with exactly: OK',
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--leader-socket',
      '/tmp/grok-leader-verify.sock',
    ]);
  });

  it('presents a key account’s key the way its session would', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(CODEX_ANSWERED);
      cli.exit(0);
    });
    const store = memory({ [modelAccountRef(SEAT)]: KEY });

    await service({ ...openai, kind: 'key' }, spawn, { store }).verify(SEAT);

    const run = runs()[0];
    expect(run?.args).toEqual(expect.arrayContaining(['-e', 'OPENAI_API_KEY']));
    expect(run?.args.some((arg) => arg.includes('/fleetadlc/login'))).toBe(false);
    expect(run?.env.OPENAI_API_KEY).toBe(KEY);
    // By name on the command line, valued only in the docker client's environment.
    expect(run?.args).toEqual(expect.arrayContaining(['-e', 'CODEX_API_KEY']));
    expect(run?.env.CODEX_API_KEY).toBe(KEY);
    expect(run?.args.join(' ')).not.toContain(KEY);
  });

  it('says what to paste when a Claude subscription has no token, and runs nothing', async () => {
    const { spawn, runs } = spawner();

    const check = await service(claude, spawn).verify(SEAT);

    expect(check).toMatchObject({ ok: false, message: expect.stringContaining('claude setup-token') });
    expect(runs()).toHaveLength(0);
  });

  it('gives up after its time, and removes the container', async () => {
    const { spawn, runs, removals } = spawner();

    const check = await service(openai, spawn, { verifyTimeoutMs: 30 }).verify(SEAT);

    expect(check).toMatchObject({ ok: false, message: 'codex did not answer within 0 s' });
    expect(runs()[0]?.cli.killed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(removals().filter((args) => args[2] === `fleetadlc-verify-${SEAT}`)).toHaveLength(2);
  });

  it('reports a refusal in the CLI’s words, without the token', async () => {
    const { spawn } = spawner((cli) => {
      cli.say(JSON.stringify({ type: 'result', is_error: true, result: `OAuth token ${TOKEN} is invalid.` }));
      cli.exit(1);
    });
    const store = memory({ [modelAccountRef(SEAT)]: TOKEN });

    const check = await service(claude, spawn, { store }).verify(SEAT);

    expect(check).toMatchObject({ ok: false, message: 'OAuth token [redacted] is invalid.' });
  });

  it('runs one check at a time for an account', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(CODEX_ANSWERED);
      setTimeout(() => cli.exit(0), 5);
    });
    const logins = service(openai, spawn);

    const [first, second] = await Promise.all([logins.verify(SEAT), logins.verify(SEAT)]);

    expect(runs()).toHaveLength(1);
    expect(second).toEqual(first);
  });
});

describe('reading what `grok models` lists', () => {
  it('takes each id in grok’s order, and which one is its default', () => {
    expect(parseGrokModels(GROK_MODELS)).toEqual({
      models: [
        { id: 'grok-4.7', createdAt: null, isDefault: true },
        { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
        { id: 'grok-4.6', createdAt: null, isDefault: false },
        { id: 'grok-4.5', createdAt: null, isDefault: false },
      ],
      defaultModel: 'grok-4.7',
      signedIn: true,
      status: 'You are logged in with grok.com.',
    });
  });

  it('says so when grok is not signed in, which it lists models for anyway', () => {
    const listed = parseGrokModels(GROK_MODELS_SIGNED_OUT);

    expect(listed.signedIn).toBe(false);
    expect(listed.status).toBe('You are not authenticated.');
    // The list is there, and is not what any seat can call.
    expect(listed.models.map((model) => model.id)).toEqual(['grok-4.6', 'grok-4.5']);
  });

  it('reads through colour, and leaves out an entry that is not a model id', () => {
    const coloured = GROK_MODELS.replace('* grok-4.7 (default)', '\u001b[1m* grok-4.7\u001b[0m (default)').replace(
      '- grok-4.5',
      '- grok-4.5\n  - $(reboot)',
    );

    const listed = parseGrokModels(coloured);

    expect(listed.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
    expect(listed.defaultModel).toBe('grok-4.7');
  });
});

describe('listing an xAI seat’s models, under the docker driver', () => {
  it('runs `grok models` in a throwaway container with the seat’s login, on a leader socket of its own', async () => {
    const { spawn, runs, removals } = spawner((cli) => {
      cli.say(GROK_MODELS);
      cli.exit(0);
    });

    const models = await service(xai, spawn).models(SEAT);

    expect(models.map((model) => [model.id, model.isDefault])).toEqual([
      ['grok-4.7', true],
      ['grok-4.7-build-fast', false],
      ['grok-4.6', false],
      ['grok-4.5', false],
    ]);
    expect(removals()).toEqual([['rm', '-f', `fleetadlc-models-${SEAT}`]]);
    const listed = runs()[0]?.args ?? [];
    expectOwnHome(listed);
    expect(listed.some((arg) => arg.endsWith(':/fleetadlc/auth'))).toBe(false);
    expect(withoutFreshHome(listed)).toEqual([
      'run',
      '--rm',
      '--init',
      '--name',
      `fleetadlc-models-${SEAT}`,
      '-w',
      '/tmp',
      '-v',
      `${join(loginRoot, '.published', SEAT, 'config.toml')}:/fleetadlc/login/config.toml:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'AGENTS.md')}:/fleetadlc/login/AGENTS.md:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'AGENTS.override.md')}:/fleetadlc/login/AGENTS.override.md:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'managed_config.toml')}:/fleetadlc/login/managed_config.toml:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, 'requirements.toml')}:/fleetadlc/login/requirements.toml:ro`,
      '-v',
      `${join(loginRoot, '.published', SEAT, '.env')}:/fleetadlc/login/.env:ro`,
      ...OPT_OUTS,
      '-e',
      'GROK_DISABLE_AUTOUPDATER=1',
      '-e',
      'GROK_HOME=/fleetadlc/login',
      '--entrypoint',
      'grok',
      'fleetadlc-bot:latest',
      'models',
      '--leader-socket',
      '/tmp/grok-leader-models.sock',
    ]);
  });

  it('asks once for everyone inside the window, and again after a failure', async () => {
    let answer = GROK_MODELS_SIGNED_OUT;
    const { spawn, runs } = spawner((cli) => {
      cli.say(answer);
      setTimeout(() => cli.exit(0), 5);
    });
    const logins = service(xai, spawn);

    // Signed out first: a failure, and not remembered.
    await expect(logins.models(SEAT)).rejects.toMatchObject({ status: 502 });
    answer = GROK_MODELS;
    const [first, second] = await Promise.all([logins.models(SEAT), logins.models(SEAT)]);
    const third = await logins.models(SEAT);

    // Signed out is asked twice before it is believed, then once for everyone.
    expect(runs()).toHaveLength(3);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('asks again when grok says it is signed out: it refreshes an expired sign-in while it answers', async () => {
    // Its log: "You are not authenticated." printed, then auth.refresh.success
    // a moment later. The task start refused irisexampleco's review on it.
    const answers = [GROK_MODELS_SIGNED_OUT, GROK_MODELS];
    const { spawn, runs } = spawner((cli) => {
      cli.say(answers.shift() ?? GROK_MODELS);
      setTimeout(() => cli.exit(0), 5);
    });

    const models = await service(xai, spawn).models(SEAT);

    expect(runs()).toHaveLength(2);
    expect(models.map((model) => model.id)).toContain('grok-4.7');
  });

  it('fails a seat grok says is not signed in, rather than listing what the seat cannot call', async () => {
    const { spawn } = spawner((cli) => {
      cli.say(GROK_MODELS_SIGNED_OUT);
      cli.exit(0);
    });

    await expect(service(xai, spawn).models(SEAT)).rejects.toMatchObject({
      status: 502,
      message: 'You are not authenticated — sign this subscription in again on the “Foundation model accounts / API keys” step',
    });
  });

  it('fails with grok’s last words when it exits otherwise, with anything like a secret taken out', async () => {
    const { spawn } = spawner((cli) => {
      cli.say(`Error: could not reach the model list (Bearer abcdefgh12345678)\n`);
      cli.exit(1);
    });

    const error = await service(xai, spawn)
      .models(SEAT)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, message: expect.stringContaining('could not reach the model list') });
    expect((error as Error).message).not.toContain('abcdefgh12345678');
  });

  it('gives up after its time, and removes the container', async () => {
    const { spawn, runs, removals } = spawner();

    await expect(service(xai, spawn, { modelsTimeoutMs: 30 }).models(SEAT)).rejects.toMatchObject({
      status: 502,
      message: 'grok did not list models within 0 s',
    });
    expect(runs()[0]?.cli.killed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(removals().filter((args) => args[2] === `fleetadlc-models-${SEAT}`)).toHaveLength(2);
  });

  it('lists only for an xAI seat, deciding from the account row', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(GROK_MODELS);
      cli.exit(0);
    });

    for (const account of [openai, claude, { ...xai, kind: 'key' as const }]) {
      await expect(service(account, spawn).models(SEAT)).rejects.toMatchObject({ status: 400 });
    }
    await expect(service(null, spawn).models(SEAT)).rejects.toMatchObject({ status: 404 });
    await expect(service(xai, spawn).models('../../etc')).rejects.toMatchObject({ status: 404 });
    expect(runs()).toHaveLength(0);
  });
});

describe('under the local driver, the host’s own CLI', () => {
  let bin: string;
  const savedPath = process.env.PATH;
  const savedDatabase = process.env.DATABASE_URL;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'fleetadlc-fake-cli-'));
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    // hostd holds the platform's database URL; a sign-in must not inherit it.
    process.env.DATABASE_URL = 'postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db';
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabase;
    rmSync(bin, { recursive: true, force: true });
  });

  function fake(name: string, script: string): void {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }

  it('signs codex in with its home at the account’s sign-in directory, with the base environment and nothing of hostd’s', async () => {
    const said = CODEX_DEVICE.replace(/'/g, "'\\''");
    fake(
      'codex',
      `env > "$CODEX_HOME/seen-env"\nprintf '%s' '${said}'\nsleep 0.2\necho '{}' > "$CODEX_HOME/auth.json"\nexit 0`,
    );
    const logins = new LoginService({ driver: 'local', loginRoot, image: 'unused', store: memory(), account: async () => openai });

    const state = await logins.start(SEAT);
    expect(state).toMatchObject({ state: 'waiting', code: 'URPK-DI1GG' });

    // Under the test's own five seconds, so a sign-in that never finishes fails
    // on the state it was left in rather than on the timeout.
    await vi.waitFor(async () => expect(await logins.status(SEAT)).toEqual({ state: 'signed-in' }), { timeout: 3_000, interval: 20 });
    // Codex reads auth.json from its home and from nowhere else.
    const seen = readFileSync(join(loginRoot, SEAT, 'sign-in', 'seen-env'), 'utf8');
    expect(seen).toContain(`CODEX_HOME=${join(loginRoot, SEAT, 'sign-in')}\n`);
    expect(hasLogin(loginRoot, SEAT)).toBe(true);
    expect(seen).not.toContain('DATABASE_URL');
  });

  it('gives each grok check a leader socket of its own, not one on the host’s /tmp', async () => {
    fake('grok', `printf '%s\\n' "$@" > "${bin}/args"\nprintf '%s\\n' '${CLAUDE_ANSWERED}'\nexit 0`);
    const logins = new LoginService({ driver: 'local', loginRoot, image: 'unused', store: memory(), account: async () => xai });

    await logins.verify(SEAT);

    const args = readFileSync(join(bin, 'args'), 'utf8').trim().split('\n');
    const socket = args[args.indexOf('--leader-socket') + 1] ?? '';
    expect(socket).toMatch(/fleetadlc-verify-[^/]+\/grok-leader\.sock$/);
    expect(socket).not.toBe('/tmp/grok-leader-verify.sock');
  });

  it('lists an xAI seat’s models with GROK_HOME at its sign-in directory, on a leader socket of its own', async () => {
    const said = GROK_MODELS.replace(/'/g, "'\\''");
    fake('grok', `printf '%s\\n' "$@" > "${bin}/args"\nenv > "${bin}/env"\nprintf '%s' '${said}'\nexit 0`);
    const logins = new LoginService({ driver: 'local', loginRoot, image: 'unused', store: memory(), account: async () => xai });

    const models = await logins.models(SEAT);

    expect(models.find((model) => model.isDefault)?.id).toBe('grok-4.7');
    const args = readFileSync(join(bin, 'args'), 'utf8').trim().split('\n');
    expect(args.slice(0, 2)).toEqual(['models', '--leader-socket']);
    expect(args[2]).toMatch(/fleetadlc-models-[^/]+\/grok-leader\.sock$/);
    const env = readFileSync(join(bin, 'env'), 'utf8');
    expect(env).toContain(`GROK_HOME=${join(loginRoot, SEAT, 'sign-in')}\n`);
    expect(env).toContain('GROK_DISABLE_AUTOUPDATER=1');
    expect(env).not.toContain('DATABASE_URL');
  });

  it('verifies Claude with the token, in a scratch directory that is gone afterwards', async () => {
    fake(
      'claude',
      `pwd > "${bin}/cwd"\nenv > "${bin}/env"\nprintf '%s\\n' '${CLAUDE_ANSWERED}'\nexit 0`,
    );
    const logins = new LoginService({
      driver: 'local',
      loginRoot,
      image: 'unused',
      store: memory({ [modelAccountRef(SEAT)]: TOKEN }),
      account: async () => claude,
    });

    const check = await logins.verify(SEAT);

    expect(check).toMatchObject({ ok: true, message: 'answered: OK' });
    const env = readFileSync(join(bin, 'env'), 'utf8');
    expect(env).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`);
    expect(env).not.toContain('ANTHROPIC_API_KEY');
    expect(env).not.toContain('DATABASE_URL');
    expect(existsSync(readFileSync(join(bin, 'cwd'), 'utf8').trim())).toBe(false);
  });
});

describe('calling a model from a candidate image, for the engine update', () => {
  const candidate = { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, mount: null, secret: TOKEN };

  it('calls the model a task would, in the image and container named, with the session’s base environment', async () => {
    const { spawn, runs, removals } = spawner((cli) => {
      cli.say(CLAUDE_ANSWERED);
      cli.exit(0);
    });

    const check = await service(claude, spawn).callModel({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      image: 'fleetadlc-bot:candidate',
      name: 'fleetadlc-engines-call-1',
      credential: candidate,
      env: { HOME: '/home/bot', PATH: '/home/bot/.local/bin:/usr/bin:/bin' },
    });

    expect(check).toEqual({ ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:00:00.000Z' });
    expect(removals()).toEqual([['rm', '-f', 'fleetadlc-engines-call-1']]);
    const run = runs()[0];
    expect(run?.args).toEqual([
      'run',
      '--rm',
      '--init',
      '--name',
      'fleetadlc-engines-call-1',
      '-w',
      '/tmp',
      '-e',
      'HOME=/home/bot',
      '-e',
      'PATH=/home/bot/.local/bin:/usr/bin:/bin',
      ...OPT_OUTS,
      '-e',
      'CLAUDE_CODE_OAUTH_TOKEN',
      '--entrypoint',
      'claude',
      'fleetadlc-bot:candidate',
      '-p',
      'Reply with exactly: OK',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      '--model',
      'claude-opus-5-5',
    ]);
    // Valued only in the docker client's environment, never on its command line.
    expect(run?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(run?.args)).not.toContain(TOKEN);
  });

  it('names the model to codex and to grok as their engines do, with a login mounted where a bot has it', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(CODEX_ANSWERED);
      cli.exit(0);
    });
    writeSignIn('{"tokens":"start"}');
    const logins = service(openai, spawn);
    const login = { env: { CODEX_HOME: '/fleetadlc/login' }, mount: join(loginRoot, SEAT), secret: null };

    await logins.callModel({ provider: 'openai', model: 'gpt-5.5-codex', image: 'fleetadlc-bot:candidate', name: 'c-1', credential: login });
    await logins.callModel({
      provider: 'xai',
      model: 'grok-4.7',
      image: 'fleetadlc-bot:candidate',
      name: 'c-2',
      credential: { env: { GROK_HOME: '/fleetadlc/login' }, mount: join(loginRoot, SEAT), secret: null },
    });

    const codex = runs()[0]?.args ?? [];
    expectOwnHome(codex);
    expect(codex).toEqual(expect.arrayContaining(['-e', 'CODEX_HOME=/fleetadlc/login']));
    expect(codex.some((arg) => arg.endsWith(':/fleetadlc/auth'))).toBe(false);
    expect(codex.slice(codex.indexOf('fleetadlc-bot:candidate') + 1)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.5-codex',
      'Reply with exactly: OK',
    ]);
    const grok = runs()[1]?.args ?? [];
    expectOwnHome(grok);
    expect(grok).toEqual(expect.arrayContaining([`${join(loginRoot, SEAT, 'sign-in')}:/fleetadlc/auth`, '-e', 'GROK_AUTH_PATH=/fleetadlc/auth/auth.json']));
    expect(grok.some((arg) => arg.startsWith(`${join(loginRoot, SEAT)}:`))).toBe(false);
    expect(grok.slice(grok.indexOf('fleetadlc-bot:candidate') + 1)).toEqual([
      '-p',
      'Reply with exactly: OK',
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--leader-socket',
      '/tmp/grok-leader-call.sock',
      '--model',
      'grok-4.7',
    ]);
  });

  it('fails on a refusal, in the CLI’s words and without the credential', async () => {
    const { spawn } = spawner((cli) => {
      cli.say(CLAUDE_BAD_TOKEN.replace('invalid.', `invalid: ${TOKEN}`));
      cli.exit(1);
    });

    const check = await service(claude, spawn).callModel({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      image: 'fleetadlc-bot:candidate',
      name: 'fleetadlc-engines-call-1',
      credential: candidate,
    });

    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/^Failed to authenticate\. API Error: 401 OAuth access token is invalid/);
    expect(check.message).not.toContain(TOKEN);
  });
});

describe('a credential a CLI retries being refused', () => {
  /** Claude Code 2.1.282 with a key that is not one, streamed, in the bot image on 2026-09-24. */
  const retry = (attempt: number) =>
    JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt,
      max_retries: 10,
      retry_delay_ms: 581 * attempt,
      error_status: 401,
      error: 'authentication_failed',
    });

  it('is said at Claude’s second refusal, not after its three minutes of retries', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp' });
    expect(credentialRefusal([init, retry(1)].join('\n'))).toBeNull();
    expect(credentialRefusal([init, retry(1), retry(2)].join('\n'))).toBe(
      'the credential was refused (401 authentication_failed)',
    );
  });

  it('is said at codex’s second refusal', () => {
    expect(credentialRefusal(CODEX_REFUSED)).toBe(
      'the credential was refused (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses)',
    );
  });

  it('is not a retry of something that is not the credential', () => {
    const overloaded = JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 2, error_status: 529, error: 'overloaded' });
    expect(credentialRefusal([overloaded, overloaded].join('\n'))).toBeNull();
    expect(credentialRefusal(CODEX_ANSWERED)).toBeNull();
  });

  it('stops the call there, removes its container, and fails it with that reason', async () => {
    const { spawn, runs, removals } = spawner((cli) => {
      cli.say(`${retry(1)}\n`);
      cli.say(`${retry(2)}\n`);
      // Would go on for minutes.
    });

    const check = await service(claude, spawn).callModel({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      image: 'fleetadlc-bot:candidate',
      name: 'fleetadlc-engines-call-1',
      credential: { env: { ANTHROPIC_API_KEY: KEY }, mount: null, secret: KEY },
    });

    expect(check).toEqual({
      ok: false,
      message: 'the credential was refused (401 authentication_failed)',
      checkedAt: '2026-09-24T08:00:00.000Z',
    });
    expect(runs()[0]?.cli.killed).toBe(true);
    expect(removals()).toEqual([
      ['rm', '-f', 'fleetadlc-engines-call-1'],
      ['rm', '-f', 'fleetadlc-engines-call-1'],
    ]);
  });
});

describe('listing an xAI seat’s models in a candidate image', () => {
  it('runs that image’s grok, in a container of its own name, and asks again each time', async () => {
    const { spawn, runs } = spawner((cli) => {
      cli.say(GROK_MODELS);
      cli.exit(0);
    });
    const logins = service(xai, spawn);

    await logins.modelsIn(SEAT, 'fleetadlc-bot:candidate', 'fleetadlc-engines-models');
    await logins.modelsIn(SEAT, 'fleetadlc-bot:candidate', 'fleetadlc-engines-models');
    // What a task reads is still the image in use, and still remembered.
    await logins.models(SEAT);

    expect(runs()).toHaveLength(3);
    expect(runs()[0]?.args).toEqual(expect.arrayContaining(['--name', 'fleetadlc-engines-models', 'fleetadlc-bot:candidate']));
    expect(runs()[2]?.args).toEqual(expect.arrayContaining([`fleetadlc-models-${SEAT}`, 'fleetadlc-bot:latest']));
  });
});
