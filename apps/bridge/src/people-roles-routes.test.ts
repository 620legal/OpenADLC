import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parsePersonRoles, type StoredPersonRoles } from '@openadlc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPeopleRolesRoutes } from './people-roles-routes.js';
import { Router } from './router.js';
import { authorize, roleFor } from './roles.js';

/**
 * Settings → Roles: who among the install's people holds Product, Legal,
 * Engineering and the custom roles an admin adds. Only an admin reads or
 * writes them, each change is audited with who made it, and a member is
 * a person in People, by id, whether or not they approve.
 */

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const FIXED = [
  { id: 'product', name: 'Product', members: [] as string[] },
  { id: 'legal', name: 'Legal', members: [] as string[] },
  { id: 'engineering', name: 'Engineering', members: [] as string[] },
];

/** Ada approves and Grace does not; both are people, and both may hold a role. */
const PEOPLE = [
  { id: 'ada', label: 'Ada' },
  { id: 'grace', label: 'grace@example.com' },
];

async function serve(options: { people?: { id: string; label: string }[]; stored?: StoredPersonRoles } = {}) {
  let stored: string | null = options.stored ? JSON.stringify(options.stored) : null;
  const everyone = options.people ?? PEOPLE;
  const audited: { actor: string; action: string; target: string; payload?: Record<string, unknown> }[] = [];
  let ids = 0;
  const deps = {
    stored: async () => parsePersonRoles(stored),
    store: async (value: StoredPersonRoles) => {
      stored = JSON.stringify(value);
    },
    people: async () => everyone,
    audit: async (entry: (typeof audited)[number]) => void audited.push(entry),
    newId: () => `pr_0000000${++ids}`,
  };
  const people: Record<string, 'admin' | 'user'> = { 'admin@exampleco.test': 'admin', 'user@exampleco.test': 'user' };
  const lookup = { roleOf: async (identity: string) => people[identity] ?? null, admins: async () => ['admin@exampleco.test'], refused: async () => undefined };
  const router = new Router(undefined, undefined, undefined, (method, path, identity) => authorize(lookup, method, path, identity));
  registerPeopleRolesRoutes(router, deps);
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/people-roles`;
  const headers = (who = 'admin@exampleco.test') => ({ 'x-openadlc-identity': who, 'content-type': 'application/json' });
  return {
    read: async (who?: string) => {
      const response = await fetch(url, { headers: headers(who) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    save: async (roles: unknown, who?: string) => {
      const response = await fetch(url, { method: 'PUT', headers: headers(who), body: JSON.stringify({ roles }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    stored: () => stored,
    audited,
    deps,
  };
}

describe('the roles the install’s people hold', () => {
  it('are Product, Legal and Engineering with no one in them on an install with nothing stored', async () => {
    const roles = await serve();
    expect(await roles.read()).toEqual({
      status: 200,
      body: {
        roles: [
          { id: 'product', name: 'Product', fixed: true, members: [] },
          { id: 'legal', name: 'Legal', fixed: true, members: [] },
          { id: 'engineering', name: 'Engineering', fixed: true, members: [] },
        ],
        people: PEOPLE,
      },
    });
  });

  it('are saved whole, read back the same, and each change is audited once with who made it and what changed', async () => {
    const roles = await serve();
    const saved = await roles.save([{ ...FIXED[0], members: [' ada'] }, FIXED[1], FIXED[2], { name: 'Finance', members: ['grace'] }]);
    const expected = {
      roles: [
        { id: 'product', name: 'Product', fixed: true, members: ['ada'] },
        { id: 'legal', name: 'Legal', fixed: true, members: [] },
        { id: 'engineering', name: 'Engineering', fixed: true, members: [] },
        { id: 'pr_00000001', name: 'Finance', fixed: false, members: ['grace'] },
      ],
      people: PEOPLE,
    };
    expect(saved).toEqual({ status: 200, body: expected });
    expect((await roles.read()).body).toEqual(expected);
    expect(roles.audited).toEqual([
      {
        actor: 'admin@exampleco.test',
        action: 'people_roles.changed',
        target: 'install',
        payload: {
          rolesAdded: ['Finance'],
          rolesRemoved: [],
          rolesRenamed: [],
          membersAdded: [
            { role: 'Product', person: 'Ada' },
            { role: 'Finance', person: 'grace@example.com' },
          ],
          membersRemoved: [],
        },
      },
    ]);

    // The same list again changes nothing, and writes no entry.
    await roles.save(expected.roles);
    expect(roles.audited).toHaveLength(1);
  });

  it('keep a renamed custom role’s id, and drop a custom role left out with its people', async () => {
    const roles = await serve({ stored: { roles: [...parsePersonRoles(null).roles, { id: 'pr_aaaaaaaa', name: 'Finance', members: ['grace'] }, { id: 'pr_bbbbbbbb', name: 'Ops', members: ['ada'] }] } });
    const saved = await roles.save([...FIXED, { id: 'pr_aaaaaaaa', name: 'Money', members: ['grace'] }]);
    expect(saved.status).toBe(200);
    expect((await roles.read()).body.roles).toEqual([
      ...FIXED.map((role) => ({ ...role, fixed: true })),
      { id: 'pr_aaaaaaaa', name: 'Money', fixed: false, members: ['grace'] },
    ]);
    expect(roles.audited[0]?.payload).toMatchObject({ rolesRemoved: ['Ops'], rolesRenamed: [{ from: 'Finance', to: 'Money' }], membersRemoved: [{ role: 'Ops', person: 'Ada' }] });
  });

  it.each([
    ['a fixed role left out', FIXED.slice(1), 'Product cannot be deleted: send it with no members to empty it'],
    ['a fixed role renamed', [{ ...FIXED[0], name: 'Products' }, ...FIXED.slice(1)], 'Product cannot be renamed'],
    ['an empty name', [...FIXED, { name: '', members: [] }], 'a custom role needs a name'],
    ['a blank name', [...FIXED, { name: '   ', members: [] }], 'a custom role needs a name'],
    ['a 41-character name', [...FIXED, { name: 'x'.repeat(41), members: [] }], `“${'x'.repeat(41)}” is longer than 40 characters: shorten the role’s name`],
    ['a fixed role’s name', [...FIXED, { name: 'product', members: [] }], 'there is already a role named “Product”: give this one another name'],
    ['two names that differ only in case', [...FIXED, { name: 'Finance', members: [] }, { name: 'FINANCE', members: [] }], 'there is already a role named “Finance”: give this one another name'],
    ['a member who is not a person', [...FIXED, { name: 'Finance', members: ['bob'] }], '“bob” is not a person in People: add them under Settings → People first, or take them off Finance'],
  ])('refuse %s with a 400 that says what to fix, and write nothing', async (_, list, error) => {
    const before = { roles: [...parsePersonRoles(null).roles, { id: 'pr_aaaaaaaa', name: 'Ops', members: ['ada'] }] };
    const roles = await serve({ stored: before });
    expect(await roles.save(list)).toEqual({ status: 400, body: { error } });
    expect(roles.stored()).toBe(JSON.stringify(before));
    expect(roles.audited).toEqual([]);
  });

  it('accept a name of 40 characters', async () => {
    const roles = await serve();
    expect((await roles.save([...FIXED, { name: 'x'.repeat(40), members: [] }])).status).toBe(200);
  });

  it('never show a member who is no longer a person in People', async () => {
    const roles = await serve({ people: [{ id: 'ada', label: 'Ada' }], stored: { roles: [{ id: 'product', members: ['ada', 'grace'] }, { id: 'legal', members: ['grace'] }, { id: 'engineering', members: [] }] } });
    const read = await roles.read();
    expect((read.body.roles as { id: string; members: string[] }[]).map((role) => [role.id, role.members])).toEqual([
      ['product', ['ada']],
      ['legal', []],
      ['engineering', []],
    ]);
  });

  it('are an admin’s: a user is refused both', async () => {
    expect(roleFor('GET', '/v1/people-roles')).toBe('admin');
    expect(roleFor('PUT', '/v1/people-roles')).toBe('admin');
    const roles = await serve();
    expect((await roles.read('user@exampleco.test')).status).toBe(403);
    expect((await roles.save(FIXED, 'user@exampleco.test')).status).toBe(403);
    expect(roles.stored()).toBeNull();
  });
});
