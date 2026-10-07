import type { AddressInfo } from 'node:net';
import { registryTokenRef, TASK_TOKEN_HEADER, taskTokenFor, type SecretStore } from '@fleetadlc/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hostd's other unit tests are pure; this one needs the route, and the route
// reads the task to refuse a credential to a task that has ended.
vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { setBotStatus: vi.fn(), getBotByName: vi.fn(), listBots: vi.fn(async () => []) },
  costs: { taskSpend: vi.fn(async () => 0) },
  sessions: { removeSessionsForBot: vi.fn() },
  tasks: { getTask: vi.fn(async (id: string) => (KNOWN_TASKS.has(id) ? { id, costCapUsd: 10 } : null)) },
}));

const KNOWN_TASKS = new Set(['task-live', 'task-ended']);
const RUNNING = ['task-live'];
const INSTALL_SECRET = 'install-secret-for-the-test';

class FakeStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
  async list(): Promise<string[]> {
    return [...this.values.keys()].sort();
  }
}

let server: Awaited<ReturnType<typeof start>>;

async function start(registryHost: string | null, { stored = true }: { stored?: boolean } = {}) {
  const { createHostdServer } = await import('./server.js');
  const { RegistryCredentials } = await import('./registry.js');
  const { AttachTokens } = await import('./attach-tokens.js');

  const store = new FakeStore();
  if (stored) await store.set(registryTokenRef(), 'npm_secret');

  const http = createHostdServer({
    config: { hostName: 'test', demoMode: false } as never,
    driver: { kind: 'local' } as never,
    runner: { activeTaskIds: () => RUNNING, sessionOf: () => null } as never,
    attachTokens: new AttachTokens(),
    registry: new RegistryCredentials(registryHost, store),
    perTaskCapUsd: 10,
    secret: async () => INSTALL_SECRET,
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    async get(taskId: string, headers: Record<string, string> = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}/registry-token`, { headers });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

afterEach(async () => {
  await server?.close();
});

describe('a task asking hostd for a registry credential', () => {
  beforeEach(async () => {
    server = await start('npm.internal.example');
  });

  it('is served when it presents its own task token', async () => {
    const result = await server.get('task-live', {
      [TASK_TOKEN_HEADER]: taskTokenFor('task-live', INSTALL_SECRET),
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ host: 'npm.internal.example', token: 'npm_secret' });
  });

  it('is refused another task’s credential', async () => {
    // The point of the task token: a bot that could fetch with any id in the
    // path would be able to install as, and be billed as, somebody else.
    const result = await server.get('task-live', {
      [TASK_TOKEN_HEADER]: taskTokenFor('task-ended', INSTALL_SECRET),
    });
    expect(result.status).toBe(401);
    expect(result.body.token).toBeUndefined();
  });

  it('is refused with no credential at all', async () => {
    const result = await server.get('task-live');
    expect(result.status).toBe(401);
    expect(JSON.stringify(result.body)).not.toContain('npm_secret');
  });

  it('is served to the platform, which holds the install secret', async () => {
    // hostd's own suites and the bridge drive this directly.
    const result = await server.get('task-live', { 'x-fleetadlc-internal-secret': INSTALL_SECRET });
    expect(result.status).toBe(200);
  });

  it('is refused for a task that is not running here', async () => {
    // A live session is the only thing that needs to install. A token request
    // for a finished task is something else asking.
    const result = await server.get('task-ended', {
      [TASK_TOKEN_HEADER]: taskTokenFor('task-ended', INSTALL_SECRET),
    });
    expect(result.status).toBe(409);
  });

  it('is 404 for a task the platform has never heard of', async () => {
    const result = await server.get('task-nope', {
      [TASK_TOKEN_HEADER]: taskTokenFor('task-nope', INSTALL_SECRET),
    });
    expect(result.status).toBe(404);
  });
});

describe('an install with no private registry', () => {
  beforeEach(async () => {
    server = await start(null);
  });

  it('answers 501, so a wrapper installs publicly rather than failing', async () => {
    // Every install today takes this path. It has to read as "nothing to do",
    // not as an error, or a wrapper will treat a normal install as broken.
    const result = await server.get('task-live', {
      [TASK_TOKEN_HEADER]: taskTokenFor('task-live', INSTALL_SECRET),
    });
    expect(result.status).toBe(501);
    expect(result.body.error).toContain('no private package registry');
  });

  it('still refuses an unauthenticated caller, rather than explaining itself', async () => {
    expect((await server.get('task-live')).status).toBe(401);
  });
});

describe('an install that names a registry but stores no token for it', () => {
  beforeEach(async () => {
    server = await start('npm.internal.example', { stored: false });
  });

  it('answers 503 with the remedy, so the wrapper fails rather than installing publicly', async () => {
    // 501 here was read as "no registry" and the install went to the public
    // registry: the dependency-confusion fallback the wrapper exists to stop.
    const result = await server.get('task-live', {
      [TASK_TOKEN_HEADER]: taskTokenFor('task-live', INSTALL_SECRET),
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: expect.stringContaining('npm.internal.example'),
      remedy: expect.stringContaining(registryTokenRef()),
    });
  });
});
