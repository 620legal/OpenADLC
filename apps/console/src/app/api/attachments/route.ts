import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { FILE_LIMIT_BYTES } from '@/lib/attachments';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * One file, streamed on to the bridge as it arrives.
 *
 * A route handler and not a server action: Next stops a server action's body
 * at one megabyte, and a screenshot is several. The origin of this write is
 * checked by `middleware.ts`, as every `/api/*` write's is.
 *
 * A body declared larger than a file may be is refused here, before it is
 * read: with middleware in front, Next keeps only the first part of a body
 * for it (`middlewareClientMaxBodySize` in next.config.ts), and a file past
 * that would reach the bridge cut short, as a file that looks whole.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared)) {
    return Response.json({ error: 'the upload did not say how large it is; attach the file again' }, { status: 411 });
  }
  if (declared > FILE_LIMIT_BYTES) {
    return Response.json({ error: `that file is larger than ${FILE_LIMIT_BYTES / (1024 * 1024)} MB, the most a file can be` }, { status: 413 });
  }
  const upstream = await fetchBridge(`${BRIDGE_URL}/v1/attachments`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      ...identityHeadersFrom(request),
      'content-type': request.headers.get('content-type') ?? 'application/octet-stream',
      'content-length': String(declared),
      'x-file-name': request.headers.get('x-file-name') ?? '',
    },
    body: request.body,
    // @ts-expect-error -- `duplex` is required by undici to stream a request body, and not in the DOM types.
    duplex: 'half',
  });
  return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
}
