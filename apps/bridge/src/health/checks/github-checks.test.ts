import { generateKeyPairSync } from 'node:crypto';
import { DeviceAuthError, GitHubApiError, type AppApi } from '@fleetadlc/github';
import type { Bot } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import type { Unheard } from '../../unheard.js';
import type { WebhookStatus } from '../../webhook-setup.js';
import { appChecks, type AppReader } from './app.js';
import { crewChecks, type RepoRef, type SigningReader } from './crew.js';
import { hostCheck } from './host.js';
import { webhookCheck } from './webhook.js';

/**
 * Each check, pass and fail, against a GitHub that is a fake: what it proves is
 * proved by what GitHub answers, and what it says when it fails is the thing a
 * person has to do and where.
 */

const NOW = new Date('2026-09-25T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('OpenADLC’s host service', () => {
  it('passes while hostd answers, and asks for `fleetadlc up` when it does not', async () => {
    expect(await hostCheck({ health: async () => ({ ok: true }) }).run(NOW)).toEqual([
      { ok: true, fixed: 'OpenADLC’s host service is answering again' },
    ]);
    const [down] = await hostCheck({ health: async () => ({ ok: false }) }).run(NOW);
    expect(down).toMatchObject({ ok: false, severity: 'blocking', action: { label: 'Run fleetadlc up', command: 'fleetadlc up' } });
  });
});

// ------------------------------------------------------------------ webhook

function unheard(partial: Partial<Unheard> = {}): Unheard {
  return {
    subject: 'fleetadlc-testbed#1',
    what: 'imported',
    title: 'Document the webhook step',
    url: 'https://github.com/janedoe/fleetadlc-testbed/issues/1',
    happenedAt: minutesAgo(40),
    foundAt: minutesAgo(30),
    ...partial,
  };
}

function webhookStatus(partial: Partial<WebhookStatus> = {}): WebhookStatus {
  return {
    ready: false,
    configured: true,
    hearing: 'never',
    unheard: [],
    settingsUrl: 'https://github.com/settings/apps/fleetadlc-janedoe',
    placeholderHook: false,
    publicUrl: 'https://fleetadlc.example.com',
    webhookUrl: 'https://fleetadlc.example.com/webhooks/github',
    secretStored: true,
    tunnel: { running: false } as never,
    github: { url: 'https://fleetadlc.example.com/webhooks/github', secretSet: true },
    lastDelivery: null,
    stale: false,
    resuming: false,
    canAutomate: true,
    tunnelAvailable: false,
    detail: '',
    ...partial,
  };
}

const webhookAnswer = async (status: WebhookStatus, lastHeard: string | null = null) =>
  (await webhookCheck({ status: async () => status, lastHeard: async () => lastHeard }).run(NOW))[0];

describe('GitHub delivering to the bridge', () => {
  it('fails when GitHub lists nothing and something happened it would have sent, with the app’s settings as the fix', async () => {
    const answer = await webhookAnswer(webhookStatus({ hearing: 'silent', unheard: [unheard()] }));

    expect(answer).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'GitHub is not sending events to OpenADLC',
      action: { label: 'Open the app’s settings', url: 'https://github.com/settings/apps/fleetadlc-janedoe' },
      facts: { subject: { repo: 'fleetadlc-testbed', number: 1, title: 'Document the webhook step', ref: 'fleetadlc-testbed#1' } },
    });
    expect(answer && 'detail' in answer ? answer.detail : '').toContain('turn on **Active** under Webhook');
  });

  it('passes once the bridge has taken a delivery since what it missed', async () => {
    const answer = await webhookAnswer(webhookStatus({ hearing: 'silent', unheard: [unheard()] }), minutesAgo(5));
    expect(answer).toEqual({ ok: true, fixed: 'GitHub is delivering again' });
  });

  it('passes while GitHub lists a delivery from after what happened', async () => {
    const answer = await webhookAnswer(
      webhookStatus({
        hearing: 'heard',
        unheard: [unheard()],
        lastDelivery: { event: 'issues', action: 'opened', statusCode: 202, deliveredAt: minutesAgo(38), redelivery: false },
      }),
    );
    expect(answer).toMatchObject({ ok: true });
  });

  it('fails when a switch was turned off after GitHub last delivered: what happened since never arrived', async () => {
    const answer = await webhookAnswer(
      webhookStatus({
        hearing: 'heard',
        unheard: [unheard({ happenedAt: minutesAgo(40) })],
        lastDelivery: { event: 'issues', action: 'opened', statusCode: 202, deliveredAt: minutesAgo(2 * 24 * 60), redelivery: false },
      }),
      minutesAgo(2 * 24 * 60),
    );
    expect(answer).toMatchObject({ ok: false, title: 'GitHub is not sending events to OpenADLC' });
  });

  it('says nothing either way before anything has happened that GitHub would send', async () => {
    expect(await webhookAnswer(webhookStatus({ hearing: 'never' }))).toMatchObject({ ok: null });
    expect(await webhookAnswer(webhookStatus({ hearing: 'unknown' }))).toMatchObject({ ok: null });
  });

  it('says nothing either way while the bridge is bringing its tunnel back at start', async () => {
    // What it reads then is the last run's tunnel: a card raised on that was
    // gone again a few seconds later, at every restart.
    expect(await webhookAnswer(webhookStatus({ resuming: true, hearing: 'silent', unheard: [unheard()] }))).toMatchObject({
      ok: null,
      reason: 'the bridge is bringing its tunnel back',
    });
  });

  it('sends a person to the webhook step for what OpenADLC can set itself', async () => {
    expect(await webhookAnswer(webhookStatus({ stale: true }))).toMatchObject({
      ok: false,
      title: 'GitHub is delivering to a tunnel that has stopped',
      action: { href: '/onboarding?step=webhook' },
    });
    expect(
      await webhookAnswer(
        webhookStatus({ configured: false, github: { url: 'https://old.example.com/webhooks/github', secretSet: true }, detail: 'GitHub is pointed at https://old.example.com/webhooks/github, not at this bridge' }),
      ),
    ).toMatchObject({ ok: false, title: 'GitHub delivers somewhere other than this bridge', action: { href: '/onboarding?step=webhook' } });
    expect(
      await webhookAnswer(
        webhookStatus({
          hearing: 'heard',
          lastDelivery: { event: 'ping', action: null, statusCode: 401, deliveredAt: minutesAgo(3), redelivery: false },
        }),
      ),
    ).toMatchObject({ ok: false, title: 'OpenADLC refuses what GitHub delivers' });
  });

  it('is the walkthrough’s to say while nothing is set up', async () => {
    const checked = await webhookCheck({
      status: async () => webhookStatus({ canAutomate: false, publicUrl: '' }),
      lastHeard: async () => null,
    }).run(NOW);
    expect(checked).toEqual([]);
  });
});

