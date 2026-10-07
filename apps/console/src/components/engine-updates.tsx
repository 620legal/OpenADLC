'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { modelName } from '@/lib/model-onboarding';

/**
 * The engine CLIs the crew thinks with, and the weekly update that keeps them
 * current.
 *
 * Every Sunday evening, unless somebody changes it here, OpenADLC asks for a
 * newer version of each tool, builds a bot image with them, and swaps
 * it in only once each CLI answers from it and every model the crew uses has
 * been called through it. This says what the crew runs now, how the last run
 * ended in one sentence, and when the next one is — and offers the two things
 * a person might want instead of waiting: update now, or go back to the image
 * before the last update. Each tool has its own row with its own schedule,
 * Update now and last result, and Update all now moves every tool at once.
 *
 * Self-contained, so a page mounts it with one line: it reads and writes its
 * own state through `/api/engine-updates`.
 */

export type EngineVersions = Record<string, string | null | undefined>;

export interface EngineUpdateCheck {
  kind: 'cli' | 'model';
  state: 'passed' | 'failed' | 'skipped';
  detail: string;
  cli?: string;
  model?: string;
  configured?: string[];
  account?: { id: string; label: string; provider: string; kind: string } | null;
  bots?: string[];
}

export interface EngineUpdateResult {
  state: 'updated' | 'current' | 'failed' | 'skipped' | 'rolled-back';
  trigger: string;
  requestedBy: string | null;
  from: EngineVersions;
  to: EngineVersions | null;
  latest: EngineVersions | null;
  checks: EngineUpdateCheck[];
  reason: string;
  startedAt: string;
  finishedAt: string;
  refreshed?: string[];
  deferred?: string[];
}

/** What the last run that was about one tool did to it. */
export interface ToolCheck {
  state: EngineUpdateResult['state'];
  finishedAt: string;
  reason: string;
  from: string | null;
  to: string | null;
  latest: string | null;
  trigger: string;
}

export interface SystemToolRow {
  id: string;
  name: string;
  inUse: string | null;
  latest: string | null;
  pin: string | null;
  /** Where a newer version was read. Absent on the three-engine fallback, which is npm. */
  source?: 'npm' | 'github' | 'nodejs';
  schedule: { mode: 'schedule' | 'manual'; day: string; time: string };
  /** The tool's next scheduled run; null while it is manual. */
  nextRun?: string | null;
  /** The last run that was about this tool, or null before one. */
  last?: ToolCheck | null;
}

/** A change to one tool's schedule, as the PATCH's `tools` entry takes it. */
export type ToolSchedulePatch = Partial<SystemToolRow['schedule']>;

export interface EngineUpdatesView {
  /** Present once the bridge speaks of System. Absent on an older bridge, which is the three engines. */
  tools?: SystemToolRow[];
  timeZone?: string;
  schedule: { enabled: boolean; day: string; time: string; timeZone: string; description: string };
  nextRun: string | null;
  due: boolean;
  hostd: { reachable: boolean; detail: string };
  applicable: boolean | null;
  reason: string;
  image: string | null;
  inUse: EngineVersions | null;
  inUseSource: string | null;
  previous: EngineVersions | null;
  latest: EngineVersions | null;
  running: { startedAt: string; trigger: string } | null;
  last: EngineUpdateResult | null;
  hold: EngineVersions;
  /**
   * Whole days an engine CLI release must have been on npm before a run
   * takes it; 0 takes it at once. Absent on a bridge from before the setting.
   */
  minReleaseAgeDays?: number;
  attention: { title: string; detail: string } | null;
}

/** The waits the panel offers, and whatever the install has set besides. */
const RELEASE_AGES = [0, 1, 2, 3, 5, 7, 14, 30, 60, 90];

/** The CLIs, in the order the image installs them, by the names people use. */
export const ENGINES = [
  { pkg: '@anthropic-ai/claude-code', name: 'claude-code' },
  { pkg: '@openai/codex', name: 'codex' },
  { pkg: '@xai-official/grok', name: 'grok' },
] as const;

/**
 * Every tool an update can move, in the order hostd's `describeChanges` says
 * them: the engines, then what the image carries besides. A sentence that
 * knew only the engines read "— ; checked against …" for an update that moved
 * only Node or gh.
 */
