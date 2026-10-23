import { createServer } from 'node:http';
import { DEFAULT_DELIVERY_RULES, deliveryRulesSchema, storedDeliveryRules, type DeliveryRules } from '@openadlc/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DeliverySource } from './delivery-rules.js';
import { onlyShipsByRelease, registerDeployRoutes, type DeployRouteDeps } from './deploy-routes.js';
import { Router } from './router.js';

const REPO = { id: 'repo-1', name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' };
const SHA = 'abc1234def';
const REVIEWERS = deliveryRulesSchema.parse({ version: 1, production: { approval: 'reviewers', soakMinutes: 0 } });

function world(
  options: {
    source?: DeliverySource;
    rules?: DeliveryRules;
    release?: { released: boolean; held: boolean; line: string };
    /** The repository's stored rules as they are kept, unparsed. */
    stored?: unknown;
  } = {},
) {
  const rows: { repoId: string; rules: DeliveryRules }[] = [];
  /** What the rules read as, changed by what the routes write: a row is the repository's, none is Settings' choice. */
  const now = { source: options.source ?? ('repository' as DeliverySource), rules: options.rules ?? REVIEWERS, stored: options.stored ?? null };
  const cleared: string[] = [];
  const rechecked: string[] = [];
  const choices: { repoId: string; choice: unknown }[] = [];
  const soaked: { sha: string; after: Date }[] = [];
  const forgotten: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const releaseHeld = vi.fn(async () => options.release ?? { released: true, held: false, line: 'app@abc1234: dispatched promote-production' });
  const deps: DeployRouteDeps = {
    repo: async (name) => (name === REPO.name ? REPO : null),
    pipeline: { releaseHeld },
    delivery: {
      get: async () => ({ rules: now.rules, source: now.source, testingUrl: null, fileError: null }),
      forget: (fullName) => void forgotten.push(fullName),
    },
    setRules: async (repoId, rules) => {
      rows.push({ repoId, rules: rules as DeliveryRules });
      Object.assign(now, { source: 'repository', rules: storedDeliveryRules(rules) ?? now.rules, stored: rules });
    },
    storedRules: async () => now.stored,
    clearRules: async (repoId) => {
      cleared.push(repoId);
      Object.assign(now, { source: 'setting', rules: DEFAULT_DELIVERY_RULES, stored: null });
    },
    recordChoice: async (repoId, choice) => void choices.push({ repoId, choice }),
    held: async () => [{ sha: SHA }],
    soak: async (_repo, sha, after) => void soaked.push({ sha, after }),
    audit: async (entry) => void audits.push(entry),
    recheck: () => void rechecked.push('ships-by-release'),
    now: () => Date.parse('2026-10-04T12:00:00Z'),
  };
  const router = new Router();
  registerDeployRoutes(router, deps);
  return { router, rows, choices, soaked, forgotten, audits, releaseHeld, cleared, rechecked };
}

async function post(router: Router, path: string, body?: unknown) {
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'x-openadlc-identity': 'janedoe', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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

  it('answers 409 where .github/openadlc.yml sets the rules, and names the file to edit', async () => {
    const { router, rows, soaked } = world({ source: 'file' });
    const answer = await post(router, '/v1/repos/app/delivery/automatic');

    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain('https://github.com/exampleco/app/edit/main/.github/openadlc.yml');
    expect(rows).toEqual([]);
    expect(soaked).toEqual([]);
  });
});

/**
 * Settings → Repositories: whether a repository ships by release. Its merged
 * cards then wait in Ship for a published release that contains their merge,
 * rather than going to Done when a skipped deploy-testing deploys nothing.
 */
