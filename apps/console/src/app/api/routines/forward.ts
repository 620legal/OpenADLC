import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * Passes a Routines change to the bridge as sent, with the caller's identity,
 * so the bridge's own checks stand: Approves on in People, and what a routine
 * may say (#369, docs/adr/0090). The bridge's answer comes back whole, a
 * refusal's words included.
 */
export async function forwardRoutine(request: Request, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string): Promise<Response> {
  const hasBody = method === 'POST' || method === 'PATCH';
  const response = await fetchBridge(`${BRIDGE_URL}/v1/routines${path}`, {
    method,
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), ...(hasBody ? { 'content-type': 'application/json' } : {}) },
    ...(hasBody ? { body: (await request.text()) || '{}' } : {}),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A routine's id as the bridge takes it in a path. */
export function routinePath(id: string): string {
  return `/${encodeURIComponent(decodeURIComponent(id))}`;
}
