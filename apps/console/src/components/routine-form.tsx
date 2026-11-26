'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { RoutineCadence, RoutineTemplateView, RoutineView } from '@/lib/api';

/**
 * Creating or editing a routine (#369, docs/adr/0090): a repository, the
 * request it files, a kind, and when — daily, weekly on a day, or monthly on
 * a day — at a time in a time zone. A new one starts from a template, Blank
 * included, and everything a template fills stays editable. Saving makes the
 * person saving it the routine's owner, whose name it files in.
 *
 * Drawn only for someone the bridge says may change routines; the bridge
 * checks again on every save.
 */

export const KINDS = ['feature', 'defect', 'chore', 'question'] as const;
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** "Every Monday at 09:00", as the list and the form say a cadence. */
export function cadenceWords(cadence: RoutineCadence, time: string): string {
  if (cadence.every === 'day') return `Every day at ${time}`;
  if (cadence.every === 'week') return `Every ${WEEKDAYS[cadence.weekday - 1] ?? 'week'} at ${time}`;
  const day = cadence.day >= 29 ? `${cadence.day} (or the month’s last day)` : String(cadence.day);
  return `Monthly on day ${day} at ${time}`;
}

/** What the form holds while it is edited. */
export interface RoutineDraft {
  repo: string;
  text: string;
  details: string;
  kind: string;
  every: RoutineCadence['every'];
  weekday: number;
  day: number;
  time: string;
  timeZone: string;
}

/** The form's fields from a template, keeping the repository and zone already chosen. */
export function draftFromTemplate(template: RoutineTemplateView, keep: Pick<RoutineDraft, 'repo' | 'timeZone'>): RoutineDraft {
  return {
    ...keep,
    text: template.text,
    details: template.details ?? '',
    kind: template.kind,
    every: template.cadence.every,
    weekday: template.cadence.every === 'week' ? template.cadence.weekday : 1,
    day: template.cadence.every === 'month' ? template.cadence.day : 1,
    time: template.time,
  };
}

export function draftFromRoutine(routine: RoutineView): RoutineDraft {
  return {
    repo: routine.repo,
    text: routine.text,
    details: routine.details ?? '',
    kind: routine.kind,
    every: routine.cadence.every,
    weekday: routine.cadence.every === 'week' ? routine.cadence.weekday : 1,
    day: routine.cadence.every === 'month' ? routine.cadence.day : 1,
    time: routine.time,
    timeZone: routine.timeZone,
  };
}

/** The body `POST /v1/routines` and `PATCH /v1/routines/:id` take. */
export function bodyOf(draft: RoutineDraft): Record<string, unknown> {
  const cadence: RoutineCadence =
    draft.every === 'week' ? { every: 'week', weekday: draft.weekday } : draft.every === 'month' ? { every: 'month', day: draft.day } : { every: 'day' };
  return { repo: draft.repo, text: draft.text, details: draft.details, kind: draft.kind, cadence, time: draft.time, timeZone: draft.timeZone };
}

