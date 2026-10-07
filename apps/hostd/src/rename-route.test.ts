import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /bots/:from/rename` as the bridge calls it: behind the install's
 * secret, answering with what it did or hostd's reason not to.
 */

const INSTALL_SECRET = 'install-secret-for-the-test';
const PLATFORM = { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': INSTALL_SECRET };
const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const rows: Record<string, { name: string; sidecarDb: boolean; modelAccountId: string | null }> = {
  atlas: { name: 'atlas', sidecarDb: true, modelAccountId: SEAT },
};

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { getBotByName: vi.fn(async (name: string) => rows[name] ?? null) },
  sessions: {},
  tasks: { getTask: vi.fn(async (id: string) => (id === 'task-9' ? { id, state: 'running' } : null)) },
}));

import { audit } from '@fleetadlc/db';

let workRoot: string;
let server: { close: () => Promise<void>; post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }> };
const calls: string[] = [];
let held: Record<string, string> = {};

async function start() {
  const { createHostdServer } = await import('./server.js');
  const { RegistryCredentials } = await import('./registry.js');
  const { AttachTokens } = await import('./attach-tokens.js');

  const http = createHostdServer({
    config: { hostName: 'test', driver: 'docker', workRoot } as never,
    driver: {
      kind: 'docker',
      removeBot: async (bot: string) => void calls.push(`remove ${bot}`),
      ensureBot: async (bot: string) => void calls.push(`ensure ${bot}`),
    } as never,
    runner: {
      activeTaskIds: () => Object.keys(held),
      sessionOf: (id: string) => (held[id] ? { bot: held[id] } : null),
      end: async () => undefined,
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
    async post(path: string, body: unknown, headers: Record<string, string> = PLATFORM) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

beforeEach(async () => {
  workRoot = mkdtempSync(join(tmpdir(), 'fleetadlc-rename-route-'));
  calls.length = 0;
  held = {};
  vi.mocked(audit).mockClear();
  server = await start();
});

afterEach(async () => {
  await server.close();
  rmSync(workRoot, { recursive: true, force: true });
});

describe('renaming a bot’s computer over the wire', () => {
  it('moves it, and asks the driver for the bot under its new name', async () => {
    mkdirSync(join(workRoot, 'atlas', 'repos'), { recursive: true });
    writeFileSync(join(workRoot, 'atlas', 'repos', 'marker'), 'mine');

    const answer = await server.post('/bots/atlas/rename', { to: 'fleetadlc-atlas-janedoe' });

    expect(answer).toEqual({
      status: 200,
      body: { from: 'atlas', to: 'fleetadlc-atlas-janedoe', folder: 'moved' },
    });
    expect(calls).toEqual([
      'remove atlas',
      'ensure fleetadlc-atlas-janedoe',
    ]);
    expect(existsSync(join(workRoot, 'fleetadlc-atlas-janedoe', 'repos', 'marker'))).toBe(true);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bot.computer_renamed', target: 'fleetadlc-atlas-janedoe' }),
    );
  });

  it('answers 409 with the reason while the bot is working', async () => {
    held = { 'task-9': 'atlas' };

    const answer = await server.post('/bots/atlas/rename', { to: 'fleetadlc-atlas-janedoe' });

    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain('running task task-9');
    expect(calls).toEqual([]);
  });

  it('answers 400 for a name no bot could have', async () => {
    const answer = await server.post('/bots/atlas/rename', { to: 'Not A Login' });
    expect(answer.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('is refused without the install’s secret', async () => {
    const answer = await server.post('/bots/atlas/rename', { to: 'fleetadlc-atlas-janedoe' }, { 'content-type': 'application/json' });
    expect(answer.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
