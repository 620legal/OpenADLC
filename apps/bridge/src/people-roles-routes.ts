import { audit, settings } from '@openadlc/db';
import {
  checkPersonRoles,
  diffPersonRoles,
  parsePersonRoles,
  personRolesUnchanged,
  pruneMembers,
  viewPersonRoles,
  type PersonRolesView,
  type StoredPersonRoles,
} from '@openadlc/shared';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';
import { HttpFailure, type Router } from './router.js';

/** The store, the live `humans` and the audit trail, injected so the routes can be tested without them. */
export interface PeopleRolesDeps {
  stored(): Promise<StoredPersonRoles>;
  store(value: StoredPersonRoles, by: string): Promise<void>;
  /** The install's people as they are now: the settings row, or `OPENADLC_HUMANS` / install.json when it is unset. */
  humans(): Promise<string[]>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<unknown>;
  /** A new custom role's id; the shared check's own when left out. */
  newId?: () => string;
}

export function livePeopleRolesDeps(config: BridgeConfig): PeopleRolesDeps {
  return {
    stored: async () => {
      const raw = await settings.getSetting('personRoles');
      // A row that is not JSON is shown as the fixed roles alone rather than
      // failing Settings; the next save replaces it.
      if (raw && !isJsonObject(raw)) console.warn('[bridge] personRoles is not a JSON object; it reads as the fixed roles with no one in them');
      return parsePersonRoles(raw);
    },
    store: (value, by) => settings.setSetting('personRoles', JSON.stringify(value), by),
    humans: async () => (await effectiveConfig(config)).humans,
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

async function view(deps: PeopleRolesDeps): Promise<PersonRolesView> {
  const [stored, humans] = await Promise.all([deps.stored(), deps.humans()]);
  return { roles: viewPersonRoles(stored, humans), humans };
}

/**
 * Settings → Roles: who among the install's people holds each person role.
 * Nothing routes by them yet; a later change routes Needs-you items to the
 * role they concern.
 *
 * Only an admin reads or writes them (`roles.ts`). A member is always one of
 * the live `humans`: the read leaves out anyone who is not, whichever source
 * `humans` came from, and `prunePersonRoles` takes them out of the stored row
 * when `humans` is saved, so a person taken out and later put back does not
 * quietly get their old roles back (ADR 0032).
 */
export function registerPeopleRolesRoutes(router: Router, deps: PeopleRolesDeps): void {
  router.get('/v1/people-roles', async (): Promise<PersonRolesView> => view(deps));

  router.add('PUT', '/v1/people-roles', async ({ body, identity }): Promise<PersonRolesView> => {
    const input = await body<unknown>();
    const [current, humans] = await Promise.all([deps.stored(), deps.humans()]);
    const checked = checkPersonRoles(input, current, humans, deps.newId);
    if (!checked.ok) throw new HttpFailure(400, checked.error);

    await deps.store(checked.stored, identity);
    // Against what the person saw, so a member only the read filter hid is
    // not audited as removed by them.
    const diff = diffPersonRoles(viewPersonRoles(current, humans), viewPersonRoles(checked.stored, humans));
    if (!personRolesUnchanged(diff)) {
      await deps.audit({ actor: identity, action: 'people_roles.changed', target: 'install', payload: { ...diff } });
    }
    return { roles: viewPersonRoles(checked.stored, humans), humans };
  });
}

/**
 * Takes everyone no longer among `humans` out of every role, after `humans`
 * is saved. Writes and audits nothing when nobody was taken out.
 */
export async function prunePersonRoles(deps: Pick<PeopleRolesDeps, 'stored' | 'store' | 'audit'>, humans: readonly string[], by: string): Promise<void> {
  const { stored, removed } = pruneMembers(await deps.stored(), humans);
  if (removed.length === 0) return;
  await deps.store(stored, by);
  await deps.audit({ actor: by, action: 'people_roles.pruned', target: 'install', payload: { removed } });
}
