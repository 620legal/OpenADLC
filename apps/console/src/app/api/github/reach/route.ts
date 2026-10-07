import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Whether the app reaches one repository yet: asked by the field waiting on somebody installing it. */
export async function GET(request: Request) {
  const repo = new URL(request.url).searchParams.get('repo') ?? '';
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/reach?repo=${encodeURIComponent(repo)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
