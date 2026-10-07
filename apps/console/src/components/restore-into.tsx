'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { setsUpLines } from '@/components/restore-step';
import { DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  GROUP_TITLES,
  STATE_WORDS,
  base64Of,
  isAccountChoice,
  jobLine,
  looksSealed,
  madeOn,
  outcomeLine,
  takenCount,
  takenIn,
  whenWords,
  type CompareItem,
  type Comparison,
  type IntoPreview,
  type RestoreJob,
  type UndoView,
  VERDICT_WORDS,
} from '@/lib/backup';
import { cn } from '@/lib/cn';

/**
 * Settings → Backup's Restore: putting a backup back into an install that is
 * already set up. The card opens this in a modal. The running job and an undo
 * that is still possible stay on the section, because closing the modal
 * unmounts only the form.
 *
 * The bridge opens the file and lays it beside this install thing by thing —
 * new here (ticked), the same (nothing to do), different (what differs, and
 * this install's kept unless the backup's is taken), only here (kept; a
 * restore never removes anything) — with every sign-in in it checked first.
 * One that is expired or refused cannot be ticked; one that can only be
 * checked by using it waits unticked, saying that taking it takes it over.
 *
 * Restore then waits for the bots it changes to finish their work, pauses the
 * dispatcher, backs this install up and writes what was chosen; afterwards it
 * says what came back, and Undo puts the install back for a day.
 */

export type IntoPhase =
  | { at: 'choosing' }
  | { at: 'reading' }
  /**
   * The archive the preview was made from travels with it, and is what
   * Restore sends: the file chosen since may be another one.
   */
  | { at: 'read'; preview: IntoPreview; archive: string; sealed: boolean }
  | { at: 'running'; job: RestoreJob; preview: IntoPreview | null };

const BADGE: Record<CompareItem['state'], string> = {
  new: 'bg-signal/10 text-signal',
  same: 'bg-surface text-dim',
  different: 'bg-attention/10 text-attention',
  'only-here': 'bg-surface text-muted',
};

