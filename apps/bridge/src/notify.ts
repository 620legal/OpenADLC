import { lastEventAt, listEventsOfTypeWith, recordEvent, settings } from '@openadlc/db';
import { getSecretStore, notifyTargetRef } from '@openadlc/github';
import type { BridgeConfig } from './config.js';

/**
 * Tells a person that a bot is waiting on them.
 *
 * Nothing notified anyone: a gate was a GitHub comment and a console row, so a
 * task could sit paused until somebody happened to look at the board. A few
 * things are worth interrupting someone for — a gate opened (`gate_opened`),
 * the month's spend reached its warning (`cap_warning`), a promote waits for
 * its approval (`promote_waiting`), a pull request waits for a person to merge
 * or approve it (`merge_waiting`), a review stopped (`review_stalled`) — and,
 * just as deliberately, nothing else: a platform that notifies on everything
 * is one whose notifications are ignored, including the ones that mattered.
 *
 * And one more, with the same restraint: something only a person can do has
 * gone undone, and it stops work (`check_failing`, from the health checks) —
 * sent when it has lasted five minutes, and again only if it is still there a
 * day later. Its all-clear (`check_fixed`) goes only to somebody who was told
 * it was broken.
 *
 * The two waiting kinds are read from Needs you rather than sent where they
 * happen (`notify-waiting.ts`): four places write a stalled review, and the
 * merge line decides a hold in paths a person reviews.
 */
export const NOTIFIABLE = [
  'gate_opened',
  'cap_warning',
  'promote_waiting',
  'merge_waiting',
  'review_stalled',
  'check_failing',
  'check_fixed',
] as const;
export type NotifiableEvent = (typeof NOTIFIABLE)[number];

/**
 * What a person can switch off in Settings → Notifications, each on unless
 * `notifyKinds` says `false`. A failing check and its all-clear are one
 * switch: an all-clear for a failure that was never sent says nothing.
 */
export const NOTIFY_SWITCHES = ['gate_opened', 'merge_waiting', 'review_stalled', 'cap_warning', 'promote_waiting', 'check_failing'] as const;
export type NotifySwitch = (typeof NOTIFY_SWITCHES)[number];
export type NotifySwitches = Record<NotifySwitch, boolean>;

export function switchOf(event: NotifiableEvent): NotifySwitch {
  return event === 'check_fixed' ? 'check_failing' : event;
}

export interface Notification {
  event: NotifiableEvent;
  /** Who it is for: a GitHub login, or null for the install's owner. */
  to: string | null;
  text: string;
  /** Where to go to act on it. */
  link: string;
  /** The occurrence it is about, when the sender dedupes by one (`notify-waiting.ts`). Recorded, never sent. */
  item?: string;
}

/**
 * Whether this is one of those. Everything else is on the board, which is
 * where a person chooses to look rather than being made to.
 */
export function isNotifiable(event: string): event is NotifiableEvent {
  return (NOTIFIABLE as readonly string[]).includes(event);
}

/**
 * A link that opens the work item a notification is about — its request,
 * issue and pull request as one conversation — rather than the panel of the
 * bot that asked, which held every other subject that bot had worked on. Any
 * member's subject opens the same item.
 */
export function itemLink(consoleUrl: string, subject: string): string {
  const base = consoleUrl.replace(/\/+$/, '');
  return `${base}/?${new URLSearchParams({ item: subject }).toString()}`;
}

// ------------------------------------------------------------------ transports

export const TRANSPORT_KINDS = ['ntfy', 'slack', 'webhook'] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export const NTFY_SERVER = 'https://ntfy.sh';

/** What `notifyTransport` holds. The target is not in it: it is the `notify-target` secret. */
export interface StoredTransport {
  kind: TransportKind;
  /** ntfy's server; absent for the other two. */
  server?: string;
  /** When the kind, server or target last changed: only a send since then proves it. */
  setAt: string;
  setBy: string;
}

/** Where a notification goes, as the notifier resolved it for one send. */
export interface Transport {
  kind: TransportKind;
  /** The URL, or the ntfy topic. A credential: never logged, recorded or shown whole. */
  target: string;
  server?: string;
  /** Settings → Notifications, or `OPENADLC_NOTIFY_WEBHOOK` when nothing is set there. */
  source: 'settings' | 'env';
  /** The stored transport's `setAt`; null for the environment's. */
  setAt: string | null;
}

/** One message on its way: a notification, or Settings' test. */
export interface Message {
  event: NotifiableEvent | 'test';
  to: string | null;
  text: string;
  link: string;
}

