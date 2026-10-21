import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { settings } from '@openadlc/db';
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
} from '@openadlc/github';
import { appSettingsUrl, PLACEHOLDER_HOOK_URL } from '@openadlc/shared';
import type { BridgeConfig } from './config.js';
import { effectiveConfig, storeWebhookSecret, type EffectiveConfig } from './effective-config.js';
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

/** The stored address, and who made it. */
type StoredAddress = Pick<EffectiveConfig, 'publicUrl' | 'webhookMode'>;

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

/**
 * A delivery that never reached the bridge: no answer at all, or a proxy's
 * error in its place — Cloudflare's 502 or 530 for a tunnel whose address is
 * dead, the gateway's 502 for a bridge that did not answer. A 500 or a 4xx
 * is the bridge itself answering, which says the way to it works: the webhook
 * route answers no more than 500 for a failure of its own (`internal-api.ts`).
 */
export function unreached(statusCode: number): boolean {
  return statusCode === 0 || statusCode >= 502;
}

/** How often `watchTunnel` runs (`main.ts`). */
export const TUNNEL_WATCH_MS = 60_000;

/**
 * How long the watch waits after raising a tunnel before it raises another,
 * doubled each time up to `REVIVE_WAIT_MAX_MS`. A flat half hour re-raised a
 * tunnel on a flaky edge every half hour for good, moving GitHub's hook each
 * time while GitHub delivered; and quick tunnels are rate-limited. Back to
 * the shortest once GitHub delivers to the address it has with a 2xx.
 */
const REVIVE_WAIT_MS = 30 * 60_000;
const REVIVE_WAIT_MAX_MS = 8 * 60 * 60_000;

/**
 * How long the watch leaves an address alone after it looked at replacing it
 * and would not — GitHub did not answer, its hook points elsewhere, it
 * delivers there — doubled each time up to `HOLD_MAX_MS`. Every minute was a
 * read of the settings and a call to GitHub for an answer that had not changed.
 */
const HOLD_MS = 60_000;
const HOLD_MAX_MS = 30 * 60_000;

/**
 * How often an address is tried. Every run only to confirm a first failure,
 * and through a new tunnel's first `NEW_TUNNEL_MS`: one that never answered
 * was tried every minute for as long as it ran.
 */
const PROBE_EVERY_MS = 5 * 60_000;
const NEW_TUNNEL_MS = 10 * 60_000;

/** How long a try of the tunnel's address waits for an answer. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * How long one call to GitHub as the app is waited for. The watch holds the
 * turn while it waits (`exclusive`), so a call that never came back kept a
 * person's take-down waiting behind it.
 */
const GITHUB_TIMEOUT_MS = 15_000;

/** A delivery GitHub made this soon after the hook was repointed may still have gone to the old address, by either clock. */
const REPOINT_SLACK_MS = 60_000;

/**
 * What the tunnel's public address answered from this machine: its status, or
 * 0 for no answer at all.
 */
export type Probe = (url: string) => Promise<number>;

/**
 * A GET, which the gateway answers with a 404 and never passes on: trying the
 * address every few minutes reaches cloudflared and the gateway, and nothing
 * of the bridge.
 */
const probeAddress: Probe = async (url) => {
  try {
    const answer = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await answer.body?.cancel().catch(() => undefined);
    return answer.status;
  } catch {
    return 0;
  }
};

/**
 * `api`, each call given up after `ms`. `AppApi` takes no signal, so the
 * request is left to finish or fail on its own; what waited on it goes on.
 */
function within(api: AppApi, ms: number): AppApi {
  const bounded = <T>(call: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`GitHub did not answer ${what} within ${Math.round(ms / 1000)}s`)), ms);
      timer.unref?.();
    });
    return Promise.race([call, late]).finally(() => clearTimeout(timer));
  };
  const page = api.page?.bind(api);
  return {
    request: <T>(method: string, path: string, token: string, body?: unknown) => bounded(api.request<T>(method, path, token, body), `${method} ${path}`),
    ...(page ? { page: <T>(path: string, token: string) => bounded(page<T>(path, token), `GET ${path}`) } : {}),
  };
}

/** A revive that a person's Configure or take-down, or the bridge stopping, overtook: what they did stands. */
class Superseded extends Error {}