export const TOOLS: readonly { pkg: string; name: string }[] = [...ENGINES, { pkg: 'node', name: 'node' }, { pkg: 'gh', name: 'gh' }];

/** A tool's name by its key; one this console does not know yet by the last part of its key. */
function toolName(pkg: string): string {
  return TOOLS.find((tool) => tool.pkg === pkg)?.name ?? pkg.slice(pkg.lastIndexOf('/') + 1);
}

/** Every key in either map, the known tools first and in their order. */
function toolKeys(...maps: EngineVersions[]): string[] {
  const present = new Set(maps.flatMap((map) => Object.keys(map)));
  const known = TOOLS.map((tool) => tool.pkg).filter((pkg) => present.has(pkg));
  return [...known, ...[...present].filter((pkg) => !known.includes(pkg)).sort()];
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Zones a person is likely to mean. The one the install already uses is added when it is not among them. */
const ZONES: readonly string[] = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Jerusalem',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** Every half hour, which is as fine as a weekly schedule needs. */
const TIMES = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);

/** How a minimum release age reads after "once it is": `3 days old`, or `published` for 0. */
export function releaseAge(days: number): string {
  if (days === 0) return 'published';
  return `${days} day${days === 1 ? '' : 's'} old`;
}

function capitalised(word: string): string {
  return word ? `${word[0]?.toUpperCase()}${word.slice(1)}` : word;
}

/**
 * Whether the tools' own rows differ in mode, day or time. The bridge's
 * summary then names only the first scheduled tool's day and time, and the
 * shared switch would write that onto every tool, so neither is shown.
 */
export function toolsDiffer(tools: readonly SystemToolRow[] | undefined): boolean {
  const first = tools?.[0]?.schedule;
  if (!tools || !first) return false;
  return tools.some(
    ({ schedule }) => schedule.mode !== first.mode || schedule.day !== first.day || schedule.time !== first.time,
  );
}

/** "Engine updates — every Sunday at 18:00", "— off", or "— each tool on its own schedule". */
export function engineUpdatesTitle(schedule: EngineUpdatesView['schedule'], tools?: readonly SystemToolRow[]): string {
  if (toolsDiffer(tools)) return 'Engine updates — each tool on its own schedule';
  return `Engine updates — ${schedule.enabled ? `every ${capitalised(schedule.day)} at ${schedule.time}` : 'off'}`;
}

/**
 * The zone, or UTC where this browser's Intl does not know it. The bridge
 * checks a zone against Node's tz database, which can be newer than a
 * browser's, and an unknown zone threw while Settings was drawn.
 */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** "Sep 27, 18:02", on the install's clock rather than the browser's. */
export function when(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const zone = safeZone(timeZone);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  return `${date}, ${time}`;
}

/** "Sunday, Oct 4 at 18:00". */
export function whenDay(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: safeZone(timeZone), weekday: 'long' }).format(at);
  const [date, time] = when(iso, timeZone).split(', ');
  return `${weekday}, ${date} at ${time}`;
}

/** "claude-code 2.1.282 → 2.1.290; codex 0.155.1 → 0.156.1; node 22.11.0 → 22.12.0". */
export function versionChanges(from: EngineVersions, to: EngineVersions | null): string {
  if (!to) return '';
  return toolKeys(from, to)
    .filter((pkg) => (from[pkg] ?? null) !== (to[pkg] ?? null))
    .map((pkg) => `${toolName(pkg)} ${from[pkg] ?? 'unknown'} → ${to[pkg] ?? 'unknown'}`)
    .join('; ');
}

/** "gh 2.62.0, node 22.11.0": what a rollback holds back, every tool it names. */
export function heldBack(hold: EngineVersions): string[] {
  return toolKeys(hold)
    .filter((pkg) => hold[pkg])
    .map((pkg) => `${toolName(pkg)} ${hold[pkg]}`);
}

/** "Newest Opus on Anthropic Max", for one model call. */
export function checkLabel(check: EngineUpdateCheck): string {
  const names = [...new Set((check.configured?.length ? check.configured : [check.model ?? '']).map(modelName))];
  const where = check.account ? check.account.label : `${check.bots?.[0] ?? 'the bot'}’s own key`;
  return `${names.join(' / ')} on ${where}`;
}

