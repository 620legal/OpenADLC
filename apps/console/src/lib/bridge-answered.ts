/**
 * The bridge answered, and with an error: a running bridge, which is not the
 * same as one that does not answer. Every page said "cannot reach the bridge
 * … run fleetadlc up" for both, over a bridge that was up and had said why in
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