// ------------------------------------------------------------------ the app

const FULL_PERMISSIONS = {
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'write',
  checks: 'write',
  workflows: 'write',
  administration: 'write',
  actions: 'write',
  deployments: 'read',
  metadata: 'read',
  members: 'read',
  git_signing_ssh_public_keys: 'write',
};

const ALL_EVENTS = ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'workflow_run', 'deployment_status'];

function appReader(options: {
  permissions?: Record<string, string>;
  events?: string[];
  installation?: { permissions: Record<string, string> } | 'missing';
  deviceCode?: () => Promise<unknown>;
  kinds?: { who: string; kind: 'refresh' | 'static' }[];
  key?: boolean;
  unanswered?: '/app' | 'installation';
}): AppReader {
  const api: AppApi = {
    async request<T>(_method: string, path: string): Promise<T> {
      if (options.unanswered === '/app' && path === '/app') throw new Error('/app → 502: Bad Gateway');
      if (options.unanswered === 'installation' && path.endsWith('/installation')) throw new Error('fetch failed');
      if (path === '/app') {
        return {
          slug: 'fleetadlc-janedoe',
          id: 7,
          owner: { login: 'janedoe', type: 'User' },
          permissions: options.permissions ?? FULL_PERMISSIONS,
          events: options.events ?? ALL_EVENTS,
        } as T;
      }
      if (path.endsWith('/installation')) {
        if (options.installation === 'missing') throw new Error(`${path} → 404: {"message":"Not Found"}`);
        return { id: 42, account: { login: 'janedoe', type: 'User' }, permissions: options.installation?.permissions ?? FULL_PERMISSIONS } as T;
      }
      throw new Error(`${path} → 404: not faked`);
    },
  };
  return {
    clientId: async () => 'Iv23client',
    credentials: async () => (options.key === false ? null : { clientId: 'Iv23client', privateKey: PRIVATE_KEY }),
    api,
    repositories: async () => [{ name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }],
    requestDeviceCode: options.deviceCode ?? (async () => ({})),
    tokenKinds: async () => options.kinds ?? [{ who: 'fleetadlc-atlas-janedoe', kind: 'refresh' }],
  };
}

