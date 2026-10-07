import { describeDatabase, waitForDatabase } from '@fleetadlc/db';

/** Errors that mean nothing is there to answer, as Node and pg give them. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET']);

/**
 * What to say about a database error that means the database cannot be used
 * at all, or null for any other.
 *
 * With the stack stopped, `fleetadlc auth status` printed `connect
 * ECONNREFUSED 127.0.0.1:47432` and `fleetadlc backup` printed "unexpected
 * Error, reported without its message", neither of which says to start it.
 */
export function databaseUnreachable(error: unknown, url: string = process.env.DATABASE_URL ?? ''): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const where = describeDatabase(url);
  const at = where ? ` (${where})` : '';
  if (typeof code === 'string' && UNREACHABLE.has(code)) return `cannot reach the database${at}: start the stack with fleetadlc up`;
  // invalid_password and invalid_authorization_specification.
  if (code === '28P01' || code === '28000') return `the database${at} refused this install’s user or password: check databaseUrl in install.json`;
  return null;
}

/**
 * Waits for the database as a command run at a terminal should: a few
 * seconds, not the thirty a service starting beside it needs, and then says
 * what to do.
 */
export async function reachDatabase(attempts = 5, delayMs = 500): Promise<void> {
  try {
    await waitForDatabase(attempts, delayMs);
  } catch (error) {
    const said = databaseUnreachable(error);
    throw said ? new Error(said) : error;
  }
}
