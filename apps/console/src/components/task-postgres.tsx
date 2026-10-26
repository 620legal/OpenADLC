'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { readTaskPostgresCompose, saveTaskPostgres } from '@/app/actions';
import { Button } from '@/components/ui/button';
import type { TaskPostgresComposeServer, TaskPostgresServer, TaskPostgresView } from '@/lib/api';
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
 *
 * The values are in the repository's own Compose file, so the form fills
 * itself from it for a repository with nothing set, and again on "Fill from
 * docker-compose.yml": a person checks them and saves, rather than typing
 * what the repository's file already said (v0.1.10). Filling saves nothing.
 */

/** A server as the form holds it: what was typed, port included. */
interface Row {
  key: number;
  port: string;
  superuser: string;
  password: string;
  database: string;
  image: string;
  /** Where it was filled from, and what to check in it; a field's notes go once the person changes it. */
  from?: { service: string; notes: TaskPostgresComposeServer['notes']; refusal: string | null };
}

type Field = keyof Omit<Row, 'key' | 'from'>;

const NEW_SERVER = { port: '', superuser: '', password: '', database: '', image: 'pgvector/pgvector:pg16' };
/**
 * Each placeholder says it is an example. Bare, in grey, a repository's
 * values read as a server already filled in: a person pressed Save on an
 * added row with nothing typed in it, and the bridge refused a port that
 * was not there (v0.1.9).
 */
const FIELDS: { field: Field; label: string; placeholder: string }[] = [
  { field: 'port', label: 'Port', placeholder: 'e.g. 55432' },
  { field: 'superuser', label: 'Superuser', placeholder: 'e.g. app' },
  { field: 'password', label: 'Password', placeholder: 'e.g. app' },
  { field: 'database', label: 'Database', placeholder: 'e.g. app_db' },
  { field: 'image', label: 'Image', placeholder: 'e.g. pgvector/pgvector:pg16' },
];
const IMAGE = FIELDS.find(({ field }) => field === 'image')!;

let nextKey = 1;
function rowsOf(view: TaskPostgresView): Row[] {
  return (view.taskPostgres?.servers ?? []).map((server) => ({ key: nextKey++, ...server, port: String(server.port) }));
}

/** A server the Compose file starts, as a row to check: its port empty where the file publishes none. */
function rowFrom({ service, port, notes, refusal, ...server }: TaskPostgresComposeServer): Row {
  return { key: nextKey++, ...server, port: port === null ? '' : String(port), from: { service, notes, refusal } };
}

/** What a save sends: the port as typed, which the bridge reads as digits or refuses. */
export function settingOf(rows: readonly Row[], sharedDatabase: boolean): { servers: TaskPostgresServer[]; sharedDatabase: boolean } {
  return {
    servers: rows.map(({ key: _key, from: _from, port, ...rest }) => ({ ...rest, port: /^\d+$/.test(port.trim()) ? Number(port.trim()) : (port as unknown as number) })),
    sharedDatabase,
  };
}

const LABELS: Readonly<Record<Field, string>> = { port: 'Port', superuser: 'Superuser', password: 'Password', database: 'Database', image: 'Image' };

/** The services a fill took, as a person reads them: "its postgres service". */
function servicesOf(servers: readonly TaskPostgresComposeServer[]): string {
  const names = servers.map((server) => server.service);
  const listed = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `its ${listed} service${names.length === 1 ? '' : 's'}`;
}

