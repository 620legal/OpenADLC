'use client';

import { useState, useTransition } from 'react';
import { saveTaskPostgres } from '@/app/actions';
import { Button } from '@/components/ui/button';
import type { TaskPostgresServer, TaskPostgresView } from '@/lib/api';
import { cn } from '@/lib/cn';
import { safeAction } from '@/lib/safe-action';

/**
 * A repository's Postgres servers for its tasks, in Settings → Repositories:
 * for a repository whose checks need a server of their own — their own
 * superuser, server-wide roles its migrations make, the port its Makefile
 * defaults to — which a database on the shared task server cannot be. Each
 * task gets its own, in its computer, reachable from nothing else, and gone
 * with it. The values are the repository's local-development defaults.
 *
 * Saved whole with Save, unlike the controls above, which save as they
 * change: a server half typed in would reach the next task. What the bridge
 * refuses is said here with what to correct, and the form keeps what was
 * typed.
 */

/** A server as the form holds it: what was typed, port included. */
interface Row {
  key: number;
  port: string;
  superuser: string;
  password: string;
  database: string;
  image: string;
}

const NEW_SERVER = { port: '', superuser: '', password: '', database: '', image: 'pgvector/pgvector:pg16' };
const FIELDS: { field: keyof Omit<Row, 'key'>; label: string; placeholder: string }[] = [
  { field: 'port', label: 'Port', placeholder: '55432' },
  { field: 'superuser', label: 'Superuser', placeholder: 'core' },
  { field: 'password', label: 'Password', placeholder: 'core' },
  { field: 'database', label: 'Database', placeholder: 'core_db' },
  { field: 'image', label: 'Image', placeholder: 'pgvector/pgvector:pg16' },
];

let nextKey = 1;
function rowsOf(view: TaskPostgresView): Row[] {
  return (view.taskPostgres?.servers ?? []).map((server) => ({ key: nextKey++, ...server, port: String(server.port) }));
}

/** What a save sends: the port as typed, which the bridge reads as digits or refuses. */
export function settingOf(rows: readonly Row[], sharedDatabase: boolean): { servers: TaskPostgresServer[]; sharedDatabase: boolean } {
  return {
    servers: rows.map(({ key: _key, port, ...rest }) => ({ ...rest, port: /^\d+$/.test(port.trim()) ? Number(port.trim()) : (port as unknown as number) })),
    sharedDatabase,
  };
}

export function TaskPostgresSection({ repo, initial }: { repo: string; initial: TaskPostgresView }) {
  const [view, setView] = useState(initial);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(initial));
  const [shared, setShared] = useState(initial.taskPostgres?.sharedDatabase ?? false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const id = `${repo}-task-postgres`;

  const change = (key: number, field: keyof Omit<Row, 'key'>, value: string) => {
    setSaid(null);
    setRows((all) => all.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  };

  const save = () => {
    setSaid(null);
    startTransition(async () => {
      const result = await safeAction(() => saveTaskPostgres(repo, settingOf(rows, shared)));
      if (!result.ok || !result.view) return setSaid({ ok: false, text: result.error ?? 'the bridge refused it' });
      setView(result.view);
      setRows(rowsOf(result.view));
      setShared(result.view.taskPostgres?.sharedDatabase ?? false);
      setSaid({ ok: true, text: result.view.taskPostgres ? 'Saved: the next task here gets them.' : 'Saved: its tasks have no server of their own.' });
    });
  };

  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
      <div className="flex flex-col gap-0.5">
        <h4 id={id} className="text-[13px] font-semibold text-body">
          Postgres for its tasks
        </h4>
        <span className="text-[12px] leading-snug text-muted">
          For checks that need a Postgres server of their own: their own superuser, roles their migrations make, the
          port the Makefile defaults to. Each task that runs checks gets its own server in its computer, at
          127.0.0.1 on the port given here, reachable from nothing else and removed with the computer, in place of its
          database on the shared server. The task is told as {view.env}, so the Makefile’s db target can skip
          starting one itself. Give the repository’s local-development defaults: only that task can reach them.
        </span>
      </div>

      {view.supported.ok === false && (
        <p role="alert" className="rounded-md bg-alarm/10 px-2.5 py-2 text-[12px] leading-normal text-alarm">
          This install cannot give a task one: {view.supported.why}
        </p>
      )}
      {view.supported.ok === null && view.supported.why && <p className="text-[12px] leading-normal text-dim">{view.supported.why}</p>}
      {view.unreadable && (
        <p role="alert" className="rounded-md bg-alarm/10 px-2.5 py-2 text-[12px] leading-normal text-alarm">
          What is stored no longer reads, and its tasks will not start until it is corrected: {view.unreadable}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-[12.5px] text-dim">None: its tasks use their database on the shared server, as DATABASE_URL.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <li key={row.key} data-server={index + 1} className="flex flex-col gap-2 rounded-md border border-edge bg-surface px-3 py-2.5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-[5rem_1fr_1fr_1fr]">
                {FIELDS.filter(({ field }) => field !== 'image').map(({ field, label, placeholder }) => (
                  <label key={field} className="flex flex-col gap-1 text-[11.5px] text-muted">
                    {label}
                    <input
                      aria-label={`Server ${index + 1} ${label.toLowerCase()}`}
                      value={row[field]}
                      placeholder={placeholder}
                      inputMode={field === 'port' ? 'numeric' : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => change(row.key, field, event.target.value)}
                      className="h-9 rounded-md border border-edge-strong bg-panel px-2 font-mono text-[12.5px] text-body md:h-8"
                    />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-[11.5px] text-muted">
                  Image
                  <input
                    aria-label={`Server ${index + 1} image`}
                    value={row.image}
                    placeholder="pgvector/pgvector:pg16"
                    list={`${id}-images`}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => change(row.key, 'image', event.target.value)}
                    className="h-9 rounded-md border border-edge-strong bg-panel px-2 font-mono text-[12.5px] text-body md:h-8"
                  />
                </label>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                    setSaid(null);
                    setRows((all) => all.filter((one) => one.key !== row.key));
                  }}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <datalist id={`${id}-images`}>
        <option value="pgvector/pgvector:pg16" />
        <option value="pgvector/pgvector:pg17" />
        <option value="postgres:16" />
        <option value="postgres:17" />
      </datalist>
      <p className="text-[11.5px] leading-snug text-dim">
        Images: {view.images.join(' or ')}, pinned by adding @sha256:&lt;digest&gt; if you want the same server on every task.
      </p>

      <label className="inline-flex items-center gap-2 text-[12.5px] text-soft">
        <input type="checkbox" checked={shared} disabled={pending} onChange={(event) => {
            setSaid(null);
            setShared(event.target.checked);
          }} />
        Also give each task its database on the shared server, as DATABASE_URL
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => {
            setSaid(null);
            setRows((all) => [...all, { key: nextKey++, ...NEW_SERVER }]);
          }}>
          Add a server
        </Button>
        <Button size="sm" variant="primary" disabled={pending} onClick={save}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {said && (
          <span role={said.ok ? 'status' : 'alert'} className={cn('text-[12px]', said.ok ? 'text-dim' : 'text-alarm')}>
            {said.ok ? said.text : `Not saved: ${said.text}`}
          </span>
        )}
      </div>
    </section>
  );
}
