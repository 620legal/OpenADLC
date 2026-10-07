import { createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpFailure } from './router.js';

/** Google's published keys for the assertion Identity-Aware Proxy signs. */
const IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const IAP_ISSUER = 'https://cloud.google.com/iap';

/** IAP signs with ES256. Accepting anything else is how a verifier gets talked out of verifying. */
const ALGORITHM = 'ES256';

/** Clocks disagree; an assertion is not forged for being a few seconds early. */
const SKEW_SECONDS = 60;

export const IAP_ASSERTION_HEADER = 'x-goog-iap-jwt-assertion';
export const IAP_EMAIL_HEADER = 'x-goog-authenticated-user-email';
/**
 * The same assertion, as the console carries it to the bridge. Google's front
 * end in front of a run.app address strips `x-goog-*` from what a caller sends,
 * so on the first cloud install the console forwarded the assertion and the
 * bridge never saw it. The name confers nothing: what is accepted is still only
 * a signature that verifies for this install's audience.
 */
export const FORWARDED_ASSERTION_HEADER = 'x-fleetadlc-iap-assertion';
export const LOCAL_IDENTITY_HEADER = 'x-fleetadlc-identity';
/** What the console's server and the CLI present on a local install; see `consoleSecretRef`. */
export const CONSOLE_SECRET_HEADER = 'x-fleetadlc-console-secret';

export type IdentityMode = 'local' | 'iap';

interface Claims {
  iss?: string;
  aud?: string;
  email?: string;
  sub?: string;
  exp?: number;
  iat?: number;
}

function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

function parseJson<T>(segment: string, what: string): T {
  try {
    return JSON.parse(decodeSegment(segment).toString('utf8')) as T;
  } catch {
    throw new HttpFailure(401, `the IAP assertion's ${what} is not JSON`);
  }
}

/**
 * Which path is in force, in one sentence: the bridge logs it at start and
 * `fleetadlc status` prints it (`/v1/status`), so nobody has to guess. One
 * function, so the two cannot say different things.
 */
export function describeIdentity(mode: IdentityMode, audience: string): string {
  if (mode === 'local') {
    return 'local header, believed only from the console and the fleetadlc CLI, which hold the console secret';
  }
  return `verified IAP assertion for audience ${audience}`;
}

export interface Jwks {
  keys: (JsonWebKey & { kid?: string; alg?: string })[];
}

/**
 * Resolves the person behind a request.
 *
 * In `iap` mode the only thing trusted is the signature: the identity comes from
 * the verified claim, and a request whose assertion does not verify is refused
 * rather than falling back to the headers beside it. `x-goog-authenticated-user-email`
 * and `x-fleetadlc-identity` are just headers — anything that reaches the bridge can
 * set them, and the identity decides who may answer a gate, move a card and
 * satisfy `review:human`.
 *
 * In `local` mode the person is named by `x-fleetadlc-identity`, and that is
 * believed only from a caller holding the install's console secret: the
 * console's server and the `fleetadlc` CLI. The bridge listens on every
 * interface, because a task's container reaches `/internal/tasks/*` through the
 * Docker gateway, so "only this machine can reach it" was never true. Without
 * the secret, a host on the LAN or code in a task's container named itself and
 * was an admin: it downloaded a backup of every credential and minted a
 * terminal into the lead reviewer's session. `x-goog-authenticated-user-email`
 * is not read here at all; only IAP can vouch for it.
 */
export class Identity {
  private cached: { jwks: Jwks; at: number } | null = null;
  /** `kid`s a fresh read did not contain, so one cannot be used to make us fetch. */
  private readonly unknownKids = new Map<string, number>();
  /** In-flight read, so a burst of requests causes one fetch rather than one each. */
  private inFlight: Promise<Jwks> | null = null;
  /** When an unknown kid last made us read the key set again, whichever kid it was. */
  private lastForcedRead = 0;

