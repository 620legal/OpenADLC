import { lastEventAt, listEventsOfTypeWith, recordEvent, settings, withAdvisoryLock } from '@openadlc/db';
import { getSecretStore, notifyTargetRef, personNotifyTargetRef } from '@openadlc/github';
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
  /**
   * The people it is routed to, by person id (`needs-you-audience.ts`): sent
   * to each one's own channel, and never to the install's, which would reach
   * everyone on it (ADR 0035). Absent or empty, it is for everyone, and goes
   * to the install's channel as it always did.
   */
  people?: readonly string[];
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

/**
 * The kinds a person may choose for their own channel. Any signed-in person
 * may set one, so a URL they typed would be one the bridge posts to from
 * inside the install: a generic webhook, or an ntfy server of their own,
 * could aim it at a metadata endpoint or a service on the bridge's network.
 * So there is no webhook, ntfy is only a topic on the install's own server,
 * and Slack is only hooks.slack.com. The install's channel, which only an
 * admin sets, keeps all three.
 */
export const PERSONAL_KINDS = ['ntfy', 'slack'] as const;
export type PersonalKind = (typeof PERSONAL_KINDS)[number];

export const PERSONAL_KIND_REFUSAL = 'Your channel is an ntfy topic or a Slack incoming webhook: a webhook to another address is set only for the install, by an admin';
export const PERSONAL_SERVER_REFUSAL = 'Your ntfy topic is on the install’s own ntfy server: it takes no server of its own';
export const PERSONAL_SLACK_REFUSAL = 'A Slack incoming-webhook URL is https://hooks.slack.com/…, with no user, password or port: copy it from the app’s Incoming Webhooks page';
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

export function isPersonalKind(value: unknown): value is PersonalKind {
  return typeof value === 'string' && (PERSONAL_KINDS as readonly string[]).includes(value);
}

/** Whether a person's own target may be posted to: a topic name for ntfy, a hooks.slack.com URL for Slack, nothing else. */
export function personalTargetRefusal(kind: PersonalKind, target: string): string | null {
  if (kind === 'ntfy') {
    return NTFY_TOPIC.test(target) ? null : 'An ntfy topic is 1 to 64 letters, digits, - or _: the name after the server in the ntfy app, without the server';
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return PERSONAL_SLACK_REFUSAL;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com' || url.port || url.username || url.password) return PERSONAL_SLACK_REFUSAL;
  if (!target.startsWith('https://hooks.slack.com/')) return PERSONAL_SLACK_REFUSAL;
  return null;
}

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
  /** Settings → Notifications, `OPENADLC_NOTIFY_WEBHOOK` when nothing is set there, or one person's own channel. */
  source: 'settings' | 'env' | 'person';
  /** The stored transport's `setAt`; null for the environment's. */
  setAt: string | null;
  /** Whose own channel it is, for `source: 'person'`. */
  person?: string;
}

/** One message on its way: a notification, or Settings' test. */
export interface Message {
  event: NotifiableEvent | 'test';
  to: string | null;
  text: string;
  link: string;
}

export const TEST_TEXT = 'OpenADLC can reach you here. Sent from Settings → Notifications.';
export const PERSON_TEST_TEXT = 'OpenADLC can reach you here, on your own channel. Sent from Settings → Notifications → Your channel.';

/**
 * Slack reads `<…>` in a message as a link or a mention, so a bot's question
 * quoting an issue could add a link of its own beside the console's, or ping
 * `<!channel>`. Its three control characters are escaped as Slack asks; `|`
 * means nothing outside the brackets.
 */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
      return post(transport.target, { text: `${slackEscape(personal)}\n<${message.link}|Open in OpenADLC>` });
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
  // A user and password in any URL the error names, the ntfy server's
  // included: the server is checked to have none, but one saved before that
  // check, or a redirect's, must not reach the event log either.
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1…@');
}

// ------------------------------------------------------------------ where it is kept

