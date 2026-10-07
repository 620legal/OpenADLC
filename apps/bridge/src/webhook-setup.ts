import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { settings } from '@fleetadlc/db';
import {
  appJwt,
  appPrivateKeyRef,
  deliverableUrl,
  getSecretStore,
  lastAppWebhookDelivery,
  readAppWebhook,
  setAppWebhook,
  type AppApi,
  type AppHookDelivery,
  type AppWebhook,
} from '@fleetadlc/github';
import { appSettingsUrl, PLACEHOLDER_HOOK_URL } from '@fleetadlc/shared';
import type { BridgeConfig } from './config.js';
import { effectiveConfig, storeWebhookSecret } from './effective-config.js';
import { APP_API } from './invitation-service.js';
import { TunnelKeeper, type Spawner, type TunnelState } from './tunnel.js';
import { readUnheard, type Unheard } from './unheard.js';
import { startWebhookGateway, type WebhookGateway } from './webhook-gateway.js';

/**
 * Getting GitHub to deliver here, with as little asked of the operator as
 * possible.
 *
 * This step used to be the worst one in setup, and it was the worst one because
 * it was four manual operations that each fail quietly: find a public address,
 * copy a payload URL, copy an event list, invent a secret and paste it into two
 * places that must agree. Every part of that is something OpenADLC already knows or
 * can do — it runs on the machine, so it can raise the tunnel; it holds the app
 * key, so it can write the hook; it generated the secret, so it can store the
 * same value it sent.
 *
 * What is left for a person is one decision that is genuinely theirs, because
 * only they know the answer: is this install on a laptop or does it already have
 * an address? Everything after that is done for them.
 *
 * The one thing this does *not* do is point the tunnel at the bridge. See
 * `webhook-gateway.ts`: the bridge trusts a header for identity in local mode, so
 * the tunnel gets one allowlisted route instead.
 */

export type SetupMode = 'tunnel' | 'address';

/** What the app about to be created will have for a webhook address; see `addressForNewApp`. */
export type NewAppAddress = 'have' | 'tunnel' | 'none';

/**
 * Whether GitHub sends, which is not the same as whether it has been told where
 * to — and which no setting can answer.
 *
 * An app's webhook has an **Active** switch that no API can turn on or read. An
 * app created before the install had an address is made with it off, and then
 * everything OpenADLC can set is right and GitHub still sends nothing. So this is
 * answered from GitHub's own list of what it delivered, and, when that is
 * empty, from whether anything has happened that it would have delivered.
 *
 * - `heard`: GitHub lists a delivery — whatever the bridge answered, it sends.
 * - `never`: it lists none, and nothing has happened that says it should have.
 *   On a hook set up a minute ago that is all it means.
 * - `silent`: it lists none, and something happened that it would have sent —
 *   an issue reconcile found by reading the repository (`unheard.ts`). GitHub
 *   is not sending.
 * - `unknown`: GitHub could not be asked.
 */
export type Hearing = 'heard' | 'never' | 'silent' | 'unknown';

/** What a webhook that GitHub is not sending from needs, said once for every place that says it. */
export const NOT_SENDING = 'GitHub is not sending events to OpenADLC. Open the app’s settings and turn on Active under Webhook';

export interface WebhookStatus {
  /**
   * GitHub delivering here: configured, and GitHub has delivered. An address and
   * a secret alone are not it — they were both right on an install GitHub had
   * never sent a thing to, and this said ready.
   */
  ready: boolean;
  /** Everything OpenADLC can set: an address, a secret, GitHub pointed at it, a tunnel up if it needs one. */
  configured: boolean;
  /** Whether GitHub sends at all. See `Hearing`. */
  hearing: Hearing;
  /**
   * What happened in the last two days that nothing was delivered for, newest
   * find first — what `silent` rests on, so the page can name it.
   */
  unheard: Unheard[];
  /** The app's settings page on GitHub, where Active is; null when OpenADLC cannot name the app. */
  settingsUrl: string | null;
  /**
   * GitHub's hook still has the placeholder the manifest gives an app created
   * without an address: GitHub made its webhook switched off, and pointing it
   * here will not switch it on.
   */
  placeholderHook: boolean;
  publicUrl: string;
  webhookUrl: string;
  secretStored: boolean;
  tunnel: TunnelState;
  /** What GitHub believes right now, or null when it could not be asked. */
  github: AppWebhook | null;
  /**
   * What GitHub last delivered to the app's hook and what the bridge answered,
   * or null when it has delivered nothing or could not be asked.
   */
  lastDelivery: AppHookDelivery | null;
  /**
   * A quick tunnel's address dies with the process that raised it. When the
   * stored address is one of those and no tunnel is running, the install looks
   * configured and receives nothing — so it is said outright rather than shown
   * as green.
   */
  stale: boolean;
  /**
   * The bridge is bringing the last run's tunnel back, at start. Until it has,
   * the rest describes the tunnel that ended with the last bridge — and says
   * nothing about whether this one will be reached.
   */
  resuming: boolean;
  /** Whether OpenADLC can do this itself, or the app's settings need a person. */
  canAutomate: boolean;
  /** Whether a tunnel can be raised at all on this machine. */
  tunnelAvailable: boolean;
  detail: string;
}

