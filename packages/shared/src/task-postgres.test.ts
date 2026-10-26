import { describe, expect, it } from 'vitest';
import {
  isTaskPostgresImage,
  parseTaskPostgres,
  taskPostgresAddresses,
  taskPostgresImageRefusal,
  taskPostgresRepositoryOf,
  TASK_POSTGRES_MAX_SERVERS,
  withoutPasswords,
} from './task-postgres.js';

/** acme/app's local Postgres, as its docker-compose.yml and Makefile name it. */
const APP = { port: 55432, superuser: 'app', password: 'app', database: 'app_db', image: 'pgvector/pgvector:pg16' };
const DIGEST = `sha256:${'a'.repeat(64)}`;

function refusal(input: unknown): string {
  const read = parseTaskPostgres(input);
  if (read.ok) throw new Error(`expected a refusal, got ${JSON.stringify(read.setting)}`);
  return read.error;
}

describe('a repository’s Postgres servers for its tasks', () => {
  it('reads app’s one server, with no database on the shared server unless it asks', () => {
    expect(parseTaskPostgres({ servers: [APP] })).toEqual({ ok: true, setting: { servers: [APP], sharedDatabase: false } });
    expect(parseTaskPostgres({ servers: [APP], sharedDatabase: true })).toEqual({ ok: true, setting: { servers: [APP], sharedDatabase: true } });
  });

  it('reads no servers, or nothing stored, as the setting being off', () => {
    expect(parseTaskPostgres({ servers: [] })).toEqual({ ok: true, setting: null });
    expect(parseTaskPostgres(null)).toEqual({ ok: true, setting: null });
  });

  it('takes a port typed as digits, as a form sends it', () => {
    const read = parseTaskPostgres({ servers: [{ ...APP, port: '55432' }] });
    expect(read).toMatchObject({ ok: true, setting: { servers: [{ port: 55432 }] } });
  });

  it('refuses an image outside the allowlist, and says which images it takes and how to pin one', () => {
    const error = refusal({ servers: [{ ...APP, image: 'evil/postgres:16' }] });
    expect(error).toContain("evil/postgres:16 is not an image a task's server may run");
    expect(error).toContain('pgvector/pgvector:<tag> or postgres:<tag>');
    expect(error).toContain('@sha256:<digest>');
  });

  it('allows pgvector’s images and Docker’s official postgres, at a tag, a digest or both', () => {
    for (const image of [
      'pgvector/pgvector:pg16',
      'pgvector/pgvector:0.8.0-pg17-bookworm',
      `pgvector/pgvector:pg16@${DIGEST}`,
      'docker.io/pgvector/pgvector:pg16',
      'postgres:16',
      'postgres:16.4-alpine',
      'library/postgres:17',
      'docker.io/library/postgres:15',
      `postgres@${DIGEST}`,
    ]) {
      expect(isTaskPostgresImage(image), image).toBe(true);
    }
  });

  it('refuses a bare name, another publisher, a registry of someone else’s, or a malformed digest', () => {
    for (const image of [
      'postgres',
      'pgvector/pgvector',
      'postgres:latest@sha256:abc',
      'ghcr.io/someone/postgres:16',
      'evil.example/library/postgres:16',
      'pgvector/pgvector-fork:pg16',
      'postgres:16 --privileged',
      'postgres:16@sha256:x@sha256:y',
      '',
    ]) {
      expect(isTaskPostgresImage(image), image).toBe(false);
    }
  });

  it('refuses a name every object answers to, which is no repository the allowlist names', () => {
    // `in` found these on Object.prototype, and let them through at any tag.
    for (const image of ['constructor:16', 'toString:1', 'hasOwnProperty:pg16', '__proto__:16']) {
      expect(isTaskPostgresImage(image), image).toBe(false);
      expect(taskPostgresRepositoryOf(image), image).toBeNull();
    }
  });

  it('says which allowed repository an image is from whatever its tag, and what a save says of one it refuses', () => {
    expect(taskPostgresRepositoryOf('docker.io/library/postgres:16')).toBe('postgres');
    expect(taskPostgresRepositoryOf('pgvector/pgvector')).toBe('pgvector/pgvector');
    expect(taskPostgresRepositoryOf('bitnami/postgresql:16')).toBeNull();
    expect(taskPostgresImageRefusal('pgvector/pgvector:pg16')).toBeNull();
    expect(taskPostgresImageRefusal('bitnami/postgresql:16')).toBe(refusal({ servers: [{ ...APP, image: 'bitnami/postgresql:16' }] }));
  });

  it('refuses a port outside 1024–65535, or two servers on one port', () => {
    expect(refusal({ servers: [{ ...APP, port: 80 }] })).toMatch(/server 1's port is a whole number from 1024 to 65535/);
    expect(refusal({ servers: [{ ...APP, port: 55432.5 }] })).toMatch(/whole number/);
    expect(refusal({ servers: [APP, { ...APP, database: 'other' }] })).toBe(
      "two servers cannot both listen on 55432 in one task's computer: give each a port of its own",
    );
  });

  it('refuses a superuser or database that is not a plain Postgres name', () => {
    expect(refusal({ servers: [{ ...APP, superuser: 'App; drop' }] })).toMatch(/server 1's superuser is a Postgres name/);
    expect(refusal({ servers: [{ ...APP, database: 'app-db' }] })).toMatch(/server 1's database is a Postgres name/);
  });

  it('refuses a password that would not survive the environment', () => {
    expect(refusal({ servers: [{ ...APP, password: 'two\nlines' }] })).toMatch(/needs its superuser's password.*printable characters/);
    expect(refusal({ servers: [{ ...APP, password: 'x'.repeat(101) }] })).toMatch(/1 to 100 printable characters/);
  });

  it('says an empty field is empty, apart from a value it refuses, as the form sends a server it added', () => {
    // What the form sends for a server added and saved with nothing typed:
    // every field empty but the image it starts with.
    const added = { port: '', superuser: '', password: '', database: '', image: 'pgvector/pgvector:pg16' };
    expect(refusal({ servers: [added] })).toBe("server 1 has no port: give the port the repository's Makefile reaches it on");
    expect(refusal({ servers: [{ ...APP, port: '  ' }] })).toBe("server 1 has no port: give the port the repository's Makefile reaches it on");
    expect(refusal({ servers: [{ ...APP, port: undefined }] })).toMatch(/^server 1 has no port: /);
    expect(refusal({ servers: [{ ...APP, superuser: '' }] })).toBe("server 1 has no superuser: give the superuser the repository's own database URLs log in as");
    expect(refusal({ servers: [{ ...APP, password: '' }] })).toBe("server 1 has no password: give its superuser's password, as the repository's own database URLs give it");
    expect(refusal({ servers: [{ ...APP, database: ' ' }] })).toBe("server 1 has no database: give the database the repository's own database URLs name");
    expect(refusal({ servers: [{ ...APP, image: '' }] })).toBe('server 1 has no image: use pgvector/pgvector:<tag> or postgres:<tag>, such as pgvector/pgvector:pg16');
    expect(refusal({ servers: [APP, { ...APP, port: 55433, database: null }] })).toMatch(/^server 2 has no database: /);

    // A value that is there and wrong is still said as that.
    expect(refusal({ servers: [{ ...APP, port: '80' }] })).toMatch(/^server 1's port is a whole number from 1024 to 65535/);
    expect(refusal({ servers: [{ ...APP, port: 'five' }] })).toMatch(/^server 1's port is a whole number/);
    expect(refusal({ servers: [{ ...APP, superuser: 'App' }] })).toMatch(/^server 1's superuser is a Postgres name/);
  });

  it(`refuses more than ${TASK_POSTGRES_MAX_SERVERS} servers, and a shape it cannot read`, () => {
    const many = Array.from({ length: TASK_POSTGRES_MAX_SERVERS + 1 }, (_, index) => ({ ...APP, port: 55432 + index }));
    expect(refusal({ servers: many })).toMatch(/at most 4 servers/);
    expect(refusal({ servers: 'app' })).toMatch(/servers is a list/);
    expect(refusal([APP])).toMatch(/send \{ servers: \[\] \} to turn it off/);
    expect(refusal({ servers: [APP], sharedDatabase: 'yes' })).toMatch(/sharedDatabase is true or false/);
  });

  it('tells a task where each server listens in its computer, and leaves passwords out of what others read', () => {
    expect(taskPostgresAddresses([APP, { ...APP, port: 55499 }])).toEqual(['127.0.0.1:55432', '127.0.0.1:55499']);
    expect(JSON.stringify(withoutPasswords({ servers: [{ ...APP, password: 'hunter2' }], sharedDatabase: false }))).not.toContain('hunter2');
  });
});