/** One recorded delivery, as the health check and Settings read it. */
export interface DeliveryRecord {
  at: string;
  event: string;
  transport: TransportKind;
  source: 'settings' | 'env' | 'person';
  setAt: string | null;
  person?: string;
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
  /** When the newest event of this type with these fields was recorded, or null for none. */
  lastAt(type: string, fields: Record<string, string>): Promise<string | null>;
  /** The deliveries recorded with these fields, newest first. */
  deliveries(fields: Record<string, string>): Promise<DeliveryRecord[]>;
  /** `personNotify`: each person's own channel, without its target. */
  personSetting(): Promise<string | null>;
  /** Writes `personNotify`; an empty value clears it. */
  writePerson(value: string, by: string): Promise<void>;
  /** One person's own target, kept only in the secret store. */
  personTarget(personId: string): Promise<string | null>;
  setPersonTarget(personId: string, value: string | null): Promise<void>;
  /** Runs a read-modify-write of `personNotify` alone: two people saving at once each keep their own entry. */
  lockPeople<T>(fn: () => Promise<T>): Promise<T>;
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
    lastAt: (type, fields) => lastEventAt(type, fields),
    deliveries: async (fields) =>
      (await listEventsOfTypeWith('notify.delivery', fields)).map((row) => ({ ...(row.payload as Omit<DeliveryRecord, 'at'>), at: row.at })),
    personSetting: () => settings.getSetting('personNotify'),
    writePerson: (value, by) => settings.setSettings({ personNotify: value }, by),
    personTarget: (personId) => getSecretStore().get(personNotifyTargetRef(personId)),
    setPersonTarget: (personId, value) =>
      value ? getSecretStore().set(personNotifyTargetRef(personId), value) : getSecretStore().delete(personNotifyTargetRef(personId)),
    lockPeople: (fn) => withAdvisoryLock('openadlc:person-notify', fn),
  };
}

/** One person's own channel as `personNotify` keeps it. The target is the secret `notify-target:person:<id>`. */
export interface StoredPersonChannel {
  kind: PersonalKind;
  /** When it last changed: only a delivery since then says it works. */
  setAt: string;
}

export interface StoredPersonNotify {
  people: Record<string, StoredPersonChannel>;
}

/**
 * `personNotify`, read tolerantly: a missing or broken row is nobody's
 * channel, and an entry of a kind this does not know is dropped. With
 * `people`, an entry for someone no longer in People is dropped too.
 */