/** "checked against Newest Opus on Anthropic Max, Newest Codex on OpenAI API key". */
function checkedAgainst(checks: EngineUpdateCheck[]): string {
  const called = checks.filter((check) => check.kind === 'model' && check.state === 'passed').map(checkLabel);
  if (called.length === 0) return 'each CLI answered from the new image; no bot had a model to call';
  return `checked against ${called.join(', ')}`;
}

/** The last result, in one sentence, and how loudly to say it. */
export function lastResultSentence(
  result: EngineUpdateResult | null,
  timeZone: string,
): { text: string; tone: 'good' | 'warn' | 'plain' } {
  if (!result) return { text: 'No engine update has run here yet.', tone: 'plain' };
  const at = when(result.finishedAt, timeZone);
  const changed = versionChanges(result.from, result.to);
  switch (result.state) {
    case 'updated':
      // hostd's reason is its own account of the change, when the names here fall short.
      return { text: `${at} — ${changed || result.reason}; ${checkedAgainst(result.checks)}.`, tone: 'good' };
    case 'current':
      return { text: `${at} — nothing to take: ${result.reason}.`, tone: 'plain' };
    case 'failed':
      return {
        text: `${at} — ${changed || 'the update'} did not go in: ${result.reason}. The bots are still on the engines they had.`,
        tone: 'warn',
      };
    case 'skipped':
      return { text: `${at} — not run: ${result.reason}.`, tone: 'plain' };
    case 'rolled-back':
      return { text: `${at} — rolled back to the previous image: ${changed || result.reason}.`, tone: 'plain' };
  }
}

function clipped(text: string, limit = 180): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** One tool's last check or result: "Last checked Sep 27, 18:02 — nothing newer". */
export function toolLastSentence(check: ToolCheck | null | undefined, timeZone: string): { text: string; tone: 'good' | 'warn' | 'plain' } {
  if (!check) return { text: 'Not checked here yet.', tone: 'plain' };
  const at = when(check.finishedAt, timeZone);
  switch (check.state) {
    case 'updated':
      return check.from !== check.to && check.to
        ? { text: `Updated ${at}: ${check.from ?? 'unknown'} → ${check.to}.`, tone: 'good' }
        : { text: `Checked ${at}, in an update of another tool; this one stayed at ${check.to ?? check.from ?? 'its version'}.`, tone: 'plain' };
    case 'current':
      return {
        text: `Checked ${at}: ${check.latest && check.from && check.latest !== check.from ? `${check.latest} is out, and ${clipped(check.reason)}` : 'nothing newer'}.`,
        tone: 'plain',
      };
    case 'failed':
      return { text: `Failed ${at}: ${clipped(check.reason)}. It is still on ${check.from ?? 'the version it had'}.`, tone: 'warn' };
    case 'skipped':
      return { text: `Not run ${at}: ${clipped(check.reason)}.`, tone: 'plain' };
    case 'rolled-back':
      return { text: `Rolled back ${at}${check.from !== check.to && check.to ? `: ${check.from ?? 'unknown'} → ${check.to}` : ''}.`, tone: 'plain' };
  }
}

/** When the next run is, or why there is none. */
export function nextRunSentence(view: EngineUpdatesView): string {
  if (view.running) {
    return `Updating now — started ${when(view.running.startedAt, view.schedule.timeZone)}. The bots keep working; nothing changes for them unless every check passes.`;
  }
  if (!view.schedule.enabled) return 'Off: the engines stay as they are until somebody updates them here.';
  if (view.due) return 'This week’s update is due, and starts within a few minutes.';
  if (!view.nextRun) return '';
  return `Next: ${whenDay(view.nextRun, view.schedule.timeZone)} (${view.schedule.timeZone}).`;
}

function Row({ tone, children }: { tone: 'good' | 'warn' | 'plain'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed',
        tone === 'good' && 'border-signal/40 bg-signal/10 text-body',
        tone === 'warn' && 'border-attention/40 bg-attention/10 text-body',
        tone === 'plain' && 'border-edge bg-surface text-muted',
      )}
    >
      {children}
    </div>
  );
}