/** The browser's own zone, which a new routine starts in; UTC where it has none. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

const FIELD = 'mt-1 w-full rounded-md border border-edge-strong bg-surface px-2 py-1.5 text-[12.5px] text-body';
const LABEL = 'text-[11px] font-medium text-soft';

export function RoutineForm({
  repos,
  templates,
  routine,
  timeZone,
  onSaved,
  onCancel,
  save = saveRoutine,
}: {
  repos: readonly string[];
  templates: readonly RoutineTemplateView[];
  /** The routine edited; absent for a new one, which starts from the template picker. */
  routine?: RoutineView;
  /** The zone a new routine starts in; the browser's when not given. */
  timeZone?: string;
  onSaved: () => void;
  onCancel: () => void;
  save?: (draft: RoutineDraft, id: string | null) => Promise<string | null>;
}) {
  const start = (): RoutineDraft => {
    if (routine) return draftFromRoutine(routine);
    const keep = { repo: repos[0] ?? '', timeZone: timeZone ?? browserTimeZone() };
    const blank = templates.find((template) => template.id === 'blank') ?? templates[0];
    return blank
      ? draftFromTemplate(blank, keep)
      : { ...keep, text: '', details: '', kind: 'chore', every: 'week', weekday: 1, day: 1, time: '09:00' };
  };
  const [draft, setDraft] = useState<RoutineDraft>(start);
  const [picked, setPicked] = useState<string | null>(routine ? null : 'blank');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (patch: Partial<RoutineDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const zoneList = zones();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const refused = await save(draft, routine?.id ?? null);
      if (refused) setError(refused);
      else onSaved();
    });
  };

  return (
    <form
      data-routine-form
      className="flex flex-col gap-3 rounded-md border border-edge bg-panel p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-[12.5px] font-semibold text-body">{routine ? 'Edit routine' : 'New routine'}</p>
      {!routine && (
        <div data-routine-templates className="flex flex-wrap gap-1.5" role="group" aria-label="Start from a template">
          {templates.map((template) => (
            <Button
              key={template.id}
              type="button"
              size="sm"
              variant={picked === template.id ? 'secondary' : 'ghost'}
              aria-pressed={picked === template.id}
              data-template={template.id}
              onClick={() => {
                setPicked(template.id);
                setDraft((current) => draftFromTemplate(template, { repo: current.repo, timeZone: current.timeZone }));
              }}
            >
              {template.label}
            </Button>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Repository</span>
          <select name="repo" value={draft.repo} onChange={(event) => set({ repo: event.target.value })} className={FIELD}>
            {repos.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Kind</span>
          <select name="kind" value={draft.kind} onChange={(event) => set({ kind: event.target.value })} className={FIELD}>
            {KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className={LABEL}>What should the crew do each time?</span>
        <textarea name="text" value={draft.text} onChange={(event) => set({ text: event.target.value })} rows={2} className={`${FIELD} resize-none`} />
      </label>
      <label className="block">
        <span className={LABEL}>Details</span>
        <textarea name="details" value={draft.details} onChange={(event) => set({ details: event.target.value })} rows={4} className={`${FIELD} resize-y`} />
      </label>

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className={LABEL}>Repeats</span>
          <select name="every" value={draft.every} onChange={(event) => set({ every: event.target.value as RoutineDraft['every'] })} className={FIELD}>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </label>
        {draft.every === 'week' && (
          <label className="block">
            <span className={LABEL}>On</span>
            <select name="weekday" value={draft.weekday} onChange={(event) => set({ weekday: Number(event.target.value) })} className={FIELD}>
              {WEEKDAYS.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {draft.every === 'month' && (
          <label className="block">
            <span className={LABEL}>On day</span>
            <select name="day" value={draft.day} onChange={(event) => set({ day: Number(event.target.value) })} className={FIELD}>
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className={LABEL}>At</span>
          <input name="time" type="time" value={draft.time} onChange={(event) => set({ time: event.target.value })} className={FIELD} />
        </label>
        <label className="block">
          <span className={LABEL}>Time zone</span>
          <input name="timeZone" list="routine-zones" value={draft.timeZone} onChange={(event) => set({ timeZone: event.target.value })} className={FIELD} />
          <datalist id="routine-zones">
            {zoneList.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
      </div>
      {draft.every === 'month' && draft.day >= 29 && <p className="text-[11px] text-muted">A month without day {draft.day} runs it on its last day.</p>}

      <p className="text-[11px] text-muted">
        Each time it runs, it files this as a console request in your name, as if you had sent it: intake, gates and caps apply as usual. It skips a run while its last request is still open,
        while work is paused, while the monthly cap is reached, or once its owner no longer has Approves on.
      </p>
      {error && (
        <p data-routine-error role="alert" className="text-[12px] text-alarm">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={pending || !draft.text.trim() || !draft.repo}>
          {pending ? 'Saving…' : routine ? 'Save' : 'Create routine'}
        </Button>
      </div>
    </form>
  );
}

/** Saves through the console's proxy; null when saved, or the bridge's words for why not. */
export async function saveRoutine(draft: RoutineDraft, id: string | null): Promise<string | null> {
  try {
    const response = await fetch(id ? `/api/routines/${encodeURIComponent(id)}` : '/api/routines', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyOf(draft)),
    });
    if (response.ok) return null;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `The routine could not be saved (${response.status}).`;
  } catch {
    return 'The console could not reach the bridge to save the routine. Try again.';
  }
}
