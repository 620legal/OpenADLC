import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * The largest restore body the console carries: the bridge's own limit,
 * `RESTORE_BODY_MAX` in apps/bridge/src/backup.ts. The console does not import
 * the bridge, so the number is repeated here, and `next.config.ts` lets
 * middleware pass a body this large.
 */
export const RESTORE_BODY_MAX = 96 * 1024 * 1024;

/**
 * A restore body that cannot be carried whole, refused before it is read; null
 * when it can. With middleware in front, Next keeps only the first part of a
 * body for the route, and a backup cut short reached the bridge as JSON that
 * did not parse ("Unterminated string … at position 10485760").
 */
export function refuseRestoreBody(request: Request): Response | null {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared)) {
    return Response.json(
      { error: 'the restore did not say how large the backup is; choose the file again, or run: fleetadlc restore PATH' },
      { status: 411 },
    );
  }
  if (declared > RESTORE_BODY_MAX) {
    return Response.json(
      { error: `that backup is larger than the ${RESTORE_BODY_MAX / (1024 * 1024)} MB the console can carry; run: fleetadlc restore PATH` },
      { status: 413 },
    );
  }
  return null;
}

/** A restore request passed on to the bridge's `path`, once its size is one the console can carry. */
export async function forwardRestore(request: Request, path: string): Promise<Response> {
  const refused = refuseRestoreBody(request);
  if (refused) return refused;
  const response = await fetchBridge(`${BRIDGE_URL}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    body: await request.text(),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
