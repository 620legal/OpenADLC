import { lastEventAt, recordEvent, settings } from '@openadlc/db';
import { isRetiredNotifyTargetRef, RETIRED_NOTIFY_TARGET_REF, type SecretStore } from '@openadlc/github';
import type { BridgeConfig } from './config.js';
import { databasePushStore, DEVICE_TEST_TEXT, sendToDevice, sendToDevices, type PushStore } from './push-devices.js';

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
 * Each goes as push to the console app, on the devices where a person turned
 * notifications on (ADR 0048), and nowhere else: ntfy, Slack and the webhook
 * are retired (ADR 0049).
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
   * The people it is routed to, by person id (`needs-you-audience.ts`): pushed
   * to each one's devices, and not to every admin's, which would tell people
   * it is not for (ADR 0035). Absent or empty, it is for everyone, and goes to
   * every admin's devices.
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

// ------------------------------------------------------------------ retired channels

/**
 * What a request that still names ntfy, Slack, a webhook or a person's own
 * channel is told (ADR 0049): the routes and settings stay, so it is told in
 * words what to do instead rather than given a 404.
 */
export const RETIRED_CHANNEL_REFUSAL =
  'ntfy, Slack and webhook notifications are retired: install the console as an app and turn on notifications on your device in Settings → Notifications';

/**
 * The settings that named the retired channels, the install's and each
 * person's. Migration 0165 deletes them; `PATCH /v1/install` refuses them
 * with `RETIRED_CHANNEL_REFUSAL` rather than as unknown keys.
 */
export const RETIRED_SETTING_KEYS = ['notifyTransport', 'personNotify'] as const;

/**
 * Deletes the retired channels' targets from the secret store (ADR 0049):
 * the install's `notify-target` and each person's `notify-target:person:<id>`,
 * found by prefix, so it needs no setting to say who had one. A migration
 * cannot reach the secret store, so the bridge does this at every start; once
 * they are gone it deletes nothing and records nothing. Never a value.
 */
