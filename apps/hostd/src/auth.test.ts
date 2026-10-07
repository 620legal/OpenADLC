import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  auditActor,
  authenticate,
  INTERNAL_SECRET_HEADER,
  ON_BEHALF_OF_HEADER,
  PRINCIPAL,
  secretMatches,
} from './auth.js';

const SECRET = 'a'.repeat(64);

function request(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('hostd will not serve a caller it cannot authenticate', () => {
  it('admits the install secret', () => {
    expect(authenticate(request({ [INTERNAL_SECRET_HEADER]: SECRET }), SECRET)).toEqual({
      principal: PRINCIPAL,
      onBehalfOf: null,
    });
  });

  it('refuses a request carrying no secret at all', () => {
    expect(authenticate(request({}), SECRET)).toBeNull();
  });

  it('refuses the wrong secret of the same length', () => {
    expect(authenticate(request({ [INTERNAL_SECRET_HEADER]: 'b'.repeat(64) }), SECRET)).toBeNull();
  });

  it('refuses a prefix of the secret', () => {
    expect(authenticate(request({ [INTERNAL_SECRET_HEADER]: SECRET.slice(0, 32) }), SECRET)).toBeNull();
  });

  it('admits nobody when the install has no secret, rather than everybody', () => {
    // The dangerous reading of "compare the secret" is that an empty expected
    // value matches an empty offer, which would open every route on an install
    // whose secret had not been written yet.
    expect(secretMatches('', '')).toBe(false);
    expect(authenticate(request({}), '')).toBeNull();
    expect(authenticate(request({ [INTERNAL_SECRET_HEADER]: '' }), '')).toBeNull();
  });

  it('does not let a repeated header smuggle a second value past the check', () => {
    expect(authenticate(request({ [INTERNAL_SECRET_HEADER]: ['wrong', SECRET] }), SECRET)).toBeNull();
  });
});

describe('the audit actor comes from what was authenticated', () => {
  it('names the principal when the caller asserted nobody', () => {
    const caller = authenticate(request({ [INTERNAL_SECRET_HEADER]: SECRET }), SECRET);

    // Never 'unknown', which is what the body used to default to.
    expect(auditActor(caller!)).toBe(PRINCIPAL);
    expect(auditActor(caller!)).not.toContain('unknown');
  });

  it('keeps the person and the principal both visible', () => {
    const caller = authenticate(
      request({ [INTERNAL_SECRET_HEADER]: SECRET, [ON_BEHALF_OF_HEADER]: 'alice' }),
      SECRET,
    );

    // The person is an assertion hostd cannot check, so the row says which
    // principal made it rather than presenting it as established fact.
    expect(caller?.onBehalfOf).toBe('alice');
    expect(auditActor(caller!)).toBe(`alice via ${PRINCIPAL}`);
  });

  it('treats a blank assertion as no assertion', () => {
    const caller = authenticate(
      request({ [INTERNAL_SECRET_HEADER]: SECRET, [ON_BEHALF_OF_HEADER]: '   ' }),
      SECRET,
    );

    expect(caller?.onBehalfOf).toBeNull();
    expect(auditActor(caller!)).toBe(PRINCIPAL);
  });

  it('cannot be named by an unauthenticated caller at all', () => {
    // The point of the change: naming yourself is no longer a thing you can do
    // without the secret, whatever you put in the request.
    expect(authenticate(request({ [ON_BEHALF_OF_HEADER]: 'root' }), SECRET)).toBeNull();
  });
});