describe('the app’s permissions, compared with what this OpenADLC asks for', () => {
  it('names a missing one as the app’s page does, under its heading, with the permissions page to add it on', async () => {
    const { git_signing_ssh_public_keys: _left, ...older } = FULL_PERMISSIONS;
    const results = await appChecks(appReader({ permissions: older })).permissions.run(NOW);

    const missing = results.find((result) => result.subject === 'git_signing_ssh_public_keys');
    expect(missing).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'The OpenADLC app does not have “SSH signing keys”',
      action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
    });
    const detail = missing && 'detail' in missing ? missing.detail : '';
    expect(detail).toContain('under Account permissions, as Read and write');
    expect(detail).toContain('reconnect each bot that commits');
    // Every other one is there, and says so.
    expect(results.filter((result) => result.ok === true).map((result) => result.subject)).toContain('contents');
  });

  it('says a missing permission that only disables one thing without holding the app up', async () => {
    // Without "Actions: write" a failed CI is not run again, and nothing else stops.
    const results = await appChecks(appReader({ permissions: { ...FULL_PERMISSIONS, actions: 'read' } })).permissions.run(NOW);
    expect(results.find((result) => result.subject === 'actions')).toMatchObject({ ok: false, severity: 'warning' });
    const contents = await appChecks(appReader({ permissions: { ...FULL_PERMISSIONS, contents: 'read' } })).permissions.run(NOW);
    expect(contents.find((result) => result.subject === 'contents')).toMatchObject({ ok: false, severity: 'blocking' });
  });

  it('counts write as covering read, and a lower level as missing', async () => {
    const results = await appChecks(appReader({ permissions: { ...FULL_PERMISSIONS, members: 'write', contents: 'read' } })).permissions.run(NOW);
    expect(results.filter((result) => result.ok === false).map((result) => result.subject)).toEqual(['contents']);
  });

  it('asks the installation to accept what the app holds and the installation does not yet', async () => {
    const { administration: _left, ...accepted } = FULL_PERMISSIONS;
    const results = await appChecks(appReader({ installation: { permissions: accepted } })).permissions.run(NOW);
    expect(results.find((result) => result.subject === 'accept:42')).toMatchObject({
      ok: false,
      title: 'The OpenADLC app’s new permissions are waiting to be accepted on janedoe',
      action: { label: 'Review the request', url: 'https://github.com/settings/installations/42' },
    });
  });

  it('tells an app made before this OpenADLC asked for deployments what to tick, and where', async () => {
    // Created from the old manifest: no Deployments permission, and so no
    // deployment_status event. Nothing was ever labelled deployed:testing.
    const { deployments: _left, ...older } = FULL_PERMISSIONS;
    const results = await appChecks(
      appReader({ permissions: older, events: ALL_EVENTS.filter((event) => event !== 'deployment_status') }),
    ).permissions.run(NOW);

    expect(results.find((result) => result.subject === 'deployments')).toMatchObject({
      ok: false,
      title: 'The OpenADLC app does not have “Deployments”',
    });
    const event = results.find((result) => result.subject === 'event:deployment_status');
    expect(event).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'The OpenADLC app is not subscribed to “Deployment status”',
      action: { label: 'Open the app’s permissions and events', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
    });
    const detail = event && 'detail' in event ? event.detail : '';
    expect(detail).toContain('under Subscribe to events, tick “Deployment status” and save');
    expect(detail).toContain('“Deployments” as Read-only, under Repository permissions');
    // The ones it has, it says so.
    expect(results.find((result) => result.subject === 'event:issues')).toMatchObject({ ok: true });
  });

  it('passes an app subscribed to every event the bridge acts on', async () => {
    const results = await appChecks(appReader({})).permissions.run(NOW);
    expect(results.filter((result) => (result.subject ?? '').startsWith('event:') && result.ok !== true)).toEqual([]);
  });

  it('can say whether the app lacks one, for the checks that wait on it', async () => {
    const { git_signing_ssh_public_keys: _left, ...older } = FULL_PERMISSIONS;
    expect(await appChecks(appReader({ permissions: older })).lacks('git_signing_ssh_public_keys')).toBe(true);
    expect(await appChecks(appReader({})).lacks('git_signing_ssh_public_keys')).toBe(false);
  });
});

describe('the app’s permissions when GitHub does not answer', () => {
  it('cannot run, so every row stands as it was, an accept card included', async () => {
    await expect(appChecks(appReader({ unanswered: '/app' })).permissions.run(NOW)).rejects.toThrow('GitHub did not describe the app');
    await expect(appChecks(appReader({ unanswered: 'installation' })).permissions.run(NOW)).rejects.toThrow('fetch failed');
  });
});

