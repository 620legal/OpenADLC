'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CloseIcon } from '@/components/icons';
import { ACCEPT, megabytes, refusalFor, WHERE_FILES_GO } from '@/lib/attachments';
import { cn } from '@/lib/cn';

/** A file the bridge took, as it answered. */
export interface Uploaded {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
}

interface Entry {
  key: string;
  name: string;
  size: number;
  /** An object URL for an image's thumbnail, freed when the entry goes. */
  preview: string | null;
  state: 'uploading' | 'done' | 'error';
  /** 0 to 1, while it uploads. */
  progress: number;
  error?: string;
  uploaded?: Uploaded;
}

/** What the box holds, for the form around it: the ids to send, and whether anything is still on its way. */
export interface AttachmentState {
  ids: string[];
  busy: boolean;
}

/**
 * Sends one file to the console's upload route, saying how far it has got.
 * XMLHttpRequest and not fetch: fetch says nothing of an upload's progress,
 * and a 9 MB screenshot on a slow line with no sign of movement looks stuck.
 */
function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/attachments');
    request.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let body: { attachment?: Uploaded; error?: string } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        // Said below, with the status.
      }
      if (request.status >= 200 && request.status < 300 && body.attachment) resolve(body.attachment);
      else reject(new Error(body.error ?? `${file.name} was not taken (${request.status})`));
    };
    request.onerror = () => reject(new Error(`${file.name} did not reach the console; try again`));
    request.send(file);
  });
}

/**
 * Where files are given with a request or a message: dropped on it, pasted
 * (a screenshot straight from the clipboard), or picked. Each uploads at once,
 * with its own progress, a thumbnail for an image, and a reason naming the
 * file when it is not taken; the form sends the ids it got back.
 *
 * Remounted (`key`) by the form to start empty after a send.
 */
export function AttachmentDrop({
  onChange,
  compact = false,
  upload = uploadFile,
}: {
  onChange: (state: AttachmentState) => void;
  /** One line under a message box, rather than a drop area of its own. */
  compact?: boolean;
  /** How a file is sent; a test gives its own. */
  upload?: typeof uploadFile;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const inputId = useId();
  // Read through a ref: a parent passing a new function on every render must
  // not make this tell it again, which re-rendered the parent, and so on.
  const changed = useRef(onChange);
  changed.current = onChange;
  const live = useRef(entries);
  live.current = entries;

  useEffect(() => {
    changed.current({
      ids: entries.flatMap((entry) => (entry.state === 'done' && entry.uploaded ? [entry.uploaded.id] : [])),
      busy: entries.some((entry) => entry.state === 'uploading'),
    });
  }, [entries]);

  // Thumbnails are object URLs, which hold the image until they are let go.
  useEffect(
    () => () => {
      for (const entry of live.current) if (entry.preview) URL.revokeObjectURL(entry.preview);
    },
    [],
  );

  const update = (key: string, patch: Partial<Entry>) =>
    setEntries((all) => all.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));

  const add = (files: readonly File[]): void => {
    const held = live.current.filter((entry) => entry.state !== 'error');
    let count = held.length;
    let bytes = held.reduce((total, entry) => total + entry.size, 0);
    const added: Entry[] = [];
    const sending: { key: string; file: File }[] = [];
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      const refusal = refusalFor(file, { count, bytes });
      const preview = !refusal && file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
      added.push({ key, name: file.name, size: file.size, preview, state: refusal ? 'error' : 'uploading', progress: 0, ...(refusal ? { error: refusal } : {}) });
      if (refusal) continue;
      count += 1;
      bytes += file.size;
      sending.push({ key, file });
    }
    // Listed before any upload starts, so its first progress has an entry to land on.
    setEntries((all) => [...all, ...added]);
    for (const { key, file } of sending) {
      void upload(file, (progress) => update(key, { progress }))
        .then((uploaded) => update(key, { state: 'done', progress: 1, uploaded }))
        .catch((error: unknown) => update(key, { state: 'error', error: error instanceof Error ? error.message : `${file.name} was not taken` }));
    }
  };

  // A screenshot pasted anywhere in the form this box is part of.
  useEffect(() => {
    const scope: Element | Document = zone.current?.closest('[role="dialog"], form, aside') ?? document;
    const onPaste = (event: Event) => {
      const files = [...((event as ClipboardEvent).clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      add(files);
    };
    scope.addEventListener('paste', onPaste);
    return () => scope.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = (key: string) =>
    setEntries((all) => {
      const gone = all.find((entry) => entry.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return all.filter((entry) => entry.key !== key);
    });

  return (
    <div
      ref={zone}
      data-attachments
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setOver(false);
        add([...event.dataTransfer.files]);
      }}
      className={cn(
        'flex flex-col gap-2 rounded-md text-[12px]',
        !compact && 'border border-dashed px-3 py-2.5',
        !compact && (over ? 'border-link bg-link/5' : 'border-edge-strong'),
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <button type="button" onClick={() => picker.current?.click()} className="text-link hover:underline">
          {compact ? 'Attach files' : 'Add files'}
        </button>
        {!compact && <span>or drop or paste screenshots, mockups and documents here</span>}
        <input
          ref={picker}
          id={inputId}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            add([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </div>
      {!compact && <p className="text-[11px] text-dim">{WHERE_FILES_GO}</p>}
      {entries.length > 0 && (
        <ul aria-label="Attached files" className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li key={entry.key} data-file={entry.name} data-state={entry.state} className="flex items-center gap-2">
              {entry.preview ? (
                // A local object URL, never a remote one.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={entry.preview} alt="" className="size-8 shrink-0 rounded border border-edge object-cover" />
              ) : (
                <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded border border-edge bg-surface text-[9px] uppercase text-dim">
                  {/\.([a-z0-9]+)$/i.exec(entry.name)?.[1] ?? 'file'}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-soft" title={entry.name}>
                  {entry.name} <span className="text-dim">· {megabytes(entry.size)}</span>
                </span>
                {entry.state === 'uploading' && (
                  <span role="progressbar" aria-valuenow={Math.round(entry.progress * 100)} aria-valuemin={0} aria-valuemax={100} className="h-1 w-full overflow-hidden rounded bg-well">
                    <span className="block h-full bg-link transition-[width]" style={{ width: `${Math.round(entry.progress * 100)}%` }} />
                  </span>
                )}
                {entry.state === 'error' && (
                  <span role="alert" className="text-alarm">
                    {entry.error}
                  </span>
                )}
              </div>
              <button
                type="button"
                aria-label={`Remove ${entry.name}`}
                onClick={() => remove(entry.key)}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded text-muted hover:bg-well hover:text-body"
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
