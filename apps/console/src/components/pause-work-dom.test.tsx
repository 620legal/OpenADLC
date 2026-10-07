// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PauseWorkCard } from './pause-work';

/**
 * Settings → Pause work stops every repository at once, or the ones chosen,
 * so it asks first.
 */

const paused = vi.hoisted(() => [] as string[]);
/** What each pause and resume named: the repositories, or `all`. */
const asked = vi.hoisted(() => [] as string[]);
vi.mock('@/app/actions', () => ({
  pauseWork: vi.fn(async (reason: string, repos?: string[]) => {
    paused.push(reason);
    asked.push(`pause ${repos?.join(',') ?? 'all'}`);
    const pause = { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason };
    return { ok: true, pauses: repos ? { paused: null, repos: Object.fromEntries(repos.map((name) => [name, pause])) } : { paused: pause, repos: {} } };
  }),
  resumeWork: vi.fn(async (repos?: string[], options?: { keepRepos?: boolean }) => {
    asked.push(`resume ${repos?.join(',') ?? (options?.keepRepos ? 'install' : 'all')}`);
    return { ok: true, pauses: { paused: null, repos: {} } };
  }),
}));

const NONE = { paused: null, repos: {} };
const REPOSITORIES = [
  { name: 'api', color: 'blue' },
  { name: 'web', color: 'green' },
  { name: 'docs', color: null },
];

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  paused.length = 0;
  asked.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${[...container.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('pausing work from Settings', () => {
  it('asks before it pauses, and pauses only on Confirm', async () => {
    await act(async () => root.render(<PauseWorkCard initial={NONE} />));
    await click(button('Pause work'));
    expect(container.textContent).toContain('Pause all new work across every repository?');
    expect(paused).toEqual([]);

    await click(button('Cancel'));
    expect(container.textContent).not.toContain('Pause all new work across every repository?');
    expect(paused).toEqual([]);

    await click(button('Pause work'));
    await click(button('Confirm'));
    expect(paused).toEqual(['']);
    expect(container.textContent).toContain('Paused by janedoe');
    expect(container.textContent).toContain('Merges still land');
    // The bridge's merging off leaves a pull request to auto-merge, so it is not a way to stop one.
    expect(container.textContent).toContain('needs-human');
    expect(container.textContent).not.toContain('merging off');
  });
});

describe('pausing some repositories from Settings', () => {
  function box(name: string): HTMLInputElement {
    const found = container.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${name}"]`);
    if (!found) throw new Error(`no box for ${name}`);
    return found;
  }

  it('offers each repository to choose, names the chosen ones when it asks, and pauses only those', async () => {
    await act(async () => root.render(<PauseWorkCard initial={NONE} repositories={REPOSITORIES} />));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    await click(container.querySelector<HTMLInputElement>('input[type="radio"][value="chosen"]')!);
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((one) => one.value)).toEqual(['api', 'web', 'docs']);
    // Nothing chosen, nothing to pause.
    expect(button('Pause work').disabled).toBe(true);

    await click(box('api'));
    await click(box('web'));
    await click(button('Pause work'));
    expect(container.textContent).toContain('Pause new work in api and web?');
    expect(asked).toEqual([]);

    await click(button('Confirm'));
    expect(asked).toEqual(['pause api,web']);
    const list = container.querySelector('ul[aria-label="Paused repositories"]');
    expect(list?.textContent).toContain('api');
    expect(list?.textContent).toContain('Paused by janedoe');
    // Paused already: not offered again.
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((one) => one.value)).toEqual(['docs']);
  });

  it('shows who paused each one, with its own Resume, and Resume all', async () => {
    const pause = { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'a migration is running' };
    await act(async () => root.render(<PauseWorkCard initial={{ paused: null, repos: { api: pause, web: pause } }} repositories={REPOSITORIES} />));

    const rows = [...container.querySelectorAll('ul[aria-label="Paused repositories"] li')].map((one) => one.textContent);
    expect(rows).toEqual([
      expect.stringContaining('apiPaused by janedoe at 2026-09-29 10:00 UTC: a migration is running.'),
      expect.stringContaining('webPaused by janedoe'),
    ]);
    expect(container.textContent).not.toContain('Work runs.');

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Resume web"]')!);
    expect(asked).toEqual(['resume web']);

    await act(async () => root.render(<PauseWorkCard key="again" initial={{ paused: null, repos: { api: pause, web: pause } }} repositories={REPOSITORIES} />));
    await click(button('Resume all'));
    // The ones it lists, by name: not a resume of everything, which would
    // lift a pause made since the page last read them.
    expect(asked).toEqual(['resume web', 'resume api,web']);
  });

  it('takes the pauses from each read of the page, so a pause made since is listed with its own Resume', async () => {
    await act(async () => root.render(<PauseWorkCard initial={NONE} repositories={REPOSITORIES} />));
    expect(container.querySelector('ul[aria-label="Paused repositories"]')).toBeNull();

    // The page's 15-second refresh, after someone paused api for an incident.
    const incident = { by: 'oncall', at: '2026-09-29T10:00:00.000Z', reason: 'an account may be compromised' };
    await act(async () => root.render(<PauseWorkCard initial={{ paused: null, repos: { api: incident } }} repositories={REPOSITORIES} />));
    expect(container.querySelector('ul[aria-label="Paused repositories"]')?.textContent).toContain('Paused by oncall');
    expect(container.querySelector('button[aria-label="Resume api"]')).not.toBeNull();
  });
});

