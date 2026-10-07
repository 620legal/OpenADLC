import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  BackupError,
  checkLoginFiles,
  forgetTaskLogin,
  materialiseLoginConfig,
  prepareTaskLoginHome,
  ensureSignInDir,
  moveSignInIntoPlace,
  publishFreshSignIn,
  publishedLoginConfigPath,
  readLoginFolder,
  regularSignInPath,
  removePublishedLoginConfig,
  removeTree,
  replaceLoginFiles,
  SIGN_IN_DIR,
  signInDir,
  taskLoginHome,
  writeLoginFolder,
  type LoginFiles,
} from '@fleetadlc/backup';
import { modelAccounts } from '@fleetadlc/db';
import { isModelId, modelListCache, type AvailableModel, type ModelListCache } from '@fleetadlc/engines';
import { modelAccountRef, type SecretStore } from '@fleetadlc/github';
import { SECRET_SHAPES, stepNamed, type AccountCheck, type SubscriptionLogin } from '@fleetadlc/shared';
import { hostBaseEnv, telemetryEnv } from './drivers/base-env.js';
import { probeNetworkArgs } from './drivers/docker.js';
import { keyEnv } from './key-env.js';

/**
 * A subscription, signed in once and shared by every bot on it.
 *
 * Several `codex` or `grok` windows on one laptop share one login because they
 * share one home directory. The bots could not: each container started with an
 * empty home, so a bot on a subscription failed its first task, and nothing a
 * person could do from the console changed that. This is the shared place.
 *
 * Each OpenAI or xAI subscription gets one directory, `<loginRoot>/<account>`,
 * and its sign-in is one file in it, `sign-in/auth.json` (`SIGN_IN_DIR`). It
 * is signed in here, from the console, by running the CLI's device sign-in.
 * Under the docker driver no container has the account directory as its
 * home or mounts it. A task's computer gets a home outside its slot, so a
 * file it creates is not the next task's, and it cannot rename the home on
 * the host. A sign-in, a model list, a check, an engine-update call and a
 * backup's restore check get a home of their own the same way, so a plugin a
 * task wrote is not loaded. The sign-in file is shared, not copied: Codex
 * writes it in place through a file mount, and Grok renames a new file over
 * it, so a Grok container also has the sign-in directory, and only that, at
 * `CONTAINER_AUTH` (`GROK_AUTH_PATH`). Codex does not. Under the local driver
 * there is no container, and the sign-in directory is the CLI's home.
 *
 * A Claude subscription needs none of this. `claude setup-token` prints a
 * long-lived token, which is stored like a key and injected as
 * `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * Nothing here logs what a CLI prints. Its output holds the one-time code,
 * and could hold worse; the code reaches the operator in the answer to the
 * call that started the sign-in, and a failure's last lines reach them with
 * the code and anything shaped like a secret taken out.
 */

/** Where a container's own home appears: a task's, a sign-in's or a check's. `CODEX_HOME` or `GROK_HOME` names it. */
export const CONTAINER_LOGIN = '/fleetadlc/login';

/**
 * Where a Grok container sees the account's sign-in directory, so its rename
 * of `auth.json` lands on the account. The directory holds that file and
 * nothing hostd reads besides; it is not `GROK_HOME`. Codex does not get it;
 * Codex's file mount is `CONTAINER_LOGIN/auth.json`.
 */
export const CONTAINER_AUTH = '/fleetadlc/auth';

/** The variable each device-signed-in CLI reads its home from. */
export const LOGIN_HOME_ENV = { openai: 'CODEX_HOME', xai: 'GROK_HOME' } as const;
export type DeviceProvider = keyof typeof LOGIN_HOME_ENV;

/** Whether this provider's subscription signs in by device code into a directory. */
export function isDeviceProvider(provider: string): provider is DeviceProvider {
  return provider === 'openai' || provider === 'xai';
}

/**
 * The login a bot's computer should hold for this account: the account itself
 * when it is an OpenAI or xAI subscription, and none for anything else — a
 * key, a Claude subscription, or no account at all.
 */
export function loginFor(
  account: { id: string; provider: string; kind: string } | null | undefined,
): { accountId: string; provider: DeviceProvider } | null {
  return account?.kind === 'subscription' && isDeviceProvider(account.provider) ? { accountId: account.id, provider: account.provider } : null;
}

/** The CLI a provider's subscription signs in and thinks with. */
const CLI: Record<'anthropic' | DeviceProvider, string> = { anthropic: 'claude', openai: 'codex', xai: 'grok' };

/**
 * Set for grok wherever it runs here. Without it the CLI updates itself, and a
 * bot whose engine changed under it is a change nobody made.
 */
const CLI_ENV: Partial<Record<'anthropic' | DeviceProvider, Record<string, string>>> = {
  xai: { GROK_DISABLE_AUTOUPDATER: '1' },
};

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

/**
 * The account's login directory. Refuses anything that is not an account id
 * before a path is built from it: the id arrives in a URL, and `..` is a
 * directory name too.
 */
export function loginDir(root: string, accountId: string): string {
  if (!isAccountId(accountId)) throw new Error(`${JSON.stringify(accountId)} is not a model account id`);
  return join(resolve(root), accountId.toLowerCase());
}

/**
 * The directory, made by hostd and closed to everyone else.
 *
 * hostd makes it because Docker would otherwise create a missing bind-mount
 * source itself, as root, and the `bot` user inside could not write its login
 * there. 0700 on the root and on the directory, set explicitly: `mkdir`'s mode
 * is filtered by the umask and ignored for a directory that is already there.
 */
export function ensureLoginDir(root: string, accountId: string): string {
  const dir = loginDir(root, accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(resolve(root), 0o700);
  chmodSync(dir, 0o700);
  ensureSignInDir(dir);
  moveSignInIntoPlace(dir);
  return dir;
}

/**
 * Every account's sign-in moved into its sign-in directory, at hostd's start:
 * an earlier build kept it at the top of the account directory, and an
 * account nothing has touched since would otherwise read as signed out.
 */
export function moveSignInsIntoPlace(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isAccountId(name)) continue;
    try {
      ensureLoginDir(root, name);
    } catch (error) {
      console.warn(`[hostd] could not move ${name}'s sign-in into ${SIGN_IN_DIR}/: ${(error as Error).message}`);
    }
  }
}

/**
 * Whether the account's CLI has written a login: a regular `auth.json` in its
 * sign-in directory, where codex keeps one and where grok documents its own.
 * It is a presence check and nothing reads what is in it.
 */
