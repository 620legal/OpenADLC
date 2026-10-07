import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { envOr } from '@fleetadlc/shared';
import { GcpSecretStore } from './gcp-secrets.js';

/**
 * Where a self-hosted install keeps secret material. Local installs use files
 * with 0600 permissions under $FLEETADLC_HOME; cloud installs swap in the provider's
 * secret manager behind the same interface. Nothing secret is ever written to a
 * bot container's disk: hostd reads from here and injects into the session env.
 */
export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export function fleetHome(): string {
  return envOr('FLEETADLC_HOME', join(homedir(), '.fleetadlc'));
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly root = join(fleetHome(), 'secrets')) {}

  private path(ref: string): string {
    if (!/^[a-zA-Z0-9._:-]+$/.test(ref)) throw new Error(`invalid secret ref: ${ref}`);
    return join(this.root, `${ref.replace(/:/g, '__')}.secret`);
  }

  async get(ref: string): Promise<string | null> {
    const path = this.path(ref);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').trim();
  }

  /**
   * Written beside the target, synced, then renamed over it. Written in place,
   * a crash mid-write left a truncated secret: for a rotated refresh token that
   * is a sign-in GitHub refuses, and a person redoing the device flow.
   */
  async set(ref: string, value: string): Promise<void> {
    const path = this.path(ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, `${value}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  async delete(ref: string): Promise<void> {
    const path = this.path(ref);
    if (existsSync(path)) rmSync(path);
  }

  async list(prefix = ''): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const { readdirSync } = await import('node:fs');
    return readdirSync(this.root)
      .filter((file) => file.endsWith('.secret'))
      .map((file) => file.replace(/\.secret$/, '').replace(/__/g, ':'))
      .filter((ref) => ref.startsWith(prefix))
      .sort();
  }
}

/** Refresh tokens are per bot, so a revocation is scoped to one identity. */
export function refreshTokenRef(bot: string): string {
  return `github-refresh-${bot}`;
}

/** Only set when the app has token expiry disabled (no refresh token is issued). */
export function accessTokenRef(bot: string): string {
  return `github-token-${bot}`;
}

/**
 * The GitHub App's private key.
 *
 * The one credential in the install that is not per bot, and the widest: it
 * mints installation tokens, which carry the app's permissions without being
 * intersected by any account's access, so it can write to and administer every
 * repository the app is installed on. The merge line, the `review-gate` check,
 * the rulesets, the webhook's setup and the crew's invitations all need it; an
 * install without one never merges anything.
 *
 * Server-side only, and never handed to a task. The bridge reads it, and the
 * CLI's backup and restore carry it with the rest of the secret store.
 */
export function appPrivateKeyRef(): string {
  return 'github-app-private-key';
}

/**
 * The webhook's signing secret.
 *
 * The one thing that makes a GitHub delivery trusted, and a trusted delivery
 * can answer a gate as the login it names. It was a row in the settings table,
 * and so in every database dump; it lives here, with the app's key. The
 * bridge reads it on every delivery, and moves an older install's row here
 * when it starts (`moveWebhookSecretToStore`).
 */
export function webhookSecretRef(): string {
  return 'github-webhook-secret';
}

/**
 * The GitHub App's client secret.
 *
 * What GitHub asks for, beside the client id, to narrow a bot's user token to
 * one repository (`createScopedToken`), so each task gets a token that reaches
 * only its own repository. The manifest flow is given one; an app made by hand,
 * or before this was kept, has one pasted in settings. Without it a task gets
 * the account's token, which reaches every repository the account can.
 *
 * Server-side only, like the private key: never handed to a task.
 */
export function appClientSecretRef(): string {
  return 'github-app-client-secret';
}

export function signingKeyRef(bot: string): string {
  return `ssh-signing-${bot}`;
}

export function engineKeyRef(bot: string): string {
  return `engine-key-${bot}`;
}

/**
 * Every secret named after a bot, and so every one that has to move when the
 * bot is renamed — when it takes the handle of the account that connected, or
 * goes back to its seat. One list, so a ref added here is a ref a rename
 * carries, and a rename cannot leave one behind under a name nothing uses.
 */
export const BOT_SECRET_REFS: readonly ((bot: string) => string)[] = [
  refreshTokenRef,
  accessTokenRef,
  signingKeyRef,
  engineKeyRef,
];

/**
 * The credential for one model account, shared by every bot assigned to it.
 *
 * A uuid is a legal ref: `FileSecretStore` allows letters, digits and `._:-`,
 * and an account id is hex and hyphens. One ref is the whole point — rotating
 * the account is one write here, not one per bot.
 */
export function modelAccountRef(id: string): string {
  return `model-account-${id}`;
}

/**
 * The credential a task presents to a private package registry.
 *
 * Install-wide, not per bot: it authenticates the install to a registry, not a
 * bot to GitHub, and a per-bot copy would be four places to rotate instead of
 * one. It is deliberately *not* minted into the session environment at task
 * start — a task that runs for an hour would install with whatever was true
 * when it began, and the whole point of rotating a registry credential is that
 * the old one stops working. hostd serves it per request instead
 * (`GET /tasks/:id/registry-token`), so the next install picks up the rotation.
 */
export function registryTokenRef(): string {
  return 'registry-token';
}

/**
 * What hostd presents to the bridge's token service. The service hands out a
 * GitHub credential, so reaching the private network is not on its own enough
 * to be served: the caller has to hold something only the install's own
 * components can read.
 */
export function internalSecretRef(): string {
  return 'internal-api-secret';
}

/**
 * Generates the shared secret on first use so an operator has nothing to set.
 * `fleetadlc up` calls it before it starts hostd and the bridge, and the bridge
 * calls it again at start; everything else only reads it, and retries once if
 * it is not there yet.
 */
export async function ensureInternalSecret(store: SecretStore = getSecretStore()): Promise<string> {
  const existing = await store.get(internalSecretRef());
  if (existing) return existing;
  const generated = randomBytes(32).toString('hex');
  await store.set(internalSecretRef(), generated);
  return generated;
}

/**
 * What an outside monitoring system presents to the bridge's `/internal/alerts`,
 * as `x-fleetadlc-alerts-secret`, and to nothing else. Its own secret because
 * the internal one mints every bot's GitHub token and starts work, and a
 * monitor wired to file alerts held the install's master key to do it.
 */
export function alertsSecretRef(): string {
  return 'alerts-secret';
}

/** Generates the alerts secret on first use, like the internal secret; the bridge calls it at start. */
export async function ensureAlertsSecret(store: SecretStore = getSecretStore()): Promise<string> {
  const existing = await store.get(alertsSecretRef());
  if (existing) return existing;
  const generated = randomBytes(32).toString('hex');
  await store.set(alertsSecretRef(), generated);
  return generated;
}

/**
 * What the console's server and the `fleetadlc` CLI present to the bridge's
 * `/v1` API on a local install. That install takes the person's name from a
 * header, and the bridge listens on every interface, so without this anything
 * that reached the port — a host on the LAN, a task's container — was an admin:
 * it could download a backup of every credential or mint a terminal into
 * another seat's session.
 *
 * Its own secret rather than the internal one: the internal secret also opens
 * `/internal/dispatch/lease`, and the console must never hold that.
 */
export function consoleSecretRef(): string {
  return 'console-api-secret';
}

/**
 * Generates the console secret on first use, like the internal secret: the
 * bridge and `fleetadlc up` both call this, and whichever runs first writes it.
 */
export async function ensureConsoleSecret(store: SecretStore = getSecretStore()): Promise<string> {
  const existing = await store.get(consoleSecretRef());
  if (existing) return existing;
  const generated = randomBytes(32).toString('hex');
  await store.set(consoleSecretRef(), generated);
  return generated;
}

/**
 * What kind of credential this install holds for a bot, if any. A device-flow
 * install holds a refresh token; an install whose app does not expire user
 * tokens holds the token itself. Either one means the bot can act.
 */
export async function credentialKind(
  bot: string,
  store: SecretStore = getSecretStore(),
): Promise<'refresh' | 'static' | null> {
  if (await store.get(refreshTokenRef(bot))) return 'refresh';
  if (await store.get(accessTokenRef(bot))) return 'static';
  return null;
}

let defaultStore: SecretStore | undefined;

/**
 * `FLEETADLC_SECRET_STORE=gcp` is what the cloud module sets on the bridge and the
 * host. Anything else is the file store, which is what every local install has.
 */
export function getSecretStore(): SecretStore {
  if (!defaultStore) {
    defaultStore =
      envOr('FLEETADLC_SECRET_STORE', 'file') === 'gcp'
        ? new GcpSecretStore({ project: envOr('FLEETADLC_GCP_PROJECT', '') || undefined })
        : new FileSecretStore();
  }
  return defaultStore;
}

export function setSecretStore(store: SecretStore): void {
  defaultStore = store;
}

/**
 * The header a task's session presents it under. Named here, beside the mint and
 * the verifier, because three components have to agree on the string: hostd
 * mints and now also verifies, the bridge verifies, and the skill runner sends.
 */
export const TASK_TOKEN_HEADER = 'x-fleetadlc-task-token';

/**
 * The credential a task's own session presents to the bridge.
 *
 * A session has to reach `/internal/tasks/:id/*` — the skill runner is the
 * session's command, and that is how a task reports its state, its usage and
 * its gates. It must not hold the install's secret to do it: that secret also
 * opens `/internal/dispatch/lease`, so a bot that had it could start work on
 * any other bot, forge the ledger and answer for tasks that are not its own.
 *
 * So the session gets an HMAC of its own task id under the install secret.
 * hostd can mint it because hostd reads the secret; the bridge can verify it
 * for the id in the route without keeping any state; and a bot cannot derive
 * one for a different task, because it never sees the key.
 */
export function taskTokenFor(taskId: string, installSecret: string): string {
  return createHmac('sha256', installSecret).update(`task:${taskId}`).digest('hex');
}

/** Constant-time, and false for an empty secret so a missing one admits nobody. */
export function taskTokenMatches(taskId: string, installSecret: string, presented: string): boolean {
  if (!installSecret || !presented) return false;
  const expected = Buffer.from(taskTokenFor(taskId, installSecret));
  const offered = Buffer.from(presented);
  if (expected.length !== offered.length) return false;
  return timingSafeEqual(expected, offered);
}