describe('where the app is installed', () => {
  it('passes for a repository the app is installed on, and offers the install page for one it is not', async () => {
    expect(await appChecks(appReader({})).installed.run(NOW)).toMatchObject([{ subject: 'fleetadlc-testbed', ok: true }]);
    expect(await appChecks(appReader({ installation: 'missing' })).installed.run(NOW)).toMatchObject([
      {
        subject: 'fleetadlc-testbed',
        ok: false,
        title: 'The OpenADLC app is not installed on janedoe/fleetadlc-testbed',
        action: { label: 'Install the app', url: 'https://github.com/apps/fleetadlc-janedoe/installations/new' },
      },
    ]);
  });

  it('sends a person to the Install the app step when GitHub did not say which app it is', async () => {
    const reader = appReader({ installation: 'missing' });
    const api: AppApi = {
      request: async <T>(method: string, path: string, token: string, body?: unknown): Promise<T> => {
        if (path === '/app') throw new Error('/app → 502: Bad Gateway');
        return reader.api.request<T>(method, path, token, body);
      },
    };
    expect(await appChecks({ ...reader, api }).installed.run(NOW)).toMatchObject([
      {
        ok: false,
        title: 'The OpenADLC app is not installed on janedoe/fleetadlc-testbed',
        // Creating the app and installing it are two steps; `?step=app` only creates it.
        action: { label: 'Open the “Install the app” step', href: '/onboarding?step=install' },
      },
    ]);
  });

  it('has no answer without the app’s key, rather than a wrong one', async () => {
    expect(await appChecks(appReader({ key: false })).installed.run(NOW)).toMatchObject([{ ok: null }]);
  });

  /** The reader of an install whose app is private to janedoe and that works in exampleco/infra. */
  const onAnotherAccount = (reach: AppReader['reach']): AppReader => ({
    ...appReader({}),
    repositories: async () => [{ name: 'infra', fullName: 'exampleco/infra' }],
    reach,
  });

  it('says to make a private app public for another account, not to install what GitHub will not offer', async () => {
    const reader = onAnotherAccount(async (repository) => ({
      state: 'blocked',
      repository,
      account: 'exampleco',
      need: 'make-public',
      title: 'The OpenADLC app is private to janedoe',
      detail: 'GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
      action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
      steps: [],
    }));

    const [row] = await appChecks(reader).installed.run(NOW);

    expect(row).toMatchObject({
      subject: 'infra',
      ok: false,
      severity: 'blocking',
      title: 'The OpenADLC app is private, so it cannot be installed on exampleco/infra',
      action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
      facts: { need: 'make-public', subject: { repo: 'infra' } },
    });
    expect(row && 'detail' in row ? row.detail : '').toMatch(/^The OpenADLC app is private to janedoe\. GitHub installs a private app/);
  });

  it('passes once the app reaches the repository, and has no answer when GitHub could not say', async () => {
    const reached = onAnotherAccount(async (repository) => ({ state: 'reachable', repository, account: 'exampleco', installationId: 8 }));
    expect(await appChecks(reached).installed.run(NOW)).toMatchObject([{ subject: 'infra', ok: true, facts: { installationId: 8 } }]);

    const unknown = onAnotherAccount(async (repository) => ({ state: 'unknown', repository, reason: 'GitHub did not say' }));
    expect(await appChecks(unknown).installed.run(NOW)).toMatchObject([{ subject: 'infra', ok: null, reason: 'GitHub did not say' }]);
  });
});

