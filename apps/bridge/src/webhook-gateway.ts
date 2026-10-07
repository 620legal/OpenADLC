import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The one route a tunnel is allowed to expose.
 *
 * OpenADLC can start a public tunnel for you, and the obvious way to do it — point
 * the tunnel at the bridge — is wrong. In `local` mode the bridge takes
 * `x-fleetadlc-identity` at face value, which `identity.ts` itself describes as
 * honest only for "an install reachable only from the machine it runs on". A
 * tunnel makes it reachable from everywhere, and then one header is the
 * difference between a stranger and the operator: answering a gate, moving a
 * card, satisfying `review:human`.
 *
 * So the tunnel points here instead, and this forwards exactly one method and
 * one path, with a fixed set of headers. The identity headers are not on that
 * list, so nothing arriving from the internet can claim to be anybody — the
 * delivery is authenticated the way GitHub's deliveries are authenticated, by
 * its HMAC, and by nothing else.
 *
 * It is an allowlist rather than a denylist on purpose: a route added to the
 * bridge tomorrow is not exposed by having been forgotten here.
 */

const WEBHOOK_PATH = '/webhooks/github';

/**
 * Headers worth forwarding: what the handler reads, plus what is useful in a
 * log. `x-fleetadlc-identity` and the IAP headers are deliberately absent, and so is
 * anything bearing a credential — `authorization`, `cookie`.
 */
const FORWARDED = new Set([
  'content-type',
  'user-agent',
  'x-github-event',
  'x-github-delivery',
  'x-github-hook-id',
  'x-github-hook-installation-target-id',
  'x-github-hook-installation-target-type',
  'x-hub-signature',
  'x-hub-signature-256',
]);

/**
 * GitHub's own documented ceiling for a delivery. Past it, refuse rather than
 * truncate. The bridge's webhook route reads no further than this either.
 */
export const WEBHOOK_BODY_MAX = 25 * 1024 * 1024;

export interface WebhookGateway {
  /** The port to point a tunnel at — never the bridge's own. */
  port: number;
  close: () => Promise<void>;
}

function readBody(stream: NodeJS.ReadableStream): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > WEBHOOK_BODY_MAX) {
        resolve('too-large');
        stream.removeAllListeners('data');
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Starts the gateway on an ephemeral port unless one is named.
 *
 * Bound to loopback: the tunnel reaches it from this machine, so there is no
 * reason for the port itself to be listening on anything else.
 */
export async function startWebhookGateway(options: {
  bridgePort: number;
  port?: number;
  host?: string;
}): Promise<WebhookGateway> {
  const target = { host: options.host ?? '127.0.0.1', port: options.bridgePort };

  const server: Server = createServer((incoming, response) => {
    void (async () => {
      const path = (incoming.url ?? '').split('?')[0];

      if (incoming.method !== 'POST' || path !== WEBHOOK_PATH) {
        // Deliberately uninformative. Whatever found this URL does not need a
        // map of what else is behind it.
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
        incoming.resume();
        return;
      }

      // A delivery that says it is larger than GitHub sends is refused before
      // a byte of it is held; one that does not say is cut off as it arrives.
      const declared = Number(incoming.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX) {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'delivery larger than GitHub sends' }));
        incoming.resume();
        return;
      }

      const body = await readBody(incoming).catch(() => null);
      if (body === null) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'could not read the delivery' }));
        return;
      }
      if (body === 'too-large') {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'delivery larger than GitHub sends' }));
        return;
      }

      const headers: Record<string, string> = { 'content-length': String(body.length) };
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (FORWARDED.has(name.toLowerCase()) && typeof value === 'string') headers[name] = value;
      }

      const forwarded = httpRequest(
        { ...target, method: 'POST', path: WEBHOOK_PATH, headers },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, {
            'content-type': answer.headers['content-type'] ?? 'application/json',
          });
          answer.pipe(response);
        },
      );

      forwarded.on('error', () => {
        // The bridge did not answer (it is closing, or not listening on this
        // port). GitHub does not retry a failed delivery by itself; the
        // bridge, back, has it redelivered (`Scheduler.redeliverFailed`),
        // which takes a 5xx and not a 4xx.
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'the bridge did not answer' }));
      });

      forwarded.end(body);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
