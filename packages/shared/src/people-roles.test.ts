import { describe, expect, it } from 'vitest';
import { checkPersonRoles, diffPersonRoles, parsePersonRoles, personRolesUnchanged, pruneMembers, viewPersonRoles, type StoredPersonRoles } from './people-roles.js';

const EMPTY = parsePersonRoles(null);
const FIXED = [
  { id: 'product', name: 'Product', members: [] as string[] },
  { id: 'legal', name: 'Legal', members: [] as string[] },
  { id: 'engineering', name: 'Engineering', members: [] as string[] },
];
const HUMANS = ['ada', 'Grace'];
let counter = 0;
const nextId = () => `pr_0000000${++counter}`;

function check(roles: unknown[], current: StoredPersonRoles = EMPTY, humans = HUMANS) {
  return checkPersonRoles({ roles }, current, humans, nextId);
}

describe('parsePersonRoles', () => {
  it('reads nothing stored, or a row that is not JSON, as the three fixed roles with no one in them', () => {
    const empty = { roles: [{ id: 'product', members: [] }, { id: 'legal', members: [] }, { id: 'engineering', members: [] }] };
    expect(parsePersonRoles(null)).toEqual(empty);
    expect(parsePersonRoles('')).toEqual(empty);
    expect(parsePersonRoles('{not json')).toEqual(empty);
    expect(parsePersonRoles('[1,2]')).toEqual(empty);
  });

  it('keeps the fixed roles in their order, adds one that is missing, and drops an id it does not know', () => {
    const raw = JSON.stringify({
      roles: [
        { id: 'pr_aaaaaaaa', name: 'Finance', members: ['ada'] },
        { id: 'legal', name: 'Lawyers', members: ['grace', 7] },
        { id: 'marketing', name: 'Marketing', members: [] },
        { id: 'pr_bbbbbbbb', members: [] },
      ],
    });
    expect(parsePersonRoles(raw)).toEqual({
      roles: [
        { id: 'product', members: [] },
        { id: 'legal', members: ['grace'] },
        { id: 'engineering', members: [] },
        { id: 'pr_aaaaaaaa', name: 'Finance', members: ['ada'] },
      ],
    });
  });
});

describe('viewPersonRoles', () => {
  it('names the fixed roles from code and shows only members among humans, spelt as humans spells them', () => {
    const stored = {
      roles: [
        { id: 'engineering', members: ['GRACE', 'bob', 'grace'] },
        { id: 'pr_aaaaaaaa', name: 'Finance', members: ['ada'] },
      ],
    };
    expect(viewPersonRoles(stored, HUMANS)).toEqual([
      { id: 'product', name: 'Product', fixed: true, members: [] },
      { id: 'legal', name: 'Legal', fixed: true, members: [] },
      { id: 'engineering', name: 'Engineering', fixed: true, members: ['Grace'] },
      { id: 'pr_aaaaaaaa', name: 'Finance', fixed: false, members: ['ada'] },
    ]);
  });
});

