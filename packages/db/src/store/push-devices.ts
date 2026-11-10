import { query } from '../client.js';

/**
 * One browser or installed app that takes a person's Web Push. Its
 * subscription is not here: it is the secret `push-device:<personId>:<id>`,
 * and this row only says whose it is, what it is called and where it goes.
 * See `migrations/0164_push_devices.sql`.
 */
export interface PushDevice {
  id: string;
  personId: string;
  name: string;
  /** The push service's host, such as web.push.apple.com. */
  service: string;
  addedAt: string;
}

interface Row {
  id: string;
  person_id: string;
  name: string;
  service: string;
  added_at: Date;
}

function toDevice(row: Row): PushDevice {
  return { id: row.id, personId: row.person_id, name: row.name, service: row.service, addedAt: row.added_at.toISOString() };
}

const COLUMNS = 'id, person_id, name, service, added_at';

/** Each device of these people, oldest first. */
export async function listFor(personIds: readonly string[]): Promise<PushDevice[]> {
  if (personIds.length === 0) return [];
  const rows = await query<Row>(`select ${COLUMNS} from push_devices where person_id = any($1::uuid[]) order by added_at, id`, [[...personIds]]);
  return rows.map(toDevice);
}

/**
 * Adds one under the id the bridge made, so its secret can be written first;
 * or renames the one this browser saved before: the same endpoint
 * keeps its id, so its secret is replaced rather than a second one made.
 */
export async function add(input: { id: string; personId: string; name: string; service: string; endpointHash: string }): Promise<PushDevice> {
  const rows = await query<Row>(
    `insert into push_devices (id, person_id, name, service, endpoint_hash)
     values ($1, $2, $3, $4, $5)
     on conflict (person_id, endpoint_hash) do update set name = excluded.name, service = excluded.service
     returning ${COLUMNS}`,
    [input.id, input.personId, input.name, input.service, input.endpointHash],
  );
  const row = rows[0];
  if (!row) throw new Error('the device was not saved');
  return toDevice(row);
}

/** The id the row for this endpoint already has, or null. */
export async function idFor(personId: string, endpointHash: string): Promise<string | null> {
  const rows = await query<{ id: string }>('select id from push_devices where person_id = $1 and endpoint_hash = $2', [personId, endpointHash]);
  return rows[0]?.id ?? null;
}

/** Removes one of this person's own; false when they have none by that id. */
export async function remove(id: string, personId: string): Promise<boolean> {
  const rows = await query<{ id: string }>('delete from push_devices where id = $1 and person_id = $2 returning id', [id, personId]);
  return rows.length > 0;
}

/** Removes one whoever's it is: a push service said its subscription is gone. */
export async function removeById(id: string): Promise<void> {
  await query('delete from push_devices where id = $1', [id]);
}

/** Removes every device of one person. */
export async function removeFor(personId: string): Promise<void> {
  await query('delete from push_devices where person_id = $1', [personId]);
}

export async function count(personId: string): Promise<number> {
  const rows = await query<{ n: string | number }>('select count(*) as n from push_devices where person_id = $1', [personId]);
  return Number(rows[0]?.n ?? 0);
}

/** Every device's id, which a secret with no row is judged against. */
export async function allIds(): Promise<string[]> {
  const rows = await query<{ id: string }>('select id from push_devices');
  return rows.map((row) => row.id);
}

/** Each push service a device uses, once. */
export async function services(): Promise<string[]> {
  const rows = await query<{ service: string }>('select distinct service from push_devices order by service');
  return rows.map((row) => row.service);
}