/** Why the watch last held off replacing an address it found dead. */
export type TunnelHold = 'github-unreachable' | 'hook-elsewhere' | 'github-delivers' | 'not-possible';

/** What the watch knows of the address GitHub has, and what it will do about it (`watchTunnel`). */
export interface TunnelWatch {
  /** The address is a tunnel this bridge raised: the only kind the watch replaces. */
  keeps: boolean;
  /** It has answered from this machine at least once. */
  answered: boolean;
  /** Since when every try of it from here has failed, or null while it answers. */
  failingSince: string | null;
  /** Why the watch last held off replacing it, or null. */
  held: TunnelHold | null;
  /** The soonest the watch raises another tunnel, while it is waiting to; null when it is not. */
  notBefore: string | null;
}

/** The watch replacing a quick tunnel whose address stopped reaching the bridge (`watchTunnel`). */
export interface TunnelRevival {
  /** When the watch raised it, or tried to. */
  at: string;
  /** The address that had stopped reaching the bridge. */
  from: string;
  /** The new tunnel's address, or null when one could not be raised. */
  to: string | null;
  /** Why not, when it could not. */
  error: string | null;
}

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
   * GitHub's newest delivery, when it never reached the bridge at the address
   * GitHub has now: made after this bridge last pointed the app here, or
   * started, and answered by nothing or by a proxy's error (`unreached`). A
   * Mac that slept woke with cloudflared still running and its address dead;
   * every delivery got a 502, and this said GitHub delivered here.
   */
  unreached: AppHookDelivery | null;
  /** The last time the watch replaced a quick tunnel that had stopped reaching the bridge, or null. */
  revived: TunnelRevival | null;
  /** What the watch knows and will do, so a card says that and not what it would do in general. */
  watch: TunnelWatch;
  /**
   * A quick tunnel's address dies with the process that raised it. When the
   * stored address is one this bridge raised and no tunnel is running, the
   * install looks configured and receives nothing — so it is said outright
   * rather than shown as green.
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
  /** Injected so the tunnel watch's tests reach no network. */
  probe?: Probe;
  /** The clock for when the app was last pointed here; injected so a test can place deliveries around it. */
  now?: () => number;
}

/** A quick tunnel's hostname, which is the shape that goes stale. */
function isQuickTunnel(url: string): boolean {
  return /\.trycloudflare\.com/i.test(url);
}

/**
 * Whether the stored address is a quick tunnel this bridge raised: the only
 * kind `resume()` raises again at start, the watch replaces, a take-down
 * forgets, and a status calls stopped when no tunnel runs behind it. Said by
 * the mode stored beside it. Going by the address alone, a quick tunnel a
 * person runs themselves and gave as a fixed address was replaced at every
 * restart, and called stopped until it was.
 *
 * An install from before the mode was stored has none, nor has an address
 * restored from a backup made then: a quick tunnel's address is then read as
 * this bridge's own, as it was before. One from the environment is always a
 * person's (`effectiveConfig`). `tunnel` beside any other address is a row
 * out of step with it, not a tunnel to raise again: this bridge raises only
 * quick tunnels.
 */
