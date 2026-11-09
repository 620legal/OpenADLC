'use client';

import { useState, useTransition } from 'react';
import { savePersonRoles } from '@/app/actions';
import type { PersonRole, PersonRolesView } from '@/lib/api';

/** The list as `PUT /v1/people-roles` takes it: every role, with its id, so each keeps it. */
function sent(roles: readonly PersonRole[]): { id: string; name: string; members: string[] }[] {
  return roles.map((role) => ({ id: role.id, name: role.name, members: [...role.members] }));
}

/**
 * Settings → Roles: who among the install's people holds Product, Legal,
 * Engineering and the roles an admin adds. Nothing routes by them yet.
 *
 * Each change saves the whole list, as Egress does, and the list shown is the
 * one the bridge last answered: a refusal leaves it as it was, with the
 * bridge's words, rather than showing a change that was not stored. The
 * bridge checks each name and person and audits what changed
 * (`people-roles-routes.ts`).
 */
export function PeopleRolesSettings({ initial }: { initial: PersonRolesView }) {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = (roles: { id?: string; name: string; members: string[] }[], done: string, after?: () => void) => {
    // A second save while one is out would be made from the list before it.
    if (pending) return;
    setError(null);
    setSaid(null);
    start(async () => {
      const result = await savePersonRoles(roles);
      if (!result.ok || !result.view) {
        setError(result.error ?? 'the roles were not saved');
        return;
      }
      setView(result.view);
      setSaid(done);
      after?.();
    });
  };

  const addRole = () => {
    const name = draft.trim();
    if (!name) return;
    save([...sent(view.roles), { name, members: [] }], `${name} added`, () => setDraft(''));
  };
  const deleteRole = (role: PersonRole) =>
    save(
      sent(view.roles.filter((one) => one.id !== role.id)),
      `${role.name} deleted`,
    );
  // Members are people's ids (docs/adr/0034-one-list-of-people.md); what a
  // person sees is how People calls them.
  const labelOf = (id: string) => view.people.find((person) => person.id === id)?.label ?? id;
  const addPerson = (role: PersonRole, id: string) =>
    save(
      sent(view.roles).map((one) => (one.id === role.id ? { ...one, members: [...one.members, id] } : one)),
      `${labelOf(id)} added to ${role.name}`,
    );
  const removePerson = (role: PersonRole, id: string) =>
    save(
      sent(view.roles).map((one) => (one.id === role.id ? { ...one, members: one.members.filter((member) => member !== id) } : one)),
      `${labelOf(id)} removed from ${role.name}`,
    );

  return (
    <div data-people-roles className="flex flex-col gap-2.5 text-[12.5px]">
      <p className="text-muted">
        A role is a group of the install’s people. Product, Legal and Engineering are always here; add others as you need them. Each change is in
        the audit trail with who made it, and someone removed from People is taken off every role.
      </p>
      <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge">
        {view.roles.map((role) => {
          const offered = view.people.filter((person) => !role.members.includes(person.id));
          return (
            <li key={role.id} data-role={role.id} className="flex flex-col gap-1.5 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-body">{role.name}</span>
                {!role.fixed && (
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Delete ${role.name}`}
                    onClick={() => deleteRole(role)}
                    className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[12px] text-body hover:bg-well disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {role.members.length === 0 ? (
                  <span className="text-dim">No one yet</span>
                ) : (
                  role.members.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 rounded-full border border-edge bg-well px-2 py-0.5">
                      <span className="text-body">{labelOf(id)}</span>
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={`Remove ${labelOf(id)} from ${role.name}`}
                        onClick={() => removePerson(role, id)}
                        className="text-soft hover:text-body disabled:opacity-50"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
                {view.people.length === 0 ? (
                  <a href="#people" className="text-soft underline">
                    Add people under People
                  </a>
                ) : (
                  offered.length > 0 && (
                    <select
                      aria-label={`Add a person to ${role.name}`}
                      value=""
                      disabled={pending}
                      onChange={(event) => {
                        if (event.target.value) addPerson(role, event.target.value);
                      }}
                      className="rounded-md border border-edge bg-panel px-2 py-0.5 text-[12px] text-body disabled:opacity-50"
                    >
                      <option value="">Add a person</option>
                      {offered.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.label}
                        </option>
                      ))}
                    </select>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Add a role"
          placeholder="Finance"
          value={draft}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addRole();
            }
          }}
          className="min-w-[200px] flex-1 rounded-md border border-edge bg-panel px-2.5 py-1 text-body"
        />
        <button
          type="button"
          disabled={pending || !draft.trim()}
          onClick={addRole}
          className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[12px] text-body hover:bg-well disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Add'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-alarm">
          {error}
        </p>
      )}
      {said && (
        <p role="status" className="text-signal">
          {said}
        </p>
      )}
    </div>
  );
}
