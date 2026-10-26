// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPostgresCompose, TaskPostgresView } from '@/lib/api';

vi.mock('@/app/actions', () => ({ saveTaskPostgres: vi.fn(), readTaskPostgresCompose: vi.fn() }));
import { readTaskPostgresCompose, saveTaskPostgres } from '@/app/actions';
import { settingOf, TaskPostgresSection } from './task-postgres';

/** acme/app's local Postgres, as its docker-compose.yml and Makefile name it. */
const APP = { port: 55432, superuser: 'app', password: 'app', database: 'app_db', image: 'pgvector/pgvector:pg16' };

/** What the bridge reads from app's docker-compose.yml on main. */
const APP_COMPOSE: TaskPostgresCompose = {
  ok: true,
  file: 'docker-compose.yml',
  branch: 'main',
  servers: [{ service: 'postgres', ...APP, notes: [], refusal: null }],
  notes: [],
};
/** A repository with no Compose file. */
const NO_COMPOSE: TaskPostgresCompose = {
  ok: false,
  file: null,
  branch: 'main',
  why: 'acme/app has no Compose file on main: none of compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml',
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

const html = (initial: TaskPostgresView) => renderToStaticMarkup(<TaskPostgresSection repo="app" initial={initial} />).replace(/<!-- -->/g, '');
/** Which DATABASE_URL choice a rendered page shows, by its value. */
const chosenIn = (page: string) => [...page.matchAll(/<input type="radio"[^>]*>/g)].find(([tag]) => tag.includes(' checked=""'))?.[0].match(/value="([^"]+)"/)?.[1] ?? null;

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
const radios = () => [...container.querySelectorAll<HTMLInputElement>('fieldset input[type="radio"]')];
const choiceTexts = () => radios().map((radio) => radio.closest('label')?.textContent?.trim());
/** Which DATABASE_URL choice the form shows, by its value: none, shared or server. */
const chosen = () => radios().find((radio) => radio.checked)?.value ?? null;
/** Chooses as a person does, by clicking it. */
const choose = (value: string) => radios().find((radio) => radio.value === value)!.click();
/** Picks the server DATABASE_URL comes from, by its place in the list. */
function pick(index: number): void {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="The server DATABASE_URL comes from"]')!;
  select.value = String(index);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('a repository’s Postgres servers for its tasks, in its settings', () => {
  it('shows each stored server with what it was given, and what the task is told', () => {
    const page = html(view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } }));

    expect(page).toContain('Postgres for its tasks');
    expect(page).toContain('value="55432"');
    expect(page).toContain('value="app_db"');
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
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } }) });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view()} />));

    await act(async () => button('Add a server').click());
    await act(async () => {
      type('Server 1 port', '55432');
      type('Server 1 superuser', 'app');
      type('Server 1 password', 'app');
      type('Server 1 database', 'app_db');
    });
    await act(async () => button('Save').click());

    expect(saveTaskPostgres).toHaveBeenCalledWith('app', { servers: [APP], databaseUrl: 'none' });
    expect(container.textContent).toContain('Saved: the next task here gets them.');
  });

  it('keeps what was typed and says the bridge’s refusal, which says what to correct', async () => {
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: false, error: "someone/postgres:16 is not an image a task's server may run: use pgvector/pgvector:<tag> or postgres:<tag>" });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } })} />));

    await act(async () => type('Server 1 image', 'someone/postgres:16'));
    await act(async () => button('Save').click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Not saved: someone/postgres:16 is not an image');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Server 1 image"]')?.value).toBe('someone/postgres:16');
  });

  it('takes every server away when the last is removed and saved', async () => {
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view() });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [APP], databaseUrl: 'shared' } })} />));

    await act(async () => button('Remove').click());
    await act(async () => button('Save').click());

    expect(saveTaskPostgres).toHaveBeenCalledWith('app', { servers: [], databaseUrl: 'shared' });
    expect(container.textContent).toContain('Saved: its tasks have no server of their own.');
  });

  it('starts an added server empty, with examples that say they are examples, and sends what is empty as empty', async () => {
    const refusal = "server 1 has no port: give the port the repository's Makefile reaches it on";
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: false, error: refusal });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view()} />));

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
    expect(saveTaskPostgres).toHaveBeenCalledWith('app', {
      servers: [{ port: '', superuser: '', password: '', database: '', image: 'pgvector/pgvector:pg16' }],
      databaseUrl: 'none',
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(`Not saved: ${refusal}`);
  });

  it('offers three choices of DATABASE_URL, none until a person chooses, and says it takes the place of the Makefile’s default', async () => {
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } }) });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view()} />));
    expect(container.querySelector('fieldset')).toBeNull();
    await act(async () => button('Add a server').click());

    const fieldset = container.querySelector('fieldset')!;
    expect(fieldset.querySelector('legend')?.textContent).toBe('Each task’s DATABASE_URL');
    expect(choiceTexts()).toEqual([
      'None, so the Makefile’s own default applies',
      'Its database on the shared server, a plain role that cannot make roles',
      'One of the servers above, as its superuser',
    ]);
    expect(chosen()).toBe('none');
    for (const radio of radios()) {
      // A flex column stretches its items: a label, and the click that chooses it, took the whole line.
      expect(radio.closest('label')?.className).toMatch(/\bself-start\b/);
      // A choice a browser restores on reload is one React keeps when it hydrates, whatever the setting holds.
      expect(radio.getAttribute('autocomplete')).toBe('off');
    }
    const said = document.getElementById(fieldset.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(said).toContain('A DATABASE_URL takes the place of the Makefile’s own default (DATABASE_URL ?= …)');

    await act(async () => {
      type('Server 1 port', '55432');
      type('Server 1 superuser', 'app');
      type('Server 1 password', 'app');
      type('Server 1 database', 'app_db');
    });
    await act(async () => button('Save').click());
    expect(saveTaskPostgres).toHaveBeenCalledWith('app', { servers: [APP], databaseUrl: 'none' });
  });

  it('shows a stored choice as it is stored, a server of its own by its port, and its URL without the password', () => {
    const vectors = { ...APP, port: 55433, password: 'vectors-local', database: 'vectors' };
    const page = html(view({ taskPostgres: { servers: [APP, vectors], databaseUrl: { port: 55433 } } }));

    expect(chosenIn(page)).toBe('server');
    expect(page).toMatch(/<option value="1" selected="">Server 2 \(127\.0\.0\.1:55433\)<\/option>/);
    expect(page).toContain('The task gets <span class="font-mono">postgres://app:&lt;its password&gt;@127.0.0.1:55433/vectors</span>');
    expect(chosenIn(html(view({ taskPostgres: { servers: [APP], databaseUrl: 'shared' } })))).toBe('shared');
    expect(chosenIn(html(view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } })))).toBe('none');
  });

  it('saves each of the three choices as the bridge reads them, a server by the port its row has now', async () => {
    const vectors = { ...APP, port: 55433, database: 'vectors' };
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: false, error: 'held for the test' });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [APP, vectors], databaseUrl: 'none' } })} />));

    await act(async () => choose('shared'));
    await act(async () => button('Save').click());
    expect(vi.mocked(saveTaskPostgres).mock.calls.at(-1)?.[1]).toMatchObject({ databaseUrl: 'shared' });

    await act(async () => pick(1));
    expect(chosen()).toBe('server');
    expect(container.querySelector('fieldset p')?.textContent).toContain('postgres://app:<its password>@127.0.0.1:55433/vectors');
    await act(async () => type('Server 2 port', '55434'));
    await act(async () => button('Save').click());
    expect(vi.mocked(saveTaskPostgres).mock.calls.at(-1)?.[1]).toEqual({ servers: [APP, { ...vectors, port: 55434 }], databaseUrl: { port: 55434 } });

    await act(async () => choose('none'));
    await act(async () => button('Save').click());
    expect(vi.mocked(saveTaskPostgres).mock.calls.at(-1)?.[1]).toMatchObject({ databaseUrl: 'none' });
  });

  it('gives no DATABASE_URL once the server it came from is removed, rather than another server’s', async () => {
    const vectors = { ...APP, port: 55433, database: 'vectors' };
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: false, error: 'held for the test' });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [APP, vectors], databaseUrl: { port: 55433 } } })} />));
    expect(chosen()).toBe('server');

    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('li[data-server="2"] button')].find((one) => one.textContent?.trim() === 'Remove')!.click());
    expect(chosen()).toBe('none');
    await act(async () => button('Save').click());
    expect(saveTaskPostgres).toHaveBeenCalledWith('app', { servers: [APP], databaseUrl: 'none' });
  });

  it('hydrates the choices as the setting holds them, whatever the browser restored before the page’s script ran', async () => {
    // The server renders "none" chosen, another choice is on it by the time
    // React hydrates, and React keeps what it finds until the section renders again.
    const initial = view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } });
    const page = document.createElement('div');
    document.body.appendChild(page);
    page.innerHTML = renderToString(<TaskPostgresSection repo="app" initial={initial} />);
    const restored = page.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')!;
    restored.checked = true;

    let hydrated: Root | null = null;
    await act(async () => {
      hydrated = hydrateRoot(page, <TaskPostgresSection repo="app" initial={initial} />);
    });
    expect(page.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')).toBe(restored);
    expect(restored.checked).toBe(false);
    expect(page.querySelector<HTMLInputElement>('input[type="radio"][value="none"]')!.checked).toBe(true);

    // Chosen by the person, it is chosen, and Save sends what it shows.
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [APP], databaseUrl: 'shared' } }) });
    await act(async () => restored.click());
    expect(restored.checked).toBe(true);
    await act(async () => [...page.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Save')!.click());
    expect(vi.mocked(saveTaskPostgres).mock.calls[0]?.[1]).toMatchObject({ databaseUrl: 'shared' });
    act(() => hydrated?.unmount());
    page.remove();
  });

  it('hydrates a server of its own as chosen when the saved setting holds it, whatever the browser left on it', async () => {
    const initial = view({ taskPostgres: { servers: [APP], databaseUrl: { port: 55432 } } });
    const page = document.createElement('div');
    document.body.appendChild(page);
    page.innerHTML = renderToString(<TaskPostgresSection repo="app" initial={initial} />);
    page.querySelector<HTMLInputElement>('input[type="radio"][value="none"]')!.checked = true;

    let hydrated: Root | null = null;
    await act(async () => {
      hydrated = hydrateRoot(page, <TaskPostgresSection repo="app" initial={initial} />);
    });
    expect(page.querySelector<HTMLInputElement>('input[type="radio"][value="server"]')!.checked).toBe(true);
    expect(page.querySelector<HTMLInputElement>('input[type="radio"][value="none"]')!.checked).toBe(false);
    act(() => hydrated?.unmount());
    page.remove();
  });

  it('sends a port that is not digits as typed, for the bridge to refuse with what to do', () => {
    const rows = [{ key: 1, ...APP, port: 'five' }];
    expect(settingOf(rows, { choice: 'none', key: null }).servers[0]?.port).toBe('five');
    expect(settingOf(rows, { choice: 'server', key: 1 }).databaseUrl).toEqual({ port: 'five' });
  });
});

