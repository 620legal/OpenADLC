import { internalSecretRef } from '@fleetadlc/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authLogin, authStatus, botsToConnect, connectThroughBridge } from './auth.js';
import { defaultConfig } from '../install.js';

/** The install `authLogin` sees: its crew, its secret store, and what GitHub's device flow answers. */
const world = vi.hoisted(() => ({
  crew: [] as { id: string; name: string; slot: string; role: string; githubLogin: string | null }[],
  secrets: new Map<string, string>(),
  writes: [] as string[],
  approvedAs: 'janedoe-crew',
  kinds: new Map<string, 'refresh' | 'static'>(),
}));

vi.mock('@fleetadlc/db', () => ({
  bots: {
    listBots: async () => world.crew,
    getBotById: async (id: string) => world.crew.find((bot) => bot.id === id) ?? null,
  },
  credentials: { getCredential: async () => null },
  closePool: async () => undefined,
  waitForDatabase: async () => undefined,
  settings: { getSetting: async () => null },
}));

vi.mock('@fleetadlc/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/github')>();
  return {
    ...actual,
    requestDeviceCode: async () => ({ deviceCode: 'd', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 1, expiresIn: 900 }),
    pollForUserToken: async () => ({ accessToken: 'ghu_cli', refreshToken: 'ghr_cli', expiresAt: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' }),
    credentialKind: async (bot: string) => world.kinds.get(bot) ?? null,
    GitHubClient: class {
      async viewer() {
        return { login: world.approvedAs, id: 42 };
      }
    },
    getSecretStore: () => ({
      get: async (ref: string) => world.secrets.get(ref) ?? null,
      set: async (ref: string, value: string) => {
        world.writes.push(ref);
        world.secrets.set(ref, value);
      },
      delete: async (ref: string) => {
        world.writes.push(ref);
        world.secrets.delete(ref);
      },
      list: async () => [...world.secrets.keys()],
    }),
  };
});

