import type { Routine, routines as routineStore } from '@openadlc/db';
import { nextRunAt, type RoutineKind, type RoutineSkipReason } from '@openadlc/shared';

/**
 * Files the routines that fall due (#369,
 * docs/adr/0090-a-routine-files-a-console-request-as-its-owner-from-a-claimed-slot.md).
 *
 * The `routines` job calls `fire` every minute. Each due routine's slot is
 * claimed first, by moving `next_run_at` to the first slot after this minute
 * with a conditional update. That one rule is the schedule:
 *
 * - **One firing per claim.** A bridge that was down for three days claims
 *   once and files once, not once per missed slot, and two ticks or two
 *   bridges never both file one slot.
 * - **A skip still spends the slot**, so a routine that skipped while work was
 *   paused does not fire later in a burst.
 * - **A slot is lost rather than doubled** when the bridge stops between the
 *   claim and the filing; a filing that fails is recorded, not tried again
 *   every minute.
 *
 * Then, in order, it skips while work is paused, while the monthly cap stops
 * leasing, while its owner no longer has Approves on in People, and while the
 * request it filed last is still open; otherwise it files one console request
 * through `fileRequest`, as its owner, marked as this routine's.
 */

/** What `fileRequest` takes from a routine, as `POST /v1/requests` takes a body. */
export interface RoutineRequest {
  repo: string;
  text: string;
  context: string | null;
  kind: RoutineKind;
}

/** `fileRequest` in `api.ts`, given once the console's API is registered: the same function, not a copy. */
export type RoutineFile = (request: RoutineRequest, identity: string, options: { routineId: string }) => Promise<{ id: string }>;

export interface RoutineServiceDeps {
  store: Pick<typeof routineStore, 'due' | 'claimSlot' | 'recordRun' | 'previousOpen'>;
  /** Why work is paused for a repository, across the install or in it (`DispatchGate.paused`); null while it runs. */
  paused(repo: string): string | null;
  /** The monthly budget when it stops leasing: reached, with `costs.onCap.stopLeasing` on. Null otherwise. */
  capReached(): Promise<{ spentUsd: number; capUsd: number } | null>;
  /** Whether the person a GitHub account is linked to is in People with Approves on. */
  approves(githubUserId: number): Promise<boolean>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
}

/** The audit actions a firing writes, on `routine:<id>`. */
export const ROUTINE_FILED = 'routine.filed';
export const ROUTINE_SKIPPED = 'routine.skipped';
export const ROUTINE_FAILED = 'routine.failed';

const MINUTE = 60_000;

const id8 = (id: string) => id.slice(0, 8);

export class RoutineService {
  private file: RoutineFile | null = null;

  constructor(private readonly deps: RoutineServiceDeps) {}

  /**
   * Given by `registerConsoleApi`, which holds `fileRequest`. Until then
   * nothing is claimed: a slot spent with nothing to file it would be lost.
   */
  useFiler(file: RoutineFile): void {
    this.file = file;
  }

  /** Files or skips each routine due at `now`, and says what it did, one line each. */
  async fire(now: Date = new Date()): Promise<string[]> {
    const file = this.file;
    if (!file) return ['routines wait for the console API, which files their requests'];
    const lines: string[] = [];
    for (const routine of await this.deps.store.due(now)) {
      // One routine that cannot be claimed (a stored zone Intl no longer
      // knows, a lost connection) does not hold up the others.
      lines.push(
        ...(await this.fireOne(routine, now, file).catch((error: unknown) => [
          `routine ${id8(routine.id)} (${routine.repo}) could not be fired: ${error instanceof Error ? error.message : String(error)}`,
        ])),
      );
    }
    return lines;
  }

  private async fireOne(routine: Routine, now: Date, file: RoutineFile): Promise<string[]> {
    if (!routine.nextRunAt) return [];
    // The first slot strictly after this minute, however many were missed:
    // one claim, one firing.
    const thisMinute = Math.floor(now.getTime() / MINUTE) * MINUTE;
    const next = nextRunAt(new Date(thisMinute + MINUTE), routine.cadence, routine.time, routine.timeZone);
    if (!(await this.deps.store.claimSlot(routine.id, new Date(routine.nextRunAt), next))) return [];

    const name = `routine ${id8(routine.id)} (${routine.repo})`;
    let filed: { id: string };
    try {
      const skip = await this.skipOf(routine);
      if (skip) {
        await this.deps.store.recordRun(routine.id, { at: now, outcome: 'skipped', skipReason: skip.message });
        await this.audit(routine, ROUTINE_SKIPPED, { reason: skip.reason, message: skip.message, nextRunAt: next.toISOString() });
        return [`${name} skipped: ${skip.message}`];
      }
      filed = await file({ repo: routine.repo, text: routine.text, context: routine.details, kind: routine.kind }, routine.owner.identity, { routineId: routine.id });
    } catch (error) {
      // The slot is already spent, so a failing intake (a 409 while it is not
      // ready) is said on the routine rather than tried again every minute.
      const message = `Filing its request failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.deps.store.recordRun(routine.id, { at: now, outcome: 'failed', skipReason: message }).catch(() => undefined);
      await this.audit(routine, ROUTINE_FAILED, { message, nextRunAt: next.toISOString() }).catch(() => undefined);
      return [`${name} failed: ${message}`];
    }
    // Filed: whatever goes wrong writing that down, it is not called a failure.
    const line = `${name} filed request:${id8(filed.id)} as ${routine.owner.identity}`;
    try {
      await this.deps.store.recordRun(routine.id, { at: now, outcome: 'filed', requestId: filed.id });
      await this.audit(routine, ROUTINE_FILED, { requestId: filed.id, nextRunAt: next.toISOString() });
    } catch (error) {
      return [`${line}, but could not record it: ${error instanceof Error ? error.message : String(error)}`];
    }
    return [line];
  }

  /** Why this firing files nothing, checked in the order ADR 0090 gives; null when it files. */
  private async skipOf(routine: Routine): Promise<{ reason: RoutineSkipReason; message: string } | null> {
    const paused = this.deps.paused(routine.repo);
    if (paused) return { reason: 'paused', message: `Work is paused: ${paused}` };

    const cap = await this.deps.capReached();
    if (cap) return { reason: 'cap', message: `The monthly cap is reached ($${cap.spentUsd.toFixed(2)} of $${cap.capUsd.toFixed(2)})` };

    // Stays unpaused: it files again at the first firing after the owner has
    // Approves back, or after an approver edits it and so takes it over.
    if (!(await this.deps.approves(routine.owner.githubId))) {
      return {
        reason: 'approves',
        message: `@${routine.owner.login} no longer has Approves on (or is not in People): an approver can edit this routine to take it over`,
      };
    }

    if (routine.lastRequestId && (await this.deps.store.previousOpen(routine.lastRequestId))) {
      return { reason: 'open', message: `Its last request request:${id8(routine.lastRequestId)} is still open` };
    }
    return null;
  }

  private async audit(routine: Routine, action: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.audit({ actor: 'routines', action, target: `routine:${routine.id}`, payload: { repo: routine.repo, owner: routine.owner.login, ...payload } });
  }
}
