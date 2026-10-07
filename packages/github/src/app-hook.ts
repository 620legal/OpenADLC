import { BlockList, isIP } from 'node:net';
import { appJwt, type AppApi, type AppCredentials } from './app-auth.js';

/**
 * The app's own webhook settings, which the app itself is allowed to rewrite.
 *
 * This exists to delete a step. Setting up a webhook used to be four manual
 * operations — find a public address, copy a payload URL, copy the event list,
 * invent a secret and paste the same value into two places — and every one of
 * them fails silently. A mistyped URL looks exactly like a working one until a
 * comment goes unanswered, and a secret that matches in neither place leaves the
 * bridge refusing every delivery, because an unsigned one is never accepted.
 *
 * None of it needs a person. OpenADLC holds the app's private key, and an app may
 * configure its own hook, so OpenADLC can write both the URL and the secret onto
 * GitHub and keep the secret it wrote. The person is then asked for nothing at
 * all, and the two values cannot disagree because one side generated both.
 */

export interface AppWebhook {
  url: string;
  /**
   * Whether a secret is set. Never the value: GitHub returns `********` for a
   * hook that has one, and there is no read path that returns the secret itself
   * — which is why OpenADLC stores what it generated rather than reading it back.
   */
  secretSet: boolean;
}

interface RawConfig {
  url?: unknown;
  secret?: unknown;
}

function asWebhook(raw: RawConfig): AppWebhook {
  return {
    url: typeof raw.url === 'string' ? raw.url : '',
    secretSet: typeof raw.secret === 'string' && raw.secret.length > 0,
  };
}

/** What GitHub currently believes, which is the only thing worth reporting. */
export async function readAppWebhook(
  api: AppApi,
  credentials: AppCredentials,
  now = Date.now(),
): Promise<AppWebhook> {
  return asWebhook(await api.request<RawConfig>('GET', '/app/hook/config', appJwt(credentials, now)));
}

/**
 * One delivery GitHub made to the app's hook, as GitHub recorded it: which
 * event, what the bridge answered, and when. `statusCode` 0 means GitHub got
 * no answer at all.
 */
export interface AppHookDelivery {
  event: string;
  action: string | null;
  statusCode: number;
  deliveredAt: string;
  redelivery: boolean;
}

function asDelivery(raw: unknown): AppHookDelivery | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.event !== 'string' || typeof entry.delivered_at !== 'string') return null;
  return {
    event: entry.event,
    action: typeof entry.action === 'string' ? entry.action : null,
    statusCode: typeof entry.status_code === 'number' ? entry.status_code : 0,
    deliveredAt: entry.delivered_at,
    redelivery: entry.redelivery === true,
  };
}

/**
 * The most recent delivery GitHub made to the app's hook, or null when it has
 * made none.
 *
 * The one piece of evidence that the whole path works — GitHub, the tunnel,
 * the bridge, the signature — rather than that a setting was saved: a hook
 * pointed at the right address that every delivery fails at looks, from the
 * settings alone, exactly like one that works.
 */
export async function lastAppWebhookDelivery(
  api: AppApi,
  credentials: AppCredentials,
  now = Date.now(),
): Promise<AppHookDelivery | null> {
  const raw = await api.request<unknown>('GET', '/app/hook/deliveries?per_page=1', appJwt(credentials, now));
  const list = Array.isArray(raw) ? raw : [];
  return asDelivery(list[0]);
}

/**
 * Asks GitHub to make its newest delivery again, when that one did not go
 * through; true when it was asked.
 *
 * For the first delivery an app ever makes: the ping GitHub sends as it
 * creates an app whose webhook is switched on. It is signed with a secret
 * GitHub generated and hands OpenADLC only in the reply to the code exchange —
 * which is still on its way when the ping arrives — so the bridge refuses it.
 * Asked for again once the secret is stored, it goes through, and the first
 * delivery on record is one that shows the whole path works.
 */
export async function redeliverLatestFailure(
  api: AppApi,
  credentials: AppCredentials,
  now = Date.now(),
): Promise<boolean> {
  const token = appJwt(credentials, now);
  const raw = await api.request<unknown>('GET', '/app/hook/deliveries?per_page=1', token);
  const newest = (Array.isArray(raw) ? raw[0] : undefined) as { id?: unknown; status_code?: unknown } | undefined;
  if (!newest || typeof newest.id !== 'number') return false;

  const code = typeof newest.status_code === 'number' ? newest.status_code : 0;
  if (code >= 200 && code < 300) return false;

  await api.request('POST', `/app/hook/deliveries/${newest.id}/attempts`, token);
  return true;
}

/** How far back GitHub keeps deliveries it can redeliver: three days. */
export const REDELIVERY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How many times one delivery is redelivered before it is left alone: one the
 * bridge keeps answering with a 500 would otherwise be sent again on every
 * reconcile for three days.
 */
export const MAX_REDELIVERIES = 3;

/** How many pages of deliveries one pass reads at most: ten thousand deliveries. */
const DELIVERY_PAGES = 100;

interface RawDelivery {
  id: number;
  guid: string;
  statusCode: number;
  deliveredAt: number;
  redelivery: boolean;
}