export interface WebhookSetupDeps {
  config: BridgeConfig;
  /** Injected so the tests never reach GitHub. */
  api?: AppApi;
  spawner?: Spawner;
  startGateway?: (bridgePort: number) => Promise<WebhookGateway>;
  generateSecret?: () => string;
  /** Injected so a test does not depend on what is installed on the machine. */
  hasCloudflared?: () => boolean;
}

/** A quick tunnel's hostname, which is the shape that goes stale. */
function isQuickTunnel(url: string): boolean {
  return /\.trycloudflare\.com/i.test(url);
}

/** Whether `cloudflared` is on the PATH, without starting it to find out. */
function cloudflaredOnPath(): boolean {
  const path = process.env.PATH ?? '';
  for (const directory of path.split(':')) {
    if (!directory) continue;
    try {
      accessSync(join(directory, 'cloudflared'), constants.X_OK);
      return true;
    } catch {
      // Not here; try the next.
    }
  }
  return false;
}

export class WebhookSetup {
  private readonly keeper = new TunnelKeeper();
  /** Started on demand, so nothing listens until a tunnel is actually asked for. */
  private gateway: WebhookGateway | null = null;
  private gatewayStarting: Promise<WebhookGateway> | null = null;
  /** The app's settings page, by client id: it does not move while the app is the same app. */
  private settingsPage: { clientId: string; url: string } | null = null;

  constructor(private readonly deps: WebhookSetupDeps) {}

  private get api(): AppApi {
    return this.deps.api ?? APP_API;
  }

  private newSecret(): string {
    return (this.deps.generateSecret ?? (() => randomBytes(32).toString('hex')))();
  }

  private async appCredentials(): Promise<{ clientId: string; privateKey: string } | null> {
    const live = await effectiveConfig(this.deps.config);
    if (!live.gitHubClientId) return null;
    const privateKey = await getSecretStore().get(appPrivateKeyRef());
    if (!privateKey) return null;
    return { clientId: live.gitHubClientId, privateKey };
  }

  /**
   * Readiness without asking GitHub, for the step list.
   *
   * The walkthrough is rendered on the server and its ticks have to be right on
   * first paint — but a GitHub round trip on every load of the page, for one
   * checkmark, is not worth it. Everything that makes an install *stop* working
   * is knowable locally: a quick tunnel's address outlives the tunnel, and that
   * is the case where a stored secret would otherwise show the step as done and
   * the install receive nothing.
   *
   * A hook repointed from GitHub's own settings page is not caught here. That
   * one needs the round trip, and the step itself makes it.
   */
  async localReadiness(): Promise<{ ready: boolean; stale: boolean }> {
    const live = await effectiveConfig(this.deps.config);
    const stale = this.tunnelStopped(live.publicUrl);
    return {
      ready: Boolean(live.publicUrl) && live.webhookSecretConfigured && !stale,
      stale,
    };
  }

  async status(): Promise<WebhookStatus> {
    const credentials = await this.appCredentials();

    // Asked rather than assumed: the app's settings can be changed from GitHub's
    // own UI, and then what OpenADLC stored is no longer what GitHub does.
    const github = credentials
      ? await readAppWebhook(this.api, credentials).catch(() => null)
      : null;

    return this.report(credentials, github);
  }