export const TEST_TEXT = 'OpenADLC can reach you here. Sent from Settings → Notifications.';

/**
 * The request each transport is sent, without sending it, so each shape is
 * checked without a network.
 *
 * ntfy's JSON publish goes to the server's root with the topic in the body:
 * its header form (`POST /<topic>` with a `Title` header) cannot carry text
 * that is not ASCII, and every question a bot asks can have some. The generic
 * webhook's body is the one it always had, so a receiver written for it keeps
 * working.
 */
export function requestFor(transport: Pick<Transport, 'kind' | 'target' | 'server'>, message: Message): { url: string; init: RequestInit } {
  const to = message.to ? `@${message.to}` : 'the owner';
  const personal = message.to ? `@${message.to}: ${message.text}` : message.text;
  const post = (url: string, body: unknown) => ({
    url,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  });
  switch (transport.kind) {
    case 'ntfy':
      return post(`${(transport.server || NTFY_SERVER).replace(/\/+$/, '')}/`, {
        topic: transport.target,
        title: 'OpenADLC',
        message: personal,
        click: message.link,
        tags: [message.event],
      });
    case 'slack':
      return post(transport.target, { text: `${personal}\n<${message.link}|Open in OpenADLC>` });
    case 'webhook':
      return post(transport.target, { text: `${to}: ${message.text}`, link: message.link, event: message.event });
  }
}

/**
 * The target as the console shows it: the host and the last four characters,
 * never more. A short topic shows none of itself, since four of five
 * characters is the topic.
 */
export function maskTarget(kind: TransportKind, target: string): string {
  const trimmed = target.replace(/\/+$/, '');
  const tail = trimmed.length > 8 ? trimmed.slice(-4) : '';
  if (kind === 'ntfy') return `…${tail}`;
  try {
    return `${new URL(trimmed).origin}/…${tail}`;
  } catch {
    return `…${tail}`;
  }
}

/**
 * Takes the target out of text that may hold it: an error from `fetch` names
 * the URL it could not reach, and a Slack URL's path is the credential. Run
 * on every error before it is recorded, logged or answered.
 */
export function redactTarget(text: string, target: string): string {
  if (!target) return text;
  const pieces = new Set([target, target.replace(/\/+$/, '')]);
  try {
    const url = new URL(target);
    const path = `${url.pathname}${url.search}`;
    if (path.length > 1) {
      pieces.add(path);
      pieces.add(path.replace(/^\/+/, ''));
    }
  } catch {
    // A topic, not a URL: the topic itself is all there is to take out.
  }
  let out = text;
  for (const piece of [...pieces].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(piece).join('…');
  return out;
}

// ------------------------------------------------------------------ where it is kept

/** One recorded delivery, as the health check and Settings read it. */
export interface DeliveryRecord {
  at: string;
  event: string;
  transport: TransportKind;
  source: 'settings' | 'env';
  setAt: string | null;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/**
 * Where the notifier keeps and reads what it needs: the two settings, the
 * secret and the event log. One seam, so the tests run on memory.
 */
export interface NotifyStore {
  setting(key: 'notifyTransport' | 'notifyKinds'): Promise<string | null>;
  /** Writes both together; an empty value clears one. */
  write(values: Partial<Record<'notifyTransport' | 'notifyKinds', string>>, by: string): Promise<void>;
  target(): Promise<string | null>;
  setTarget(value: string | null): Promise<void>;
  record(type: string, payload: Record<string, unknown>): Promise<void>;
  /** Whether an event of this type was ever recorded with these fields. */
  recorded(type: string, fields?: Record<string, string>): Promise<boolean>;
  /** The deliveries recorded with these fields, newest first. */
  deliveries(fields: Record<string, string>): Promise<DeliveryRecord[]>;
}

export function databaseNotifyStore(): NotifyStore {
  return {
    setting: (key) => settings.getSetting(key),
    write: (values, by) => settings.setSettings(values, by),
    target: () => getSecretStore().get(notifyTargetRef()),
    setTarget: (value) => (value ? getSecretStore().set(notifyTargetRef(), value) : getSecretStore().delete(notifyTargetRef())),
    record: async (type, payload) => {
      await recordEvent({ source: 'platform', type, payload });
    },
    recorded: async (type, fields = {}) => (await lastEventAt(type, fields)) !== null,
    deliveries: async (fields) =>
      (await listEventsOfTypeWith('notify.delivery', fields)).map((row) => ({ ...(row.payload as Omit<DeliveryRecord, 'at'>), at: row.at })),
  };
}

export function parseStoredTransport(value: string | null): StoredTransport | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredTransport>;
    if (!parsed || !(TRANSPORT_KINDS as readonly string[]).includes(parsed.kind ?? '') || typeof parsed.setAt !== 'string') return null;
    return {
      kind: parsed.kind as TransportKind,
      ...(parsed.kind === 'ntfy' ? { server: parsed.server || NTFY_SERVER } : {}),
      setAt: parsed.setAt,
      setBy: parsed.setBy ?? '',
    };
  } catch {
    return null;
  }
}

