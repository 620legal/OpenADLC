import { query } from '../client.js';

/**
 * What the install has under way that a sleeping host would stop: tasks
 * queued or running, merges the line is working on, and deploys waiting on a
 * promote or still running. The bridge holds its host awake while any is
 * above zero (the bridge's `keep-awake.ts`).
 */
export interface InFlight {
  tasks: number;
  merges: number;
  deploys: number;
}

/**
 * Deploy and merge rows untouched for longer than this are a fault rather
 * than work: one stuck for a day would otherwise keep a laptop awake for good.
 * Tasks need no bound, since reconcile fails the stale ones.
 */
export const STALE_AFTER = '24 hours';

/**
 * The same condition as `PROMOTABLE` in `deploy-runs.ts`: a promote waits on
 * its soak or a person only for a commit whose smoke passed and that was
 * neither sent back nor rolled back.
 */
const PROMOTABLE = `smoke_conclusion = 'success' and sent_back_at is null and rollback_dispatched_at is null`;

/**
 * One statement, so the three counts are of one moment. A `paused` task waits
 * on a person and a merge `waiting` is held for a person, an approval or a
 * stack: neither is work a sleep interrupts.
 */
export async function inFlight(): Promise<InFlight> {
  const [row] = await query<{ tasks: number | string; merges: number | string; deploys: number | string }>(
    `select
       (select count(*) from tasks where state in ('queued', 'running')) as tasks,
       (select count(*) from merge_lines
          where state in ('updating', 'testing', 'merging') and updated_at > now() - interval '${STALE_AFTER}') as merges,
       (select count(*) from deploy_runs
          where updated_at > now() - interval '${STALE_AFTER}'
            and (
              (promote_dispatched_at is null and (promote_after is not null or promote_held_at is not null) and ${PROMOTABLE})
              or (testing_dispatched_at is not null and testing_conclusion is null)
              or (promote_dispatched_at is not null and production_conclusion is null)
            )) as deploys`,
  );
  return { tasks: Number(row?.tasks ?? 0), merges: Number(row?.merges ?? 0), deploys: Number(row?.deploys ?? 0) };
}
