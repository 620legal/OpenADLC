import { settings, withAdvisoryLock } from '@fleetadlc/db';
import { HttpFailure, type Router } from './router.js';

/**
 * One seat paused, from Crew: it finishes what it is doing — a running task
 * runs on, and a task waiting on a person's answer resumes when it gets one —
 * and takes no new work until it is resumed. Pausing the install or a
 * repository (`pause-work.ts`) stops everyone; this stops one seat, say while
 * its model is changed or its account looked at, and the rest of the crew
 * goes on.
 *
 * Stored as `workPausedSeats`, JSON keyed by bot name, so a bridge that
 * restarts is still paused; written only through `pauseSeat` and
 * `resumeSeat`, which the Crew routes call and audit (`PATCH /v1/install`
 * refuses the key). Everything that starts new work for a seat asks
 * `TaskService.blocked`, which says the pause as a blocker: a review or a
 * stage the sweeps come back for starts once the seat is resumed, and work
 * only an event starts is recorded with the pause's words for the resume to
 * run again. The dispatcher, which runs on its own,
 * reads the same setting before it leases to a builder.
 */

export interface SeatPause {
  by: string;
  at: string;
  why: string | null;
}

export const SEAT_PAUSE_KEY = 'workPausedSeats';

/** The words every refusal on a paused seat begins with; the resume looks for them to run held work again. */
export const SEAT_PAUSED = 'is paused';

/** Each paused seat's pause, by bot name. A value that does not read pauses nobody: it names no seat to hold. */
export function seatPausesFrom(stored: string | null): Record<string, SeatPause> {
  if (!stored) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, SeatPause> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = (value ?? {}) as Partial<SeatPause>;
    out[name] = {
      by: typeof entry.by === 'string' ? entry.by : 'someone',
      at: typeof entry.at === 'string' ? entry.at : new Date(0).toISOString(),
      why: typeof entry.why === 'string' && entry.why ? entry.why : null,
    };
  }
  return out;
}

/** Every seat's pause, as stored now. One that cannot be read holds nobody back, as a health row that cannot be read does not. */
export async function readSeatPauses(read: () => Promise<string | null> = () => settings.getSetting(SEAT_PAUSE_KEY)): Promise<Record<string, SeatPause>> {
  try {
    return seatPausesFrom(await read());
  } catch {
    return {};
  }
}

/** "builder is paused by janedoe: changing its model". */
export function seatPausedWords(seat: string, pause: SeatPause): string {
  return `${seat} ${SEAT_PAUSED} by ${pause.by}${pause.why ? `: ${pause.why}` : ''}`;
}

/** Why this seat takes no new work, in the words a refusal uses, or null when it is not paused. */
export async function seatPausedReason(seat: string, read?: () => Promise<string | null>): Promise<string | null> {
  const pause = (await readSeatPauses(read))[seat];
  return pause ? seatPausedWords(seat, pause) : null;
}