describe('device flow and expiring tokens', () => {
  it('fails when GitHub refuses a device code because Device Flow is off', async () => {
    const off = appReader({
      deviceCode: async () => {
        throw new DeviceAuthError('device_flow_disabled', 'Device Flow must be explicitly enabled for this App');
      },
    });
    expect(await appChecks(off).deviceFlow.run(NOW)).toMatchObject([
      { ok: false, title: 'Device Flow is off in the OpenADLC app', action: { url: 'https://github.com/settings/apps/fleetadlc-janedoe' } },
    ]);
  });

  it('does not call a network failure a switch that is off', async () => {
    const down = appReader({
      deviceCode: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(await appChecks(down).deviceFlow.run(NOW)).toMatchObject([{ ok: null }]);
  });

  it('warns when every sign-in GitHub issued came without a refresh token', async () => {
    const seat = (who: string, kind: 'refresh' | 'static') => ({ who, kind });
    expect(await appChecks(appReader({ kinds: [seat('builder', 'static'), seat('intake', 'static')] })).tokenExpiry.run(NOW)).toMatchObject([
      { ok: false, severity: 'warning', title: 'The OpenADLC app’s user tokens never expire' },
    ]);
    expect(await appChecks(appReader({ kinds: [seat('builder', 'refresh'), seat('lead-reviewer', 'refresh')] })).tokenExpiry.run(NOW)).toMatchObject([
      { ok: true },
      { subject: 'held', ok: true },
    ]);
    expect(await appChecks(appReader({ kinds: [] })).tokenExpiry.run(NOW)).toEqual([]);
  });

  it('passes the app once one sign-in rotates, and names every seat and account still holding one that never expires', async () => {
    const held = [
      { who: 'builder', kind: 'refresh' as const },
      { who: 'intake', kind: 'static' as const },
      { who: 'spare-account', kind: 'static' as const },
    ];
    const [app, lasting] = await appChecks(appReader({ kinds: held })).tokenExpiry.run(NOW);
    expect(app).toEqual({ ok: true, fixed: 'The OpenADLC app issues user tokens that expire now' });
    expect(lasting).toMatchObject({ subject: 'held', ok: false, severity: 'warning', title: '2 sign-ins OpenADLC holds never expire', facts: { lasting: ['intake', 'spare-account'] } });
  });
});

// ------------------------------------------------------------------ the crew

function bot(partial: Partial<Bot> & Pick<Bot, 'id' | 'name' | 'role'>): Bot {
  return {
    slot: partial.name,
    displayName: partial.name,
    engine: 'claude',
    model: 'newest:opus',
    githubLogin: partial.name,
    hostId: null,
    container: `bot-${partial.name}`,
    status: 'running',
    skills: [],
    sidecarDb: false,
    modelAccountId: null,
    modelSetAt: null,
    ...partial,
  };
}

const BUILDER = bot({ id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement' });
const REVIEWER = bot({ id: 'bot-lead', name: 'noraexampleco', slot: 'lead-reviewer', role: 'review_lead' });
const UNCONNECTED = bot({ id: 'bot-sre', name: 'sre', slot: 'sre', role: 'deploy', githubLogin: null });

interface Calls {
  method: string;
  path: string;
  body?: unknown;
}

function crewReader(options: {
  crew?: Bot[];
  refused?: string[];
  user?: (login: string) => Promise<unknown>;
  repo?: (login: string) => Promise<unknown>;
  listed?: { id: number; key: string }[];
  upload?: () => Promise<unknown>;
  stored?: string | null;
  requires?: boolean | null;
  lacksPermission?: boolean;
  calls?: Calls[];
  repositories?: RepoRef[];
  githubUserId?: number | null;
}): SigningReader {
  const calls = options.calls ?? [];
  return {
    crew: async () => options.crew ?? [BUILDER, REVIEWER],
    repositories: async () => options.repositories ?? [{ name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'main' }],
    credential: async (one) => (one.githubLogin ? { kind: 'refresh', status: 'active' } : { kind: null, status: null }),
    token: async (one) => {
      if (options.refused?.includes(one.name)) {
        throw new Error(`${one.name}'s GitHub authorization is no longer valid (The refresh token passed is incorrect or expired.)`);
      }
      return `token-${one.name}`;
    },
    githubUserId: async () => options.githubUserId ?? null,
    github: (_token, login) => ({
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ method, path, body });
        if (path === '/user') return ((await options.user?.(login)) ?? { login }) as T;
        if (path.startsWith('/repos/')) return ((await options.repo?.(login)) ?? { permissions: { push: true }, owner: { type: 'User' } }) as T;
        if (path.endsWith('/ssh_signing_keys') && method === 'GET') return (options.listed ?? []) as T;
        if (path === '/user/ssh_signing_keys' && method === 'POST') return ((await options.upload?.()) ?? { id: 91 }) as T;
        throw new GitHubApiError(404, path, 'not faked');
      },
    }),
    signingKey: async () => (options.stored === undefined ? 'PRIVATE KEY' : options.stored),
    publicKeyOf: () => 'ssh-ed25519 AAAAC3Nza-builder fleetadlc-fleetadlc-atlas-janedoe',
    requiresSignatures: async () => (options.requires === undefined ? true : options.requires),
    appLacksSigningPermission: async () => options.lacksPermission ?? false,
    recordKeyId: async () => undefined,
  };
}

describe('each bot’s sign-in', () => {
  it('passes when GitHub says who the bot is, and asks to reconnect one whose sign-in it refuses', async () => {
    const results = await crewChecks(crewReader({ refused: ['noraexampleco'] })).signIn.run(NOW);
    expect(results).toMatchObject([
      { subject: 'bot-builder', ok: true },
      {
        subject: 'bot-lead',
        ok: false,
        severity: 'blocking',
        title: 'The lead reviewer (noraexampleco) cannot sign in to GitHub',
        action: { label: 'Reconnect the lead reviewer (noraexampleco)', href: '/settings#github-accounts' },
        facts: { botId: 'bot-lead', refused: true },
      },
    ]);
  });

  it('asks to connect a bot that has no account yet, by its role', async () => {
    const [result] = await crewChecks(crewReader({ crew: [UNCONNECTED] })).signIn.run(NOW);
    expect(result).toMatchObject({ ok: false, title: 'The SRE has no GitHub account connected', action: { label: 'Connect the SRE' } });
    // A role that is not a noun on its own gets one: not "Connect the intake".
    const [intake] = await crewChecks(crewReader({ crew: [{ ...UNCONNECTED, name: 'intake', slot: 'intake', role: 'intake' }] })).signIn.run(NOW);
    expect(intake).toMatchObject({ action: { label: 'Connect the intake bot' } });
  });

  it('asks to reconnect a bot whose sign-in is another account’s, naming both, and passes whatever the case', async () => {
    const [other] = await crewChecks(crewReader({ crew: [REVIEWER], user: async () => ({ login: 'fleetadlc-lead-reviewer' }) })).signIn.run(NOW);
    expect(other).toMatchObject({
      subject: 'bot-lead',
      ok: false,
      severity: 'blocking',
      title: 'The lead reviewer (noraexampleco) signs in to GitHub as fleetadlc-lead-reviewer, not noraexampleco',
      detail: expect.stringContaining('in a browser signed in as noraexampleco'),
      action: { label: 'Reconnect the lead reviewer (noraexampleco)', href: '/settings#github-accounts' },
    });

    const [same] = await crewChecks(crewReader({ crew: [REVIEWER], user: async () => ({ login: 'NoraExampleCo' }) })).signIn.run(NOW);
    expect(same).toMatchObject({ ok: true });
  });

  it('fails a builder whose sign-in is the lead reviewer’s account, with or without a recorded id', async () => {
    for (const githubUserId of [null, 7]) {
      const [result] = await crewChecks(
        crewReader({ crew: [BUILDER], githubUserId, user: async () => ({ login: 'lead-reviewer-acct', id: 8 }) }),
      ).signIn.run(NOW);
      expect(result).toMatchObject({
        ok: false,
        severity: 'blocking',
        title: 'The builder (fleetadlc-atlas-janedoe) signs in to GitHub as lead-reviewer-acct, not fleetadlc-atlas-janedoe',
        action: { label: 'Reconnect the builder (fleetadlc-atlas-janedoe)' },
      });
    }
  });

  it('says a bot’s account was renamed when GitHub gives the recorded id under a new login', async () => {
    const [result] = await crewChecks(
      crewReader({ crew: [BUILDER], githubUserId: 7, user: async () => ({ login: 'atlas-renamed', id: 7 }) }),
    ).signIn.run(NOW);
    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'The builder (fleetadlc-atlas-janedoe) has been renamed on GitHub to atlas-renamed',
      detail: expect.stringContaining('records as fleetadlc-atlas-janedoe is called atlas-renamed on GitHub now'),
      action: { label: 'Reconnect the builder (fleetadlc-atlas-janedoe)' },
      facts: { renamedTo: 'atlas-renamed' },
    });
  });

  it('has no answer when GitHub does not answer', async () => {
    const [result] = await crewChecks(
      crewReader({
        crew: [BUILDER],
        user: async () => {
          throw new Error('fetch failed');
        },
      }),
    ).signIn.run(NOW);
    expect(result).toMatchObject({ ok: null });
  });
});

