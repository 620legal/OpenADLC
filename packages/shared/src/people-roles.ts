/**
 * Person roles: named groups of the install's people (Product, Legal,
 * Engineering, and any an admin adds) that a Needs-you item may later be
 * routed to. Not an access role (`admin`/`user`) and not a crew seat's role,
 * which is why the code never calls one a bare `role`.
 *
 * Stored as one install setting, `personRoles`, written by
 * `PUT /v1/people-roles` and by the store when a person is removed or merged.
 * A member is a person's id in People (ADR 0034, superseding ADR 0032's
 * "members are live humans"), so someone with no GitHub login can hold one.
 * The fixed roles' names live here and are never stored, so no write can
 * rename one; a custom role's id is `pr_` and 8 hex characters, assigned when
 * it is added and kept across renames, because that id is what routing will
 * refer to.
 */

export interface FixedPersonRole {
  id: string;
  name: string;
}

export const FIXED_PERSON_ROLES: readonly FixedPersonRole[] = [
  { id: 'product', name: 'Product' },
  { id: 'legal', name: 'Legal' },
  { id: 'engineering', name: 'Engineering' },
];

export const MAX_PERSON_ROLE_NAME = 40;
export const MAX_CUSTOM_PERSON_ROLES = 50;

/** One role as stored: a fixed role has no name, a custom one always has one. */
export interface StoredPersonRole {
  id: string;
  name?: string;
  members: string[];
}

export interface StoredPersonRoles {
  roles: StoredPersonRole[];
}

/** One role as the API and the console see it. */
export interface PersonRole {
  id: string;
  name: string;
  fixed: boolean;
  members: string[];
}

/** One person the console may offer for a role: their id, and how they are called. */
export interface RolePerson {
  id: string;
  label: string;
}

/** What `GET` and `PUT /v1/people-roles` answer: the roles, and the people the console may offer. */
export interface PersonRolesView {
  roles: PersonRole[];
  people: RolePerson[];
}

/** How a person is called in a role: their name, else their email, else `@login`. */
export function personRoleLabel(person: { id: string; name?: string | null; email?: string | null; githubLogin?: string | null }): string {
  return person.name?.trim() || person.email || (person.githubLogin ? `@${person.githubLogin}` : person.id);
}

const CUSTOM_ID = /^pr_[0-9a-f]{8}$/;

function fixedRole(id: string): FixedPersonRole | undefined {
  return FIXED_PERSON_ROLES.find((role) => role.id === id);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The stored setting, read tolerantly: a missing row or one that is not JSON
 * reads as the three fixed roles with no one in them, and an entry that is
 * neither a fixed role nor a well-formed custom one is dropped. A read never
 * throws, so a bad row cannot take Settings down with it.
 */
export function parsePersonRoles(raw: string | null): StoredPersonRoles {
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const entries = parsed && typeof parsed === 'object' && Array.isArray((parsed as { roles?: unknown }).roles) ? ((parsed as { roles: unknown[] }).roles) : [];
  const fixed = new Map<string, string[]>();
  const custom: StoredPersonRole[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, members } = entry as Record<string, unknown>;
    if (typeof id !== 'string') continue;
    if (fixedRole(id)) {
      if (!fixed.has(id)) fixed.set(id, stringList(members));
      continue;
    }
    if (!CUSTOM_ID.test(id) || typeof name !== 'string' || !name.trim() || custom.some((role) => role.id === id)) continue;
    custom.push({ id, name: name.trim(), members: stringList(members) });
  }
  return { roles: [...FIXED_PERSON_ROLES.map((role) => ({ id: role.id, members: fixed.get(role.id) ?? [] })), ...custom] };
}