export function TaskPostgresSection({ repo, initial }: { repo: string; initial: TaskPostgresView }) {
  const [view, setView] = useState(initial);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(initial));
  const [shared, setShared] = useState(initial.taskPostgres?.sharedDatabase ?? false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  /** What the last fill from the Compose file said; `asked` when a person pressed for it. */
  const [filled, setFilled] = useState<{ ok: boolean; text: string; notes: string[]; asked: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  /** Whether the person has changed the form, which a fill they did not ask for then leaves alone. */
  const touched = useRef(false);
  const firstFill = useRef(false);
  const box = useRef<HTMLInputElement>(null);
  const id = `${repo}-task-postgres`;

  const change = (key: number, field: Field, value: string) => {
    setSaid(null);
    touched.current = true;
    setRows((all) =>
      all.map((row) => {
        if (row.key !== key) return row;
        // A note about a field, or the refusal of an image, was about what the file said, not what is typed now.
        const from = row.from && {
          ...row.from,
          notes: row.from.notes.filter((note) => note.field !== field),
          refusal: field === 'image' ? null : row.from.refusal,
        };
        return { ...row, [field]: value, ...(from ? { from } : {}) };
      }),
    );
  };

  /**
   * Fills the servers from the repository's Compose file, replacing those on
   * the form; nothing is saved. Unasked — the first state of a repository
   * with nothing set — it leaves a form the person has already changed.
   */
  const fill = (asked: boolean) => {
    if (asked) setSaid(null);
    setReading(true);
    void safeAction(() => readTaskPostgresCompose(repo)).then((result) => {
      setReading(false);
      if (!asked && touched.current) return;
      const compose = result.compose;
      if (!result.ok || !compose) return setFilled({ ok: false, text: `Not filled from the repository's Compose file: ${result.error ?? 'the bridge did not answer'}`, notes: [], asked });
      if (!compose.ok) return setFilled({ ok: false, text: `Not filled: ${compose.why}`, notes: [], asked });
      setRows(compose.servers.map(rowFrom));
      setFilled({
        ok: true,
        text:
          `Filled from ${compose.file} on ${compose.branch}, ${servicesOf(compose.servers)}: check each server, then Save. ` +
          'Nothing is saved until you do. Each image is as the file writes it; pinning one with @sha256:<digest> is optional.',
        notes: compose.notes,
        asked,
      });
    });
  };

  // A repository with nothing set starts filled from its Compose file; one
  // with a setting, or one that no longer reads, starts as it is stored.
  useEffect(() => {
    if (firstFill.current || initial.taskPostgres || initial.unreadable) return;
    firstFill.current = true;
    fill(false);
    // Once, on the first render: a later fill is the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The box shows what the state holds, which is what Save sends, from
  // hydration on. React keeps the tick a box has when it hydrates, so a tick
  // a browser restored before the script ran stayed on screen, while Save
  // sent false, until the section next rendered. `autoComplete="off"` asks a
  // browser not to restore one; this holds when one does anyway.
  useEffect(() => {
    if (box.current && box.current.checked !== shared) box.current.checked = shared;
  }, [shared]);

  const save = () => {
    setSaid(null);
    touched.current = true;
    startTransition(async () => {
      const result = await safeAction(() => saveTaskPostgres(repo, settingOf(rows, shared)));
      if (!result.ok || !result.view) return setSaid({ ok: false, text: result.error ?? 'the bridge refused it' });
      setView(result.view);
      setRows(rowsOf(result.view));
      setShared(result.view.taskPostgres?.sharedDatabase ?? false);
      // What the fill said to check was before the save; the form is now what is stored.
      setFilled(null);
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

      {filled && (
        <div role={filled.ok || !filled.asked ? 'status' : 'alert'} className={cn('flex flex-col gap-1 text-[12px] leading-normal', filled.ok || !filled.asked ? 'text-dim' : 'text-alarm')}>
          <p>{filled.text}</p>
          {filled.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
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
                  {IMAGE.label}
                  <input
                    aria-label={`Server ${index + 1} image`}
                    value={row.image}
                    placeholder={IMAGE.placeholder}
                    list={`${id}-images`}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => change(row.key, 'image', event.target.value)}
                    className="h-9 rounded-md border border-edge-strong bg-panel px-2 font-mono text-[12.5px] text-body md:h-8"
                  />
                </label>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                    setSaid(null);
                    touched.current = true;
                    setRows((all) => all.filter((one) => one.key !== row.key));
                  }}>
                  Remove
                </Button>
              </div>
              {row.from && (row.from.notes.length > 0 || row.from.refusal) && (
                <div className="flex flex-col gap-1 text-[11.5px] leading-snug">
                  {row.from.notes.length > 0 && (
                    <ul aria-label={`Server ${index + 1}: what to check, from its ${row.from.service} service`} className="flex flex-col gap-0.5 text-dim">
                      {row.from.notes.map((note) => (
                        <li key={`${note.field}:${note.text}`}>
                          {note.field ? `${LABELS[note.field]}: ` : ''}
                          {note.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  {row.from.refusal && (
                    <p role="alert" className="rounded-md bg-alarm/10 px-2 py-1.5 text-alarm">
                      Save would refuse its image: {row.from.refusal}
                    </p>
                  )}
                </div>
              )}
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

      <div className="flex flex-col gap-1">
        {/* Only the box and its words take a click. A column stretches its items, so
            the label spanned the form, and a click anywhere on its line ticked the box.
            On v0.1.10 it showed ticked with nothing saved, after an added server and a
            refused Save, each of which puts the state back on the box: a click had
            ticked it, and this line is where one lands without meaning to. */}
        <label className="inline-flex items-center gap-2 self-start text-[12.5px] text-soft">
          {/* autoComplete off: a browser restores a box's tick on reload or Back, and
              React keeps the tick it finds when it hydrates, so a tick never saved
              would show as though the setting held it, while Save sent false. */}
          <input ref={box} type="checkbox" checked={shared} disabled={pending} autoComplete="off" aria-describedby={`${id}-shared`} onChange={(event) => {
              setSaid(null);
              touched.current = true;
              setShared(event.target.checked);
            }} />
          Also give each task its database on the shared server, as DATABASE_URL
        </label>
        <p id={`${id}-shared`} className="pl-6 text-[11.5px] leading-snug text-dim">
          Leave it off when the repository’s Makefile defaults its own: a DATABASE_URL takes the place of the
          Makefile’s own default (DATABASE_URL ?= …), and what reads it reaches the shared server, not the servers above.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => {
            setSaid(null);
            touched.current = true;
            setRows((all) => [...all, { key: nextKey++, ...NEW_SERVER }]);
          }}>
          Add a server
        </Button>
        <Button size="sm" disabled={pending || reading} onClick={() => fill(true)}>
          {reading ? 'Reading the Compose file…' : 'Fill from docker-compose.yml'}
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
