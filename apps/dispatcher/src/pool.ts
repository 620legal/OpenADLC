import { maxTasksOf, nextSeat, type BotRole } from '@fleetadlc/shared';

interface Seated {
  id: string;
  name: string;
  slot: string;
  role: BotRole;
  /** The GitHub account it is on; null until it is put on one. */
  githubLogin: string | null;
  /** How many tasks it runs at once (`bots.max_tasks`); absent reads as one. */
  maxTasks?: number;
}

/**
 * A builder beside the owner that is on no GitHub account yet, while the owner
 * is on one: a seat just added from settings, before a person has chosen its
 * account. Work leased to it fails at once — it cannot push, or open a pull
 * request — and its lease holds the issue's paths until something lets it go.
 *
 * Never when engines are scripted, as `holdFor` skips its GitHub holds there:
 * the work is fabricated and pushes nothing, and the concurrency suite adds a
 * `builder-2` with no account on an install whose owner may be connected for
 * the live suites. Nor while the owner has no account either, which is every
 * scratch and CI install.
 */
function waitingForAccount(bot: Seated, owner: Seated, options: PoolOptions): boolean {
  return !options.scripted && bot.githubLogin === null && owner.githubLogin !== null;
}

export interface PoolOptions {
  /** `FLEETADLC_SCRIPTED_ENGINES`: nothing reaches GitHub, so an account decides nothing. */
  scripted?: boolean;
}

/** The other bots with the owner's role, in seat order, and which of them wait for an account. */
function sameRoleOthers<T extends Seated>(owner: T, crew: readonly T[], options: PoolOptions): { ready: T[]; waiting: T[] } {
  const others = crew
    .filter((bot) => bot.id !== owner.id && bot.role === owner.role)
    .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true }));
  return {
    ready: others.filter((bot) => !waitingForAccount(bot, owner, options)),
    waiting: others.filter((bot) => waitingForAccount(bot, owner, options)),
  };
}

/**
 * Who builds in a repository: its owner, then every other bot with the
 * owner's role, in seat order, up to `concurrency` seats (the dispatcher
 * passes no cap; `builderSlots` applies the repository's concurrency).
 *
 * They used to be found by name — the owner's, with `-2`, `-3` after it —
 * which stopped meaning anything when a bot started going by its account's
 * handle: nobody's second builder is called `fleetadlc-atlas-janedoe-2`. The
 * role is what makes a bot a builder, and the seats keep a stable order for
 * the ones after the owner.
 *
 * A builder on no account yet is left out (`waitingForAccount`). The owner is not:
 * whether it can sign in is the hold's question (`hold.ts`), which says so.
 */
export function builderPool<T extends Seated>(
  owner: T,
  crew: readonly T[],
  concurrency: number,
  options: PoolOptions = {},
): T[] {
  return [owner, ...sameRoleOthers(owner, crew, options).ready].slice(0, concurrency);
}

/**
 * The places a repository's next builds can go, one entry per task that can
 * start: the owner first, filled to the tasks it has room for, then each other
 * builder in seat order the same way, and no more than `limit` in all.
 *
 * A seat runs as many tasks at once as its tasks-at-once setting (maxTasks)
 * allows, each in a computer of its own, so a second build no longer needs a
 * second seat; it needs room on one. `room` is how many more a seat can take now.
 */
export function builderSlots<T extends Seated>(seats: readonly T[], room: (seat: T) => number, limit: number): T[] {
  const slots: T[] = [];
  for (const seat of seats) {
    for (let free = room(seat); free > 0 && slots.length < limit; free -= 1) slots.push(seat);
    if (slots.length >= limit) break;
  }
  return slots;
}

/** What the builders can run at once between them: the sum of their tasks-at-once settings (maxTasks). */
export function combinedTasks(seats: readonly Seated[]): number {
  return seats.reduce((sum, seat) => sum + maxTasksOf(seat), 0);
}

/**
 * What to say when a repository asks to build more at once than its builders
 * can run between them: the builders waiting for an account, when there are
 * any, or else the two ways to give it more — a builder's tasks at once, or
 * another seat, which is the owner's with the next number.
 */
export function missingBuildersReason(
  owner: Seated,
  crew: readonly Seated[],
  pool: readonly Seated[],
  concurrency: number,
  options: PoolOptions = {},
): string {
  const seat = nextSeat(
    owner.slot,
    crew.map((bot) => bot.slot),
  );
  const combined = combinedTasks(pool);
  const { waiting } = sameRoleOthers(owner, crew, options);
  if (waiting.length > 0) {
    return `concurrency is ${concurrency} but the builders that can work run ${combined} task(s) at once; put ${waiting.map((bot) => bot.name).join(', ')} on a GitHub account in Settings → Crew`;
  }
  return `concurrency is ${concurrency} but the builders' combined maxTasks is ${combined}; raise a builder's tasks at once on the Crew page, or add a ${seat} seat in Settings → Crew`;
}

/**
 * Why a repository's owner cannot build, when it cannot: it thinks with no
 * model. Every task leased to it would fail, somewhere nobody looks, so the
 * repository is skipped with this as the reason instead.
 *
 * The walkthrough used to make the automation account the owner of the
 * repository it added, and that account's engine is `none`. The console shows
 * the owner and cannot change it, so the reason says where it is changed:
 * config/repos.yaml. A setting the entry leaves out keeps the row's value at
 * every seed (`upsertRepo`), so naming the owner there changes nothing else.
 */
export function ownerCannotBuild(owner: { name: string; engine: string }, repo: string): string | null {
  if (owner.engine !== 'none') return null;
  return (
    `${owner.name} owns ${repo} but thinks with no model, so nothing is leased to it; ` +
    `set \`owner: builder\` for ${repo} in config/repos.yaml and run \`fleetadlc seed\` ` +
    '(settings the entry leaves out keep what the console set)'
  );
}
