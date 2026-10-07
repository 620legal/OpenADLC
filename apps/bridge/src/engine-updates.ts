import { audit, settings, type SettingKey } from '@fleetadlc/db';
import {
  ENGINE_PACKAGES,
  isMinReleaseAgeDays,
  minReleaseAgeDaysFrom,
  SYSTEM_TOOLS,
  systemToolById,
  type EngineUpdateResult,
  type EngineUpdateStart,
  type EngineUpdateStatus,
  type EngineVersions,
  type SystemToolId,
} from '@fleetadlc/shared';
import { HttpFailure, type Router } from './router.js';
import { isIanaTimeZone, processTimeZone, timeZoneFrom } from './system-settings.js';

/**
 * When the engine CLIs are updated, and what is remembered about it.
 *
 * hostd does the update (`apps/hostd/src/engine-updates.ts`): it owns Docker
 * and the bot image. The bridge owns the clock and the record. Once a week —
 * Sunday at 18:00 in the install's own timezone unless a person chooses
 * otherwise — it asks hostd to run, follows the run to its end, and writes
 * the outcome where people look: `engines.updated` and
 * `engines.update_failed` in the audit log, and the last result here, where
 * the console and its attention list read it. A run that found nothing newer
 * is remembered as the last check and written nowhere else.
 *
 * The clock is a job that looks every few minutes, not a timer set for
 * Sunday: a laptop asleep at 18:00 runs the update when it wakes, once. What
 * makes it once is the week remembered — the slot a run was started for —
 * which is stored before the run is followed, so a bridge that restarts
 * mid-run does not start another.
 */

export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Day = (typeof DAYS)[number];

export interface Schedule {
  enabled: boolean;
  day: Day;
  /** 24-hour `HH:MM`, in the install's timezone. */
  time: string;
}

export const DEFAULT_SCHEDULE: Schedule = { enabled: true, day: 'sunday', time: '18:00' };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * What a pin must look like: the version the tool is on, as the image's label
 * and hostd's `heldVersions` write it. Anything else was stored and then
 * dropped by hostd, so the pin never held and the page said it did.
 */
const PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Where each part lives in the install's settings. */
const KEY = {
  enabled: 'engineUpdates',
  day: 'engineUpdateDay',
  time: 'engineUpdateTime',
  slot: 'engineUpdateSlot',
  last: 'engineUpdateLast',
  hold: 'engineUpdateHold',
} as const satisfies Record<string, SettingKey>;

/** The process zone, when the install has not stored one. */
export function localTimeZone(): string {
  return processTimeZone();
}

// ------------------------------------------------------------------ the week

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formats = new Map<string, Intl.DateTimeFormat>();