export function hasLogin(root: string, accountId: string): boolean {
  // `existsSync` follows a link. A task that replaced `auth.json` with one
  // left the account looking signed in while the next task got no mount.
  return isAccountId(accountId) && regularSignInPath(loginDir(root, accountId)) !== null;
}

/** Deletes the account's directory, and only ever a directory directly under the root. */
export function removeLoginDir(root: string, accountId: string): void {
  const dir = loginDir(root, accountId);
  const inside = relative(resolve(root), dir);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside !== accountId.toLowerCase()) {
    throw new Error(`refusing to remove ${dir}: it is not an account's directory under ${root}`);
  }
  // A Grok task can leave a directory it made unreadable in the sign-in directory.
  removeTree(dir);
  removePublishedLoginConfig(dir);
}

/**
 * The `-v` arguments that put the sealed home files over the login the
 * container sees.
 *
 * rename(2) onto a bind-mounted file fails with EBUSY, so a read-only mount
 * of each sealed file (`SEALED_LOGIN_FILES`) cannot be replaced and cannot
 * be written in place. A writable copy would still take that in-place write,
 * which is the config this task's CLI loads. The published files are
 * `<login root>/.published/<account>/`, which the container is not given
 * except as these mounts. The sign-in is not one of them: Codex bind-mounts
 * the account's `auth.json`, and Grok renames it in the sign-in directory.
 */
export function loginConfigVolume(loginDir: string): string[] {
  if (!publishedLoginConfigPath(loginDir)) return [];
  return materialiseLoginConfig(loginDir).flatMap((published) => ['-v', `${published}:${CONTAINER_LOGIN}/${basename(published)}:ro`]);
}

/**
 * A task's home and its sign-in, as `-v` arguments.
 *
 * The home is the task's own directory. Codex bind-mounts `auth.json`. Grok
 * also gets the sign-in directory at `CONTAINER_AUTH`, because it renames
 * that file and a file mount would keep the old inode. That directory, not
 * the account's: with the account directory there, files a task planted
 * piled up beside the account's own, a backup carried them, and the restore
 * check loaded them. Codex gets neither.
 */
export function taskLoginMounts(loginDir: string, slotDir: string, provider: DeviceProvider): string[] {
  const home = prepareTaskLoginHome(loginDir, slotDir);
  if (!home) return [];
  const auth = regularSignInPath(loginDir);
  const file = auth ? ['-v', `${auth}:${CONTAINER_LOGIN}/auth.json`] : [];
  const shared = provider === 'xai' && auth ? ['-v', `${signInDir(loginDir)}:${CONTAINER_AUTH}`] : [];
  return ['-v', `${home}:${CONTAINER_LOGIN}`, ...file, ...shared, ...loginConfigVolume(loginDir)];
}

/**
 * The same home and sign-in mount a task gets, for a container that lives
 * for one sign-in, check, model list or engine call, or for a backup's
 * restore check, whose copy is laid out like an account directory.
 *
 * `close` moves a sign-in the CLI created in that home onto the account,
 * then removes the home. It does not throw.
 */
export function openEphemeralLogin(
  loginDir: string,
  provider: DeviceProvider,
): { args: string[]; env: Record<string, string>; close: () => void } {
  const root = resolve(loginDir, '..');
  const slot = join(root, '.once', `once-${randomBytes(6).toString('hex')}`);
  const args = taskLoginMounts(loginDir, slot, provider);
  const home = taskLoginHome(root, slot);
  const env: Record<string, string> = {};
  if (provider === 'xai' && args.some((arg) => arg.endsWith(`:${CONTAINER_AUTH}`))) env.GROK_AUTH_PATH = `${CONTAINER_AUTH}/auth.json`;
  return {
    args,
    env,
    close: () => {
      try {
        if (home) publishFreshSignIn(loginDir, home);
      } catch (error) {
        // The account stays signed out, and says so: `report` reads the file.
        console.warn(`[hostd] a sign-in could not be moved onto ${basename(loginDir)}: ${(error as Error).message}`);
      }
      forgetTaskLogin(root, slot);
    },
  };
}

/**
 * The scratch copies `adoptSignIn` checks a backup's sign-in in, which hold
 * its refresh tokens: every account's, at hostd's start, or one account's
 * when it is forgotten. Only the `finally` that ends a check removed one, and
 * hostd stopping or crashing during the check left it on disk, past the
 * account itself.
 */
export function removeAdoptCopies(root: string, accountId?: string): void {
  const prefix = accountId ? `.adopt-${accountId.toLowerCase()}-` : '.adopt-';
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) if (name.startsWith(prefix)) rmSync(join(root, name), { recursive: true, force: true });
}

// ------------------------------------------------------------------ output

const ANSI = /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/** What a terminal would show: no colour, no cursor movement, no carriage returns. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n');
}

/**
 * The link and the one-time code a device sign-in prints, or null until both
 * have been printed in full.
 *
 * Read from what the CLIs actually print, not from a guess at it:
 *
 *     1. Open this link in your browser and sign in to your account
 *        https://auth.openai.com/codex/device
 *     2. Enter this one-time code (expires in 15 minutes)
 *        URPK-DI1GG
 *
 * and grok's, which also carries the code in the link:
 *
 *       https://accounts.x.ai/oauth2/device?user_code=NAEV-43ZB
 *     Confirm this code in your browser:
 *       NAEV-43ZB
 *
 * Output arrives in chunks, so a link or a code at the very end of what has
 * arrived may be cut short: both have to be followed by more output before
 * they count. Only an https link is taken, because the console renders it as
 * one.
 */
