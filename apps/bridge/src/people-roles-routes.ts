import { audit, people as peopleStore, settings } from '@openadlc/db';
import {
  checkPersonRoles,
  diffPersonRoles,
  parsePersonRoles,
  personRoleLabel,
  personRolesUnchanged,
  viewPersonRoles,
  type PersonRolesView,
  type RolePerson,
  type StoredPersonRoles,
} from '@openadlc/shared';
import type { BridgeConfig } from './config.js';
import { HttpFailure, type Router } from './router.js';

/** The store, the install's people and the audit trail, injected so the routes can be tested without them. */
export interface PeopleRolesDeps {
  stored(): Promise<StoredPersonRoles>;
  store(value: StoredPersonRoles, by: string): Promise<void>;
  /** Everyone in People, by id, as the console calls them. */
  people(): Promise<RolePerson[]>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<unknown>;
  /** A new custom role's id; the shared check's own when left out. */
  newId?: () => string;
}

export function livePeopleRolesDeps(_config?: BridgeConfig): PeopleRolesDeps {
  return {
    stored: async () => {
      const raw = await settings.getSetting('personRoles');
      // A row that is not JSON is shown as the fixed roles alone rather than
      // failing Settings; the next save replaces it.
      if (raw && !isJsonObject(raw)) console.warn('[bridge] personRoles is not a JSON object; it reads as the fixed roles with no one in them');
      return parsePersonRoles(raw);
    },
    store: (value, by) => settings.setSetting('personRoles', JSON.stringify(value), by),
    people: async () => (await peopleStore.listPeople()).map((person) => ({ id: person.id, label: personRoleLabel(person) })),
    audit,
  };
}

function isJsonObject(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** What an audit entry says of a member: how the person is called, not only their id. */
function labelled<T extends { members: string[] }>(roles: readonly T[], people: readonly RolePerson[]): T[] {
  const label = new Map(people.map((person) => [person.id, person.label]));
  return roles.map((role) => ({ ...role, members: role.members.map((id) => label.get(id) ?? id) }));
}

/**
 * Settings → Roles: who among the install's people holds each person role.
 * Nothing routes by them yet; a later change routes Needs-you items to the
 * role they concern.
 *
 * Only an admin reads or writes them (`roles.ts`). A member is a person in
 * People, by id (docs/adr/0034-one-list-of-people.md): the read leaves out an
 * id that is no longer a person, and removing a person takes them off every
 * role in the same change, so a person removed and added again does not
 * quietly get their old roles back. Holding a role never makes anyone an
 * approver: only Approves does.
 */
export function registerPeopleRolesRoutes(router: Router, deps: PeopleRolesDeps): void {
  router.get('/v1/people-roles', async (): Promise<PersonRolesView> => {
    const [stored, people] = await Promise.all([deps.stored(), deps.people()]);
    return { roles: viewPersonRoles(stored, people.map((person) => person.id)), people };
  });

  router.add('PUT', '/v1/people-roles', async ({ body, identity }): Promise<PersonRolesView> => {
    const input = await body<unknown>();
    const [current, people] = await Promise.all([deps.stored(), deps.people()]);
    const ids = people.map((person) => person.id);
    const checked = checkPersonRoles(input, current, ids, deps.newId);
    if (!checked.ok) throw new HttpFailure(400, checked.error);

    await deps.store(checked.stored, identity);
    // Against what the person saw, so a member only the read filter hid is
    // not audited as removed by them.
    const diff = diffPersonRoles(labelled(viewPersonRoles(current, ids), people), labelled(viewPersonRoles(checked.stored, ids), people));
    if (!personRolesUnchanged(diff)) {
      await deps.audit({ actor: identity, action: 'people_roles.changed', target: 'install', payload: { ...diff } });
    }
    return { roles: viewPersonRoles(checked.stored, ids), people };
  });
}
