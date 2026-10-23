// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPostgresCompose, TaskPostgresView } from '@/lib/api';

vi.mock('@/app/actions', () => ({ saveTaskPostgres: vi.fn(), readTaskPostgresCompose: vi.fn() }));
import { readTaskPostgresCompose, saveTaskPostgres } from '@/app/actions';
import { settingOf, TaskPostgresSection } from './task-postgres';

/** 620legal/core's local Postgres, as its docker-compose.yml and Makefile name it. */
const CORE = { port: 55432, superuser: 'core', password: 'core', database: 'core_db', image: 'pgvector/pgvector:pg16' };

/** What the bridge reads from core's docker-compose.yml on main. */
const CORE_COMPOSE: TaskPostgresCompose = {
  ok: true,
  file: 'docker-compose.yml',
  branch: 'main',
  servers: [{ service: 'postgres', ...CORE, notes: [], refusal: null }],
  notes: [],
};
/** A repository with no Compose file. */
const NO_COMPOSE: TaskPostgresCompose = {
  ok: false,
  file: null,
  branch: 'main',
  why: '620legal/core has no Compose file on main: none of compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml',
};

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
  vi.mocked(readTaskPostgresCompose).mockReset().mockResolvedValue({ ok: true, compose: NO_COMPOSE });
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

  it('starts an added server empty, with examples that say they are examples, and sends what is empty as empty', async () => {
    const refusal = "server 1 has no port: give the port the repository's Makefile reaches it on";
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: false, error: refusal });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view()} />));

    await act(async () => button('Add a server').click());
    const field = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Server 1 ${name}"]`)!;
    for (const name of ['port', 'superuser', 'password', 'database']) {
      expect(field(name).value, name).toBe('');
      expect(field(name).placeholder, name).toMatch(/^e\.g\. \S/);
    }
    expect(field('port').placeholder).toBe('e.g. 55432');
    // The image starts as a value the person can see and edit, and its placeholder, once cleared, is an example too.
    expect(field('image').value).toBe('pgvector/pgvector:pg16');
    await act(async () => type('Server 1 image', ''));
    expect(field('image').placeholder).toBe('e.g. pgvector/pgvector:pg16');
    await act(async () => type('Server 1 image', 'pgvector/pgvector:pg16'));

    await act(async () => button('Save').click());
    expect(saveTaskPostgres).toHaveBeenCalledWith('core', {
      servers: [{ port: '', superuser: '', password: '', database: '', image: 'pgvector/pgvector:pg16' }],
      sharedDatabase: false,
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(`Not saved: ${refusal}`);
  });

  it('starts the shared-database box unticked for a new setting, and says a DATABASE_URL takes the place of the Makefile’s default', async () => {
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [CORE], sharedDatabase: false } }) });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view()} />));
    await act(async () => button('Add a server').click());

    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.closest('label')?.textContent).toContain('Also give each task its database on the shared server, as DATABASE_URL');
    expect(box.checked).toBe(false);
    // A flex column stretches its items: the label, and the click that ticks the box, took the whole line.
    expect(box.closest('label')?.parentElement?.className).toMatch(/\bflex-col\b/);
    expect(box.closest('label')?.className).toMatch(/\bself-start\b/);
    // A tick a browser restores on reload is one React keeps when it hydrates, whatever the setting holds.
    expect(box.getAttribute('autocomplete')).toBe('off');
    const said = document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(said).toContain('a DATABASE_URL takes the place of the Makefile’s own default (DATABASE_URL ?= …)');
    expect(said).toContain('Leave it off when the repository’s Makefile defaults its own');

    await act(async () => {
      type('Server 1 port', '55432');
      type('Server 1 superuser', 'core');
      type('Server 1 password', 'core');
      type('Server 1 database', 'core_db');
    });
    await act(async () => button('Save').click());
    expect(saveTaskPostgres).toHaveBeenCalledWith('core', { servers: [CORE], sharedDatabase: false });

    // A saved setting that holds it is shown as it holds it.
    expect(html(view({ taskPostgres: { servers: [CORE], sharedDatabase: true } }))).toMatch(/<input type="checkbox"[^>]* checked=""/);
    expect(html(view({ taskPostgres: { servers: [CORE], sharedDatabase: false } }))).not.toMatch(/<input type="checkbox"[^>]* checked=""/);
  });

  it('hydrates the box unticked when the setting holds it off, whatever tick the browser put on it before the page’s script ran', async () => {
    // The server renders it unticked, a tick is on it by the time React
    // hydrates, and React keeps the tick it finds until the section renders again.
    const initial = view({ taskPostgres: { servers: [CORE], sharedDatabase: false } });
    const page = document.createElement('div');
    document.body.appendChild(page);
    page.innerHTML = renderToString(<TaskPostgresSection repo="core" initial={initial} />);
    const restored = page.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    restored.checked = true;

    let hydrated: Root | null = null;
    await act(async () => {
      hydrated = hydrateRoot(page, <TaskPostgresSection repo="core" initial={initial} />);
    });
    const box = page.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box).toBe(restored);
    expect(box.checked).toBe(false);

    // Ticked by the person, it is ticked, and Save sends what it shows.
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [CORE], sharedDatabase: true } }) });
    await act(async () => box.click());
    expect(box.checked).toBe(true);
    await act(async () => [...page.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Save')!.click());
    expect(vi.mocked(saveTaskPostgres).mock.calls[0]?.[1]).toMatchObject({ sharedDatabase: true });
    act(() => hydrated?.unmount());
    page.remove();
  });

  it('hydrates the box ticked when the saved setting holds it, whatever the browser left on it', async () => {
    const initial = view({ taskPostgres: { servers: [CORE], sharedDatabase: true } });
    const page = document.createElement('div');
    document.body.appendChild(page);
    page.innerHTML = renderToString(<TaskPostgresSection repo="core" initial={initial} />);
    page.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = false;

    let hydrated: Root | null = null;
    await act(async () => {
      hydrated = hydrateRoot(page, <TaskPostgresSection repo="core" initial={initial} />);
    });
    expect(page.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    act(() => hydrated?.unmount());
    page.remove();
  });

  it('sends a port that is not digits as typed, for the bridge to refuse with what to do', () => {
    const rows = [{ key: 1, ...CORE, port: 'five' }];
    expect(settingOf(rows, false).servers[0]?.port).toBe('five');
  });
});