export function parseDeviceAuth(output: string): { url: string; code: string } | null {
  const text = stripAnsi(output);
  const link = /https:\/\/[^\s"'<>`]+(?=\s)/.exec(text)?.[0]?.replace(/[.,;:)\]]+$/, '');
  if (!link) return null;
  try {
    if (new URL(link).protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const standalone = /^[ \t]*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)[ \t]*\n/m.exec(text)?.[1];
  const inLink = /[?&]user_code=([A-Za-z0-9-]+)/.exec(link)?.[1];
  const code = standalone ?? inLink;
  return code ? { url: link, code } : null;
}

/**
 * Anything in a CLI's words that looks like a credential, by the shapes
 * `redactSecrets` masks. The account's own secret is removed by value as well;
 * the shapes catch the ones it was not handed — a refreshed token, an id
 * token, a key in an error message.
 */
export function scrubOutput(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let scrubbed = text;
  for (const secret of secrets) {
    const value = secret?.trim() ?? '';
    if (value.length >= 4) scrubbed = scrubbed.split(value).join('[redacted]');
  }
  for (const shape of SECRET_SHAPES) scrubbed = scrubbed.replace(shape.pattern, '[redacted]');
  return scrubbed;
}

/** The longest message that leaves hostd, which is also what the account row keeps. */
export const MESSAGE_MAX = 400;

/** The end of what a CLI said, scrubbed first so a cut cannot split a secret past the scrubber. */
export function lastWords(output: string, secrets: readonly (string | null | undefined)[] = []): string {
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const said = scrubOutput(lines.join('\n'), secrets).trim();
  return said.length > MESSAGE_MAX ? `…${said.slice(-(MESSAGE_MAX - 1))}` : said;
}

function bounded(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > MESSAGE_MAX ? `${trimmed.slice(0, MESSAGE_MAX - 1)}…` : trimmed;
}

type JsonEvent = Record<string, unknown>;

function jsonEvents(output: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stripAnsi(output).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed as JsonEvent);
    } catch {
      // A line of prose that happens to start with a brace.
    }
  }
  return events;
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const joined = value.filter((one): one is string => typeof one === 'string' && one.trim().length > 0).join(' ');
    return joined || null;
  }
  if (value && typeof value === 'object' && 'message' in value) return textOf((value as { message: unknown }).message);
  return null;
}

/**
 * Whether a one-line prompt was answered, and in whose words.
 *
 * Passing is exit 0 with no event marked `is_error`: `claude -p` exits 1 with
 * `"is_error": true` and `"result": "Not logged in · Please run /login"`, grok
 * reports `{"type":"error","message":"Not signed in. …"}`, and codex ends a
 * refused turn with `turn.failed`. Codex also reports transient `error` events
 * while it retries, so those decide nothing on a run that exited 0.
 */
export function judgeProbe(
  output: string,
  exitCode: number | null,
  secrets: readonly (string | null | undefined)[] = [],
): { ok: boolean; message: string } {
  const events = jsonEvents(output);
  const refused = events.find((event) => event.is_error === true);

  if (exitCode === 0 && !refused) {
    const result = events.find((event) => event.type === 'result' && typeof event.result === 'string');
    const reply =
      textOf(result?.result) ??
      textOf(
        events
          .map((event) => event.item as JsonEvent | undefined)
          .find((item) => item?.type === 'agent_message')?.text,
      );
    return { ok: true, message: bounded(scrubOutput(reply ? `answered: ${reply}` : 'answered', secrets)) };
  }

  const failedTurn = events.findLast((event) => event.type === 'turn.failed');
  const errorEvent = events.findLast((event) => event.type === 'error');
  const words =
    textOf(refused?.result) ??
    textOf(refused?.errors) ??
    textOf(refused?.error) ??
    textOf(failedTurn?.error) ??
    textOf(errorEvent?.message) ??
    // The secret goes in too: scrubbed after the cut, the tail of one no
    // shape matches was left in the message the console and the account row keep.
    (lastWords(output.split('\n').filter((line) => !line.trim().startsWith('{')).join('\n'), secrets) || null);

  return {
    ok: false,
    message: bounded(scrubOutput(words ?? `the CLI exited with ${exitCode ?? 'a signal'}`, secrets)),
  };
}

/**
 * A credential as a CLI is handed it: the variables to set, the login
 * directory to mount at `CONTAINER_LOGIN`, and the secret among the variables,
 * which is scrubbed from anything the CLI says and never put on a command line.
 */
export interface PresentedCredential {
  env: Record<string, string>;
  mount: string | null;
  secret: string | null;
}

/**
 * A credential refused, as a CLI that retries the refusal says it, or null.
 *
 * Measured with a key that is not one, in the bot image on 2026-09-24: Claude
 * Code 2.1.282 answers a 401 with `api_retry` events — ten attempts, backing
 * off to half a minute each, about three minutes before it gives up — and
 * says nothing else until then; codex reports each retry as an `error` event
 * reading "unexpected status 401 Unauthorized". A valid credential is never
 * refused, so the second refusal in a row is the answer, and waiting out the
 * rest only turns it into "did not answer".
 */
export function credentialRefusal(output: string): string | null {
  let refusals = 0;
  let said: string | null = null;
  for (const event of jsonEvents(output)) {
    const status = typeof event.error_status === 'number' ? event.error_status : null;
    if (event.type === 'system' && event.subtype === 'api_retry' && (status === 401 || status === 403)) {
      refusals += 1;
      said = `${status}${typeof event.error === 'string' ? ` ${event.error}` : ''}`;
      continue;
    }
    const text = typeof event.message === 'string' ? event.message : '';
    const codex = event.type === 'error' ? /unexpected status (?:401|403)\b[^)]*/.exec(text)?.[0] : undefined;
    if (codex) {
      refusals += 1;
      said = codex.trim();
    }
  }
  return refusals >= 2 && said ? `the credential was refused (${said})` : null;
}

/** What `grok models` says an account can call. */
export interface CliModelList {
  /** Each model it offers, in its order, the default marked. It dates none. */
  models: AvailableModel[];
  /** The one it calls its default, or null when it names none. */
  defaultModel: string | null;
  /** False when it said it is not signed in — which it does, and lists models anyway. */
  signedIn: boolean;
  /** What it said about the sign-in — the line saying it is not signed in, or else its first. */
  status: string | null;
}

/**
 * Reads `grok models`, as grok 1.0.41 prints it for a SuperGrok seat:
 *
 *     You are logged in with grok.com.
 *
 *     Default model: grok-4.7
 *
 *     Available models:
 *       * grok-4.7 (default)
 *       - grok-4.7-build-fast
 *       - grok-4.6
 *       - grok-4.5
 *
 * Signed out, it exits 0 all the same and still lists models, a shorter list
 * that is not what any account can call:
 *
 *     You are not authenticated.
 *
 *     Default model: grok-4.6
 *
 *     Available models:
 *       * grok-4.6 (default)
 *       - grok-4.5
 *
 * so whether it says it is signed in is part of the answer, and the caller
 * has to look. An entry that is not shaped like a model id is left out rather
 * than passed on: these ids reach an engine's command line and the ledger.
 */
