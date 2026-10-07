import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CONSOLE_SECRET_HEADER,
  describeIdentity,
  IAP_ASSERTION_HEADER,
  FORWARDED_ASSERTION_HEADER,
  IAP_EMAIL_HEADER,
  Identity,
  identityFromConfig,
  LOCAL_IDENTITY_HEADER,
  type Jwks,
} from './identity.js';

const AUDIENCE = '/projects/123456789/global/backendServices/987654321';
const ISSUER = 'https://cloud.google.com/iap';
const KID = 'test-key';

let privateKey: KeyObject;
let jwks: Jwks;
/** A second key, to stand in for something that signs but is not IAP. */
let impostorKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  privateKey = pair.privateKey;
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwks = { keys: [{ ...jwk, kid: KID, alg: 'ES256' } as Jwks['keys'][number]] };
  impostorKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
});

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function assertion(
  claims: Record<string, unknown> = {},
  options: { header?: Record<string, unknown>; key?: KeyObject } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'ES256', kid: KID, typ: 'JWT', ...options.header });
  const payload = b64({
    iss: ISSUER,
    aud: AUDIENCE,
    email: 'alice@example.com',
    sub: 'accounts.google.com:1',
    iat: now,
    exp: now + 600,
    ...claims,
  });
  // ES256 in a JWT is the raw r||s pair, which is what ieee-p1363 produces.
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'utf8'), {
    key: options.key ?? privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function iapResolver(): Identity {
  return new Identity('iap', AUDIENCE, '', async () => jwks);
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
    throw new Error('the assertion was accepted, and should not have been');
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status !== 'number') throw error;
    return { status, message: (error as Error).message };
  }
}

describe('a verified IAP assertion is the identity', () => {
  it('takes the person from the signed claim', async () => {
    const who = await iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: assertion() }));
    expect(who).toBe('alice@example.com');
  });

  it('strips the prefix Google puts on the subject form', async () => {
    const who = await iapResolver().resolve(
      request({ [IAP_ASSERTION_HEADER]: assertion({ email: 'accounts.google.com:bob@example.com' }) }),
    );
    expect(who).toBe('bob@example.com');
  });
});

describe('the assertion as the console forwards it', () => {
  // Google strips `x-goog-*` on the way into a run.app service, so the console
  // carries the assertion under an OpenADLC name as well.
  it('is the identity when it verifies', async () => {
    const who = await iapResolver().resolve(request({ [FORWARDED_ASSERTION_HEADER]: assertion() }));
    expect(who).toBe('alice@example.com');
  });

  it('is refused like any other when it does not', async () => {
    const forged = assertion({ aud: '/projects/1/global/backendServices/somebody-else' });
    const { status } = await refusal(iapResolver().resolve(request({ [FORWARDED_ASSERTION_HEADER]: forged })));
    expect(status).toBe(401);
  });
});

