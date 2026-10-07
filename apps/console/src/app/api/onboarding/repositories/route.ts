import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** The repositories the app was installed on, for the picker. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/onboarding/repositories`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