/** What a clock on the wall in `timeZone` reads at `at`. */
function wallClock(at: number, timeZone: string): Wall {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`. */
function offsetAt(at: number, timeZone: string): number {
  const second = Math.floor(at / 1000) * 1000;
  const wall = wallClock(second, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - second;
}

/**
 * The instant a wall clock in `timeZone` reads this date and time. Asked
 * twice, because the offset at the guess can differ from the offset at the
 * answer on the day a clock changes.
 */
function instantOf(date: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const guess = naive - offsetAt(naive, timeZone);
  return naive - offsetAt(guess, timeZone);
}

/** The calendar date `days` after `wall`'s. */
function shifted(wall: Pick<Wall, 'year' | 'month' | 'day'>, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function hourMinute(time: string): [number, number] {
  const [hour = '18', minute = '0'] = time.split(':');
  return [Number(hour), Number(minute)];
}

/** This week's slot: the most recent scheduled day and time at or before `now`. */
export function lastSlotAtOrBefore(now: Date, schedule: Pick<Schedule, 'day' | 'time'>, timeZone: string): Date {
  const wall = wallClock(now.getTime(), timeZone);
  const [hour, minute] = hourMinute(schedule.time);
  const back = (wall.weekday - DAYS.indexOf(schedule.day) + 7) % 7;
  const slot = instantOf(shifted(wall, -back), hour, minute, timeZone);
  return new Date(slot <= now.getTime() ? slot : instantOf(shifted(wall, -back - 7), hour, minute, timeZone));
}

/** The first scheduled day and time after `now`. */
export function nextSlotAfter(now: Date, schedule: Pick<Schedule, 'day' | 'time'>, timeZone: string): Date {
  const last = lastSlotAtOrBefore(now, schedule, timeZone);
  const [hour, minute] = hourMinute(schedule.time);
  return new Date(instantOf(shifted(wallClock(last.getTime(), timeZone), 7), hour, minute, timeZone));
}

/**
 * Whether this week's run is owed: the schedule is on, and its most recent
 * slot is later than the last one a run was started for. Nothing is owed
 * before the first slot is remembered — an install does not update its
 * engines the day it is set up, for a Sunday that passed before it existed.
 */
export function isDue(now: Date, schedule: Schedule, handled: Date | null, timeZone: string): boolean {
  if (!schedule.enabled || !handled) return false;
  return lastSlotAtOrBefore(now, schedule, timeZone).getTime() > handled.getTime();
}

/** The schedule as stored, with anything unreadable left at its default. */
export function scheduleFrom(stored: Partial<Record<SettingKey, string>>): Schedule {
  const day = (stored[KEY.day] ?? '').trim().toLowerCase();
  const time = (stored[KEY.time] ?? '').trim();
  return {
    enabled: stored[KEY.enabled] !== 'off',
    day: (DAYS as readonly string[]).includes(day) ? (day as Day) : DEFAULT_SCHEDULE.day,
    time: TIME.test(time) ? time : DEFAULT_SCHEDULE.time,
  };
}

/** "every Sunday at 18:00". */
export function describeSchedule(schedule: Schedule): string {
  if (!schedule.enabled) return 'off';
  return `every ${schedule.day[0]?.toUpperCase()}${schedule.day.slice(1)} at ${schedule.time}`;
}

export interface ToolSchedule {
  mode: 'schedule' | 'manual';
  day: Day;
  time: string;
  /** The slot a run was claimed for. Null until the first look, which does not run. */
  slot: string | null;
  /** The installed version a pin holds. Null follows the schedule. A pin is not a downgrade. */
  pin: string | null;
}

export type ToolSchedules = Record<SystemToolId, ToolSchedule>;

const TOOL_IDS = SYSTEM_TOOLS.map((tool) => tool.id);

export interface ToolCheck {
  state: EngineUpdateResult['state'];
  finishedAt: string;
  reason: string;
  from: string | null;
  to: string | null;
  latest: string | null;
  trigger: string;
}

function parseRecord(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isToolSchedule(value: unknown): value is ToolSchedule {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ToolSchedule>;
  return (
    (row.mode === 'schedule' || row.mode === 'manual') &&
    typeof row.day === 'string' &&
    (DAYS as readonly string[]).includes(row.day) &&
    typeof row.time === 'string' &&
    TIME.test(row.time) &&
    (row.slot === null || typeof row.slot === 'string') &&
    (row.pin === null || typeof row.pin === 'string')
  );
}

/**
 * Per-tool schedules. When none are stored, `engineUpdates`, `engineUpdateDay`
 * and `engineUpdateTime` — or their defaults — become every tool's, including
 * the slot already claimed. `migrated` means that has to be written and the
 * old keys dropped, so the next edit of one tool is not put back by the old Sunday.
 */
export function toolSchedulesFrom(stored: Partial<Record<SettingKey, string>>): { schedules: ToolSchedules; migrated: boolean } {
  const parsed = parseRecord(stored.systemToolSchedules);
  if (parsed) {
    const schedules = {} as ToolSchedules;
    const complete = TOOL_IDS.every((id) => {
      const row = parsed[id];
      if (!isToolSchedule(row)) return false;
      schedules[id] = row;
      return true;
    });
    if (complete) return { schedules, migrated: false };
  }
  const legacy = scheduleFrom(stored);
  const slotAt = stored.engineUpdateSlot ? new Date(stored.engineUpdateSlot) : null;
  const slot = slotAt && !Number.isNaN(slotAt.getTime()) ? slotAt.toISOString() : null;
  const schedules = {} as ToolSchedules;
  for (const id of TOOL_IDS) {
    schedules[id] = {
      mode: legacy.enabled ? 'schedule' : 'manual',
      day: legacy.day,
      time: legacy.time,
      slot,
      pin: null,
    };
  }
  return { schedules, migrated: true };
}

/** The one schedule every tool is on, or null once any tool's mode, day or time differs. */
export function sharedSchedule(schedules: ToolSchedules): Schedule | null {
  const rows = TOOL_IDS.map((id) => schedules[id]);
  const first = rows[0] ?? { mode: 'schedule' as const, day: DEFAULT_SCHEDULE.day, time: DEFAULT_SCHEDULE.time };
  const same = rows.every((row) => row.mode === first.mode && row.day === first.day && row.time === first.time);
  return same ? { enabled: first.mode === 'schedule', day: first.day, time: first.time } : null;
}

/** The one schedule a page can say in a sentence, when the tools still share it. */
export function summarySchedule(schedules: ToolSchedules): Schedule {
  const shared = sharedSchedule(schedules);
  if (shared) return shared;
  const rows = TOOL_IDS.map((id) => schedules[id]);
  const first = rows[0] ?? { mode: 'schedule' as const, day: DEFAULT_SCHEDULE.day, time: DEFAULT_SCHEDULE.time };
  const scheduled = rows.find((row) => row.mode === 'schedule');
  if (!scheduled) return { enabled: false, day: first.day, time: first.time };
  return { enabled: true, day: scheduled.day, time: scheduled.time };
}

function toolKey(id: SystemToolId): string {
  return SYSTEM_TOOLS.find((tool) => tool.id === id)?.key ?? id;
}

/**
 * The tools a result is about, when nothing recorded which: a run asks a
 * registry only for the tools it may move (and the pins it reports), so the
 * keys of `latest` name them. A run that stopped before it asked names none,
 * and is written against none — it said nothing about any one tool, and
 * marking every tool failed made each row claim a failure it did not have.
 * The run's own result still says what happened.
 */
function toolsOfResult(result: EngineUpdateResult): SystemToolId[] {
  const asked = result.latest ? Object.keys(result.latest) : [];
  return TOOL_IDS.filter((id) => asked.includes(toolKey(id)));
}

/** The ids of some package keys; absent keys are the three engine CLIs, which is what hostd runs then. */
function toolsOfKeys(keys: readonly string[] | undefined): SystemToolId[] {
  if (!keys) return TOOL_IDS.filter((id) => Object.hasOwn(ENGINE_PACKAGES, id));
  return TOOL_IDS.filter((id) => keys.includes(toolKey(id)));
}

/** What `systemToolRun` holds while a run the bridge started is going. */
interface ToolRun {
  startedAt: string;
  tools: readonly SystemToolId[];
}

/** The refusal a person gets for Update now while another run is going. */
function alreadyRunning(startedAt: string | null): HttpFailure {
  return new HttpFailure(
    409,
    `an update is already running${startedAt ? ` (started ${startedAt})` : ''}; press Update now again once it has finished`,
  );
}

/** The ids a body names, or null when it names tools that are not updatable. Undefined when it names none. */
function toolIdsFrom(value: unknown): SystemToolId[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const ids: SystemToolId[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const tool = systemToolById(item);
    if (!tool) return null;
    if (!ids.includes(tool.id)) ids.push(tool.id);
  }
  return ids;
}

// ------------------------------------------------------------------ attention

/** A failed update, as the console's attention list shows it: something a person must see. */
export interface EngineUpdateAttention {
  kind: 'engine-update-failed';
  title: string;
  detail: string;
  at: string;
  href: string;
}

/**
 * The attention item for the last result, or null when it needs nobody.
 * Only a failure does: the bots are still on the image they had, and the
 * reason is usually a credential or a model a person has to look at. It
 * stays until a later run ends otherwise.
 */
export function engineUpdateAttention(last: EngineUpdateResult | null): EngineUpdateAttention | null {
  if (!last || last.state !== 'failed') return null;
  return {
    kind: 'engine-update-failed',
    title: 'The engine update did not go in — the bots are still on the engines they had',
    detail: last.reason,
    at: last.finishedAt,
    href: '/settings#engine-updates',
  };
}

// ------------------------------------------------------------------ the record

export interface SystemToolView {
  id: SystemToolId;
  key: string;
  name: string;
  purpose: string;
  source: (typeof SYSTEM_TOOLS)[number]['source'];
  inUse: string | null;
  latest: string | null;
  /** The version a pin holds, or null when the tool follows its schedule. */
  pin: string | null;
  schedule: { mode: 'schedule' | 'manual'; day: Day; time: string };
  nextRun: string | null;
  due: boolean;
  last: ToolCheck | null;
}

export interface EngineUpdatesView {
  /** The clock every schedule reads. */
  timeZone: string;
  tools: SystemToolView[];
  /**
   * The schedule the tools share, when they do. A page that still reads one
   * sentence gets it; the rows are `tools`.
   */
  schedule: Schedule & { timeZone: string; description: string };
  /** The first scheduled run after now; null while every tool is manual. */
  nextRun: string | null;
  /** This week's run is owed and starts within minutes: its slot passed while nothing ran. */
  due: boolean;
  hostd: { reachable: boolean; detail: string };
  /** Whether hostd can update the image here; null when hostd did not answer. */
  applicable: boolean | null;
  reason: string;
  image: string | null;
  inUse: EngineVersions | null;
  inUseSource: string | null;
  /** What a rollback would go back to; null when there is nothing to go back to. */
  previous: EngineVersions | null;
  /** What npm called newest when a run last asked. */
  latest: EngineVersions | null;
  running: { startedAt: string; trigger: string } | null;
  last: EngineUpdateResult | null;
  /** A version a rollback undid, which no run takes again. */
  hold: EngineVersions;
  /** Whole days an engine CLI release must have been on npm before a run takes it; see `DEFAULT_MIN_RELEASE_AGE_DAYS`. */
  minReleaseAgeDays: number;
  attention: EngineUpdateAttention | null;
}

/** What the bridge asks of hostd. `HostdClient` is one. */
export interface EngineUpdatesHostd {
  engineUpdateStatus(): Promise<EngineUpdateStatus>;
  startEngineUpdate(
    input: { trigger: string; hold: EngineVersions; only?: readonly string[]; pins?: EngineVersions; minReleaseAgeDays?: number },
    identity?: string,
  ): Promise<EngineUpdateStart>;
  rollbackEngines(identity: string): Promise<EngineUpdateResult>;
}

export interface EngineUpdateStore {
  all(): Promise<Partial<Record<SettingKey, string>>>;
  set(key: SettingKey, value: string, by: string): Promise<void>;
}

export interface EngineUpdatesOptions {
  hostd: EngineUpdatesHostd;
  store?: EngineUpdateStore;
  audit?: (entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }) => Promise<void>;
  now?: () => Date;
  timeZone?: string;
  /** How often a running update is looked at. */
  pollMs?: number;
  /** How long hostd may not answer mid-run before the run counts as lost. */
  silentMs?: number;
  /** How long a run may take at all before the bridge stops waiting for it. */
  maxMs?: number;
  log?: (line: string) => void;
}

interface Stored {
  schedules: ToolSchedules;
  last: EngineUpdateResult | null;
  toolLast: Partial<Record<SystemToolId, ToolCheck>>;
  hold: EngineVersions;
  timeZone: string | null;
  /** The run in flight, as `systemToolRun` holds it. */
  run: string | undefined;
  minReleaseAgeDays: number;
}

function storedFrom(all: Partial<Record<SettingKey, string>>): Stored {
  const { schedules } = toolSchedulesFrom(all);
  return {
    schedules,
    last: parse<EngineUpdateResult>(all[KEY.last]),
    toolLast: parse<Partial<Record<SystemToolId, ToolCheck>>>(all.systemToolLast) ?? {},
    hold: parse<EngineVersions>(all[KEY.hold]) ?? {},
    timeZone: all.systemTimeZone ?? null,
    run: all.systemToolRun,
    minReleaseAgeDays: minReleaseAgeDaysFrom(all.engineUpdateMinReleaseAgeDays),
  };
}

interface Started {
  startedAt: string | null;
  joined: boolean;
  done: Promise<EngineUpdateResult>;
}

function parse<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** A result small enough to keep as a setting, with nothing in it but words and versions. */
function kept(result: EngineUpdateResult): EngineUpdateResult {
  return {
    ...result,
    reason: clip(result.reason, 2000),
    checks: result.checks.slice(0, 40).map((check) => ({ ...check, detail: clip(check.detail, 600) })),
  };
}

/** The versions a rollback left behind: each package whose version it changed. */
function undone(result: EngineUpdateResult): EngineVersions {
  const hold: EngineVersions = {};
  for (const [pkg, version] of Object.entries(result.from)) {
    if (version && version !== (result.to?.[pkg] ?? null)) hold[pkg] = version;
  }
  return hold;
}

const settingsStore: EngineUpdateStore = {
  all: () => settings.allSettings(),
  set: (key, value, by) => settings.setSetting(key, value, by),
};

interface StartInput {
  trigger: 'console' | 'schedule';
  actor: string;
  /** Package keys this run may move. Absent: hostd's default, the three engines. */
  only?: readonly string[];
  /** Installed versions a schedule must not replace. An explicit update omits these. */
  pins?: EngineVersions;
  /** Slots to claim once hostd has taken the run. */
  claims?: { id: SystemToolId; slot: Date }[];
  /** The tools this run is for, so its result is written against them and no other. */
  tools?: readonly SystemToolId[];
}

export class EngineUpdates {
  private readonly hostd: EngineUpdatesHostd;
  private readonly store: EngineUpdateStore;
  private readonly audit: NonNullable<EngineUpdatesOptions['audit']>;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  /** The run this bridge started or joined and is following, from asking hostd to the record. */
  private current: Promise<Started> | null = null;
  private following: { startedAt: string; trigger: string } | null = null;

  constructor(private readonly options: EngineUpdatesOptions) {
    this.hostd = options.hostd;
    this.store = options.store ?? settingsStore;
    this.audit = options.audit ?? audit;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Stored zone, else the zone this bridge was built with (tests), else the process. */
  private zone(stored: Stored): string {
    return timeZoneFrom(stored.timeZone, this.options.timeZone ?? localTimeZone());
  }

  private async saveSchedules(schedules: ToolSchedules, by: string): Promise<void> {
    await this.store.set('systemToolSchedules', JSON.stringify(schedules), by);
  }

  /**
   * What is stored, or the read's error. A failed read used to answer the
   * defaults — every tool on Sunday 18:00, no pin — and the tick, a claim, a
   * recorded result or a schedule change then saved them over what a person
   * set, so one database error wiped every pin. Only `view` falls back.
   */
  private async stored(): Promise<Stored> {
    return storedFrom(await this.store.all());
  }

  /**
   * Writes the per-tool schedules once, and drops the keys they came from.
   * A read used to do this. The attention list catches a failed read and
   * treats it as no failed update, so a migration that could not be saved
   * hid the card for an update that had failed.
   */
  async migrate(): Promise<void> {
    const all = await this.store.all();
    const { schedules, migrated } = toolSchedulesFrom(all);
    if (!migrated) return;
    await this.saveSchedules(schedules, 'fleetadlc');
    for (const key of [KEY.enabled, KEY.day, KEY.time, KEY.slot] as const) {
      if (all[key]) await this.store.set(key, '', 'fleetadlc');
    }
  }

  /** The last result the bridge recorded; what the attention list reads. */
  async lastResult(): Promise<EngineUpdateResult | null> {
    const all = await this.store.all().catch(() => ({}) as Partial<Record<SettingKey, string>>);
    return parse<EngineUpdateResult>(all[KEY.last]);
  }

  /** The attention item for a failed update, or null. See `engineUpdateAttention`. */
  async attention(): Promise<EngineUpdateAttention | null> {
    return engineUpdateAttention(await this.lastResult());
  }

  async view(): Promise<EngineUpdatesView> {
    const now = this.now();
    // The Settings page still answers, with what an empty store would say.
    const stored = await this.stored().catch(() => storedFrom({}));
    const status = await this.hostd.engineUpdateStatus().then(
      (answer) => ({ answer, detail: '' }),
      (error: unknown) => ({ answer: null, detail: message(error) }),
    );
    const hostd = status.answer;
    // hostd's own last result is newer only while the bridge is still
    // recording it; show it rather than the one before.
    const last =
      hostd?.last && (!stored.last || hostd.last.finishedAt > stored.last.finishedAt) ? hostd.last : stored.last;
    const zone = this.zone(stored);
    const schedule = summarySchedule(stored.schedules);
    const tools: SystemToolView[] = SYSTEM_TOOLS.map((tool) => {
      const row = stored.schedules[tool.id];
      const check = stored.toolLast[tool.id] ?? null;
      const enabled = row.mode === 'schedule';
      const asSchedule: Schedule = { enabled: true, day: row.day, time: row.time };
      const handled = row.slot ? new Date(row.slot) : null;
      return {
        id: tool.id,
        key: tool.key,
        name: tool.name,
        purpose: tool.purpose,
        source: tool.source,
        inUse: hostd?.inUse?.[tool.key] ?? null,
        latest: check?.latest ?? last?.latest?.[tool.key] ?? null,
        pin: row.pin,
        schedule: { mode: row.mode, day: row.day, time: row.time },
        nextRun: enabled ? nextSlotAfter(now, asSchedule, zone).toISOString() : null,
        due: enabled && isDue(now, asSchedule, handled && !Number.isNaN(handled.getTime()) ? handled : null, zone),
        last: check,
      };
    });
    const nexts = tools.flatMap((tool) => (tool.nextRun ? [tool.nextRun] : [])).sort();

    return {
      timeZone: zone,
      tools,
      schedule: { ...schedule, timeZone: zone, description: describeSchedule(schedule) },
      nextRun: nexts[0] ?? null,
      due: tools.some((tool) => tool.due),
      hostd: { reachable: hostd !== null, detail: status.detail },
      applicable: hostd ? hostd.applicable : null,
      reason: hostd?.reason ?? '',
      image: hostd?.image ?? null,
      inUse: hostd?.inUse ?? null,
      inUseSource: hostd?.inUseSource ?? null,
      previous: hostd?.previous ?? null,
      latest: last?.latest ?? null,
      running: hostd?.running ?? this.following,
      last,
      hold: stored.hold,
      minReleaseAgeDays: stored.minReleaseAgeDays,
      attention: engineUpdateAttention(last),
    };
  }

  /**
   * Runs the update now, or joins the run already going — here or on hostd.
   * Answers once hostd has taken the request, which is at once; `done`
   * settles when the run has ended and been recorded, and never rejects.
   * A hostd that does not answer is thrown, so the caller can say so.
   */
  start(input: StartInput): Promise<Started> {
    if (this.current) {
      // A person's Update now used to join the run already going, and the
      // tool they pressed it for was not in that run: the page said it had
      // started, and the tool never moved. Refused instead, with the button
      // disabled until the run ends. A schedule's look joins and claims
      // nothing, so its tools are still due at the next look.
      if (input.trigger === 'console') return Promise.reject(alreadyRunning(this.following?.startedAt ?? null));
      return this.current.then((started) => ({ ...started, joined: true }));
    }
    const attempt = this.begin(input);
    this.current = attempt;
    const release = (): void => {
      if (this.current === attempt) this.current = null;
    };
    attempt.then((started) => started.done.finally(release), release);
    return attempt;
  }

  private async begin(input: StartInput): Promise<Started> {
    // Read at each start, the schedule's and a person's alike: a changed
    // minimum applies from the next run.
    const { hold, minReleaseAgeDays } = await this.stored();
    const answer = await this.hostd.startEngineUpdate(
      {
        trigger: input.trigger,
        hold,
        minReleaseAgeDays,
        ...(input.only ? { only: input.only } : {}),
        ...(input.pins && Object.keys(input.pins).length > 0 ? { pins: input.pins } : {}),
      },
      input.actor,
    );
    // hostd was already running one this bridge did not start — started
    // before a restart. Nothing new began, so neither this person's tools nor
    // a schedule's due ones are in it.
    if (answer.running && answer.joined) {
      if (input.trigger === 'console') throw alreadyRunning(answer.startedAt);
      const startedAt = answer.startedAt ?? this.now().toISOString();
      this.following = { startedAt, trigger: input.trigger };
      const done = this.follow(startedAt, input)
        .then(async (result) => {
          await this.record(result, input.actor).catch((error: unknown) => {
            this.log(`[bridge] could not record the engine update: ${message(error)}`);
          });
          return result;
        })
        .finally(() => {
          this.following = null;
        });
      return { startedAt, joined: true, done };
    }
    // Once hostd has it, and not before: a hostd that did not answer has not
    // run this week's update, and the next look tries again.
    if (input.claims?.length) await this.claimTools(input.claims, input.actor);

    if (!answer.running) {
      const result = answer.last;
      if (result) await this.record(result, input.actor, input.tools);
      const done = result ?? this.lost(answer.startedAt ?? this.now().toISOString(), input, 'hostd answered with no run and no result');
      return { startedAt: answer.startedAt, joined: false, done: Promise.resolve(done) };
    }

    const startedAt = answer.startedAt ?? this.now().toISOString();
    this.following = { startedAt, trigger: input.trigger };
    // Written down before it is followed: a bridge that restarts mid-run
    // records hostd's result from `tick`, and needs to know which tools it was for.
    await this.store
      .set('systemToolRun', JSON.stringify({ startedAt, tools: input.tools ?? toolsOfKeys(input.only) } satisfies ToolRun), input.actor)
      .catch((error: unknown) => this.log(`[bridge] could not remember the engine update in flight: ${message(error)}`));
    const done = this.follow(startedAt, input)
      .then(async (result) => {
        await this.record(result, input.actor, input.tools).catch((error: unknown) => {
          this.log(`[bridge] could not record the engine update: ${message(error)}`);
        });
        return result;
      })
      .finally(() => {
        this.following = null;
      });
    return { startedAt, joined: answer.joined, done };
  }

  /** Looks at hostd until the run that started at `startedAt` has ended, and returns how. */
  private async follow(startedAt: string, input: { trigger: string; actor: string }): Promise<EngineUpdateResult> {
    const pollMs = this.options.pollMs ?? 5_000;
    const silentMs = this.options.silentMs ?? 10 * 60_000;
    const maxMs = this.options.maxMs ?? 3 * 60 * 60_000;
    const began = Date.now();
    let silentSince: number | null = null;

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let status: EngineUpdateStatus;
      try {
        status = await this.hostd.engineUpdateStatus();
        silentSince = null;
      } catch (error) {
        silentSince ??= Date.now();
        if (Date.now() - silentSince >= silentMs) {
          return this.lost(startedAt, input, `hostd stopped answering while the update ran (${message(error)})`);
        }
        continue;
      }
      if (status.last?.startedAt === startedAt && status.running?.startedAt !== startedAt) return status.last;
      if (status.running?.startedAt === startedAt) {
        if (Date.now() - began >= maxMs) {
          return this.lost(startedAt, input, `the update was still running after ${Math.round(maxMs / 60_000)} minutes`);
        }
        continue;
      }
      return this.lost(
        startedAt,
        input,
        'hostd no longer knows the run — it restarted before the update finished; check which versions are in use',
      );
    }
  }

  /** A run the bridge could not see to its end, as a failure a person will see. */
  private lost(startedAt: string, input: { trigger: string; actor: string }, reason: string): EngineUpdateResult {
    return {
      state: 'failed',
      trigger: input.trigger,
      requestedBy: input.actor,
      from: {},
      to: null,
      latest: null,
      checks: [],
      reason,
      startedAt,
      finishedAt: this.now().toISOString(),
    };
  }

  /** The slot each due tool was claimed for, so the next look does not run it again. */
  private async claimTools(claims: { id: SystemToolId; slot: Date }[], by: string): Promise<void> {
    if (claims.length === 0) return;
    const stored = await this.stored();
    const schedules = stored.schedules;
    for (const claim of claims) {
      const row = schedules[claim.id];
      if (!row) continue;
      schedules[claim.id] = { ...row, slot: claim.slot.toISOString() };
    }
    await this.saveSchedules(schedules, by);
  }

  /**
   * Writes a result down, once: as the last result, and in the audit log when
   * it changed something or failed to. A run with nothing newer is kept only
   * as the last check. False when this result was already recorded, which is
   * what makes recording it from two places safe.
   */
  async record(result: EngineUpdateResult, actor?: string | null, tools?: readonly SystemToolId[]): Promise<boolean> {
    const stored = await this.stored();
    if (stored.last && stored.last.startedAt === result.startedAt && stored.last.finishedAt === result.finishedAt) {
      return false;
    }
    await this.store.set(KEY.last, JSON.stringify(kept(result)), 'fleetadlc');
    const toolLast = { ...stored.toolLast };
    const schedules = stored.schedules;
    let pinsMoved = false;
    // Only the tools the run was for. A rollback swaps the whole image, so it
    // is every tool's news; a run for grok says nothing about Codex's last check.
    const persisted = parse<ToolRun>(stored.run);
    const inFlight = persisted && persisted.startedAt === result.startedAt ? persisted.tools : undefined;
    const about = result.state === 'rolled-back' ? [...TOOL_IDS] : (tools ?? inFlight ?? toolsOfResult(result));
    for (const id of about) {
      const key = toolKey(id);
      const from = result.from[key];
      const to = result.to?.[key];
      const latest = result.latest?.[key];
      toolLast[id] = {
        state: result.state,
        finishedAt: result.finishedAt,
        reason: result.reason,
        from: typeof from === 'string' ? from : null,
        to: typeof to === 'string' ? to : null,
        latest: typeof latest === 'string' ? latest : null,
        trigger: result.trigger,
      };
      // An explicit update is the one that moves a pin. A schedule reported
      // the newer version and left the pin where it was.
      if (result.trigger === 'console' && schedules[id].pin && typeof to === 'string' && to !== schedules[id].pin) {
        schedules[id] = { ...schedules[id], pin: to };
        pinsMoved = true;
      }
    }
    await this.store.set('systemToolLast', JSON.stringify(toolLast), 'fleetadlc');
    if (pinsMoved) await this.saveSchedules(schedules, 'fleetadlc');
    if (persisted && persisted.startedAt === result.startedAt) await this.store.set('systemToolRun', '', 'fleetadlc');

    const who = result.requestedBy ?? actor ?? (result.trigger === 'schedule' ? 'schedule' : 'fleetadlc');
    const checks = result.checks.map((check) => ({
      kind: check.kind,
      state: check.state,
      ...(check.cli ? { cli: check.cli } : {}),
      ...(check.model ? { model: check.model } : {}),
      ...(check.account ? { account: check.account.label } : {}),
    }));
    switch (result.state) {
      case 'updated':
        await this.audit({
          actor: who,
          action: 'engines.updated',
          target: 'bot-image',
          payload: {
            trigger: result.trigger,
            from: result.from,
            to: result.to,
            changes: result.reason,
            checks,
            refreshed: result.refreshed ?? [],
            deferred: result.deferred ?? [],
          },
        });
        // What a rollback held back is moot once something newer went in.
        if (Object.keys(stored.hold).length > 0) await this.store.set(KEY.hold, '', 'fleetadlc');
        break;
      case 'failed':
        await this.audit({
          actor: who,
          action: 'engines.update_failed',
          target: 'bot-image',
          payload: {
            trigger: result.trigger,
            reason: clip(result.reason, 1000),
            from: result.from,
            to: result.to,
            checks: checks.filter((check) => check.state === 'failed'),
          },
        });
        break;
      case 'rolled-back': {
        await this.audit({
          actor: who,
          action: 'engines.rolled_back',
          target: 'bot-image',
          payload: { from: result.from, to: result.to, refreshed: result.refreshed ?? [], deferred: result.deferred ?? [] },
        });
        const hold = undone(result);
        await this.store.set(KEY.hold, Object.keys(hold).length > 0 ? JSON.stringify(hold) : '', who);
        break;
      }
      default:
        break;
    }
    return true;
  }

  /**
   * The scheduled job. Records a run hostd finished that nobody recorded — a
   * bridge that restarted mid-run, or gave up waiting — and starts this
   * week's run once its slot has passed, however long after.
   */
  async tick(): Promise<string[]> {
    await this.migrate();
    const lines: string[] = [];
    if (!this.current) {
      const status = await this.hostd.engineUpdateStatus().catch(() => null);
      if (status?.last && !status.running && (await this.record(status.last))) {
        lines.push(`recorded the engine update hostd finished at ${status.last.finishedAt}: ${status.last.state}`);
      }
    }

    const now = this.now();
    const stored = await this.stored();
    const zone = this.zone(stored);
    const schedules = stored.schedules;
    const scheduled = TOOL_IDS.filter((id) => schedules[id].mode === 'schedule');
    if (scheduled.length === 0) return [...lines, 'engine updates are off'];

    const summary = summarySchedule(schedules);
    const due: SystemToolId[] = [];
    const first: SystemToolId[] = [];
    for (const id of scheduled) {
      const row = schedules[id];
      const asSchedule: Schedule = { enabled: true, day: row.day, time: row.time };
      if (!row.slot) {
        first.push(id);
        schedules[id] = { ...row, slot: lastSlotAtOrBefore(now, asSchedule, zone).toISOString() };
        continue;
      }
      const handled = new Date(row.slot);
      if (Number.isNaN(handled.getTime()) || isDue(now, asSchedule, handled, zone)) due.push(id);
    }
    if (first.length > 0) await this.saveSchedules(schedules, 'schedule');
    const nextOf = (id: SystemToolId): string =>
      nextSlotAfter(now, { day: schedules[id].day, time: schedules[id].time }, zone).toISOString();
    if (due.length === 0) {
      const next = scheduled.map(nextOf).sort()[0];
      // Over the scheduled tools only: a tool updated by hand does not make the
      // others' day and time any less one schedule.
      const lead = schedules[scheduled[0]!];
      const shared = scheduled.every((id) => schedules[id].day === lead.day && schedules[id].time === lead.time);
      const when = shared ? describeSchedule(summary) : 'on each tool’s own schedule';
      if (first.length === scheduled.length) {
        return [...lines, `engine updates run ${when} (${zone}); the first is at ${next}`];
      }
      return [...lines, `engine updates run ${when}; the next is at ${next}`];
    }

    // One candidate for every tool that is due. A pin is named so a newer
    // version is reported and not applied; an unpinned tool may move.
    const only = due.map((id) => toolKey(id));
    const pins: EngineVersions = {};
    for (const id of due) {
      const pin = schedules[id].pin;
      if (pin) pins[toolKey(id)] = pin;
    }
    const claims = due.map((id) => ({
      id,
      slot: lastSlotAtOrBefore(now, { day: schedules[id].day, time: schedules[id].time }, zone),
    }));

    try {
      const started = await this.start({
        trigger: 'schedule',
        actor: 'schedule',
        only,
        ...(Object.keys(pins).length > 0 ? { pins } : {}),
        claims,
        tools: due,
      });
      const result = await started.done;
      return [...lines, `this week's engine update: ${result.state} — ${result.reason}`];
    } catch (error) {
      return [...lines, `this week's engine update did not start: ${message(error)}; the next look tries again`];
    }
  }

  /** The previous image back as latest, and recorded; refused while an update runs. */
  async rollback(actor: string): Promise<EngineUpdatesView> {
    if (this.current) throw new HttpFailure(409, 'an engine update is running; roll back once it has finished');
    const result = await this.hostd.rollbackEngines(actor);
    await this.record(result, actor);
    return this.view();
  }

  /**
   * Changes the schedule. A changed day, time or time zone, or turning it
   * on, counts from now: the next run is the next time it comes round, never
   * a slot that passed while the schedule said something else.
   */
  async setSchedule(input: Record<string, unknown>, actor: string): Promise<EngineUpdatesView> {
    await this.migrate();
    for (const key of Object.keys(input)) {
      if (!['enabled', 'day', 'time', 'timeZone', 'tools', 'minReleaseAgeDays'].includes(key)) {
        throw new HttpFailure(400, `${key} is not part of the schedule`);
      }
    }
    if (input.minReleaseAgeDays !== undefined && !isMinReleaseAgeDays(input.minReleaseAgeDays)) {
      throw new HttpFailure(400, 'minReleaseAgeDays is a whole number of days from 0 to 90, such as 3; 0 takes a new release at once');
    }
    const stored = await this.stored();
    let zone = this.zone(stored);
    const schedules = stored.schedules;
    // The shared day, time and switch write one value onto every tool. Once
    // the tools differ, that erased each one's own day and time, and put a
    // tool someone held to manual back on a schedule. Refused before anything
    // is written, the time zone included, so a refused change changes nothing.
    const sharedInput = input.enabled !== undefined || input.day !== undefined || input.time !== undefined;
    if (sharedInput && !sharedSchedule(schedules)) {
      throw new HttpFailure(
        409,
        'the tools update on their own schedules, so one change would overwrite each — change them one by one: tools: [{ id, mode, day, time }]',
      );
    }
    const current = summarySchedule(schedules);
    const next: Schedule = { ...current };
    let zoneMoved = false;

    if (input.timeZone !== undefined) {
      const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
      if (!isIanaTimeZone(timeZone)) throw new HttpFailure(400, 'timeZone is an IANA name, such as America/New_York');
      if (timeZone !== zone) {
        await this.store.set('systemTimeZone', timeZone, actor);
        await this.audit({
          actor,
          action: 'system.timezone_changed',
          target: 'install',
          payload: { from: zone, to: timeZone },
        });
        zone = timeZone;
        zoneMoved = true;
      }
    }

    let shared = false;
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new HttpFailure(400, 'enabled is true or false');
      next.enabled = input.enabled;
      shared = true;
    }
    if (input.day !== undefined) {
      const day = typeof input.day === 'string' ? input.day.trim().toLowerCase() : '';
      if (!(DAYS as readonly string[]).includes(day)) throw new HttpFailure(400, `day is one of ${DAYS.join(', ')}`);
      next.day = day as Day;
      shared = true;
    }
    if (input.time !== undefined) {
      const time = typeof input.time === 'string' ? input.time.trim() : '';
      if (!TIME.test(time)) throw new HttpFailure(400, 'time is HH:MM on a 24-hour clock, such as 18:00');
      next.time = time;
      shared = true;
    }
    if (shared) {
      // The page's one schedule still sets every tool. A later per-tool edit
      // is what makes them differ; this is how an install moves off the old
      // Sunday without a second form.
      //
      // Whether a tool's schedule moved is its own row's question. The summary
      // counts as on once any tool is, so a tool that was manual, turned on
      // with the summary's own day and time, kept the slot it had when it went
      // manual, and the next look ran it at once.
      for (const id of TOOL_IDS) {
        const was = schedules[id];
        const row: ToolSchedule = { ...was, mode: next.enabled ? 'schedule' : 'manual', day: next.day, time: next.time };
        const moved = row.mode === 'schedule' && (was.mode !== 'schedule' || was.day !== row.day || was.time !== row.time);
        schedules[id] = moved ? { ...row, slot: lastSlotAtOrBefore(this.now(), row, zone).toISOString() } : row;
      }
      await this.saveSchedules(schedules, actor);
      await this.audit({
        actor,
        action: 'engines.schedule_changed',
        target: 'bot-image',
        payload: { enabled: next.enabled, day: next.day, time: next.time, timeZone: zone },
      });
    }

    if (input.tools !== undefined) {
      if (!Array.isArray(input.tools)) throw new HttpFailure(400, 'tools is a list');
      for (const item of input.tools) {
        if (!item || typeof item !== 'object') throw new HttpFailure(400, 'a tool needs an id');
        const row = item as Record<string, unknown>;
        const tool = typeof row.id === 'string' ? systemToolById(row.id) : undefined;
        if (!tool) throw new HttpFailure(400, 'unknown tool');
        const currentRow = schedules[tool.id];
        let mode = currentRow.mode;
        let day = currentRow.day;
        let time = currentRow.time;
        let pin = currentRow.pin;
        if (row.mode !== undefined) {
          if (row.mode !== 'schedule' && row.mode !== 'manual') throw new HttpFailure(400, 'mode is schedule or manual');
          mode = row.mode;
        }
        if (row.day !== undefined) {
          const named = typeof row.day === 'string' ? row.day.trim().toLowerCase() : '';
          if (!(DAYS as readonly string[]).includes(named)) throw new HttpFailure(400, `day is one of ${DAYS.join(', ')}`);
          day = named as Day;
        }
        if (row.time !== undefined) {
          const named = typeof row.time === 'string' ? row.time.trim() : '';
          if (!TIME.test(named)) throw new HttpFailure(400, 'time is HH:MM on a 24-hour clock, such as 18:00');
          time = named;
        }
        if (row.pin !== undefined) {
          const named = typeof row.pin === 'string' ? row.pin.trim() : row.pin;
          if (named !== null && (typeof named !== 'string' || !PIN.test(named))) {
            throw new HttpFailure(400, `a pin is the version ${tool.name} is on, such as 2.1.282, or null to unpin`);
          }
          pin = named;
        }
        const moved = mode === 'schedule' && (mode !== currentRow.mode || day !== currentRow.day || time !== currentRow.time);
        schedules[tool.id] = {
          ...currentRow,
          mode,
          day,
          time,
          pin,
          ...(moved ? { slot: lastSlotAtOrBefore(this.now(), { day, time }, zone).toISOString() } : {}),
        };
      }
      await this.saveSchedules(schedules, actor);
      await this.audit({
        actor,
        action: 'engines.schedule_changed',
        target: 'bot-image',
        payload: { tools: input.tools, timeZone: zone },
      });
    }

    // A slot is a wall-clock time in the install's zone. Moved to a zone where
    // this week's has already passed, every scheduled tool fell due at once.
    if (zoneMoved) {
      for (const id of TOOL_IDS) {
        const row = schedules[id];
        if (row.mode === 'schedule') schedules[id] = { ...row, slot: lastSlotAtOrBefore(this.now(), row, zone).toISOString() };
      }
      await this.saveSchedules(schedules, actor);
    }

    if (isMinReleaseAgeDays(input.minReleaseAgeDays) && input.minReleaseAgeDays !== stored.minReleaseAgeDays) {
      await this.store.set('engineUpdateMinReleaseAgeDays', String(input.minReleaseAgeDays), actor);
      await this.audit({
        actor,
        action: 'engines.schedule_changed',
        target: 'bot-image',
        payload: { minReleaseAgeDays: { from: stored.minReleaseAgeDays, to: input.minReleaseAgeDays } },
      });
    }

    return this.view();
  }
}