  constructor(
    private readonly mode: IdentityMode,
    private readonly audience: string,
    /** What the console and the CLI present in `local` mode. Empty refuses every `/v1` request there. */
    private readonly consoleSecret: string = '',
    /** Injected so the verification can be tested without reaching Google. */
    private readonly fetchJwks: () => Promise<Jwks> = defaultFetchJwks,
    private readonly cacheMs = 3_600_000,
    private readonly unknownKidMs = 60_000,
  ) {}

  /** What the bridge logs at start; see `describeIdentity`. */
  describe(): string {
    return describeIdentity(this.mode, this.audience);
  }

  async resolve(request: IncomingMessage): Promise<string> {
    if (this.mode === 'local') return this.localIdentity(request);

    const assertion = this.header(request, IAP_ASSERTION_HEADER) || this.header(request, FORWARDED_ASSERTION_HEADER);
    if (!assertion) {
      throw new HttpFailure(
        401,
        `this install verifies identity through IAP, and the request carried no IAP assertion (${IAP_ASSERTION_HEADER} or ${FORWARDED_ASSERTION_HEADER}); open OpenADLC at its IAP-protected address`,
      );
    }
    return this.verifyAssertion(assertion);
  }

  private localIdentity(request: IncomingMessage): string {
    if (!this.holdsConsoleSecret(request)) {
      // Says what to use, and nothing about what was sent.
      throw new HttpFailure(
        401,
        'this bridge serves /v1 only to its console and the fleetadlc CLI. In a browser, sign in to the console with the link `fleetadlc console-link` prints',
      );
    }
    const local = this.header(request, LOCAL_IDENTITY_HEADER);
    if (local) return local;
    return 'local operator';
  }

  /**
   * Compared as SHA-256 digests, which are always the same length, so neither
   * a wrong value nor a wrong length takes longer to refuse than the other.
   */
  private holdsConsoleSecret(request: IncomingMessage): boolean {
    if (this.consoleSecret.length === 0) return false;
    const presented = this.header(request, CONSOLE_SECRET_HEADER);
    const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
    return timingSafeEqual(digest(presented), digest(this.consoleSecret));
  }

  private header(request: IncomingMessage, name: string): string {
    const value = request.headers[name];
    const first = typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
    return first.trim();
  }

