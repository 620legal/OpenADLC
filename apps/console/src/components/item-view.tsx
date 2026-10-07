'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { sendItemMessage } from '@/app/actions';
import { useRole } from '@/components/app-header';
import { AttachmentDrop, type AttachmentState } from '@/components/attachment-drop';
import { CheckIcon, CloseIcon, ComputerIcon, ExternalIcon, TerminalIcon, WarningIcon } from '@/components/icons';
import { Markdown } from '@/components/markdown';
import { RepoBadge } from '@/components/repo-badge';
import { ComputerTab, TerminalTab, useSessions } from '@/components/task-computer';
import { OpenQuestions } from '@/components/thread-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DesignMemoryEntry, ItemAttachment, ItemTask, ItemView as ItemData } from '@/lib/api';
import { KIND_WORDS } from '@/components/design-memory';
import { megabytes, WHERE_FILES_GO } from '@/lib/attachments';
import { botLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { IssueControls } from '@/components/issue-controls';
import {
  itemComposer,
  itemEntries,
  liveTasks,
  questionsFor,
  roleTabs,
  roleWords,
  speakerLabel,
  taskLabel,
  type ItemEntry,
} from '@/lib/item';
import { useDraft } from '@/lib/draft';
import { reach } from '@/lib/reach';
import { safeAction } from '@/lib/safe-action';
import { personName, standsOut } from '@/lib/thread';
import { stageOf } from '@/lib/stages';
import { useEventStream } from '@/lib/use-event-stream';
import { money } from '@/lib/when';

/** Not answering at all means the console's server is down or restarting; the stream catches up. */
const CONSOLE_NOT_ANSWERING = 'The console is not answering, so this may be out of date. It catches up when it answers.';

const CONVERSATION = 'conversation';

/** The address of an item, as a page: any member's subject opens the same item. */
function itemHref(subject: string): string {
  return `/items/${encodeURIComponent(subject)}`;
}

/**
 * One piece of work — the request, the issue it became and that issue's pull
 * request — as one conversation, with each role on its own tab, even when
 * seats share a GitHub account.
 *
 * A card used to open the panel of the bot that last touched it, with every
 * other subject that bot had worked on beside it, and two reviewers on one
 * account were one handle. Here every entry is headed by the role and seat
 * that said it, each role present has a tab of its own, and each task going
 * now has its computer and terminal, labelled the same way. The board opens
 * it as a sheet (`?item=`); `/items/<subject>` is the same view as a page.
 */
export function ItemView({
  subject,
  initial = null,
  now,
  variant = 'page',
  onClose,
  initialRole = null,
}: {
  /** Any member's subject: `request:<id8>`, `repo#12`, or its pull request. */
  subject: string;
  /** What the server already read, so the first drawing is not empty. */
  initial?: ItemData | null;
  now: string;
  variant?: 'page' | 'sheet';
  onClose?: () => void;
  /** A role's tab to open on, from `?role=`: a question in Needs you opens the role that asked it. */
  initialRole?: string | null;
}) {
  const [view, setView] = useState<ItemData | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [streamDown, setStreamDown] = useState(false);
  const [tab, setTab] = useState(initialRole ? `role:${initialRole}` : CONVERSATION);
  // The session each task's terminal attaches to, when one was chosen on its computer tab.
  const [attachTo, setAttachTo] = useState<Record<string, string>>({});
  // Kept across a reload, per item: the page is read again on a timer, and a
  // console restarted under the tab loads it afresh.
  const [draft, setDraft] = useDraft(`item:${subject}`);
  const [picked, setPicked] = useState<string | null>(null);
  const [clock, setClock] = useState(now);
  const [pending, startTransition] = useTransition();
  const [files, setFiles] = useState<AttachmentState>({ ids: [], busy: false });
  const [filesKey, setFilesKey] = useState(0);
  // Set at once, where `pending` is set only by the next render: a second
  // Cmd+Enter before then sent the same message twice.
  const sending = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerId = useId();
  const admin = useRole() === 'admin';

  // Only the latest read is drawn: an older one that answered late brought
  // back a question that had already been answered.
  const loadSeq = useRef(0);
  const load = async (): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const response = await reach(`/api/item/${encodeURIComponent(subject)}`, { cache: 'no-store' }, CONSOLE_NOT_ANSWERING);
      const body = (await response.json()) as ItemData & { error?: string };
      if (seq !== loadSeq.current) return;
      if (!response.ok) throw new Error(body.error ?? `Could not read ${subject}.`);
      setView(body);
      setError(null);
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Could not read this item.');
    }
  };

  // The same subscription a bot's panel has: the stream says that something
  // changed, and this reads the item again; a stream that ends is opened
  // again, and its `open` reads what was missed.
  useEventStream(`/api/item/${encodeURIComponent(subject)}/stream`, {
    onOpen: () => {
      setStreamDown(false);
      void load();
    },
    onChanged: () => void load(),
    onDown: () => setStreamDown(true),
  });
  // With no EventSource there is no `open` to read it first; the hook's timer reads it after that.
  useEffect(() => {
    if (typeof EventSource === 'undefined') void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date().toISOString()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (variant !== 'sheet' || !onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, input, select, [contenteditable="true"], .xterm')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant, onClose]);

  const role = tab.startsWith('role:') ? tab.slice(5) : null;
  const questions = view ? questionsFor(view, role) : [];
  const target = view ? itemComposer(view, { role, picked }) : null;

  const send = (text: string, gateId: string | null, withFiles = false): void => {
    const attachments = withFiles ? files.ids : [];
    if ((!text.trim() && attachments.length === 0) || sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const result = await safeAction(() =>
          sendItemMessage(subject, { text, gateId, role, ...(attachments.length > 0 ? { attachments } : {}) }),
        );
        if (!result.ok) setError(result.error ?? 'That did not go through.');
        else {
          setDraft('');
          setPicked(null);
          if (withFiles) {
            setFiles({ ids: [], busy: false });
            setFilesKey((key) => key + 1);
          }
          await load();
        }
      } finally {
        sending.current = false;
      }
    });
  };

  // The box is one for every tab that talks, and stays drawn, hidden, on a
  // computer or a terminal: one per tab was a new file box on each switch,
  // and a screenshot attached a moment before was not sent.
  const talking = !tab.startsWith('computer:') && !tab.startsWith('terminal:');

  const body = (
    <>
      <ItemHeader view={view} subject={subject} variant={variant} onClose={onClose} />
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="overflow-x-auto border-b border-edge px-5">
          <TabsList aria-label="What to see">
            <TabsTrigger value={CONVERSATION}>Conversation</TabsTrigger>
            {view &&
              roleTabs(view).map((one) => (
                <TabsTrigger key={one.value} value={one.value} data-role-tab={one.role}>
                  {one.label}
                </TabsTrigger>
              ))}
            {admin &&
              view &&
              liveTasks(view).flatMap((task) => [
                <TabsTrigger key={`computer-${task.id}`} value={`computer:${task.id}`}>
                  <ComputerIcon />
                  Computer · {taskLabel(view, task)}
                </TabsTrigger>,
                <TabsTrigger key={`terminal-${task.id}`} value={`terminal:${task.id}`}>
                  <TerminalIcon />
                  Terminal · {taskLabel(view, task)}
                </TabsTrigger>,
              ])}
          </TabsList>
        </div>

        {[CONVERSATION, ...(view ? roleTabs(view).map((one) => one.value) : [])].map((value) => (
          <TabsContent key={value} value={value} className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 *:shrink-0">
              {streamDown && (
                <p role="status" className="rounded-md border border-attention/35 bg-attention/10 px-2.5 py-1.5 text-[12px] text-attention">
                  Not updating on its own right now. It reconnects by itself and catches up once the connection is back.
                </p>
              )}
              {error && (
                <p role="alert" className="rounded-md border border-alarm/40 bg-alarm/10 px-2.5 py-1.5 text-[12px] text-alarm">
                  {error}
                </p>
              )}
              {view && questions.length > 0 && (
                <OpenQuestions
                  questions={questions}
                  label={() => ''}
                  selected={null}
                  pending={pending}
                  onAnswer={(gateId, text) => send(text, gateId)}
                  onShow={() => undefined}
                  pick={{
                    picked: target?.gateId ?? picked,
                    onPick: (gateId) => {
                      setPicked(gateId);
                      composer.current?.focus();
                    },
                    label: (question) => `${speakerLabel(view, questions.find((one) => one.id === question.id) ?? { role: null, seat: null, bot: null })} asks`,
                  }}
                />
              )}
              {!view && !error && <p className="text-[12.5px] text-dim">Loading…</p>}
              {view && (
                <Conversation entries={itemEntries(view, { now: clock, role })} empty={role ? `Nothing said by the ${roleWords(role)} yet.` : 'Nothing said yet.'} />
              )}
            </div>

          </TabsContent>
        ))}

        {view && target && (
          <form
            hidden={!talking}
            onSubmit={(event) => {
              event.preventDefault();
              if (target.mode !== 'pick' && !files.busy && !pending) send(draft, target.gateId, true);
            }}
            className="flex flex-col gap-2 border-t border-edge px-5 pb-4 pt-3"
          >
            <label htmlFor={composerId} className="text-[12px] font-medium text-soft">
              {target.mode === 'answer' ? 'Your answer' : role ? `Message the ${roleWords(role)}` : 'Message the crew about this'}
            </label>
            <textarea
              ref={composer}
              id={composerId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && target.mode !== 'pick' && !files.busy && !pending) {
                  event.preventDefault();
                  send(draft, target.gateId, true);
                }
              }}
              rows={2}
              disabled={target.mode === 'pick'}
              placeholder={target.mode === 'answer' ? 'Your own answer…' : 'Ask a question or give direction'}
              className="w-full resize-none rounded-md border border-edge-strong bg-panel px-2.5 py-2 text-[13px] leading-normal text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60"
            />
            <AttachmentDrop key={filesKey} compact onChange={setFiles} />
            <div className="flex items-center gap-2.5">
              <span data-composer-helper className="text-[11.5px] leading-snug text-dim">
                {target.helper}
                {files.ids.length > 0 && ` · ${WHERE_FILES_GO}`}
              </span>
              <button
                type="submit"
                disabled={pending || files.busy || (!draft.trim() && files.ids.length === 0) || target.mode === 'pick'}
                className="ml-auto inline-flex h-11 shrink-0 items-center rounded-md bg-body px-4 text-[12.5px] font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:opacity-50 md:h-[30px] md:px-3"
              >
                {pending ? 'Sending…' : target.mode === 'answer' ? 'Answer' : 'Send'}
              </button>
            </div>
          </form>
        )}

        {admin &&
          view &&
          liveTasks(view).flatMap((task) => [
            <TabsContent key={`computer-${task.id}`} value={`computer:${task.id}`} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <TaskScreen
                task={task}
                which="computer"
                onAttach={(name) => {
                  setAttachTo((was) => ({ ...was, [task.id]: name }));
                  setTab(`terminal:${task.id}`);
                }}
              />
            </TabsContent>,
            <TabsContent key={`terminal-${task.id}`} value={`terminal:${task.id}`} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <TaskScreen task={task} which="terminal" session={attachTo[task.id]} />
            </TabsContent>,
          ])}
      </Tabs>
    </>
  );

  if (variant === 'sheet') {
    return (
      <>
        <div aria-hidden onClick={onClose} className="fixed inset-0 z-30 bg-scrim" />
        <aside
          aria-label={view ? `${view.title}: the conversation` : 'A piece of work'}
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[640px] flex-col border-l border-edge bg-panel shadow-2xl"
        >
          {body}
        </aside>
      </>
    );
  }
  return <section className="mx-auto flex h-full w-full max-w-[860px] flex-col border-x border-edge bg-panel">{body}</section>;
}