export function parseGrokModels(output: string): CliModelList {
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const refusal = lines.find((line) => /\bnot (?:authenticated|signed in|logged in)\b/i.test(line));
  const named = lines.map((line) => /^default model:\s*(\S+)$/i.exec(line)?.[1]).find((id) => id !== undefined);

  const models: AvailableModel[] = [];
  const start = lines.findIndex((line) => /^available models:?$/i.test(line));
  for (const line of start >= 0 ? lines.slice(start + 1) : []) {
    const entry = /^([*-])\s+(\S+)(.*)$/.exec(line);
    if (!entry) break;
    const [, bullet, id = '', rest = ''] = entry;
    if (!isModelId(id) || models.some((model) => model.id === id)) continue;
    const isDefault = bullet === '*' || /\(default\)/i.test(rest) || id === named;
    models.push({ id, createdAt: null, isDefault });
  }

  const marked = models.find((model) => model.isDefault)?.id ?? null;
  return {
    models,
    defaultModel: marked ?? (named && isModelId(named) ? named : null),
    signedIn: refusal === undefined,
    status: refusal ?? lines[0] ?? null,
  };
}

// ------------------------------------------------------------------ processes

export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A CLI hostd started. Output is stdout and stderr together, as it arrives. */
export interface RunningCli {
  onOutput(listener: (text: string) => void): void;
  readonly exited: Promise<CliExit>;
  kill(): void;
}

export type CliSpawner = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd?: string; stdin: 'pipe' | 'ignore' },
) => RunningCli;

export const spawnCli: CliSpawner = (command, args, options) => {
  const child = spawnProcess(command, args, {
    env: options.env,
    cwd: options.cwd,
    stdio: [options.stdin, 'pipe', 'pipe'],
  });
  const listeners: ((text: string) => void)[] = [];
  const emit = (text: string): void => {
    for (const listener of listeners) listener(text);
  };
  child.stdout?.on('data', (chunk: Buffer) => emit(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => emit(chunk.toString('utf8')));

  const exited = new Promise<CliExit>((resolveExit) => {
    let settled = false;
    const settle = (exit: CliExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(exit);
    };
    child.on('error', (error) => {
      emit(`${command} could not be started: ${error.message}\n`);
      settle({ code: 127, signal: null });
    });
    child.on('close', (code, signal) => settle({ code, signal }));
  });

  return {
    onOutput: (listener) => void listeners.push(listener),
    exited,
    kill: () => {
      child.stdin?.end();
      child.kill('SIGTERM');
    },
  };
};

/** How much of a sign-in's output is kept, from the end. Enough for its last lines. */
const OUTPUT_KEPT = 64 * 1024;

export interface LoginAccount {
  id: string;
  provider: 'anthropic' | 'openai' | 'xai';
  kind: 'key' | 'subscription';
}

/** A request hostd will not act on, with the status the route answers. */
export class LoginRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LoginRefused';
  }
}

/**
 * The CLI was asked what an account can call and did not say. A gateway's
 * status, because the fault is past hostd: the CLI, or the provider behind it.
 * The message is the CLI's own words, scrubbed.
 */
export class ModelListFailed extends LoginRefused {
  constructor(message: string) {
    super(502, message);
    this.name = 'ModelListFailed';
  }
}

interface LoginRun {
  provider: DeviceProvider;
  startedAt: string;
  output: string;
  prompt: { url: string; code: string } | null;
  exit: CliExit | null;
  /** Stopped by the fifteen-minute limit rather than by the CLI. */
  expired: boolean;
  process: RunningCli;
  timer: NodeJS.Timeout;
  /** Settles once the link and code are printed, the CLI exits, or it prints neither in time. */
  ready: Promise<void>;
}

export interface LoginServiceOptions {
  driver: 'docker' | 'local';
  loginRoot: string;
  /** The configured bot image. A sign-in and a check both run in it, as a session would. */
  image: string;
  store: SecretStore;
  /** Read by hostd itself: a caller's word for an account's provider or kind is not taken. */
  account?: (id: string) => Promise<LoginAccount | null>;
  spawn?: CliSpawner;
  now?: () => Date;
  /** How long a sign-in may take to print its link and code. */
  codeWaitMs?: number;
  /** When an unfinished sign-in is stopped. The code has expired by then. */
  loginTimeoutMs?: number;
  /** How long a check may take before it counts as unanswered. */
  verifyTimeoutMs?: number;
  /** How long `grok models` may take before it counts as unanswered. */
  modelsTimeoutMs?: number;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * The docker client's own environment: hostd's, so it finds its context and
 * its socket, plus any secret it is to pass on. The container is given only
 * the variables `-e` names, never this whole environment.
 */
function dockerClientEnv(secrets: Record<string, string> = {}): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...secrets };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms).unref?.());
}

async function readAccount(id: string): Promise<LoginAccount | null> {
  const account = await modelAccounts.get(id);
  return account ? { id: account.id, provider: account.provider, kind: account.kind } : null;
}

/**
 * Signs a subscription in, checks any account, takes over a sign-in from a
 * backup (and hands its files to one), lists an xAI seat's models, makes the
 * engine update's call to a model in a candidate image, and forgets a login.
 *
 * Under the docker driver each that runs a CLI does so in a throwaway
 * container from the bot image — the image the bots think in, with the CLI
 * version they use — and under the local driver on the host, as a local
 * session does.
 */
export class LoginService {
  private readonly runs = new Map<string, LoginRun>();
  private readonly starting = new Map<string, Promise<SubscriptionLogin>>();
  private readonly checking = new Map<string, Promise<AccountCheck>>();
  /** Accounts whose backup sign-in is being checked; a sign-in started then would be written over. */
  private readonly adopting = new Set<string>();
  /** What each xAI seat's CLI last listed, for a few minutes. See `models`. */
  private readonly modelLists: ModelListCache = modelListCache();
  private readonly spawn: CliSpawner;
  private readonly account: (id: string) => Promise<LoginAccount | null>;
  private readonly now: () => Date;

  constructor(private readonly options: LoginServiceOptions) {
    this.spawn = options.spawn ?? spawnCli;
    this.account = options.account ?? readAccount;
    this.now = options.now ?? (() => new Date());
  }

  private async known(accountId: string): Promise<LoginAccount> {
    const account = isAccountId(accountId) ? await this.account(accountId) : null;
    if (!account) throw new LoginRefused(404, `no model account ${accountId}`);
    return account;
  }

  /** Only an OpenAI or xAI subscription has a device sign-in. */
  private async deviceAccount(accountId: string): Promise<LoginAccount & { provider: DeviceProvider }> {
    const account = await this.known(accountId);
    if (account.kind !== 'subscription') {
      throw new LoginRefused(400, 'an API key account has nothing to sign in to — its key is the credential');
    }
    if (!isDeviceProvider(account.provider)) {
      throw new LoginRefused(
        400,
        'a Claude subscription does not sign in here — run `claude setup-token` and paste the token it prints on the account',
      );
    }
    return account as LoginAccount & { provider: DeviceProvider };
  }