  private async jwks(refresh = false): Promise<Jwks> {
    const fresh = this.cached && Date.now() - this.cached.at < this.cacheMs;
    if (this.cached && fresh && !refresh) return this.cached.jwks;
    // Coalesce: a burst of requests arriving on a cold cache should cost one
    // read of Google's keys, not one per request.
    this.inFlight ??= this.fetchJwks()
      .then((jwks) => {
        this.cached = { jwks, at: Date.now() };
        return jwks;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async keyFor(kid: string): Promise<JsonWebKey & { alg?: string }> {
    const refused = this.unknownKids.get(kid);
    if (refused !== undefined && Date.now() - refused < this.unknownKidMs) {
      // Already asked Google about this one recently. Without this, an unknown
      // kid is a free outbound fetch per request for anything that can reach
      // the bridge, and a failing fetch refuses the console too.
      throw new HttpFailure(401, `the IAP assertion was signed by an unknown key (${kid})`);
    }

    const find = (jwks: Jwks) => (Array.isArray(jwks.keys) ? jwks.keys.find((c) => c.kid === kid) : undefined);
    let key = find(await this.jwks());
    // IAP rotates its keys, so a kid that is new to us is a stale cache before
    // it is a forgery — worth one fresh read, but one a minute, whatever the
    // kid. Counted per kid, a new invented kid on every request was a fetch of
    // Google's keys on every request; a real rotation still gets through
    // within the minute.
    if (!key && Date.now() - this.lastForcedRead >= this.unknownKidMs) {
      this.lastForcedRead = Date.now();
      key = find(await this.jwks(true));
    }
    if (!key) {
      this.unknownKids.set(kid, Date.now());
      // Bounded, so a stream of invented kids cannot grow this without limit.
      if (this.unknownKids.size > 256) this.unknownKids.clear();
      throw new HttpFailure(401, `the IAP assertion was signed by an unknown key (${kid})`);
    }

    // Pin the key type as well as the algorithm. `verify('sha256', …)` with an
    // RSA key would check an RSA signature while `alg` still read ES256, so the
    // algorithm pin alone leaves a gadget if the key set ever served something
    // else.
    const shape = key as { kty?: string; crv?: string };
    if (shape.kty !== 'EC' || shape.crv !== 'P-256') {
      throw new HttpFailure(401, `the IAP signing key ${kid} is not the EC P-256 key ES256 requires`);
    }
    return key;
  }

  private async verifyAssertion(assertion: string): Promise<string> {
    const parts = assertion.split('.');
    if (parts.length !== 3) throw new HttpFailure(401, 'the IAP assertion is not a three-part JWT');
    const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

    const header = parseJson<{ alg?: string; kid?: string }>(headerSegment, 'header');
    // Pinned, not read: an attacker who picks the algorithm picks whether the
    // signature means anything.
    if (header.alg !== ALGORITHM) {
      throw new HttpFailure(401, `the IAP assertion must be signed with ${ALGORITHM}, not ${header.alg ?? 'nothing'}`);
    }
    if (!header.kid) throw new HttpFailure(401, 'the IAP assertion names no signing key');

    const jwk = await this.keyFor(header.kid);
    let key;
    try {
      key = createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      throw new HttpFailure(401, 'the IAP signing key could not be read');
    }

    const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, 'utf8');
    // A JWT's ES256 signature is the raw r||s pair, not the DER encoding
    // node:crypto defaults to.
    const ok = verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, decodeSegment(signatureSegment));
    if (!ok) throw new HttpFailure(401, 'the IAP assertion did not verify');

    const claims = parseJson<Claims>(payloadSegment, 'payload');
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== IAP_ISSUER) {
      throw new HttpFailure(401, `the IAP assertion was issued by ${claims.iss ?? 'nobody'}, not ${IAP_ISSUER}`);
    }
    // Without the audience check a valid assertion for somebody else's service
    // would be accepted here.
    if (claims.aud !== this.audience) {
      throw new HttpFailure(401, 'the IAP assertion was issued for a different service');
    }
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) {
      throw new HttpFailure(401, 'the IAP assertion has expired');
    }
    if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > now) {
      throw new HttpFailure(401, 'the IAP assertion is not valid yet');
    }

    const email = (claims.email ?? '').trim();
    if (!email) throw new HttpFailure(401, 'the IAP assertion carries no email to act as');
    return email.replace(/^accounts\.google\.com:/, '');
  }
}

async function defaultFetchJwks(): Promise<Jwks> {
  const response = await fetch(IAP_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new HttpFailure(503, `could not read IAP's signing keys (${response.status})`);
  return (await response.json()) as Jwks;
}

/**
 * `iap` mode without an audience would verify a signature and then accept an
 * assertion minted for any other service, so the install refuses to start rather
 * than run a check that passes everything. `local` mode without the console
 * secret would refuse its own console, so it refuses to start too.
 */
export function identityFromConfig(mode: IdentityMode, audience: string, consoleSecret = ''): Identity {
  if (mode === 'iap' && audience.length === 0) {
    throw new Error(
      'FLEETADLC_IDENTITY_MODE=iap needs FLEETADLC_IAP_AUDIENCE, the backend service the assertion is issued for',
    );
  }
  if (mode === 'local' && consoleSecret.length === 0) {
    throw new Error(
      'a local install needs its console secret, which `fleetadlc up` makes. Start the install with `fleetadlc up`',
    );
  }
  return new Identity(mode, audience, consoleSecret);
}
