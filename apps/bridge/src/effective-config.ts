import { settings, type SettingKey } from '@fleetadlc/db';
import { GcpSecretStore, getSecretStore, webhookSecretRef, type SecretStore } from '@fleetadlc/github';
import { defaultInstallName } from '@fleetadlc/shared';
import type { BridgeConfig } from './config.js';

/**
 * The install's settings as they are *now*, rather than as they were when the
 * process started.
 *
 * `BridgeConfig` is read from the environment once, at start-up, which is
 * correct for ports and paths and wrong for everything an operator configures.
 * Setting a GitHub App client id used to mean editing `~/.fleetadlc/install.json`
 * in a terminal and restarting the stack — so the console could report that the
 * client id was missing and offer no way to supply it.
 *
 * A stored setting wins over the environment. Absent, the environment still
 * does, so an install configured by `fleetadlc init` or by a deployment's env is
 * untouched by this.
 */
export interface EffectiveConfig {
  organization: string;
  /** What the header on every post calls this install. */
  installName: string;
  /** Whether a crew post whose signature does not check still counts; see `attribution.ts`. */
  attributionMode: 'audit' | 'enforce';
  /**
   * The repositories, by lower-cased name, whose approved pull requests the
   * bridge does not merge (`MergeLine`). Merging is on for every other one.
   */
  bridgeMergeOff: string[];
  /**
   * Repositories where a person merges a change to how CI runs. Elsewhere —
   * the default — OpenADLC merges one once the security reviewer has approved
   * it too, which by default runs on the lead's provider; see `mergeDecision`.
   */
  ciMergeByPerson: string[];
  /**
   * False when the settings table could not be read, so every value above is
   * the environment's or empty. The merge line reads it: an empty
   * `bridgeMergeOff` then says nothing about what the operator turned off.
   */
  settingsRead: boolean;
  gitHubClientId: string;
  /**
   * The automation account an install names, as a seat or a name — the
   * console's setting, else the environment's — or null for the bot whose role
   * is `automation`. `automation-bot.ts` turns it into a bot.
   */
  automationBot: string | null;
  humans: string[];
  /** Accounts an admin allowed beyond those the install works in already, lower-cased; see `app-reach.ts`. */
  allowedAccounts: string[];
  publicUrl: string;
  /** The address the bots' own addresses are suggested from. */
  operatorEmail: string;
  clientIdConfigured: boolean;
  webhookSecretConfigured: boolean;
  /**
   * The signing key itself, for the one caller that has to compare against it.
   *
   * Never returned to a browser: `/v1/install` picks its fields by name and
   * reports `webhookSecretConfigured` instead. Anything added here that spreads
   * this object into a response would be leaking it, which is why nothing does.
   */
  webhookSecret: string;
}

export async function effectiveConfig(config: BridgeConfig): Promise<EffectiveConfig> {
  // A database that cannot be read must not take the bridge's configuration
  // with it: the environment is still a complete answer on its own.
  let settingsRead = true;
  const stored: Partial<Record<SettingKey, string>> = await settings.allSettings().catch(() => {
    settingsRead = false;
    return {} as Partial<Record<SettingKey, string>>;
  });

  const clientId = stored.githubClientId ?? config.gitHubClientId;
  // The secret store's, then an older install's row that the bridge has not
  // moved yet (`moveWebhookSecretToStore`), then the environment's.
  const inStore = await storedWebhookSecret().catch(() => null);
  const webhookSecret = inStore || stored.webhookSecret || config.webhookSecret;
  const humans = stored.humans
    ? stored.humans.split(',').map((entry) => entry.trim()).filter(Boolean)
    : config.humans;

  return {
    organization: stored.organization ?? config.organization,
    installName: stored.installName?.trim() || defaultInstallName(stored.organization ?? config.organization),
    attributionMode: stored.attributionMode === 'enforce' ? 'enforce' : 'audit',
    bridgeMergeOff: (stored.bridgeMergeOff ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    ciMergeByPerson: (stored.ciMergeByPerson ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    settingsRead,
    gitHubClientId: clientId,
    automationBot: stored.automationBot ?? config.automationBot ?? null,
    humans,
    allowedAccounts: (stored.allowedAccounts ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    publicUrl: stored.publicUrl ?? config.publicUrl,
    operatorEmail: stored.operatorEmail ?? '',
    clientIdConfigured: clientId.length > 0,
    webhookSecretConfigured: webhookSecret.length > 0,
    webhookSecret,
  };
}

/** How long a webhook secret read from Secret Manager is believed: it is asked on every delivery. */
const REMOTE_SECRET_MS = 30_000;

let remembered: { store: SecretStore; at: number; value: string | null } | null = null;

/**
 * The webhook secret as the secret store has it, read on every call so a
 * secret `fleetadlc init` or the console just wrote is the one the next
 * delivery is checked against, with no restart. A file is cheap to read;
 * Secret Manager is a request, so its answer is kept for a moment, and a
 * write through `storeWebhookSecret` replaces it at once.
 */
async function storedWebhookSecret(): Promise<string | null> {
  const store = getSecretStore();
  const remote = store instanceof GcpSecretStore;
  if (remote && remembered?.store === store && Date.now() - remembered.at < REMOTE_SECRET_MS) return remembered.value;
  const value = await store.get(webhookSecretRef());
  if (remote) remembered = { store, at: Date.now(), value };
  return value;
}

/**
 * Keeps the webhook secret in the secret store, or takes it out when empty.
 *
 * Every place that sets it comes here: the app's manifest exchange, the
 * webhook step and `PATCH /v1/install`. It was a row in the settings table,
 * so it was in every database dump and backup of the table, readable by
 * anyone with the database; an older install's row goes as this writes.
 */
export async function storeWebhookSecret(secret: string, by: string): Promise<void> {
  const store = getSecretStore();
  const value = secret.trim();
  if (value.length === 0) await store.delete(webhookSecretRef());
  else await store.set(webhookSecretRef(), value);
  remembered = null;
  await settings.setSetting('webhookSecret', '', by);
}

/**
 * Moves an older install's webhook secret out of the settings table, once,
 * when the bridge starts: into the secret store when that has none, and the
 * row deleted either way. Says what it did, never the value.
 */
export async function moveWebhookSecretToStore(by = 'fleetadlc'): Promise<'moved' | 'dropped' | 'none'> {
  const row = (await settings.getSetting('webhookSecret'))?.trim();
  if (!row) return 'none';
  const store = getSecretStore();
  const held = await store.get(webhookSecretRef());
  if (!held) await store.set(webhookSecretRef(), row);
  remembered = null;
  await settings.setSetting('webhookSecret', '', by);
  return held ? 'dropped' : 'moved';
}
