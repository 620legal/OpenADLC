import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserChangeRefused, type Person, type PersonInput } from '@openadlc/db';
import { registerPeopleRoutes, setApproversFromLogins, type PeopleRouteDeps } from './people-routes.js';
import { Router } from './router.js';

const AT = '2026-11-09T10:00:00.000Z';

function person(fields: Partial<Person> & { id: string }): Person {
  return {
    name: '',
    email: null,
    consoleRole: null,
    githubLogin: null,
    githubUserId: null,
    githubLinkedAt: null,
    approves: false,
    addedBy: 'jane@example.com',
    addedHow: 'added',
    addedAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

/** People as a list in memory, changed the way the store changes it. */
function memory(initial: Person[], environment = { logins: [] as string[], inEffect: false }) {
  let rows = [...initial];
  let next = 0;
  const changes: string[] = [];
  const deps: PeopleRouteDeps = {
    roles: { invalidate: vi.fn() },
    identityMode: 'iap',
    store: {
      list: async () => rows,
      add: async (input: PersonInput, by) => {
        if (input.consoleRole && !input.email) throw new UserChangeRefused('invalid', 'a console role needs an email to sign in with');
        const added = person({
          id: `p-${++next}`,
          name: input.name ?? '',
          email: input.email ?? null,
          consoleRole: input.consoleRole ?? null,
          githubLogin: input.github?.login ?? null,
          githubUserId: input.github?.id ?? null,
          addedBy: by,
        });
        rows.push(added);
        changes.push(`person.added ${added.id} by ${by}`);
        return added;
      },
      update: async (id, input) => {
        const row = rows.find((one) => one.id === id)!;
        Object.assign(row, input.github ? { githubLogin: input.github.login, githubUserId: input.github.id, githubLinkedAt: null } : {});
        return row;
      },
      setApproves: async (id, on, by) => {
        const row = rows.find((one) => one.id === id)!;
        if (on && !row.githubLogin) throw new UserChangeRefused('invalid', `Give ${row.email} a GitHub login first`);
        row.approves = on;
        changes.push(`person.approves_${on ? 'on' : 'off'} ${id} by ${by}`);
        return row;
      },
      merge: async (id, into) => {
        rows = rows.filter((one) => one.id !== id);
        return rows.find((one) => one.id === into)!;
      },
      remove: async (id) => {
        const row = rows.find((one) => one.id === id)!;
        if (row.consoleRole === 'admin' && rows.filter((one) => one.consoleRole === 'admin').length <= 1) {
          throw new UserChangeRefused('last-admin', `${row.email} is the only admin. Make someone else an admin first`);
        }
        rows = rows.filter((one) => one.id !== id);
      },
    },
    environment: async () => environment,
    lookup: async (login) => ({ alice: { login: 'alice', id: 11 }, bob: { login: 'bob', id: 12 } })[login.toLowerCase()] ?? false,
    personRoles: async () => ({ roles: [{ id: 'product', members: ['p-b'] }, { id: 'legal', members: [] }] }),
  };
  return { deps, rows: () => rows, changes };
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function serve(deps: PeopleRouteDeps) {
  const router = new Router(undefined, undefined, undefined, async () => 'admin');
  registerPeopleRoutes(router, deps);
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'x-openadlc-identity': 'Jane@Example.com', 'content-type': 'application/json' };
  return {
    get: async (path: string) => fetch(`${url}${path}`, { headers }),
    send: async (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
}

const USERS = [person({ id: 'p-a', email: 'a@example.com', consoleRole: 'admin' }), person({ id: 'p-b', email: 'b@example.com', consoleRole: 'user' })];

describe('Settings → People', () => {
  it('lists each console user once, with their roles, on an install where nobody approves', async () => {
    const { deps } = memory(USERS.map((one) => ({ ...one })));
    const api = await serve(deps);
    const view = (await (await api.get('/v1/people')).json()) as { people: { id: string; email: string; approves: boolean; roles: string[] }[] };
    expect(view.people.map((one) => [one.id, one.email, one.approves, one.roles])).toEqual([
      ['p-a', 'a@example.com', false, []],
      ['p-b', 'b@example.com', false, ['product']],
    ]);
  });

  it('says who is asking', async () => {
    const { deps } = memory(USERS);
    const api = await serve(deps);
    expect(await (await api.get('/v1/me')).json()).toEqual({ email: 'jane@example.com', role: 'admin', identityMode: 'iap' });
  });

  it('adds a person with an email and a GitHub login, pinned to its account and not confirmed, and never approving', async () => {
    const { deps } = memory(USERS.map((one) => ({ ...one })));
    const api = await serve(deps);
    const response = await api.send('POST', '/v1/people', { name: 'Alice', email: 'alice@example.com', consoleRole: 'user', githubLogin: 'alice' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { person: unknown }).person).toMatchObject({
      email: 'alice@example.com',
      github: { login: 'alice', id: 11, confirmed: false },
      approves: false,
    });
  });

  it('refuses a login GitHub has no account by, and checks one as it is typed', async () => {
    const { deps } = memory(USERS);
    const api = await serve(deps);
    const refused = await api.send('POST', '/v1/people', { email: 'x@example.com', githubLogin: 'nobodyhere' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('GitHub has no account @nobodyhere');
    expect(await (await api.get('/v1/people/github/Alice')).json()).toEqual({ exists: true, login: 'alice', id: 11 });
    expect(await (await api.get('/v1/people/github/nobodyhere')).json()).toEqual({ exists: false });
  });

  it('turns Approves on and off, saying who did it, and refuses it for someone with no GitHub login', async () => {
    const { deps, changes } = memory([...USERS.map((one) => ({ ...one })), person({ id: 'p-c', githubLogin: 'carol', githubUserId: 7 })]);
    const api = await serve(deps);
    expect((await api.send('POST', '/v1/people/p-c/approves', { on: true })).status).toBe(200);
    expect((await api.send('POST', '/v1/people/p-c/approves', { on: false })).status).toBe(200);
    expect(changes).toEqual(['person.approves_on p-c by Jane@Example.com', 'person.approves_off p-c by Jane@Example.com']);
    const refused = await api.send('POST', '/v1/people/p-a/approves', { on: true });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('Give a@example.com a GitHub login first');
  });

  it('shows OPENADLC_HUMANS as approvers that cannot be changed here, with where they come from', async () => {
    const { deps } = memory(USERS, { logins: ['carol'], inEffect: true });
    const api = await serve(deps);
    const view = (await (await api.get('/v1/people')).json()) as { people: { id: string; approvesFrom: string | null; virtual?: boolean }[]; environment: unknown };
    expect(view.environment).toEqual({ logins: ['carol'], inEffect: true });
    expect(view.people.at(-1)).toMatchObject({ id: 'env:carol', approvesFrom: 'environment', virtual: true });
    const refused = await api.send('POST', '/v1/people/env:carol/approves', { on: false });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('set in OPENADLC_HUMANS');
  });

  it('says a refused change as a status, clearing what roles read either way', async () => {
    const { deps } = memory([USERS[0]!]);
    const api = await serve(deps);
    const response = await api.send('POST', '/v1/people/p-a/remove');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'last-admin' });
    expect(deps.roles.invalidate).toHaveBeenCalled();
  });

  it('takes away a person’s own notification channel once they are removed or merged away, and not when the removal is refused', async () => {
    const three = [...USERS.map((one) => ({ ...one })), person({ id: 'p-c', email: 'c@example.com', consoleRole: 'user' })];
    const forgetChannel = vi.fn(async () => undefined);
    const api = await serve({ ...memory(three).deps, forgetChannel });
    expect((await api.send('POST', '/v1/people/p-c/remove')).status).toBe(200);
    expect(forgetChannel).toHaveBeenCalledWith('p-c', 'Jane@Example.com');
    expect((await api.send('POST', '/v1/people/p-b/merge', { into: 'p-a' })).status).toBe(200);
    expect(forgetChannel).toHaveBeenLastCalledWith('p-b', 'Jane@Example.com');

    forgetChannel.mockClear();
    expect((await api.send('POST', '/v1/people/p-a/remove')).status).toBe(409);
    expect(forgetChannel).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/install {humans}', () => {
  it('resolves each login and makes exactly those approve', async () => {
    const setApprovers = vi.fn(async (accounts: readonly { login: string; id: number }[]) => accounts.map((one) => person({ id: `p-${one.id}`, githubLogin: one.login, approves: true })));
    const lookup = async (login: string) => (login === 'alice' ? { login, id: 11 } : false) as { login: string; id: number } | false;
    expect(await setApproversFromLogins(['alice', '@alice'], 'jane@example.com', lookup, { setApprovers })).toEqual(['alice']);
    expect(setApprovers).toHaveBeenCalledWith([{ login: 'alice', id: 11 }], 'jane@example.com');
    await expect(setApproversFromLogins(['bob'], 'jane@example.com', lookup, { setApprovers })).rejects.toThrow('GitHub has no account @bob');
  });
});