describe('filling it from the repository’s Compose file', () => {
  const field = (index: number, name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Server ${index} ${name}"]`);
  const valuesOf = (index: number) => ['port', 'superuser', 'password', 'database', 'image'].map((name) => field(index, name)?.value);

  it('starts a repository with nothing set filled from its docker-compose.yml, and saves nothing until Save', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({ ok: true, compose: CORE_COMPOSE });
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [CORE], sharedDatabase: false } }) });

    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view()} />));

    expect(readTaskPostgresCompose).toHaveBeenCalledWith('core');
    expect(valuesOf(1)).toEqual(['55432', 'core', 'core', 'core_db', 'pgvector/pgvector:pg16']);
    const status = container.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toContain('Filled from docker-compose.yml on main, its postgres service: check each server, then Save.');
    expect(status).toContain('Nothing is saved until you do.');
    expect(status).toContain('pinning one with @sha256:<digest> is optional');
    expect(saveTaskPostgres).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);

    await act(async () => button('Save').click());
    expect(saveTaskPostgres).toHaveBeenCalledWith('core', { servers: [CORE], sharedDatabase: false });
    expect(container.textContent).toContain('Saved: the next task here gets them.');
    expect(container.textContent).not.toContain('Nothing is saved until you do.');
  });

  it('starts a repository with a setting as it is stored, and fills from the file only when asked', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({ ok: true, compose: CORE_COMPOSE });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view({ taskPostgres: { servers: [{ ...CORE, port: 55499 }], sharedDatabase: false } })} />));

    expect(readTaskPostgresCompose).not.toHaveBeenCalled();
    expect(field(1, 'port')?.value).toBe('55499');

    await act(async () => button('Fill from docker-compose.yml').click());

    expect(readTaskPostgresCompose).toHaveBeenCalledWith('core');
    expect(valuesOf(1)).toEqual(['55432', 'core', 'core', 'core_db', 'pgvector/pgvector:pg16']);
    expect(field(2, 'port')).toBeNull();
    expect(saveTaskPostgres).not.toHaveBeenCalled();
  });

  it('starts a stored setting that no longer reads as it is, for the person to correct', async () => {
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view({ unreadable: 'evil/pg:1 is not an image' })} />));
    expect(readTaskPostgresCompose).not.toHaveBeenCalled();
  });

  it('shows an image outside the allowlist as the file writes it, with the refusal, and what is left to give', async () => {
    const refusal = "ankane/pgvector:latest is not an image a task's server may run: use pgvector/pgvector:<tag> or postgres:<tag>";
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({
      ok: true,
      compose: {
        ...CORE_COMPOSE,
        servers: [
          {
            service: 'db',
            ...CORE,
            password: '',
            image: 'ankane/pgvector:latest',
            notes: [{ field: 'password', text: "the file sets no POSTGRES_PASSWORD: give the one the repository's own database URLs use" }],
            refusal,
          },
        ],
      },
    });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view()} />));

    expect(field(1, 'image')?.value).toBe('ankane/pgvector:latest');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(`Save would refuse its image: ${refusal}`);
    const notes = container.querySelector('ul[aria-label="Server 1: what to check, from its db service"]');
    expect(notes?.textContent).toBe("Password: the file sets no POSTGRES_PASSWORD: give the one the repository's own database URLs use");

    await act(async () => type('Server 1 password', 'core'));
    expect(container.querySelector('ul[aria-label^="Server 1: what to check"]')).toBeNull();
    await act(async () => type('Server 1 image', 'pgvector/pgvector:pg16'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('says on the form a file with no Postgres service, and keeps what the form holds', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({
      ok: true,
      compose: { ok: false, file: 'docker-compose.yml', branch: 'main', why: 'docker-compose.yml has no Postgres service: none of its services runs pgvector/pgvector or postgres (cache (redis:7))' },
    });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view({ taskPostgres: { servers: [CORE], sharedDatabase: false } })} />));

    await act(async () => button('Fill from docker-compose.yml').click());

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Not filled: docker-compose.yml has no Postgres service: none of its services runs pgvector/pgvector or postgres (cache (redis:7))',
    );
    expect(valuesOf(1)).toEqual(['55432', 'core', 'core', 'core_db', 'pgvector/pgvector:pg16']);
  });

  it('says on the form a file it cannot read, first and when asked', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({
      ok: true,
      compose: { ok: false, file: 'docker-compose.yml', branch: 'main', why: 'docker-compose.yml does not read as YAML: Flow sequence in block collection must be sufficiently indented' },
    });
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view()} />));

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Not filled: docker-compose.yml does not read as YAML: Flow sequence in block collection must be sufficiently indented',
    );
    expect(container.textContent).toContain('None: its tasks use their database on the shared server');

    vi.mocked(readTaskPostgresCompose).mockResolvedValue({ ok: false, error: 'the bridge did not answer: it may be restarting' });
    await act(async () => button('Fill from docker-compose.yml').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Not filled from the repository's Compose file: the bridge did not answer: it may be restarting",
    );
  });

  it('leaves a form the person has begun when the first fill answers after', async () => {
    let answer: (value: Awaited<ReturnType<typeof readTaskPostgresCompose>>) => void = () => undefined;
    vi.mocked(readTaskPostgresCompose).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<TaskPostgresSection repo="core" initial={view()} />));
    expect(button('Reading the Compose file…').disabled).toBe(true);

    await act(async () => button('Add a server').click());
    await act(async () => type('Server 1 port', '6000'));
    await act(async () => answer({ ok: true, compose: CORE_COMPOSE }));

    expect(valuesOf(1)).toEqual(['6000', '', '', '', 'pgvector/pgvector:pg16']);
    expect(container.textContent).not.toContain('Filled from');
    expect(button('Fill from docker-compose.yml').disabled).toBe(false);
  });
});