export function parseSwitches(value: string | null): NotifySwitches {
  let off: Record<string, unknown> = {};
  try {
    off = value ? (JSON.parse(value) as Record<string, unknown>) ?? {} : {};
  } catch {
    off = {};
  }
  return Object.fromEntries(NOTIFY_SWITCHES.map((name) => [name, off[name] !== false])) as NotifySwitches;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // undici's "fetch failed" says nothing; what it failed on is the cause.
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

export class Notifier {
  constructor(
    private readonly config: BridgeConfig,
    readonly store: NotifyStore = databaseNotifyStore(),
  ) {}

  /**
   * Where a notification goes now, read on every send so a save in Settings
   * takes effect without a restart. Settings first; the environment's webhook
   * only when nothing is set there. A stored kind whose secret is gone (a
   * restore that left it out) is treated as nothing set rather than a
   * transport with nowhere to send.
   */
  async transport(): Promise<Transport | null> {
    const stored = parseStoredTransport(await this.store.setting('notifyTransport').catch(() => null));
    const target = stored ? await this.store.target().catch(() => null) : null;
    if (stored && target) return { kind: stored.kind, target, ...(stored.server ? { server: stored.server } : {}), source: 'settings', setAt: stored.setAt };
    const env = this.config.notifyWebhook?.trim();
    return env ? { kind: 'webhook', target: env, source: 'env', setAt: null } : null;
  }

  /** Each switch, on unless a person turned it off; on when they cannot be read. */
  async switches(): Promise<NotifySwitches> {
    return parseSwitches(await this.store.setting('notifyKinds').catch(() => null));
  }

  /** The newest delivery that counts for this transport: since it was set, or of any age for the environment's. */
  async lastDelivery(transport: Transport): Promise<DeliveryRecord | null> {
    const fields: Record<string, string> =
      transport.source === 'settings' && transport.setAt ? { source: 'settings', setAt: transport.setAt } : { source: 'env' };
    return (await this.store.deliveries(fields))[0] ?? null;
  }

  /**
   * Sends one, or says what it would have sent.
   *
   * The transport is optional on purpose: a development install has none, and
   * logging the intent keeps the path exercised rather than dormant until the
   * day someone configures it.
   */
  async send(notification: Notification): Promise<'sent' | 'logged' | 'refused' | 'off'> {
    if (!isNotifiable(notification.event)) {
      console.warn(`[bridge] refusing to notify on ${notification.event}: not one of the things worth interrupting somebody for`);
      return 'refused';
    }

    const on = (await this.switches())[switchOf(notification.event)];
    const to = notification.to ? `@${notification.to}` : 'the owner';

    // Recorded whether or not it is delivered, and whether or not its kind is
    // switched off. A notification is a thing the platform decided to do, so
    // it belongs in the event log next to everything else it decided — and
    // that is what makes "one notification, and none on answering" checkable
    // without reading a log file whose path depends on how the install was started.
    await this.store
      .record(`notify.${notification.event}`, {
        to: notification.to,
        link: notification.link,
        text: notification.text,
        ...(notification.item ? { item: notification.item } : {}),
        ...(on ? {} : { off: true }),
      })
      .catch(() => undefined);

    if (!on) return 'off';

    const transport = await this.transport();
    if (!transport) {
      console.log(`[bridge] would notify ${to}: ${notification.text} — ${notification.link}`);
      return 'logged';
    }

    // A transport that is down must not stop the platform. The gate is
    // already on GitHub and on the board; the notification is the extra.
    const result = await this.deliver(transport, notification);
    return result.ok ? 'sent' : 'logged';
  }

  /**
   * Settings' Send a test: through the transport as it is saved, whatever the
   * switches say. Null when there is nowhere to send it.
   */
  async test(): Promise<DeliveryResult | null> {
    const transport = await this.transport();
    if (!transport) return null;
    return this.deliver(transport, {
      event: 'test',
      to: null,
      text: TEST_TEXT,
      link: `${this.config.consoleUrl.replace(/\/+$/, '')}/settings/notifications`,
    });
  }

  /**
   * Sends one message and records whether the endpoint took it, as
   * `notify.delivery`: what the health check reads, since nothing else says a
   * transport works. Never the target, and an error only once it is taken out.
   */
  private async deliver(transport: Transport, message: Message): Promise<DeliveryResult> {
    const { url, init } = requestFor(transport, message);
    const result = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
      .then((response): DeliveryResult => ({ ok: response.ok, status: response.status, error: response.ok ? null : response.statusText || null }))
      .catch((error: unknown): DeliveryResult => ({ ok: false, status: null, error: messageOf(error) }));
    const safe: DeliveryResult = { ...result, error: result.error === null ? null : redactTarget(result.error, transport.target) };
    if (!safe.ok) {
      console.warn(`[bridge] could not notify through ${transport.kind}: ${safe.status ?? ''} ${safe.error ?? ''}`.trim());
    }
    await this.store
      .record('notify.delivery', {
        event: message.event,
        transport: transport.kind,
        source: transport.source,
        setAt: transport.setAt,
        ok: safe.ok,
        status: safe.status,
        error: safe.error,
      })
      .catch(() => undefined);
    return safe;
  }
}

// ------------------------------------------------------------------ Settings → Notifications

/** What Settings → Notifications shows. Never the target whole. */
export interface NotificationSettingsView {
  source: 'settings' | 'env' | 'none';
  kind: TransportKind | null;
  server: string | null;
  target: string | null;
  switches: NotifySwitches;
  last: { at: string; event: string; ok: boolean; status: number | null; error: string | null } | null;
}

export async function notificationSettingsView(notifier: Notifier): Promise<NotificationSettingsView> {
  const [transport, switches] = await Promise.all([notifier.transport(), notifier.switches()]);
  const last = transport ? await notifier.lastDelivery(transport).catch(() => null) : null;
  return {
    source: transport?.source ?? 'none',
    kind: transport?.kind ?? null,
    server: transport?.server ?? null,
    target: transport ? maskTarget(transport.kind, transport.target) : null,
    switches,
    last: last ? { at: last.at, event: last.event, ok: last.ok, status: last.status, error: last.error } : null,
  };
}

/** What `PUT /v1/settings/notifications` is given. */
export interface NotificationSettingsInput {
  /** null clears the transport and its target. Absent leaves it as it is. */
  kind?: TransportKind | null;
  server?: string;
  /** Absent or empty keeps the stored one, which only makes sense for the same kind. */
  target?: string;
  switches?: Partial<Record<NotifySwitch, boolean>>;
}

/** What a save changed, as it is audited: never the target. */
export interface NotificationSettingsChange {
  kind: TransportKind | null;
  server: string | null;
  targetChanged: boolean;
  switches: NotifySwitches;
}

const TARGET_WORDS: Record<TransportKind, string> = { ntfy: 'ntfy topic', slack: 'Slack webhook URL', webhook: 'webhook URL' };

function targetRefusal(kind: TransportKind, target: string): string | null {
  if (kind === 'slack' && !target.startsWith('https://hooks.slack.com/')) {
    return 'A Slack incoming-webhook URL starts with https://hooks.slack.com/: copy it from the app’s Incoming Webhooks page';
  }
  if (kind === 'webhook' && !/^https?:\/\/[^\s/]+/.test(target)) return 'The webhook URL starts with http:// or https://';
  if (kind === 'ntfy' && !/^[A-Za-z0-9_-]{1,64}$/.test(target)) {
    return 'An ntfy topic is 1 to 64 letters, digits, - or _: the name after the server in the ntfy app, without the server';
  }
  return null;
}

/**
 * Saves Settings → Notifications: the kind and server to `notifyTransport`,
 * the target to the secret store only, the switches to `notifyKinds`.
 * Returns a refusal in words a person can act on, or what changed.
 *
 * A new `setAt` is written only when where notifications go changed: the
 * health check counts only sends since then, and flipping a switch does not
 * make a transport that worked unproved.
 */
export async function saveNotificationSettings(
  store: NotifyStore,
  input: NotificationSettingsInput,
  by: string,
  now: Date = new Date(),
): Promise<{ ok: false; error: string } | { ok: true; change: NotificationSettingsChange }> {
  const stored = parseStoredTransport(await store.setting('notifyTransport'));
  const values: Partial<Record<'notifyTransport' | 'notifyKinds', string>> = {};
  let next: StoredTransport | null = stored;
  let newTarget: string | null | undefined;
  let targetChanged = false;

  if (input.kind === null) {
    next = null;
    values.notifyTransport = '';
    newTarget = null;
    targetChanged = stored !== null;
  } else if (input.kind !== undefined) {
    const kind = input.kind;
    if (!(TRANSPORT_KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'Choose ntfy, Slack or a webhook' };
    const given = typeof input.target === 'string' ? input.target.trim() : '';
    if (!given && !(stored?.kind === kind && (await store.target()))) {
      return {
        ok: false,
        error: stored ? `Enter the ${TARGET_WORDS[kind]}: the one saved is kept only when the kind stays ${stored.kind}` : `Enter the ${TARGET_WORDS[kind]}`,
      };
    }
    if (given) {
      const refusal = targetRefusal(kind, given);
      if (refusal) return { ok: false, error: refusal };
    }
    let server: string | undefined;
    if (kind === 'ntfy') {
      server = (typeof input.server === 'string' ? input.server.trim() : '') || (stored?.kind === 'ntfy' ? stored.server : '') || NTFY_SERVER;
      if (!/^https?:\/\/[^\s/]+/.test(server)) return { ok: false, error: 'The ntfy server starts with http:// or https://, such as https://ntfy.sh' };
      server = server.replace(/\/+$/, '');
    }
    targetChanged = given ? given !== (await store.target()) : false;
    const moved = !stored || stored.kind !== kind || (stored.server ?? null) !== (server ?? null) || targetChanged;
    if (moved) {
      next = { kind, ...(server ? { server } : {}), setAt: now.toISOString(), setBy: by };
      values.notifyTransport = JSON.stringify(next);
    }
    if (given && targetChanged) newTarget = given;
  }

  const switches = parseSwitches(await store.setting('notifyKinds'));
  if (input.switches !== undefined) {
    if (typeof input.switches !== 'object' || input.switches === null) return { ok: false, error: 'switches is an object of kinds, each true or false' };
    for (const [name, on] of Object.entries(input.switches)) {
      if (!(NOTIFY_SWITCHES as readonly string[]).includes(name)) return { ok: false, error: `${name} is not a kind of notification: one of ${NOTIFY_SWITCHES.join(', ')}` };
      if (typeof on !== 'boolean') return { ok: false, error: `${name} is true or false` };
      switches[name as NotifySwitch] = on;
    }
    const off = Object.fromEntries(NOTIFY_SWITCHES.filter((name) => !switches[name]).map((name) => [name, false]));
    values.notifyKinds = Object.keys(off).length > 0 ? JSON.stringify(off) : '';
  }

  // The secret first: a setting that names a kind with no target falls back
  // to nothing set, where a target with no setting is never read.
  if (newTarget !== undefined) await store.setTarget(newTarget);
  if (Object.keys(values).length > 0) await store.write(values, by);
  return {
    ok: true,
    change: { kind: next?.kind ?? null, server: next?.server ?? null, targetChanged, switches },
  };
}

/** A store held in memory, for tests and for nothing else. */
export function memoryNotifyStore(initial: { settings?: Record<string, string>; target?: string | null } = {}): NotifyStore & {
  settings: Record<string, string>;
  secret: string | null;
  events: { type: string; payload: Record<string, unknown>; at: string }[];
} {
  const state = {
    settings: { ...(initial.settings ?? {}) },
    secret: initial.target ?? null,
    events: [] as { type: string; payload: Record<string, unknown>; at: string }[],
  };
  let tick = 0;
  const matches = (payload: Record<string, unknown>, fields: Record<string, string>) =>
    Object.entries(fields).every(([key, value]) => payload[key] === value);
  return Object.assign(state, {
    setting: async (key: string) => state.settings[key] ?? null,
    write: async (values: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        if (value.length === 0) delete state.settings[key];
        else state.settings[key] = value;
      }
    },
    target: async () => state.secret,
    setTarget: async (value: string | null) => {
      state.secret = value;
    },
    record: async (type: string, payload: Record<string, unknown>) => {
      state.events.push({ type, payload, at: new Date(Date.UTC(2026, 10, 2) + tick++ * 1000).toISOString() });
    },
    recorded: async (type: string, fields: Record<string, string> = {}) => state.events.some((event) => event.type === type && matches(event.payload, fields)),
    deliveries: async (fields: Record<string, string>) =>
      state.events
        .filter((event) => event.type === 'notify.delivery' && matches(event.payload, fields))
        .reverse()
        .map((event) => ({ ...(event.payload as unknown as Omit<DeliveryRecord, 'at'>), at: event.at })),
  });
}
