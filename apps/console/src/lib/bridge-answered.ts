/**
 * The bridge answered, and with an error: a running bridge, which is not the
 * same as one that does not answer. Every page said "cannot reach the bridge
 * … run openadlc up" for both, over a bridge that was up and had said why in
 * its `{ error }`, which was thrown away for `bridge /v1/board → 500`.
 */
export class BridgeAnswered extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly said: string,
  ) {
    super(`the bridge answered ${status} to ${path}${said ? `: ${said}` : ''}`);
    this.name = 'BridgeAnswered';
  }
}

/** A refusal as a `BridgeAnswered`, with the bridge's own words from its `{ error }`, or its text. */
export async function bridgeAnswered(path: string, response: Response): Promise<BridgeAnswered> {
  const text = await response.text().catch(() => '');
  let said = text.trim().slice(0, 300);
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) said = body.error.trim();
  } catch {
    // Not JSON: a proxy's page, said as it came.
  }
  return new BridgeAnswered(path, response.status, said);
}

/**
 * The bridge answered with an error because its database does not answer:
 * `said` is the bridge's line for it from `/healthz`, which names the
 * database, and the container and `docker start` when there is one. After
 * OrbStack restarted and left `openadlc-db` down, every page said only
 * `connect ECONNREFUSED 127.0.0.1:47432`.
 */
export class DatabaseDown extends BridgeAnswered {
  constructor(path: string, status: number, said: string) {
    super(path, status, said);
    this.name = 'DatabaseDown';
  }
}

/**
 * The bridge's `/healthz` line about its database, or null when it says
 * nothing is wrong with it, cannot be asked, or is older than the line.
 */
export async function databaseDownLine(bridgeUrl: string, timeoutMs = 3_000): Promise<string | null> {
  try {
    const response = await fetch(`${bridgeUrl}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 503) return null;
    const body = (await response.json()) as { database?: unknown };
    return typeof body.database === 'string' && body.database.trim() ? body.database.trim() : null;
  } catch {
    return null;
  }
}