describe('checkPersonRoles', () => {
  it('accepts the fixed roles with members and a new custom role, and gives the new one an id', () => {
    const result = check([...FIXED.slice(0, 2), { ...FIXED[2], members: ['ADA', 'ada'] }, { name: '  Finance ', members: ['grace'] }]);
    expect(result).toEqual({
      ok: true,
      stored: {
        roles: [
          { id: 'product', members: [] },
          { id: 'legal', members: [] },
          { id: 'engineering', members: ['ada'] },
          { id: expect.stringMatching(/^pr_/), name: 'Finance', members: ['Grace'] },
        ],
      },
    });
  });

  it('keeps a custom role’s id when it is renamed', () => {
    const current = { roles: [...EMPTY.roles, { id: 'pr_aaaaaaaa', name: 'Finance', members: [] }] };
    const result = check([...FIXED, { id: 'pr_aaaaaaaa', name: 'Money', members: [] }], current);
    expect(result.ok && result.stored.roles[3]).toEqual({ id: 'pr_aaaaaaaa', name: 'Money', members: [] });
  });

  it('removes a custom role left out', () => {
    const current = { roles: [...EMPTY.roles, { id: 'pr_aaaaaaaa', name: 'Finance', members: ['ada'] }] };
    expect(check(FIXED, current)).toEqual({ ok: true, stored: EMPTY });
  });

  it.each([
    ['not a list', { roles: 'x' }, 'roles is a list of {id?, name, members}'],
    ['a member that is not a string', { roles: [...FIXED, { name: 'Finance', members: [1] }] }, 'roles is a list of {id?, name, members}'],
    ['a fixed role left out', { roles: FIXED.slice(1) }, 'Product cannot be deleted: send it with no members to empty it'],
    ['a fixed role renamed', { roles: [{ ...FIXED[0], name: 'Products' }, ...FIXED.slice(1)] }, 'Product cannot be renamed'],
    ['an empty name', { roles: [...FIXED, { name: '', members: [] }] }, 'a custom role needs a name'],
    ['a blank name', { roles: [...FIXED, { name: '   ', members: [] }] }, 'a custom role needs a name'],
    ['a name of 41 characters', { roles: [...FIXED, { name: 'x'.repeat(41), members: [] }] }, `“${'x'.repeat(41)}” is longer than 40 characters: shorten the role’s name`],
    ['a fixed role’s name', { roles: [...FIXED, { name: 'product', members: [] }] }, 'there is already a role named “Product”: give this one another name'],
    ['a fixed role’s name, before it', { roles: [{ name: 'legal', members: [] }, ...FIXED] }, 'there is already a role named “Legal”: give this one another name'],
    ['another custom name in another case', { roles: [...FIXED, { name: 'Finance', members: [] }, { name: 'FINANCE', members: [] }] }, 'there is already a role named “Finance”: give this one another name'],
    ['an id not stored', { roles: [...FIXED, { id: 'pr_ffffffff', name: 'Finance', members: [] }] }, 'there is no role pr_ffffffff: leave id out to add a new role'],
    ['a member not among humans', { roles: [...FIXED, { name: 'Finance', members: ['bob'] }] }, '“bob” is not one of the install’s people: add them under Settings → Install → People first, or take them off Finance'],
    ['51 custom roles', { roles: [...FIXED, ...Array.from({ length: 51 }, (_, n) => ({ name: `Role ${n}`, members: [] }))] }, 'at most 50 custom roles'],
  ])('refuses %s, saying what to fix', (_, input, error) => {
    expect(checkPersonRoles(input, EMPTY, HUMANS, nextId)).toEqual({ ok: false, error });
  });

  it('accepts a name of 40 characters', () => {
    expect(check([...FIXED, { name: 'x'.repeat(40), members: [] }]).ok).toBe(true);
  });
});

describe('pruneMembers', () => {
  it('takes off every role whoever is no longer among humans, and says who from where', () => {
    const stored = { roles: [{ id: 'product', members: [] }, { id: 'legal', members: ['grace', 'ada'] }, { id: 'engineering', members: [] }, { id: 'pr_aaaaaaaa', name: 'Finance', members: ['grace'] }] };
    expect(pruneMembers(stored, ['ADA'])).toEqual({
      stored: { roles: [{ id: 'product', members: [] }, { id: 'legal', members: ['ada'] }, { id: 'engineering', members: [] }, { id: 'pr_aaaaaaaa', name: 'Finance', members: [] }] },
      removed: [
        { role: 'Legal', login: 'grace' },
        { role: 'Finance', login: 'grace' },
      ],
    });
  });
});

describe('diffPersonRoles', () => {
  it('names roles added, removed and renamed, and people added and removed', () => {
    const before = [
      { id: 'product', name: 'Product', fixed: true, members: ['ada'] },
      { id: 'pr_aaaaaaaa', name: 'Finance', fixed: false, members: ['grace'] },
      { id: 'pr_bbbbbbbb', name: 'Ops', fixed: false, members: [] },
    ];
    const after = [
      { id: 'product', name: 'Product', fixed: true, members: ['grace'] },
      { id: 'pr_aaaaaaaa', name: 'Money', fixed: false, members: ['grace'] },
      { id: 'pr_cccccccc', name: 'Sales', fixed: false, members: ['ada'] },
    ];
    expect(diffPersonRoles(before, after)).toEqual({
      rolesAdded: ['Sales'],
      rolesRemoved: ['Ops'],
      rolesRenamed: [{ from: 'Finance', to: 'Money' }],
      membersAdded: [
        { role: 'Product', login: 'grace' },
        { role: 'Sales', login: 'ada' },
      ],
      membersRemoved: [{ role: 'Product', login: 'ada' }],
    });
    expect(personRolesUnchanged(diffPersonRoles(after, after))).toBe(true);
  });
});
