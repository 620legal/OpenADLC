'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { when } from '@/components/engine-updates';

/**
 * OpenADLC itself, as one row of Settings → System beside the tools it runs.
 *
 * It takes only the releases a person makes by tagging a version, each
 * checked against its attestation before anything of it is unpacked
 * (docs/self-hosting.md#updating-openadlc). The row says which commit runs
 * now, which release an update would take, how the last run ended, and when
 * the next one is, with the same Schedule or Manual choice and Update now as
 * an engine's row. While a run waits for the tasks to end, it says which.
 *
 * On a Google Cloud install the row is the same, and a run rolls the
 * release's images instead of restarting a checkout: it checks them, waits
 * for the tasks, then moves the console, the host and the bridge in that
 * order, and takes only the next release after the one in use. A release's
 * images are taken by the digests the release recorded, and a tag of one
 * pushed again since, naming another image, is said on the row.
 *
 * Self-contained, as `EngineUpdates` is: it reads and writes its own state
 * through `/api/self-update`.
 */

export interface LiveTask {
  id: string;
  bot: string;
  subjectRef: string;
  kind: string;
}

/** Where a cloud install's roll is: the images checked, then each part in turn. */
export type CloudStep = 'images' | 'console' | 'host' | 'bridge';

export interface SelfUpdateRunView {
  phase: 'preparing' | 'waiting' | 'restarting';
  /** On a cloud install, the part being rolled. */
  cloud?: { step: CloudStep; rolled: string[] };
  tag: string;
  from: string;
  to: string;
  trigger: 'schedule' | 'console';
  actor: string;
  startedAt: string;
  pid: number | null;
  waitingFor: LiveTask[];
}

export interface SelfUpdateLast {
  state: 'updated' | 'current' | 'skipped' | 'failed';
  trigger: 'schedule' | 'console';
  actor: string;
  from: string | null;
  to: string | null;
  tag: string | null;
  reason: string;
  step?: string;
  restoredTo?: string;
  startedAt: string;
  finishedAt: string;
}

export interface SelfUpdateView {
  /** A checkout, or a cloud install's images; a bridge from before says neither, and is a checkout. */
  backend?: 'checkout' | 'cloud';
  repository: string | null;
  inUse: { sha: string; date: string | null; tag: string | null } | null;
  /** `newest`, on a cloud install, when a later release than the one it takes is out. */
  candidate: { tag: string; sha: string | null; publishedAt: string | null; newest?: string } | null;
  candidateReason: string;
  checkedAt: string | null;
  schedule: { mode: 'schedule' | 'manual'; day: string; time: string };
  timeZone: string;
  nextRun: string | null;
  due: boolean;
  applicable: boolean;
  reason: string;
  running: SelfUpdateRunView | null;
  last: SelfUpdateLast | null;
  attention: { title: string; detail: string } | null;
  /**
   * On a cloud install, each tag of the release in use or the one it would
   * take that names another image now than the release recorded, in words
   * naming both digests. The recorded one is what runs and what is taken; a
   * bridge from before says none.
   */
  movedTags?: string[];
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const TIMES = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);