/** The request, its issue and its pull request, the stage it is in, and what it has cost. */
function ItemHeader({
  view,
  subject,
  variant,
  onClose,
}: {
  view: ItemData | null;
  subject: string;
  variant: 'page' | 'sheet';
  onClose?: () => void;
}) {
  const stage = view?.stage ? stageOf(view.stage) : undefined;
  return (
    <div className="flex flex-col gap-2 border-b border-edge px-5 pb-3.5 pt-[18px]">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-dim">
            {stage && <span className="rounded border border-edge px-1.5 py-px font-medium text-soft">{stage.title}</span>}
            {view?.repo && <RepoBadge name={view.repo} />}
            {view && view.costUsd > 0 && <span>{money(view.costUsd)} so far</span>}
          </div>
          <h2 className="text-[15px] font-semibold leading-snug text-body">{view?.title ?? subject}</h2>
        </div>
        {variant === 'sheet' && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Link href={itemHref(view?.key ?? subject)} className="rounded-md px-2 py-1 text-[12px] text-link hover:underline">
              Open as a page
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex size-11 items-center justify-center rounded-md text-muted transition-colors hover:bg-well hover:text-body focus-visible:outline-2 focus-visible:outline-link md:size-8"
            >
              <CloseIcon size={16} />
            </button>
          </div>
        )}
      </div>
      {view?.request && (
        <div className="rounded-lg border border-edge bg-surface px-3 py-2 text-[12.5px] leading-normal text-soft">
          <p className="text-[11px] font-medium text-dim">
            Asked by {view.request.requestedBy ? personName(view.request.requestedBy) : 'somebody'}
          </p>
          <Markdown text={view.request.text} className="line-clamp-4" />
        </div>
      )}
      {view && view.attachments.length > 0 && <Attachments files={view.attachments} />}
      {view && (view.designMemory ?? []).length > 0 && <DesignProposals entries={view.designMemory ?? []} />}
      {view && (view.issue?.url || view.pullRequest?.url) && (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px]">
          {view.issue?.url && (
            <a href={view.issue.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
              Issue #{view.issue.number}
              <ExternalIcon size={11} />
            </a>
          )}
          {view.pullRequest?.url && (
            <a href={view.pullRequest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
              Pull request #{view.pullRequest.number}
              <ExternalIcon size={11} />
            </a>
          )}
        </div>
      )}
      {/* An issue's pause, play next and cancel, in words; a request has none until it is filed,
          and finished work none, as on the board: a shipped item's cancel would close its merged pull request. */}
      {view?.issue && !['merged', 'done'].includes(view.issue.stage) && (
        <IssueControls issue={{ subject: view.key, number: view.issue.number, held: view.held ?? null, next: view.next ?? false }} />
      )}
    </div>
  );
}

