import { describe, expect, it } from 'vitest';
import { isEmail, normalizeEmail } from './users.js';

/** The console users themselves are people now; see people.test.ts. */
describe('how a console sign-in is spelt', () => {
  it('keys a person on one spelling', () => {
    expect(normalizeEmail('accounts.google.com:JaneDoe@Example.com')).toBe('janedoe@example.com');
    // As `console_members` writes it, pasted into Add or into admin_emails.
    expect(normalizeEmail(' user:JaneDoe@Example.com')).toBe('janedoe@example.com');
  });

  it('takes an address, not a bare name', () => {
    expect(isEmail('jane@example.com')).toBe(true);
    expect(isEmail('console')).toBe(false);
  });
});