  private async removeContainer(name: string): Promise<void> {
    await this.spawn('docker', ['rm', '-f', name], { env: dockerClientEnv(), stdin: 'ignore' }).exited.catch(
      () => undefined,
    );
  }

  /**
   * Starts the CLI's device sign-in, in a home of its own, for the account, and
   * answers with the link and the one-time code once it has printed them.
   * One sign-in per account: asked again while one is running, this answers
   * with that one rather than starting a second.
   */
  start(accountId: string): Promise<SubscriptionLogin> {
    const key = accountId.toLowerCase();
    const pending = this.starting.get(key);
    if (pending) return pending;
    const attempt = this.begin(accountId).finally(() => this.starting.delete(key));
    this.starting.set(key, attempt);
    return attempt;
  }

  private async begin(accountId: string): Promise<SubscriptionLogin> {
    const account = await this.deviceAccount(accountId);
    const id = account.id.toLowerCase();

    const current = this.runs.get(id);
    if (current && !current.exit) return this.report(id);
    // The other way round from `adopt`'s refusal: the adopted files would go
    // over this sign-in's, and its run be forgotten while the CLI went on.
    if (this.adopting.has(id)) {
      throw new LoginRefused(409, 'a sign-in from a backup is being checked for this account; try again once it has finished');
    }

    const dir = ensureLoginDir(this.options.loginRoot, id);
    const home = LOGIN_HOME_ENV[account.provider];
    const extra = { ...telemetryEnv(), ...(CLI_ENV[account.provider] ?? {}) };
    const cli = CLI[account.provider];

    let spawned: RunningCli;
    // A home of this sign-in's own. The account directory used to be
    // GROK_HOME, so a plugin a task had written there was loaded, and a
    // fresh sign-in left it in place.
    const opened = this.options.driver === 'docker' ? openEphemeralLogin(dir, account.provider) : null;
    if (opened) {
      const name = `fleetadlc-login-${id}`;
      // A container of this name is from a sign-in hostd no longer knows
      // about — it restarted, or the last one was never cleaned up.
      await this.removeContainer(name);
      spawned = this.spawn(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          // The CLI would be PID 1, which ignores SIGTERM unless it handles it
          // itself; an init process passes the signal on, so stopping a
          // sign-in stops it.
          '--init',
          '--name',
          name,
          ...probeNetworkArgs(),
          ...opened.args,
          '-e',
          `${home}=${CONTAINER_LOGIN}`,
          ...Object.entries({ ...extra, ...opened.env }).flatMap(([variable, value]) => ['-e', `${variable}=${value}`]),
          '--entrypoint',
          cli,
          this.options.image,
          'login',
          '--device-auth',
        ],
        { env: dockerClientEnv(), stdin: 'pipe' },
      );
    } else {
      // The host's CLI, with the same base environment a local session gets
      // and never hostd's own, which holds the platform's database.
      spawned = this.spawn(cli, ['login', '--device-auth'], {
        env: { ...hostBaseEnv(), [home]: signInDir(dir), ...extra },
        stdin: 'pipe',
      });
    }

    let markReady: () => void = () => undefined;
    const run: LoginRun = {
      provider: account.provider,
      startedAt: this.now().toISOString(),
      output: '',
      prompt: null,
      exit: null,
      expired: false,
      process: spawned,
      timer: setTimeout(() => {
        run.expired = true;
        void this.stop(id, run);
      }, this.options.loginTimeoutMs ?? FIFTEEN_MINUTES),
      ready: new Promise<void>((resolveReady) => {
        markReady = resolveReady;
      }),
    };
    run.timer.unref?.();
    this.runs.set(id, run);

    spawned.onOutput((text) => {
      run.output = (run.output + text).slice(-OUTPUT_KEPT);
      if (!run.prompt) {
        run.prompt = parseDeviceAuth(run.output);
        if (run.prompt) markReady();
      }
    });
    void spawned.exited.then((exit) => {
      opened?.close();
      run.exit = exit;
      clearTimeout(run.timer);
      markReady();
    });

    // A CLI that prints no link has nothing to show the operator. Stopped
    // rather than left running, so the next attempt starts clean.
    const wait = this.options.codeWaitMs ?? 45_000;
    const quiet = setTimeout(() => {
      if (run.prompt || run.exit) return;
      void this.stop(id, run);
      markReady();
    }, wait);
    quiet.unref?.();
    await run.ready;
    clearTimeout(quiet);