function capitalised(word: string): string {
  return word ? `${word[0]?.toUpperCase()}${word.slice(1)}` : word;
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

function clipped(text: string, limit = 220): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** "abc1234 (v0.1.0), Oct 18, 09:12", or a dash before the bridge has read it. */
export function inUseText(view: SelfUpdateView): string {
  if (!view.inUse) return '—';
  const date = view.inUse.date ? `, ${when(view.inUse.date, view.timeZone)}` : '';
  return `${short(view.inUse.sha)}${view.inUse.tag ? ` (${view.inUse.tag})` : ''}${date}`;
}

/**
 * "would take v0.2.0, published Oct 18, 12:00 (looked Oct 21, 10:00)", or why
 * there is nothing to take, with when that was looked for; while a run goes,
 * "taking v0.2.0". Without the look's time a stored "the newest release" read
 * as a fact about now, minutes after a newer one was published.
 */
export function wouldTakeText(view: SelfUpdateView): string {
  // The run's own tag, which may be an older release than the candidate when a newer one failed its check.
  if (view.running) return `taking ${view.running.tag}`;
  const looked = view.checkedAt ? ` (looked ${when(view.checkedAt, view.timeZone)})` : '';
  if (!view.candidate) return `${view.candidateReason}${looked}`;
  const published = view.candidate.publishedAt ? `, published ${when(view.candidate.publishedAt, view.timeZone)}` : '';
  // A cloud install never skips one: each release's bridge and host migrate as they start.
  const next = view.candidate.newest ? `: it takes the next release, not ${view.candidate.newest}, one at a time` : '';
  return `would take ${view.candidate.tag}${published}${next}${looked}`;
}

const CLOUD_STEPS: { step: CloudStep | 'waiting'; name: string }[] = [
  { step: 'images', name: 'checking images' },
  { step: 'waiting', name: 'waiting' },
  { step: 'console', name: 'console' },
  { step: 'host', name: 'host' },
  { step: 'bridge', name: 'bridge' },
];

/** A cloud run's steps in order, each done, the current one, or still to come. */
export function cloudSteps(run: SelfUpdateRunView): { name: string; state: 'done' | 'current' | 'next' }[] {
  const at = run.phase === 'preparing' ? 'images' : run.phase === 'waiting' ? 'waiting' : (run.cloud?.step ?? 'console');
  const index = CLOUD_STEPS.findIndex((one) => one.step === at);
  return CLOUD_STEPS.map((one, i) => ({ name: one.name, state: i < index ? 'done' : i === index ? 'current' : 'next' }));
}

/** "builder on openadlc#12, reviewer on openadlc#14 and 1 more". */
function tasksInWords(tasks: readonly LiveTask[]): string {
  const named = tasks.slice(0, 3).map((task) => `${task.bot} on ${task.subjectRef}`);
  return tasks.length > 3 ? `${named.join(', ')} and ${tasks.length - 3} more` : named.join(', ');
}

/** The run in flight, or how the last one ended, in one sentence, and how loudly. */
export function selfUpdateSentence(view: SelfUpdateView): { text: string; tone: 'good' | 'warn' | 'plain' } {
  const run = view.running;
  if (run && view.backend === 'cloud') {
    const waiting =
      run.waitingFor.length > 0
        ? `rolls once ${run.waitingFor.length === 1 ? 'this task ends' : `these ${run.waitingFor.length} tasks end`}: ${tasksInWords(run.waitingFor)}`
        : 'rolls in a minute';
    switch (run.phase) {
      case 'preparing':
        return { text: `Checking ${run.tag}'s images: each by its digest at the registry and its attestation checked, while the install goes on as it is.`, tone: 'plain' };
      case 'waiting':
        return { text: `${run.tag}'s images check out, and it ${waiting}. No new task starts meanwhile.`, tone: 'plain' };
      case 'restarting':
        switch (run.cloud?.step) {
          case 'host':
            return { text: `Rolling ${run.tag}: the console is on it, and hostd is restarting onto it; the bridge is last.`, tone: 'plain' };
          case 'bridge':
            return { text: `Rolling ${run.tag}: the console and the host are on it, and the bridge is being replaced; the row is back once the new one serves.`, tone: 'plain' };
          default:
            return { text: `Rolling ${run.tag}: the console first, then the host, then the bridge.`, tone: 'plain' };
        }
    }
  }
  if (run) {
    switch (run.phase) {
      case 'preparing':
        return { text: `Preparing ${run.tag}: downloading it and checking its attestation beside the install, which goes on as it is.`, tone: 'plain' };
      case 'waiting':
        return {
          text:
            run.waitingFor.length > 0
              ? `${run.tag} is ready, and restarts the install once ${run.waitingFor.length === 1 ? 'this task ends' : `these ${run.waitingFor.length} tasks end`}: ${tasksInWords(run.waitingFor)}. No new task starts meanwhile.`
              : `${run.tag} is ready, and restarts the install in a minute. No new task starts meanwhile.`,
          tone: 'plain',
        };
      case 'restarting':
        return { text: `Restarting onto ${run.tag} now; the console is back once the services are.`, tone: 'plain' };
    }
  }
  const last = view.last;
  if (!last) return { text: 'Not updated here yet.', tone: 'plain' };
  const at = when(last.finishedAt, view.timeZone);
  switch (last.state) {
    case 'updated':
      return { text: `Updated ${at}: ${short(last.from)} → ${last.tag ?? short(last.to)}.`, tone: 'good' };
    case 'current':
      return { text: `Checked ${at}: ${clipped(last.reason)}.`, tone: 'plain' };
    case 'skipped':
      return { text: `Not run ${at}: ${clipped(last.reason)}.`, tone: 'plain' };
    case 'failed':
      return { text: `Failed ${at}${last.step ? ` at ${last.step}` : ''}: ${clipped(last.reason, 400)}.`, tone: 'warn' };
  }
}

/**
 * What the schedule means, said plainly: on a schedule, a version tag is a
 * deploy to this install within the week, with no one pressing anything here.
 */
export function deploySentence(view: SelfUpdateView): string {
  const where = view.repository ? ` on ${view.repository}` : '';
  if (view.backend === 'cloud') {
    if (view.schedule.mode === 'manual') return `A release${where} is rolled out here, the next after the one in use, only when somebody presses Update now.`;
    return `Every release tagged${where} is rolled out here, one at a time, at the next scheduled run, without anyone pressing anything.`;
  }
  if (view.schedule.mode === 'manual') return `A release${where} is taken here only when somebody presses Update now.`;
  return `Every release tagged${where} is deployed here at the next scheduled run, without anyone pressing anything.`;
}

/** On a cloud install, what a release does not carry: the bots' image, which holds Claude Code. */
export const CLOUD_BOT_IMAGE =
  "The bots' image is not part of a release: it holds Claude Code, which a release may not redistribute, so it is built on the host and kept current by the engine updates below.";

/** Why Update now cannot be pressed, or null when it can. */
export function updateNowRefusal(view: SelfUpdateView): string | null {
  if (view.running) return `an update to ${view.running.tag} is ${view.running.phase}, started by ${view.running.actor}`;
  if (!view.applicable) return view.reason;
  return null;
}

export type SelfUpdateBusy = 'updating' | 'saving' | 'checking' | null;

/** The row, drawn from a view; `SelfUpdate` below reads the view and handles the clicks. */
export function SelfUpdateRow({
  view,
  busy,
  error,
  onSchedule,
  onUpdate,
  onCheck,
}: {
  view: SelfUpdateView;
  busy: SelfUpdateBusy;
  error: string | null;
  onSchedule?: (patch: Partial<SelfUpdateView['schedule']>) => void;
  onUpdate?: () => void;
  onCheck?: () => void;
}) {
  const sentence = selfUpdateSentence(view);
  const refusal = updateNowRefusal(view);
  const scheduled = view.schedule.mode === 'schedule';
  const times = TIMES.includes(view.schedule.time) ? TIMES : [...TIMES, view.schedule.time].sort();
  const select = 'rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12px] text-body disabled:opacity-50';
  return (
    <li id="self-update" className="space-y-1.5 px-3.5 py-2.5 text-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-soft">OpenADLC</span>
        <span className="font-mono text-[11.5px] text-body">{inUseText(view)}</span>
        <span className="text-[11.5px] text-dim">{wouldTakeText(view)}</span>
        {onCheck ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label="Check again for an OpenADLC release"
            disabled={busy !== null || view.running !== null}
            onClick={onCheck}
          >
            {busy === 'checking' ? 'Checking…' : 'Check again'}
          </Button>
        ) : null}
        <span className="ml-auto flex items-center gap-3">
          {onUpdate ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label="Update OpenADLC now"
              title={refusal ?? undefined}
              disabled={busy !== null || refusal !== null}
              onClick={onUpdate}
            >
              {view.running ? 'Updating…' : 'Update now'}
            </Button>
          ) : null}
        </span>
      </div>
      {onSchedule ? (
        <div className="flex flex-wrap items-center gap-2 text-muted">
          <select
            aria-label="When OpenADLC updates"
            value={view.schedule.mode}
            disabled={busy !== null}
            onChange={(event) => onSchedule({ mode: event.target.value as 'schedule' | 'manual' })}
            className={select}
          >
            <option value="schedule">Automatically on a schedule</option>
            <option value="manual">Only when I press Update</option>
          </select>
          {scheduled && (
            <>
              <select
                aria-label="OpenADLC’s day"
                value={view.schedule.day}
                disabled={busy !== null}
                onChange={(event) => onSchedule({ day: event.target.value })}
                className={select}
              >
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {capitalised(day)}
                  </option>
                ))}
              </select>
              <select
                aria-label="OpenADLC’s time"
                value={view.schedule.time}
                disabled={busy !== null}
                onChange={(event) => onSchedule({ time: event.target.value })}
                className={cn(select, 'font-mono')}
              >
                {times.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
              {view.nextRun ? <span className="text-dim">next {when(view.nextRun, view.timeZone)}</span> : null}
            </>
          )}
        </div>
      ) : null}
      <p className="text-[11.5px] leading-relaxed text-muted">{deploySentence(view)}</p>
      {view.backend === 'cloud' && <p className="text-[11.5px] leading-relaxed text-muted">{CLOUD_BOT_IMAGE}</p>}
      {!view.applicable && !view.running && <p className="text-[11.5px] leading-relaxed text-muted">{view.reason}</p>}
      {(view.movedTags ?? []).map((words) => (
        <p key={words} className="text-[11.5px] leading-relaxed text-attention">
          {words}
        </p>
      ))}
      {view.backend === 'cloud' && view.running && (
        <ol aria-label="Where the roll is" className="flex flex-wrap items-center gap-x-1.5 text-[11.5px]">
          {cloudSteps(view.running).map((one, index) => (
            <li
              key={one.name}
              aria-current={one.state === 'current' ? 'step' : undefined}
              className={cn(one.state === 'current' ? 'font-medium text-soft' : one.state === 'done' ? 'text-dim' : 'text-muted')}
            >
              {index > 0 ? '· ' : ''}
              {one.state === 'done' ? `${one.name} ✓` : one.name}
            </li>
          ))}
        </ol>
      )}
      <p
        className={cn(
          'text-[11.5px] leading-relaxed',
          sentence.tone === 'good' && 'text-signal',
          sentence.tone === 'warn' && 'text-attention',
          sentence.tone === 'plain' && 'text-dim',
        )}
      >
        {sentence.text}
      </p>
      {error && <p className="text-[11.5px] text-attention">{error}</p>}
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

