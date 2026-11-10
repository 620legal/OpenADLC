'use client';

import { useEffect, useState, useTransition } from 'react';
import { addPerson, changePerson, checkGithubLogin, mergePerson, removePerson, setApproves, type PersonFields } from '@/app/actions';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
import type { IdentityMode, PeopleView, Person, PersonRole, Role } from '@/lib/api';
import { safeAction } from '@/lib/safe-action';

/**
 * The warning under a person IAP will not let in. A console role is only half
 * of access: IAP admits exactly the `console_members` Terraform applied, and
 * an address they do not name gets Google's block page, which says nothing
 * about this install. Only `absent` warns — with a `group:` or `domain:`
 * member the bridge cannot know, and a warning that may be wrong teaches
 * people to ignore it.
 */
export function iapLine(person: Pick<Person, 'email' | 'iapAccess'>): string | null {
  if (person.iapAccess !== 'absent' || !person.email) return null;
  return (
    `IAP does not admit this address, so they cannot open the console. Run: openadlc cloud members add ${person.email} — ` +
    `or add "user:${person.email}" to console_members in $OPENADLC_HOME/cloud.tfvars.json and run openadlc cloud apply. ` +
    'A grant added by hand with gcloud does not last: console_members is the whole list, and the next apply removes anything else.'
  );
}

const ROLE_WORDS: Record<Role, string> = { admin: 'Admin', user: 'User' };

const ROLES_LINE =
  'Admins reach everything; users file requests, answer the crew and read the board. Approves lets a person’s GitHub login answer gates, approve plan changes and reserved paths, and review production; adding someone or giving them a role never does.';

/**
 * The card's line. On a local install the bridge sees one identity for every
 * console request, so a console role restricts nobody there; saying "who may
 * use the console" let an operator believe a colleague was limited.
 */
export function peopleLine(identityMode: IdentityMode | undefined): string {
  if (identityMode === 'local')
    return `On a local install the console is one person, the operator; add others by GitHub login, to answer the crew on GitHub. ${ROLES_LINE}`;
  return `Who may use the console, and who answers the crew on GitHub. ${ROLES_LINE}`;
}

/** What People calls a person: name, else email, else `@login`. */
export function personLabel(person: Pick<Person, 'id' | 'name' | 'email' | 'github'>): string {
  return person.name.trim() || person.email || (person.github ? `@${person.github.login}` : person.id);
}

/** What the GitHub column says of an account: confirmed by the person's own link, or only named by an admin. */
export function githubLine(person: Pick<Person, 'github'>): string {
  if (!person.github) return 'No GitHub account';
  return `@${person.github.login} · ${person.github.confirmed ? 'confirmed' : 'named'}`;
}

