'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRole } from '@/components/app-header';
import { IntakeDialog } from '@/components/intake-dialog';
import { PAUSE_WORK, PauseForm } from '@/components/pause-work';
import { DialogTitle } from '@/components/ui/dialog';
import type { JumpItem, PaletteRead } from '@/lib/api';
import { labelIn } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { filterCommands, paletteCommands, rankJump, type PaletteCommand } from '@/lib/command-palette';
import type { HeaderData } from '@/lib/header';
import { isMac, isPaletteShortcut } from '@/lib/keys';

/** Where the palette reads the jump list and whether anything is paused, each time it opens. */
export const PALETTE_READ = '/api/palette';

/**
 * ⌘K (Ctrl+K off a Mac), on every page with the header: jump to a work item
 * by its key, number or title, go to a page, or act — file a request, pause
 * work, or go to where it resumes. Pressed again, or Esc, closes it.
 *
 * Mounted once by `AppShell`, with one listener in the capture phase, so the
 * shortcut reaches it while a text field has focus. The palette itself, and
 * what it reads, exist only while it is open: no page's read carries the jump
 * list (docs/adr/0029).
 */
export function CommandPalette({ data, repo = 'all' }: { data: HeaderData; repo?: string }) {
  const [open, setOpen] = useState(false);
  const [intake, setIntake] = useState(false);

  useEffect(() => {
    const mac = isMac(navigator as Navigator & { userAgentData?: { platform?: string } });
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event, mac)) return;
      // The browser's own ⌘K / Ctrl+K is its search bar.
      event.preventDefault();
      setOpen((was) => !was);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <>
      {open && (
        <Palette
          data={data}
          repo={repo}
          onClose={() => setOpen(false)}
          onNewRequest={() => {
            setOpen(false);
            setIntake(true);
          }}
        />
      )}
      {intake && (
        <IntakeDialog repos={data.repos} labelOf={(name) => labelIn(data.crew, name)} defaultRepo={repo} open onOpenChange={setIntake} />
      )}
    </>
  );
}

/** A row of the list: an item to open, or a command. */
type Row = { id: string; kind: 'item'; item: JumpItem } | { id: string; kind: 'command'; command: PaletteCommand };

const GROUPS: { key: 'items' | 'go' | 'act'; label: string }[] = [
  { key: 'items', label: 'Items' },
  { key: 'go', label: 'Go to' },
  { key: 'act', label: 'Act' },
];

function groupOf(row: Row): 'items' | 'go' | 'act' {
  return row.kind === 'item' ? 'items' : row.command.group;
}

