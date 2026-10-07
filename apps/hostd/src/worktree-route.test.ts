import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_TOKEN_HEADER, taskTokenFor } from '@fleetadlc/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the task to tell one that never existed from one that is over,
// which is the same reason `registry-route.test.ts` mocks the store.
vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { setBotStatus: vi.fn(), getBotByName: vi.fn(), listBots: vi.fn(async () => []) },
  costs: { taskSpend: vi.fn(async () => 0) },
  sessions: { removeSessionsForBot: vi.fn() },
  tasks: { getTask: vi.fn(async (id: string) => (KNOWN_TASKS.has(id) ? { id, costCapUsd: 10 } : null)) },
}));

const KNOWN_TASKS = new Set(['task-live', 'task-ended']);
const INSTALL_SECRET = 'install-secret-for-the-test';

let base: string;
let root: string;
let server: Awaited<ReturnType<typeof start>>;

async function start() {
  const { createHostdServer } = await import('./server.js');
  const { RegistryCredentials } = await import('./registry.js');
  const { AttachTokens } = await import('./attach-tokens.js');

  const http = createHostdServer({
    config: { hostName: 'test', demoMode: false } as never,
    driver: { kind: 'local' } as never,
    runner: {
      activeTaskIds: () => ['task-live'],
      sessionOf: () => null,
      // Only a running task has a worktree, which is what the route asks about.
      worktreeOf: (taskId: string) => (taskId === 'task-live' ? root : null),
    } as never,
    attachTokens: new AttachTokens(),
    registry: new RegistryCredentials(null),
    perTaskCapUsd: 10,
    secret: async () => INSTALL_SECRET,
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    async get(taskId: string, path: string, headers: Record<string, string> = {}) {
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const response = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}/worktree${query}`, { headers });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    async write(taskId: string, method: string, headers: Record<string, string> = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}/worktree`, {
        method,
        headers,
        body: JSON.stringify({ path: 'src/server.ts', content: 'anything' }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

const PLATFORM = { 'x-fleetadlc-internal-secret': INSTALL_SECRET };

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'fleetadlc-worktree-route-'));
  root = join(base, 'wt', 'task-live');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'server.ts'), 'export const port = 47312;\n');
  writeFileSync(join(base, 'secrets.txt'), 'not the bot’s work\n');

  server = await start();
});

afterEach(async () => {
  await server?.close();
  rmSync(base, { recursive: true, force: true });
});

describe('the console reading a task’s worktree', () => {
  it('lists the worktree for the platform, which holds the install secret', async () => {
    const result = await server.get('task-live', '', PLATFORM);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: 'directory', path: '' });
  });

  it('shows a file the bot wrote', async () => {
    const result = await server.get('task-live', 'src/server.ts', PLATFORM);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: 'file', content: 'export const port = 47312;\n' });
  });

  it('is refused with no credential at all', async () => {
    // The worktree holds whatever the bot is working on, some of which is not
    // public yet. Reaching the port is not enough to read it.
    const result = await server.get('task-live', 'src/server.ts');
    expect(result.status).toBe(401);
    expect(JSON.stringify(result.body)).not.toContain('47312');
  });

  it('is refused a task token, which admits a session and not a reader', async () => {
    // `/tasks/:id/registry-token` takes one because a session cannot hold the
    // install secret. Nothing about this route is reached by a session, so the
    // credential that exists for that one must not open it.
    const result = await server.get('task-live', 'src/server.ts', {
      [TASK_TOKEN_HEADER]: taskTokenFor('task-live', INSTALL_SECRET),
    });
    expect(result.status).toBe(401);
  });

  it('refuses a path that climbs out, through the route as well as under it', async () => {
    const result = await server.get('task-live', '../../secrets.txt', PLATFORM);
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).not.toContain('not the bot');
  });

  it('refuses a symlink the task planted, with the status the module chose', async () => {
    symlinkSync(join(base, 'secrets.txt'), join(root, 'shortcut'));
    const result = await server.get('task-live', 'shortcut', PLATFORM);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain('not the bot');
  });

  it('is 409 for a task that is not running here', async () => {
    // A worktree exists while its task does; `TaskRunner.end` removes it. A read
    // for a finished task is something else asking.
    const result = await server.get('task-ended', '', PLATFORM);
    expect(result.status).toBe(409);
  });

  it('is 404 for a task the platform has never heard of', async () => {
    expect((await server.get('task-nope', '', PLATFORM)).status).toBe(404);
  });

  it('has no write path, even for the platform', async () => {
    // "Nothing there is writable" is an acceptance criterion, and hostd routes on
    // method and path together — so this fails the day somebody adds a POST here
    // rather than the day a person notices one landed.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = await server.write('task-live', method, PLATFORM);
      expect(result.status, `${method} /tasks/task-live/worktree`).toBe(404);
    }
  });
});