describe('an unverifiable assertion is refused, not downgraded', () => {
  it('refuses a request with no assertion at all, naming both headers and where to open OpenADLC', async () => {
    const { status, message } = await refusal(iapResolver().resolve(request({})));
    expect(status).toBe(401);
    expect(message).toContain(`(${IAP_ASSERTION_HEADER} or ${FORWARDED_ASSERTION_HEADER})`);
    expect(message).toContain('open OpenADLC at its IAP-protected address');
  });

  it('refuses a forged email header that carries no assertion', async () => {
    // The whole point: this header is what the bridge used to believe.
    const { status } = await refusal(
      iapResolver().resolve(request({ [IAP_EMAIL_HEADER]: 'attacker@example.com' })),
    );
    expect(status).toBe(401);
  });

  it('refuses a forged local header too', async () => {
    const { status } = await refusal(
      iapResolver().resolve(request({ [LOCAL_IDENTITY_HEADER]: 'attacker@example.com' })),
    );
    expect(status).toBe(401);
  });

  it('refuses an assertion whose payload was edited after signing', async () => {
    const [header, , signature] = assertion().split('.') as [string, string, string];
    const swapped = b64({
      iss: ISSUER,
      aud: AUDIENCE,
      email: 'attacker@example.com',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const { status } = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: `${header}.${swapped}.${signature}` })),
    );
    expect(status).toBe(401);
  });

  it('refuses something that signs correctly but is not IAP', async () => {
    const { status } = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: assertion({}, { key: impostorKey }) })),
    );
    expect(status).toBe(401);
  });

  it('refuses a valid assertion issued for a different service', async () => {
    // Correctly signed by IAP, for somebody else's backend. Without the audience
    // check this is the hole that stays open after the signature verifies.
    const { status, message } = await refusal(
      iapResolver().resolve(
        request({
          [IAP_ASSERTION_HEADER]: assertion({ aud: '/projects/999/global/backendServices/111' }),
        }),
      ),
    );
    expect(status).toBe(401);
    expect(message).toContain('different service');
  });

  it('refuses an assertion from the wrong issuer', async () => {
    const { status } = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: assertion({ iss: 'https://example.com' }) })),
    );
    expect(status).toBe(401);
  });

  it('refuses an expired assertion', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const { status, message } = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: assertion({ iat: past, exp: past + 600 }) })),
    );
    expect(status).toBe(401);
    expect(message).toContain('expired');
  });

  it('refuses an assertion with no email to act as', async () => {
    const { status } = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: assertion({ email: '' }) })),
    );
    expect(status).toBe(401);
  });

  it('will not be talked out of verifying by the algorithm it is handed', async () => {
    // `alg: none` with an empty signature is the classic way past a verifier
    // that reads the algorithm out of the token it is checking.
    const header = b64({ alg: 'none', kid: KID });
    const payload = b64({ iss: ISSUER, aud: AUDIENCE, email: 'attacker@example.com', exp: 9_999_999_999 });
    const { status } = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: `${header}.${payload}.` })),
    );
    expect(status).toBe(401);

    // And an HMAC over the public key, which is the other half of that trick.
    const hs256 = b64({ alg: 'HS256', kid: KID });
    const forged = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: `${hs256}.${payload}.aaaa` })),
    );
    expect(forged.status).toBe(401);
  });

  it('refuses a token that is not a three-part JWT', async () => {
    const { status } = await refusal(iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: 'nonsense' })));
    expect(status).toBe(401);
  });

  it('refuses an assertion signed by a key it has never heard of', async () => {
    const { status } = await refusal(
      iapResolver().resolve(request({ [IAP_ASSERTION_HEADER]: assertion({}, { header: { kid: 'unknown' } }) })),
    );
    expect(status).toBe(401);
  });

  it('re-reads the keys once before calling an unknown kid a forgery', async () => {
    // IAP rotates its signing keys, so a kid that is new to us is not yet a bad
    // assertion; it is a stale cache.
    let calls = 0;
    const rotating = new Identity('iap', AUDIENCE, '', async () => {
      calls += 1;
      return calls === 1 ? { keys: [] } : jwks;
    });

    expect(await rotating.resolve(request({ [IAP_ASSERTION_HEADER]: assertion() }))).toBe('alice@example.com');
    expect(calls).toBe(2);
  });
});

describe('the key set cannot be used against us', () => {
  it('refuses a key that is not the EC P-256 one ES256 needs', async () => {
    // An RSA key here would let verify('sha256', …) check an RSA signature
    // while `alg` still read ES256, so the algorithm pin alone is not enough.
    const rsa = { kty: 'RSA', kid: KID, n: 'abc', e: 'AQAB' } as Jwks['keys'][number];
    const resolver = new Identity('iap', AUDIENCE, '', async () => ({ keys: [rsa] }));

    const { status, message } = await refusal(
      resolver.resolve(request({ [IAP_ASSERTION_HEADER]: assertion() })),
    );
    expect(status).toBe(401);
    expect(message).toContain('EC P-256');
  });

  it('does not re-read the key set for a kid it has just refused', async () => {
    let calls = 0;
    const resolver = new Identity('iap', AUDIENCE, '', async () => {
      calls += 1;
      return { keys: [] };
    });
    const bad = request({ [IAP_ASSERTION_HEADER]: assertion({}, { header: { kid: 'invented' } }) });

    await refusal(resolver.resolve(bad));
    const afterFirst = calls;
    // Without a negative cache each of these is a fresh outbound fetch, so
    // anything that can reach the bridge can make it hammer Google — and a
    // failing fetch refuses the console along with the attacker.
    await refusal(resolver.resolve(bad));
    await refusal(resolver.resolve(bad));

    expect(calls).toBe(afterFirst);
  });

  it('reads the key set again at most once a minute for kids it has never seen, however many', async () => {
    let calls = 0;
    const resolver = new Identity('iap', AUDIENCE, '', async () => {
      calls += 1;
      return { keys: [] };
    });

    await refusal(resolver.resolve(request({ [IAP_ASSERTION_HEADER]: assertion({}, { header: { kid: 'invented-0' } }) })));
    const afterFirst = calls;
    // A new kid every time misses the per-kid cache; each was a fresh fetch.
    for (let index = 1; index <= 20; index += 1) {
      await refusal(resolver.resolve(request({ [IAP_ASSERTION_HEADER]: assertion({}, { header: { kid: `invented-${index}` } }) })));
    }

    expect(calls).toBe(afterFirst);
  });

  it('survives a key set served without a keys array', async () => {
    const resolver = new Identity('iap', AUDIENCE, '', async () => ({}) as Jwks);
    const { status } = await refusal(resolver.resolve(request({ [IAP_ASSERTION_HEADER]: assertion() })));
    expect(status).toBe(401);
  });
});