    return this.report(id);
  }

  private async stop(id: string, run: LoginRun): Promise<void> {
    clearTimeout(run.timer);
    run.process.kill();
    if (this.options.driver === 'docker') await this.removeContainer(`fleetadlc-login-${id}`);
  }

  private async report(id: string): Promise<SubscriptionLogin> {
    const run = this.runs.get(id);
    if (run && !run.exit) {
      await run.ready;
      if (run.prompt && !run.exit) {
        return { state: 'waiting', url: run.prompt.url, code: run.prompt.code, startedAt: run.startedAt };
      }
      // Stopped for printing no link in time: give it a moment to go, and
      // say what it did print either way.
      if (!run.exit) await Promise.race([run.process.exited, pause(5_000)]);
      if (!run.exit) return { state: 'failed', message: this.failure(run) };
    }

    // The file, not the exit code. A sign-in that exited 0 but could not be
    // moved onto the account (a task had made a directory where it goes)
    // said "signed in" while every task got no sign-in.
    if (hasLogin(this.options.loginRoot, id)) return { state: 'signed-in' };
    if (run?.exit && run.exit.code !== 0) return { state: 'failed', message: this.failure(run) };
    return { state: 'signed-out' };
  }

  private failure(run: LoginRun): string {
    if (run.expired) {
      return 'the sign-in was not finished within 15 minutes, so its code has expired — sign in again for a new one';
    }
    // The code and its link are useless by now, and still not something to
    // repeat to anyone.
    const said = lastWords(run.output, [run.prompt?.code, run.prompt?.url]);
    if (!run.prompt) return said ? `the CLI printed no sign-in link: ${said}` : 'the CLI printed no sign-in link';
    return said || `the sign-in exited with ${run.exit?.code ?? run.exit?.signal ?? 'an error'}`;
  }

  /** Where the account's sign-in stands, without starting anything. */
  async status(accountId: string): Promise<SubscriptionLogin> {
    const account = await this.deviceAccount(accountId);
    return this.report(account.id.toLowerCase());
  }

  /**
   * Stops any sign-in and deletes the account's directory. The account row is
   * already gone when the bridge asks, so this does not look for it.
   */
  async forget(accountId: string): Promise<void> {
    if (!isAccountId(accountId)) throw new LoginRefused(404, `no model account ${accountId}`);
    const id = accountId.toLowerCase();
    const run = this.runs.get(id);
    this.runs.delete(id);
    if (run) await this.stop(id, run);
    else if (this.options.driver === 'docker') await this.removeContainer(`fleetadlc-login-${id}`);
    // A check or an adopt still running would make the folder again after it
    // was removed, for an account that is gone.
    await this.checking.get(id)?.catch(() => undefined);
    removeLoginDir(this.options.loginRoot, id);
    removeAdoptCopies(resolve(this.options.loginRoot), id);
  }

  /**
   * The account's sign-in as files a backup can carry — its sign-in file and
   * the sealed files, when it is signed in — or null when it is not. Read here
   * because the folder is hostd's; the bridge only passes it on, into an
   * archive the person downloading it has sealed.
   */
  async signInFiles(accountId: string): Promise<LoginFiles | null> {
    const account = await this.deviceAccount(accountId);
    return readLoginFolder(loginDir(this.options.loginRoot, account.id));
  }

  /**
   * Takes over a subscription's sign-in from a backup, which is checking it
   * the only way it can be checked: by using it.
   *
   * The files go into a scratch copy beside the account's folder — never into
   * the folder itself, which every bot on the account has mounted — and the
   * account's check runs against the copy, holding it exactly as a session
   * would, in a throwaway container: one line to the CLI, as `verify` asks.
   * A CLI refreshes its sign-in as it uses it, so what it leaves in the copy
   * is the sign-in as it stands now. Only when it answered are those files
   * moved into the account's folder, each by a rename that replaces it whole;
   * when it did not, the copy goes and nothing of it is kept, so a sign-in
   * that works here is never put over by one that does not.
   *
   * Refused while a sign-in is running for the account: that one would write
   * over it. One at a time per account, as a check is.
   */
  adoptSignIn(accountId: string, files: LoginFiles): Promise<AccountCheck> {
    const key = accountId.toLowerCase();
    const pending = this.checking.get(key);
    if (pending) return pending.catch(() => undefined).then(() => this.adoptSignIn(accountId, files));
    this.adopting.add(key);
    const attempt = this.adopt(accountId, files).finally(() => {
      this.checking.delete(key);
      this.adopting.delete(key);
    });
    this.checking.set(key, attempt);
    return attempt;
  }

  private async adopt(accountId: string, files: LoginFiles): Promise<AccountCheck> {
    const account = await this.deviceAccount(accountId);
    const id = account.id.toLowerCase();
    const running = this.runs.get(id);
    if (running && !running.exit) {
      throw new LoginRefused(409, 'a sign-in is running for this account; finish it or let it expire, then restore again');
    }
    try {
      checkLoginFiles(files);
    } catch (error) {
      if (error instanceof BackupError) throw new LoginRefused(400, error.message);
      throw error;
    }
    const checkedAt = (): string => this.now().toISOString();

    // Beside the account's own, so the one directory Docker is given for
    // sign-ins holds it too. Hidden, and not an account id, so nothing takes
    // it for an account's folder.
    const root = resolve(this.options.loginRoot);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const copy = mkdtempSync(join(root, `.adopt-${id}-`));
    try {
      chmodSync(copy, 0o700);
      writeLoginFolder(copy, files);
      const home = LOGIN_HOME_ENV[account.provider];
      const presented: PresentedCredential =
        this.options.driver === 'docker'
          ? { env: { [home]: CONTAINER_LOGIN }, mount: copy, secret: null }
          : { env: { [home]: signInDir(copy) }, mount: null, secret: null };

      const limit = this.options.verifyTimeoutMs ?? 120_000;
      const run = await this.runOnce(account, presented, {
        purpose: 'adopt',
        args: (leaderSocket) => probeArgs(account.provider, leaderSocket),
        timeoutMs: limit,
        refusedWhen: credentialRefusal,
      });
      if (run.refused) return { ok: false, message: bounded(scrubOutput(run.refused)), checkedAt: checkedAt() };
      if (run.timedOut) {
        return { ok: false, message: `${CLI[account.provider]} did not answer within ${Math.round(limit / 1000)} s`, checkedAt: checkedAt() };
      }
      const verdict = judgeProbe(run.output, run.exit.code);
      if (!verdict.ok) return { ...verdict, checkedAt: checkedAt() };

      const kept = readLoginFolder(copy);
      if (!kept) return { ok: false, message: 'the CLI answered, but left no sign-in behind', checkedAt: checkedAt() };
      // Removed while it was checked: its folder is not made again.
      if (!(await this.account(id))) throw new LoginRefused(404, `no model account ${id}`);
      try {
        replaceLoginFiles(ensureLoginDir(root, id), kept);
      } catch (error) {
        if (error instanceof BackupError) throw new LoginRefused(409, error.message);
        throw error;
      }
      // Only the finished run it saw at the start, whose status the adopted
      // files now answer.
      if (this.runs.get(id) === running) this.runs.delete(id);
      return { ...verdict, checkedAt: checkedAt() };
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }

  /** Every sign-in still running, stopped. For hostd's shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.entries()].filter(([, run]) => !run.exit).map(([id, run]) => this.stop(id, run)));
  }

  /**
   * Runs the account's CLI with a one-line prompt, holding exactly the
   * credential a session on it would be given, and says whether it answered.
   * One check per account at a time; asked again, this answers with the one
   * already running.
   */
  verify(accountId: string): Promise<AccountCheck> {
    const key = accountId.toLowerCase();
    const pending = this.checking.get(key);
    if (pending) return pending;
    const attempt = this.probe(accountId).finally(() => this.checking.delete(key));
    this.checking.set(key, attempt);
    return attempt;
  }

  private async probe(accountId: string): Promise<AccountCheck> {
    const account = await this.known(accountId);
    const checkedAt = (): string => this.now().toISOString();

    const presented = await this.credentialFor(account);
    if ('refusal' in presented) return { ok: false, message: presented.refusal, checkedAt: checkedAt() };

    const limit = this.options.verifyTimeoutMs ?? 120_000;
    const run = await this.runOnce(account, presented, {
      purpose: 'verify',
      args: (leaderSocket) => probeArgs(account.provider, leaderSocket),
      timeoutMs: limit,
    });
    if (run.timedOut) {
      return {
        ok: false,
        message: `${CLI[account.provider]} did not answer within ${Math.round(limit / 1000)} s`,
        checkedAt: checkedAt(),
      };
    }
    const verdict = judgeProbe(run.output, run.exit.code, presented.secret ? [presented.secret] : []);
    return { ...verdict, checkedAt: checkedAt() };
  }

  /**
   * What an xAI subscription can call, in its own CLI's words: `grok models`,
   * run the way a check is — in a throwaway container from the bot image,
   * with the account's login mounted where a bot has it, on a leader socket
   * of its own.
   *
   * Remembered per account for as long as a key's list is, so a task start
   * and the picker that asks straight after it cost one container between
   * them, and callers that arrive together share one run. A failure is not
   * remembered. Signed out, grok still lists models — an older, shorter list
   * nothing can call — so that answer is a failure too, rather than a list
   * that would resolve `newest:grok` to a model the seat cannot run.
   *
   * Only an xAI seat is asked here. A key lists with its key, a Claude seat
   * with its token, and an OpenAI seat has nothing that lists what a ChatGPT
   * plan can call.
   */
  async models(accountId: string): Promise<AvailableModel[]> {
    const account = await this.xaiSeat(accountId);
    return this.modelLists.modelsFor(account.id.toLowerCase(), () => this.listCliModels(account));
  }

  /**
   * What an xAI seat's CLI in another image lists — a candidate bot image,
   * before anything runs on it. Asked afresh and not remembered: the answer
   * is that image's, and a task still reads the one its own image gives.
   */
  async modelsIn(accountId: string, image: string, name: string): Promise<AvailableModel[]> {
    return this.listCliModels(await this.xaiSeat(accountId), { image, name });
  }

  private async xaiSeat(accountId: string): Promise<LoginAccount> {
    const account = await this.known(accountId);
    if (account.kind !== 'subscription' || account.provider !== 'xai') {
      throw new LoginRefused(
        400,
        'only an xAI subscription lists its models through its CLI — a key lists with the key, ' +
          'and a Claude subscription with its token',
      );
    }
    return account;
  }

  private async listCliModels(
    account: LoginAccount,
    where: { image?: string; name?: string } = {},
  ): Promise<AvailableModel[]> {
    const presented = await this.credentialFor(account);
    if ('refusal' in presented) throw new ModelListFailed(presented.refusal);

    // Under a second in the bot image. A task start waits on this before it
    // falls back to trusting a pinned id, so it is not given a check's two
    // minutes.
    const limit = this.options.modelsTimeoutMs ?? 30_000;
    const secrets = presented.secret ? [presented.secret] : [];
    const ask = async (): Promise<CliModelList> => {
      const run = await this.runOnce(account, presented, {
        purpose: 'models',
        args: (leaderSocket) => ['models', '--leader-socket', leaderSocket],
        timeoutMs: limit,
        ...where,
      });
      if (run.timedOut) throw new ModelListFailed(`grok did not list models within ${Math.round(limit / 1000)} s`);
      if (run.exit.code !== 0) {
        const said = lastWords(run.output, secrets);
        throw new ModelListFailed(said || `grok models exited with ${run.exit.code ?? run.exit.signal}`);
      }
      return parseGrokModels(run.output);
    };

    // Asked twice before it is believed signed out. grok refreshes an expired
    // sign-in while it answers, and answers from before the refresh: its own
    // log had "auth.refresh.success" a moment after it printed "You are not
    // authenticated." A task start refused a seat that was signed in, and the
    // account's check went red and green again with nobody touching it.
    // Asked again, it answers from after.
    let listed = await ask();
    if (!listed.signedIn) listed = await ask();
    if (!listed.signedIn) {
      const said = scrubOutput(listed.status ?? 'grok says it is not signed in', secrets).replace(/[.\s]+$/, '');
      throw new ModelListFailed(`${said} — sign this subscription in again on ${stepNamed('models')}`);
    }
    if (listed.models.length === 0) {
      throw new ModelListFailed(`grok listed no models: ${listed.status ? scrubOutput(listed.status, secrets) : 'it printed nothing'}`);
    }
    return listed.models;
  }

  /**
   * The smallest real call a task makes: one line to `model`, through the
   * provider's CLI in `image`, holding `credential` — which the caller reads
   * the way a session's is read, so it is the credential a task on it gets.
   * The weekly engine update asks this of a candidate image for every model
   * the crew uses, before any bot runs on it. The answer is judged as a check
   * is, in the CLI's own words with the credential taken out.
   */
  async callModel(input: {
    provider: LoginAccount['provider'];
    model: string;
    image: string;
    /** The throwaway container's name; the caller's, so its runs can be told apart and cleaned up. */
    name: string;
    credential: PresentedCredential;
    /** What a session has before any credential, such as its PATH and home. Never a secret. */
    env?: Record<string, string>;
  }): Promise<AccountCheck> {
    const checkedAt = (): string => this.now().toISOString();
    const limit = this.options.verifyTimeoutMs ?? 120_000;
    const secrets = input.credential.secret ? [input.credential.secret] : [];
    const run = await this.runOnce({ id: input.name, provider: input.provider }, input.credential, {
      purpose: 'call',
      args: (leaderSocket) => probeArgs(input.provider, leaderSocket, { model: input.model, stream: true }),
      timeoutMs: limit,
      image: input.image,
      name: input.name,
      ...(input.env ? { env: input.env } : {}),
      refusedWhen: credentialRefusal,
    });
    if (run.refused) {
      return { ok: false, message: bounded(scrubOutput(run.refused, secrets)), checkedAt: checkedAt() };
    }
    if (run.timedOut) {
      return {
        ok: false,
        message: `${CLI[input.provider]} did not answer within ${Math.round(limit / 1000)} s`,
        checkedAt: checkedAt(),
      };
    }
    return { ...judgeProbe(run.output, run.exit.code, secrets), checkedAt: checkedAt() };
  }

  /**
   * Runs the account's CLI once, holding the credential a session would, and
   * collects what it prints. Under the docker driver that is a throwaway
   * container from the bot image named for what it is doing, removed first in
   * case a hostd that restarted left one; on the host it is the host's CLI in
   * a scratch directory that goes when it does. Either way grok is given a
   * leader socket nobody else uses, so a check or a listing neither joins nor
   * starts the leader a bot's session is on.
   *
   * The image, the container's name and a base environment can be given, for
   * the engine update trying a candidate image; otherwise it is the configured
   * image, a name from the purpose and the account, and nothing more.
   */
  private async runOnce(
    account: Pick<LoginAccount, 'id' | 'provider'>,
    presented: PresentedCredential,
    task: {
      purpose: 'verify' | 'models' | 'call' | 'adopt';
      args: (leaderSocket: string) => string[];
      timeoutMs: number;
      image?: string;
      name?: string;
      env?: Record<string, string>;
      /** An answer the output already gives, before the CLI has finished saying it; the run is stopped there. */
      refusedWhen?: (output: string) => string | null;
    },
  ): Promise<{ output: string; exit: CliExit; timedOut: boolean; refused: string | null }> {
    const id = account.id.toLowerCase();
    const cli = CLI[account.provider];
    const env = { ...(task.env ?? {}), ...telemetryEnv(), ...(CLI_ENV[account.provider] ?? {}), ...presented.env };

    let spawned: RunningCli;
    let scratch: string | null = null;
    let closeLogin = (): void => undefined;
    const name = task.name ?? `fleetadlc-${task.purpose}-${id}`;
    const loginArgs = (): string[] => {
      if (!presented.mount || !isDeviceProvider(account.provider)) return [];
      // A home of this run's own, an adopt copy's check included. The copy
      // was its home, and it loaded a CLAUDE.md and an LSP server a task had
      // planted beside the sign-in, which a backup then carried.
      const opened = openEphemeralLogin(presented.mount, account.provider);
      Object.assign(env, opened.env);
      closeLogin = opened.close;
      return opened.args;
    };
    if (this.options.driver === 'docker') {
      // The container's own /tmp, which nothing else shares.
      const args = task.args(`/tmp/grok-leader-${task.purpose}.sock`);
      await this.removeContainer(name);
      const secretNames = presented.secret ? Object.keys(presented.env) : [];
      spawned = this.spawn(
        'docker',
        [
          'run',
          '--rm',
          '--init',
          '--name',
          name,
          ...probeNetworkArgs(),
          '-w',
          '/tmp',
          ...loginArgs(),
          // A secret is named here and valued in the docker client's own
          // environment, so it is not on a command line anyone can read in
          // the process list.
          ...Object.entries(env).flatMap(([variable, value]) =>
            secretNames.includes(variable) ? ['-e', variable] : ['-e', `${variable}=${value}`],
          ),
          '--entrypoint',
          cli,
          task.image ?? this.options.image,
          ...args,
        ],
        { env: dockerClientEnv(presented.secret ? presented.env : {}), stdin: 'ignore' },
      );
    } else {
      // On the host a fixed socket path would be one leader for every run at
      // once; each gets its own in its own scratch directory, as the grok
      // engine gives each session one.
      scratch = mkdtempSync(join(tmpdir(), `fleetadlc-${task.purpose}-`));
      const args = task.args(join(scratch, 'grok-leader.sock'));
      spawned = this.spawn(cli, args, { env: { ...hostBaseEnv(), ...env }, cwd: scratch, stdin: 'ignore' });
    }

    let output = '';
    let refused: string | null = null;
    spawned.onOutput((text) => {
      output = (output + text).slice(-OUTPUT_KEPT);
      if (refused || !task.refusedWhen) return;
      refused = task.refusedWhen(output);
      if (!refused) return;
      spawned.kill();
      if (this.options.driver === 'docker') void this.removeContainer(name);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawned.kill();
      if (this.options.driver === 'docker') void this.removeContainer(name);
    }, task.timeoutMs);
    timer.unref?.();

    try {
      const exit = await spawned.exited;
      return { output, exit, timedOut, refused };
    } finally {
      clearTimeout(timer);
      closeLogin();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * The credential a session on this account would be given, as environment
   * and a mount. What `session-env.ts` injects, for the same account.
   */
  private async credentialFor(account: LoginAccount): Promise<PresentedCredential | { refusal: string }> {
    if (account.kind === 'key') {
      const key = (await this.options.store.get(modelAccountRef(account.id)))?.trim() ?? '';
      if (!key) return { refusal: 'this account has no key stored' };
      // Under every name the session gives it: Codex reads CODEX_API_KEY.
      return { env: keyEnv(KEY_ENV[account.provider], key), mount: null, secret: key };
    }

    if (account.provider === 'anthropic') {
      const token = (await this.options.store.get(modelAccountRef(account.id)))?.trim() ?? '';
      if (!token) {
        return {
          refusal:
            'no token is stored for this subscription — run `claude setup-token` on a machine signed in to it and paste the token it prints',
        };
      }
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, mount: null, secret: token };
    }

    const dir = ensureLoginDir(this.options.loginRoot, account.id);
    const home = LOGIN_HOME_ENV[account.provider];
    return this.options.driver === 'docker'
      ? { env: { [home]: CONTAINER_LOGIN }, mount: dir, secret: null }
      : { env: { [home]: signInDir(dir) }, mount: null, secret: null };
  }
}

/** The variable a key is presented as, per provider — what a session sets for a key account. */
const KEY_ENV: Record<LoginAccount['provider'], string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
};