/** The members of a list that are people in People, each once. */
function amongPeople(members: readonly string[], people: readonly string[]): string[] {
  const known = new Set(people);
  const out: string[] = [];
  for (const member of members) {
    const id = member.trim();
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function roleName(role: StoredPersonRole): string {
  return fixedRole(role.id)?.name ?? role.name ?? role.id;
}

/**
 * The roles as the API shows them: the fixed ones first in their order, then
 * the custom ones as stored. A member who is no longer a person in People
 * is left out, so a role never shows someone the install no longer has.
 */
export function viewPersonRoles(stored: StoredPersonRoles, people: readonly string[]): PersonRole[] {
  const normal = parsePersonRoles(JSON.stringify(stored));
  return normal.roles.map((role) => ({
    id: role.id,
    name: roleName(role),
    fixed: fixedRole(role.id) !== undefined,
    members: amongPeople(role.members, people),
  }));
}

function newPersonRoleId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `pr_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export type PersonRolesCheck = { ok: true; stored: StoredPersonRoles } | { ok: false; error: string };

/**
 * Checks a whole list sent by `PUT /v1/people-roles` against what is stored
 * and the ids of the install's people, and gives what to store. Each refusal says what to
 * change; nothing is half-applied.
 */
export function checkPersonRoles(
  input: unknown,
  current: StoredPersonRoles,
  people: readonly string[],
  newId: () => string = newPersonRoleId,
): PersonRolesCheck {
  const shape = 'roles is a list of {id?, name, members}';
  if (!input || typeof input !== 'object' || !Array.isArray((input as { roles?: unknown }).roles)) return { ok: false, error: shape };
  const given = (input as { roles: unknown[] }).roles;
  for (const entry of given) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: shape };
    const { id, name, members } = entry as Record<string, unknown>;
    if (id !== undefined && typeof id !== 'string') return { ok: false, error: shape };
    if (typeof name !== 'string') return { ok: false, error: shape };
    if (!Array.isArray(members) || !members.every((member) => typeof member === 'string')) return { ok: false, error: shape };
  }
  const entries = given as { id?: string; name: string; members: string[] }[];

  for (const fixed of FIXED_PERSON_ROLES) {
    if (!entries.some((entry) => entry.id === fixed.id)) return { ok: false, error: `${fixed.name} cannot be deleted: send it with no members to empty it` };
  }

  const existing = new Set(current.roles.filter((role) => !fixedRole(role.id)).map((role) => role.id));
  const seenIds = new Set<string>();
  // The fixed names are taken whatever order the list comes in, so a custom
  // "product" is refused by the name the person can see it clashes with.
  const seenNames = new Map(FIXED_PERSON_ROLES.map((role) => [role.name.toLowerCase(), role.name]));
  const fixedOut = new Map<string, string[]>();
  const customOut: StoredPersonRole[] = [];
  const known = new Set(people);

  for (const entry of entries) {
    const fixed = entry.id === undefined ? undefined : fixedRole(entry.id);
    const name = entry.name.trim();
    if (fixed) {
      if (name !== fixed.name) return { ok: false, error: `${fixed.name} cannot be renamed` };
    } else {
      if (!name) return { ok: false, error: 'a custom role needs a name' };
      if (name.length > MAX_PERSON_ROLE_NAME) {
        return { ok: false, error: `“${name}” is longer than ${MAX_PERSON_ROLE_NAME} characters: shorten the role’s name` };
      }
      if (entry.id !== undefined && !existing.has(entry.id)) return { ok: false, error: `there is no role ${entry.id}: leave id out to add a new role` };
    }
    if (entry.id !== undefined) {
      if (seenIds.has(entry.id)) return { ok: false, error: `${fixed?.name ?? entry.id} is sent twice: send each role once` };
      seenIds.add(entry.id);
    }
    if (!fixed) {
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) return { ok: false, error: `there is already a role named “${seenNames.get(lower)}”: give this one another name` };
      seenNames.set(lower, name);
    }

    const members: string[] = [];
    for (const member of entry.members) {
      const id = member.trim();
      if (!known.has(id)) {
        return { ok: false, error: `“${id}” is not a person in People: add them under Settings → People first, or take them off ${name}` };
      }
      if (!members.includes(id)) members.push(id);
    }
    if (fixed) fixedOut.set(fixed.id, members);
    else customOut.push({ id: entry.id ?? '', name, members });
  }
  for (const role of customOut) {
    if (role.id) continue;
    let id = newId();
    while (existing.has(id) || seenIds.has(id)) id = newId();
    seenIds.add(id);
    role.id = id;
  }

  if (customOut.length > MAX_CUSTOM_PERSON_ROLES) return { ok: false, error: `at most ${MAX_CUSTOM_PERSON_ROLES} custom roles` };
  return {
    ok: true,
    stored: { roles: [...FIXED_PERSON_ROLES.map((role) => ({ id: role.id, members: fixedOut.get(role.id) ?? [] })), ...customOut] },
  };
}

export interface PersonRoleMember {
  role: string;
  /** The person's id. */
  person: string;
}

/** The stored roles without anyone no longer in People, and who was taken off which role. */
export function pruneMembers(stored: StoredPersonRoles, people: readonly string[]): { stored: StoredPersonRoles; removed: PersonRoleMember[] } {
  const known = new Set(people);
  const removed: PersonRoleMember[] = [];
  const roles = stored.roles.map((role) => {
    const kept = role.members.filter((member) => known.has(member.trim()));
    for (const member of role.members) if (!kept.includes(member)) removed.push({ role: roleName(role), person: member });
    return { ...role, members: kept };
  });
  return { stored: { roles }, removed };
}

export interface PersonRolesDiff {
  rolesAdded: string[];
  rolesRemoved: string[];
  rolesRenamed: { from: string; to: string }[];
  membersAdded: PersonRoleMember[];
  membersRemoved: PersonRoleMember[];
}

/** What changed between two lists of roles, by name, for the audit entry. */
export function diffPersonRoles(before: readonly PersonRole[], after: readonly PersonRole[]): PersonRolesDiff {
  const diff: PersonRolesDiff = { rolesAdded: [], rolesRemoved: [], rolesRenamed: [], membersAdded: [], membersRemoved: [] };
  for (const role of after) {
    const was = before.find((one) => one.id === role.id);
    if (!was) diff.rolesAdded.push(role.name);
    else if (was.name !== role.name) diff.rolesRenamed.push({ from: was.name, to: role.name });
    const had = was?.members ?? [];
    for (const person of role.members) if (!had.includes(person)) diff.membersAdded.push({ role: role.name, person });
    for (const person of had) if (!role.members.includes(person)) diff.membersRemoved.push({ role: role.name, person });
  }
  for (const role of before) {
    if (after.some((one) => one.id === role.id)) continue;
    diff.rolesRemoved.push(role.name);
    for (const person of role.members) diff.membersRemoved.push({ role: role.name, person });
  }
  return diff;
}

/** Whether a diff says nothing changed. */
export function personRolesUnchanged(diff: PersonRolesDiff): boolean {
  return Object.values(diff).every((list) => list.length === 0);
}

/**
 * The role a question names, matched by name without regard to case, or
 * undefined when the install has none by that name. Bots name a role as people
 * see it and never by a custom role's `pr_` id, so only names are matched.
 */
export function personRoleByName<T extends { id: string; name: string }>(name: string | null | undefined, roles: readonly T[]): T | undefined {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) return undefined;
  return roles.find((role) => role.name.trim().toLowerCase() === wanted);
}
