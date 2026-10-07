// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleUser, Role } from '@/lib/api';
import { headerData } from '@/lib/header';
import { AppShell, RoleProvider } from './app-header';
import { adminOnly } from './needs-you';
import { AdminsOnly, NoAdmin, NotAUser } from './not-a-user';
import { UsersSection } from './users-section';

/** Settings → Users, and what a user is not shown elsewhere. */

vi.mock('@/components/live-refresh', () => ({ LiveRefresh: () => null }));

const sent = vi.hoisted(() => [] as string[]);
vi.mock('@/app/actions', () => ({
  addUser: vi.fn(async (email: string, role: Role) => {
    sent.push(`add ${email} ${role}`);
    return { ok: true, user: { email: email.toLowerCase(), role, addedBy: 'janedoe@example.com', addedHow: 'added', addedAt: '2026-09-30T12:00:00.000Z' } };
  }),
  setUserRole: vi.fn(async (email: string, role: Role) => {
    sent.push(`role ${email} ${role}`);
    if (email === 'janedoe@example.com') return { ok: false, error: 'janedoe@example.com is the only admin. Make someone else an admin first' };
    return { ok: true, user: { email, role, addedBy: 'janedoe@example.com', addedHow: 'added', addedAt: '2026-09-30T11:00:00.000Z' } };
  }),
  removeUser: vi.fn(async (email: string) => {
    sent.push(`remove ${email}`);
    return { ok: true };
  }),
}));

