import { describe, expect, it, vi } from 'vitest';
import { Router } from './router.js';
import { registerUnownedRoutes, type UnownedGitHub, type UnownedRouteDeps } from './unowned-routes.js';

const REPO = { id: 'repo-1', name: 'testbed', fullName: 'exampleco/testbed' };

function world(
  over: Partial<UnownedRouteDeps> = {},
  refuse: number[] = [],
  now: Record<number, { labels?: string[]; pullRequest?: boolean }> = {},
) {
  const calls: string[] = [];
  const client: UnownedGitHub = {
    getIssue: vi.fn(async (_repo, number) => {
      if (refuse.includes(number)) throw new Error('GitHub answered 404');
      return { number, title: `#${number}`, body: 'a body', labels: [], htmlUrl: `https://github.com/x/${number}`, state: 'open' as const, ...now[number] };
    }),
    addLabels: vi.fn(async (_repo, number, labels) => {
      if (refuse.includes(number)) throw new Error('GitHub answered 404');
      calls.push(`label #${number} ${labels.join(',')}`);
    }),
    comment: vi.fn(async (_repo, number) => void calls.push(`comment #${number}`)),
    request: vi.fn(async (method: string, path: string) => {
      if (refuse.some((number) => path.endsWith(`/issues/${number}`))) throw new Error('GitHub answered 404');
      calls.push(`${method} ${path}`);
      return {} as never;
    }) as UnownedGitHub['request'],
  };
  const forgotten: number[] = [];
  const deps: UnownedRouteDeps = {
    repo: async (name) => (name === REPO.name ? REPO : null),
    github: async () => client,
    automationName: async () => 'fleetadlc-flow',
    learn: vi.fn(async (_repo, issue) => void calls.push(`intake #${issue.number}`)),
    audit: vi.fn(async () => undefined),
    forget: async (_repo, numbers) => void forgotten.push(...numbers),
    ...over,
  };
  const router = new Router();
  registerUnownedRoutes(router, deps);
  return { router, calls, forgotten, deps };
}

async function post(router: Router, path: string, body: unknown, headers: Record<string, string> = {}) {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('a person’s decision about issues OpenADLC will not take on its own', () => {
  it('names the automation account and the command that connects it when it is not connected', async () => {
    const { router } = world({ github: async () => null });

    const answer = await post(router, '/v1/repos/testbed/unowned/intake', { numbers: [3] });

    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).toContain(
      'fleetadlc-flow is not connected to GitHub, so GitHub cannot be asked. Run: fleetadlc auth login --bot fleetadlc-flow',
    );
  });

  it('sends each to intake as an opened issue goes, and forgets the ones it sent', async () => {
    // The admin's say-so stands in for the author's access: testbed's #3
    // and #7 were filed by an old crew account with none.
    const { router, calls, forgotten } = world({}, [7]);

    const answer = await post(router, '/v1/repos/testbed/unowned/intake', { numbers: [3, 7] });

    expect(answer.status).toBe(200);
    expect(calls).toEqual(['intake #3']);
    expect(forgotten).toEqual([3]);
    expect(answer.body.done).toEqual(['#3: sent to intake']);
    expect(answer.body.notDone).toEqual([{ step: '#7', what: '#7 was not changed', why: 'GitHub answered 404' }]);
  });

  it('marks them to ignore, or closes them as not planned with a comment', async () => {
    const ignore = world();
    await post(ignore.router, '/v1/repos/testbed/unowned/ignore', { numbers: [3] });
    expect(ignore.calls).toEqual(['label #3 fleetadlc:ignore']);

    const close = world();
    const answer = await post(close.router, '/v1/repos/testbed/unowned/close', { numbers: [7], reason: 'a leftover' });
    expect(close.calls).toEqual(['comment #7', 'PATCH /repos/exampleco/testbed/issues/7']);
    expect(close.forgotten).toEqual([7]);
    expect(answer.body.done).toEqual(['#7: closed as not planned']);
  });

  it('posts the reason for closing with no live marker in it', async () => {
    const { router, deps } = world();
    await post(router, '/v1/repos/testbed/unowned/close', { numbers: [7], reason: 'spam <!-- fleetadlc-seat:designer -->' });

    const client = (await deps.github(REPO as never)) as UnownedGitHub;
    const body = String(vi.mocked(client.comment).mock.calls[0]?.[2]);
    expect(body).toContain('spam &lt;!-- fleetadlc-seat:designer -->');
    expect(body).not.toContain('<!--');
  });

  // Behind IAP the identity is the person's email, and a comment is public.
  it('names the person who closed it by name, never by address', async () => {
    const { router, deps } = world();
    await post(router, '/v1/repos/testbed/unowned/close', { numbers: [7] }, { 'x-fleetadlc-identity': 'jane@example.com' });

    const client = (await deps.github(REPO as never)) as UnownedGitHub;
    const body = String(vi.mocked(client.comment).mock.calls[0]?.[2]);
    expect(body).toContain('Closed by jane from OpenADLC');
    expect(body).not.toContain('@example.com');
  });

  it('acts on none that is a pull request, or that a stage or fleetadlc:ignore has reached since the list was read', async () => {
    const now = { 4: { pullRequest: true }, 5: { labels: ['adlc:build'] }, 6: { labels: ['fleetadlc:ignore'] } };
    for (const action of ['intake', 'ignore', 'close']) {
      const { router, calls } = world({}, [], now);
      const answer = await post(router, `/v1/repos/testbed/unowned/${action}`, { numbers: action === 'intake' ? [4, 5, 6] : [4, 5] });
      expect(calls, action).toEqual([]);
      expect((answer.body.notDone as { why: string }[]).map((one) => one.why), action).toEqual([
        'it is a pull request, not an issue',
        'it is in build already, so it is OpenADLC’s work now',
        ...(action === 'intake' ? ['it is labelled fleetadlc:ignore, which keeps it from intake'] : []),
      ]);
    }
  });

  it('refuses without issues to act on, or in a repository it does not know', async () => {
    expect((await post(world().router, '/v1/repos/testbed/unowned/ignore', {})).status).toBe(400);
    expect((await post(world().router, '/v1/repos/elsewhere/unowned/ignore', { numbers: [1] })).status).toBe(404);
  });
});