const MARK: Record<EngineUpdateCheck['state'], string> = { passed: '✓', failed: '×', skipped: '–' };

export type Busy = 'updating' | 'rolling-back' | 'saving' | null;

/** The panel, drawn from a view. `EngineUpdates` below fetches the view and handles the clicks. */
export function EngineUpdatesPanel({
  view,
  busy,
  error,
  confirming,
  onEnabled,
  onDay,
  onTime,
  onUpdate,
  onRollback,
  onConfirm,
  onPin,
  onTimeZone,
  onToolSchedule,
  onUpdateTool,
  onMinReleaseAge,
}: {
  view: EngineUpdatesView;
  busy: Busy;
  error: string | null;
  confirming: boolean;
  onEnabled: (enabled: boolean) => void;
  onDay: (day: string) => void;
  onTime: (time: string) => void;
  onUpdate: () => void;
  onRollback: () => void;
  onConfirm: (confirming: boolean) => void;
  /** Pin a tool to the version it is on, or clear the pin. Absent on a panel that only shows the shared schedule. */
  onPin?: (id: string, pin: string | null) => void;
  /** The install's clock. Absent on a panel that only shows the zone it was given. */
  onTimeZone?: (timeZone: string) => void;
  /** One tool's Update choice, day or time. Absent on a panel that only shows the shared schedule. */
  onToolSchedule?: (id: string, patch: ToolSchedulePatch) => void;
  /** One tool's Update now. */
  onUpdateTool?: (id: string) => void;
  /** How many days a new engine CLI release waits. Absent on a panel that only shows it. */
  onMinReleaseAge?: (days: number) => void;
}) {
  const zone = view.schedule.timeZone;
  const last = lastResultSentence(view.last, zone);
  const canRun = view.hostd.reachable && view.applicable === true && !view.running && busy === null;
  const previous = view.previous ? versionChanges(view.inUse ?? {}, view.previous) : '';
  const held = heldBack(view.hold);
  const times = TIMES.includes(view.schedule.time) ? TIMES : [...TIMES, view.schedule.time].sort();
  const zones = ZONES.includes(zone) ? ZONES : [zone, ...ZONES];
  const ownSchedules = toolsDiffer(view.tools);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13.5px] font-semibold text-body">System</h2>
          <p className="mt-1 max-w-lg text-[12.5px] leading-relaxed text-muted">
            {engineUpdatesTitle(view.schedule, view.tools)}. OpenADLC builds a new bot image with the tools that are due — Claude
            Code, Codex, Grok, the GitHub CLI and Node — and swaps it in only once each one that changed, and every
            model the crew uses, has answered from it. Each tool updates on its own day and time, or only when
            somebody presses Update. A pin stays on the installed version; the schedule may say a newer one is out and
            does not take it. Each update is in the audit log.
            {ownSchedules && ' The tools no longer share one schedule, so each is turned off or moved in its own row.'}
          </p>
        </div>
        {!ownSchedules && (
          <button
            type="button"
            role="switch"
            aria-checked={view.schedule.enabled}
            aria-label="Update the engines on a schedule"
            disabled={busy !== null}
            onClick={() => onEnabled(!view.schedule.enabled)}
            className={cn(
              'mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:opacity-50',
              view.schedule.enabled ? 'border-signal/50 bg-signal/30' : 'border-edge-strong bg-well',
            )}
          >
            <span
              className={cn(
                'size-3.5 rounded-full bg-body transition-transform',
                view.schedule.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
              )}
            />
          </button>
        )}
      </div>

      {view.tools ? (
        <ul className="divide-y divide-edge rounded-lg border border-edge">
          {view.tools.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              zone={zone}
              reachable={view.hostd.reachable}
              busy={busy}
              canRun={canRun}
              onPin={onPin}
              onToolSchedule={onToolSchedule}
              onUpdateTool={onUpdateTool}
            />
          ))}
        </ul>
      ) : (
        <table className="text-left text-[12px]">
          <tbody>
            {ENGINES.map(({ pkg, name }) => {
              const inUse = view.inUse?.[pkg] ?? null;
              const newest = view.latest?.[pkg] ?? null;
              return (
                <tr key={pkg}>
                  <td className="py-0.5 pr-4 text-soft">{name}</td>
                  <td className="py-0.5 pr-4 font-mono text-[11.5px] text-body">{inUse ?? (view.hostd.reachable ? 'unknown' : '—')}</td>
                  <td className="py-0.5 pr-4 text-[11.5px] text-dim">
                    {newest && inUse && newest !== inUse ? `npm had ${newest} at the last check` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!view.hostd.reachable && (
        <p className="text-[12px] text-attention">
          hostd is not answering, so the versions in use are not known. Run <code className="font-mono">fleetadlc doctor</code>, or{' '}
          <code className="font-mono">fleetadlc up</code> if it has stopped.
          {view.hostd.detail && <span className="mt-0.5 block text-muted">{view.hostd.detail}</span>}
        </p>
      )}
      {view.hostd.reachable && view.applicable === false && <p className="text-[12px] text-muted">{view.reason}</p>}

      <Row tone={last.tone}>{last.text}</Row>

      <p className="text-[12.5px] text-muted">{nextRunSentence(view)}</p>
      {held.length > 0 && (
        <p className="text-[12px] text-dim">
          Held back after a rollback: {held.join(', ')}. A newer version is taken as usual.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
        {!view.tools && (
          <>
            <label className="flex items-center gap-1.5">
              Day
              <select
                aria-label="Day of the week"
                value={view.schedule.day}
                disabled={busy !== null || !view.schedule.enabled}
                onChange={(event) => onDay(event.target.value)}
                className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12.5px] text-body"
              >
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {capitalised(day)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              Time
              <select
                aria-label="Time of day"
                value={view.schedule.time}
                disabled={busy !== null || !view.schedule.enabled}
                onChange={(event) => onTime(event.target.value)}
                className="rounded-md border border-edge-strong bg-panel px-2 py-1 font-mono text-[12px] text-body"
              >
                {times.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {onTimeZone ? (
          <label className="flex items-center gap-1.5">
            Time zone
            <select
              aria-label="Time zone"
              value={zone}
              disabled={busy !== null}
              onChange={(event) => onTimeZone(event.target.value)}
              className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12.5px] text-body"
            >
              {zones.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-dim">{zone}</span>
        )}
        {view.minReleaseAgeDays !== undefined &&
          (onMinReleaseAge ? (
            <label className="flex items-center gap-1.5">
              Take an engine release once it is
              <select
                aria-label="Minimum release age"
                value={view.minReleaseAgeDays}
                disabled={busy !== null}
                onChange={(event) => onMinReleaseAge(Number(event.target.value))}
                className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12.5px] text-body"
              >
                {[...new Set([...RELEASE_AGES, view.minReleaseAgeDays])]
                  .sort((a, b) => a - b)
                  .map((days) => (
                    <option key={days} value={days}>
                      {releaseAge(days)}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <span className="text-dim">Engine releases are taken once {releaseAge(view.minReleaseAgeDays)}</span>
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={onUpdate} disabled={!canRun}>
          {busy === 'updating' || view.running ? 'Updating…' : view.tools ? 'Update all now' : 'Update now'}
        </Button>
        {!confirming ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onConfirm(true)}
            disabled={!view.previous || !canRun}
            title={view.previous ? undefined : 'There is no previous image until an update has gone in'}
          >
            Roll back to the previous image
          </Button>
        ) : (
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-soft">
            Go back to {previous || 'the previous image'}?
            <Button variant="danger" size="sm" onClick={onRollback} disabled={busy !== null}>
              {busy === 'rolling-back' ? 'Rolling back…' : 'Roll back'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onConfirm(false)} disabled={busy !== null}>
              Keep this one
            </Button>
          </span>
        )}
      </div>

      {error && <p className="text-[12px] text-attention">{error}</p>}

      {view.last && view.last.checks.length > 0 && (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer select-none text-soft">What the last run checked</summary>
          <ul className="mt-2 space-y-1">
            {view.last.checks.map((check, index) => (
              <li key={index} className="flex gap-2">
                <span
                  className={cn(
                    'w-3 shrink-0 text-center',
                    check.state === 'passed' && 'text-signal',
                    check.state === 'failed' && 'text-alarm',
                    check.state === 'skipped' && 'text-dim',
                  )}
                >
                  {MARK[check.state]}
                </span>
                <span className="min-w-0 break-words">
                  {check.kind === 'model' ? `${checkLabel(check)} — ` : ''}
                  {check.detail}
                </span>
              </li>
            ))}
          </ul>
          {view.last.state === 'updated' && (view.last.deferred?.length ?? 0) > 0 && (
            <p className="mt-2 text-dim">
              {view.last.deferred?.join(', ')} {view.last.deferred?.length === 1 ? 'was' : 'were'} working, and{' '}
              {view.last.deferred?.length === 1 ? 'takes' : 'take'} the new image at the next task.
            </p>
          )}
        </details>
      )}
    </div>
  );
}

/**
 * One tool: the version in use, its Update choice with its own day and time,
 * its own Update now, its pin, and what the last run about it did. Each tool
 * keeps its own schedule: Codex can wait for a person while Claude Code
 * takes Tuesday night.
 */
function ToolRow({
  tool,
  zone,
  reachable,
  busy,
  canRun,
  onPin,
  onToolSchedule,
  onUpdateTool,
}: {
  tool: SystemToolRow;
  zone: string;
  reachable: boolean;
  busy: Busy;
  canRun: boolean;
  onPin?: (id: string, pin: string | null) => void;
  onToolSchedule?: (id: string, patch: ToolSchedulePatch) => void;
  onUpdateTool?: (id: string) => void;
}) {
  const inUse = tool.inUse;
  const newest = tool.latest;
  const scheduled = tool.schedule.mode === 'schedule';
  const times = TIMES.includes(tool.schedule.time) ? TIMES : [...TIMES, tool.schedule.time].sort();
  const last = toolLastSentence(tool.last, zone);
  const select = 'rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12px] text-body disabled:opacity-50';
  return (
    <li className="space-y-1.5 px-3.5 py-2.5 text-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-soft">{tool.name}</span>
        <span className="font-mono text-[11.5px] text-body">{inUse ?? (reachable ? 'unknown' : '—')}</span>
        <span className="text-[11.5px] text-dim">
          {newest && inUse && newest !== inUse
            ? tool.source && tool.source !== 'npm'
              ? `the last check had ${newest}`
              : `npm had ${newest} at the last check`
            : ''}
          {tool.pin ? `${newest && inUse && newest !== inUse ? '; ' : ''}pinned at ${tool.pin}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {onPin && inUse ? (
            <button
              type="button"
              disabled={busy !== null}
              aria-label={tool.pin ? `Unpin ${tool.name}` : `Pin ${tool.name} at ${inUse}`}
              onClick={() => onPin(tool.id, tool.pin ? null : inUse)}
              className="text-link hover:underline disabled:opacity-50"
            >
              {tool.pin ? 'Unpin' : 'Pin'}
            </button>
          ) : null}
          {onUpdateTool ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Update ${tool.name} now`}
              disabled={!canRun}
              onClick={() => onUpdateTool(tool.id)}
            >
              Update now
            </Button>
          ) : null}
        </span>
      </div>
      {onToolSchedule ? (
        <div className="flex flex-wrap items-center gap-2 text-muted">
          <select
            aria-label={`When ${tool.name} updates`}
            value={tool.schedule.mode}
            disabled={busy !== null}
            onChange={(event) => onToolSchedule(tool.id, { mode: event.target.value as 'schedule' | 'manual' })}
            className={select}
          >
            <option value="schedule">Automatically on a schedule</option>
            <option value="manual">Only when I press Update</option>
          </select>
          {scheduled && (
            <>
              <select
                aria-label={`${tool.name}’s day`}
                value={tool.schedule.day}
                disabled={busy !== null}
                onChange={(event) => onToolSchedule(tool.id, { day: event.target.value })}
                className={select}
              >
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {capitalised(day)}
                  </option>
                ))}
              </select>
              <select
                aria-label={`${tool.name}’s time`}
                value={tool.schedule.time}
                disabled={busy !== null}
                onChange={(event) => onToolSchedule(tool.id, { time: event.target.value })}
                className={cn(select, 'font-mono')}
              >
                {times.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
              {tool.nextRun ? <span className="text-dim">next {when(tool.nextRun, zone)}</span> : null}
            </>
          )}
        </div>
      ) : null}
      <p
        className={cn(
          'text-[11.5px] leading-relaxed',
          last.tone === 'good' && 'text-signal',
          last.tone === 'warn' && 'text-attention',
          last.tone === 'plain' && 'text-dim',
        )}
      >
        {last.text}
      </p>
    </li>
  );
}

async function bridgeError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON: say what came back.
  }
  return text.slice(0, 300) || `the bridge answered ${response.status}`;
}

export function EngineUpdates({ initial = null }: { initial?: EngineUpdatesView | null }) {
  const [view, setView] = useState<EngineUpdatesView | null>(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Why the last read failed, apart from what an action was refused: one
   * failed poll while the bridge restarted stayed in red for the rest of the
   * run. A read that works clears it, and leaves a refusal said.
   */
  const [pollError, setPollError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/engine-updates', { cache: 'no-store' });
      if (!response.ok) throw new Error(await bridgeError(response));
      setView((await response.json()) as EngineUpdatesView);
      setPollError(null);
    } catch (cause) {
      setPollError(cause instanceof Error ? cause.message : 'could not read the engine updates');
    }
  }, []);

  // The page is read again every fifteen seconds; what it read is taken while
  // nothing here is in flight, so a run another admin started shows.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen && busy === null) {
    setSeen(initial);
    if (initial) setView(initial);
  }

  useEffect(() => {
    // The page read it already for the first paint, so it is drawn at its full
    // height rather than moving everything below it when it arrives.
    if (initial) return;
    void load();
  }, [load]);

  // A link to /settings#engine-updates — what "needs you" sends a failed
  // update to — is followed before this has loaded, while the page is too
  // short to scroll it into place. Once it has its full height, it goes there.
  const loaded = view !== null;
  useEffect(() => {
    if (loaded && (window.location.hash === '#engine-updates' || window.location.hash === '#system')) {
      document.getElementById('system')?.scrollIntoView({ block: 'start' });
    }
  }, [loaded]);

  // Followed while a run is going or owed, so the sentence changes when it ends.
  const watching = Boolean(view?.running) || Boolean(view?.due);
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [watching, load]);

  async function act(kind: Exclude<Busy, null>, path: string, init: RequestInit): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
      if (!response.ok) throw new Error(await bridgeError(response));
      setView((await response.json()) as EngineUpdatesView);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the bridge refused');
      // "An update is already running" is usually a run this page had not
      // seen yet. Reading the view again shows it, and disables every Update
      // now until it ends.
      void load();
    } finally {
      setBusy(null);
    }
  }

  const schedule = (patch: Record<string, unknown>) =>
    void act('saving', '/api/engine-updates', { method: 'PATCH', body: JSON.stringify(patch) });

  return (
    <section id="system" className="scroll-mt-7 rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
      {/* A failed update's card still links to #engine-updates. */}
      <div id="engine-updates" className="scroll-mt-7" />
      {view ? (
        <EngineUpdatesPanel
          view={view}
          busy={busy}
          error={error ?? pollError}
          confirming={confirming}
          onEnabled={(enabled) => schedule({ enabled })}
          onDay={(day) => schedule({ day })}
          onTime={(time) => schedule({ time })}
          onTimeZone={(timeZone) => schedule({ timeZone })}
          onPin={(id, pin) => schedule({ tools: [{ id, pin }] })}
          onToolSchedule={(id, patch) => schedule({ tools: [{ id, ...patch }] })}
          onMinReleaseAge={(minReleaseAgeDays) => schedule({ minReleaseAgeDays })}
          onUpdate={() => void act('updating', '/api/engine-updates', { method: 'POST', body: '{}' })}
          onUpdateTool={(id) => void act('updating', '/api/engine-updates', { method: 'POST', body: JSON.stringify({ tools: [id] }) })}
          onRollback={() => void act('rolling-back', '/api/engine-updates/rollback', { method: 'POST', body: '{}' })}
          onConfirm={setConfirming}
        />
      ) : (
        <p className="text-[12.5px] text-muted">{error ?? pollError ?? 'asking which engines the crew runs…'}</p>
      )}
    </section>
  );
}