const USERS: ConsoleUser[] = [
  { email: 'janedoe@example.com', role: 'admin', addedBy: 'janedoe@example.com', addedHow: 'first', addedAt: '2026-09-30T10:00:00.000Z' },
  { email: 'bob@example.com', role: 'user', addedBy: 'janedoe@example.com', addedHow: 'added', addedAt: '2026-09-30T11:00:00.000Z' },
];

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}`);
  return found;
}

function row(email: string): HTMLLIElement {
  const found = [...container.querySelectorAll('li')].find((one) => one.textContent?.includes(email));
  if (!found) throw new Error(`no row for ${email}`);
  return found as HTMLLIElement;
}

/** Sets a controlled field the way a person typing does, so React sees it. */
function type(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('Settings → Users', () => {
  it('lists each person with their role, and says who became admin by being first', async () => {
    await act(async () => root.render(<UsersSection initial={USERS} me="janedoe@example.com" />));
    expect(row('janedoe@example.com').textContent).toContain('(you)');
    expect(row('janedoe@example.com').textContent).toContain('Admin by being the first to open the console');
    expect((row('janedoe@example.com').querySelector('select') as HTMLSelectElement).value).toBe('admin');
    expect((row('bob@example.com').querySelector('select') as HTMLSelectElement).value).toBe('user');
    expect(row('bob@example.com').textContent).toContain('Added by janedoe@example.com');
  });

  it('says behind IAP who may use the console, and on a local install that roles are advisory there', async () => {
    await act(async () => root.render(<UsersSection initial={USERS} me="janedoe@example.com" identityMode="iap" />));
    expect(container.textContent).toContain('Who may use the console. Admins reach everything');
    expect(container.textContent).not.toContain('advisory');

    // One identity for every console request: a role there limits nobody.
    await act(async () => root.render(<UsersSection initial={USERS} me="console" identityMode="local" />));
    expect(container.textContent).toContain(
      'On a local install roles are advisory: every console request is the same identity, so anyone who reaches the console acts as an admin.',
    );
    expect(container.textContent).not.toContain('Who may use the console');
  });

  it('adds a person with the role chosen', async () => {
    await act(async () => root.render(<UsersSection initial={USERS} me="janedoe@example.com" />));
    const form = container.querySelector('form[aria-label="Add a user"]')!;
    await act(async () => {
      type(form.querySelector('input')!, 'carol@example.com');
      type(form.querySelector('select')!, 'admin');
    });
    await act(async () => button('Add', form).click());
    await settle();
    expect(sent).toEqual(['add carol@example.com admin']);
    expect((row('carol@example.com').querySelector('select') as HTMLSelectElement).value).toBe('admin');
    expect((form.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('changes a role, and says why the last admin keeps theirs', async () => {
    await act(async () => root.render(<UsersSection initial={USERS} me="janedoe@example.com" />));
    await act(async () => type(row('bob@example.com').querySelector('select')!, 'admin'));
    await settle();
    expect((row('bob@example.com').querySelector('select') as HTMLSelectElement).value).toBe('admin');

    await act(async () => type(row('janedoe@example.com').querySelector('select')!, 'user'));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('is the only admin');
    expect((row('janedoe@example.com').querySelector('select') as HTMLSelectElement).value).toBe('admin');
    expect(sent).toEqual(['role bob@example.com admin', 'role janedoe@example.com user']);
  });

  it('takes the page’s next read, so a person another admin added shows', async () => {
    await act(async () => root.render(<UsersSection initial={USERS} me="janedoe@example.com" />));
    const dana: ConsoleUser = { email: 'dana@example.com', role: 'user', addedBy: 'bob@example.com', addedHow: 'added', addedAt: '2026-09-30T13:00:00.000Z' };
    await act(async () => root.render(<UsersSection initial={[...USERS, dana]} me="janedoe@example.com" />));
    expect(row('dana@example.com').textContent).toContain('Added by bob@example.com');
  });

  it('says the console did not answer, rather than taking the page down', async () => {
    const { removeUser } = await import('@/app/actions');
    vi.mocked(removeUser).mockRejectedValueOnce(new Error('Failed to find Server Action'));
    await act(async () => root.render(<UsersSection initial={USERS} me="janedoe@example.com" />));
    await act(async () => button('Remove', row('bob@example.com')).click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('the console did not take that');
    expect(container.textContent).toContain('bob@example.com');
  });

  it('removes a person', async () => {
    await act(async () => root.render(<UsersSection initial={USERS} me="janedoe@example.com" />));
    await act(async () => button('Remove', row('bob@example.com')).click());
    await settle();
    expect(sent).toEqual(['remove bob@example.com']);
    expect(container.textContent).not.toContain('bob@example.com');
  });
});

describe('what a user is shown', () => {
  const data = headerData({ repos: ['fleetadlc-testbed'], crew: [], budget: null, needsYou: 0 });
  const shell = (role: Role) =>
    renderToStaticMarkup(
      <RoleProvider role={role}>
        <AppShell page="board" data={data}>
          <p>board</p>
        </AppShell>
      </RoleProvider>,
    );

  it('has no Settings in the header or the phone’s navigation', () => {
    const user = shell('user');
    expect(user).not.toContain('href="/settings"');
    expect(user).toContain('href="/costs"');
    // Board, Crew, Costs and Insights: one column each on a phone.
    expect(user).toContain('href="/insights"');
    expect(user).toContain('grid-cols-4');
    const admin = shell('admin');
    expect(admin.match(/href="\/settings"/g)).toHaveLength(2);
    expect(admin).toContain('grid-cols-5');
  });
});

describe('someone the install does not know', () => {
  it('is told whom they are signed in as, and whom to ask', () => {
    const html = renderToStaticMarkup(<NotAUser email="jane@example.com" admins={['admin@example.com']} />).replace(/<!-- -->/g, '');
    expect(html).toContain('Ask an admin to add you');
    expect(html).toContain('jane@example.com</span>, which this install doesn’t know. Ask an admin to add you in Settings → Users.');
    expect(html).toContain('href="mailto:admin@example.com"');
  });
});

describe('a cloud install that named no admin', () => {
  it('tells everyone to set admin_emails', () => {
    const html = renderToStaticMarkup(<NoAdmin email="jane@example.com" />).replace(/<!-- -->/g, '');
    expect(html).toContain('No admin is configured');
    expect(html).toContain('admin_emails');
    expect(html).toContain('FLEETADLC_ADMIN_EMAILS');
  });
});

describe('what a user is not offered on a card', () => {
  it('drops a health check’s actions and links into Settings or the walkthrough, and keeps the crew’s work', () => {
    expect(adminOnly({ kind: 'recheck', label: 'Run check', checkId: 'hostd' } as never)).toBe(true);
    expect(adminOnly({ kind: 'dismiss', label: 'Dismiss', checkId: 'hostd' } as never)).toBe(true);
    expect(adminOnly({ kind: 'acknowledge', label: 'Dismiss', checkId: 'unattributed-post', occurrence: 'post:1' } as never)).toBe(true);
    expect(adminOnly({ kind: 'open_page', label: 'Connect', href: '/onboarding?step=github-accounts' })).toBe(true);
    expect(adminOnly({ kind: 'open_page', label: 'Engine updates', href: '/settings#system' })).toBe(true);
    expect(adminOnly({ kind: 'open_page', label: 'Costs', href: '/costs' })).toBe(false);
    expect(adminOnly({ kind: 'stop_task', label: 'Stop', taskId: 't1' } as never)).toBe(false);
    expect(adminOnly({ kind: 'approve', label: 'Approve', gateId: 'g1', answer: '1' } as never)).toBe(false);
  });

  it('shows a user who opens the walkthrough that it is an admin’s', () => {
    const html = renderToStaticMarkup(<AdminsOnly email="bob@example.com" what="Setting up needs" doing="sets the install up" />).replace(/<!-- -->/g, '');
    expect(html).toContain('Setting up needs an admin');
    expect(html).toContain('href="/?board=1"');
    expect(html).not.toContain('FLEETADLC_IDENTITY');
  });

  it('tells a local install whose console identity is a user how to get Settings back', () => {
    const html = renderToStaticMarkup(
      <AdminsOnly email="console" identityMode="local" what="Settings need" doing="changes settings" />,
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('Settings need an admin');
    expect(html).toContain('This console signs in as <span class="font-mono text-soft">console</span>');
    expect(html).toContain('To get Settings back, set <span class="font-mono text-soft">FLEETADLC_IDENTITY</span> to an admin’s address');
    expect(html).toContain('run <span class="font-mono text-soft">fleetadlc up</span> again');
    expect(html).toContain('href="/?board=1"');
  });
});
