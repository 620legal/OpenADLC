import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Letting the crew into a repository, against a fake GitHub that keeps who can
 * do what. Inviting an account into a real repository cannot be undone from
 * here, so it is not rehearsed against a live one.
 */

const world = vi.hoisted(() => ({
  owner: 'User' as 'User' | 'Organization',
  /** Each account's role in the repository, however it got it. */
  access: new Map<string, string>(),
  /** Invitations sent, by id: who, and with what permission. */
  invitations: new Map<number, { login: string; permission: string }>(),
  sent: [] as string[],
  connected: new Set<string>(),
  /** What GitHub answers a PUT for an account it will not invite. */
  refuse: new Map<string, Error>(),
  /** What GitHub answers when asked who owns the repository, if not the owner. */
  ownerLookup: null as Error | null,
}));

vi.mock('@fleetadlc/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/github')>();
  return {
    ...actual,
    getSecretStore: () => ({ get: async () => 'app-private-key' }),
    installationTokenFor: async () => ({ token: 'installation-token' }),
    GitHubClient: class {
      async request(method: string, path: string, body?: { permission?: string }): Promise<unknown> {
        world.sent.push(`${method} ${path}${body?.permission ? ` ${body.permission}` : ''}`);
        const permission = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(path);
        if (method === 'GET' && permission) {
          const role = world.access.get(decodeURIComponent(permission[1]!)) ?? 'none';
          return { role_name: role, permission: role === 'triage' ? 'read' : role };
        }
        if (method === 'GET') {
          if (world.ownerLookup) throw world.ownerLookup;
          return { owner: { type: world.owner } };
        }
        const collaborator = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)$/.exec(path);
        if (method === 'PUT' && collaborator) {
          const login = collaborator[1]!;
          const refusal = world.refuse.get(login);
          if (refusal) throw refusal;
          // An organization's member is added directly; anybody else is invited.
          if (world.owner === 'Organization' && login.startsWith('member-')) {
            world.access.set(login, body?.permission === 'push' ? 'write' : (body?.permission ?? 'read'));
            return null;
          }
          const id = 1000 + world.invitations.size;
          world.invitations.set(id, { login, permission: body?.permission ?? 'push' });
          return { id, invitee: { login } };
        }
        throw new Error(`unexpected ${method} ${path}`);
      }
    },
  };
});

const ran = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], _options: unknown, done: (error: Error | null, out: { stdout: string; stderr: string }) => void) => {
    ran.push([command, ...args]);
    done(null, { stdout: '[]', stderr: '' });
  },
}));

vi.mock('./github-accounts.js', () => ({ loginAvailable: vi.fn(async () => false) }));
vi.mock('./effective-config.js', () => ({ effectiveConfig: vi.fn(async () => ({ gitHubClientId: 'client-id' })) }));

const crew = [
  { id: 'b1', name: 'ottoexampleco', role: 'intake', githubLogin: 'ottoexampleco' },
  { id: 'b2', name: 'fleetadlc-atlas-janedoe', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe' },
  { id: 'b3', name: 'noraexampleco', role: 'review_lead', githubLogin: 'noraexampleco' },
  { id: 'b4', name: 'qa', role: 'qa', githubLogin: null },
];

vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },
  bots: { listBots: vi.fn(async () => crew) },
  repos: { listRepos: vi.fn(async () => [{ name: 'api', fullName: 'acme/api' }]) },
}));

import { InvitationService, nextPagePath } from './invitation-service.js';

/** A bot's own token, which is the only one that can accept its invitation. */
const actors = {
  asBot: async (name: string) =>
    world.connected.has(name)
      ? {
          request: async (method: string, path: string) => {
            world.sent.push(`${method} ${path} as ${name}`);
            const id = Number(path.split('/').pop());
            const invitation = world.invitations.get(id);
            if (!invitation) throw new Error(`${path} → 404`);
            world.access.set(invitation.login, invitation.permission === 'push' ? 'write' : invitation.permission);
            return {};
          },
        }
      : null,
};

function service(): InvitationService {
  return new InvitationService(actors as never, {} as never);
}

beforeEach(() => {
  world.owner = 'User';
  world.access = new Map();
  world.invitations = new Map();
  world.sent = [];
  world.connected = new Set(['ottoexampleco', 'fleetadlc-atlas-janedoe', 'noraexampleco']);
  world.refuse = new Map();
  world.ownerLookup = null;
  ran.length = 0;
});

