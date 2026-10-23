import { costs, hosts as hostStore, issues as issueStore, leases as leaseStore, listEventsOfType, type HealthRow } from '@openadlc/db';
import { blockingOverlaps, type WorkInFlight } from '@openadlc/dispatcher';
import {
  DEFAULT_PATH_POLICY,
  dependencyIsSatisfied,
  hasAbandonedLabel,
  hasNextLabel,
  hasPausedLabel,
  maxTasksOf,
  formatDependencyRef,
  namesRepository,
  parseDependencyRefs,
  type DependencyRef,
  type LeaseState,
  type PathPolicy,
  type StageKey,
  type TaskKind,
  type TaskState,
} from '@openadlc/shared';
import { blockersOf, type HealthAnswer } from './health/checks/crew.js';
import { readSeatPauses, seatPausedWords } from './seat-pause.js';
import { SEAT_WAIT_WINDOW_MS, STAGE_WAITING_ON_SEAT, standingSeatWaits } from './seat-waits.js';
import { isActive, issueForSubject, parseRef, subjectsOf, type IssueFacts, type TaskFacts } from './work.js';

/**
 * Why a card with nothing running on it is waiting, since when, and on what.
 *
 * A card the crew had not started said its stage's line and nothing else. On
 * 2026-10-23 OpenADLC#141 said "Waiting for a design pass" for over half an
 * hour, and #137 "Waiting on #141": the design seat had been busy with #137,
 * and the board said none of it. A person could not tell waiting from stuck,
 * and asked.
 *
 * Worked out from what is live — the tasks going now, the crew, the card's
 * own row and tasks, the leases held, the hosts' room, the pauses, the cap,
 * the checks, the next sweep — and
 * the one record of a wait the bridge keeps, a seat turning a start away
 * (`stage.waiting_on_seat`, #143), so the board's read stays the size of the
 * work in flight, not of its history (#94).
 */

/**
 * How long a card may wait with its seat free and nothing started before it
 * is marked stuck, and Needs you is told. Work a seat turned away starts
 * within about a minute of the seat having room (`StageRunner`), and the
 * dispatcher looks whenever something changes, so three minutes free with
 * nothing started is something wrong, not a wait.
 */
export const STUCK_AFTER_MS = 3 * 60_000;

/**
 * The role whose seat takes each stage's work, as the bridge starts it:
 * intake and design by `StageHandoff.staff` (its `STAFFING`), on the first
 * bot of the role, and a build by the dispatcher, on any builder with room.
 * Review and shipping are started by their own events and are not here.
 */
const SEAT_ROLE: Partial<Record<StageKey, string>> = { intake: 'intake', spec: 'spec', build: 'implement' };

/** A seat a card waits for. */
export interface WaitingSeat {
  /** The bot's name, as every address uses it. */
  name: string;
  role: string;
  /** How many tasks it runs at once (`bots.max_tasks`). */
  maxTasks: number;
}

/** A task taking a seat's slot, or its repository's build: what keeps the card behind it waiting. */
export interface SeatHolder {
  /** The subject it works on: `repo#12`, `request:<id8>`. */
  ref: string;
  /** The issue whose card it is on, as the board numbers it; null for a request or a subject the board has no issue for. */
  number: number | null;
  kind: TaskKind;
  state: TaskState;
  /** Paused on a question nobody has answered: a paused build still takes its repository's concurrency. */
  waitingOnYou: boolean;
}

/** An issue a card depends on, and what is happening on it now. */
export interface DependencyNow {
  /** As the card names it: `#N` in its own repository, `owner/name#N` in another. */
  ref: string;
  number: number;
  /** Its stage, or null when the board has no row for it. */
  stage: StageKey | null;
  /** Closed without merging: it will never ship. */
  abandoned: boolean;
  /** The task going on it now, the running one first; null when there is none. */
  task: { bot: string; kind: TaskKind; state: TaskState; waitingOnYou: boolean; activity: string | null } | null;
  /** What it waits on itself, when nothing is going on it; null when it does not wait for a seat or another issue. */
  waits: { kind: WaitingKind; seat: string | null } | null;
}

