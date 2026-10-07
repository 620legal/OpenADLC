'use client';

import { useEffect, useState } from 'react';
import { killSession, restartBot, restartTaskFresh } from '@/app/actions';
import type { BotSession, WorktreeView } from '@/lib/api';
import type { BotLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { poll, reach } from '@/lib/reach';
import { safeAction } from '@/lib/safe-action';
import { Button } from '@/components/ui/button';
import { Chip, WorkingDot } from '@/components/ui/chip';
import { Terminal } from '@/components/terminal';

/**
 * A bot's computer and its terminal: the session it is printing to, the
 * worktree it is writing, and the keyboard a person can take.
 *
 * A bot's panel showed these for the bot, and a work item shows them for
 * each task on it, labelled by its role and seat: two reviewers on one
 * account were one handle, and the item has to say whose screen is whose.
 * Both draw the same components, so a fix to one is a fix to both. A task's
 * own session (`session`) is the one shown first; the bot's other sessions
 * stay one press away.
 */

/** Not answering at all means the console's server is down or restarting; the next read catches up. */
const CONSOLE_NOT_ANSWERING = 'The console is not answering, so this may be out of date. It catches up when it answers.';

/**
 * A bot's sessions, read for a view that does not already have them: a work
 * item's Computer and Terminal tabs, one per task. Refused to a user, which
 * is why only an admin is shown these tabs at all.
 */
export function useSessions(bot: string): { sessions: BotSession[]; reload: () => Promise<void>; error: string | null } {
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = async (): Promise<void> => {
    try {
      setSessions(await readSessions(bot));
      setError(null);
    } catch (cause) {
      // Said in place of "nothing running": a failed read looked the same as
      // an idle bot. The next open reads again.
      setError(cause instanceof Error ? cause.message : 'could not read its sessions');
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot]);
  return { sessions, reload, error };
}

/** A bot's sessions as the bridge has them, or why it would not say. */
export async function readSessions(bot: string): Promise<BotSession[]> {
  const response = await reach(`/api/sessions/${encodeURIComponent(bot)}`, { cache: 'no-store' }, CONSOLE_NOT_ANSWERING);
  const body = (await response.json().catch(() => ({}))) as { stored?: BotSession[]; error?: string };
  if (!response.ok) throw new Error(`could not read ${bot}’s sessions: ${body.error ?? `the console answered ${response.status}`}`);
  return body.stored ?? [];
}

/**
 * A session's own name. A task records where its session is as `bot/session`
 * (`builder/implement-68e1726d`), and that was handed on as the name: the
 * terminal asked for `/v1/terminal/builder/builder/implement-…/token`, a
 * route that does not exist, and could never attach.
 */
export function sessionName(session: string | null | undefined): string | null {
  return session ? (session.split('/').at(-1) ?? null) : null;
}

/** The session to show first: the task's own when it is one of the bot's, else the bot's first. */
export function firstSession(sessions: readonly BotSession[], session?: string | null): string | null {
  const name = sessionName(session);
  if (name && sessions.some((one) => one.name === name)) return name;
  return sessions[0]?.name ?? name;
}

export function ComputerTab({
  bot,
  label,
  sessions,
  onChanged,
  session = null,
  taskId = null,
  onAttach,
  error = null,
}: {
  bot: string;
  label: BotLabel;
  sessions: BotSession[];
  onChanged: () => Promise<void>;
  /** Why the sessions could not be read, said in place of the empty list. */
  error?: string | null;
  /** Opens the terminal on a session: pressing one only chose whose output the pane above showed, which nobody noticed. */
  onAttach?: (session: string) => void;
  /** The task's own session, shown first: an item's tab is about one task, not the bot's newest. */
  session?: string | null;
  /** The task whose worktree to show; the bot's newest running task when absent. */
  taskId?: string | null;
}) {
  const [pane, setPane] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(firstSession(sessions, session));
  const [busy, setBusy] = useState(false);

  // The bridge's refusal is said, and the buttons come back whatever happened:
  // a refused kill showed nothing, and a call that failed outright left both
  // buttons disabled until the tab was opened again.
  const run = async (work: () => Promise<{ ok: boolean; error?: string }>, refused: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await safeAction(work);
      if (!result.ok) window.alert(result.error ?? refused);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active && sessions[0]) setActive(firstSession(sessions, session));
  }, [sessions, active, session]);

  useEffect(() => {
    if (!active) return;
    // A read that fails keeps the pane that is on screen; the next tick retries.
    const load = async (): Promise<void> => {
      const read = await poll<{ pane: string[] }>(`/api/pane/${encodeURIComponent(bot)}/${encodeURIComponent(active)}`);
      if (read) setPane(read.pane);
    };
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [bot, active]);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Active pane</h3>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-edge bg-surface p-2.5">
          {pane.length === 0 ? (
            <p className="text-[11px] text-dim">nothing running</p>
          ) : (
            <pre className="pane whitespace-pre-wrap text-soft">{pane.join('\n')}</pre>
          )}
        </div>
        <p className="mt-1 text-[10.5px] text-dim">read-only; this is what the session is printing</p>
      </section>

      <Worktree key={`${bot}:${taskId ?? ''}`} bot={bot} taskId={taskId} />

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Sessions and processes</h3>
        <div className="mt-2 space-y-1.5">
          {sessions.length === 0 && error ? (
            <p role="alert" className="rounded border border-alarm/40 bg-alarm/10 p-2 text-[11px] text-alarm">
              {error}
            </p>
          ) : sessions.length === 0 ? (
            <p className="rounded-md border border-edge bg-panel/50 p-2.5 text-[11px] text-dim">
              nothing running in this container
            </p>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  'flex items-center gap-2 rounded-md border p-2',
                  active === session.name ? 'border-edge-strong bg-well' : 'border-edge bg-panel/50',
                )}
              >
                <WorkingDot working={session.state === 'working'} />
                <button
                  onClick={() => {
                    setActive(session.name);
                    onAttach?.(session.name);
                  }}
                  title={onAttach ? `Open ${session.name} in the terminal` : undefined}
                  className="min-w-0 flex-1 text-left hover:opacity-80"
                >
                  <p className="font-mono text-[11.5px] text-body">{session.name}</p>
                  <p className="truncate font-mono text-[10.5px] text-dim">
                    {session.cmd || 'shell'} {session.pid ? `· pid ${session.pid}` : ''}
                  </p>
                </button>
                <Chip tone={session.state === 'working' ? 'signal' : session.state === 'paused' ? 'attention' : 'neutral'}>
                  {session.state}
                </Chip>
                {onAttach && (
                  <Button size="sm" onClick={() => onAttach(session.name)}>
                    open terminal
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    const question = `Kill ${session.name} in ${label.said}’s container? The branch and the issue survive.`;
                    if (!window.confirm(question)) return;
                    await run(() => killSession(bot, session.name), `${session.name} was not killed`);
                  }}
                >
                  kill
                </Button>
              </div>
            ))
          )}
        </div>
      </section>

      {/*
        A computer is a task's own now. "Restart container" here cancelled every
        task the seat had, in every work item, and recreated nothing: what it
        said and what it did had parted. On one task it restarts that task, on
        a fresh computer; on the seat it says that it stops all its work.
      */}
      {taskId ? (
        <section className="rounded-md border border-edge bg-panel/50 p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">This task’s computer</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Restarting stops this task and starts it again from its branch on a fresh computer. Its commits, pushed or not,
            are kept on the branch; its other work and the seat’s other tasks are untouched.
          </p>
          <Button
            size="sm"
            variant="danger"
            className="mt-2"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`Restart this task of ${label.said} on a fresh computer?`)) return;
              await run(() => restartTaskFresh(taskId), 'it did not restart');
            }}
          >
            restart this task
          </Button>
        </section>
      ) : (
        <section className="rounded-md border border-edge bg-panel/50 p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">All its work</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Stops every task {label.said} is running, in every work item. Each one’s branch is kept and its work goes back on
            the board to be tried again.
          </p>
          <Button
            size="sm"
            variant="danger"
            className="mt-2"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`Stop every task ${label.said} is running?`)) return;
              await run(() => restartBot(bot), 'its work was not stopped');
            }}
          >
            stop all its work
          </Button>
        </section>
      )}
    </div>
  );
}