describe('while the whole install is paused', () => {
  const pause = { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'an account may be compromised' };

  it('still shows each repository paused on its own, and says what each Resume does', async () => {
    await act(async () => root.render(<PauseWorkCard initial={{ paused: pause, repos: { api: pause } }} repositories={REPOSITORIES} />));
    expect(container.querySelector('ul[aria-label="Paused repositories"]')?.textContent).toContain('api');
    expect(() => button('Resume work')).toThrow();

    await click(button('Resume work, keep api paused'));
    expect(asked).toEqual(['resume install']);
  });

  it('resumes everything only when asked to', async () => {
    await act(async () => root.render(<PauseWorkCard initial={{ paused: pause, repos: { api: pause } }} repositories={REPOSITORIES} />));
    await click(button('Resume everything'));
    expect(asked).toEqual(['resume all']);
  });

  it('offers the one Resume work when no repository is paused on its own, which lifts the install’s pause alone', async () => {
    await act(async () => root.render(<PauseWorkCard initial={{ paused: pause, repos: {} }} repositories={REPOSITORIES} />));
    await click(button('Resume work'));
    // Not everything: a repository paused since the page read the pauses stays paused.
    expect(asked).toEqual(['resume install']);
  });
});

describe('pausing work on a bridge without the dispatcher', () => {
  it('says nothing new will build, and still says so after a pause and a resume, whose answers do not carry it', async () => {
    await act(async () => root.render(<PauseWorkCard initial={{ ...NONE, dispatching: false }} />));
    expect(container.textContent).not.toContain('Work runs.');
    expect(container.textContent).toContain('the dispatcher isn’t running');

    await click(button('Pause work'));
    await click(button('Confirm'));
    expect(container.textContent).toContain('Paused by janedoe');
    expect(container.textContent).toContain('the dispatcher isn’t running');

    await click(button('Resume work'));
    expect(container.textContent).not.toContain('Work runs.');
    expect(container.textContent).toContain('Pause and Resume do not change that');
  });

  it('reads a bridge that does not say as dispatching', async () => {
    await act(async () => root.render(<PauseWorkCard initial={NONE} />));
    expect(container.textContent).toContain('Work runs.');
    expect(container.textContent).not.toContain('dispatcher');
  });
});
