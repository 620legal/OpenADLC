import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const INTERNAL_SECRET_HEADER = 'x-fleetadlc-internal-secret';
export const ON_BEHALF_OF_HEADER = 'x-fleetadlc-on-behalf-of';

/**
 * What a shared secret can prove. The plan asks for mTLS with the bridge's own
 * service identity; a secret read from the install's secret store is the local
 * equivalent, and it proves less: that the caller is a component of this
 * install, not *which* component. The bridge and `fleetadlc attach` both hold it,
 * so hostd cannot tell them apart and does not pretend to.
 */
export const PRINCIPAL = 'platform';

export interface Caller {
  /** What hostd authenticated, not what the request called itself. */
  principal: string;
  /** The person that component says it is acting for, if it named one. */
  onBehalfOf: string | null;
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[0] ?? '') : '';
}

/** Constant-time, and false for an empty expectation so a missing secret never admits anyone. */
export function secretMatches(presented: string, expected: string): boolean {
  if (expected.length === 0 || presented.length === 0) return false;
  const offered = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself an answer.
  if (offered.length !== wanted.length) return false;
  return timingSafeEqual(offered, wanted);
}

/**
 * The caller behind a request, or null if it did not prove it is one of ours.
 *
 * Everything hostd exposes starts a task, kills a session, restarts a container
 * or mints a terminal attach token, so reaching the port is not enough to be
 * served.
 */
export function authenticate(request: IncomingMessage, expected: string): Caller | null {
  if (!secretMatches(header(request, INTERNAL_SECRET_HEADER), expected)) return null;

  const asserted = header(request, ON_BEHALF_OF_HEADER).trim();
  return { principal: PRINCIPAL, onBehalfOf: asserted === '' ? null : asserted };
}

/**
 * Who the audit log names. The person is an assertion by the caller — hostd
 * cannot check it, and says so by naming the principal it *did* authenticate
 * alongside it. Verifying the assertion is the caller's job upstream; what matters
 * here is that an unauthenticated request can no longer name anyone at all,
 * where it used to supply `identity` in the body and have it written down.
 */
export function auditActor(caller: Caller): string {
  return caller.onBehalfOf ? `${caller.onBehalfOf} via ${caller.principal}` : caller.principal;
}
