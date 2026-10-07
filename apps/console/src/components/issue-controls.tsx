'use client';

import type { ReactNode } from 'react';
import { useEffect, useState, useTransition } from 'react';
import {
  cancelItem,
  pauseItem,
  playItemNext,
  previewCancelItem,
  resumeItem,
  type CancelOutcome,
  type CancelPreview,
} from '@/app/actions';
import { useRole } from '@/components/app-header';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { CancelIcon, NextIcon, PauseIcon, PlayIcon } from '@/components/icons';

/** What an issue's controls need to know about it. */
export interface IssueControlsFor {
  /** The work item's key, `testbed#7`: what the bridge's item routes are addressed by. */
  subject: string;
  number: number;
  /** Who holds it, when somebody paused it. */
  held?: { by: string; at: string; why: string | null } | null;
  /** Put first in its repository's queue. */
  next?: boolean;
}

/**
 * Pause, play next and cancel, for one issue: an admin's, since each changes
 * what the crew builds and when. On a card they are small icon buttons above
 * the button that opens the card — `relative z-10`, and every press stops
 * there — and in the work item's header they are words.
 */
export function IssueControls({ issue, compact = false }: { issue: IssueControlsFor; compact?: boolean }) {
  const admin = useRole() === 'admin';
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  if (!admin) return null;

  const run = (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const result = await work();
      if (!result.ok) setError(result.error ?? 'that did not go through');
    });
  };
  const paused = Boolean(issue.held);
  const pauseLabel = paused ? `Resume #${issue.number}` : `Pause #${issue.number}`;
  const nextLabel = issue.next ? `Take #${issue.number} out of the front of the queue` : `Do #${issue.number} next`;
  const cancelLabel = `Cancel #${issue.number}`;

  // Said the same way on the card and in the item, with what each does on hover.
  const pauseTitle = paused
    ? `Resume work on #${issue.number}: new work may start on it again`
    : `Pause work on #${issue.number}: the step running now finishes, then nothing new starts until you resume`;
  const nextTitle = issue.next
    ? `#${issue.number} is next in line; press to put it back in its usual place`
    : `Do #${issue.number} next: to the front of its repository's queue, ahead of priority`;
  const cancelTitle = `Cancel work on #${issue.number}: stop its tasks, close its pull request and issue (you see exactly what first)`;
  const buttons = compact ? (
    <span data-issue-controls className="relative z-10 ml-auto flex shrink-0 items-center gap-1">
      <IconButton label={pauseLabel} title={pauseTitle} disabled={pending} pressed={paused} onPress={() => run(() => (paused ? resumeItem(issue.subject) : pauseItem(issue.subject)))}>
        {paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
      </IconButton>
      <IconButton
        label={nextLabel}
        title={nextTitle}
        pressed={Boolean(issue.next)}
        disabled={pending || paused}
        onPress={() => run(() => playItemNext(issue.subject, !issue.next))}
      >
        <NextIcon size={12} />
      </IconButton>
      <IconButton label={cancelLabel} title={cancelTitle} disabled={pending} danger onPress={() => setCancelling(true)}>
        <CancelIcon size={12} />
      </IconButton>
    </span>
  ) : (
    <span data-issue-controls className="flex flex-wrap items-center gap-1.5">
      <TextButton title={pauseTitle} disabled={pending} pressed={paused} onPress={() => run(() => (paused ? resumeItem(issue.subject) : pauseItem(issue.subject)))}>
        {paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
        {paused ? 'Resume work' : 'Pause work'}
      </TextButton>
      <TextButton title={nextTitle} pressed={Boolean(issue.next)} disabled={pending || paused} onPress={() => run(() => playItemNext(issue.subject, !issue.next))}>
        <NextIcon size={12} />
        {issue.next ? 'Next up · undo' : 'Do next'}
      </TextButton>
      <TextButton title={cancelTitle} danger disabled={pending} onPress={() => setCancelling(true)}>
        <CancelIcon size={12} />
        Cancel work…
      </TextButton>
    </span>
  );

  return (
    <>
      {buttons}
      {error && (
        // A line of its own below the buttons, the width of the card or the
        // item: beside them it was squeezed to a column of broken words.
        <span data-control-error role="status" className="relative z-10 block w-full basis-full text-[11.5px] leading-snug text-alarm">
          {error}
        </span>
      )}
      {cancelling && <CancelDialog issue={issue} onClose={() => setCancelling(false)} />}
    </>
  );
}

function IconButton({
  label,
  title,
  children,
  onPress,
  disabled,
  danger = false,
  pressed,
}: {
  label: string;
  title: string;
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      draggable={false}
      onClick={(event) => {
        // The card opens on a press anywhere else on it; this one is the control's.
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
      // Quiet like the card's other marks: an outline in the card's own edge,
      // its ink only on hover. They were emoji, drawn in the system's colours.
      className={cn(
        'flex size-6 items-center justify-center rounded-md border border-edge bg-panel text-dim transition-colors hover:border-edge-strong hover:text-body disabled:opacity-40',
        pressed && 'border-link/40 bg-link/10 text-link',
        danger && 'hover:border-alarm/40 hover:text-alarm',
      )}
    >
      {children}
    </button>
  );
}

/** The same controls with their words, as the item's header shows them: links' weight, not a form's. */
function TextButton({
  title,
  children,
  onPress,
  disabled,
  danger = false,
  pressed,
}: {
  title: string;
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border border-edge bg-panel px-2.5 text-[12.5px] text-soft transition-colors hover:border-edge-strong hover:text-body disabled:opacity-40',
        pressed && 'border-link/40 bg-link/10 text-link',
        danger && 'hover:border-alarm/40 hover:text-alarm',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Cancelling one issue, after saying exactly what it does: its tasks stopped,
 * its questions closed, its pull request closed unmerged with its branch
 * deleted when the bridge names one (only the crew's own for this issue), and
 * the issue closed as not planned. Read from the bridge first —
 * nothing is done until the person has seen the list — and the answer says
 * what was done and what was not, each with why.
 */
function CancelDialog({ issue, onClose }: { issue: IssueControlsFor; onClose: () => void }) {
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<CancelOutcome | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void previewCancelItem(issue.subject).then((result) => {
      if (!live) return;
      if (result.ok && result.preview) setPreview(result.preview);
      else setError(result.error ?? 'could not read what cancelling would do');
    });
    return () => {
      live = false;
    };
  }, [issue.subject]);

  const confirm = () => {
    if (!reason.trim()) return;
    setError(null);
    start(async () => {
      const result = await cancelItem(issue.subject, reason.trim());
      if (result.ok) setOutcome(result.outcome ?? {});
      else setError(result.error ?? 'it was not cancelled');
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Cancel #{issue.number}?</DialogTitle>
        {outcome ? (
          <Outcome outcome={outcome} />
        ) : (
          <>
            <DialogDescription>This stops OpenADLC&rsquo;s work on it and closes it on GitHub:</DialogDescription>
            {preview ? <PreviewList number={issue.number} preview={preview} /> : !error && <p className="mt-3 text-[12.5px] text-dim">Reading what it has…</p>}
            <label className="mt-4 block text-[12.5px] text-body">
              Why
              <textarea
                value={reason}
                required
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                placeholder="Said on the issue and the pull request when they are closed"
                className="mt-1 w-full rounded-md border border-edge-strong bg-surface px-2.5 py-1.5 text-[12.5px] text-body"
              />
            </label>
          </>
        )}
        {error && (
          <p role="status" className="mt-2 text-[12px] text-alarm">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {outcome ? (
            <DialogClose asChild>
              <Button size="sm">Close</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button size="sm">Keep it</Button>
              </DialogClose>
              <Button size="sm" variant="danger" disabled={!preview || !reason.trim() || pending} onClick={confirm}>
                {pending ? 'Cancelling…' : `Cancel #${issue.number}`}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Every step, in the order the bridge takes them. */
function PreviewList({ number, preview }: { number: number; preview: CancelPreview }) {
  const going = preview.tasks.filter((task) => ['queued', 'running', 'paused'].includes(task.state));
  return (
    <ul data-cancel-preview className="mt-3 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-body">
      {going.length > 0 && (
        <li>
          Stop {going.length === 1 ? 'its task' : `its ${going.length} tasks`}: {going.map((task) => `${task.bot}’s ${task.kind} (${task.state})`).join(', ')}
        </li>
      )}
      {preview.questions > 0 && <li>Close {preview.questions === 1 ? 'its open question' : `its ${preview.questions} open questions`}</li>}
      {preview.pr && (
        <li>
          Close pull request #{preview.pr.number} unmerged
          {preview.pr.branch ? (
            <>
              {' '}
              and <strong className="text-alarm">delete its branch</strong> <code className="font-mono text-[12px]">{preview.pr.branch}</code>
            </>
          ) : null}
        </li>
      )}
      <li>Close issue #{preview.issue?.number ?? number} as not planned</li>
    </ul>
  );
}

function Outcome({ outcome }: { outcome: CancelOutcome }) {
  const done = outcome.done ?? [];
  const notDone = outcome.notDone ?? [];
  return (
    <div data-cancel-outcome className="mt-3 space-y-2 text-[12.5px]">
      {done.length > 0 && (
        <ul className="space-y-0.5 text-body">
          {done.map((line) => (
            <li key={line}>✓ {line}</li>
          ))}
        </ul>
      )}
      {notDone.length > 0 && (
        <ul className="space-y-1 text-alarm">
          {notDone.map((one) => (
            <li key={`${one.step}:${one.what}`}>
              ✕ {one.what} — {one.why}
            </li>
          ))}
        </ul>
      )}
      {done.length === 0 && notDone.length === 0 && <p className="text-body">Cancelled.</p>}
    </div>
  );
}

/** What a held card says first: who paused it, and why on hover. */
export function heldLine(held: NonNullable<IssueControlsFor['held']>): { text: string; title: string } {
  return { text: `Paused · ${held.by}`, title: held.why ? `Paused by ${held.by}: ${held.why}` : `Paused by ${held.by}` };
}
