'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { revertDesignMemory, updateDesignMemory } from '@/app/actions';
import { Button } from '@/components/ui/button';
import type { DesignMemoryEntry } from '@/lib/api';
import { cn } from '@/lib/cn';
import { safeAction } from '@/lib/safe-action';

/**
 * A repository's design memory, in Settings → Repositories: what the design
 * stage is told the repository has decided, its constraints, conventions and
 * words, every design task long. A summary nobody can correct is a mistake
 * repeated on every issue, so each entry can be reworded, accepted, retired,
 * or marked superseded by another. A design that superseded an entry did so
 * with nobody asked, so the entry that replaced it offers Revert. Each says
 * which design seat proposed it and links the comment it came from. The
 * record is the ADRs in the repository; an entry names the one it was written
 * in once its change merged.
 */

export const KIND_WORDS: Record<DesignMemoryEntry['kind'], string> = {
  decision: 'Decision',
  constraint: 'Constraint',
  convention: 'Convention',
  glossary: 'Term',
};

const STATE_WORDS: Record<DesignMemoryEntry['state'], string> = {
  proposed: 'Proposed',
  accepted: 'In effect',
  superseded: 'Superseded',
  retired: 'Retired',
};

const STATE_TONE: Record<DesignMemoryEntry['state'], string> = {
  proposed: 'bg-attention/12 text-attention',
  accepted: 'bg-signal/12 text-signal',
  superseded: 'bg-well text-dim',
  retired: 'bg-well text-dim',
};

/** Which entries are shown first: what is in effect and what waits, then the rest. */
export function memorySections(entries: readonly DesignMemoryEntry[]): { title: string; entries: DesignMemoryEntry[] }[] {
  const of = (...states: DesignMemoryEntry['state'][]) => entries.filter((entry) => states.includes(entry.state));
  return [
    { title: 'Waiting to be accepted', entries: of('proposed') },
    { title: 'In effect', entries: of('accepted') },
    { title: 'No longer in effect', entries: of('superseded', 'retired') },
  ].filter((section) => section.entries.length > 0);
}

