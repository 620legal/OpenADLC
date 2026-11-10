import { randomUUID } from 'node:crypto';
import { listEventsOfTypeWith, people as peopleStore, pushDevices, recordEvent, withAdvisoryLock, type PushDevice } from '@openadlc/db';
import { getSecretStore, PUSH_DEVICE_PREFIX, pushDeviceRef, pushVapidKeyRef } from '@openadlc/github';
import {
  endpointHash,
  pushPayload,
  pushRequest,
  pushServiceRefusal,
  pushTag,
  subscriptionKeysRefusal,
  vapidKeys,
  vapidSubject,
  type PushSubscription,
  type VapidKeyStore,
} from './web-push.js';

/**
 * A person's devices: each browser or installed app where they turned
 * notifications on (ADR 0048). The row says whose it is and what it is
 * called; the subscription, which is a credential, is only the secret
 * `push-device:<personId>:<deviceId>`. Nothing here logs, records or returns
 * an endpoint or a key: an error that may name the endpoint is redacted first.
 */

export const MAX_DEVICES = 10;
export const TOO_MANY_DEVICES = `You have ${MAX_DEVICES} devices: remove one first`;
export const DEVICE_TEST_TEXT = 'OpenADLC can reach you on this device.';
/** How far back Settings says a device was removed because its browser stopped taking notifications. */
export const DROPPED_SHOWN_MS = 30 * 24 * 60 * 60 * 1000;

export interface PushEvent {
  at: string;
  payload: Record<string, unknown>;
}

/** Where devices, their secrets, the VAPID key and the event log are read and written. One seam, so tests run on memory. */
export interface PushStore extends VapidKeyStore {
  devices(personIds: readonly string[]): Promise<PushDevice[]>;
  addRow(input: { id: string; personId: string; name: string; service: string; endpointHash: string }): Promise<PushDevice>;
  rowId(personId: string, endpointHash: string): Promise<string | null>;
  removeRow(id: string, personId: string): Promise<boolean>;
  removeRowById(id: string): Promise<void>;
  removeRowsFor(personId: string): Promise<void>;
  count(personId: string): Promise<number>;
  allIds(): Promise<string[]>;
  services(): Promise<string[]>;
  secret(ref: string): Promise<string | null>;
  setSecret(ref: string, value: string): Promise<void>;
  deleteSecret(ref: string): Promise<void>;
  listSecrets(prefix: string): Promise<string[]>;
  record(type: string, payload: Record<string, unknown>): Promise<void>;
  /** Events of a type with these fields, newest first. */
  events(type: string, fields: Record<string, string>): Promise<PushEvent[]>;
  /** The people an unrouted notification's push goes to: every admin, or the operator on a local install. */
  admins(): Promise<{ id: string; email: string | null }[]>;
}

export function databasePushStore(options: { local?: boolean } = {}): PushStore {
  return {
    devices: (ids) => pushDevices.listFor(ids),
    addRow: (input) => pushDevices.add(input),
    rowId: (personId, hash) => pushDevices.idFor(personId, hash),
    removeRow: (id, personId) => pushDevices.remove(id, personId),
    removeRowById: (id) => pushDevices.removeById(id),
    removeRowsFor: (personId) => pushDevices.removeFor(personId),
    count: (personId) => pushDevices.count(personId),
    allIds: () => pushDevices.allIds(),
    services: () => pushDevices.services(),
    secret: (ref) => getSecretStore().get(ref),
    setSecret: (ref, value) => getSecretStore().set(ref, value),
    deleteSecret: (ref) => getSecretStore().delete(ref),
    listSecrets: (prefix) => getSecretStore().list(prefix),
    vapidKey: () => getSecretStore().get(pushVapidKeyRef()),
    setVapidKey: (value) => getSecretStore().set(pushVapidKeyRef(), value),
    lockVapid: (fn) => withAdvisoryLock('openadlc:push-vapid', fn),
    record: async (type, payload) => {
      await recordEvent({ source: 'platform', type, payload });
    },
    events: async (type, fields) =>
      (await listEventsOfTypeWith(type, fields)).map((row) => ({ at: row.at, payload: (row.payload ?? {}) as Record<string, unknown> })),
    admins: async () => {
      if (options.local) {
        const operator = await peopleStore.operator();
        return operator ? [{ id: operator.id, email: operator.email }] : [];
      }
      return (await peopleStore.listPeople()).filter((person) => person.consoleRole === 'admin').map((person) => ({ id: person.id, email: person.email }));
    },
  };
}

