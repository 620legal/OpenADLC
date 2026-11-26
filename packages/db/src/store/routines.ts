import type { RoutineCadence, RoutineKind } from '@openadlc/shared';
import { query, queryOne } from '../client.js';

/**
 * Routines (migration 0174, docs/adr/0090): console requests the bridge files
 * as their owner on a schedule. The bridge's `routines` job reads `due`,
 * claims each slot with `claimSlot`, and writes what happened with
 * `recordRun`; the console's routes create, edit, pause and delete them.
 */

export type RoutineOutcome = 'filed' | 'skipped' | 'failed';

/** The approver a routine files as: who last created or edited it. */
export interface RoutineOwner {
  /** The console identity the request is filed as. */
  identity: string;
  /** The GitHub account linked to them, whose Approves is read at each firing. */
  login: string;
  githubId: number;
}

export interface Routine {
  id: string;
  repoId: string;
  /** The repository's name, as the install lists it and `fileRequest` takes it. */
  repo: string;
  repoFullName: string;
  text: string;
  details: string | null;
  kind: RoutineKind;
  cadence: RoutineCadence;
  /** `HH:MM` on the wall clock of `timeZone`. */
  time: string;
  timeZone: string;
  paused: boolean;
  owner: RoutineOwner;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /** Null exactly when paused. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRequestId: string | null;
  /** The last request's state, read with the routine; null when there is none or it is gone. */
  lastRequestState: string | null;
  lastOutcome: RoutineOutcome | null;
  /** Why the last firing filed nothing, or why filing failed; cleared when one files. */
  lastSkipReason: string | null;
}

/** What a create or an edit writes, cleaned by `validateRoutine` beforehand. */
export interface RoutineFields {
  repoId: string;
  text: string;
  details: string | null;
  kind: RoutineKind;
  cadence: RoutineCadence;
  time: string;
  timeZone: string;
}

interface Row {
  id: string;
  repo_id: string;
  repo_name: string;
  repo_full_name: string;
  text: string;
  details: string | null;
  kind: RoutineKind;
  cadence: 'daily' | 'weekly' | 'monthly';
  cadence_day: number | null;
  time_of_day: string;
  time_zone: string;
  paused: boolean;
  owner_identity: string;
  owner_login: string;
  owner_github_id: string | number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_request_id: string | null;
  last_request_state: string | null;
  last_outcome: RoutineOutcome | null;
  last_skip_reason: string | null;
}

const SELECT = `
  select t.*, r.name as repo_name, r.full_name as repo_full_name, q.state as last_request_state
    from routines t
    join repos r on r.id = t.repo_id
    left join requests q on q.id = t.last_request_id
`;

/** A statement that changes one row, read back with its repository and last request. */
function returning(sql: string): string {
  return `with t as (${sql} returning *)
    select t.*, r.name as repo_name, r.full_name as repo_full_name, q.state as last_request_state
      from t join repos r on r.id = t.repo_id left join requests q on q.id = t.last_request_id`;
}

function cadenceColumns(cadence: RoutineCadence): ['daily' | 'weekly' | 'monthly', number | null] {
  if (cadence.every === 'week') return ['weekly', cadence.weekday];
  if (cadence.every === 'month') return ['monthly', cadence.day];
  return ['daily', null];
}