  /**
   * Everything the page says, from what GitHub's hook is set to: what it has
   * delivered, what happened that it did not, and where its Active switch is.
   */
  private async report(
    credentials: { clientId: string; privateKey: string } | null,
    github: AppWebhook | null,
  ): Promise<WebhookStatus> {
    const live = await effectiveConfig(this.deps.config);

    // Only worth asking once GitHub is pointed somewhere. A failure is kept
    // apart from an empty list: "could not ask" must never read as "GitHub has
    // sent nothing", which sends somebody to a switch that is already on.
    let lastDelivery: AppHookDelivery | null = null;
    let deliveriesRead = false;
    if (credentials && github?.url) {
      try {
        lastDelivery = await lastAppWebhookDelivery(this.api, credentials);
        deliveriesRead = true;
      } catch {
        deliveriesRead = false;
      }
    }

    const [settingsUrl, unheard] = await Promise.all([
      credentials ? this.settingsUrlFor(credentials) : Promise.resolve(null),
      readUnheard().catch(() => [] as Unheard[]),
    ]);

    const status: WebhookStatus = {
      ...this.describe({
        publicUrl: live.publicUrl,
        secretStored: live.webhookSecretConfigured,
        github,
        canAutomate: credentials !== null,
        lastDelivery,
        deliveriesRead,
        unheard,
      }),
      settingsUrl,
      lastDelivery,
    };
    return status;
  }

  /**
   * The app's settings page, asked of GitHub once per app: its slug is not
   * derivable from the client id, and an organization's app lives under the
   * organization's settings, not the person's.
   */
  private async settingsUrlFor(credentials: { clientId: string; privateKey: string }): Promise<string | null> {
    if (this.settingsPage?.clientId === credentials.clientId) return this.settingsPage.url;
    try {
      const app = await this.api.request<{ slug?: string; owner?: { login?: string; type?: string } | null }>(
        'GET',
        '/app',
        appJwt(credentials),
      );
      if (!app.slug) return null;
      const url = appSettingsUrl(app.slug, app.owner?.type === 'Organization' ? (app.owner.login ?? null) : null);
      this.settingsPage = { clientId: credentials.clientId, url };
      return url;
    } catch {
      return null;
    }
  }

  private describe(input: {
    publicUrl: string;
    secretStored: boolean;
    github: AppWebhook | null;
    canAutomate: boolean;
    lastDelivery: AppHookDelivery | null;
    deliveriesRead: boolean;
    unheard: Unheard[];
  }): Omit<WebhookStatus, 'lastDelivery' | 'settingsUrl'> {
    const tunnel = this.keeper.state();
    const webhookUrl = input.publicUrl ? `${input.publicUrl.replace(/\/$/, '')}/webhooks/github` : '';
    const stale = this.tunnelStopped(input.publicUrl);
    const pointedHere = Boolean(webhookUrl) && input.github?.url === webhookUrl;
    const configured = pointedHere && input.secretStored && Boolean(input.github?.secretSet) && !stale;
    const hearing: Hearing = !input.deliveriesRead
      ? 'unknown'
      : input.lastDelivery
        ? 'heard'
        : input.unheard.length > 0
          ? 'silent'
          : 'never';
    const ready = configured && hearing === 'heard';

    return {
      ready,
      configured,
      hearing,
      unheard: input.unheard,
      placeholderHook: input.github?.url === PLACEHOLDER_HOOK_URL,
      publicUrl: input.publicUrl,
      webhookUrl,
      secretStored: input.secretStored,
      tunnel,
      github: input.github,
      stale,
      resuming: this.resuming,
      canAutomate: input.canAutomate,
      tunnelAvailable: (this.deps.hasCloudflared ?? cloudflaredOnPath)(),
      detail: this.explain({ ...input, webhookUrl, stale, pointedHere, ready, hearing, tunnel }),
    };
  }

