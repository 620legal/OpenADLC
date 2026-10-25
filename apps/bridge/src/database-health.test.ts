import { describe, expect, it } from 'vitest';
import { databaseProblem } from './database-health.js';

const env = { DATABASE_URL: 'postgres://openadlc:not-printed@127.0.0.1:47432/openadlc_db', OPENADLC_DATABASE_CONTAINER: 'openadlc-db' };
const NOT_ANSWERING = "the install's database (openadlc-db) isn't answering on 127.0.0.1:47432: start it with `docker start openadlc-db`, or run `openadlc up`";

describe('what the bridge says of its database', () => {
  it('says nothing when it answers', async () => {
    expect(await databaseProblem({ ask: async () => [{ answers: 1 }], env })).toBeNull();
  });

  it('says it is not answering, and how to start it, when nothing takes the connection or it never answers', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:47432'), { code: 'ECONNREFUSED' });
    expect(await databaseProblem({ ask: async () => Promise.reject(refused), env })).toBe(NOT_ANSWERING);
    // The pool would wait thirty seconds for a connection; /healthz does not.
    expect(await databaseProblem({ ask: () => new Promise(() => undefined), env, timeoutMs: 20 })).toBe(NOT_ANSWERING);
  });

  // A server that answered is up, and `docker start` would send a person the wrong way.
  it('says what a server that answered and refused said, without telling anyone to start it', async () => {
    const refused = Object.assign(new Error('password authentication failed for user "openadlc"'), { severity: 'FATAL', code: '28P01' });
    const said = await databaseProblem({ ask: async () => Promise.reject(refused), env });
    expect(said).toBe('the install\'s database on 127.0.0.1:47432 answered the bridge with an error: password authentication failed for user "openadlc"');
    expect(said).not.toContain('not-printed');
  });
});