describe('letting the crew into a repository a person owns', () => {
  it('invites each bot as a collaborator with write, and each accepts its own invitation', async () => {
    const { results } = await service().inviteAndAccept('acme/api');

    expect(results.map(({ bot, state, changed }) => `${bot} ${state}${changed ? ' changed' : ''}`)).toEqual([
      'ottoexampleco in changed',
      'fleetadlc-atlas-janedoe in changed',
      'noraexampleco in changed',
      'qa no-account',
    ]);
    // No triage on a repository a person owns: GitHub refuses it there.
    expect(world.sent.filter((line) => line.startsWith('PUT'))).toEqual([
      'PUT /repos/acme/api/collaborators/ottoexampleco push',
      'PUT /repos/acme/api/collaborators/fleetadlc-atlas-janedoe push',
      'PUT /repos/acme/api/collaborators/noraexampleco push',
    ]);
    expect(world.sent).toContain('PATCH /user/repository_invitations/1001 as fleetadlc-atlas-janedoe');
  });

  it('leaves a bot that can already work there alone, whatever else it was given', async () => {
    world.access.set('fleetadlc-atlas-janedoe', 'admin');
    world.access.set('noraexampleco', 'write');
    world.access.set('ottoexampleco', 'write');

    const { results } = await service().inviteAndAccept('acme/api');

    expect(results.filter((one) => one.state === 'in').every((one) => !one.changed)).toBe(true);
    // Not invited again, and the admin somebody made by hand is not lowered to write.
    expect(world.sent.some((line) => line.startsWith('PUT'))).toBe(false);
    expect(world.access.get('fleetadlc-atlas-janedoe')).toBe('admin');
  });

  it('says a bot that is not connected is invited, and accepts once it connects', async () => {
    world.connected.delete('noraexampleco');
    const { results } = await service().inviteAndAccept('acme/api');
    expect(results.find((one) => one.bot === 'noraexampleco')).toMatchObject({ state: 'invited', changed: true });

    world.connected.add('noraexampleco');
    const again = await service().inviteAndAccept('acme/api', 'noraexampleco');
    expect(again.results).toEqual([expect.objectContaining({ bot: 'noraexampleco', state: 'in', changed: true })]);
  });

  it('says why GitHub refused, in its words', async () => {
    world.refuse.set('noraexampleco', new Error('/repos/acme/api/collaborators/noraexampleco → 403: Resource not accessible by integration'));
    const { results } = await service().inviteAndAccept('acme/api');
    expect(results.find((one) => one.bot === 'noraexampleco')).toMatchObject({
      state: 'refused',
      detail: 'the OpenADLC app needs `Administration: read and write` to invite anybody',
    });
  });
});

describe('letting the crew into a repository an organization owns', () => {
  beforeEach(() => {
    world.owner = 'Organization';
  });

  it('gives a bot that only files and labels triage, and the others write', async () => {
    await service().inviteAndAccept('acme/api');
    expect(world.sent.filter((line) => line.startsWith('PUT'))).toEqual([
      'PUT /repos/acme/api/collaborators/ottoexampleco triage',
      'PUT /repos/acme/api/collaborators/fleetadlc-atlas-janedoe push',
      'PUT /repos/acme/api/collaborators/noraexampleco push',
    ]);
  });

  it('counts a team as a way in, and invites nobody it already lets in', async () => {
    world.access.set('ottoexampleco', 'triage');
    world.access.set('fleetadlc-atlas-janedoe', 'write');
    world.access.set('noraexampleco', 'maintain');
    const { results } = await service().inviteAndAccept('acme/api');
    expect(results.filter((one) => one.state === 'in')).toHaveLength(3);
    expect(world.sent.some((line) => line.startsWith('PUT'))).toBe(false);
  });

  it('gives automation triage too when GitHub says who owns the repository', async () => {
    crew.push({ id: 'b6', name: 'automation', role: 'automation', githubLogin: 'automationexampleco' });
    try {
      await service().inviteAndAccept('acme/api');
      expect(world.sent.filter((line) => line.startsWith('PUT'))).toContain(
        'PUT /repos/acme/api/collaborators/automationexampleco triage',
      );
    } finally {
      crew.pop();
    }
  });

  it('invites neither intake nor automation when it cannot tell who owns the repository', async () => {
    // A 502 was read as "a person owns it", so both got push, and no later run
    // lowers a grant: intake, which reads untrusted issue text, kept write.
    world.ownerLookup = new Error('/repos/acme/api → 502: Bad Gateway');
    crew.push({ id: 'b6', name: 'automation', role: 'automation', githubLogin: 'automationexampleco' });
    try {
      const { results } = await service().inviteAndAccept('acme/api');

      const puts = world.sent.filter((line) => line.startsWith('PUT'));
      expect(puts.some((line) => line.includes('ottoexampleco'))).toBe(false);
      expect(puts.some((line) => line.includes('automationexampleco'))).toBe(false);
      for (const bot of ['ottoexampleco', 'automation']) {
        expect(results.find((one) => one.bot === bot)).toMatchObject({
          state: 'refused',
          changed: false,
          detail: expect.stringMatching(/could not tell whether acme is an organization.*try again/),
        });
      }
      // The rest need write wherever they are, so they are invited as usual.
      expect(puts).toEqual([
        'PUT /repos/acme/api/collaborators/fleetadlc-atlas-janedoe push',
        'PUT /repos/acme/api/collaborators/noraexampleco push',
      ]);
    } finally {
      crew.pop();
    }
  });

  it('adds a member without an invitation, and checks it can then work there', async () => {
    const member = { id: 'b5', name: 'member-builder', role: 'implement', githubLogin: 'member-builder' };
    crew.push(member);
    try {
      const { results } = await service().inviteAndAccept('acme/api', 'member-builder');
      expect(results).toEqual([expect.objectContaining({ state: 'in', changed: true, detail: 'added just now' })]);
    } finally {
      crew.pop();
    }
  });
});