function raisedHere(live: StoredAddress): boolean {
  return isQuickTunnel(live.publicUrl) && live.webhookMode !== 'address';
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
  /**
   * When this bridge last pointed the app's hook here, or started. A delivery
   * that failed before it went to an address this bridge has since replaced,
   * or failed while the bridge was down, and says nothing about this one.
   */
  private pointedAt: number;

  constructor(private readonly deps: WebhookSetupDeps) {
    this.pointedAt = this.clock();
  }

  /**
   * The quick tunnel's address this bridge keeps: one it raised, or the one
   * `resume()` took back at start. The watch replaces only this. Going by the
   * address alone, it replaced a quick tunnel a person runs themselves and
   * gave as a fixed address: a quick tunnel's address with nothing behind it.
   */
  private ours: string | null = null;

  /**
   * Moved by a person's Configure or take-down and by `shutdown`. The watch
   * reads it before it waits and after every wait: read once, a take-down that
   * arrived while it asked GitHub was followed by a raise and a repoint.
   */
  private generation = 0;

  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * One change to where GitHub delivers at a time: a person's Configure or
   * take-down, the start-up resume, and the watch's revive. The watch decides
   * on what it read a minute ago; run beside a take-down, it could raise a
   * tunnel after the person had taken the install off the internet. Each
   * change runs after the one before it, and the watch looks again once it is
   * its turn.
   */
  private changing: Promise<unknown> = Promise.resolve();

  private exclusive<T>(change: () => Promise<T>): Promise<T> {
    const next = this.changing.then(change);
    this.changing = next.catch(() => undefined);
    return next;
  }

  private get api(): AppApi {
    return within(this.deps.api ?? APP_API, GITHUB_TIMEOUT_MS);
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
    const stale = this.tunnelStopped(live);
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

    const toHere = lastDelivery ? this.deliveredHere(lastDelivery) : null;
    if (toHere) this.heardHere(toHere);

    const [settingsUrl, unheard] = await Promise.all([
      credentials ? this.settingsUrlFor(credentials) : Promise.resolve(null),
      readUnheard().catch(() => [] as Unheard[]),
    ]);

    const status: WebhookStatus = {
      ...this.describe({
        publicUrl: live.publicUrl,
        webhookMode: live.webhookMode,
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

  private describe(input: StoredAddress & {
    secretStored: boolean;
    github: AppWebhook | null;
    canAutomate: boolean;
    lastDelivery: AppHookDelivery | null;
    deliveriesRead: boolean;
    unheard: Unheard[];
  }): Omit<WebhookStatus, 'lastDelivery' | 'settingsUrl'> {
    const tunnel = this.tunnelState();
    const webhookUrl = input.publicUrl ? `${input.publicUrl.replace(/\/$/, '')}/webhooks/github` : '';
    const stale = this.tunnelStopped(input);
    const pointedHere = Boolean(webhookUrl) && input.github?.url === webhookUrl;
    const configured = pointedHere && input.secretStored && Boolean(input.github?.secretSet) && !stale;
    const hearing: Hearing = !input.deliveriesRead
      ? 'unknown'
      : input.lastDelivery
        ? 'heard'
        : input.unheard.length > 0
          ? 'silent'
          : 'never';
    const toHere = input.lastDelivery ? this.deliveredHere(input.lastDelivery) : null;
    const unreachedHere = pointedHere && toHere && unreached(toHere.statusCode) ? toHere : null;
    // GitHub listing a delivery is not GitHub delivering here when its newest
    // one never arrived: the page said ready through a dead tunnel.
    const ready = configured && hearing === 'heard' && !unreachedHere;

    return {
      ready,
      configured,
      hearing,
      unreached: unreachedHere,
      revived: this.revived,
      watch: this.watchState(input),
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
      detail: this.explain({ ...input, webhookUrl, stale, pointedHere, ready, hearing, tunnel, unreached: unreachedHere }),
    };
  }

  /**
   * The keeper's state, and what the watch found of its address: "cloudflared
   * is serving" was all it said while the process ran and its address had died.
   */
  private tunnelState(): TunnelState {
    const tunnel = this.keeper.state();
    const probed = this.probed;
    if (!tunnel.running || probed?.url !== tunnel.url || probed.failingSince === null) return tunnel;
    return {
      ...tunnel,
      detail: `cloudflared is running, but ${tunnel.url} has not reached this bridge since ${new Date(probed.failingSince).toISOString()}`,
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
    unreached: AppHookDelivery | null;
  }): string {
    if (input.ready) {
      return input.tunnel.running
        ? `GitHub delivers to ${input.webhookUrl}, through the tunnel this bridge is running`
        : `GitHub delivers to ${input.webhookUrl}`;
    }
    if (input.stale) {
      return 'the stored address was a tunnel that is no longer running, so nothing is being delivered';
    }
    if (input.unreached) {
      const answer = input.unreached.statusCode === 0 ? 'got no answer' : `got ${input.unreached.statusCode}`;
      return `GitHub’s last delivery to ${input.webhookUrl}, at ${input.unreached.deliveredAt}, ${answer}: that address does not reach this bridge`;
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
  configure(input: { mode: SetupMode; url?: string }): Promise<WebhookStatus> {
    this.generation += 1;
    return this.exclusive(() => this.point(input));
  }

  /**
   * `configure`, for what already holds the turn: the start-up resume and the
   * watch's revive. `still` is the revive asking, after each wait, whether it
   * was overtaken; when it was, the tunnel it raised is stopped and nothing
   * after is done.
   */
  private async point(input: { mode: SetupMode; url?: string }, still: () => boolean = () => true): Promise<WebhookStatus> {
    const overtaken = (): void => {
      if (still()) return;
      if (input.mode === 'tunnel') this.keeper.stop();
      throw new Superseded('the webhook was changed while a new tunnel was being raised');
    };
    const publicUrl =
      input.mode === 'tunnel' ? await this.raiseTunnel() : this.checkAddress(input.url ?? '');
    overtaken();

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
      overtaken();
      github = await setAppWebhook(this.api, credentials, { url: webhookUrl, secret });
      this.pointedAt = this.clock();
      overtaken();
    }

    // With who made it, in one write (`setSettings`): what `resume()` raises
    // again at the next start goes by it, and never by the address alone.
    await settings.setSettings({ publicUrl, webhookMode: input.mode }, 'openadlc');
    await storeWebhookSecret(secret, 'openadlc');
    this.ours = input.mode === 'tunnel' ? publicUrl : null;

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
   * A person taking the install off the internet, which lasts: the address of
   * the tunnel this bridge raised is forgotten as well, with its mode, or
   * `resume()` raised a new tunnel for it at the next start and the install
   * was back on the internet without anyone asking. An address a person gave
   * is left with its mode, a quick tunnel of their own among them, since
   * nothing here raises it.
   *
   * Stopped at once, and again in its turn: a change already under way — a
   * revive raising its tunnel — finishes first and would leave one running.
   */
  async takeDown(): Promise<WebhookStatus> {
    this.generation += 1;
    this.ours = null;
    this.keeper.stop();
    await this.exclusive(async () => {
      this.ours = null;
      this.keeper.stop();
      const live = await effectiveConfig(this.deps.config);
      if (raisedHere(live)) await settings.setSettings({ publicUrl: '', webhookMode: '' }, 'openadlc');
    });
    return this.status();
  }

  /**
   * The address this install answers on now, or null: none, or a quick tunnel
   * this bridge raised that died with it. A person's own is theirs to keep up.
   */
  private liveAddress(live: StoredAddress): string | null {
    if (!live.publicUrl) return null;
    if (raisedHere(live) && !this.keeper.state().running) return null;
    return live.publicUrl;
  }

  /**
   * What the app about to be created will have for a webhook address, asked
   * without doing anything: `have` one already, a `tunnel` to raise first, or
   * `none` — in which case GitHub creates its webhook switched off.
   */
  async newAppAddress(): Promise<NewAppAddress> {
    const live = await effectiveConfig(this.deps.config);
    if (this.liveAddress(live)) return 'have';
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
  addressForNewApp(): Promise<string | null> {
    return this.exclusive(async () => {
      const live = await effectiveConfig(this.deps.config);
      const standing = this.liveAddress(live);
      if (standing) return standing;
      if (!(this.deps.hasCloudflared ?? cloudflaredOnPath)()) return null;

      const publicUrl = await this.raiseTunnel();
      // Stored as this install's address, and as one this bridge raised: what
      // `resume()` raises a new tunnel for and repoints the app to on every
      // start. The secret is not made here: GitHub generates the webhook's,
      // and the code exchange stores it.
      await settings.setSettings({ publicUrl, webhookMode: 'tunnel' }, 'openadlc');
      this.ours = publicUrl;
      return publicUrl;
    });
  }

  /**
   * Brings a tunnel install's webhook back when the bridge starts.
   *
   * A quick tunnel dies with the process that raised it, and its address with
   * it. Nothing raised it again, so every restart — a reboot, `openadlc up` —
   * left GitHub delivering to a dead address until someone came back to the
   * webhook step and pressed a button. When the stored address is a quick
   * tunnel this bridge raised (`raisedHere`) and OpenADLC can speak as the app,
   * a new tunnel is raised and the app's hook repointed at it, keeping the
   * secret. An install on an address a person gave, a quick tunnel of their
   * own among them, one whose app key OpenADLC does not hold, or one without
   * cloudflared is left as it is, and the step still says what it would need.
   */
  async resume(): Promise<WebhookStatus | null> {
    // Set before the first await, so a check that runs while the tunnel is
    // still coming back sees that it is, not that it stopped.
    this.resuming = true;
    try {
      return await this.exclusive(async () => {
        const live = await effectiveConfig(this.deps.config);
        if (!raisedHere(live) || this.keeper.state().running) return null;
        if (!(this.deps.hasCloudflared ?? cloudflaredOnPath)()) return null;
        if (!(await this.appCredentials())) return null;
        // Taken back as this bridge's own, so the watch raises it again when
        // this raise fails: the machine woke offline, and nothing tried again.
        this.ours = live.publicUrl;
        return await this.point({ mode: 'tunnel' });
      });
    } finally {
      this.resuming = false;
    }
  }

  /** What the watch knows of the address of the tunnel this bridge runs: whether it ever answered, and since when it has not. */
  private probed: { url: string; since: number; answered: boolean; tried: number; failures: number; failingSince: number | null } | null = null;
  /** The watch's last replacement of a tunnel, or try at one. */
  private revived: TunnelRevival | null = null;
  /** No revive before this: `reviveWait` after the last, which doubles with each. */
  private notBefore = 0;
  private reviveWait = REVIVE_WAIT_MS;
  /** No look at a revive before this, after the watch held off one: `holdWait`, which doubles with each. */
  private holdUntil = 0;
  private holdWait = HOLD_MS;
  private held: TunnelHold | null = null;
  private watching = false;
  /** Set by `shutdown`, so a run of the watch that was under way raises nothing behind it. */
  private closed = false;

  /**
   * Notices the quick tunnel this bridge keeps when it has stopped reaching
   * the bridge, and raises a new one as Configure does; run every minute
   * (`main.ts`). Says what it did, or null when it did nothing.
   *
   * A Mac slept for forty minutes and woke with cloudflared still running, so
   * the keeper said it served its address; but the address was dead, every
   * delivery GitHub made got a 502 and was lost, and nothing raised a tunnel
   * again until a person pressed Configure.
   *
   * The address is tried from here (`probeAddress`) every five minutes, by
   * the wall clock, so the first run after the machine wakes tries it at once;
   * every minute only to confirm a first failure and through a new tunnel's
   * first ten minutes. It is replaced when it answered before and has failed
   * two tries a minute apart, which gives cloudflared that minute to reconnect
   * by itself, and GitHub's newest delivery to it, if there is one, failed as
   * well; or when no tunnel runs behind it at all: cloudflared ended, or a
   * raise or a repoint failed. An address that never answered from here is not
   * replaced: this machine cannot tell whether it works.
   *
   * Only the address this bridge keeps (`ours`), never a fixed one or one a
   * person took down; never without GitHub answering, or a machine still
   * offline after waking stopped the tunnel and failed to raise another; only
   * while GitHub's hook points at it, so one a person pointed elsewhere is left
   * as they set it. Each revive waits twice as long as the last before the
   * next (`REVIVE_WAIT_MS`), and each time it holds off one, twice as long
   * before it looks again (`HOLD_MS`).
   */
  async watchTunnel(now = this.clock()): Promise<TunnelRevival | null> {
    // A run that waits ten seconds on an address is not joined by the next: one at a time.
    if (this.watching || this.closed || this.resuming || !this.ours) return null;
    const attempt = { dead: this.ours, generation: this.generation, now };
    this.watching = true;
    try {
      const tunnel = this.keeper.state();
      const serving = tunnel.running ? tunnel.url : null;
      const tried = serving === attempt.dead;
      if (tried && !(await this.stoppedAnswering(tunnel, now))) return null;
      if (now < this.notBefore || now < this.holdUntil) return null;
      return await this.exclusive(() => this.revive({ ...attempt, serving, tried }));
    } finally {
      this.watching = false;
    }
  }

  /** Tries the running tunnel's address when that is due, and says whether it answered before and has now stopped. */
  private async stoppedAnswering(tunnel: TunnelState, now: number): Promise<boolean> {
    if (this.probed?.url !== tunnel.url) {
      const since = Date.parse(tunnel.since ?? '') || now;
      this.probed = { url: tunnel.url, since, answered: false, tried: since, failures: 0, failingSince: null };
    }
    const probed = this.probed;
    const dead = (): boolean => probed.answered && probed.failures >= 2;
    const often = probed.answered ? probed.failures === 1 : now - probed.since < NEW_TUNNEL_MS;
    // A few seconds' slack, so a run on the minute is not a minute late.
    if (now - probed.tried < (often ? TUNNEL_WATCH_MS : PROBE_EVERY_MS) - 5_000) return dead();
    probed.tried = now;
    const code = await (this.deps.probe ?? probeAddress)(`${tunnel.url.replace(/\/$/, '')}/webhooks/github`);
    if (this.probed !== probed) return false;
    if (!unreached(code)) {
      probed.answered = true;
      probed.failures = 0;
      probed.failingSince = null;
      // What held a revive off is about an address that has since come back.
      this.held = null;
      this.holdUntil = 0;
      this.holdWait = HOLD_MS;
      return false;
    }
    probed.failures += 1;
    probed.failingSince ??= now;
    return dead();
  }

  /**
   * Raises a new tunnel for `dead`, in its turn, when nothing changed while it
   * waited: not the generation, the stored address or who made it, or what the
   * keeper runs.
   */
  private async revive(attempt: { dead: string; serving: string | null; tried: boolean; generation: number; now: number }): Promise<TunnelRevival | null> {
    const { dead, serving, now } = attempt;
    const still = (): boolean => attempt.generation === this.generation && !this.closed;
    const hold = (why: TunnelHold): null => {
      this.held = why;
      this.holdUntil = now + this.holdWait;
      this.holdWait = Math.min(this.holdWait * 2, HOLD_MAX_MS);
      return null;
    };
    if (!still() || this.resuming || this.ours !== dead || now < this.notBefore || now < this.holdUntil) return null;

    const live = await effectiveConfig(this.deps.config);
    const tunnel = this.keeper.state();
    if (!still() || live.publicUrl !== dead || !raisedHere(live) || (tunnel.running ? tunnel.url : null) !== serving) return null;
    // What `resume()` needs at start, and the secret already stored: the
    // hook is repointed with the one GitHub signs with now, never a new one.
    if (!(this.deps.hasCloudflared ?? cloudflaredOnPath)() || !live.webhookSecret) return hold('not-possible');
    const credentials = await this.appCredentials();
    if (!still()) return null;
    if (!credentials) return hold('not-possible');

    const github = await readAppWebhook(this.api, credentials).catch(() => null);
    if (!still()) return null;
    if (!github) return hold('github-unreachable');
    // The dead address, or the tunnel a repoint that failed left running.
    const hooks = [dead, serving].filter((url): url is string => Boolean(url)).map((url) => `${url.replace(/\/$/, '')}/webhooks/github`);
    if (!hooks.includes(github.url)) return hold('hook-elsewhere');

    // Not answering from here is this machine's view. GitHub's newest delivery
    // to the address says what GitHub sees: one that arrived is a flaky edge,
    // or this machine's own way to it, and not a tunnel to replace.
    if (attempt.tried) {
      const newest = await lastAppWebhookDelivery(this.api, credentials).then(
        (delivery) => ({ delivery }),
        () => null,
      );
      if (!still()) return null;
      if (!newest) return hold('github-unreachable');
      const toHere = newest.delivery ? this.deliveredHere(newest.delivery) : null;
      if (toHere) this.heardHere(toHere);
      if (toHere && !unreached(toHere.statusCode)) return hold('github-delivers');
    }

    const at = new Date(now).toISOString();
    // Said as the start-up resume is: the keeper stops the old tunnel before
    // the new one has an address, and a check that ran then called it stopped.
    this.resuming = true;
    try {
      const status = await this.point({ mode: 'tunnel' }, still);
      this.revived = { at, from: dead, to: status.publicUrl, error: null };
    } catch (error) {
      if (error instanceof Superseded) return null;
      this.revived = { at, from: dead, to: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.resuming = false;
    }
    this.notBefore = now + this.reviveWait;
    this.reviveWait = Math.min(this.reviveWait * 2, REVIVE_WAIT_MAX_MS);
    this.held = null;
    this.holdUntil = 0;
    this.holdWait = HOLD_MS;
    return this.revived;
  }

  /** `delivery`, when GitHub made it to the address it has now: after this bridge last pointed the hook here, or started. */
  private deliveredHere(delivery: AppHookDelivery): AppHookDelivery | null {
    return Date.parse(delivery.deliveredAt) > this.pointedAt + REPOINT_SLACK_MS ? delivery : null;
  }

  /**
   * GitHub delivered to the address it has now. A 2xx proves the tunnel the
   * watch raised works, and the waits between revives start again from the
   * shortest, counted from that revive.
   */
  private heardHere(delivery: AppHookDelivery): void {
    if (delivery.statusCode < 200 || delivery.statusCode >= 300 || this.reviveWait === REVIVE_WAIT_MS) return;
    this.reviveWait = REVIVE_WAIT_MS;
    if (this.revived) this.notBefore = Math.min(this.notBefore, Date.parse(this.revived.at) + REVIVE_WAIT_MS);
  }

  /**
   * What the status says of the watch, for the stored address. Kept only while
   * the stored mode still says this bridge raised it: a restore marking the
   * running tunnel's address as a person's left the status saying it kept it.
   */
  private watchState(live: StoredAddress): TunnelWatch {
    const tunnel = this.keeper.state();
    const probed = tunnel.running && this.probed?.url === tunnel.url ? this.probed : null;
    const until = Math.max(this.notBefore, this.holdUntil);
    return {
      keeps: this.ours !== null && this.ours === live.publicUrl && raisedHere(live),
      answered: probed?.answered ?? false,
      failingSince: probed?.failingSince != null ? new Date(probed.failingSince).toISOString() : null,
      held: this.held,
      notBefore: until > this.clock() ? new Date(until).toISOString() : null,
    };
  }

  /**
   * Whether the bridge is bringing a tunnel back: the last run's, at start, or
   * one the watch found dead. The health check ran at start while it was,
   * found the quick tunnel not running, and said "GitHub is delivering to a
   * tunnel that has stopped" at every restart — a line before the log said
   * the tunnel was back up.
   */
  private resuming = false;

  /**
   * The address of a quick tunnel this bridge raised, with no tunnel behind
   * it. Not while the bridge is raising it again at start: that is a tunnel
   * coming back, not one that stopped. Never a person's own, whose cloudflared
   * this bridge cannot see: GitHub's deliveries say whether it reaches here
   * (`unreached`, and the webhook check).
   */
  private tunnelStopped(live: StoredAddress): boolean {
    return raisedHere(live) && !this.keeper.state().running && !this.resuming;
  }

  /** So a tunnel does not outlive the bridge that raised it. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    this.keeper.stop();
    await this.gateway?.close();
    this.gateway = null;
  }
}

/** What a tunnel the watch raised is followed by; `main.ts` gives the real ones. */
export interface AfterRevival {
  audit: (entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }) => Promise<unknown>;
  /** Asks the webhook check again, so its card says what is true now. */
  recheck: () => void;
  /** Has GitHub send again what failed, to the address it has now (`Scheduler.redeliverFailed`). */
  redeliver: () => Promise<string | null>;
  say: (line: string) => void;
  warn: (line: string) => void;
}

/**
 * Said once, audited as the step's own tunnel actions are, the webhook check
 * asked again, and what GitHub could not deliver meanwhile sent again to the
 * new address. A raise that failed is said and audited too: it stopped the
 * old tunnel, and the install is off the internet until the next one.
 */
export async function afterRevival(revival: TunnelRevival, deps: AfterRevival): Promise<void> {
  if (revival.to) {
    deps.say(`${revival.from} stopped reaching this bridge; raised a new tunnel at ${revival.to} and pointed the GitHub app's webhook at it`);
  } else {
    deps.warn(
      `${revival.from} stopped reaching this bridge, and a new tunnel could not be raised: ${revival.error} — ` +
        'OpenADLC tries again later, waiting longer each time, or the webhook step can start one now',
    );
  }
  await deps.audit({ actor: 'bridge', action: 'install.tunnel_revived', target: 'install', payload: { from: revival.from, to: revival.to, error: revival.error } });
  deps.recheck();
  if (!revival.to) return;
  const line = await deps.redeliver();
  if (line) deps.say(line);
}