/** The OpenADLC row, reading and writing through `/api/self-update`. */
export function SelfUpdate({ initial = null }: { initial?: SelfUpdateView | null }) {
  const [view, setView] = useState<SelfUpdateView | null>(initial);
  const [busy, setBusy] = useState<SelfUpdateBusy>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether a view was ever read: a restart takes the bridge away for a while, and the row keeps what it had. */
  const read = useRef(initial !== null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/self-update', { cache: 'no-store' });
      if (!response.ok) throw new Error(await bridgeError(response));
      setView((await response.json()) as SelfUpdateView);
      read.current = true;
    } catch (cause) {
      if (!read.current) setError(cause instanceof Error ? cause.message : 'could not read OpenADLC’s update');
    }
  }, []);

  // The page read it already for the first paint when the bridge answered.
  const first = useRef(initial);
  useEffect(() => {
    if (first.current) return;
    void load();
  }, [load]);

  // Followed while a run is in flight, so the row changes as it moves on.
  const watching = Boolean(view?.running) || Boolean(view?.due);
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [watching, load]);

  async function act(kind: Exclude<SelfUpdateBusy, null>, init: RequestInit, path = '/api/self-update'): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
      if (!response.ok) throw new Error(await bridgeError(response));
      setView((await response.json()) as SelfUpdateView);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the bridge refused');
      void load();
    } finally {
      setBusy(null);
    }
  }

  if (!view) {
    return <li className="px-3.5 py-2.5 text-[12px] text-muted">{error ?? 'asking which OpenADLC runs here…'}</li>;
  }
  return (
    <SelfUpdateRow
      view={view}
      busy={busy}
      error={error}
      onSchedule={(patch) => void act('saving', { method: 'PATCH', body: JSON.stringify(patch) })}
      onUpdate={() => void act('updating', { method: 'POST', body: '{}' })}
      onCheck={() => void act('checking', { method: 'POST', body: '{}' }, '/api/self-update/check')}
    />
  );
}