const instances = new WeakMap<object, EngineUpdates>();

/**
 * The one `EngineUpdates` for a hostd client, so the scheduled job and the
 * console's routes share a run in flight and record it once.
 */
export function engineUpdatesFor(hostd: EngineUpdatesHostd): EngineUpdates {
  if (typeof hostd !== 'object' || hostd === null) return new EngineUpdates({ hostd });
  let found = instances.get(hostd);
  if (!found) {
    found = new EngineUpdates({ hostd });
    instances.set(hostd, found);
  }
  return found;
}

/**
 * The console's routes: what the engines are and when they next update, run
 * one now, change the schedule, and roll back. Each returns the whole view,
 * so the page redraws from one answer.
 */
export function registerEngineUpdateRoutes(router: Router, updates: EngineUpdates): void {
  router.get('/v1/engines/updates', async () => updates.view());

  router.post('/v1/engines/updates', async ({ body, identity }) => {
    // No pins: an explicit update is the one that may move a pin. A schedule
    // names pins so a newer version is reported and not taken. `{ tools:
    // ["grok"] }` is one tool's Update now; no list is Update all.
    const input = await body<unknown>();
    const named = input && typeof input === 'object' && !Array.isArray(input) ? (input as { tools?: unknown }).tools : undefined;
    const ids = toolIdsFrom(named);
    if (ids === null || (ids !== undefined && ids.length === 0)) {
      throw new HttpFailure(400, `tools is a list of one or more of ${SYSTEM_TOOLS.map((tool) => tool.id).join(', ')}`);
    }
    const tools = ids ?? SYSTEM_TOOLS.map((tool) => tool.id);
    await updates.start({ trigger: 'console', actor: identity, only: tools.map((id) => toolKey(id)), tools });
    return updates.view();
  });

  router.patch('/v1/engines/updates', async ({ body, identity }) => {
    const input = await body<unknown>();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HttpFailure(400, 'send the parts of the schedule to change: enabled, day, time, timeZone, tools, minReleaseAgeDays');
    }
    return updates.setSchedule(input as Record<string, unknown>, identity);
  });

  router.post('/v1/engines/updates/rollback', async ({ identity }) => updates.rollback(identity));
}