export interface SeatPauseStore {
  read(): Promise<string | null>;
  write(value: string, by: string): Promise<void>;
  /** Runs `fn` while no other pause or resume of a seat runs, in any process. */
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

const LIVE: SeatPauseStore = {
  read: () => settings.getSetting(SEAT_PAUSE_KEY),
  write: (value, by) => settings.setSetting(SEAT_PAUSE_KEY, value, by),
  exclusive: (key, fn) => withAdvisoryLock(key, fn),
};

/**
 * Every seat's pause is one value, read, changed and written back whole. Two
 * at once each read the same value, and the second write lost the first: two
 * seats paused and only one held, or a seat resumed and then paused again by
 * a pause of another seat. As `WORK_PAUSE_LOCK` is for the install's.
 */
export const SEAT_PAUSE_LOCK = 'bridge:seat-pause';

/** Pauses one seat; pausing one already paused keeps who paused it first and when. */
export async function pauseSeat(seat: string, by: string, why: string | null, store: SeatPauseStore = LIVE, now = new Date()): Promise<SeatPause> {
  return store.exclusive(SEAT_PAUSE_LOCK, async () => {
    const all = seatPausesFrom(await store.read());
    const pause = all[seat] ?? { by, at: now.toISOString(), why };
    all[seat] = { ...pause, why: why ?? pause.why };
    await store.write(JSON.stringify(all), by);
    return all[seat]!;
  });
}

/** Resumes one seat, and says what its pause was, or null when it was not paused. */
export async function resumeSeat(seat: string, by: string, store: SeatPauseStore = LIVE): Promise<SeatPause | null> {
  return store.exclusive(SEAT_PAUSE_LOCK, async () => {
    const all = seatPausesFrom(await store.read());
    const was = all[seat] ?? null;
    if (!was) return null;
    delete all[seat];
    await store.write(JSON.stringify(all), by);
    return was;
  });
}

/** What the seat routes need beyond the store, given so a test can see each step. */
export interface SeatPauseRouteDeps {
  store?: SeatPauseStore;
  /** The bot a route names, by its name or its seat. */
  botNamed(name: string): Promise<{ id: string; name: string } | null>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
  /**
   * What starts the work the pause held, once it is resumed: the request
   * queue's drain, the gates' reviews and lead, a dispatch, and the work only
   * an event starts, which was recorded with the pause's words.
   */
  resumed?(seat: string): Promise<void>;
}

/**
 * `POST /v1/crew/:bot/pause` with `{ reason? }`, and `POST /v1/crew/:bot/resume`.
 * Both are an admin's (`roles.ts`), and both are audited, as the install's
 * and a repository's pauses are.
 */
export function registerSeatPauseRoutes(router: Router, deps: SeatPauseRouteDeps): void {
  const seatOf = async (name: string | undefined) => {
    const bot = await deps.botNamed(name ?? '');
    if (!bot) throw new HttpFailure(404, `unknown bot ${name ?? ''}`);
    return bot;
  };

  router.post('/v1/crew/:bot/pause', async ({ params, body, identity }) => {
    const bot = await seatOf(params.bot);
    const input = await body<{ reason?: unknown }>().catch(() => ({}) as { reason?: unknown });
    const why = typeof input?.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 300) : null;
    const pause = await pauseSeat(bot.name, identity, why, deps.store);
    await deps.audit({ actor: identity, action: 'seat.paused', target: bot.name, payload: { why } });
    return { seat: bot.name, seatPaused: pause };
  });

  router.post('/v1/crew/:bot/resume', async ({ params, identity }) => {
    const bot = await seatOf(params.bot);
    const was = await resumeSeat(bot.name, identity, deps.store);
    if (was) {
      await deps.audit({ actor: identity, action: 'seat.resumed', target: bot.name, payload: { pausedBy: was.by, pausedAt: was.at } });
      await deps.resumed?.(bot.name).catch((error: unknown) =>
        console.warn(`[bridge] ${bot.name} resumed, but what it held did not all start: ${error instanceof Error ? error.message : error}`),
      );
    }
    return { seat: bot.name, seatPaused: null, wasPaused: Boolean(was) };
  });
}

/**
 * The work a seat's pause held that only an event starts — a patch round, a
 * revert, a verification — recorded as failed with the pause's words
 * (`TaskService.open`, `whenBlocked: 'record'`). Nothing comes back for it on
 * its own, so the resume runs each again: the newest per subject, and none a
 * later task of the seat's has already taken up.
 *
 * `seatTasks` are the seat's own, so the words may name any name the bot has
 * had: a pause moves with a rename, and the work held under the old name was
 * never run again when the marker named only the new one. The install's and a
 * repository's pause say `work is paused, by` and `work is paused in api, by`,
 * with a comma, so they are not taken for a seat's.
 */
export function heldBySeatPause<T extends { id: string; subjectRef: string; state: string; exitReason?: string | null; createdAt: string }>(
  seatTasks: readonly T[],
): T[] {
  const marker = new RegExp(`(?:^|\\s)[\\w.-]+ ${SEAT_PAUSED} by `);
  const newest = new Map<string, T>();
  for (const task of [...seatTasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    if (!newest.has(task.subjectRef)) newest.set(task.subjectRef, task);
  }
  return [...newest.values()].filter((task) => task.state === 'failed' && marker.test(task.exitReason ?? ''));
}