function cadenceOf(row: Pick<Row, 'cadence' | 'cadence_day'>): RoutineCadence {
  if (row.cadence === 'weekly') return { every: 'week', weekday: Number(row.cadence_day) };
  if (row.cadence === 'monthly') return { every: 'month', day: Number(row.cadence_day) };
  return { every: 'day' };
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toRoutine(row: Row): Routine {
  return {
    id: row.id,
    repoId: row.repo_id,
    repo: row.repo_name,
    repoFullName: row.repo_full_name,
    text: row.text,
    details: row.details,
    kind: row.kind,
    cadence: cadenceOf(row),
    time: row.time_of_day,
    timeZone: row.time_zone,
    paused: row.paused,
    owner: { identity: row.owner_identity, login: row.owner_login, githubId: Number(row.owner_github_id) },
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    nextRunAt: iso(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
    lastRequestId: row.last_request_id,
    lastRequestState: row.last_request_state ?? null,
    lastOutcome: row.last_outcome,
    lastSkipReason: row.last_skip_reason,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function create(input: RoutineFields & { owner: RoutineOwner; by: string; nextRunAt: Date }): Promise<Routine> {
  const [cadence, day] = cadenceColumns(input.cadence);
  const row = await queryOne<Row>(
    returning(
      `insert into routines (repo_id, text, details, kind, cadence, cadence_day, time_of_day, time_zone,
                             owner_identity, owner_login, owner_github_id, created_by, updated_by, next_run_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
    ),
    [input.repoId, input.text, input.details, input.kind, cadence, day, input.time, input.timeZone, input.owner.identity, input.owner.login, input.owner.githubId, input.by, input.nextRunAt],
  );
  if (!row) throw new Error('failed to create the routine');
  return toRoutine(row);
}

/**
 * An edit: what it says, and its owner becomes whoever edited it. A paused
 * routine stays paused, with no next run; otherwise `nextRunAt` is its next.
 */
export async function update(id: string, input: RoutineFields & { owner: RoutineOwner; by: string; nextRunAt: Date }): Promise<Routine | null> {
  if (!UUID.test(id)) return null;
  const [cadence, day] = cadenceColumns(input.cadence);
  const row = await queryOne<Row>(
    returning(
      `update routines set
         repo_id = $2, text = $3, details = $4, kind = $5, cadence = $6, cadence_day = $7, time_of_day = $8, time_zone = $9,
         owner_identity = $10, owner_login = $11, owner_github_id = $12, updated_by = $13, updated_at = now(),
         next_run_at = case when paused then null else $14::timestamptz end
       where id = $1`,
    ),
    [id, input.repoId, input.text, input.details, input.kind, cadence, day, input.time, input.timeZone, input.owner.identity, input.owner.login, input.owner.githubId, input.by, input.nextRunAt],
  );
  return row ? toRoutine(row) : null;
}

export async function get(id: string): Promise<Routine | null> {
  if (!UUID.test(id)) return null;
  const row = await queryOne<Row>(`${SELECT} where t.id = $1`, [id]);
  return row ? toRoutine(row) : null;
}

/** Every routine, by repository and then oldest first. */
export async function list(): Promise<Routine[]> {
  const rows = await query<Row>(`${SELECT} order by r.name, t.created_at, t.id`);
  return rows.map(toRoutine);
}

/** Pauses (with `nextRunAt` null) or resumes (with its next slot); the owner stays. */
export async function setPaused(id: string, paused: boolean, nextRunAt: Date | null, by: string): Promise<Routine | null> {
  if (!UUID.test(id)) return null;
  const row = await queryOne<Row>(
    returning(`update routines set paused = $2, next_run_at = $3, updated_by = $4, updated_at = now() where id = $1`),
    [id, paused, paused ? null : nextRunAt, by],
  );
  return row ? toRoutine(row) : null;
}

/** Deletes it; the requests it filed stay, their `routine_id` cleared by the key. */
export async function remove(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await query<{ id: string }>('delete from routines where id = $1 returning id', [id]);
  return rows.length > 0;
}

/**
 * The routines due at `now`, oldest slot first: not paused, and in a
 * repository the install still manages, so a routine never files a request
 * with no repository.
 */
export async function due(now: Date): Promise<Routine[]> {
  const rows = await query<Row>(`${SELECT} where not t.paused and t.next_run_at <= $1 and r.removed_at is null order by t.next_run_at, t.id`, [now]);
  return rows.map(toRoutine);
}

/**
 * Takes a due slot by moving `next_run_at` on, in one statement: of two
 * bridges or two overlapping ticks, only the one whose update found the slot
 * it read gets it. False when another took it, or it was paused or edited
 * since it was read.
 */
export async function claimSlot(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'update routines set next_run_at = $3 where id = $1 and not paused and next_run_at = $2 returning id',
    [id, expectedNextRunAt, newNextRunAt],
  );
  return rows.length > 0;
}

/**
 * What a claimed slot came to. A filed run points at its request and clears
 * the last skip; a skip or a failure keeps the request filed before, which
 * the next firing's open check and the page's link still read.
 */
export async function recordRun(id: string, run: { at: Date; outcome: RoutineOutcome; requestId?: string | null; skipReason?: string | null }): Promise<void> {
  await query(
    `update routines set
       last_run_at = $2,
       last_outcome = $3,
       last_request_id = case when $3 = 'filed' then $4::uuid else last_request_id end,
       last_skip_reason = case when $3 = 'filed' then null else $5 end
     where id = $1`,
    [id, run.at, run.outcome, run.requestId ?? null, run.skipReason ?? null],
  );
}

/**
 * Whether a request a routine filed is still open, from the bridge's own
 * records and no GitHub call (ADR 0078's meaning): queued, a draft or
 * waiting on questions; or filed with an issue or pull request of its work
 * item still open, or with an issue the board has no row for yet, which
 * counts as open since a state nobody can read is never a reason to file a
 * second. Abandoned, or no longer there, is not open.
 */
export async function previousOpen(requestId: string): Promise<boolean> {
  const row = await queryOne<{ state: string; open_link: boolean; unlinked_issue: boolean }>(
    `select q.state,
            exists (
              select 1 from work_item_links mine
                join work_item_links l on l.work_item_id = mine.work_item_id
               where mine.request_id = q.id and l.kind in ('issue', 'pull') and l.state = 'open'
            ) as open_link,
            exists (
              select 1 from request_issues ri
               where ri.request_id = q.id
                 and not exists (select 1 from work_item_links l where l.repo_id = ri.repo_id and l.number = ri.issue_number)
            ) as unlinked_issue
       from requests q
      where q.id = $1`,
    [requestId],
  );
  if (!row) return false;
  if (row.state === 'queued' || row.state === 'draft' || row.state === 'questions') return true;
  if (row.state === 'filed') return Boolean(row.open_link) || Boolean(row.unlinked_issue);
  return false;
}
