import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

const json = async (response: Response) =>
  new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } });

/** The GitHub account the person asking has linked, or null. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/me`, { cache: 'no-store', headers: identityHeadersFrom(request) });
  const body = (await response.json().catch(() => null)) as { github?: { login: string } | null } | null;
  return Response.json({ github: body?.github ?? null }, { status: response.ok ? 200 : response.status });
}

/** Starts the sign-in that links the person's own GitHub account. */
export async function POST(request: Request) {
  return json(
    await fetchBridge(`${BRIDGE_URL}/v1/me/github`, {
      method: 'POST',
      cache: 'no-store',
      headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

/** Unlinks it. */
export async function DELETE(request: Request) {
  return json(await fetchBridge(`${BRIDGE_URL}/v1/me/github`, { method: 'DELETE', cache: 'no-store', headers: identityHeadersFrom(request) }));
}