/** The subscription as the browser's `PushSubscription.toJSON()` gives it, checked. */
export function subscriptionOf(value: unknown): { ok: true; subscription: PushSubscription } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'send {subscription: {endpoint, keys: {p256dh, auth}}, name}' };
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== 'string') return { ok: false, error: 'The subscription has no endpoint: turn notifications on again' };
  const refusal = pushServiceRefusal(endpoint) ?? subscriptionKeysRefusal(keys);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, subscription: { endpoint, keys: { p256dh: String(keys!.p256dh), auth: String(keys!.auth) } } };
}

function parseStored(value: string | null): PushSubscription | null {
  if (!value) return null;
  try {
    const parsed = subscriptionOf(JSON.parse(value));
    return parsed.ok ? parsed.subscription : null;
  } catch {
    return null;
  }
}

/** A device's name as a person sees it: what their browser called itself, cut to fit. */
export function deviceNameOf(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return Array.from(name || 'This device').slice(0, 60).join('');
}

export interface DeviceSeen {
  id: string;
  name: string;
  addedAt: string;
}

/**
 * Saves this browser's subscription for the person. The same browser saving
 * again keeps its id and replaces its secret, so a subscription its browser
 * renewed does not add a second device.
 */
export async function addDevice(
  store: PushStore,
  personId: string,
  input: { subscription: unknown; name: unknown },
): Promise<{ ok: true; device: DeviceSeen; service: string } | { ok: false; error: string }> {
  const parsed = subscriptionOf(input.subscription);
  if (!parsed.ok) return parsed;
  const { subscription } = parsed;
  const hash = endpointHash(subscription.endpoint);
  const service = new URL(subscription.endpoint).hostname.toLowerCase();
  const name = deviceNameOf(input.name);
  const existing = await store.rowId(personId, hash);
  if (!existing && (await store.count(personId)) >= MAX_DEVICES) return { ok: false, error: TOO_MANY_DEVICES };
  // The secret first, under the id the row will have: a secret with no row
  // is swept at start, where a row with no secret would be a device that
  // cannot be sent to. The same browser again keeps its id.
  const id = existing ?? randomUUID();
  const ref = pushDeviceRef(personId, id);
  await store.setSecret(ref, JSON.stringify(subscription));
  let row: PushDevice;
  try {
    row = await store.addRow({ id, personId, name, service, endpointHash: hash });
  } catch (error) {
    if (!existing) await store.deleteSecret(ref).catch(() => undefined);
    throw error;
  }
  return { ok: true, device: { id: row.id, name: row.name, addedAt: row.addedAt }, service };
}

/** Removes one of the person's own devices, the row and then its secret. Null when they have none by that id. */
export async function removeDevice(store: PushStore, personId: string, deviceId: string): Promise<PushDevice | null> {
  const device = (await store.devices([personId])).find((one) => one.id === deviceId);
  if (!device) return null;
  await store.removeRow(deviceId, personId);
  await store.deleteSecret(pushDeviceRef(personId, deviceId));
  return device;
}

/** Takes away every device of a removed person: their secrets by prefix, then their rows. */
export async function forgetDevices(store: PushStore, personId: string): Promise<void> {
  for (const ref of await store.listSecrets(`${PUSH_DEVICE_PREFIX}${personId}:`)) await store.deleteSecret(ref);
  await store.removeRowsFor(personId);
}

/**
 * Deletes each device secret with no row: what a crash between the two
 * writes leaves, or a person removed by the cascade alone. Returns how many.
 */
export async function sweepOrphans(store: PushStore): Promise<number> {
  const ids = new Set(await store.allIds());
  let swept = 0;
  for (const ref of await store.listSecrets(PUSH_DEVICE_PREFIX)) {
    const deviceId = ref.slice(PUSH_DEVICE_PREFIX.length).split(':')[1] ?? '';
    if (ids.has(deviceId)) continue;
    await store.deleteSecret(ref);
    swept += 1;
  }
  return swept;
}

/** What one device is sent. */
export interface PushMessage {
  event: string;
  text: string;
  link: string;
  item?: string;
}