  /** One sentence saying what is wrong, because "not ready" is not actionable. */
  private explain(input: {
    publicUrl: string;
    secretStored: boolean;
    github: AppWebhook | null;
    webhookUrl: string;
    stale: boolean;
    pointedHere: boolean;
    ready: boolean;
    hearing: Hearing;
    tunnel: TunnelState;
  }): string {
    if (input.ready) {
      return input.tunnel.running
        ? `GitHub delivers to ${input.webhookUrl}, through the tunnel this bridge is running`
        : `GitHub delivers to ${input.webhookUrl}`;
    }
    if (input.stale) {
      return 'the stored address was a tunnel that is no longer running, so nothing is being delivered';
    }
    if (!input.publicUrl) return 'this bridge has no address GitHub can reach yet';
    if (!input.github) return 'GitHub could not be asked what it is pointed at';
    if (!input.pointedHere) {
      return input.github.url
        ? `GitHub is pointed at ${input.github.url}, not at this bridge`
        : 'GitHub is pointed at nothing';
    }
    if (!input.secretStored || !input.github.secretSet) {
      return 'the address is set but there is no signing secret, so a delivery cannot be trusted';
    }
    // Everything OpenADLC can set is right. What is left is whether GitHub sends.
    if (input.hearing === 'silent') return NOT_SENDING;
    if (input.hearing === 'never') return 'the address and the secret are set, but GitHub has not delivered anything yet';
    if (input.hearing === 'unknown') return 'the address and the secret are set, but GitHub could not be asked what it has delivered';
    return 'not configured yet';
  }

  /**
   * Does the whole step.
   *
   * The order matters: GitHub is written *before* the settings are saved. If
   * GitHub refuses, nothing has been stored, and the install still describes
   * itself accurately — the alternative records an address GitHub never accepted
   * and then reports itself as configured.
   */
  async configure(input: { mode: SetupMode; url?: string }): Promise<WebhookStatus> {
    const publicUrl =
      input.mode === 'tunnel' ? await this.raiseTunnel() : this.checkAddress(input.url ?? '');

    // A given address makes any tunnel we raised irrelevant, and an orphan
    // tunnel runs until the machine is rebooted.
    if (input.mode === 'address') this.keeper.stop();

    const live = await effectiveConfig(this.deps.config);
    // Kept when there is one: rotating it on every address change would mean a
    // window where GitHub signs with one value and the bridge checks another.
    const secret = live.webhookSecret || this.newSecret();
    const webhookUrl = `${publicUrl.replace(/\/$/, '')}/webhooks/github`;

    const credentials = await this.appCredentials();
    let github: AppWebhook | null = null;

    if (credentials) {
      github = await setAppWebhook(this.api, credentials, { url: webhookUrl, secret });
    }

    await settings.setSetting('publicUrl', publicUrl, 'fleetadlc');
    await storeWebhookSecret(secret, 'fleetadlc');

    // Without the app key this is the fallback: the values are stored and
    // correct, and the app's own settings page is the one thing left to do by
    // hand. Reported, not hidden.
    //
    // With it, what GitHub has delivered is asked as well. Writing the address
    // is not the same as GitHub sending to it: an app created without one
    // takes the address and still sends nothing, and saying "done" here was how
    // that went unnoticed.
    return this.report(credentials, github);
  }