export type WaitingReason =
  /** A person held it (`openadlc:paused`). */
  | { kind: 'held' }
  /** Its Dependencies have not shipped. */
  | { kind: 'dependency'; on: DependencyNow[] }
  /** In Build and labelled `needs-triage`. */
  | { kind: 'triage' }
  /** In Build with no `start:now`. */
  | { kind: 'not_ready' }
  /** In Build and left for a person: `needs-human` or `do:human`. */
  | { kind: 'for_person' }
  /** Work is paused across the install or in its repository, in the pause's words. */
  | { kind: 'paused'; words: string }
  /** Its repository leaves this stage to a person (`untouched`). */
  | { kind: 'not_staffed' }
  /** No bot has the role that staffs the stage. */
  | { kind: 'no_seat'; role: string }
  /** The month's spend is at the cap that stops new work. */
  | { kind: 'cap'; words: string }
  /** Its seat was paused from Crew. */
  | { kind: 'seat_paused'; seat: WaitingSeat; words: string }
  /** A check holds its seat back: a sign-in, a repository it cannot work in, the host service. */
  | { kind: 'blocked'; seat: WaitingSeat; why: string; instruction: string }
  /** In Build on a bridge that runs no dispatcher: nothing leases it. */
  | { kind: 'no_dispatcher' }
  /** Every slot of its seat is taken; `holders` are the tasks running or queued on it. */
  | { kind: 'seat'; seat: WaitingSeat; seats: number; holders: SeatHolder[] }
  /** Its repository builds `limit` at a time, and that many are in flight, paused ones too. */
  | { kind: 'concurrency'; limit: number; holders: SeatHolder[] }
  /** Its seat has room, and the cards before it in the line take it. */
  | { kind: 'turn'; seat: WaitingSeat; after: string[] }
  /** Another change holds files it declared (`blockingOverlaps`). */
  | { kind: 'lease'; on: number[]; paths: string[] }
  /**
   * In Build, its own issue holds a lease with nothing running under it,
   * and the dispatcher never leases an issue a lease holds: `leased` before
   * its build has started, `paused` on a question after its task ended,
   * `in_task` for its pull request (`pr`), or once its build ended with none
   * linked yet. `merged` when that pull request has merged, and the lease
   * waits for the verification after it.
   */
  | { kind: 'leased'; bot: string; state: LeaseState; pr: number | null; merged: boolean }
  /**
   * Nothing else holds it: its seat has room, it is first in line, and the
   * live hosts run all the tasks they have room for (`hosts.taskLoad`), so a
   * start is refused until one ends (`HostFullError`).
   */
  | { kind: 'host'; running: number; capacity: number }
  /**
   * Its seat has room, it is first in line, and nothing has started it. One
   * its seat turned away while full starts within a minute of the seat
   * having room (`runner`, `StageRunner`); other intake and design the stage
   * sweep starts (at `nextAt`, null when no sweep is scheduled); a build the
   * dispatcher.
   */
  | { kind: 'free'; seat: WaitingSeat; by: 'runner' | 'sweep' | 'dispatcher'; nextAt?: string | null };

export type WaitingKind = WaitingReason['kind'];

export interface CardWaiting {
  reason: WaitingReason;
  /**
   * Since when it has waited: when its seat turned it away, while that
   * stands (`stage.waiting_on_seat`); else when its row last changed — its
   * stage, a label — or its last task ended, whichever is later. Both are
   * read already, where the stage moves would be one more read of history.
   */
  since: string;
  /** It has waited past `STUCK_AFTER_MS` with its seat free and nothing started. */
  stuck: boolean;
}

/**
 * A build paused on a question that takes one of its repository's builds at
 * once while cards wait for one: its card says so. A paused task takes no
 * slot of its seat (`tasks.seatHasRoom`, #148), but a paused build is still
 * the repository's work in flight, and a question nobody answered kept every
 * other build of a one-at-a-time repository waiting, said nowhere.
 */
export interface BuildHold {
  /** The repository whose builds at once it takes one of. */
  repo: string;
  /** Its builds at once (`repos.concurrency`). */
  limit: number;
  /** How many cards wait for one. */
  waiting: number;
}

/** A lease still holding an issue (`leases.heldLeases`). */
export interface LeaseFacts {
  repoId: string;
  issueNumber: number;
  botId: string;
  state: LeaseState;
  prNumber: number | null;
  /** The pull request it is linked to has merged. */
  pullMerged?: boolean;
  /** When it last changed state. */
  updatedAt?: string;
}