function Palette({
  data,
  repo,
  onClose,
  onNewRequest,
}: {
  data: HeaderData;
  repo: string;
  onClose: () => void;
  onNewRequest: () => void;
}) {
  const router = useRouter();
  const role = useRole();
  const [query, setQuery] = useState('');
  const [read, setRead] = useState<PaletteRead | null>(null);
  const [active, setActive] = useState(0);
  const [pausing, setPausing] = useState(false);
  const base = useId();
  const listId = `${base}-list`;

  useEffect(() => {
    let live = true;
    void (async () => {
      const failed = (error: string): PaletteRead => ({ items: null, numbered: false, itemsError: error, paused: null });
      const answer = await fetch(PALETTE_READ, { cache: 'no-store' }).catch(() => null);
      let next: PaletteRead;
      if (!answer) next = failed('the console did not answer');
      else if (!answer.ok) {
        const body = (await answer.json().catch(() => null)) as { error?: unknown } | null;
        next = failed(typeof body?.error === 'string' ? body.error : `the console answered ${answer.status}`);
      } else next = ((await answer.json().catch(() => null)) as PaletteRead | null) ?? failed('the answer was not readable');
      if (live) setRead(next);
    })();
    return () => {
      live = false;
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const items = read?.items ? rankJump(read.items, query) : [];
    const commands = filterCommands(paletteCommands({ role, paused: read?.paused ?? null, repo }), query);
    return [
      ...items.map((item): Row => ({ id: `${base}-item-${item.number}`, kind: 'item', item })),
      ...commands.map((command): Row => ({ id: `${base}-${command.id}`, kind: 'command', command })),
    ];
  }, [read, query, role, repo, base]);
  const current = Math.min(active, Math.max(rows.length - 1, 0));
  const activeRow = rows[current];

  useEffect(() => {
    if (activeRow) document.getElementById(activeRow.id)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeRow]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  const run = (row: Row) => {
    if (row.kind === 'item') return go(`/items/${encodeURIComponent(row.item.key)}`);
    const { command } = row;
    if (command.group === 'go') return go(command.href);
    if (command.id === 'new-request') return onNewRequest();
    if (command.id === 'pause') return setPausing(true);
    // Resume goes to where resuming is chosen; it resumes nothing itself.
    if (command.id === 'resume') return go(PAUSE_WORK);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const last = rows.length - 1;
    if (event.key === 'ArrowDown') setActive(Math.min(current + 1, last));
    else if (event.key === 'ArrowUp') setActive(Math.max(current - 1, 0));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(Math.max(last, 0));
    else if (event.key === 'Enter') {
      if (activeRow) run(activeRow);
    } else return;
    event.preventDefault();
  };

  const loading = read === null;
  const itemCount = rows.filter((row) => row.kind === 'item').length;
  const status = loading ? 'Loading items…' : read.items ? `${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : '';
  const itemsNote =
    read && read.itemsError !== null
      ? `Couldn't load items: ${read.itemsError}. Go to and Act still work.`
      : read && read.items && !read.numbered
        ? 'Items are numbered once the history read finishes.'
        : null;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-surface/70 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-command-palette
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Esc in Pause work goes back to the list; from the list it closes.
            if (!pausing) return;
            event.preventDefault();
            setPausing(false);
          }}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-edge-strong bg-panel shadow-2xl"
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          {pausing ? (
            <div className="overflow-y-auto p-4 text-[12.5px]">
              <p className="mb-2 text-[13px] font-semibold text-body">Pause work</p>
              <PauseForm
                autoFocus
                repositories={data.repos.map((name) => ({ name, color: data.repoColors[name] ?? null }))}
                onPaused={() => {
                  onClose();
                  router.refresh();
                }}
              />
            </div>
          ) : (
            <>
              <input
                autoFocus
                role="combobox"
                aria-label="Search items, pages and actions"
                aria-expanded
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeRow?.id}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Jump to an item, go to a page, or act…"
                className="h-12 w-full shrink-0 border-b border-edge bg-transparent px-4 text-[14px] text-body outline-none placeholder:text-dim"
              />
              <p role="status" className="sr-only">
                {status}
              </p>
              <div id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {GROUPS.map((group) => {
                  const inGroup = rows.filter((row) => groupOf(row) === group.key);
                  const note = group.key === 'items' ? itemsNote : null;
                  if (inGroup.length === 0 && !note && !(group.key === 'items' && loading)) return null;
                  return (
                    <div key={group.key} role="group" aria-label={group.label} className="pb-1">
                      <p aria-hidden className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-dim">
                        {group.label}
                      </p>
                      {group.key === 'items' && loading && <p className="px-2.5 py-1.5 text-[12.5px] text-muted">Loading items…</p>}
                      {note && (
                        <p role={read?.itemsError !== null ? 'alert' : undefined} className="px-2.5 py-1.5 text-[12.5px] text-attention">
                          {note}
                        </p>
                      )}
                      {inGroup.map((row) => (
                        <div
                          key={row.id}
                          id={row.id}
                          role="option"
                          aria-selected={row === activeRow}
                          onMouseMove={() => setActive(rows.indexOf(row))}
                          onClick={() => run(row)}
                          className={cn(
                            'flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-body',
                            row === activeRow && 'bg-well',
                          )}
                        >
                          {row.kind === 'item' ? <ItemRow item={row.item} /> : row.command.label}
                        </div>
                      ))}
                    </div>
                  );
                })}
                {!loading && rows.length === 0 && !itemsNote && <p className="px-2.5 py-3 text-[12.5px] text-muted">Nothing matches.</p>}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ItemRow({ item }: { item: JumpItem }) {
  return (
    <>
      <span className="shrink-0 font-mono text-[12px] text-muted">{item.key}</span>
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {item.refs[0] && <span className="shrink-0 text-[11.5px] text-dim">{item.refs[0]}</span>}
      {!item.open && <span className="shrink-0 text-[11.5px] text-dim">closed</span>}
    </>
  );
}