export function parsePersonNotify(raw: string | null, people?: readonly string[]): StoredPersonNotify {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const given = parsed && typeof parsed === 'object' ? (parsed as { people?: unknown }).people : null;
  const out: Record<string, StoredPersonChannel> = {};
  if (!given || typeof given !== 'object') return { people: out };
  const known = people ? new Set(people) : null;
  for (const [id, entry] of Object.entries(given as Record<string, unknown>)) {
    if (known && !known.has(id)) continue;
    if (!entry || typeof entry !== 'object') continue;
    const { kind, setAt } = entry as Record<string, unknown>;
    if (!isPersonalKind(kind) || typeof setAt !== 'string') continue;
    out[id] = { kind, setAt };
  }
  return { people: out };
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
  async transport(): Promise<(Transport & { source: 'settings' | 'env' }) | null> {
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

  /**
   * One person's own channel, read on every send like the install's. A kind
   * whose secret is gone is no channel, as it is for the install's; so is a
   * target that is not one a person may set (`personalTargetRefusal`), so a
   * row written some other way is never posted to. ntfy goes to the install's
   * own server.
   */
  async personTransport(personId: string): Promise<Transport | null> {
    const stored = parsePersonNotify(await this.store.personSetting().catch(() => null)).people[personId];
    if (!stored) return null;
    const target = await this.store.personTarget(personId).catch(() => null);
    if (!target || personalTargetRefusal(stored.kind, target)) return null;
    const server = stored.kind === 'ntfy' ? await this.installNtfyServer() : null;
    return { kind: stored.kind, target, ...(server ? { server } : {}), source: 'person', setAt: stored.setAt, person: personId };
  }

  /** The install's ntfy server: the one its own channel uses when that is ntfy, ntfy.sh otherwise. */
  async installNtfyServer(): Promise<string> {
    const stored = parseStoredTransport(await this.store.setting('notifyTransport').catch(() => null));
    return (stored?.kind === 'ntfy' && stored.server && ntfyOrigin(stored.server)) || NTFY_SERVER;
  }

  /**
   * The newest delivery that counts for this transport: since it was set, or
   * of any age for the environment's. A person's own deliveries are counted
   * only for them, so their broken topic never reads as the install's.
   */
  async lastDelivery(transport: Transport): Promise<DeliveryRecord | null> {
    const fields: Record<string, string> =
      transport.source === 'person' && transport.person && transport.setAt
        ? { source: 'person', person: transport.person, setAt: transport.setAt }
        : transport.source === 'settings' && transport.setAt
          ? { source: 'settings', setAt: transport.setAt }
          : { source: 'env' };
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
        ...(notification.people?.length ? { people: [...notification.people] } : {}),
        ...(on ? {} : { off: true }),
      })
      .catch(() => undefined);

    if (!on) return 'off';

    // Routed: each of its people's own channel, and not the install's, which
    // would tell everyone on it. Someone with no channel of their own still
    // has the console's badge and alert, and GitHub's mention.
    if (notification.people?.length) {
      let sent = false;
      for (const person of new Set(notification.people)) {
        const own = await this.personTransport(person);
        if (!own) {
          console.log(`[bridge] would notify person ${person}, who has no channel of their own: ${notification.text} — ${notification.link}`);
          continue;
        }
        if ((await this.deliver(own, notification)).ok) sent = true;
      }
      return sent ? 'sent' : 'logged';
    }

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

  /** A person's Send a test, through their own channel as saved. Null when they have none. */
  async testPerson(personId: string): Promise<DeliveryResult | null> {
    const transport = await this.personTransport(personId);
    if (!transport) return null;
    return this.deliver(transport, {
      event: 'test',
      to: null,
      text: PERSON_TEST_TEXT,
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
    // A person's own channel is not followed anywhere else: a redirect from
    // where it was checked to go is the same reach a URL of their own was.
    const result = await fetch(url, { ...init, ...(transport.source === 'person' ? { redirect: 'error' as const } : {}), signal: AbortSignal.timeout(5000) })
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
        ...(transport.person ? { person: transport.person } : {}),
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

const SERVER_REFUSAL =
  'The ntfy server is only its address, such as https://ntfy.sh: http:// or https://, with no path, topic, user or password';

/**
 * The ntfy server as it is kept: an origin and nothing else. It is a setting,
 * so it is audited and shown whole, which a user and password in it must not
 * be; and a path would send the JSON publish past the root ntfy reads it at.
 * Null for anything more than an origin.
 */
export function ntfyOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '') return null;
  if (/[@?#]/.test(value.replace(/^https?:\/\//i, '').replace(/\/+$/, ''))) return null;
  return url.origin;
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
      const origin = ntfyOrigin((typeof input.server === 'string' ? input.server.trim() : '') || (stored?.kind === 'ntfy' ? stored.server ?? '' : '') || NTFY_SERVER);
      if (!origin) return { ok: false, error: SERVER_REFUSAL };
      server = origin;
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

// ------------------------------------------------------------------ Your channel

/** What Your channel shows a person: never the target whole. */
export interface PersonalNotificationView {
  kind: PersonalKind | null;
  server: string | null;
  target: string | null;
  last: { at: string; event: string; ok: boolean; status: number | null; error: string | null } | null;
}

export async function personalNotificationView(notifier: Notifier, personId: string): Promise<PersonalNotificationView> {
  const transport = await notifier.personTransport(personId);
  const last = transport ? await notifier.lastDelivery(transport).catch(() => null) : null;
  return {
    kind: transport && isPersonalKind(transport.kind) ? transport.kind : null,
    server: transport?.server ?? null,
    target: transport ? maskTarget(transport.kind, transport.target) : null,
    last: last ? { at: last.at, event: last.event, ok: last.ok, status: last.status, error: last.error } : null,
  };
}

/**
 * What `PUT /v1/me/notifications` is given: null clears the channel; an absent
 * or empty target keeps the one saved, for the same kind. `kind` and `server`
 * are taken as sent, so a webhook or a server is refused in words rather
 * than dropped.
 */
export interface PersonalNotificationInput {
  kind: string | null;
  server?: string;
  target?: string;
}

/** What a save of Your channel changed, as it is audited: never the target. */
export interface PersonalNotificationChange {
  kind: PersonalKind | null;
  targetChanged: boolean;
}

/**
 * Saves one person's own channel: the kind to their entry in `personNotify`,
 * the target to `notify-target:person:<id>` only. Only an ntfy topic, on the
 * install's server, or a hooks.slack.com URL (`PERSONAL_KINDS`). The setting
 * is one row for everyone, so it is read and written under one lock.
 */
export async function savePersonalNotification(
  store: NotifyStore,
  personId: string,
  input: PersonalNotificationInput,
  by: string,
  now: Date = new Date(),
): Promise<{ ok: false; error: string } | { ok: true; change: PersonalNotificationChange }> {
  if (input.kind !== null && !isPersonalKind(input.kind)) return { ok: false, error: PERSONAL_KIND_REFUSAL };
  if (typeof input.server === 'string' && input.server.trim()) return { ok: false, error: PERSONAL_SERVER_REFUSAL };
  const wanted = input.kind as PersonalKind | null;
  return store.lockPeople(async () => {
    const all = parsePersonNotify(await store.personSetting());
    const stored = all.people[personId] ?? null;
    if (wanted === null) {
      if (!stored && !(await store.personTarget(personId))) return { ok: true, change: { kind: null, targetChanged: false } };
      delete all.people[personId];
      await store.setPersonTarget(personId, null);
      await store.writePerson(Object.keys(all.people).length > 0 ? JSON.stringify(all) : '', by);
      return { ok: true, change: { kind: null, targetChanged: true } };
    }
    const kind = wanted;
    const saved = await store.personTarget(personId);
    const given = typeof input.target === 'string' ? input.target.trim() : '';
    if (!given && !(stored?.kind === kind && saved)) {
      return {
        ok: false,
        error: stored ? `Enter the ${TARGET_WORDS[kind]}: the one saved is kept only when the kind stays ${stored.kind}` : `Enter the ${TARGET_WORDS[kind]}`,
      };
    }
    // The one kept is checked too: a target saved under rules since tightened
    // is not carried into a new save.
    const refusal = personalTargetRefusal(kind, given || saved || '');
    if (refusal) return { ok: false, error: refusal };
    const targetChanged = given ? given !== saved : false;
    const moved = !stored || stored.kind !== kind || targetChanged;
    // The secret first, as for the install's: an entry with no target reads as no channel.
    if (targetChanged) await store.setPersonTarget(personId, given);
    if (moved) {
      all.people[personId] = { kind, setAt: now.toISOString() };
      await store.writePerson(JSON.stringify(all), by);
    }
    return { ok: true, change: { kind, targetChanged } };
  });
}

/**
 * Takes a removed person's own channel away: their entry and their secret.
 * Their deliveries stay in the event log, which is history.
 */
export async function forgetPersonalNotification(store: NotifyStore, personId: string, by: string): Promise<void> {
  await store.lockPeople(async () => {
    const all = parsePersonNotify(await store.personSetting());
    await store.setPersonTarget(personId, null);
    if (!all.people[personId]) return;
    delete all.people[personId];
    await store.writePerson(Object.keys(all.people).length > 0 ? JSON.stringify(all) : '', by);
  });
}

/** A store held in memory, for tests and for nothing else. */
export function memoryNotifyStore(
  initial: { settings?: Record<string, string>; target?: string | null; personTargets?: Record<string, string> } = {},
): NotifyStore & {
  settings: Record<string, string>;
  secret: string | null;
  personSecrets: Record<string, string>;
  events: { type: string; payload: Record<string, unknown>; at: string }[];
} {
  const state = {
    settings: { ...(initial.settings ?? {}) },
    secret: initial.target ?? null,
    personSecrets: { ...(initial.personTargets ?? {}) },
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
    lastAt: async (type: string, fields: Record<string, string>) =>
      state.events.filter((event) => event.type === type && matches(event.payload, fields)).at(-1)?.at ?? null,
    deliveries: async (fields: Record<string, string>) =>
      state.events
        .filter((event) => event.type === 'notify.delivery' && matches(event.payload, fields))
        .reverse()
        .map((event) => ({ ...(event.payload as unknown as Omit<DeliveryRecord, 'at'>), at: event.at })),
    personSetting: async () => state.settings.personNotify ?? null,
    writePerson: async (value: string) => {
      if (value.length === 0) delete state.settings.personNotify;
      else state.settings.personNotify = value;
    },
    personTarget: async (personId: string) => state.personSecrets[personId] ?? null,
    setPersonTarget: async (personId: string, value: string | null) => {
      if (value) state.personSecrets[personId] = value;
      else delete state.personSecrets[personId];
    },
    lockPeople: <T>(fn: () => Promise<T>) => fn(),
  });
}