describe('filling it from the repository’s Compose file', () => {
  const field = (index: number, name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Server ${index} ${name}"]`);
  const valuesOf = (index: number) => ['port', 'superuser', 'password', 'database', 'image'].map((name) => field(index, name)?.value);

  it('starts a repository with nothing set filled from its docker-compose.yml, and saves nothing until Save', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({ ok: true, compose: APP_COMPOSE });
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: true, view: view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } }) });

    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view()} />));

    expect(readTaskPostgresCompose).toHaveBeenCalledWith('app');
    expect(valuesOf(1)).toEqual(['55432', 'app', 'app', 'app_db', 'pgvector/pgvector:pg16']);
    const status = container.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toContain('Filled from docker-compose.yml on main, its postgres service: check each server, then Save.');
    expect(status).toContain('Nothing is saved until you do.');
    expect(status).toContain('pinning one with @sha256:<digest> is optional');
    expect(saveTaskPostgres).not.toHaveBeenCalled();
    // Nothing about DATABASE_URL was saved, so the server the file starts is offered as it.
    expect(chosen()).toBe('server');
    expect(container.querySelector('fieldset p')?.textContent).toContain('postgres://app:<its password>@127.0.0.1:55432/app_db');

    await act(async () => button('Save').click());
    expect(saveTaskPostgres).toHaveBeenCalledWith('app', { servers: [APP], databaseUrl: { port: 55432 } });
    expect(container.textContent).toContain('Saved: the next task here gets them.');
    expect(container.textContent).not.toContain('Nothing is saved until you do.');
  });

  it('keeps a saved choice when filled, a server of its own as the filled one on its port', async () => {
    const twoServers: TaskPostgresCompose = {
      ...APP_COMPOSE,
      servers: [
        { service: 'postgres', ...APP, notes: [], refusal: null },
        { service: 'vectors', ...APP, port: 55433, database: 'vectors', notes: [], refusal: null },
      ],
    };
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({ ok: true, compose: twoServers });
    vi.mocked(saveTaskPostgres).mockResolvedValue({ ok: false, error: 'held for the test' });

    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [APP], databaseUrl: 'shared' } })} />));
    await act(async () => button('Fill from docker-compose.yml').click());
    expect(chosen()).toBe('shared');
    act(() => root.unmount());

    root = createRoot(container);
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [{ ...APP, port: 55433 }], databaseUrl: { port: 55433 } } })} />));
    await act(async () => button('Fill from docker-compose.yml').click());
    expect(chosen()).toBe('server');
    await act(async () => button('Save').click());
    expect(vi.mocked(saveTaskPostgres).mock.calls.at(-1)?.[1]).toMatchObject({ databaseUrl: { port: 55433 } });
  });

  it('starts a repository with a setting as it is stored, and fills from the file only when asked', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({ ok: true, compose: APP_COMPOSE });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [{ ...APP, port: 55499 }], databaseUrl: 'none' } })} />));

    expect(readTaskPostgresCompose).not.toHaveBeenCalled();
    expect(field(1, 'port')?.value).toBe('55499');

    await act(async () => button('Fill from docker-compose.yml').click());

    expect(readTaskPostgresCompose).toHaveBeenCalledWith('app');
    expect(valuesOf(1)).toEqual(['55432', 'app', 'app', 'app_db', 'pgvector/pgvector:pg16']);
    expect(field(2, 'port')).toBeNull();
    expect(saveTaskPostgres).not.toHaveBeenCalled();
  });

  it('starts a stored setting that no longer reads as it is, for the person to correct', async () => {
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ unreadable: 'evil/pg:1 is not an image' })} />));
    expect(readTaskPostgresCompose).not.toHaveBeenCalled();
  });

  it('shows an image outside the allowlist as the file writes it, with the refusal, and what is left to give', async () => {
    const refusal = "ankane/pgvector:latest is not an image a task's server may run: use pgvector/pgvector:<tag> or postgres:<tag>";
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({
      ok: true,
      compose: {
        ...APP_COMPOSE,
        servers: [
          {
            service: 'db',
            ...APP,
            password: '',
            image: 'ankane/pgvector:latest',
            notes: [{ field: 'password', text: "the file sets no POSTGRES_PASSWORD: give the one the repository's own database URLs use" }],
            refusal,
          },
        ],
      },
    });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view()} />));

    expect(field(1, 'image')?.value).toBe('ankane/pgvector:latest');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(`Save would refuse its image: ${refusal}`);
    const notes = container.querySelector('ul[aria-label="Server 1: what to check, from its db service"]');
    expect(notes?.textContent).toBe("Password: the file sets no POSTGRES_PASSWORD: give the one the repository's own database URLs use");

    await act(async () => type('Server 1 password', 'app'));
    expect(container.querySelector('ul[aria-label^="Server 1: what to check"]')).toBeNull();
    await act(async () => type('Server 1 image', 'pgvector/pgvector:pg16'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('says on the form a file with no Postgres service, and keeps what the form holds', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({
      ok: true,
      compose: { ok: false, file: 'docker-compose.yml', branch: 'main', why: 'docker-compose.yml has no Postgres service: none of its services runs pgvector/pgvector or postgres (cache (redis:7))' },
    });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view({ taskPostgres: { servers: [APP], databaseUrl: 'none' } })} />));

    await act(async () => button('Fill from docker-compose.yml').click());

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Not filled: docker-compose.yml has no Postgres service: none of its services runs pgvector/pgvector or postgres (cache (redis:7))',
    );
    expect(valuesOf(1)).toEqual(['55432', 'app', 'app', 'app_db', 'pgvector/pgvector:pg16']);
  });

  it('says on the form a file it cannot read, first and when asked', async () => {
    vi.mocked(readTaskPostgresCompose).mockResolvedValue({
      ok: true,
      compose: { ok: false, file: 'docker-compose.yml', branch: 'main', why: 'docker-compose.yml does not read as YAML: Flow sequence in block collection must be sufficiently indented' },
    });
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view()} />));

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
    await act(async () => root.render(<TaskPostgresSection repo="app" initial={view()} />));
    expect(button('Reading the Compose file…').disabled).toBe(true);

    await act(async () => button('Add a server').click());
    await act(async () => type('Server 1 port', '6000'));
    await act(async () => answer({ ok: true, compose: APP_COMPOSE }));

    expect(valuesOf(1)).toEqual(['6000', '', '', '', 'pgvector/pgvector:pg16']);
    expect(container.textContent).not.toContain('Filled from');
    expect(button('Fill from docker-compose.yml').disabled).toBe(false);
  });
});