function asRawDelivery(raw: unknown): RawDelivery | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'number' || typeof entry.guid !== 'string' || typeof entry.delivered_at !== 'string') return null;
  const deliveredAt = Date.parse(entry.delivered_at);
  if (Number.isNaN(deliveredAt)) return null;
  return {
    id: entry.id,
    guid: entry.guid,
    statusCode: typeof entry.status_code === 'number' ? entry.status_code : 0,
    deliveredAt,
    redelivery: entry.redelivery === true,
  };
}

/**
 * Has GitHub send again every delivery since `since` that never went through,
 * and returns the ids it asked to redeliver.
 *
 * GitHub does not retry a failed delivery by itself. A person's answer to a
 * gate, commented on GitHub while the bridge was restarting, its tunnel down
 * or the machine asleep, reached OpenADLC only as such a delivery, and was
 * lost: nothing else reads comments, and the task kept waiting.
 *
 * A delivery is every attempt GitHub made with its `guid`, the redeliveries
 * included. One is sent again only when no attempt went through and every one
 * failed with no answer (status 0) or a 5xx. A 4xx, such as a 401 for a
 * signature that does not match, fails the same way every time, and the
 * webhook health check reports it. Nothing older than GitHub's three-day
 * window is looked at, and a delivery redelivered `MAX_REDELIVERIES` times
 * is left alone.
 */
export async function redeliverFailedSince(
  api: AppApi,
  credentials: AppCredentials,
  since: number,
  now = Date.now(),
): Promise<number[]> {
  const token = appJwt(credentials, now);
  const floor = Math.max(since, now - REDELIVERY_WINDOW_MS);
  const byGuid = new Map<string, RawDelivery[]>();

  let path: string | null = '/app/hook/deliveries?per_page=100';
  for (let page = 0; path && page < DELIVERY_PAGES; page += 1) {
    const read: { items: unknown; next: string | null } = api.page
      ? await api.page<unknown>(path, token)
      : { items: await api.request<unknown>('GET', path, token), next: null };
    const listed = (Array.isArray(read.items) ? read.items : []).map(asRawDelivery).filter((entry): entry is RawDelivery => entry !== null);
    // Newest first: past the floor, the rest is older still.
    let reachedFloor = false;
    for (const delivery of listed) {
      if (delivery.deliveredAt < floor) {
        reachedFloor = true;
        continue;
      }
      byGuid.set(delivery.guid, [...(byGuid.get(delivery.guid) ?? []), delivery]);
    }
    path = reachedFloor || listed.length === 0 ? null : read.next;
  }

  const redelivered: number[] = [];
  for (const attempts of byGuid.values()) {
    if (!attempts.every((attempt) => attempt.statusCode === 0 || attempt.statusCode >= 500)) continue;
    if (attempts.filter((attempt) => attempt.redelivery).length >= MAX_REDELIVERIES) continue;
    const newest = attempts[0];
    if (!newest) continue;
    // One that GitHub will not send again (gone past its window since it was
    // listed) does not stop the rest.
    try {
      await api.request('POST', `/app/hook/deliveries/${newest.id}/attempts`, token);
      redelivered.push(newest.id);
    } catch {
      continue;
    }
  }
  return redelivered;
}

/**
 * Refused rather than sent, because GitHub accepts an address it can never
 * deliver to and reports nothing afterwards. A loopback URL is the likely
 * mistake — it is the address the bridge actually listens on — and it would
 * leave the install looking configured and receiving nothing.
 */
export function deliverableUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'that is not a URL';
  }
  if (parsed.protocol !== 'https:') return 'GitHub delivers to https, not ' + parsed.protocol.replace(':', '');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const kind = isIP(host);
  const unreachable = kind === 0 ? /(^|\.)(localhost|local)$/i.test(host) : PRIVATE.check(host, kind === 4 ? 'ipv4' : 'ipv6');
  if (unreachable) {
    return `GitHub cannot reach ${parsed.hostname} — it needs an address from the internet`;
  }
  return null;
}

/**
 * Addresses GitHub cannot deliver to: loopback, private, link-local and
 * unspecified. A pattern on the hostname let `127.0.0.1` through, because only
 * the literal `127.` matched; `URL` has already turned `2130706433` and
 * `0x7f.1` into `127.0.0.1` by here, and the IPv4 ranges also hold the
 * `::ffff:`-mapped forms of their addresses.
 */
const PRIVATE = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
})();

/**
 * Points the app's webhook at `url` and sets `secret` as its signing key.
 *
 * The secret is sent every time rather than only when absent: the value OpenADLC
 * stores and the value GitHub verifies against have to be the same one, and the
 * only way to be sure of that is to write both from here.
 */
export async function setAppWebhook(
  api: AppApi,
  credentials: AppCredentials,
  update: { url: string; secret: string },
  now = Date.now(),
): Promise<AppWebhook> {
  const objection = deliverableUrl(update.url);
  if (objection) throw new Error(objection);

  return asWebhook(
    await api.request<RawConfig>('PATCH', '/app/hook/config', appJwt(credentials, now), {
      url: update.url,
      content_type: 'json',
      secret: update.secret,
      insecure_ssl: '0',
    }),
  );
}