/** `a/b/c.ts` as the pieces you can click back to. */
function crumbsOf(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

function sizeOf(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The task's worktree, read-only: what this bot has actually written, without
 * taking its keyboard. Everything here is a GET — there is no rename, no delete
 * and no editor, because a second author in a worktree one bot owns is how two
 * changes end up in one commit nobody meant to make.
 */
export function Worktree({ bot, taskId = null }: { bot: string; taskId?: string | null }) {
  const [path, setPath] = useState('');
  const [view, setView] = useState<WorktreeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      try {
        // A seat can run several tasks at once, so an item's tab names its
        // task; the bot's own tab shows its newest.
        const task = taskId ? `&task=${encodeURIComponent(taskId)}` : '';
        const response = await fetch(`/api/worktree/${encodeURIComponent(bot)}?path=${encodeURIComponent(path)}${task}`, {
          cache: 'no-store',
        });
        const payload = (await response.json()) as WorktreeView & { error?: string };
        if (!current) return;
        // A refusal keeps the tree that is already on screen and says why above
        // it, rather than blanking the panel because one path was not served.
        if (!response.ok) return setError(payload.error ?? `could not read ${path || 'the worktree'}`);
        setView(payload);
        setError(null);
      } catch {
        if (current) setError('could not reach the worktree');
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [bot, path, reloads]);

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Worktree</h3>
        <Button size="sm" variant="ghost" onClick={() => setReloads((count) => count + 1)}>
          refresh
        </Button>
      </div>

      {error && (
        <p className="mt-2 rounded border border-alarm/40 bg-alarm/10 p-2 text-[11px] text-alarm">{error}</p>
      )}

      {view === null && !error && <p className="mt-2 text-[11px] text-dim">loading</p>}

      {view?.task === null && (
        <p className="mt-2 rounded-md border border-edge bg-panel p-2.5 text-[11px] leading-relaxed text-dim">
          Nothing to browse. A worktree exists while its task does, so this fills in when this bot starts work; what a
          finished task wrote is on its branch.
        </p>
      )}

      {view && view.task !== null && (
        <div className="mt-2 space-y-2">
          <p className="font-mono text-[10.5px] text-dim">
            {view.task.subjectRef}
            {view.task.branch ? ` · ${view.task.branch}` : ''}
          </p>

          <div className="flex flex-wrap items-center gap-1 font-mono text-[10.5px]">
            <button onClick={() => setPath('')} className="text-muted hover:text-link">
              worktree
            </button>
            {crumbsOf(view.path).map((crumb) => (
              <span key={crumb.path} className="flex items-center gap-1">
                <span className="text-dim">/</span>
                <button onClick={() => setPath(crumb.path)} className="text-muted hover:text-link">
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>

          {view.kind === 'directory' ? (
            <div className="max-h-64 overflow-y-auto rounded-md border border-edge bg-surface">
              {view.entries.length === 0 ? (
                <p className="p-2.5 text-[11px] text-dim">nothing here yet</p>
              ) : (
                view.entries.map((entry) => (
                  <button
                    key={entry.name}
                    disabled={entry.kind === 'other'}
                    onClick={() => setPath(view.path ? `${view.path}/${entry.name}` : entry.name)}
                    className="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-well disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate font-mono text-[11.5px]',
                        entry.kind === 'other' ? 'text-dim' : 'text-body',
                      )}
                    >
                      {entry.name}
                      {entry.kind === 'directory' ? '/' : ''}
                    </span>
                    <span className="font-mono text-[10.5px] text-dim">
                      {entry.kind === 'other' ? 'link' : sizeOf(entry.size)}
                    </span>
                  </button>
                ))
              )}
              {view.truncated && (
                <p className="px-2.5 py-1 text-[10.5px] text-dim">
                  first 500 entries; this directory holds more
                </p>
              )}
            </div>
          ) : (
            <div className="max-h-80 overflow-auto rounded-md border border-edge bg-surface p-2.5">
              <pre className="pane whitespace-pre-wrap break-words text-soft">{view.content}</pre>
            </div>
          )}

          <p className="text-[10.5px] text-dim">
            Read-only.{' '}
            {view.kind === 'file' && view.truncated
              ? `Showing the first ${sizeOf(view.bytes)} of ${sizeOf(view.size)}.`
              : 'Nothing here writes to the worktree.'}
          </p>
        </div>
      )}
    </section>
  );
}

export function TerminalTab({
  bot,
  label,
  sessions,
  session = null,
  error = null,
}: {
  bot: string;
  label: BotLabel;
  sessions: BotSession[];
  /** The task's own session, attached to first. */
  session?: string | null;
  /** Why the sessions could not be read, said in place of "nothing to attach to". */
  error?: string | null;
}) {
  const [target, setTarget] = useState<string | null>(firstSession(sessions, session));

  useEffect(() => {
    if (!target && sessions[0]) setTarget(firstSession(sessions, session));
  }, [sessions, target, session]);

  // A session opened from the computer's list is the one to attach to.
  useEffect(() => {
    const name = sessionName(session);
    if (name) setTarget(name);
  }, [session]);

  if (!target && error) {
    return (
      <p role="alert" className="rounded border border-alarm/40 bg-alarm/10 p-2 text-[11px] text-alarm">
        {error}
      </p>
    );
  }

  if (!target) {
    return (
      <div className="rounded-md border border-edge bg-panel/50 p-3">
        <p className="text-[12px] text-body">Nothing to attach to</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          This container has no session running. Take-over attaches to a session, so there is nothing to take over
          until this bot starts a task.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sessions.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => setTarget(session.name)}
              className={cn(
                'rounded border px-2 py-0.5 font-mono text-[10.5px] transition-colors',
                target === session.name
                  ? 'border-edge-strong bg-well text-body'
                  : 'border-edge bg-panel text-muted hover:text-soft',
              )}
            >
              {session.name}
            </button>
          ))}
        </div>
      )}
      {/* One terminal per session: another session's pill kept the socket
          open to the first, and what was typed went to the session not named. */}
      <Terminal key={target} bot={bot} label={label.name} session={target} />
    </div>
  );
}