/** A login as it is typed, checked on GitHub once typing stops. */
function useLoginCheck(login: string): string | null {
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    const typed = login.trim().replace(/^@/, '');
    if (!typed) {
      setSaid(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void checkGithubLogin(typed).then((found) => {
        if (!current) return;
        setSaid(found === null ? 'GitHub did not answer' : found.exists ? `@${found.login ?? typed} is on GitHub` : `GitHub has no account @${typed}`);
      });
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [login]);
  return said;
}

/**
 * Settings → People: the install's one list of people. Each is their console
 * sign-in, their GitHub account, whether they approve, and the roles they
 * hold (edited in Roles). The bridge refuses to demote or remove the last
 * admin, and audits every change; this only says what it answered.
 */
export function PeopleSection({
  initial,
  roles,
  me,
  identityMode,
}: {
  initial: PeopleView | null;
  roles: PersonRole[];
  me: string;
  /** Unknown when the bridge could not say who is asking. */
  identityMode?: IdentityMode;
}) {
  const [view, setView] = useState<PeopleView | null>(initial);
  const [draft, setDraft] = useState<{ name: string; email: string; login: string; role: Role | '' }>({ name: '', email: '', login: '', role: 'user' });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ name: string; email: string; login: string }>({ name: '', email: '', login: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const local = (view?.identityMode ?? identityMode) === 'local';
  const checked = useLoginCheck(draft.login);
  // The page is read again every fifteen seconds: what it read is taken while
  // nothing here is in flight, so a person another admin added shows.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen && !pending) {
    setSeen(initial);
    setView(initial);
  }

  const act = (work: () => Promise<{ ok: boolean; error?: string; person?: Person }>, then?: (person?: Person) => void) => {
    setError(null);
    startTransition(async () => {
      // A call that fails outright is said here; inside the transition it took the page down.
      const result = (await safeAction(work)) as { ok: boolean; error?: string; person?: Person };
      if (!result.ok) {
        setError(result.error ?? 'that did not go through');
        return;
      }
      if (result.person) {
        const next = result.person;
        setView((now) => (now ? { ...now, people: now.people.some((one) => one.id === next.id) ? now.people.map((one) => (one.id === next.id ? next : one)) : [...now.people, next] } : now));
      }
      then?.(result.person);
    });
  };
  const drop = (id: string) => setView((now) => (now ? { ...now, people: now.people.filter((one) => one.id !== id) } : now));
  const roleName = (id: string) => roles.find((role) => role.id === id)?.name ?? id;
  const people = view?.people ?? [];

  return (
    <SettingsCard id="people" title="People" line={peopleLine(view?.identityMode ?? identityMode)}>
      {view === null ? (
        <p className="text-[12.5px] text-muted">The list could not be read. Reload to try again.</p>
      ) : (
        <ul aria-label="People" className="flex flex-col divide-y divide-edge text-[12.5px]">
          {people.map((person) => {
            const label = personLabel(person);
            const fromEnvironment = person.approvesFrom === 'environment';
            return (
              <li key={person.id} data-person={person.id} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1">
                    <span className="text-body">{label}</span>
                    {person.email && person.email === me && <span className="ml-1.5 text-muted">(you)</span>}
                    {person.email && person.name.trim() && <span className="ml-1.5 font-mono text-muted">{person.email}</span>}
                    <span className="block text-[11.5px] text-muted">{githubLine(person)}</span>
                    {person.roles.length > 0 && <span className="block text-[11.5px] text-soft">{person.roles.map(roleName).join(', ')}</span>}
                    {iapLine(person) && (
                      <span role="alert" className="block text-[11.5px] text-alarm">
                        {iapLine(person)}
                      </span>
                    )}
                  </span>
                  {!person.virtual && (
                    <select
                      value={person.consoleRole ?? ''}
                      disabled={pending}
                      aria-label={`console role for ${label}`}
                      onChange={(event) => {
                        const next = (event.target.value || null) as Role | null;
                        act(() => changePerson(person.id, { consoleRole: next }));
                      }}
                      className="rounded-md border border-edge-strong bg-panel px-2 py-1 text-[12.5px] text-body"
                    >
                      <option value="admin">{ROLE_WORDS.admin}</option>
                      <option value="user">{ROLE_WORDS.user}</option>
                      <option value="">No console</option>
                    </select>
                  )}
                  <label className="flex items-center gap-1.5" title={fromEnvironment ? 'from OPENADLC_HUMANS' : undefined}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`Approves: ${label}`}
                      checked={person.approves}
                      disabled={pending || fromEnvironment || person.virtual}
                      onChange={(event) => {
                        const on = event.target.checked;
                        act(() => setApproves(person.id, on));
                      }}
                    />
                    <span className="text-soft">{fromEnvironment ? 'Approves · from OPENADLC_HUMANS' : 'Approves'}</span>
                  </label>
                  {!person.virtual && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => {
                          setEditing(editing === person.id ? null : person.id);
                          setEdit({ name: person.name, email: person.email ?? '', login: person.github?.login ?? '' });
                        }}
                      >
                        Edit
                      </Button>
                      {people.filter((other) => other.id !== person.id && !other.virtual).length > 0 && (
                        <select
                          aria-label={`Merge ${label} into`}
                          value=""
                          disabled={pending}
                          onChange={(event) => {
                            const into = event.target.value;
                            if (into) act(() => mergePerson(person.id, into), () => drop(person.id));
                          }}
                          className="rounded-md border border-edge bg-panel px-2 py-0.5 text-[12px] text-body"
                        >
                          <option value="">Merge into…</option>
                          {people
                            .filter((other) => other.id !== person.id && !other.virtual)
                            .map((other) => (
                              <option key={other.id} value={other.id}>
                                {personLabel(other)}
                              </option>
                            ))}
                        </select>
                      )}
                      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => act(() => removePerson(person.id), () => drop(person.id))}>
                        Remove
                      </Button>
                    </>
                  )}
                </div>
                {editing === person.id && (
                  <form
                    aria-label={`Edit ${label}`}
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      // Only what changed: a login sent again is asked of GitHub again.
                      const fields: PersonFields = {
                        ...(edit.name !== person.name ? { name: edit.name } : {}),
                        ...((edit.email.trim() || null) !== person.email ? { email: edit.email.trim() || null } : {}),
                        ...((edit.login.trim() || null) !== (person.github?.login ?? null) ? { githubLogin: edit.login.trim() || null } : {}),
                      };
                      act(() => changePerson(person.id, fields), () => setEditing(null));
                    }}
                  >
                    <Field label="Name" value={edit.name} onChange={(name) => setEdit({ ...edit, name })} />
                    <Field label="Email" value={edit.email} onChange={(email) => setEdit({ ...edit, email })} />
                    <Field label="GitHub login" value={edit.login} onChange={(login) => setEdit({ ...edit, login })} />
                    <Button type="submit" size="md" variant="primary" disabled={pending}>
                      Save
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        aria-label="Add a person"
        className="mt-2 flex flex-wrap items-end gap-2 text-[12.5px]"
        onSubmit={(event) => {
          event.preventDefault();
          const fields: PersonFields = {
            ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
            ...(!local && draft.email.trim() ? { email: draft.email.trim(), consoleRole: draft.role || null } : {}),
            ...(draft.login.trim() ? { githubLogin: draft.login.trim() } : {}),
          };
          act(() => addPerson(fields), () => setDraft({ name: '', email: '', login: '', role: 'user' }));
        }}
      >
        <Field label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
        {!local && <Field label="Email" type="email" value={draft.email} placeholder="jane@example.com" onChange={(email) => setDraft({ ...draft, email })} />}
        <label className="flex flex-col gap-1">
          <span className="text-soft">GitHub login</span>
          <input
            aria-label="GitHub login"
            value={draft.login}
            onChange={(event) => setDraft({ ...draft, login: event.target.value })}
            placeholder="janedoe"
            className="h-9 rounded-md border border-edge-strong bg-panel px-2.5 text-[13px] text-body"
          />
          {checked && <span className="text-[11.5px] text-muted">{checked}</span>}
        </label>
        {!local && (
          <label className="flex flex-col gap-1">
            <span className="text-soft">Console role</span>
            <select
              aria-label="Console role"
              value={draft.role}
              onChange={(event) => setDraft({ ...draft, role: event.target.value as Role | '' })}
              className="h-9 rounded-md border border-edge-strong bg-panel px-2 text-[13px] text-body"
            >
              <option value="user">{ROLE_WORDS.user}</option>
              <option value="admin">{ROLE_WORDS.admin}</option>
              <option value="">No console</option>
            </select>
          </label>
        )}
        <Button type="submit" size="md" variant="primary" disabled={pending || (!draft.email.trim() && !draft.login.trim())}>
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

function Field({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string }) {
  return (
    <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
      <span className="text-soft">{label}</span>
      <input
        aria-label={label}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-edge-strong bg-panel px-2.5 text-[13px] text-body"
      />
    </label>
  );
}
