import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineUpdateResult, EngineUpdateStart, EngineUpdateStatus } from '@fleetadlc/shared';

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { listBots: vi.fn(async () => []), getBotByName: vi.fn(async () => null) },
  modelAccounts: { get: vi.fn(async () => null) },
  costs: {},
  sessions: {},
  tasks: { getTask: vi.fn(async () => null) },
}));

import { audit } from '@fleetadlc/db';
import { EngineUpdateRefused } from './engine-updates.js';

/**
 * The engine update as it reaches the wire: behind the install's secret like
 * every other route, answering a started build at once, and passing on only
 * what the decision may read. The updater itself is `engine-updates.test.ts`.
 */

const INSTALL_SECRET = 'install-secret-for-the-test';
const PLATFORM = { 'x-fleetadlc-internal-secret': INSTALL_SECRET, 'x-fleetadlc-on-behalf-of': 'ada', 'content-type': 'application/json' };

const STATUS: EngineUpdateStatus = {
  driver: 'docker',
  applicable: true,
  reason: '',
  image: 'fleetadlc-bot:latest',
  inUse: { '@anthropic-ai/claude-code': '2.1.282', '@openai/codex': '0.155.1', '@xai-official/grok': '1.0.41' },
  inUseSource: 'label',
  previous: null,
  running: null,
  last: null,
};

const ROLLED_BACK: EngineUpdateResult = {
  state: 'rolled-back',
  trigger: 'rollback',
  requestedBy: 'ada',
  from: { '@openai/codex': '0.156.1' },
  to: { '@openai/codex': '0.155.1' },
  latest: null,
  checks: [],
  reason: 'codex 0.156.1 → 0.155.1',
  startedAt: '2026-09-28T07:00:00.000Z',
  finishedAt: '2026-09-28T07:00:09.000Z',
};

function updates() {
  return {
    status: vi.fn(async () => STATUS),
    update: vi.fn(
      (): EngineUpdateStart => ({ running: true, startedAt: '2026-09-27T15:00:00.000Z', joined: false, last: null }),
    ),
    rollback: vi.fn(async () => ROLLED_BACK),
  };
}

let service: ReturnType<typeof updates>;
let server: { close: () => Promise<void>; call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }> };

beforeEach(async () => {
  service = updates();
  vi.mocked(audit).mockClear();
  const { createHostdServer } = await import('./server.js');
  const { RegistryCredentials } = await import('./registry.js');
  const { AttachTokens } = await import('./attach-tokens.js');
  const http = createHostdServer({
    config: { hostName: 'test', driver: 'docker', loginRoot: '/nowhere' } as never,
    driver: { kind: 'docker' } as never,
    runner: { activeTaskIds: () => [], sessionOf: () => null } as never,
    attachTokens: new AttachTokens(),
    registry: new RegistryCredentials(null),
    perTaskCapUsd: 10,
    secret: async () => INSTALL_SECRET,
    engineUpdates: service,
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  server = {
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    async call(method, path, body, headers = PLATFORM) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
});

afterEach(async () => {
  await server.close();
});

describe('the engine update’s routes', () => {
  it('refuse a caller without the install’s secret, like every other route', async () => {
    for (const [method, path] of [
      ['GET', '/engines/update'],
      ['POST', '/engines/update'],
      ['POST', '/engines/rollback'],
    ] as const) {
      expect((await server.call(method, path, undefined, {})).status).toBe(401);
    }
    expect(service.update).not.toHaveBeenCalled();
    expect(service.rollback).not.toHaveBeenCalled();
  });

  it('say which versions the crew runs and whether a run is going', async () => {
    const { status, body } = await server.call('GET', '/engines/update');
    expect(status).toBe(200);
    expect(body).toMatchObject({ applicable: true, inUse: STATUS.inUse, running: null });
  });

  it('answer a started run at once, for whom it was asked, with only a held version the decision may read', async () => {
    const { status, body } = await server.call('POST', '/engines/update', {
      trigger: 'schedule',
      hold: { '@anthropic-ai/claude-code': '2.1.290', '@openai/codex': 'latest; rm -rf /', 'left-pad': '1.0.0' },
    });

    expect(status).toBe(202);
    expect(body).toMatchObject({ running: true, startedAt: '2026-09-27T15:00:00.000Z' });
    expect(service.update).toHaveBeenCalledWith({
      trigger: 'schedule',
      requestedBy: 'ada',
      hold: { '@anthropic-ai/claude-code': '2.1.290' },
      // A bridge from before the setting sends none: the default.
      minReleaseAgeDays: 3,
    });
  });

  it('pass on the minimum release age the bridge sends, and the default for one that is not a whole number of days from 0 to 90', async () => {
    for (const [sent, taken] of [
      [0, 0],
      [14, 14],
      [91, 3],
      [2.5, 3],
      ['7', 3],
      [-1, 3],
    ] as const) {
      service.update.mockClear();
      await server.call('POST', '/engines/update', { trigger: 'console', minReleaseAgeDays: sent });
      expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ minReleaseAgeDays: taken }));
    }
  });

  it('answer with the result when there was nothing to run', async () => {
    service.update.mockReturnValue({
      running: false,
      startedAt: '2026-09-27T15:00:00.000Z',
      joined: false,
      last: { ...ROLLED_BACK, state: 'skipped', reason: 'not applicable: the local driver runs the host’s own CLIs' },
    });
    const { status, body } = await server.call('POST', '/engines/update', {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ running: false, last: { state: 'skipped' } });
  });

  it('roll back for the person named, and pass a refusal on with its own status', async () => {
    expect(await server.call('POST', '/engines/rollback', {})).toEqual({ status: 200, body: ROLLED_BACK });
    expect(service.rollback).toHaveBeenCalledWith('ada');

    service.rollback.mockRejectedValue(new EngineUpdateRefused(409, 'an engine update is running; roll back once it has finished'));
    expect(await server.call('POST', '/engines/rollback', {})).toEqual({
      status: 409,
      body: { error: 'an engine update is running; roll back once it has finished' },
    });
  });

  it('write nothing to the audit log, which is the bridge’s to write once', async () => {
    await server.call('POST', '/engines/update', {});
    await server.call('POST', '/engines/rollback', {});
    expect(audit).not.toHaveBeenCalled();
  });
});
