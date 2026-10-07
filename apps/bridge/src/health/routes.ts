import { acknowledgements, audit } from '@fleetadlc/db';
import { HttpFailure, type Router } from '../router.js';
import type { HealthRegistry } from './registry.js';

/** Where a person's dismissal is kept and said: the store and the audit trail, or a test's stand-ins. */
export interface AcknowledgeDeps {
  acknowledge(id: string, occurrence: string, by: string, covers: readonly string[]): Promise<void>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
}

const LIVE: AcknowledgeDeps = { acknowledge: (id, occurrence, by, covers) => acknowledgements.acknowledge(id, occurrence, by, new Date(), covers), audit };

/**
 * The checks, for the console and for `fleetadlc doctor`.
 *
 * `GET` is what the checks last said, which is what the board shows. `POST
 * /run` asks every check now and answers with that — what `fleetadlc doctor` wants,
 * since a person at a terminal is asking about this moment, not about five
 * minutes ago.
 */
export function registerHealthRoutes(router: Router, registry: HealthRegistry, deps: AcknowledgeDeps = LIVE): void {
  router.get('/v1/health', async () => ({ checks: await registry.views() }));

  router.post('/v1/health/run', async () => ({ checks: await registry.views(await registry.run({ force: true })) }));

  /**
   * Asks one check now: "Check again" on its card, pressed by a person who has
   * just fixed what it said. It answers with what every check says afterwards,
   * so the page can redraw from it.
   */
  router.post('/v1/health/checks/:checkId/run', async ({ params }) => {
    const checkId = params.checkId ?? '';
    if (!registry.knows(checkId)) throw new HttpFailure(404, `no check is called ${checkId}`);
    return { checks: await registry.views(await registry.run({ ids: [checkId] })) };
  });

  /** Stops the board saying a check was fixed. */
  router.post('/v1/health/:id/dismiss', async ({ params }) => ({ dismissed: await registry.dismiss(params.id ?? '') }));

  /**
   * "Dismiss" on a card that has nothing to fix: the person has seen
   * this occurrence, and the card stays away until another arrives. The
   * occurrence is the one the card showed, not whatever the row says by the
   * time the press arrives, so a newer one is never hidden unseen. When the
   * row still leads with it, what else the card was showing (`occurrences`,
   * every post on it) is covered too, and adds to what was dismissed before.
   */
  router.post('/v1/health/:id/acknowledge', async ({ params, body, identity }) => {
    const id = params.id ?? '';
    const input = await body<{ occurrence?: unknown }>().catch(() => ({}) as { occurrence?: unknown });
    const occurrence = typeof input.occurrence === 'string' ? input.occurrence.trim() : '';
    if (!occurrence) throw new HttpFailure(400, 'say which occurrence was seen: { "occurrence": "…" }');
    const row = (await registry.rows()).find((one) => one.id === id);
    if (!row) throw new HttpFailure(404, `no health check row is called ${id}`);
    if (typeof row.facts.occurrence !== 'string' && row.facts.history !== true) {
      throw new HttpFailure(409, 'that card has something to fix, so it clears when the fix is made rather than being dismissed');
    }
    const shown =
      row.facts.occurrence === occurrence && Array.isArray(row.facts.occurrences)
        ? row.facts.occurrences.filter((one): one is string => typeof one === 'string')
        : [];
    const covers = [...new Set([occurrence, ...shown])];
    await deps.acknowledge(id, occurrence, identity, covers);
    await deps.audit({ actor: identity, action: 'notice.acknowledged', target: id, payload: { occurrence, covers, title: row.title } });
    return { acknowledged: id, occurrence };
  });
}