/**
 * The files given with the item, from the console or read from its issue:
 * each opens through the console's own server, which serves it so it cannot
 * run, and an image shows as a thumbnail.
 */
function Attachments({ files }: { files: readonly ItemAttachment[] }) {
  return (
    <ul aria-label="Files" className="flex flex-wrap gap-2">
      {files.map((file) => (
        <li key={file.id} data-attachment={file.name}>
          <a
            href={`/api/attachments/${encodeURIComponent(file.id)}`}
            target="_blank"
            rel="noreferrer"
            title={`${file.name} · ${megabytes(file.sizeBytes)}${file.source === 'github' ? ' · from GitHub' : ''}`}
            className="flex max-w-[12rem] items-center gap-1.5 rounded-md border border-edge bg-surface px-1.5 py-1 text-[11.5px] text-soft hover:border-link/60 hover:text-link"
          >
            {file.mediaType.startsWith('image/') ? (
              // Served by the console's own route, sandboxed and never sniffed.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/attachments/${encodeURIComponent(file.id)}`} alt="" className="size-7 shrink-0 rounded object-cover" />
            ) : (
              <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded bg-well text-[9px] uppercase text-dim">
                {/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? 'file'}
              </span>
            )}
            <span className="truncate">{file.name}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * What this item's design asked the repository to remember, and whether it is
 * in effect: proposed until a person answers the design's question or the
 * issue moves on to build. Corrected in Settings → Repositories.
 */
function DesignProposals({ entries }: { entries: readonly DesignMemoryEntry[] }) {
  return (
    <section aria-label="Design memory" className="flex flex-col gap-1 rounded-lg border border-edge bg-surface px-3 py-2 text-[12px]">
      <p className="font-medium text-soft">What its design asks the repository to remember</p>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <li key={entry.id} data-memory={entry.id} className="flex flex-wrap items-baseline gap-x-1.5 text-muted">
            <span className="text-dim">{KIND_WORDS[entry.kind]}:</span>
            <span className="text-body">{entry.title}</span>
            <span className={cn('text-[11px]', entry.state === 'accepted' ? 'text-signal' : entry.state === 'proposed' ? 'text-attention' : 'text-dim')}>
              · {entry.state === 'accepted' ? 'in effect' : entry.state}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LINE_TONE = { plain: 'text-soft', fail: 'text-alarm', done: 'text-signal' } as const;

/** The item's conversation, each entry headed by the role and seat that said it. */
export function Conversation({ entries, empty }: { entries: readonly ItemEntry[]; empty: string }) {
  if (entries.length === 0) return <p className="text-[12.5px] text-dim">{empty}</p>;
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'day') {
          return (
            <div key={entry.key} className="flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-dim">
              <span aria-hidden className="h-px flex-1 bg-edge" />
              {entry.label}
              <span aria-hidden className="h-px flex-1 bg-edge" />
            </div>
          );
        }
        if (entry.kind === 'line') {
          return (
            <div key={entry.key} className={cn('flex gap-2.5 text-[12.5px] leading-normal', LINE_TONE[entry.tone])}>
              <span className="w-9 shrink-0 text-dim">{entry.time}</span>
              <div className="min-w-0">
                <p className="flex items-start gap-1.5">
                  {entry.tone === 'fail' && <WarningIcon size={13} className="mt-[3px] shrink-0" />}
                  {entry.tone === 'done' && <CheckIcon size={13} className="mt-[3px] shrink-0" />}
                  <span>
                    <span className="text-dim">{entry.speaker}: </span>
                    {entry.text}
                  </span>
                </p>
                {entry.note && <Markdown text={entry.note} className="mt-0.5 text-[12px] text-muted" />}
              </div>
            </div>
          );
        }
        const open = Boolean(entry.question?.open);
        return (
          <div key={entry.key} data-entry-role={entry.role ?? ''} className="flex flex-col gap-1.5">
            <span className="text-[12px] text-dim">
              <span className="font-semibold text-body">{entry.speaker}</span>
              {entry.time && <> · {entry.time}</>}
              {entry.note && (
                <>
                  {' '}
                  · <span className={cn(open && 'font-medium text-attention')}>{entry.note}</span>
                </>
              )}
              {entry.url && (
                <>
                  {' '}
                  ·{' '}
                  <a href={entry.url} target="_blank" rel="noreferrer" className="hover:text-link">
                    on GitHub
                  </a>
                </>
              )}
            </span>
            <div
              className={cn(
                'rounded-lg px-3 py-2.5 text-[13px] leading-[1.55] text-body',
                entry.who === 'person' ? 'bg-well' : open ? 'border border-attention/50 bg-attention/5' : 'border border-edge bg-surface',
              )}
            >
              <Markdown text={entry.text} className={cn(entry.question && standsOut(entry.text) && 'font-semibold')} />
            </div>
          </div>
        );
      })}
    </>
  );
}

/** One task's computer or terminal, on its bot's sessions, its own session first. */
function TaskScreen({
  task,
  which,
  session,
  onAttach,
}: {
  task: ItemTask;
  which: 'computer' | 'terminal';
  /** A session chosen on the computer tab, to attach to instead of the task's own. */
  session?: string;
  onAttach?: (session: string) => void;
}) {
  const { sessions, reload, error } = useSessions(task.bot);
  const label = botLabel({ name: task.bot, slot: task.seat, role: task.role });
  return which === 'computer' ? (
    <ComputerTab
      bot={task.bot}
      label={label}
      sessions={sessions}
      onChanged={reload}
      session={task.tmuxSession}
      taskId={task.id}
      onAttach={onAttach}
      error={error}
    />
  ) : (
    <TerminalTab bot={task.bot} label={label} sessions={sessions} session={session ?? task.tmuxSession} error={error} />
  );
}
