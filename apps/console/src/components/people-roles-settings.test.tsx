// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonRolesView } from '@/lib/api';

/**
 * Settings → Roles in a browser: what each button sends to the bridge, and
 * what the list shows after.
 */

type Sent = { id?: string; name: string; members: string[] }[];
const saved = vi.hoisted(() => ({ calls: [] as Sent[], answer: null as { ok: boolean; view?: PersonRolesView; error?: string } | null }));
vi.mock('@/app/actions', () => ({
  savePersonRoles: vi.fn(async (roles: Sent) => {
    saved.calls.push(roles);
    if (saved.answer) return saved.answer;
    return {
      ok: true,
      view: {
        people: VIEW.people,
        roles: roles.map((role, n) => ({ id: role.id ?? `pr_0000000${n}`, name: role.name, fixed: ['product', 'legal', 'engineering'].includes(role.id ?? ''), members: role.members })),
      },
    };
  }),
}));

/** Everyone in People, approving or not: Ada by name, Grace by her email. */
const VIEW: PersonRolesView = {
  people: [
    { id: 'p-ada', label: 'Ada' },
    { id: 'p-grace', label: 'grace@example.com' },
  ],
  roles: [
    { id: 'product', name: 'Product', fixed: true, members: ['p-ada'] },
    { id: 'legal', name: 'Legal', fixed: true, members: [] },
    { id: 'engineering', name: 'Engineering', fixed: true, members: [] },
    { id: 'pr_aaaaaaaa', name: 'Finance', fixed: false, members: ['p-grace'] },
  ],
};
const SENT = VIEW.roles.map(({ id, name, members }) => ({ id, name, members }));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  saved.calls = [];
  saved.answer = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function draw(view: PersonRolesView = VIEW) {
  const { PeopleRolesSettings } = await import('./people-roles-settings');
  await act(async () => root.render(<PeopleRolesSettings initial={view} />));
}

const row = (id: string) => container.querySelector<HTMLElement>(`[data-role="${id}"]`)!;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const choose = async (select: HTMLSelectElement, value: string) => {
  select.value = value;
  await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
};

describe('Settings → Roles in a browser', () => {
  it('lists each role with its people, says No one yet for an empty one, and offers Delete only on a custom one', async () => {
    await draw();
    expect(row('product').textContent).toContain('Ada');
    expect(row('legal').textContent).toContain('No one yet');
    expect(row('pr_aaaaaaaa').textContent).toContain('grace@example.com');
    expect(button('Delete Product')).toBeNull();
    expect(button('Delete Legal')).toBeNull();
    expect(button('Delete Finance')).not.toBeNull();
  });

  it('adds a role with the whole list, and shows it once the bridge has it', async () => {
    await draw();
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Add a role"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, '  Sales ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const add = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Add')!;
    await act(async () => add.click());
    expect(saved.calls).toEqual([[...SENT, { name: 'Sales', members: [] }]]);
    expect(container.textContent).toContain('Sales added');
    expect(container.textContent).toContain('Sales');
    expect(field.value).toBe('');
  });

  it('offers everyone in People, by how People calls them', async () => {
    await draw();
    const options = [...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Add a person to Legal"] option')].map((one) => [one.value, one.textContent]);
    expect(options).toEqual([
      ['', 'Add a person'],
      ['p-ada', 'Ada'],
      ['p-grace', 'grace@example.com'],
    ]);
  });

  it('deletes a custom role, and adds and removes a person, each with the whole list', async () => {
    await draw();
    await act(async () => button('Delete Finance')!.click());
    expect(saved.calls.at(-1)).toEqual(SENT.slice(0, 3));
    expect(container.textContent).toContain('Finance deleted');
    expect(row('pr_aaaaaaaa')).toBeNull();

    await choose(container.querySelector<HTMLSelectElement>('select[aria-label="Add a person to Legal"]')!, 'p-grace');
    expect(saved.calls.at(-1)).toEqual([SENT[0], { ...SENT[1], members: ['p-grace'] }, SENT[2]]);
    expect(container.textContent).toContain('grace@example.com added to Legal');

    await act(async () => button('Remove Ada from Product')!.click());
    expect(saved.calls.at(-1)).toEqual([{ ...SENT[0], members: [] }, { ...SENT[1], members: ['p-grace'] }, SENT[2]]);
    expect(container.textContent).toContain('Ada removed from Product');
    expect(row('product').textContent).toContain('No one yet');
  });

  it('shows the bridge’s refusal and keeps the list as the bridge last answered it', async () => {
    saved.answer = { ok: false, error: '“p-grace” is not a person in People: add them under Settings → People first, or take them off Legal' };
    await draw();
    await choose(container.querySelector<HTMLSelectElement>('select[aria-label="Add a person to Legal"]')!, 'p-grace');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(saved.answer.error);
    expect(row('legal').textContent).toContain('No one yet');
  });

  it('points at People when the install has nobody in it', async () => {
    await draw({ people: [], roles: VIEW.roles.slice(0, 3).map((role) => ({ ...role, members: [] })) });
    expect(container.querySelector('select')).toBeNull();
    expect(row('product').textContent).toContain('Add people under People');
    expect(row('product').querySelector('a')?.getAttribute('href')).toBe('#people');
  });
});