describe('only where OpenADLC works', () => {
  it('invites nobody into a repository it was never given, whatever the app reaches', async () => {
    await expect(service().inviteAndAccept('someone-else/private')).rejects.toThrow(
      'someone-else/private is not a repository OpenADLC works in — add it first',
    );
    expect(world.sent).toEqual([]);
  });

  it('runs `gh` for none but its own repositories, named in any case', async () => {
    await expect(service().discover('someone-else/private')).rejects.toThrow(/not a repository OpenADLC works in/);
    expect(ran).toEqual([]);

    await service().discover('ACME/API');
    expect(ran).toEqual([['gh', 'api', 'repos/acme/api/invitations', '--paginate']]);
  });
});

describe('accepting invitations someone pasted', () => {
  it('accepts none that names no repository, whose invitation could be for any', async () => {
    world.connected = new Set(['ottoexampleco']);
    const results = await service().accept([{ id: 999, invitee: 'ottoexampleco', repository: '', expired: false }]);

    expect(results[0]?.outcome).toMatchObject({ action: 'none', detail: expect.stringContaining('names no repository') });
    expect(world.sent).toEqual([]);
  });

  it('keeps only rows with a whole positive id, an invitee and a repository', async () => {
    const { acceptable } = await import('./invitation-service.js');
    const rows = acceptable([
      { id: 41, invitee: 'ottoexampleco', repository: 'acme/api', expired: false },
      { id: '41/../../../user', invitee: 'ottoexampleco', repository: 'acme/api' },
      { id: 1.5, invitee: 'ottoexampleco', repository: 'acme/api' },
      { id: -3, invitee: 'ottoexampleco', repository: 'acme/api' },
      { id: 42, invitee: '', repository: 'acme/api' },
      { id: 43, invitee: 'ottoexampleco' },
      null,
      'a string',
    ]);
    expect(rows).toEqual([{ id: 41, invitee: 'ottoexampleco', repository: 'acme/api', expired: false }]);
  });
});

describe('why gh could not list the invitations', () => {
  const failed = (stderr: string, code: unknown = 1) =>
    Object.assign(new Error(`Command failed: gh api repos/acme/auth-service/invitations --paginate\n${stderr}`), { code, stderr });

  it('is read from what gh said, not from the command line that names the repository', async () => {
    const { whyGhFailed } = await import('./invitation-service.js');
    // Each of these repositories read "not signed in" or "not an admin" from its name alone.
    for (const repository of ['acme/auth-service', 'acme/credentials-api', 'acme/admin-panel']) {
      expect(whyGhFailed(failed('gh: Not Found (HTTP 404)'), repository)).toContain('is not an admin of');
      expect(whyGhFailed(failed('something else went wrong\n'), repository)).toBe('something else went wrong');
    }
  });

  it('says not signed in when gh says so, or exits 4', async () => {
    const { whyGhFailed } = await import('./invitation-service.js');
    expect(whyGhFailed(failed('gh: Bad credentials (HTTP 401)'), 'acme/api')).toContain('gh auth login');
    expect(whyGhFailed(failed('', 4), 'acme/api')).toContain('gh auth login');
  });

  it('says gh is not installed when there is no gh', async () => {
    const { whyGhFailed } = await import('./invitation-service.js');
    expect(whyGhFailed(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), 'acme/api')).toContain('not installed');
  });
});

describe('the next page of a list GitHub pages by cursor', () => {
  it('is the path in the rel="next" link, and none on the last page', () => {
    expect(
      nextPagePath(
        '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_9>; rel="next", <https://api.github.com/app/hook/deliveries?per_page=100>; rel="first"',
      ),
    ).toBe('/app/hook/deliveries?per_page=100&cursor=v1_9');
    expect(nextPagePath('<https://api.github.com/app/hook/deliveries?per_page=100>; rel="first"')).toBeNull();
    expect(nextPagePath(null)).toBeNull();
    // Only GitHub's own API: the token is never sent anywhere a header names.
    expect(nextPagePath('<https://elsewhere.example/app/hook/deliveries>; rel="next"')).toBeNull();
  });
});
