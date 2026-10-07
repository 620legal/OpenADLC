import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The GitHub App's webhook (`/webhooks/github`) is the bridge's only
 * unauthenticated inbound surface.
 *
 * `payload` should be the body's bytes: GitHub signs those, not a decoding of them.
 */
export function verifyWebhookSignature(input: {
  payload: string | Buffer;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  if (!input.signatureHeader) return false;
  const expected = `sha256=${createHmac('sha256', input.secret).update(input.payload).digest('hex')}`;
  const provided = Buffer.from(input.signatureHeader);
  const computed = Buffer.from(expected);
  return provided.length === computed.length && timingSafeEqual(provided, computed);
}