describe('local mode believes the header only from the console and the CLI', () => {
  const SECRET = 'a'.repeat(64);
  const local = new Identity('local', '', SECRET);

  it('takes the header from a caller holding the console secret', async () => {
    expect(await local.resolve(request({ [CONSOLE_SECRET_HEADER]: SECRET, [LOCAL_IDENTITY_HEADER]: 'janedoe' }))).toBe('janedoe');
  });

  it('falls back to a name rather than an empty identity', async () => {
    expect(await local.resolve(request({ [CONSOLE_SECRET_HEADER]: SECRET }))).toBe('local operator');
  });

  it('refuses a caller without the secret, whatever name it gives', async () => {
    // Anything that reached the port named itself and was an admin.
    const callers: Record<string, string>[] = [
      {},
      { [LOCAL_IDENTITY_HEADER]: 'owner@example.com' },
      { [CONSOLE_SECRET_HEADER]: 'b'.repeat(64) },
      { [CONSOLE_SECRET_HEADER]: 'short' },
    ];
    for (const headers of callers) {
      const { status, message } = await refusal(local.resolve(request(headers)));
      expect(status).toBe(401);
      expect(message).toContain('only to its console and the fleetadlc CLI');
      expect(message).not.toContain('b'.repeat(64));
    }
  });

  it('does not read the IAP email header, which only IAP can vouch for', async () => {
    const who = await local.resolve(
      request({ [CONSOLE_SECRET_HEADER]: SECRET, [IAP_EMAIL_HEADER]: 'attacker@example.com', [LOCAL_IDENTITY_HEADER]: 'janedoe' }),
    );
    expect(who).toBe('janedoe');
  });

  it('refuses everybody when it was given no secret to compare with', async () => {
    const { status } = await refusal(new Identity('local', '').resolve(request({ [CONSOLE_SECRET_HEADER]: '' })));
    expect(status).toBe(401);
  });

  it('says which path is in force, in both modes', () => {
    expect(local.describe()).toContain('local header');
    expect(local.describe()).toContain('console secret');
    expect(iapResolver().describe()).toContain('verified IAP assertion');
    expect(iapResolver().describe()).toContain(AUDIENCE);
  });

  it('says it in the same words `fleetadlc status` is given', () => {
    // `/v1/status` built its own sentence, and told a local install that
    // anything reaching the bridge could name itself, long after the console
    // secret closed that.
    expect(local.describe()).toBe(describeIdentity('local', ''));
    expect(iapResolver().describe()).toBe(describeIdentity('iap', AUDIENCE));
  });
});

describe('the install refuses to run a check that would pass everything', () => {
  it('will not start in iap mode without an audience', () => {
    // A signature check with no audience accepts any service's valid assertion,
    // which is worse than local mode because it looks like verification.
    expect(() => identityFromConfig('iap', '')).toThrow(/FLEETADLC_IAP_AUDIENCE/);
  });

  it('will not start in local mode without the console secret', () => {
    expect(() => identityFromConfig('local', '', '')).toThrow(/fleetadlc up/);
  });

  it('starts in local mode with one, and needs no audience', () => {
    expect(identityFromConfig('local', '', 'a'.repeat(64))).toBeInstanceOf(Identity);
  });

  it('does not need the console secret in iap mode', () => {
    expect(identityFromConfig('iap', AUDIENCE, '')).toBeInstanceOf(Identity);
  });
});
