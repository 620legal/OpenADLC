'use client';

import { useState, useTransition } from 'react';
import { addUser, removeUser, setUserRole } from '@/app/actions';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
import type { ConsoleUser, IdentityMode, Role } from '@/lib/api';
import { safeAction } from '@/lib/safe-action';

/** How someone came to be here, where it is worth saying. */
export function howLine(user: Pick<ConsoleUser, 'addedHow' | 'addedBy'>): string {
  switch (user.addedHow) {
    case 'first':
      return 'Admin by being the first to open the console';
    case 'admin-emails':
      return 'Admin from FLEETADLC_ADMIN_EMAILS';
    case 'console-members':
      return "Admin as one of the console's IAP members";
    default:
      return `Added by ${user.addedBy}`;
  }
}

const ROLE_WORDS: Record<Role, string> = { admin: 'Admin', user: 'User' };

const ROLES_LINE =
  'Admins reach everything; users file requests, answer the crew and read the board. Either role covers every repository the install manages, whatever the person’s access on GitHub.';

/**
 * The card's line. On a local install the bridge sees one identity for every
 * console request, so a role restricts nobody there; saying "who may use the
 * console" let an operator believe a colleague was limited.
 */
export function usersLine(identityMode: IdentityMode | undefined): string {
  if (identityMode === 'local')
    return `On a local install roles are advisory: every console request is the same identity, so anyone who reaches the console acts as an admin. ${ROLES_LINE}`;
  return `Who may use the console. ${ROLES_LINE}`;
}

/**
 * Settings → Users: who may use the console, and as what. An admin
 * reaches everything; a user files requests, answers the crew and reads the
 * board, threads and costs. IAP still decides who reaches the console at all,
 * so an address here that IAP does not let in cannot sign in; one IAP lets in
 * that is not here is asked to find an admin.
 *
 * The bridge refuses to demote or remove the last admin, and on a local
 * install to demote the console's own identity; every change is audited
 * there, and this only says what it answered.
 */
export function UsersSection({
  initial,
  me,
  identityMode,
}: {
  initial: ConsoleUser[] | null;
  me: string;
  /** Unknown when the bridge could not say who is asking. */
  identityMode?: IdentityMode;
}) {
  const [users, setUsers] = useState<ConsoleUser[] | null>(initial);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The page is read again every fifteen seconds: what it read is taken while
  // nothing here is in flight, so a user another admin added shows.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen && !pending) {
    setSeen(initial);
    setUsers(initial);
  }

  const act = (work: () => Promise<{ ok: boolean; error?: string }>, then: () => void) => {
    setError(null);
    startTransition(async () => {
      // A call that fails outright is said here; inside the transition it took the page down.
      const result = await safeAction(work);
      if (!result.ok) setError(result.error ?? 'that did not go through');
      else then();
    });
  };

  const replace = (next: ConsoleUser) =>
    setUsers((list) => (list ?? []).map((one) => (one.email === next.email ? next : one)));

  return (
    <SettingsCard id="users" title="Users" line={usersLine(identityMode)}>
      {users === null ? (
        <p className="text-[12.5px] text-muted">The list could not be read. Reload to try again.</p>
      ) : (
        <ul aria-label="Users" className="flex flex-col divide-y divide-edge text-[12.5px]">
          {users.map((user) => (
            <li key={user.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-mono text-body">{user.email}</span>
                {user.email === me && <span className="ml-1.5 text-muted">(you)</span>}
                <span className="block text-[11.5px] text-muted">{howLine(user)}</span>
              </span>
              <select
                value={user.role}
                disabled={pending}
                aria-label={`role for ${user.email}`}
                onChange={(event) => {
                  const next = event.target.value as Role;
                  act(
                    async () => {
                      const result = await setUserRole(user.email, next);
                      if (result.ok && result.user) replace(result.user);
                      return result;
                    },
                    () => undefined,
                  );
                }}
                className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12.5px] text-body"
              >
                <option value="admin">{ROLE_WORDS.admin}</option>
                <option value="user">{ROLE_WORDS.user}</option>
              </select>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => act(() => removeUser(user.email), () => setUsers((list) => (list ?? []).filter((one) => one.email !== user.email)))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        aria-label="Add a user"
        className="mt-2 flex flex-wrap items-end gap-2 text-[12.5px]"
        onSubmit={(event) => {
          event.preventDefault();
          const address = email.trim();
          if (!address) return;
          act(
            async () => {
              const result = await addUser(address, role);
              if (result.ok && result.user) setUsers((list) => [...(list ?? []), result.user!]);
              return result;
            },
            () => setEmail(''),
          );
        }}
      >
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <span className="text-soft">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="jane@example.com"
            className="h-9 rounded-md border border-edge-strong bg-panel px-2.5 text-[13px] text-body"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-soft">Role</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            className="h-9 rounded-md border border-edge-strong bg-panel px-2 text-[13px] text-body"
          >
            <option value="user">{ROLE_WORDS.user}</option>
            <option value="admin">{ROLE_WORDS.admin}</option>
          </select>
        </label>
        <Button type="submit" size="md" variant="primary" disabled={pending || !email.trim()}>
          Add
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-alarm">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