export interface DeviceResult {
  device: string;
  person: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface SendOptions {
  consoleUrl: string;
  fetch?: typeof fetch;
  now?: Date;
}

/**
 * Takes the endpoint out of an error before it is recorded or logged: undici
 * names the URL it could not reach, and the endpoint is the credential.
 */
export function redactEndpoint(text: string, endpoint: string): string {
  let out = text;
  const pieces = [endpoint, endpoint.replace(/\/+$/, '')];
  try {
    const url = new URL(endpoint);
    pieces.push(`${url.pathname}${url.search}`, url.pathname.replace(/^\/+/, ''));
  } catch {
    // Not a URL: the whole of it is all there is to take out.
  }
  for (const piece of pieces.filter((one) => one.length > 1).sort((a, b) => b.length - a.length)) out = out.split(piece).join('…');
  return out;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

/**
 * Sends one message to every device of these people, all at once: `send`
 * runs inside webhook handlers, which must not wait on one slow push service
 * after another. A 404 or 410 says the subscription is gone for good, so the
 * device is dropped; anything else keeps it for the next send.
 */
export async function sendToDevices(store: PushStore, personIds: readonly string[], message: PushMessage, options: SendOptions): Promise<DeviceResult[]> {
  const unique = [...new Set(personIds)];
  if (unique.length === 0) return [];
  const devices = await store.devices(unique);
  if (devices.length === 0) return [];
  return Promise.all(devices.map((device) => sendToDevice(store, device, message, options)));
}

/** One device; a device whose secret is gone is dropped, since nothing can be sent to it. */
export async function sendToDevice(store: PushStore, device: PushDevice, message: PushMessage, options: SendOptions): Promise<DeviceResult> {
  const subscription = parseStored(await store.secret(pushDeviceRef(device.personId, device.id)).catch(() => null));
  if (!subscription) {
    await drop(store, device, null);
    return { device: device.id, person: device.personId, ok: false, status: null, error: 'its subscription is gone' };
  }
  let result: { ok: boolean; status: number | null; error: string | null };
  try {
    const keys = await vapidKeys(store);
    const admin = (await store.admins().catch(() => [])).find((one) => one.email)?.email ?? null;
    const { url, init } = pushRequest(subscription, pushPayload(message), {
      keys,
      sub: vapidSubject(options.consoleUrl, admin),
      tag: pushTag(message),
      ...(options.now ? { now: options.now } : {}),
    });
    const response = await (options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    result = { ok: response.status === 201 || response.status === 202 || response.ok, status: response.status, error: response.ok ? null : response.statusText || null };
  } catch (error) {
    result = { ok: false, status: null, error: messageOf(error) };
  }
  const safe = { ...result, error: result.error === null ? null : redactEndpoint(result.error, subscription.endpoint) };
  if (!safe.ok) console.warn(`[bridge] could not push to device ${device.id} (${device.service}): ${safe.status ?? ''} ${safe.error ?? ''}`.trim());
  await store
    .record('notify.delivery', {
      event: message.event,
      transport: 'push',
      source: 'device',
      person: device.personId,
      device: device.id,
      setAt: device.addedAt,
      ok: safe.ok,
      status: safe.status,
      error: safe.error,
    })
    .catch(() => undefined);
  if (safe.status === 404 || safe.status === 410) await drop(store, device, safe.status);
  return { device: device.id, person: device.personId, ...safe };
}

async function drop(store: PushStore, device: PushDevice, status: number | null): Promise<void> {
  await store.removeRowById(device.id).catch(() => undefined);
  await store.deleteSecret(pushDeviceRef(device.personId, device.id)).catch(() => undefined);
  await store.record('notify.device_dropped', { person: device.personId, device: device.id, name: device.name, status }).catch(() => undefined);
}

// ------------------------------------------------------------------ Settings → Notifications

export interface DeviceView {
  id: string;
  name: string;
  addedAt: string;
  last: { at: string; ok: boolean; status: number | null; error: string | null } | null;
}

export interface DevicesView {
  /** The install's `applicationServerKey`, which a browser subscribes with. */
  key: string;
  devices: DeviceView[];
  /** Every device's newest delivery failed: none of them took the last notification. */
  allFailing: boolean;
  /** Devices dropped since the newest one was added, in the last 30 days. */
  dropped: { name: string; at: string; status: number | null }[];
}

/** What Settings shows a person of their devices: names and dates, never a subscription. */
export async function devicesView(store: PushStore, personId: string, now: Date = new Date()): Promise<DevicesView> {
  const [keys, devices, deliveries, drops] = await Promise.all([
    vapidKeys(store),
    store.devices([personId]),
    store.events('notify.delivery', { source: 'device', person: personId }).catch(() => [] as PushEvent[]),
    store.events('notify.device_dropped', { person: personId }).catch(() => [] as PushEvent[]),
  ]);
  const view: DeviceView[] = devices.map((device) => {
    const newest = deliveries.find((event) => event.payload.device === device.id);
    return {
      id: device.id,
      name: device.name,
      addedAt: device.addedAt,
      last: newest
        ? {
            at: newest.at,
            ok: newest.payload.ok === true,
            status: typeof newest.payload.status === 'number' ? newest.payload.status : null,
            error: typeof newest.payload.error === 'string' ? newest.payload.error : null,
          }
        : null,
    };
  });
  const newestAdd = devices.reduce((latest, device) => (device.addedAt > latest ? device.addedAt : latest), '');
  const since = new Date(now.getTime() - DROPPED_SHOWN_MS).toISOString();
  return {
    key: keys.publicKey,
    devices: view,
    allFailing: view.length > 0 && view.every((device) => device.last !== null && !device.last.ok),
    dropped: drops
      .filter((event) => event.at > since && event.at > newestAdd)
      .map((event) => ({
        name: typeof event.payload.name === 'string' ? event.payload.name : 'A device',
        at: event.at,
        status: typeof event.payload.status === 'number' ? event.payload.status : null,
      })),
  };
}

// ------------------------------------------------------------------ for tests

/** A store held in memory, for tests and for nothing else. */
export function memoryPushStore(initial: { admins?: { id: string; email: string | null }[] } = {}): PushStore & {
  rows: (PushDevice & { endpointHash: string })[];
  secrets: Record<string, string>;
  log: { type: string; payload: Record<string, unknown>; at: string }[];
  adminList: { id: string; email: string | null }[];
} {
  let tick = 0;
  const state = {
    rows: [] as (PushDevice & { endpointHash: string })[],
    secrets: {} as Record<string, string>,
    log: [] as { type: string; payload: Record<string, unknown>; at: string }[],
    adminList: [...(initial.admins ?? [])],
  };
  const stamp = () => new Date(Date.UTC(2026, 10, 10) + tick++ * 1000).toISOString();
  const public_ = (row: PushDevice & { endpointHash: string }): PushDevice => ({
    id: row.id,
    personId: row.personId,
    name: row.name,
    service: row.service,
    addedAt: row.addedAt,
  });
  return Object.assign(state, {
    devices: async (personIds: readonly string[]) => state.rows.filter((row) => personIds.includes(row.personId)).map(public_),
    addRow: async (input: { id: string; personId: string; name: string; service: string; endpointHash: string }) => {
      const found = state.rows.find((row) => row.personId === input.personId && row.endpointHash === input.endpointHash);
      if (found) {
        found.name = input.name;
        found.service = input.service;
        return public_(found);
      }
      const row = { id: input.id, personId: input.personId, name: input.name, service: input.service, addedAt: stamp(), endpointHash: input.endpointHash };
      state.rows.push(row);
      return public_(row);
    },
    rowId: async (personId: string, hash: string) => state.rows.find((row) => row.personId === personId && row.endpointHash === hash)?.id ?? null,
    removeRow: async (id: string, personId: string) => {
      const before = state.rows.length;
      state.rows = state.rows.filter((row) => !(row.id === id && row.personId === personId));
      return state.rows.length < before;
    },
    removeRowById: async (id: string) => {
      state.rows = state.rows.filter((row) => row.id !== id);
    },
    removeRowsFor: async (personId: string) => {
      state.rows = state.rows.filter((row) => row.personId !== personId);
    },
    count: async (personId: string) => state.rows.filter((row) => row.personId === personId).length,
    allIds: async () => state.rows.map((row) => row.id),
    services: async () => [...new Set(state.rows.map((row) => row.service))].sort(),
    secret: async (ref: string) => state.secrets[ref] ?? null,
    setSecret: async (ref: string, value: string) => {
      state.secrets[ref] = value;
    },
    deleteSecret: async (ref: string) => {
      delete state.secrets[ref];
    },
    listSecrets: async (prefix: string) => Object.keys(state.secrets).filter((ref) => ref.startsWith(prefix)).sort(),
    vapidKey: async () => state.secrets['push-vapid-key'] ?? null,
    setVapidKey: async (value: string) => {
      state.secrets['push-vapid-key'] = value;
    },
    lockVapid: <T>(fn: () => Promise<T>) => fn(),
    record: async (type: string, payload: Record<string, unknown>) => {
      state.log.push({ type, payload, at: stamp() });
    },
    events: async (type: string, fields: Record<string, string>) =>
      state.log
        .filter((event) => event.type === type && Object.entries(fields).every(([key, value]) => event.payload[key] === value))
        .reverse()
        .map((event) => ({ at: event.at, payload: event.payload })),
    admins: async () => state.adminList,
  });
}
