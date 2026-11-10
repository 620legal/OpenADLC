// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeopleView, Person } from '@/lib/api';

/** Settings → People in a browser: what each control sends to the bridge, and what the list shows after. */

const sent = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/app/actions', () => ({
  addPerson: vi.fn(async (fields: Record<string, unknown>) => {
    sent.calls.push(['add', fields]);
    return { ok: true, person: { ...PERSON, id: 'p-new', name: String(fields.name ?? ''), email: (fields.email as string) ?? null, github: { login: String(fields.githubLogin), id: 9, confirmed: false } } };
  }),
  changePerson: vi.fn(async (id: string, fields: unknown) => {
    sent.calls.push(['change', id, fields]);
    return { ok: true };
  }),
  setApproves: vi.fn(async (id: string, on: boolean) => {
    sent.calls.push(['approves', id, on]);
    return { ok: true, person: { ...PERSON, approves: on } };
  }),
  mergePerson: vi.fn(async () => ({ ok: true })),
  removePerson: vi.fn(async () => ({ ok: true })),
  checkGithubLogin: vi.fn(async (login: string) => (login === 'ada' ? { exists: true, login: 'ada' } : { exists: false })),
}));

const PERSON: Person = {
  id: 'p-bob',
  name: 'Bob',
  email: 'bob@example.com',
  consoleRole: 'user',
  github: { login: 'bobcat', id: 7, confirmed: false },
  approves: false,
  approvesFrom: null,
  roles: ['legal'],
  addedBy: 'jane@example.com',
  addedAt: '2026-11-09T10:00:00.000Z',
};
const CAROL: Person = {
  id: 'env:carol',
  name: '',
  email: null,
  consoleRole: null,
  github: { login: 'carol', id: null, confirmed: false },
  approves: true,
  approvesFrom: 'environment',
  roles: [],
  addedBy: 'OPENADLC_HUMANS',
  addedAt: '',
  virtual: true,
};
const VIEW: PeopleView = { people: [PERSON, CAROL], environment: { logins: ['carol'], inEffect: true }, identityMode: 'iap' };
const ROLES = [{ id: 'legal', name: 'Legal', fixed: true, members: ['p-bob'] }];

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent.calls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function draw(view: PeopleView = VIEW) {
  const { PeopleSection } = await import('./people-section');
  await act(async () => root.render(<PeopleSection initial={view} roles={ROLES} me="jane@example.com" />));
}

const row = (id: string) => container.querySelector<HTMLElement>(`[data-person="${id}"]`)!;
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('Settings → People in a browser', () => {
  it('shows each person’s email, GitHub account, console role, Approves and roles', async () => {
    await draw();
    const bob = row('p-bob');
    expect(bob.textContent).toContain('Bob');
    expect(bob.textContent).toContain('bob@example.com');
    expect(bob.textContent).toContain('@bobcat · named');
    expect(bob.textContent).toContain('Legal');
    expect(bob.querySelector<HTMLSelectElement>('select[aria-label="console role for Bob"]')!.value).toBe('user');
    expect(bob.querySelector<HTMLInputElement>('input[aria-label="Approves: Bob"]')!.checked).toBe(false);
  });

  it('turns Approves on with the switch', async () => {
    await draw();
    const toggle = row('p-bob').querySelector<HTMLInputElement>('input[aria-label="Approves: Bob"]')!;
    await act(async () => toggle.click());
    expect(sent.calls).toEqual([['approves', 'p-bob', true]]);
    expect(row('p-bob').querySelector<HTMLInputElement>('input[aria-label="Approves: Bob"]')!.checked).toBe(true);
  });

  it('shows an approver from OPENADLC_HUMANS locked, saying where it comes from', async () => {
    await draw();
    const carol = row('env:carol');
    expect(carol.textContent).toContain('from OPENADLC_HUMANS');
    const toggle = carol.querySelector<HTMLInputElement>('input[aria-label="Approves: @carol"]')!;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(carol.textContent).not.toContain('Remove');
  });

  it('checks a login on GitHub as it is typed, and adds a person with an email and a login', async () => {
    vi.useFakeTimers();
    try {
      await draw();
      const form = container.querySelector<HTMLFormElement>('form[aria-label="Add a person"]')!;
      await type(form.querySelector<HTMLInputElement>('input[aria-label="Email"]')!, 'ada@example.com');
      await type(form.querySelector<HTMLInputElement>('input[aria-label="GitHub login"]')!, 'ada');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(form.textContent).toContain('@ada is on GitHub');
      await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      expect(sent.calls).toEqual([['add', { email: 'ada@example.com', consoleRole: 'user', githubLogin: 'ada' }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on a local install adds by name and GitHub login only: the console is the operator', async () => {
    await draw({ ...VIEW, identityMode: 'local' });
    const form = container.querySelector<HTMLFormElement>('form[aria-label="Add a person"]')!;
    expect(form.querySelector('input[aria-label="Email"]')).toBeNull();
    expect(form.querySelector('select[aria-label="Console role"]')).toBeNull();
  });
});