const crew = [
  { name: 'intake', slot: 'intake', githubLogin: null },
  // Connected, so it goes by its account's handle.
  { name: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' },
  { name: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: null },
];

describe('which bot `fleetadlc auth login --bot` means', () => {
  it('is the bot in that seat, whatever it goes by now', () => {
    // `--bot builder` is what the walkthrough says, and it is still right
    // after the builder has taken its account's handle.
    expect(botsToConnect(crew, { bot: 'builder' })).toEqual([crew[1]]);
  });

  it('is the bot of that name, or of that account', () => {
    expect(botsToConnect(crew, { bot: 'fleetadlc-atlas-janedoe' })).toEqual([crew[1]]);
    expect(botsToConnect(crew, { bot: 'FleetADLC-Atlas-Janedoe' })).toEqual([crew[1]]);
    expect(botsToConnect(crew, { bot: 'intake' })).toEqual([crew[0]]);
  });

  it('reads a persona from an older guide as the seat it was', () => {
    expect(botsToConnect(crew, { bot: 'sydney' })).toEqual([crew[2]]);
  });

  it('is every bot with --all, and nobody for a name that means nothing', () => {
    expect(botsToConnect(crew, { all: true })).toEqual(crew);
    expect(botsToConnect(crew, { bot: 'nobody' })).toEqual([]);
    expect(botsToConnect(crew, {})).toEqual([]);
  });
});

const TOKEN = { accessToken: 'ghu_cli', refreshToken: 'ghr_cli', expiresAt: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' };

describe('handing a seat’s sign-in to the bridge', () => {
  it('posts it to the bridge’s connect route with the install’s secret, and says what the bridge did', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ login: 'janedoe-crew', bot: 'system-engineer', joined: 'janedoe-crew' }),
    );

    const answer = await connectThroughBridge(47311, 'install-secret', { bot: 'system-engineer', token: TOKEN, actor: 'fleetadlc auth login' }, send as unknown as typeof fetch);

    expect(answer).toEqual({ state: 'connected', login: 'janedoe-crew', bot: 'system-engineer', joined: 'janedoe-crew' });
    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:47311/internal/bots/connect');
    expect((init?.headers as Record<string, string>)['x-fleetadlc-internal-secret']).toBe('install-secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({ bot: 'system-engineer', token: { refreshToken: 'ghr_cli' } });
  });

  it('gives the bridge’s refusal in its words, and is unreachable when nothing answers or there is no secret', async () => {
    const refusing = vi.fn(async () => Response.json({ error: 'janedoe-crew is the crew account (the builder signs in as it).' }, { status: 409 }));
    expect(await connectThroughBridge(47311, 's', { bot: 'lead-reviewer', token: TOKEN, actor: 'a' }, refusing as unknown as typeof fetch)).toEqual({
      state: 'refused',
      message: 'janedoe-crew is the crew account (the builder signs in as it).',
    });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await connectThroughBridge(47311, 's', { bot: 'builder', token: TOKEN, actor: 'a' }, down as unknown as typeof fetch)).toEqual({ state: 'unreachable' });
    expect(await connectThroughBridge(47311, null, { bot: 'builder', token: TOKEN, actor: 'a' }, down as unknown as typeof fetch)).toEqual({ state: 'unreachable' });
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe('fleetadlc auth login', () => {
  // It stored the sign-in itself, under the seat's name, and refused any
  // account another seat held: a crew on a shared account could not connect.
  const printed: string[] = [];
  const exitCode = process.exitCode;
  let routes: Record<string, () => Response>;

  beforeEach(() => {
    world.crew = [
      { id: 'b-builder', name: 'janedoe-crew', slot: 'builder', role: 'implement', githubLogin: 'janedoe-crew' },
      { id: 'b-se', name: 'system-engineer', slot: 'system-engineer', role: 'spec', githubLogin: null },
    ];
    world.secrets = new Map([[internalSecretRef(), 'install-secret']]);
    world.writes = [];
    printed.length = 0;
    routes = { '/healthz': () => Response.json({ ok: true }) };
    vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
    vi.stubGlobal('fetch', async (url: string) => {
      const route = routes[new URL(url).pathname];
      if (!route) throw new TypeError('fetch failed');
      return route();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });

  const config = { ...defaultConfig('/repo'), githubClientId: 'Iv23liTEST' };

  it('connects a seat to the account another seat of its group is on, through the bridge', async () => {
    routes['/internal/bots/connect'] = () => Response.json({ login: 'janedoe-crew', bot: 'system-engineer', joined: 'janedoe-crew' });

    await authLogin(config, { bot: 'system-engineer' });

    expect(printed.join('\n')).toContain('the system engineer is connected as janedoe-crew, sharing it with the builder');
    expect(printed.join('\n')).not.toMatch(/refus|needs its own/);
    expect(world.writes).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
  });

  it('stores nothing, and fails, when the bridge refuses', async () => {
    routes['/internal/bots/connect'] = () => Response.json({ error: 'janedoe-crew is the crew account (the builder signs in as it).' }, { status: 409 });

    await authLogin(config, { bot: 'system-engineer' });

    expect(printed.join('\n')).toContain('janedoe-crew is the crew account');
    expect(world.writes).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('says to name a bot, or --all, when given neither', async () => {
    // It said "no bot named (none given)" and not what to type.
    await authLogin(config, {});
    expect(printed.join('\n')).toContain('name a bot: fleetadlc auth login --bot SEAT, or --all for every bot');
    expect(printed.join('\n')).toContain('seats: builder (janedoe-crew), system-engineer');
    expect(process.exitCode).toBe(2);

    printed.length = 0;
    await authLogin(config, { bot: ' ' });
    expect(printed.join('\n')).toContain('name a bot');
  });

  it('stores nothing, and says to start the bridge, when it is not running', async () => {
    routes = {};

    await authLogin(config, { bot: 'builder' });

    expect(printed.join('\n')).toContain('the bridge is not running. Run: fleetadlc up, then fleetadlc auth login --bot builder');
    expect(world.writes).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

describe('fleetadlc auth status', () => {
  const printed: string[] = [];

  beforeEach(() => {
    world.crew = [
      { id: 'b-builder', name: 'janedoe-crew', slot: 'builder', role: 'implement', githubLogin: 'janedoe-crew' },
      { id: 'b-se', name: 'system-engineer', slot: 'system-engineer', role: 'spec', githubLogin: null },
    ];
    world.kinds = new Map();
    printed.length = 0;
    vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
  });

  afterEach(() => vi.restoreAllMocks());

  it('says OpenADLC stores the token itself when a seat has a non-expiring one', async () => {
    // "OpenADLC stores refresh tokens only" was printed right under a seat
    // listed as "connected with a stored token (no expiry)".
    world.kinds.set('janedoe-crew', 'static');
    await authStatus();
    const output = printed.join('\n');
    expect(output).toContain('connected with a stored token');
    expect(output).toContain('OpenADLC stores that token itself');
    expect(output).toContain('Expire user authorization tokens');
    expect(output).not.toContain('stores a refresh token per account');
  });

  it('says it keeps refresh tokens when no seat has a non-expiring token', async () => {
    world.kinds.set('janedoe-crew', 'refresh');
    await authStatus();
    const output = printed.join('\n');
    expect(output).toContain('stores a refresh token per account');
    expect(output).not.toContain('stores that token itself');
  });
});