describe('each bot in each repository', () => {
  it('passes with the access its role needs, and sends a person to let it in when it is not there', async () => {
    const results = await crewChecks(
      crewReader({
        repo: async (login) => {
          if (login === 'noraexampleco') throw new GitHubApiError(404, '/repos/janedoe/fleetadlc-testbed', 'Not Found');
          return { permissions: { push: true }, owner: { type: 'User' } };
        },
      }),
    ).access.run(NOW);
    expect(results).toMatchObject([
      { subject: 'bot-builder:fleetadlc-testbed', ok: true },
      {
        subject: 'bot-lead:fleetadlc-testbed',
        ok: false,
        title: 'The lead reviewer (noraexampleco) is not in janedoe/fleetadlc-testbed yet',
        action: { label: 'Let the crew in', href: '/onboarding?step=access' },
      },
    ]);
  });

  it('asks about several repositories at once, not one by one, and answers in order', async () => {
    let running = 0;
    let most = 0;
    const repositories = Array.from({ length: 20 }, (_, index) => ({ name: `repo-${index}`, fullName: `janedoe/repo-${index}`, defaultBranch: 'main' }));
    const results = await crewChecks(
      crewReader({
        repositories,
        repo: async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
          return { permissions: { push: true }, owner: { type: 'User' } };
        },
      }),
    ).access.run(NOW);
    expect(results).toHaveLength(40);
    expect(results.slice(0, 2).map((result) => result.subject)).toEqual(['bot-builder:repo-0', 'bot-builder:repo-1']);
    expect(results[20]?.subject).toBe('bot-lead:repo-0');
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
  });

  it('has no answer for a bot whose sign-in cannot be read, so its rows stand, and nothing for one never connected', async () => {
    const reader = crewReader({ crew: [BUILDER, UNCONNECTED] });
    reader.credential = async () => ({ kind: null, status: null });
    const results = await crewChecks(reader).access.run(NOW);
    expect(results).toEqual([{ subject: 'bot-builder:fleetadlc-testbed', ok: null, reason: 'it holds no working sign-in to ask with' }]);
  });

  it('has no answer while GitHub is rate limiting the bot’s account, rather than saying it is not in', async () => {
    for (const body of ['{"message":"API rate limit exceeded for user ID 7."}', '{"message":"You have exceeded a secondary rate limit."}']) {
      const [result] = await crewChecks(
        crewReader({
          crew: [BUILDER],
          repo: async () => {
            throw new GitHubApiError(403, '/repos/janedoe/fleetadlc-testbed', body);
          },
        }),
      ).access.run(NOW);
      expect(result).toMatchObject({ ok: null, reason: expect.stringContaining('GitHub is rate limiting fleetadlc-atlas-janedoe') });
    }
  });

  it('says an organization’s SSO or IP allow list is what refuses the bot, and what to do', async () => {
    const refusing = (body: string) =>
      crewChecks(
        crewReader({
          crew: [BUILDER],
          repo: async () => {
            throw new GitHubApiError(403, '/repos/janedoe/fleetadlc-testbed', body);
          },
        }),
      ).access.run(NOW);

    const [sso] = await refusing('{"message":"Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization."}');
    expect(sso).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'The builder (fleetadlc-atlas-janedoe) is not signed in to janedoe’s single sign-on',
      detail: expect.stringContaining('authorize it on janedoe’s single sign-on page'),
      action: { url: 'https://github.com/orgs/janedoe/sso' },
    });

    const [allowList] = await refusing('{"message":"The janedoe organization has an IP allow list enabled, and your IP address is not permitted."}');
    expect(allowList).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'janedoe’s IP allow list refuses the builder (fleetadlc-atlas-janedoe)',
      detail: expect.stringContaining('Add the address OpenADLC runs from'),
    });

    for (const result of [sso, allowList]) {
      expect(result && 'detail' in result ? result.detail : '').not.toContain('invitation');
    }
  });

  it('quotes GitHub for any other 403, without saying the invitation was not accepted', async () => {
    const [result] = await crewChecks(
      crewReader({
        crew: [BUILDER],
        repo: async () => {
          throw new GitHubApiError(403, '/repos/janedoe/fleetadlc-testbed', 'Resource not accessible by integration');
        },
      }),
    ).access.run(NOW);
    expect(result).toMatchObject({
      ok: false,
      title: 'GitHub refused the builder (fleetadlc-atlas-janedoe) in janedoe/fleetadlc-testbed',
      detail: expect.stringContaining('Resource not accessible by integration'),
    });
    expect(result && 'detail' in result ? result.detail : '').not.toContain('invitation');
  });

  it('fails a bot that is in with less than its role needs', async () => {
    const [result] = await crewChecks(
      crewReader({ crew: [BUILDER], repo: async () => ({ permissions: { pull: true, push: false }, owner: { type: 'User' } }) }),
    ).access.run(NOW);
    expect(result).toMatchObject({ ok: false, title: 'The builder (fleetadlc-atlas-janedoe) cannot push to janedoe/fleetadlc-testbed' });
  });

  it.each(['admin', 'maintain'])('fails, blocking, a bot whose account has %s: it can change the rules that keep a bot from merging', async (role) => {
    const [result] = await crewChecks(
      crewReader({
        crew: [BUILDER],
        repo: async () => ({ permissions: { admin: role === 'admin', maintain: true, push: true, triage: true, pull: true }, owner: { type: 'User' } }),
      }),
    ).access.run(NOW);
    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: `The builder (fleetadlc-atlas-janedoe) has ${role} on janedoe/fleetadlc-testbed`,
      detail: expect.stringContaining('rulesets and branch protection'),
      action: { url: 'https://github.com/janedoe/fleetadlc-testbed/settings/access' },
    });
  });

  it('passes a bot with exactly write, or intake with triage in an organization', async () => {
    const intake = bot({ id: 'bot-intake', name: 'intake-janedoe', slot: 'intake', role: 'intake' });
    const results = await crewChecks(
      crewReader({
        crew: [BUILDER, intake],
        repo: async (login) =>
          login === 'intake-janedoe'
            ? { permissions: { triage: true, pull: true }, owner: { type: 'Organization' } }
            : { permissions: { push: true, triage: true, pull: true }, owner: { type: 'Organization' } },
      }),
    ).access.run(NOW);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
  });
});

