import { createServer } from 'node:http';
import { deliveryRulesSchema, type DeliveryRules } from '@fleetadlc/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DeliverySource } from './delivery-rules.js';
import { registerDeployRoutes, type DeployRouteDeps } from './deploy-routes.js';
import { Router } from './router.js';

const REPO = { id: 'repo-1', name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' };
const SHA = 'abc1234def';
const REVIEWERS = deliveryRulesSchema.parse({ version: 1, production: { approval: 'reviewers', soakMinutes: 0 } });

function world(options: { source?: DeliverySource; rules?: DeliveryRules; release?: { released: boolean; held: boolean; line: string } } = {}) {
  const rows: { repoId: string; rules: DeliveryRules }[] = [];
  const choices: { repoId: string; choice: unknown }[] = [];
  const soaked: { sha: string; after: Date }[] = [];
  const forgotten: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const releaseHeld = vi.fn(async () => options.release ?? { released: true, held: false, line: 'app@abc1234: dispatched promote-production' });
  const deps: DeployRouteDeps = {
    repo: async (name) => (name === REPO.name ? REPO : null),
    pipeline: { releaseHeld },
    delivery: {
      get: async () => ({ rules: options.rules ?? REVIEWERS, source: options.source ?? 'repository', testingUrl: null, fileError: null }),
      forget: (fullName) => void forgotten.push(fullName),
    },
    setRules: async (repoId, rules) => void rows.push({ repoId, rules }),
    recordChoice: async (repoId, choice) => void choices.push({ repoId, choice }),
    held: async () => [{ sha: SHA }],
    soak: async (_repo, sha, after) => void soaked.push({ sha, after }),
    audit: async (entry) => void audits.push(entry),
    now: () => Date.parse('2026-10-04T12:00:00Z'),
  };
  const router = new Router();
  registerDeployRoutes(router, deps);
  return { router, rows, choices, soaked, forgotten, audits, releaseHeld };
}

async function post(router: Router, path: string) {
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'x-fleetadlc-identity': 'janedoe' } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('releasing a promote held for a person', () => {
  it('dispatches it through the pipeline, as the person who released it', async () => {
    const { router, releaseHeld } = world();
    const answer = await post(router, `/v1/repos/app/deploys/${SHA}/release`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ released: true });
    expect(releaseHeld).toHaveBeenCalledWith(REPO, SHA, expect.any(String));
  });

  it('answers 404 for a repository OpenADLC does not work in', async () => {
    expect((await post(world().router, `/v1/repos/elsewhere/deploys/${SHA}/release`)).status).toBe(404);
  });

  it('answers 409 for a commit that is not held', async () => {
    const { router } = world({ release: { released: false, held: false, line: 'not held' } });
    const answer = await post(router, `/v1/repos/app/deploys/${SHA}/release`);
    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain('is not held for a person');
  });

  it('says it is still held when the dispatch failed', async () => {
    const { router } = world({ release: { released: false, held: true, line: 'app@abc1234: promote-production not dispatched (502)' } });
    const answer = await post(router, `/v1/repos/app/deploys/${SHA}/release`);
    expect(answer.status).toBe(502);
    expect(String(answer.body.error)).toContain('It is still held');
  });
});

describe('switching a repository to automatic delivery', () => {
  it('stores `approval: auto` with a soak of at least 30 minutes, forgets the cached rules, and turns held promotes into soaks', async () => {
    const { router, rows, choices, soaked, forgotten, audits } = world();
    const answer = await post(router, '/v1/repos/app/delivery/automatic');

    expect(answer.status).toBe(200);
    expect(choices).toEqual([{ repoId: 'repo-1', choice: { approval: 'auto', soakMinutes: 30, reviewers: [] } }]);
    expect(rows).toEqual([{ repoId: 'repo-1', rules: expect.objectContaining({ production: expect.objectContaining({ approval: 'auto', soakMinutes: 30 }) }) }]);
    expect(forgotten).toEqual(['exampleco/app']);
    expect(soaked).toEqual([{ sha: SHA, after: new Date('2026-10-04T12:30:00Z') }]);
    expect(audits).toEqual([expect.objectContaining({ action: 'delivery.switched_automatic', target: 'app' })]);
  });

  it('records the choice and makes no row of rules where Settings’ fallback gave them', async () => {
    const { router, rows, choices } = world({ source: 'setting' });
    expect((await post(router, '/v1/repos/app/delivery/automatic')).status).toBe(200);
    expect(choices).toHaveLength(1);
    expect(rows).toEqual([]);
  });

  it('keeps a longer soak the rules already had', async () => {
    const { router, rows } = world({ rules: deliveryRulesSchema.parse({ version: 1, production: { approval: 'reviewers', soakMinutes: 90 } }) });
    await post(router, '/v1/repos/app/delivery/automatic');
    expect(rows[0]?.rules.production.soakMinutes).toBe(90);
  });

  it('answers 409 where .github/fleetadlc.yml sets the rules, and names the file to edit', async () => {
    const { router, rows, soaked } = world({ source: 'file' });
    const answer = await post(router, '/v1/repos/app/delivery/automatic');

    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain('https://github.com/exampleco/app/edit/main/.github/fleetadlc.yml');
    expect(rows).toEqual([]);
    expect(soaked).toEqual([]);
  });
});
