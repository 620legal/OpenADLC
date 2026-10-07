'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { fileRequest } from '@/app/actions';
import { AttachmentDrop, type AttachmentState } from '@/components/attachment-drop';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { atStart, botLabel, type BotLabel } from '@/lib/bot-label';
import { useDraft } from '@/lib/draft';
import { safeAction } from '@/lib/safe-action';

const KINDS = ['feature', 'defect', 'chore', 'question'];

/** What was sent, as the confirmation says it. */
interface SentRequest {
  title: string;
  repo: string;
  bot: string;
  /** The request's own work item, `request:<id8>`; absent from an older bridge. */
  subject?: string;
  queued: boolean;
  position: number | null;
  paused?: string;
}

/** The first line of what was asked, as the request's title; the bridge titles its card the same. */
export function requestTitle(text: string): string {
  const line = text.split('\n').map((one) => one.trim()).find(Boolean) ?? 'A request';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** "Intake is on it", or its place in line when the bridge queued it. */
function whatNext(sent: Pick<SentRequest, 'queued' | 'position' | 'paused'>): string {
  if (!sent.queued) return 'Intake is on it';
  const place = sent.position ? `Queued (#${sent.position})` : 'Queued';
  return sent.paused ? `${place}: work is paused, so it starts when work resumes` : place;
}

export function IntakeDialog({
  repos,
  labelOf = (name) => botLabel({ name }),
  defaultRepo,
  children,
}: {
  repos: string[];
  /** The bot that took the request, as a person reads it: the bridge answers with its name. */
  labelOf?: (name: string) => BotLabel;
  /** The repository the board is showing, which a request is most likely for. */
  defaultRepo?: string;
  /** The button that opens it, where a page wants its own; one button element. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Kept across a reload: a request half written is not lost to a console
  // restarted under the tab.
  const [text, setText] = useDraft('intake:text');
  const [context, setContext] = useDraft('intake:context');
  const [repo, setRepo] = useState(defaultRepo && repos.includes(defaultRepo) ? defaultRepo : (repos[0] ?? ''));
  const [kind, setKind] = useState(KINDS[0]);
  const [result, setResult] = useState<string | null>(null);
  /**
   * What was sent: the dialog says so in place of the form, with where it went
   * and what happens next. Null while the form shows.
   */
  const [sent, setSent] = useState<SentRequest | null>(null);
  /** "Send & add another": the one just sent, said in a line above an empty form. */
  const [added, setAdded] = useState<SentRequest | null>(null);
  const [pending, startTransition] = useTransition();
  /** The files uploaded so far, and whether one is still on its way. */
  const [files, setFiles] = useState<AttachmentState>({ ids: [], busy: false });
  /** Bumped to empty the files after a send: the box starts again empty. */
  const [filesKey, setFilesKey] = useState(0);

  const clear = (): void => {
    setText('');
    setContext('');
    setResult(null);
    setFiles({ ids: [], busy: false });
    setFilesKey((key) => key + 1);
  };

  const submit = (andAnother = false): void => {
    startTransition(async () => {
      const title = requestTitle(text);
      const response = await safeAction(() =>
        fileRequest({ text, context, repo, kind, ...(files.ids.length > 0 ? { attachments: files.ids } : {}) }),
      );
      if (response.ok) {
        // Where its conversation is, not just a sentence about it: "watch the
        // Intake column" left somebody to find that themselves, and the
        // intake bot's thread mixed it with every other request, and each
        // request is its own conversation. Its own item, with the bot's thread
        // for an older bridge.
        const what: SentRequest = {
          title,
          repo,
          bot: response.bot ?? 'intake',
          ...(response.subject ? { subject: response.subject } : {}),
          queued: response.queued === true,
          position: response.position ?? null,
          ...(response.paused ? { paused: response.paused } : {}),
        };
        clear();
        if (andAnother) setAdded(what);
        else {
          setAdded(null);
          setSent(what);
        }
      } else {
        // The line said the last one went; this one did not.
        setAdded(null);
        setResult(response.error ?? 'could not file that');
      }
    });
  };

  const another = (): void => {
    clear();
    setSent(null);
    setAdded(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Opened again, it is a new request, not the last one's confirmation.
        if (!next) another();
      }}
    >
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm" variant="primary">
            + New request
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        {sent ? (
          <SentView sent={sent} said={labelOf(sent.bot).said} onAnother={another} />
        ) : (
          <>
            <DialogTitle>New request</DialogTitle>
            <DialogDescription>
              Say what you want and as much as you know: what it should do, who it is for, what done looks like. Add
              screenshots, mockups or documents. The intake bot asks about everything still missing, one question at a
              time, and files the issue once you have agreed what it says.
            </DialogDescription>

            {added && (
              <p role="status" className="mt-3 rounded-md border border-signal/40 bg-signal/10 px-2.5 py-1.5 text-[12px] text-signal">
                Sent: {added.title} → {added.repo || 'no repository'} · {whatNext(added)}.
              </p>
            )}

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-[11px] font-medium text-soft">What do you want changed?</span>
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={2}
                  placeholder="the board should show what a task has cost so far"
                  className="mt-1 w-full resize-none rounded-md border border-edge-strong bg-surface px-2.5 py-2 text-[12.5px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
                />
              </label>

              {/* The detail is the request's `context`, which triage reads as
                  its own section: the box that said "anything else" in two
                  rows read as optional, and requests arrived as one line. */}
              <label className="block">
                <span className="text-[11px] font-medium text-soft">Details</span>
                <textarea
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                  rows={6}
                  placeholder={'What should it do, and for whom? What does done look like?\nWhat should it look like (attach a screenshot or a mockup)? Anything it must not change?'}
                  className="mt-1 w-full resize-y rounded-md border border-edge-strong bg-surface px-2.5 py-2 text-[12.5px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
                />
              </label>

              <AttachmentDrop key={filesKey} onChange={setFiles} />

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[11px] font-medium text-soft">Repository</span>
                  <select
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                    className="mt-1 w-full rounded-md border border-edge-strong bg-surface px-2 py-1.5 text-[12.5px] text-body"
                  >
                    {repos.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-soft">Kind</span>
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                    className="mt-1 w-full rounded-md border border-edge-strong bg-surface px-2 py-1.5 text-[12.5px] text-body"
                  >
                    {KINDS.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="rounded-md border border-edge bg-surface p-2.5">
                <p className="text-[11px] font-medium text-soft">What happens after you send</p>
                <ol className="mt-1 space-y-0.5 text-[11px] text-muted">
                  <li>1. the intake bot reads it and looks for duplicates</li>
                  <li>2. it asks you about everything still missing, in this request’s own conversation</li>
                  <li>3. it files the issue on GitHub with the fields the dispatcher needs</li>
                  <li>4. design, build and review follow, and their questions come back here</li>
                </ol>
              </div>

              {result && <p className="text-[11px] text-attention">{result}</p>}
            </div>

            {/*
              * Before sending, the way out is "I will do this myself" — which is a
              * real choice and also the only close this had. Once sent, the
              * confirmation replaces all of this.
              */}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <DialogClose asChild>
                <Button size="sm" variant="ghost">
                  File on GitHub myself
                </Button>
              </DialogClose>
              <Button size="sm" variant="ghost" disabled={pending || files.busy || !text.trim()} onClick={() => submit(true)}>
                Send &amp; add another
              </Button>
              <Button size="sm" variant="primary" disabled={pending || files.busy || !text.trim()} onClick={() => submit()}>
                {pending ? 'Sending…' : files.busy ? 'Uploading…' : 'Send to intake'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The confirmation, in place of the form: what was sent and where, what
 * happens next, and the three things to do now.
 */
function SentView({ sent, said, onAnother }: { sent: SentRequest; said: string; onAnother: () => void }) {
  return (
    <div role="status" aria-label="Sent" className="flex flex-col gap-3">
      <DialogTitle>
        Sent: {sent.title} → {sent.repo || 'no repository'}
      </DialogTitle>
      <DialogDescription>
        {whatNext(sent)}. {atStart(said)} asks in this request’s own conversation if anything is missing, then files the issue.
      </DialogDescription>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <DialogClose asChild>
          <Button size="sm" variant="ghost">
            Close
          </Button>
        </DialogClose>
        <Button size="sm" variant="ghost" onClick={onAnother}>
          Send another
        </Button>
        <DialogClose asChild>
          {/* `Button` is a plain button, not a Radix slot, so the link carries
              the primary/sm styling itself. */}
          <a
            href={sent.subject ? `/?item=${encodeURIComponent(sent.subject)}` : `/?bot=${encodeURIComponent(sent.bot)}`}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-body px-2.5 text-xs font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
          >
            Open the conversation
          </a>
        </DialogClose>
      </div>
    </div>
  );
}
