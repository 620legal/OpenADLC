/**
 * What each person may do in the console, and how an email is spelt. The
 * rows themselves are people (`people.ts`, `migrations/0162_people.sql`): a
 * console user is a person with an email and a console role. The bridge
 * enforces the role (`roles.ts`).
 */
export type Role = 'admin' | 'user';

export const ROLES: readonly Role[] = ['admin', 'user'];

/**
 * How a person came to be: added by an admin, one of the first admins and
 * from where, or brought forward by 0162 from `humans`, a linked account, or
 * a role member no person held.
 */
export type AddedHow = 'added' | 'first' | 'admin-emails' | 'console-members' | 'humans' | 'linked' | 'roles';

export interface User {
  email: string;
  role: Role;
  addedBy: string;
  addedHow: AddedHow;
  addedAt: string;
  updatedAt: string;
}

interface Row {
  email: string;
  role: Role;
  added_by: string;
  added_how: AddedHow;
  added_at: Date;
  updated_at: Date;
}

/**
 * A change refused for what it would do, not because the database failed:
 * the route says it as a 409 or a 404 a person can act on.
 */
export class UserChangeRefused extends Error {
  constructor(
    readonly reason: 'last-admin' | 'exists' | 'not-found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'UserChangeRefused';
  }
}

/**
 * One spelling per person. IAP's claim can carry `accounts.google.com:` in
 * front, an address copied from `console_members` carries `user:`, and a
 * person typing one capitalises it however they like; the row is keyed on
 * none of them, or it would never match the email IAP asserts.
 */
export function normalizeEmail(email: string): string {
  return email.trim().replace(/^accounts\.google\.com:/i, '').replace(/^user:/i, '').trim().toLowerCase();
}

/** Something an admin can type that could be the email IAP asserts. */
export function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(email);
}
