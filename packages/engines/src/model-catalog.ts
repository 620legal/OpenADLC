import { createHash } from 'node:crypto';
import type { AvailableModel } from './model-choice.js';

/**
 * How long a model list stays good.
 *
 * A new model is not an event that has to be caught in seconds, and listing
 * on every task start is a round trip per task. A few minutes is enough for
 * the next task to follow a model the provider has just added, without asking
 * again for every task that starts in between.
 */
export const MODEL_LIST_TTL_MS = 3 * 60 * 1000;

export interface ModelListCache {
  /**
   * The models last listed for this account, or a fresh list when the last
   * one is older than the TTL. A failed list is not remembered: the next task
   * asks again rather than repeating an error it did not cause.
   */
  modelsFor(accountId: string, load: () => Promise<AvailableModel[]>): Promise<AvailableModel[]>;
}

/**
 * The cache key for an account's list: its id and a short hash of the secret
 * that listed it.
 *
 * Keyed by the id alone, a key rotated to another organisation or tier kept
 * offering the old key's models, and resolving `newest:` from them, until the
 * TTL ran out. The bridge and hostd each hold a cache and nothing tells one
 * when the other's secret changed, so the secret itself is what moves the key.
 */
export function modelListKey(accountId: string, secret: string): string {
  return `${accountId}:${createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
}

interface CacheEntry {
  at: number;
  pending: Promise<AvailableModel[]>;
}

/**
 * One list per account, shared by every bot on it.
 *
 * The same shape as `commandInImage`: the first caller asks, and anyone who
 * arrives while that answer is still fresh is handed the same promise instead
 * of starting another round trip. The clock is injected so a test can move a
 * provider's catalogue forward without waiting out the TTL.
 */
export function modelListCache(options?: { ttlMs?: number; now?: () => number }): ModelListCache {
  const ttlMs = options?.ttlMs ?? MODEL_LIST_TTL_MS;
  const now = options?.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();

  return {
    modelsFor(accountId, load) {
      const hit = entries.get(accountId);
      if (hit && now() - hit.at < ttlMs) return hit.pending;

      // Set before the first await. Two tasks that start together then share
      // one request; a rejection is dropped so the next start is a new ask.
      const pending = load().catch((error: unknown) => {
        const current = entries.get(accountId);
        if (current?.pending === pending) entries.delete(accountId);
        throw error;
      });
      entries.set(accountId, { at: now(), pending });
      return pending;
    },
  };
}
