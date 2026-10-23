// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPostgresView } from '@/lib/api';

vi.mock('@/app/actions', () => ({ saveTaskPostgres: vi.fn() }));
import { saveTaskPostgres } from '@/app/actions';
import { settingOf, TaskPostgresSection } from './task-postgres';

/** 620legal/core's local Postgres, as its docker-compose.yml and Makefile name it. */
const CORE = { port: 55432, superuser: 'core', password: 'core', database: 'core_db', image: 'pgvector/pgvector:pg16' };

function view(over: Partial<TaskPostgresView> = {}): TaskPostgresView {
  return {
    taskPostgres: null,
    unreadable: null,
    supported: { ok: true, why: null },
    images: ['pgvector/pgvector:<tag>', 'postgres:<tag>'],
    env: 'OPENADLC_TASK_POSTGRES',
    ...over,
  };
}

const html = (initial: TaskPostgresView) => renderToStaticMarkup(<TaskPostgresSection repo="core" initial={initial} />).replace(/<!-- -->/g, '');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(saveTaskPostgres).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Types into a field as a person does, so React sees the change. */
function type(label: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no field ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const button = (text: string) => [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === text)!;

describe('a repository’s Postgres servers for its tasks, in its settings', () => {
  it('shows each stored server with what it was given, and what the task is told', () => {
    const page = html(view({ taskPostgres: { servers: [CORE], sharedDatabase: false } }));

    expect(page).toContain('Postgres for its tasks');
    expect(page).toContain('value="55432"');
    expect(page).toContain('value="core_db"');
    expect(page).toContain('value="pgvector/pgvector:pg16"');
    expect(page).toContain('OPENADLC_TASK_POSTGRES');
  });

  it('says there are none, and what the tasks use instead', () => {
    expect(html(view())).toContain('None: its tasks use their database on the shared server, as DATABASE_URL.');
  });

  it('says when this install cannot give a task one, and why, rather than saving in silence', () => {
    const page = html(view({ supported: { ok: false, why: 'laptop runs the local driver, which has no containers to make a server in' } }));
    expect(page).toContain('This install cannot give a task one: laptop runs the local driver');
  });

  it('says a stored setting no longer reads, so it can be corrected', () => {
    expect(html(view({ unreadable: 'evil/pg:1 is not an image a task’s server may run' }))).toContain('What is stored no longer reads');
  });

  it('saves the servers a person typed, whole, and shows what the bridge then holds', async () => {
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [CORE], sharedDatabase: false } }) });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view()} />));

    await act(async () => button('Add a server').click());
    await act(async () => {
      type('Server 1 port', '55432');
      type('Server 1 superuser', 'core');
      type('Server 1 password', 'core');
      type('Server 1 database', 'core_db');
    });
    await act(async () => button('Save').click());

    expect(saveTaskPostgres).toHaveBeenCalledWith('core', { servers: [CORE], sharedDatabase: false });
    expect(container.textContent).toContain('Saved: the next task here gets them.');
  });

  it('keeps what was typed and says the bridge’s refusal, which says what to correct', async () => {
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: false, error: "someone/postgres:16 is not an image a task's server may run: use pgvector/pgvector:<tag> or postgres:<tag>" });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view({ taskPostgres: { servers: [CORE], sharedDatabase: false } })} />));

    await act(async () => type('Server 1 image', 'someone/postgres:16'));
    await act(async () => button('Save').click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Not saved: someone/postgres:16 is not an image');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Server 1 image"]')?.value).toBe('someone/postgres:16');
  });

  it('takes every server away when the last is removed and saved', async () => {
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view() });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view({ taskPostgres: { servers: [CORE], sharedDatabase: true } })} />));

    await act(async () => button('Remove').click());
    await act(async () => button('Save').click());

    expect(saveTaskPostgres).toHaveBeenCalledWith('core', { servers: [], sharedDatabase: true });
    expect(container.textContent).toContain('Saved: its tasks have no server of their own.');
  });

  it('sends a port that is not digits as typed, for the bridge to refuse with what to do', () => {
    const rows = [{ key: 1, ...CORE, port: 'five' }];
    expect(settingOf(rows, false).servers[0]?.port).toBe('five');
  });
});