export function DesignMemorySection({ repo, entries: initial }: { repo: string; entries: readonly DesignMemoryEntry[] }) {
  const [entries, setEntries] = useState<DesignMemoryEntry[]>([...initial]);
  const sections = memorySections(entries);
  const replace = (next: DesignMemoryEntry) => setEntries((all) => all.map((entry) => (entry.id === next.id ? next : entry)));
  return (
    <section aria-labelledby={`${repo}-memory`} className="flex flex-col gap-3 rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
      <div className="flex flex-col gap-0.5">
        <h4 id={`${repo}-memory`} className="text-[13px] font-semibold text-body">
          Design memory
        </h4>
        <span className="text-[12px] leading-snug text-muted">
          What the design stage is told this repository has decided, on every design task. Only the design proposes an
          entry, in its signed design comment, and it is in effect once you answer the design’s question or the issue
          moves on to build. One that replaces another says so on the issue and can be reverted here. Decisions are
          written up as ADRs under docs/adr/ in the repository.
        </span>
      </div>
      {sections.length === 0 && <p className="text-[12.5px] text-dim">Nothing yet. The first design on this repository starts it.</p>}
      {sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{section.title}</p>
          <ul className="flex flex-col gap-2">
            {section.entries.map((entry) => (
              <MemoryEntry
                key={entry.id}
                repo={repo}
                entry={entry}
                others={entries.filter((one) => one.id !== entry.id && one.state === 'accepted')}
                replaced={entries.find((one) => one.id === entry.supersedes && one.state === 'superseded') ?? null}
                onSaved={replace}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function MemoryEntry({
  repo,
  entry,
  others,
  replaced,
  onSaved,
}: {
  repo: string;
  entry: DesignMemoryEntry;
  /** What it could be marked superseded by. */
  others: readonly DesignMemoryEntry[];
  /** The entry this one took out of effect, while it is out: what Revert puts back. */
  replaced: DesignMemoryEntry | null;
  onSaved: (entry: DesignMemoryEntry) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  type Patch = Parameters<typeof updateDesignMemory>[1];

  /** Each write in turn, the next only once the last was taken; the first refusal is said. */
  const save = (...patches: Patch[]) => {
    setError(null);
    startTransition(async () => {
      for (const patch of patches) {
        const result = await safeAction(() => updateDesignMemory(repo, patch));
        if (!result.ok || !result.entry) return setError(result.error ?? 'that did not save');
        onSaved(result.entry);
      }
      setEditing(false);
    });
  };

  const revert = () => {
    setError(null);
    startTransition(async () => {
      const result = await safeAction(() => revertDesignMemory(repo, entry.id));
      if (!result.ok || !result.restored || !result.retired) return setError(result.error ?? 'that did not revert');
      onSaved(result.restored);
      onSaved(result.retired);
    });
  };

  // The form starts from what is saved: a cancelled edit stayed in it, and the
  // next Edit's Save wrote it into what every design task is given.
  const edit = (on: boolean) => {
    setTitle(entry.title);
    setBody(entry.body);
    setEditing(on);
  };

  return (
    <li data-memory={entry.id} className="flex flex-col gap-1.5 rounded-md border border-edge bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="rounded bg-well px-1.5 py-px font-medium text-soft">{KIND_WORDS[entry.kind]}</span>
        <span className={cn('rounded px-1.5 py-px font-medium', STATE_TONE[entry.state])}>{STATE_WORDS[entry.state]}</span>
        {entry.sourceSubject && (
          <Link href={`/?item=${encodeURIComponent(entry.sourceSubject)}`} className="text-link hover:underline">
            {entry.sourceSubject}
          </Link>
        )}
        {entry.adrPath && <span className="font-mono text-dim">{entry.adrPath}</span>}
        {entry.proposedBy && (
          <span className="text-dim">
            proposed by {entry.proposedBy}
            {entry.sourceUrl && (
              <>
                {' '}
                in{' '}
                <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
                  its design comment
                </a>
              </>
            )}
          </span>
        )}
        {!entry.proposedBy && entry.sourceUrl && (
          <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
            its design comment
          </a>
        )}
        {entry.decidedBy && <span className="text-dim">· {entry.decidedBy}</span>}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <input
            aria-label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-[13px] text-body"
          />
          <textarea
            aria-label="What it says"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            className="resize-y rounded-md border border-edge-strong bg-panel px-2 py-1.5 text-[12.5px] text-body"
          />
        </div>
      ) : (
        <>
          <p className="text-[13px] font-medium text-body">{entry.title}</p>
          <p className="whitespace-pre-wrap text-[12.5px] leading-normal text-soft">{entry.body}</p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {editing ? (
          <>
            <Button size="sm" variant="primary" disabled={pending || !title.trim() || !body.trim()} onClick={() => save({ id: entry.id, title, body })}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => edit(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={pending} onClick={() => edit(true)}>
              Edit
            </Button>
            {entry.state === 'proposed' && (
              <Button size="sm" disabled={pending} onClick={() => save({ id: entry.id, state: 'accepted' })}>
                Accept
              </Button>
            )}
            {entry.state === 'accepted' && replaced && (
              <Button size="sm" disabled={pending} onClick={revert} title={`Put “${replaced.title}” back in effect and retire this one`}>
                Revert
              </Button>
            )}
            {(entry.state === 'accepted' || entry.state === 'proposed') && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => save({ id: entry.id, state: 'retired' })}>
                Retire
              </Button>
            )}
            {entry.state === 'accepted' && (
              <label className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                Superseded by
                <select
                  value=""
                  disabled={pending}
                  onChange={(event) => {
                    const by = event.target.value;
                    if (!by) return;
                    // The replacement names what it replaces, then this one leaves
                    // effect. The second write was not waited for, and its refusal
                    // was never said. In this order a refusal of either is said
                    // here: once superseded, this entry moves to another list.
                    save(...(by !== '-' ? [{ id: by, supersedes: entry.id }] : []), { id: entry.id, state: 'superseded' });
                  }}
                  className="h-8 rounded-md border border-edge bg-panel px-1.5 text-[12px] text-soft"
                >
                  <option value="">…</option>
                  <option value="-">nothing in particular</option>
                  {others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {error && (
          <span role="alert" className="text-[12px] text-alarm">
            {error}
          </span>
        )}
      </div>
    </li>
  );
}