/** What the reasons are read from beyond the tasks and the cards; each part absent holds nothing back. */
export interface WaitingContext {
  /** Why new work may not start in a repository now (`DispatchGate.paused`), or null. */
  paused?: (repo: string) => string | null;
  /** Each paused seat's words, by bot name (`seatPausedWords`). */
  seatPaused?: ReadonlyMap<string, string>;
  /** The month's spend at the cap that stops new work, in words; null under it. */
  cap?: string | null;
  /** What the health checks last said, for a seat they hold back (`blockersOf`). */
  health?: readonly HealthAnswer[];
  /** When the stage sweep runs next (`JobTimer.nextRun`); null when it runs on no timer, absent when not known. */
  nextSweepAt?: string | null;
  /** False on a bridge that runs no dispatcher, so nothing leases a build. */
  dispatching?: boolean;
  /** Each repository's work in flight and path policy, by id, for a build whose files another change holds. Absent, none is read. */
  inFlight?: ReadonlyMap<string, { work: readonly WorkInFlight[]; policy: PathPolicy }>;
  /**
   * The starts a full seat turned away (`stage.waiting_on_seat`), in the
   * window they are kept for: which waits stand, and since when, is read
   * from them and the cards' tasks (`standingSeatWaits`). Absent, none.
   */
  seatWaitEvents?: readonly { at: string; payload: unknown }[];
  /** Every lease still holding an issue, for a Build card one holds with nothing running. Absent, none. */
  leases?: readonly LeaseFacts[];
  /**
   * How many tasks the live hosts hold a computer for, and have room for in
   * all (`hosts.taskLoad`): every seat's tasks go to them alike. Null while
   * no host is live, when a start finds hostd's own answer; absent, not read.
   */
  hosts?: { running: number; capacity: number } | null;
}

/** A card the reasons are worked out for. */
export interface WaitingCard {
  /** `repo#n`. */
  ref: string;
  issue: IssueFacts;
  /** Its live tasks: queued, running or paused, on the issue, its pull request or the request it came from. */
  active: readonly TaskFacts[];
  /** Every task read on it, ended ones too: when the last ended is when it began to wait. */
  tasks: readonly TaskFacts[];
}

export interface WaitingInput extends WaitingContext {
  now: Date;
  /** In the order the crew takes work: `issues.byNextFirst`. */
  cards: readonly WaitingCard[];
  /** Every task going in the install: queued, running or paused. */
  live: readonly TaskFacts[];
  bots: readonly { id: string; name: string; role?: string; maxTasks?: number | null }[];
  /** `fullName` (`owner/name`) finds a dependency written as `owner/name#N`; without it only `#N` is found. */
  repos: readonly { id: string; name: string; fullName?: string; stageModes: Partial<Record<string, string>>; concurrency?: number }[];
  /** The tasks waiting on a question nobody has answered, by id. */
  gated: ReadonlySet<string>;
  /** What a running task is doing, by id, for the line of a card that depends on it (`activityOf`). */
  activity?: (taskId: string) => string | null;
  /**
   * Every issue read, the cards' and the rest, for what a dependency or a
   * seat's task is on. Absent, the cards' issues alone.
   */
  issues?: readonly IssueFacts[];
}

export interface Waiting {
  /** By card ref; a card with work going on it, or in a stage nothing here staffs, is not in it. */
  cards: Map<string, CardWaiting>;
  /** By task id. */
  holds: Map<string, BuildHold>;
}

const STAFFED: readonly StageKey[] = ['intake', 'spec', 'build'];

/** A lease in one of these holds its issue (`leases.listActiveLeases`). */
const HELD_LEASE: readonly LeaseState[] = ['leased', 'in_task', 'paused'];

/**
 * Takes a slot on its seat: queued or running (`tasks.seatHasRoom`). One
 * paused on a person's answer takes none, kept computer or not (#148): a
 * design paused at 06:00 and answered at 13:38 held the seat all day.
 */
function holdsSlot(task: TaskFacts): boolean {
  return task.state === 'queued' || task.state === 'running';
}

