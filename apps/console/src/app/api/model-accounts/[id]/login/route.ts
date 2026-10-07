import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Where an OpenAI or xAI seat's sign-in stands. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/model-accounts/${encodeURIComponent(id)}/login`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Starts one. The answer is the link and the one-time code for the person
 * who asked, and this route does nothing with them but pass them on.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/model-accounts/${encodeURIComponent(id)}/login`, {
    method: 'POST',
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