export async function retireOldChannels(
  secrets: Pick<SecretStore, 'list' | 'delete'>,
  record: (type: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<number> {
  const refs = (await secrets.list(RETIRED_NOTIFY_TARGET_REF)).filter(isRetiredNotifyTargetRef);
  for (const ref of refs) await secrets.delete(ref);
  if (refs.length > 0) await record('notify.channels_retired', { count: refs.length }).catch(() => undefined);
  return refs.length;
}

// ------------------------------------------------------------------ where it is kept

/** One recorded delivery to a device (ADR 0048), as `push-devices.ts` writes it. */
export interface DeliveryRecord {
  at: string;
  event: string;
  /**
   * Always push now. Deliveries recorded through ntfy, Slack or the webhook
   * before ADR 0049 stay in the event log as history; every reader asks for
   * `source: 'device'`, so none of them reads one.
   */
  transport: 'push';
  source: 'device';
  setAt: string | null;
  person?: string;
  /** The device's id: never its endpoint. */
  device?: string;
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
 * Where the notifier keeps and reads what it needs: the switches and the
 * event log. One seam, so the tests run on memory.
 */
export interface NotifyStore {
  setting(key: 'notifyKinds'): Promise<string | null>;
  /** An empty value clears it. */
  write(values: Partial<Record<'notifyKinds', string>>, by: string): Promise<void>;
  record(type: string, payload: Record<string, unknown>): Promise<void>;
  /** Whether an event of this type was ever recorded with these fields. */
  recorded(type: string, fields?: Record<string, string>): Promise<boolean>;
  /** When the newest event of this type with these fields was recorded, or null for none. */
  lastAt(type: string, fields: Record<string, string>): Promise<string | null>;
  /** Each person's devices (ADR 0048). Absent, nothing is pushed. */
  push?: PushStore;
}

export function databaseNotifyStore(options: { local?: boolean } = {}): NotifyStore {
  return {
    push: databasePushStore(options),
    setting: (key) => settings.getSetting(key),
    write: (values, by) => settings.setSettings(values, by),
    record: async (type, payload) => {
      await recordEvent({ source: 'platform', type, payload });
    },
    recorded: async (type, fields = {}) => (await lastEventAt(type, fields)) !== null,
    lastAt: (type, fields) => lastEventAt(type, fields),
  };
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

/** Whether an unrouted notification would reach an admin, as the `notifications` health check reads it. */
export interface AdminPush {
  /** How many people an unrouted notification goes to. */
  admins: number;
  /** How many devices they have between them. */
  devices: number;
  /** How many of those took their newest push, or have not been sent one yet. */
  receiving: number;
}

export class Notifier {
  constructor(
    private readonly config: BridgeConfig,
    readonly store: NotifyStore = databaseNotifyStore({ local: config.identityMode === 'local' }),
    readonly push: PushStore | null = store.push ?? null,
  ) {}

  /** Each switch, on unless a person turned it off; on when they cannot be read. */
  async switches(): Promise<NotifySwitches> {
    return parseSwitches(await this.store.setting('notifyKinds').catch(() => null));
  }

  /**
   * Who an unrouted notification is for: every admin, or the operator on a
   * local install. One resolver, read by `send` and by `adminPush`, so the
   * health check proves the devices a notification would go to.
   */
  private async admins(): Promise<string[]> {
    if (!this.push) return [];
    return (await this.push.admins()).map((admin) => admin.id);
  }

  /**
   * Pushes to each device of these people. A push service that is down, or a
   * store that cannot be read, must not stop the platform: the gate is
   * already on GitHub and on the board; the notification is the extra.
   */
  private async pushTo(personIds: readonly string[], notification: Notification): Promise<boolean> {
    if (!this.push) return false;
    try {
      const results = await sendToDevices(
        this.push,
        personIds,
        { event: notification.event, text: notification.text, link: notification.link, ...(notification.item ? { item: notification.item } : {}) },
        { consoleUrl: this.config.consoleUrl },
      );
      return results.some((result) => result.ok);
    } catch (error) {
      console.warn(`[bridge] could not push: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Sends one, or says what it would have sent.
   *
   * With no device to send to, the intent is logged: a development install
   * has none, and logging keeps the path exercised rather than dormant.
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

    // Routed: its people's devices only. Someone with no device still has the
    // console's badge and alert, and GitHub's mention. Unrouted: every
    // admin's, since what is for everyone is an admin's to act on.
    const people = notification.people?.length ? [...new Set(notification.people)] : await this.admins().catch(() => [] as string[]);
    const sent = await this.pushTo(people, notification);
    if (!sent) console.log(`[bridge] would notify ${to}: ${notification.text} — ${notification.link}`);
    return sent ? 'sent' : 'logged';
  }

  /**
   * A person's Send a test to one of their devices, whatever the switches say.
   * Null when they have no device by that id.
   */
  async testDevice(personId: string, deviceId: string): Promise<DeliveryResult | null> {
    if (!this.push) return null;
    const device = (await this.push.devices([personId])).find((one) => one.id === deviceId);
    if (!device) return null;
    const { ok, status, error } = await sendToDevice(
      this.push,
      device,
      { event: 'test', text: DEVICE_TEST_TEXT, link: `${this.config.consoleUrl.replace(/\/+$/, '')}/settings/notifications` },
      { consoleUrl: this.config.consoleUrl },
    );
    return { ok, status, error };
  }

  /**
   * Whether an unrouted notification would reach an admin: their devices,
   * and how many took their newest push. A device just added counts until a
   * send to it fails, so turning one on clears the health card at once.
   */
  async adminPush(): Promise<AdminPush> {
    if (!this.push) return { admins: 0, devices: 0, receiving: 0 };
    const admins = await this.admins();
    if (admins.length === 0) return { admins: 0, devices: 0, receiving: 0 };
    const devices = await this.push.devices(admins);
    let receiving = 0;
    for (const person of new Set(devices.map((device) => device.personId))) {
      const deliveries = await this.push.events('notify.delivery', { source: 'device', person });
      for (const device of devices.filter((one) => one.personId === person)) {
        const newest = deliveries.find((event) => event.payload.device === device.id);
        if (!newest || newest.payload.ok === true) receiving += 1;
      }
    }
    return { admins: admins.length, devices: devices.length, receiving };
  }
}

// ------------------------------------------------------------------ Settings → Notifications

/** What Settings → Notifications shows of the install's: which kinds are on. Each person's devices are `/v1/me/push`. */
export interface NotificationSettingsView {
  switches: NotifySwitches;
}

export async function notificationSettingsView(notifier: Notifier): Promise<NotificationSettingsView> {
  return { switches: await notifier.switches() };
}

/** What `PUT /v1/settings/notifications` is given. */
export interface NotificationSettingsInput {
  switches?: Partial<Record<NotifySwitch, boolean>>;
}

/** What a save changed, as it is audited. */
export interface NotificationSettingsChange {
  switches: NotifySwitches;
}

/** The fields a save of the install's channel took before ADR 0049. */
export const RETIRED_FIELDS = ['kind', 'server', 'target'] as const;

/**
 * Saves the switches to `notifyKinds`. A body that still names a channel
 * (`kind`, `server`, `target`) is refused rather than half-saved, so whoever
 * sent it learns the channel is gone. Returns a refusal in words a person can
 * act on, or what changed.
 */
export async function saveNotificationSettings(
  store: NotifyStore,
  input: NotificationSettingsInput,
  by: string,
): Promise<{ ok: false; error: string } | { ok: true; change: NotificationSettingsChange }> {
  if (RETIRED_FIELDS.some((field) => field in input)) return { ok: false, error: RETIRED_CHANNEL_REFUSAL };
  if (typeof input.switches !== 'object' || input.switches === null) return { ok: false, error: 'send {switches}: an object of kinds, each true or false' };
  const switches = parseSwitches(await store.setting('notifyKinds'));
  for (const [name, on] of Object.entries(input.switches)) {
    if (!(NOTIFY_SWITCHES as readonly string[]).includes(name)) return { ok: false, error: `${name} is not a kind of notification: one of ${NOTIFY_SWITCHES.join(', ')}` };
    if (typeof on !== 'boolean') return { ok: false, error: `${name} is true or false` };
    switches[name as NotifySwitch] = on;
  }
  const off = Object.fromEntries(NOTIFY_SWITCHES.filter((name) => !switches[name]).map((name) => [name, false]));
  await store.write({ notifyKinds: Object.keys(off).length > 0 ? JSON.stringify(off) : '' }, by);
  return { ok: true, change: { switches } };
}

/** A store held in memory, for tests and for nothing else. */
export function memoryNotifyStore(initial: { settings?: Record<string, string>; push?: PushStore } = {}): NotifyStore & {
  settings: Record<string, string>;
  events: { type: string; payload: Record<string, unknown>; at: string }[];
} {
  const state = {
    settings: { ...(initial.settings ?? {}) },
    events: [] as { type: string; payload: Record<string, unknown>; at: string }[],
  };
  let tick = 0;
  const matches = (payload: Record<string, unknown>, fields: Record<string, string>) =>
    Object.entries(fields).every(([key, value]) => payload[key] === value);
  return Object.assign(state, {
    ...(initial.push ? { push: initial.push } : {}),
    setting: async (key: string) => state.settings[key] ?? null,
    write: async (values: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        if (value.length === 0) delete state.settings[key];
        else state.settings[key] = value;
      }
    },
    record: async (type: string, payload: Record<string, unknown>) => {
      state.events.push({ type, payload, at: new Date(Date.UTC(2026, 10, 2) + tick++ * 1000).toISOString() });
    },
    recorded: async (type: string, fields: Record<string, string> = {}) => state.events.some((event) => event.type === type && matches(event.payload, fields)),
    lastAt: async (type: string, fields: Record<string, string>) =>
      state.events.filter((event) => event.type === type && matches(event.payload, fields)).at(-1)?.at ?? null,
  });
}
