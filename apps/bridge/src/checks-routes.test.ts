import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { GitHubReads } from './ci-failure.js';
import { registerChecksRoutes, type ChecksRouteDeps } from './checks-routes.js';
import { Router } from './router.js';

const REPO = { id: 'r1', name: 'api', fullName: 'acme/api', defaultBranch: 'main' };

async function serve(deps: ChecksRouteDeps) {
  const router = new Router(undefined, undefined, undefined, async () => 'user');
  registerChecksRoutes(router, deps);
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path: string) => {
      const response = await fetch(`${base}${path}`, { headers: { 'x-openadlc-identity': 'jane@acme.test' } });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function recordingReads(): GitHubReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async <T,>(path: string): Promise<T> => {
      asked.push(`GET ${path}`);
      if (path.includes('/actions/workflows?')) return { workflows: [] } as T;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
    jobLog: async (repo, id) => {
      asked.push(`LOG ${repo} ${id}`);
      return { missing: 'expired' };
    },
  };
}

describe('the Checks route', () => {
  it('answers a managed repository with its view, reading GitHub only with GETs', async () => {
    const reads = recordingReads();
    const app = await serve({
      repo: async (name) => (name === 'api' ? REPO : null),
      reads: async () => reads,
      records: { hostCheck: async () => ({ command: 'make e2e' }), hostCheckRun: async () => null, localCi: async () => null },
    });
    try {
      const { status, body } = await app.get('/v1/repos/api/checks');
      expect(status).toBe(200);
      expect(body).toMatchObject({ repo: 'api', defaultBranch: 'main', workflow: { state: 'missing' } });
      expect((body.rows as { key: string }[]).map((row) => row.key)).toEqual(['host-check']);
      expect(reads.asked.length).toBeGreaterThan(0);
      expect(reads.asked.every((call) => call.startsWith('GET /repos/acme/api/'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('answers 404 for a repository the install does not manage', async () => {
    const app = await serve({
      repo: async () => null,
      reads: async () => recordingReads(),
      records: { hostCheck: async () => null, hostCheckRun: async () => null, localCi: async () => null },
    });
    try {
      const { status, body } = await app.get('/v1/repos/elsewhere/checks');
      expect(status).toBe(404);
      expect(JSON.stringify(body)).toContain('not a repository this install manages');
    } finally {
      await app.close();
    }
  });
});

describe('what the Checks page and the CI failure section may reach', () => {
  // A module that runs a check, reruns one, starts a host check or decides a
  // merge is never imported by them: the page is read-only by what it can
  // call, not by a promise (docs/adr/0083-…).
  const FORBIDDEN = ['./host-check-service.js', './hostd-client.js', './merge-line.js', './gates.js', './automation.js', './automation-bot.js', './webhooks.js'];

  for (const file of ['checks-view.ts', 'ci-failure.ts', 'checks-routes.ts']) {
    it(`${file} imports nothing that runs or decides, and no GitHub client but its type`, () => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)].map((match) => ({ typeOnly: Boolean(match[1]), from: match[2]! }));
      expect(imports.length).toBeGreaterThan(0);
      for (const one of imports) expect(FORBIDDEN).not.toContain(one.from);
      for (const one of imports.filter((entry) => entry.from === '@openadlc/github')) expect(one.typeOnly).toBe(true);
      expect(imports.some((one) => one.from === '@openadlc/db')).toBe(false);
      // Nothing but GET reaches GitHub: no request with another method is written.
      expect(source).not.toMatch(/request\(\s*'(POST|PATCH|PUT|DELETE)'/);
    });
  }
});