  private checkAddress(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) throw new Error('give the address this bridge is reachable at');
    const objection = deliverableUrl(trimmed);
    if (objection) throw new Error(objection);
    return trimmed;
  }

  /** The gateway first, because that is what the tunnel must point at. */
  private async raiseTunnel(): Promise<string> {
    if (!this.gateway) {
      // One gateway, however many raise a tunnel at once: two callers both
      // found none and each started one, and the first was never closed.
      if (!this.gatewayStarting) {
        const start = this.deps.startGateway ?? ((bridgePort: number) => startWebhookGateway({ bridgePort }));
        this.gatewayStarting = start(this.deps.config.port).finally(() => {
          this.gatewayStarting = null;
        });
      }
      this.gateway = await this.gatewayStarting;
    }
    return this.keeper.start(this.gateway.port, { spawner: this.deps.spawner });
  }

  /**
   * The tunnel is killed before this first awaits, which is what lets a bridge
   * exiting without `shutdown` (`main.ts`) call it from its exit hook.
   */
  async stopTunnel(): Promise<WebhookStatus> {
    this.keeper.stop();
    return this.status();
  }

  /**
   * A person taking the install off the internet, which lasts: the quick
   * tunnel's address is forgotten as well, or `resume()` raised a new tunnel
   * for it at the next start and the install was back on the internet without
   * anyone asking. A fixed address is left, since nothing raises it.
   */
  async takeDown(): Promise<WebhookStatus> {
    this.keeper.stop();
    const live = await effectiveConfig(this.deps.config);
    if (isQuickTunnel(live.publicUrl)) await settings.setSetting('publicUrl', '', 'fleetadlc');
    return this.status();
  }

  /** The address this install answers on now, or null: none, or a quick tunnel's that died with it. */
  private liveAddress(publicUrl: string): string | null {
    if (!publicUrl) return null;
    if (isQuickTunnel(publicUrl) && !this.keeper.state().running) return null;
    return publicUrl;
  }

  /**
   * What the app about to be created will have for a webhook address, asked
   * without doing anything: `have` one already, a `tunnel` to raise first, or
   * `none` — in which case GitHub creates its webhook switched off.
   */
  async newAppAddress(): Promise<NewAppAddress> {
    const live = await effectiveConfig(this.deps.config);
    if (this.liveAddress(live.publicUrl)) return 'have';
    return (this.deps.hasCloudflared ?? cloudflaredOnPath)() ? 'tunnel' : 'none';
  }

  /**
   * An address to create the app with, so that GitHub creates its webhook
   * switched on — raising a tunnel for it when there is none and one can be.
   *
   * The manifest's `hook_attributes.active` is the only way to switch an app's
   * webhook on that is not a person ticking a box: `PATCH /app/hook/config`
   * sets the address and the secret and cannot touch it. The walkthrough made
   * the app before it had an address, so every app it made was switched off
   * for good, and the webhook step then pointed it here and reported success.
   * A quick tunnel's address changes every time one is raised, which does not
   * matter: `resume()` raises a new one on every start and repoints the app.
   *
   * Null when there is no address and cloudflared is not here to make one; the
   * app is then created switched off, and the webhook step says how to switch
   * it on.
   */
  async addressForNewApp(): Promise<string | null> {
    const live = await effectiveConfig(this.deps.config);
    const standing = this.liveAddress(live.publicUrl);
    if (standing) return standing;
    if (!(this.deps.hasCloudflared ?? cloudflaredOnPath)()) return null;

    const publicUrl = await this.raiseTunnel();
    // Stored as this install's address, which is what `resume()` raises a new
    // tunnel for and repoints the app to on every start. The secret is not
    // made here: GitHub generates the webhook's, and the code exchange stores it.
    await settings.setSetting('publicUrl', publicUrl, 'fleetadlc');
    return publicUrl;
  }

  /**
   * Brings a tunnel install's webhook back when the bridge starts.
   *
   * A quick tunnel dies with the process that raised it, and its address with
   * it. Nothing raised it again, so every restart — a reboot, `fleetadlc up` —
   * left GitHub delivering to a dead address until someone came back to the
   * webhook step and pressed a button. When the stored address is a quick
   * tunnel's and OpenADLC can speak as the app, a new tunnel is raised and the
   * app's hook repointed at it, keeping the secret. An install on a fixed
   * address, one whose app key OpenADLC does not hold, or one without cloudflared
   * is left as it is, and the step still says what it would need.
   */
  async resume(): Promise<WebhookStatus | null> {
    // Set before the first await, so a check that runs while the tunnel is
    // still coming back sees that it is, not that it stopped.
    this.resuming = true;
    try {
      const live = await effectiveConfig(this.deps.config);
      if (!isQuickTunnel(live.publicUrl) || this.keeper.state().running) return null;
      if (!(this.deps.hasCloudflared ?? cloudflaredOnPath)()) return null;
      if (!(await this.appCredentials())) return null;
      return await this.configure({ mode: 'tunnel' });
    } finally {
      this.resuming = false;
    }
  }

  /**
   * Whether the bridge is bringing the last run's tunnel back. The health
   * check ran at start while it was, found the quick tunnel not running, and
   * said "GitHub is delivering to a tunnel that has stopped" at every restart
   * — a line before the log said the tunnel was back up.
   */
  private resuming = false;

  /**
   * A quick tunnel's address with no tunnel behind it. Not while the bridge is
   * raising it again at start: that is a tunnel coming back, not one that
   * stopped.
   */
  private tunnelStopped(publicUrl: string): boolean {
    return isQuickTunnel(publicUrl) && !this.keeper.state().running && !this.resuming;
  }

  /** So a tunnel does not outlive the bridge that raised it. */
  async shutdown(): Promise<void> {
    this.keeper.stop();
    await this.gateway?.close();
    this.gateway = null;
  }
}