/** The latest of these moments, or null when none is one. */
function latest(moments: readonly (string | null | undefined)[]): string | null {
  const known = moments.filter((moment): moment is string => typeof moment === 'string' && Number.isFinite(Date.parse(moment)));
  return known.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/** What a card waits on before its turn in a seat's line is asked, or `line` when nothing does. */
type Hold = WaitingReason | { kind: 'line'; seats: WaitingSeat[] };

/**
 * The order the dispatcher leases builds in: repository by repository, as
 * it walks them, and in each the one a person put next first, then the
 * line's own order. The builders are shared, so the first repository's
 * builds take the room before the next one's are asked.
 */
function buildOrder<T extends { card: WaitingCard }>(line: readonly T[], repos: readonly { name: string }[]): T[] {
  const rank = new Map(repos.map((repo, index) => [repo.name, index]));
  const at = (one: T) => rank.get(one.card.issue.repoName) ?? repos.length;
  const next = (one: T) => (hasNextLabel(one.card.issue.labels) ? 0 : 1);
  return line
    .map((one, index) => ({ one, index }))
    .sort((a, b) => at(a.one) - at(b.one) || next(a.one) - next(b.one) || a.index - b.index)
    .map(({ one }) => one);
}

export function waitingOf(input: WaitingInput): Waiting {
  const now = input.now.getTime();
  const repoByName = new Map(input.repos.map((repo) => [repo.name, repo]));
  const issues = input.issues ?? input.cards.map((card) => card.issue);
  const seat = (bot: WaitingInput['bots'][number]): WaitingSeat => ({ name: bot.name, role: bot.role ?? '', maxTasks: maxTasksOf(bot) });
  const slotsOf = (botId: string) => input.live.filter((task) => task.botId === botId && holdsSlot(task));
  const botByName = new Map(input.bots.map((bot) => [bot.name, bot]));
  const roomOf = (one: WaitingSeat) => {
    const bot = botByName.get(one.name);
    return bot ? Math.max(0, one.maxTasks - slotsOf(bot.id).length) : 0;
  };
  const holderOf = (task: TaskFacts): SeatHolder => ({
    ref: task.subjectRef,
    // A subject on no card shown is said by its own number.
    number: issueForSubject(task.subjectRef, issues)?.number ?? parseRef(task.subjectRef)?.number ?? null,
    kind: task.kind,
    state: task.state,
    waitingOnYou: task.state === 'paused' && input.gated.has(task.id),
  });
  const holdersOf = (seats: readonly WaitingSeat[]): TaskFacts[] =>
    seats.flatMap((one) => {
      const bot = botByName.get(one.name);
      return bot ? slotsOf(bot.id) : [];
    });
  // The lease holding each issue, by its card's ref.
  const repoNameById = new Map(input.repos.map((repo) => [repo.id, repo.name]));
  const leaseOf = new Map<string, LeaseFacts>(
    (input.leases ?? [])
      .filter((lease) => HELD_LEASE.includes(lease.state) && repoNameById.has(lease.repoId))
      .map((lease) => [`${repoNameById.get(lease.repoId)}#${lease.issueNumber}`, lease] as const),
  );
  // The intake and design seats are the first bot of the role, as staffing
  // picks one; a build goes to any builder with room.
  const seatsFor = (stage: StageKey): WaitingSeat[] => {
    const role = SEAT_ROLE[stage];
    const all = input.bots.filter((bot) => bot.role === role).map(seat);
    return stage === 'build' ? all : all.slice(0, 1);
  };

  const holdOf = (card: WaitingCard): Hold | null => {
    const { issue } = card;
    if (!STAFFED.includes(issue.stage) || card.active.length > 0) return null;
    // A question open on it, even one its task ended beside, waits on a
    // person, which its card and Needs you already say.
    if (card.tasks.some((task) => input.gated.has(task.id))) return null;
    if (hasPausedLabel(issue.labels)) return { kind: 'held' };
    // Its own lease, with nothing running under it: the dispatcher passes an
    // issue a lease holds before anything else, so no builder having room
    // starts it. Read as free, it turned stuck after three minutes, and Start
    // it now asked the dispatcher for what it would never do (#153).
    const lease = issue.stage === 'build' ? leaseOf.get(card.ref) : undefined;
    if (lease) {
      return {
        kind: 'leased',
        bot: input.bots.find((bot) => bot.id === lease.botId)?.name ?? 'a bot',
        state: lease.state,
        pr: lease.prNumber,
        merged: lease.prNumber !== null && lease.pullMerged === true,
      };
    }
    if (issue.stage === 'build') {
      // By the label the dispatcher keeps, not by the Dependencies alone: a
      // dependency that shipped before the week the board reads is not
      // among its issues, and read from them it waited for good.
      if (issue.labels.includes('blocked')) return { kind: 'dependency', on: [] };
      if (issue.labels.includes('needs-triage')) return { kind: 'triage' };
      if (!issue.labels.includes('start:now')) return { kind: 'not_ready' };
      if (issue.labels.includes('needs-human') || issue.labels.includes('do:human')) return { kind: 'for_person' };
    }
    const paused = input.paused?.(issue.repoName);
    if (paused) return { kind: 'paused', words: paused };
    if (issue.stage !== 'build' && repoByName.get(issue.repoName)?.stageModes[issue.stage] === 'untouched') return { kind: 'not_staffed' };
    const seats = seatsFor(issue.stage);
    if (seats.length === 0) return { kind: 'no_seat', role: SEAT_ROLE[issue.stage]! };
    if (input.cap) return { kind: 'cap', words: input.cap };
    const working = seats.filter((one) => !input.seatPaused?.has(one.name));
    if (working.length === 0) return { kind: 'seat_paused', seat: seats[0]!, words: input.seatPaused?.get(seats[0]!.name) ?? `${seats[0]!.name} is paused` };
    const blockers = (one: WaitingSeat) => {
      const bot = botByName.get(one.name);
      return bot ? blockersOf(input.health ?? [], bot, issue.repoName) : [];
    };
    const able = working.filter((one) => blockers(one).length === 0);
    if (able.length === 0) {
      const first = blockers(working[0]!)[0]!;
      return { kind: 'blocked', seat: working[0]!, why: first.why, instruction: first.instruction };
    }
    if (issue.stage === 'build' && input.dispatching === false) return { kind: 'no_dispatcher' };
    return { kind: 'line', seats: able };
  };

  // The starts a full seat turned away that nothing has started since.
  const seatWaits = input.seatWaitEvents?.length ? standingSeatWaits(input.seatWaitEvents, issues, input.cards.flatMap((card) => card.tasks)) : new Map<string, { since: string }>();

  const reasons = new Map<string, WaitingReason>();
  const lines = new Map<string, { card: WaitingCard; seats: WaitingSeat[] }[]>();
  for (const card of input.cards) {
    const hold = holdOf(card);
    if (!hold) continue;
    if (hold.kind !== 'line') {
      reasons.set(card.ref, hold);
      continue;
    }
    // One line per seat: intake's and design's across every repository, as
    // the sweep walks them; every builder's together, as they share the work.
    const key = card.issue.stage;
    lines.set(key, [...(lines.get(key) ?? []), { card, seats: hold.seats }]);
  }

  // The hosts' room left, shared by every seat's line: a host runs whoever's
  // task it is given. Full, a card with nothing else in its way read as
  // free, then stuck, and no Start it now could start it (#153).
  let hostRoom = input.hosts ? input.hosts.capacity - input.hosts.running : Number.POSITIVE_INFINITY;
  for (const [stage, line] of lines) {
    const seats = line[0]!.seats;
    let room = seats.reduce((sum, one) => sum + roomOf(one), 0);
    const taken: string[] = [];
    const repoRoom = new Map<string, number>();
    const repoTaken = new Map<string, string[]>();
    for (const { card } of stage === 'build' ? buildOrder(line, input.repos) : line) {
      const repo = repoByName.get(card.issue.repoName);
      if (room <= 0) {
        reasons.set(
          card.ref,
          taken.length > 0
            ? { kind: 'turn', seat: seats[0]!, after: [...taken] }
            : { kind: 'seat', seat: seats[0]!, seats: seats.length, holders: holdersOf(seats).map(holderOf) },
        );
        continue;
      }
      // Builds in flight in its repository, paused ones too, against its
      // concurrency, as the dispatcher counts them.
      const limit = stage === 'build' ? repo?.concurrency : undefined;
      if (repo && limit !== undefined) {
        const building = input.live.filter((task) => task.kind === 'implement' && task.repoId === repo.id && isActive(task));
        if (!repoRoom.has(repo.id)) repoRoom.set(repo.id, Math.max(0, limit - building.length));
        if (repoRoom.get(repo.id)! <= 0) {
          const before = repoTaken.get(repo.id) ?? [];
          reasons.set(card.ref, before.length > 0 ? { kind: 'turn', seat: seats[0]!, after: [...before] } : { kind: 'concurrency', limit, holders: building.map(holderOf) });
          continue;
        }
      }
      // Another change holding its files keeps it back without taking the
      // builder: the dispatcher hands the slot to the next card.
      const flight = stage === 'build' && repo ? input.inFlight?.get(repo.id) : undefined;
      const declared = card.issue.declaredPaths ?? [];
      if (flight && declared.length > 0) {
        const collisions = blockingOverlaps(
          declared,
          flight.work.filter((work) => work.number !== card.issue.number),
          flight.policy,
        );
        if (collisions.length > 0) {
          reasons.set(card.ref, {
            kind: 'lease',
            on: collisions.map((collision) => collision.number),
            paths: [...new Set(collisions.flatMap((collision) => collision.pairs.map((pair) => pair.theirs)))],
          });
          continue;
        }
      }
      room -= 1;
      taken.push(card.ref);
      if (repo && limit !== undefined) {
        repoRoom.set(repo.id, repoRoom.get(repo.id)! - 1);
        repoTaken.set(repo.id, [...(repoTaken.get(repo.id) ?? []), card.ref]);
      }
      // Next in its seat's line, and no host to run it on: the cards behind
      // it wait their turn after it.
      if (hostRoom <= 0 && input.hosts) {
        reasons.set(card.ref, { kind: 'host', running: input.hosts.running, capacity: input.hosts.capacity });
        continue;
      }
      hostRoom -= 1;
      const by = stage === 'build' ? 'dispatcher' : seatWaits.has(card.ref) ? 'runner' : 'sweep';
      reasons.set(card.ref, {
        kind: 'free',
        seat: seats[0]!,
        by,
        ...(by === 'sweep' && input.nextSweepAt !== undefined ? { nextAt: input.nextSweepAt } : {}),
      });
    }
  }

  // What each issue a card depends on is doing now: its task, or its own wait.
  const byRef = new Map(input.cards.map((card) => [card.ref, card]));
  const botName = (id: string) => input.bots.find((bot) => bot.id === id)?.name ?? 'a bot';
  const seatOfReason = (reason: WaitingReason | undefined): string | null =>
    reason && 'seat' in reason ? reason.seat.name : null;
  // A dependency in another repository the install manages is found there by
  // its full name and named as written. Read as a number it was this
  // repository's #N: once that one shipped, the card said "Blocked by another
  // issue" while it still waited on the other repository's.
  const resolveRef = (card: WaitingCard, ref: DependencyRef) => {
    const repo =
      ref.repo === null
        ? { id: card.issue.repoId, name: card.issue.repoName }
        : input.repos.find((one) => one.fullName !== undefined && namesRepository(ref, one.fullName));
    const issue = repo ? (issues.find((one) => one.repoId === repo.id && one.number === ref.number) ?? null) : null;
    const shown = repo?.id === card.issue.repoId ? `#${ref.number}` : formatDependencyRef(ref);
    return { repoName: repo?.name ?? null, number: ref.number, issue, shown };
  };
  const dependencyNow = ({ repoName, number, issue, shown }: ReturnType<typeof resolveRef>): DependencyNow => {
    // One in a repository the install does not manage has nothing going on it that the board sees.
    const ref = repoName === null ? null : `${repoName}#${number}`;
    const subjects = new Set(issue ? subjectsOf(issue) : ref ? [ref] : []);
    const going = ((ref ? byRef.get(ref)?.active : undefined) ?? input.live.filter((task) => subjects.has(task.subjectRef) && isActive(task))).filter(isActive);
    const leading = going.find((task) => task.state === 'running') ?? going[0];
    const own = ref ? reasons.get(ref) : undefined;
    return {
      ref: shown,
      number,
      stage: issue?.stage ?? null,
      abandoned: hasAbandonedLabel(issue?.labels),
      task: leading
        ? {
            bot: botName(leading.botId),
            kind: leading.kind,
            state: leading.state,
            waitingOnYou: leading.state === 'paused' && input.gated.has(leading.id),
            activity: leading.state === 'running' ? (input.activity?.(leading.id) ?? null) : null,
          }
        : null,
      waits: !leading && own ? { kind: own.kind, seat: seatOfReason(own) } : null,
    };
  };
  for (const card of input.cards) {
    const reason = reasons.get(card.ref);
    if (reason?.kind !== 'dependency') continue;
    // One not read is named too: with the label still on, the dispatcher
    // has not found it shipped.
    const unshipped = parseDependencyRefs(card.issue.body ?? null)
      .map((ref) => resolveRef(card, ref))
      .filter((found) => !found.issue || !dependencyIsSatisfied(found.issue));
    reasons.set(card.ref, { kind: 'dependency', on: unshipped.map(dependencyNow) });
  }

  // When a seat last finished something, among the tasks read: a seat that
  // freed a minute ago has not left a card waiting with nothing started.
  const lastEnd = new Map<string, string>();
  for (const task of input.cards.flatMap((card) => card.tasks)) {
    if (isActive(task) || !task.endedAt) continue;
    const was = lastEnd.get(task.botId);
    if (!was || Date.parse(task.endedAt) > Date.parse(was)) lastEnd.set(task.botId, task.endedAt);
  }

  const cards = new Map<string, CardWaiting>();
  const waitingOn = new Map<string, { limit: number; count: number }>();
  for (const card of input.cards) {
    const reason = reasons.get(card.ref);
    if (!reason) continue;
    // Turned away by its seat, it has waited since then; else since it last
    // changed, or its lease did.
    const changed = latest([card.issue.updatedAt, ...card.tasks.filter((task) => !isActive(task)).map((task) => task.endedAt ?? task.createdAt)]) ?? card.issue.updatedAt;
    const since = seatWaits.get(card.ref)?.since ?? (reason.kind === 'leased' ? (latest([changed, leaseOf.get(card.ref)?.updatedAt]) ?? changed) : changed);
    let stuck = false;
    if (reason.kind === 'free') {
      const bot = botByName.get(reason.seat.name);
      const freeSince = latest([since, bot ? lastEnd.get(bot.id) : null]) ?? since;
      stuck = now - Date.parse(freeSince) > STUCK_AFTER_MS;
    }
    if (reason.kind === 'concurrency') {
      const repo = card.issue.repoName;
      const was = waitingOn.get(repo) ?? { limit: reason.limit, count: 0 };
      waitingOn.set(repo, { ...was, count: was.count + 1 });
    }
    cards.set(card.ref, { reason, since, stuck });
  }

  // A build paused on a question that takes one of its repository's builds
  // while others wait for one says so on its own card.
  const holds = new Map<string, BuildHold>();
  for (const [repoName, { limit, count }] of waitingOn) {
    const repo = repoByName.get(repoName);
    for (const task of input.live) {
      if (repo && task.kind === 'implement' && task.repoId === repo.id && task.state === 'paused') holds.set(task.id, { repo: repoName, limit, waiting: count });
    }
  }
  return { cards, holds };
}

/** The cards `waitingOf` reads, from issues and the tasks read on them. */
export function waitingCards(issues: readonly IssueFacts[], tasks: readonly TaskFacts[], extraSubjects?: (issue: IssueFacts) => readonly string[]): WaitingCard[] {
  const bySubject = new Map<string, TaskFacts[]>();
  for (const task of tasks) bySubject.set(task.subjectRef, [...(bySubject.get(task.subjectRef) ?? []), task]);
  return issues.map((issue) => {
    const subjects = new Set([...subjectsOf(issue), ...(extraSubjects?.(issue) ?? [])]);
    const mine = [...subjects].flatMap((subject) => bySubject.get(subject) ?? []);
    return { ref: `${issue.repoName}#${issue.number}`, issue, active: mine.filter(isActive), tasks: mine };
  });
}

/** What reads the parts of `WaitingContext` that are in the database, and what only the bridge's process knows. */
export interface WaitingReads {
  /** Why new work may not start in a repository (`DispatchGate.paused`). */
  paused?: (repo: string) => string | null;
  /** When the stage sweep runs next. */
  nextSweepAt?: () => Date | null;
  dispatching?: boolean;
  /** Whether a reached global cap stops new work (`config/costs.yaml` `onCap.stopLeasing`). */
  stopLeasing?: boolean;
  /** What the health checks last said. */
  health?: () => Promise<readonly HealthRow[]>;
  /** A repository's path policy (`.github/openadlc.yml` `paths:`), for a build another change's files hold back. */
  pathPolicy?: (repo: { id: string; name: string; fullName: string; defaultBranch: string }) => Promise<PathPolicy>;
}

/**
 * The context for `waitingOf`, read: the seats paused from Crew, the month's
 * budget, the checks, the leases held and the hosts' load, and — only for a
 * repository with a build that could start — its work in flight and path
 * policy. A part that cannot be read
 * holds nothing back, as a check that cannot be read does not.
 */
export async function readWaitingContext(
  reads: WaitingReads,
  candidates: { buildRepos: readonly { id: string; name: string; fullName: string; defaultBranch: string }[] },
): Promise<WaitingContext> {
  type Flight = { work: readonly WorkInFlight[]; policy: PathPolicy };
  const flightOf = async (repo: (typeof candidates.buildRepos)[number]): Promise<[string, Flight] | null> => {
    const [work, policy] = await Promise.all([
      issueStore.workInFlight(repo.id),
      reads.pathPolicy ? reads.pathPolicy(repo).catch(() => DEFAULT_PATH_POLICY) : Promise.resolve(DEFAULT_PATH_POLICY),
    ]);
    return [repo.id, { work, policy }];
  };
  const [seatPauses, budget, health, inFlight, seatWaitEvents, held, load] = await Promise.all([
    readSeatPauses(),
    // The cap the dispatcher stops leasing at, and every start too
    // (`spendingLimits.refusal`), as the budget job last wrote it.
    reads.stopLeasing === false ? Promise.resolve(null) : (async () => costs.getBudget(costs.currentPeriod()))().catch(() => null),
    reads.health ? (async () => reads.health!())().catch((): readonly HealthRow[] => []) : Promise.resolve([] as readonly HealthRow[]),
    Promise.all(candidates.buildRepos.map((repo) => flightOf(repo).catch(() => null))),
    (async () => listEventsOfType(STAGE_WAITING_ON_SEAT, new Date(Date.now() - SEAT_WAIT_WINDOW_MS)))().catch(() => []),
    // The leases held now and the hosts' load: each the size of the work in flight, no history.
    (async () => leaseStore.heldLeases())().catch(() => undefined),
    (async () => hostStore.taskLoad())().catch(() => undefined),
  ]);
  const next = reads.nextSweepAt?.();
  return {
    ...(reads.paused ? { paused: reads.paused } : {}),
    seatPaused: new Map(Object.entries(seatPauses).map(([name, pause]) => [name, seatPausedWords(name, pause)])),
    cap: budget?.state === 'stopped' ? `this month's spend is $${budget.spentUsd.toFixed(2)} of the $${budget.capUsd.toFixed(2)} monthly cap` : null,
    health,
    ...(reads.nextSweepAt ? { nextSweepAt: next ? next.toISOString() : null } : {}),
    ...(reads.dispatching !== undefined ? { dispatching: reads.dispatching } : {}),
    inFlight: new Map(inFlight.filter((entry): entry is [string, Flight] => entry !== null)),
    seatWaitEvents,
    ...(held ? { leases: held } : {}),
    ...(load !== undefined ? { hosts: load ? { running: load.used, capacity: load.capacity } : null } : {}),
  };
}

/** The repositories with a Build card that nothing holds before its seat's line: the only ones whose work in flight is read. */
export function buildCandidates(cards: readonly WaitingCard[]): Set<string> {
  return new Set(
    cards
      .filter(
        (card) =>
          card.issue.stage === 'build' &&
          card.active.length === 0 &&
          (card.issue.declaredPaths ?? []).length > 0 &&
          card.issue.labels.includes('start:now') &&
          !card.issue.labels.includes('blocked') &&
          !hasPausedLabel(card.issue.labels),
      )
      .map((card) => card.issue.repoName),
  );
}
