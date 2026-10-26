'use client';

import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { usePrefersReducedMotion } from '@/components/avatar';
import { ChevronDownIcon } from '@/components/icons';
import { RepoBadge } from '@/components/repo-badge';
import type { RunningTask } from '@/lib/api';
import { cn } from '@/lib/cn';
import { duration } from '@/lib/when';

/** A task's kind as the list says it: the stage's word a person uses, not the skill's. */
const KIND_WORDS: Record<string, string> = {
  intake: 'triage',
  request: 'triage',
  spec: 'design',
  implement: 'build',
  patch: 'fix',
  review: 'review',
  deploy: 'deploy',
  qa: 'QA',
};

export function kindWords(task: Pick<RunningTask, 'kind' | 'skill'>): string {
  if (task.skill === 'resolve-conflict') return 'conflict';
  return KIND_WORDS[task.kind] ?? task.kind;
}

/**
 * How many tasks are running across the install, above the columns, and,
 * opened, which: a person looking at a board whose cards had not changed for
 * a while could not tell whether the crew was working or stuck. Its dot moves
 * only while something runs, and never for someone who asked for less motion;
 * the count is a status, so a screen reader hears it when it changes.
 *
 * The count said "1 task running" over empty columns while intake triaged a
 * console request, and nothing on the page said what was running. The list
 * is the bridge's, read with the count from the same tasks, install-wide as
 * the count is; past the first it names, "and N more running" makes up the
 * rest. An older bridge sends no list, and the line is the count alone.
 */
export function RunningTasks({
  count,
  tasks,
  everyRepository,
  showRepo,
  now,
  who,
  onOpen,
  onOpenChange,
}: {
  count: number;
  /** The tasks counted, as the bridge names them; absent from an older bridge. */
  tasks?: readonly RunningTask[];
  /** The board shows one repository, and the count is still every one's. */
  everyRepository: boolean;
  /** Whether a row says its repository: there is more than one to tell apart. */
  showRepo: boolean;
  now: string;
  /** A bot by its name, as a card's line starts with it. */
  who: (bot: string) => string;
  /** Opens a row's subject in the item sheet. */
  onOpen: (subject: string) => void;
  /** Said when the list opens or closes, so the board polls while it is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [open, setOpenState] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();
  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  const listable = count > 0 && tasks !== undefined;
  const shown = open && listable;

  const setOpen = (next: boolean): void => {
    setOpenState(next);
    report.current?.(next);
  };
  // Nothing left running, or a bridge that stopped sending the list, closes it.
  useEffect(() => {
    if (!open || listable) return;
    setOpenState(false);
    report.current?.(false);
  }, [open, listable]);

  const text = count > 0 ? `${count} ${count === 1 ? 'task' : 'tasks'} running${everyRepository ? ' across every repository' : ''}` : 'Nothing running';
  const dot = <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', count > 0 ? ['bg-signal', !reduced && 'working-dot'] : 'bg-dim')} />;
  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };
  const opened = (event: MouseEvent<HTMLAnchorElement>, subject: string): void => {
    // A modified click opens the address where the person asked: a new tab.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(false);
    onOpen(subject);
  };
  const more = tasks ? count - tasks.length : 0;

  return (
    <>
      <p role="status" data-running className={cn('flex items-center gap-1.5 text-[12px]', count > 0 ? 'text-soft' : 'text-dim')}>
        {listable ? (
          <button
            ref={button}
            type="button"
            aria-expanded={shown}
            aria-controls={panel}
            onClick={() => setOpen(!shown)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && shown) {
                event.preventDefault();
                close();
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-sm hover:text-body focus-visible:outline-2 focus-visible:outline-link"
          >
            {dot}
            {text}
            <ChevronDownIcon size={12} className={cn('text-dim transition-transform motion-reduce:transition-none', shown && 'rotate-180')} />
          </button>
        ) : (
          <>
            {dot}
            {text}
          </>
        )}
      </p>
      {shown && (
        <ul
          id={panel}
          aria-label="Tasks running"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
          className="order-last flex basis-full flex-col gap-1 rounded-md bg-surface px-3 py-2 text-[12px]"
        >
          {tasks!.map((task) => {
            const since = duration(task.since, now);
            const line = (
              <>
                <span className="shrink-0 font-medium text-soft">{who(task.bot)}</span>
                <span className="shrink-0 text-dim">{kindWords(task)}</span>
                {showRepo && task.repo && <RepoBadge name={task.repo} />}
                <span className="min-w-0 flex-1 truncate">
                  {task.title ?? task.subject}
                  {task.title && <span className="ml-1.5 text-[11px] text-dim">{task.subject}</span>}
                </span>
                {since && <span className="shrink-0 whitespace-nowrap text-dim">{since}</span>}
              </>
            );
            return (
              <li key={task.id} data-running-task className="text-muted">
                {task.opens ? (
                  <a
                    href={`/?item=${encodeURIComponent(task.opens)}`}
                    onClick={(event) => opened(event, task.opens!)}
                    className="flex items-center gap-2 rounded-sm py-0.5 hover:text-body focus-visible:outline-2 focus-visible:outline-link"
                  >
                    {line}
                  </a>
                ) : (
                  <span className="flex items-center gap-2 py-0.5">{line}</span>
                )}
              </li>
            );
          })}
          {more > 0 && <li className="py-0.5 text-dim">and {more} more running</li>}
        </ul>
      )}
    </>
  );
}
