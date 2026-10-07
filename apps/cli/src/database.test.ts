import { describe, expect, it } from 'vitest';
import { databaseUnreachable } from './database.js';

const URL = 'postgres://fleetadlc:secret@127.0.0.1:47432/fleetadlc_db';

describe('a database error that means the database cannot be used', () => {
  // With the stack stopped, commands printed `connect ECONNREFUSED …` or
  // "unexpected Error, reported without its message".
  it('says where the database was looked for and to start the stack', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:47432'), { code: 'ECONNREFUSED' });
    expect(databaseUnreachable(refused, URL)).toBe('cannot reach the database (fleetadlc_db on 127.0.0.1:47432): start the stack with fleetadlc up');
    expect(databaseUnreachable({ code: 'ENOTFOUND' }, URL)).toContain('start the stack with fleetadlc up');
  });

  it('says a refused password is install.json’s to fix, without the password', () => {
    const said = databaseUnreachable({ code: '28P01' }, URL);
    expect(said).toContain('check databaseUrl in install.json');
    expect(said).not.toContain('secret');
  });

  it('is null for anything else', () => {
    expect(databaseUnreachable(new Error('relation "settings" does not exist'), URL)).toBeNull();
    expect(databaseUnreachable(null, URL)).toBeNull();
  });
});