describe('setting a repository to ship by release', () => {
  const SETTING = DEFAULT_DELIVERY_RULES;

  it('gives a repository with no stored rules a row that says only that, and takes it away again when turned off', async () => {
    const { router, rows, cleared, forgotten, audits, rechecked } = world({ source: 'setting', rules: SETTING });

    const on = await post(router, '/v1/repos/app/delivery/ships-by-release', { on: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ shipsByRelease: true, testing: 'release', source: 'repository' });
    expect(rows).toEqual([{ repoId: 'repo-1', rules: { version: 1, testing: { on: 'release' } } }]);
    expect(forgotten).toEqual(['exampleco/app']);
    // Settings says at once whether the app hears a release published.
    expect(rechecked).toEqual(['ships-by-release']);
    expect(audits).toEqual([expect.objectContaining({ actor: 'janedoe', action: 'delivery.ships_by_release', target: 'app', payload: { on: true, was: 'merge', testing: 'release' } })]);

    // Off, Settings' testing-deploy choice is what the repository had.
    const off = await post(router, '/v1/repos/app/delivery/ships-by-release', { on: false });
    expect(off.body).toMatchObject({ shipsByRelease: false, testing: 'merge', source: 'setting' });
    expect(cleared).toEqual(['repo-1']);
    expect(rows).toHaveLength(1);
  });

  it('keeps everything else stored rules say, and puts back a testing deploy on merge when turned off', async () => {
    const stored = deliveryRulesSchema.parse({ version: 1, testing: { url: 'https://testing.example.com' }, production: { approval: 'reviewers', soakMinutes: 0 } });
    const { router, rows, cleared } = world({ source: 'repository', rules: stored, stored });

    await post(router, '/v1/repos/app/delivery/ships-by-release', { on: true });
    expect(rows[0]?.rules).toEqual({ ...stored, testing: { ...stored.testing, on: 'release' } });

    const off = await post(router, '/v1/repos/app/delivery/ships-by-release', { on: false });
    expect(off.body).toMatchObject({ shipsByRelease: false, testing: 'merge' });
    expect(rows[1]?.rules).toEqual({ ...stored, testing: { ...stored.testing, on: 'merge' } });
    expect(cleared).toEqual([]);
  });

  it('writes nothing when it already is as asked', async () => {
    const { router, rows, cleared } = world({ source: 'repository', rules: deliveryRulesSchema.parse({ version: 1, testing: { on: 'release' } }) });
    expect((await post(router, '/v1/repos/app/delivery/ships-by-release', { on: true })).body).toMatchObject({ shipsByRelease: true });
    expect(rows).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('answers 409 where .github/openadlc.yml sets the rules, naming what to set there', async () => {
    const { router, rows } = world({ source: 'file', rules: SETTING });
    const answer = await post(router, '/v1/repos/app/delivery/ships-by-release', { on: true });
    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain('`testing.on: release`');
    expect(String(answer.body.error)).toContain('https://github.com/exampleco/app/edit/main/.github/openadlc.yml');
    expect(rows).toEqual([]);
  });

  it('answers 400 for a body that does not say on or off', async () => {
    const { router, rows } = world({ source: 'setting', rules: SETTING });
    expect((await post(router, '/v1/repos/app/delivery/ships-by-release', { on: 'yes' })).status).toBe(400);
    expect((await post(router, '/v1/repos/app/delivery/ships-by-release')).status).toBe(400);
    expect(rows).toEqual([]);
  });

  it('tells a row that says only release from one a person wrote more into', () => {
    expect(onlyShipsByRelease({ version: 1, testing: { on: 'release' } })).toBe(true);
    // What the migration for 620legal/OpenADLC writes where it had none.
    expect(onlyShipsByRelease(JSON.parse('{"version": 1, "testing": {"on": "release"}}'))).toBe(true);
    expect(onlyShipsByRelease({ version: 1, testing: { on: 'release', url: 'https://testing.example.com' } })).toBe(false);
    expect(onlyShipsByRelease({ version: 1, testing: { on: 'release' }, production: { approval: 'reviewers' } })).toBe(false);
    expect(onlyShipsByRelease({ version: 1, testing: { on: 'merge' } })).toBe(false);
    expect(onlyShipsByRelease(null)).toBe(false);
  });
});