describe('each committing bot’s signing key', () => {
  it('passes when the account lists the stored key, whatever its comment, and asks nobody to do anything', async () => {
    const calls: Calls[] = [];
    const results = await crewChecks(
      crewReader({ listed: [{ id: 5, key: 'ssh-ed25519 AAAAC3Nza-builder some-other-comment' }], calls }),
    ).signingKey.run(NOW);

    // Only the builder commits; a reviewer's key proves nothing.
    expect(results).toMatchObject([{ subject: 'bot-builder', ok: true, facts: { registered: true, keyId: 5 } }]);
    expect(calls.find((call) => call.method === 'GET')?.path).toBe('/users/fleetadlc-atlas-janedoe/ssh_signing_keys');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('warns of a key on the account that no seat holds, which verifies for it whichever session signed', async () => {
    // A session's token carries the app's "SSH signing keys" permission, so a
    // key can be added to the account from a session, and it reads Verified.
    const results = await crewChecks(
      crewReader({
        listed: [
          { id: 5, key: 'ssh-ed25519 AAAAC3Nza-builder fleetadlc-fleetadlc-atlas-janedoe' },
          { id: 6, key: 'ssh-ed25519 AAAAC3Nza-somebody-else' },
        ],
      }),
    ).signingKey.run(NOW);
    expect(results).toMatchObject([
      { subject: 'bot-builder', ok: true },
      {
        subject: 'account:fleetadlc-atlas-janedoe',
        ok: false,
        severity: 'warning',
        title: 'fleetadlc-atlas-janedoe has a signing key OpenADLC did not register',
        facts: { keyIds: [6] },
      },
    ]);
  });

  it('says nothing of other keys on an account while a seat’s own key could not be read', async () => {
    const results = await crewChecks(crewReader({ stored: null, listed: [{ id: 6, key: 'ssh-ed25519 AAAAC3Nza-somebody-else' }] })).signingKey.run(NOW);
    expect(results.some((result) => result.subject === 'account:fleetadlc-atlas-janedoe')).toBe(false);
  });

  it('registers a key the account lacks itself when the bot’s sign-in can, and says so once', async () => {
    const results = await crewChecks(crewReader({ listed: [] })).signingKey.run(NOW);
    expect(results).toMatchObject([
      { subject: 'bot-builder', ok: true, note: 'Registered the signing key of the builder (fleetadlc-atlas-janedoe) on its GitHub account' },
    ]);
  });

  it('asks to reconnect the bot when GitHub refuses the key, blocking when the repository requires signed commits', async () => {
    const refused = crewReader({
      listed: [],
      upload: async () => {
        throw new GitHubApiError(403, '/user/ssh_signing_keys', 'Resource not accessible by integration');
      },
    });
    const [result] = await crewChecks(refused).signingKey.run(NOW);
    expect(result).toMatchObject({
      subject: 'bot-builder',
      ok: false,
      severity: 'blocking',
      title: 'The builder (fleetadlc-atlas-janedoe) has no signing key on its GitHub account',
      action: { label: 'Reconnect the builder (fleetadlc-atlas-janedoe)', href: '/settings#github-accounts' },
      waitingFor: [],
      facts: { botId: 'bot-builder', registered: false, requiresSignatures: { 'fleetadlc-testbed': true } },
    });
    expect(result && 'detail' in result ? result.detail : '').toContain('Reconnect the builder (fleetadlc-atlas-janedoe) so GitHub learns its signing key');
  });

  it('says GitHub was rate limiting when that is why it could not register the key', async () => {
    const [result] = await crewChecks(
      crewReader({
        listed: [],
        upload: async () => {
          throw new GitHubApiError(403, '/user/ssh_signing_keys', '{"message":"API rate limit exceeded for user ID 7."}');
        },
      }),
    ).signingKey.run(NOW);
    const detail = result && 'detail' in result ? result.detail : '';
    expect(detail).toContain('GitHub was rate limiting its account');
    expect(detail).not.toContain('its sign-in was made before the app could register one');
  });

  it('is only a warning where nothing requires signed commits', async () => {
    const [result] = await crewChecks(
      crewReader({
        listed: [],
        requires: false,
        upload: async () => {
          throw new GitHubApiError(403, '/user/ssh_signing_keys', 'Resource not accessible by integration');
        },
      }),
    ).signingKey.run(NOW);
    expect(result).toMatchObject({ ok: false, severity: 'warning' });
  });

  it('waits for the app’s permission when the app does not have it yet', async () => {
    const [result] = await crewChecks(
      crewReader({
        listed: [],
        lacksPermission: true,
        upload: async () => {
          throw new GitHubApiError(403, '/user/ssh_signing_keys', 'Resource not accessible by integration');
        },
      }),
    ).signingKey.run(NOW);
    expect(result).toMatchObject({ ok: false, waitingFor: ['app-permissions:git_signing_ssh_public_keys'] });
    expect(result && 'detail' in result ? result.detail : '').toContain('The OpenADLC app needs “SSH signing keys” first');
  });

  it('asks to reconnect a bot that has no key at all', async () => {
    const [result] = await crewChecks(crewReader({ stored: null })).signingKey.run(NOW);
    expect(result).toMatchObject({ ok: false, title: 'The builder (fleetadlc-atlas-janedoe) has no signing key on its GitHub account' });
  });

  it('says the secret store failed, and sends nobody to reconnect, when the key cannot be read or kept', async () => {
    const reader = { ...crewReader({}), signingKey: async () => Promise.reject(new Error('the secret store is locked')) };
    const [result] = await crewChecks(reader).signingKey.run(NOW);
    expect(result).toMatchObject({
      ok: null,
      reason: 'its signing key could not be read from or written to the secret store: the secret store is locked',
    });
  });
});