function Lines({ title, lines, tone }: { title: string; lines: string[]; tone?: 'attention' }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className={cn('text-[11px] uppercase tracking-wider', tone === 'attention' ? 'text-attention' : 'text-dim')}>{title}</p>
      <ul className="flex flex-col gap-0.5 text-[12.5px] leading-snug text-soft">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** Why an item has no tick of its own, when it has none. */
function whyFixed(item: CompareItem, comparison: Comparison, choices: Record<string, boolean>): string | null {
  if (item.state === 'same') return 'nothing to do';
  if (item.state === 'only-here') return 'kept — a restore never removes anything';
  if (item.dependsOn && !takenIn(comparison, choices, item.dependsOn)) {
    const parent = comparison.groups.flatMap((group) => group.items).find((one) => one.key === item.dependsOn);
    return `goes with ${parent ? parent.label.charAt(0).toLowerCase() + parent.label.slice(1) : 'what it belongs to'}, which is not taken`;
  }
  return null;
}

function Item({
  item,
  comparison,
  choices,
  onChoice,
  disabled,
}: {
  item: CompareItem;
  comparison: Comparison;
  choices: Record<string, boolean>;
  onChoice: (key: string, take: boolean) => void;
  disabled: boolean;
}) {
  const fixed = whyFixed(item, comparison, choices);
  const blocked = item.verdict?.state === 'blocked';
  const ticked = takenIn(comparison, choices, item.key);
  let control: ReactNode = null;
  if (isAccountChoice(item) && item.accounts) {
    control = (
      <span className="flex flex-col gap-1 pl-[26px] text-[12.5px] text-body" role="radiogroup" aria-label={`${item.label}: which account`}>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={item.key}
            checked={!ticked}
            disabled={disabled}
            onChange={() => onChoice(item.key, false)}
            className="accent-link"
          />
          this install’s — {item.accounts.here}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={item.key}
            checked={ticked}
            disabled={disabled}
            onChange={() => onChoice(item.key, true)}
            className="accent-link"
          />
          the backup’s — {item.accounts.backup}
        </label>
      </span>
    );
  }
  const hasBox = !isAccountChoice(item) && (item.state === 'new' || item.state === 'different');
  return (
    <li className="flex flex-col gap-1">
      <label className={cn('flex items-start gap-2.5', hasBox && item.takeable && !fixed ? 'cursor-pointer' : '')}>
        {hasBox ? (
          <input
            type="checkbox"
            aria-label={`${item.label}: ${item.state === 'new' ? 'add it' : 'take the backup’s'}`}
            checked={ticked}
            disabled={disabled || !item.takeable || fixed !== null}
            onChange={(event) => onChoice(item.key, event.target.checked)}
            className="mt-[3px] size-4 shrink-0 accent-link"
          />
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] text-body">{item.label}</span>
            <span className={cn('rounded px-1.5 py-px text-[10.5px] uppercase tracking-wider', BADGE[item.state])}>
              {STATE_WORDS[item.state]}
            </span>
          </span>
          {item.differences.map((line) => (
            <span key={line} className="text-[12px] leading-snug text-muted">
              {line}
            </span>
          ))}
          {item.note && (
            <span className={cn('text-[12px] leading-snug', blocked ? 'text-alarm' : item.rotates ? 'text-attention' : 'text-muted')}>
              {blocked ? `${VERDICT_WORDS.blocked} — ${item.note}` : item.note}
            </span>
          )}
          {fixed && item.state !== 'same' && item.state !== 'only-here' && (
            <span className="text-[12px] leading-snug text-muted">{fixed.charAt(0).toUpperCase() + fixed.slice(1)}.</span>
          )}
        </span>
      </label>
      {control}
    </li>
  );
}

/** The comparison, group by group, with a choice beside each thing that has one. */
function ComparisonList({
  comparison,
  choices,
  onChoice,
  disabled = false,
}: {
  comparison: Comparison;
  choices: Record<string, boolean>;
  onChoice: (key: string, take: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col">
      {comparison.groups.map((group) => (
        <section key={group.group} aria-label={GROUP_TITLES[group.group]} className="flex flex-col gap-2 border-t border-well py-3">
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-dim">{GROUP_TITLES[group.group]}</h4>
          <ul className="flex flex-col gap-2.5">
            {group.items.map((item) => (
              <Item key={item.key} item={item} comparison={comparison} choices={choices} onChoice={onChoice} disabled={disabled} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** What an undo that is still possible did, and until when it can be taken back. */
function undoSentence(undo: UndoView): string {
  return `A backup made ${madeOn(undo.backupMadeAt)} was restored here at ${whenWords(undo.restoredAt)}. Undo puts back what it changed, until ${whenWords(undo.until)}.`;
}

function UndoLine({ undo, onUndo, busy }: { undo: UndoView; onUndo: () => void; busy: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface px-3 py-2.5">
      <p className="text-[12.5px] leading-snug text-soft">{undoSentence(undo)}</p>
      <button
        type="button"
        onClick={onUndo}
        disabled={busy}
        className="inline-flex h-8 items-center rounded-md border border-edge-strong px-3 text-[12.5px] text-body hover:bg-panel disabled:opacity-50"
      >
        Undo the restore
      </button>
    </div>
  );
}

const outsideButton =
  'inline-flex h-8 shrink-0 items-center rounded-md border border-edge-strong px-3 text-[12.5px] text-body hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link';

/**
 * What the Backup section shows outside the modal. Closing the modal is
 * allowed while a restore runs; the section then says so and Show opens it
 * on the job as it stands. Undo stays here too, so it is not only inside a
 * closed modal.
 */
export function RestoreOutsideModal({
  running,
  runningKind = null,
  outcome = null,
  open,
  undo,
  error = null,
  busy = false,
  onShow,
  onUndo,
}: {
  running: boolean;
  /** Which job the section is following. An undo is not a restore. */
  runningKind?: 'restore' | 'undo' | null;
  /**
   * A job that finished or failed while the modal was closed. Without it the
   * running line just went away, and whether the restore had worked was said
   * only inside a modal nobody had open.
   */
  outcome?: RestoreJob | null;
  open: boolean;
  undo: UndoView | null;
  /**
   * A failure of the section's own Undo. The modal draws `error` too, and
   * unmounts that when it is closed, which is where this button lives.
   */
  error?: string | null;
  /** The undo request is in flight. A second press starts another one. */
  busy?: boolean;
  onShow: () => void;
  onUndo: () => void;
}) {
  return (
    <>
      {running && !open && (
        <p role="status" className="flex flex-wrap items-center gap-2 text-[12.5px] leading-snug text-body">
          <span>{runningKind === 'undo' ? 'An undo is running…' : 'A restore is running…'}</span>
          <button type="button" onClick={onShow} className={outsideButton}>
            Show
          </button>
        </p>
      )}
      {outcome && !running && !open && (
        <p
          role="status"
          className={cn('flex flex-wrap items-center gap-2 text-[12.5px] leading-snug', outcome.state === 'failed' ? 'text-alarm' : 'text-body')}
        >
          <span>{jobLine(outcome)}</span>
          <button type="button" onClick={onShow} className={outsideButton}>
            Show
          </button>
        </p>
      )}
      {undo && !running && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface px-3 py-2.5">
            <p className="text-[12.5px] leading-snug text-soft">{undoSentence(undo)}</p>
            <button type="button" onClick={onUndo} disabled={busy} className={cn(outsideButton, 'disabled:opacity-50')}>
              {busy ? 'Undoing…' : 'Undo the last restore'}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-[12.5px] text-alarm">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The modal's title and its Close. The body is `RestoreIntoSection`'s form,
 * unchanged. On a phone the modal is the whole screen, so no backdrop is left
 * to tap and there is no Esc key: without Close there was no way back.
 */
export function RestoreDialogBody({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <DialogTitle>Restore</DialogTitle>
          <DialogDescription>Put a backup back into this install.</DialogDescription>
        </div>
        <DialogClose className={closeButton}>Close</DialogClose>
      </div>
      <div className="mt-3">{children}</div>
    </>
  );
}

/** The Close in the Backup and Restore modals' headers. */
export const closeButton =
  'inline-flex h-8 shrink-0 items-center rounded-md border border-edge-strong px-3 text-[12.5px] text-body hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link';

function JobResult({ job }: { job: RestoreJob }) {
  if (job.state !== 'done' || !job.result) return null;
  if ('summary' in job.result) {
    return (
      <div className="flex flex-col gap-3">
        <Lines title="Restored" lines={setsUpLines(job.result.summary)} />
        <Lines title="Sign-ins" lines={job.result.signIns.map(outcomeLine)} />
        <Lines
          title="Still to do"
          tone="attention"
          lines={[...job.result.summary.next, 'Anything else that needs a person is on the board, in Needs you.']}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Lines
        title="Sign-ins"
        lines={job.result.signIns.map((line) =>
          line.state === 'kept'
            ? `${line.who}: this install’s is kept — the one it had before ${line.reason ? `was not accepted: ${line.reason}` : 'no longer works'}`
            : `${line.who}: ${line.state === 'taken-over' ? 'taken back by using it' : line.state === 'same' ? 'as it was' : 'put back'}`,
        )}
      />
      <Lines
        title="Kept"
        tone="attention"
        lines={[
          ...(job.result.keptSeats ?? []).map(
            (seat) =>
              `${seat.seat.charAt(0).toUpperCase()}${seat.seat.slice(1).replace(/-/g, ' ')} stays ${seat.login ?? 'as it is'}: the sign-in it had before was not accepted (${seat.reason.replace(/[.\s]+$/, '')}), and the one it has works`,
          ),
          ...job.result.keptAccounts.map((account) => `A model account the restore added is still used by ${account.usedBy.join(', ')}, so it stays`),
        ]}
      />
    </div>
  );
}

/** The part, drawn from where it is. `RestoreIntoSection` below does the reading, the restoring and the asking. */
export function RestoreIntoPanel({
  phase,
  fileName,
  sealed,
  passphrase,
  choices,
  undo,
  error,
  undoing = false,
  starting = false,
  onPick,
  onPassphrase,
  onRead,
  onChoice,
  onRestore,
  onUndo,
}: {
  phase: IntoPhase;
  fileName: string | null;
  sealed: boolean;
  passphrase: string;
  choices: Record<string, boolean>;
  undo: UndoView | null;
  error: string | null;
  /**
   * An undo or a restore whose request is in flight. Their buttons stayed
   * live, and a double-click started two undos: the second re-applied the
   * snapshot with refresh tokens the first had already spent.
   */
  undoing?: boolean;
  starting?: boolean;
  onPick: () => void;
  onPassphrase: (value: string) => void;
  onRead: () => void;
  onChoice: (key: string, take: boolean) => void;
  onRestore: () => void;
  onUndo: () => void;
}) {
  const running = phase.at === 'running' && (phase.job.state === 'waiting' || phase.job.state === 'applying');
  const preview = phase.at === 'read' ? phase.preview : null;
  const count = preview ? takenCount(preview.comparison, choices) : 0;
  return (
    <div className="flex flex-col gap-3 border-t border-well pt-3">
      <span className="text-[13px] font-semibold text-body">Restore from a backup</span>
      <p className="text-[12px] leading-snug text-muted">
        Puts a backup back into this install. It is compared with this install first, thing by thing, and nothing is
        removed: what is only here stays.
      </p>

      {undo && phase.at !== 'running' && <UndoLine undo={undo} onUndo={onUndo} busy={running || undoing || starting} />}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPick}
          disabled={phase.at === 'reading' || running}
          className="inline-flex h-8 items-center rounded-md border border-edge-strong px-3 text-[12.5px] text-body hover:bg-panel disabled:opacity-50"
        >
          {fileName ? 'choose another file' : 'choose the backup file'}
        </button>
        {fileName && <span className="font-mono text-[12px] text-soft">{fileName}</span>}
      </div>

      {fileName && sealed && (phase.at === 'choosing' || phase.at === 'reading') && (
        <input
          type="password"
          aria-label="The backup’s passphrase"
          autoComplete="off"
          placeholder="its passphrase"
          value={passphrase}
          onChange={(event) => onPassphrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && passphrase) onRead();
          }}
          className="h-9 rounded-md border border-edge-strong bg-surface px-3 text-[13px] text-body placeholder:text-dim"
        />
      )}
      {fileName && !sealed && (phase.at === 'choosing' || phase.at === 'reading') && (
        <p className="text-[12px] text-attention">This file is not encrypted: anyone who has had it has had the credentials in it.</p>
      )}
      {fileName && (phase.at === 'choosing' || phase.at === 'reading') && (
        <button
          type="button"
          onClick={onRead}
          disabled={phase.at === 'reading' || (sealed && !passphrase)}
          className="inline-flex h-9 w-fit items-center rounded-md bg-body px-3.5 text-[13px] font-medium text-surface disabled:opacity-50"
        >
          {phase.at === 'reading' ? 'Comparing it with this install…' : 'Compare it with this install'}
        </button>
      )}

      {preview && (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-muted">
            Made {madeOn(preview.holds.createdAt)}
            {preview.sealed ? '' : ', and not encrypted'}.
          </p>
          <ComparisonList comparison={preview.comparison} choices={choices} onChoice={onChoice} />
          <div className="flex flex-col gap-2 border-t border-well pt-3">
            <p className="text-[12px] leading-snug text-muted">
              Restore waits for the bots it changes to finish their work and pauses the dispatcher while it writes. This
              install is backed up first; Undo puts it back for 24 hours. Afterwards the health checks run, and anything
              that needs a person lands in Needs you.
            </p>
            <button
              type="button"
              onClick={onRestore}
              disabled={count === 0 || starting}
              className="inline-flex h-9 w-fit items-center rounded-md bg-body px-3.5 text-[13px] font-medium text-surface disabled:opacity-50"
            >
              {count === 0 ? 'Nothing chosen to restore' : `Restore ${count} ${count === 1 ? 'thing' : 'things'}`}
            </button>
          </div>
        </div>
      )}

      {phase.at === 'running' && (
        <div className="flex flex-col gap-3">
          <p
            role="status"
            className={cn(
              'rounded-md p-3 text-[13px] leading-relaxed',
              phase.job.state === 'failed' ? 'border border-alarm/40 bg-alarm/5 text-body' : 'border border-signal/40 bg-signal/5 text-body',
            )}
          >
            {jobLine(phase.job)}
          </p>
          <JobResult job={phase.job} />
          {/* A failed restore or undo leaves its journal, and the bridge offers it: a
              half-restored install is exactly what Undo is for. */}
          {undo && !running && <UndoLine undo={undo} onUndo={onUndo} busy={undoing} />}
        </div>
      )}

      {error && (
        <p role="alert" className="text-[12.5px] text-alarm">
          {error}
        </p>
      )}
    </div>
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

/** A job the section has to keep showing after the modal that started it is closed. */
function restoreRunning(phase: IntoPhase): boolean {
  return phase.at === 'running' && (phase.job.state === 'waiting' || phase.job.state === 'applying');
}

/**
 * Undo, when the panel would offer it: whenever the bridge has one, except
 * while a job is waiting or applying — the same rule as `UndoLine` inside the
 * form. A finished undo clears it on the bridge. It was hidden after a failed
 * restore or undo too, which is when the journal they left is most needed.
 */
export function undoOnOffer(phase: IntoPhase, undo: UndoView | null): UndoView | null {
  if (restoreRunning(phase)) return null;
  return undo;
}

type RestoreIntoView = {
  /** The restore form. The modal renders it; closing the modal unmounts only this. */
  form: ReactNode;
  running: boolean;
  /** The job being followed, when one is. The section says an undo as an undo. */
  runningKind: 'restore' | 'undo' | null;
  undo: UndoView | null;
  /** Why the section's Undo did not start. Drawn beside that button. */
  undoError: string | null;
  /** The section's Undo has a request in flight. */
  undoing: boolean;
  /** A job that ended while the modal was closed, until the modal is opened again. */
  outcome: RestoreJob | null;
  onUndo: () => void;
};

export function RestoreIntoSection({
  open,
  children,
}: {
  /** Whether the modal showing `form` is open: what ends while it is closed is said on the section. */
  open: boolean;
  children: (view: RestoreIntoView) => ReactNode;
}) {
  const [phase, setPhase] = useState<IntoPhase>({ at: 'choosing' });
  const [file, setFile] = useState<{ name: string; archive: string; sealed: boolean } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [undo, setUndo] = useState<UndoView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The section's Undo, apart from the modal's error: the modal is unmounted while it is closed. */
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [starting, setStarting] = useState(false);
  // Read before the state above has drawn: two clicks in one frame both saw
  // the button enabled. The bridge refuses a second job too, since two tabs
  // can click as well.
  const inFlight = useRef(false);
  const [outcome, setOutcome] = useState<RestoreJob | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Read by the poll when a job ends, without restarting the poll on every open and close.
  const openRef = useRef(open);
  // Bumped when the modal closes on a form nobody finished, so a comparison
  // still in flight does not come back into the form that was cleared.
  const session = useRef(0);

  const status = useCallback(async (): Promise<{ job: RestoreJob | null; undo: UndoView | null } | null> => {
    const response = await fetch('/api/restore/into', { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json()) as { job: RestoreJob | null; undo: UndoView | null };
  }, []);

  // What can be undone, and a restore still running from before the page opened.
  useEffect(() => {
    void status().then((now) => {
      if (!now) return;
      setUndo(now.undo);
      if (now.job && (now.job.state === 'waiting' || now.job.state === 'applying')) setPhase({ at: 'running', job: now.job, preview: null });
    });
  }, [status]);

  // Asked again while one runs. The next check was scheduled only by a new
  // job arriving, so one failed request stopped the poll for good, and the
  // section said "A restore is running…" until the page was reloaded.
  // A failed request is asked again; an answer with no job means the bridge
  // no longer has one (it restarted), and there is nothing left to follow.
  const job = phase.at === 'running' ? phase.job : null;
  useEffect(() => {
    if (!job || (job.state !== 'waiting' && job.state !== 'applying')) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      timer = setTimeout(() => {
        void status().then((now) => {
          if (stopped) return;
          if (!now) return ask();
          setUndo(now.undo);
          const next = now.job;
          if (!next) {
            setPhase({ at: 'choosing' });
            return;
          }
          if (next.state === 'done' || next.state === 'failed') setOutcome(openRef.current ? null : next);
          setPhase((current) => (current.at === 'running' ? { ...current, job: next } : current));
        });
      }, 2_000);
    };
    ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job, status]);

  // Opening the modal shows the outcome in full, so the section's line goes.
  // Closing it on a form with no job running forgets the file and its
  // passphrase: the next Restore starts clean rather than holding a secret
  // in a form nobody is looking at.
  const running = restoreRunning(phase);
  const atJob = phase.at === 'running';
  useEffect(() => {
    openRef.current = open;
    if (open) {
      setOutcome(null);
      return;
    }
    if (running) return;
    setPassphrase('');
    if (atJob) return;
    session.current += 1;
    setFile(null);
    setChoices({});
    setError(null);
    setPhase({ at: 'choosing' });
  }, [open, running, atJob]);

  // The file before is let go at once, and a comparison of it still in
  // flight is dropped. It stayed on screen with its Compare live while the
  // new one was read, and that comparison then showed under the new name:
  // Restore sent the new file with choices made on the old one.
  async function choose(chosen: File | undefined): Promise<void> {
    if (!chosen) return;
    const started = (session.current += 1);
    setFile(null);
    setError(null);
    setPhase({ at: 'choosing' });
    try {
      const bytes = await chosen.arrayBuffer();
      if (session.current !== started) return;
      setFile({ name: chosen.name, archive: base64Of(bytes), sealed: looksSealed(bytes) });
    } catch {
      if (session.current === started) setError(`could not read ${chosen.name}`);
    }
  }

  const body = (archive: { archive: string; sealed: boolean } | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ archive: archive?.archive ?? '', ...(archive?.sealed ? { passphrase } : {}), ...extra });

  async function read(): Promise<void> {
    const started = session.current;
    const compared = file;
    if (!compared) return;
    setPhase({ at: 'reading' });
    setError(null);
    try {
      const response = await fetch('/api/restore/into/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(compared) });
      if (!response.ok) throw new Error(await bridgeError(response));
      const preview = (await response.json()) as IntoPreview;
      if (session.current !== started) return;
      setChoices({ ...preview.comparison.choices });
      setUndo(preview.undo);
      setPhase({ at: 'read', preview, archive: compared.archive, sealed: compared.sealed });
    } catch (cause) {
      if (session.current !== started) return;
      setPhase({ at: 'choosing' });
      setError(cause instanceof Error ? cause.message : 'the backup could not be read');
    }
  }

  async function restore(read: Extract<IntoPhase, { at: 'read' }>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    try {
      const response = await fetch('/api/restore/into', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(read, { choices }) });
      if (!response.ok) throw new Error(await bridgeError(response));
      const answer = (await response.json()) as { job: RestoreJob };
      setPhase({ at: 'running', job: answer.job, preview: read.preview });
      // The passphrase and the file are done with.
      setPassphrase('');
      setFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the restore did not start');
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }

  async function undoIt(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setUndoError(null);
    setUndoing(true);
    try {
      const response = await fetch('/api/restore/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(await bridgeError(response));
      const answer = (await response.json()) as { job: RestoreJob };
      setUndo(null);
      setPhase({ at: 'running', job: answer.job, preview: null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'the undo did not start';
      setError(message);
      setUndoError(message);
    } finally {
      inFlight.current = false;
      setUndoing(false);
    }
  }

  // The modal renders `form` and unmounts it when it closes. The phase, the
  // poll and the undo stay here, so Show opens on the job as it stands.
  return children({
    form: (
      <>
        <input
          ref={picker}
          type="file"
          accept=".fleetbak,.json,application/octet-stream,application/json"
          aria-label="The backup file to restore"
          className="hidden"
          onChange={(event) => {
            void choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <RestoreIntoPanel
          phase={phase}
          fileName={file?.name ?? null}
          sealed={file?.sealed ?? true}
          passphrase={passphrase}
          choices={choices}
          undo={undo}
          error={error}
          undoing={undoing}
          starting={starting}
          onPick={() => picker.current?.click()}
          onPassphrase={setPassphrase}
          onRead={() => void read()}
          onChoice={(key, take) => setChoices((current) => ({ ...current, [key]: take }))}
          onRestore={() => {
            if (phase.at === 'read') void restore(phase);
          }}
          onUndo={() => void undoIt()}
        />
      </>
    ),
    running,
    runningKind: phase.at === 'running' ? phase.job.kind : null,
    undo: undoOnOffer(phase, undo),
    undoError,
    undoing,
    outcome,
    onUndo: () => void undoIt(),
  });
}