const PROMPT = 'Reply with exactly: OK';

/**
 * One tiny prompt, headless, allowed one turn. Haiku for Claude, because the
 * question is whether the credential answers, not how well. Grok gets a
 * leader socket of its own, so the check neither joins nor starts the one a
 * bot's session is using.
 *
 * Given a model, it is that model's call instead — the engine update's
 * question is whether this CLI can call what a task on it will, and "Newest
 * Opus" moving to an id an older Claude Code refused is how that was learned.
 * Streamed, Claude says a refused credential as it retries it rather than
 * minutes later; see `credentialRefusal`.
 */
export function probeArgs(
  provider: LoginAccount['provider'],
  leaderSocket: string,
  options: { model?: string; stream?: boolean } = {},
): string[] {
  const { model } = options;
  switch (provider) {
    case 'anthropic':
      return [
        '-p',
        PROMPT,
        '--output-format',
        ...(options.stream ? ['stream-json', '--verbose'] : ['json']),
        '--max-turns',
        '1',
        '--model',
        model ?? 'claude-haiku-4-5',
      ];
    case 'openai':
      return [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        ...(model ? ['--model', model] : []),
        PROMPT,
      ];
    case 'xai':
      return [
        '-p',
        PROMPT,
        '--output-format',
        'json',
        '--max-turns',
        '1',
        '--leader-socket',
        leaderSocket,
        ...(model ? ['--model', model] : []),
      ];
  }
}
