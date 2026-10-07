import { randomBytes } from 'node:crypto';
import type { AttachGrant } from './terminal-gateway.js';

/**
 * A terminal attach is authorised by a token that is good for one bot, one
 * session, sixty seconds, and one use. The console asks the bridge, the bridge
 * asks hostd, and the gateway redeems it — so the browser never holds anything
 * that would let it attach to a second session.
 */
export class AttachTokens {
  private readonly grants = new Map<string, AttachGrant>();

  constructor(private readonly lifetimeMs = 60_000) {}

  mint(input: { bot: string; session: string; identity: string }): { token: string; expiresInSeconds: number } {
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    this.grants.set(token, {
      bot: input.bot,
      session: input.session,
      identity: input.identity,
      expiresAt: Date.now() + this.lifetimeMs,
    });
    return { token, expiresInSeconds: Math.round(this.lifetimeMs / 1000) };
  }

  redeem(token: string): AttachGrant | null {
    this.sweep();
    const grant = this.grants.get(token);
    if (!grant) return null;
    this.grants.delete(token);
    return grant.expiresAt < Date.now() ? null : grant;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(token);
    }
  }

  get outstanding(): number {
    this.sweep();
    return this.grants.size;
  }
}
