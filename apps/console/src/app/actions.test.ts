import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_NOT_ANSWERING } from '@/lib/reach';
import {
  answerGate,
  killSession,
  pauseWork,
  releasePromote,
  removeRepository,
  repositoryRemoval,
  restartTaskFresh,
  requestAttachToken,
  restartBot,
  resumeWork,
  retryTriage,
  abandonRequest,
  revertDesignMemory,
  sendMessage,
  setCrewColor,
  stopTasks,
  switchToAutomatic,
  updateRepoSettings,
} from './actions';

// A server action reads the incoming request's headers and revalidates a path;
// neither exists outside a request, and neither is what is under test.
vi.mock('@/lib/identity', () => ({ identityHeaders: async () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asking for a terminal when the bridge does not answer', () => {
  it('says the bridge is not answering, instead of `fetch failed`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const grant = await requestAttachToken('builder', 'shell');
    expect(grant.ok).toBe(false);
    expect(grant.error).toBe(BRIDGE_NOT_ANSWERING);
  });

  it('still shows the bridge’s own words when it answers with a refusal', async () => {
    // hostd's half of the same failure arrives this way, already worded.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'hostd is not answering' }), { status: 502 })),
    );
    const grant = await requestAttachToken('builder', 'shell');
    expect(grant.error).toBe('hostd is not answering');
  });
});

describe('where take-over connects', () => {
  it('returns the gateway address the console runs with, set after it was loaded', async () => {
    // A cloud console is built without the variable and started with it: read
    // when the token is minted, not inlined when the module was built.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ token: 't', expiresInSeconds: 60 })));
    vi.stubEnv('NEXT_PUBLIC_FLEETADLC_TERMINAL_URL', '');
    expect(await requestAttachToken('builder', 'shell')).toEqual({ ok: true, token: 't', expiresInSeconds: 60 });

    vi.stubEnv('NEXT_PUBLIC_FLEETADLC_TERMINAL_URL', 'wss://console.example.com');
    expect(await requestAttachToken('builder', 'shell')).toEqual({ ok: true, token: 't', expiresInSeconds: 60, url: 'wss://console.example.com' });
    vi.unstubAllEnvs();
  });
});

describe('trying a failed triage again', () => {
  it('asks the bridge to triage the same request, and passes on its refusal in its own words', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? 'GET' });
        return new Response(JSON.stringify({ bot: 'ottoexampleco' }), { status: 200 });
      }),
    );
    expect(await retryTriage('a4b02784-3ae8-450b-abe9-0c93eb4d67dc')).toEqual({ ok: true, bot: 'ottoexampleco' });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/requests\/a4b02784-3ae8-450b-abe9-0c93eb4d67dc\/triage$/), method: 'POST' }]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'that request is already issue #15' }), { status: 409 })),
    );
    expect(await retryTriage('a4b02784-3ae8-450b-abe9-0c93eb4d67dc')).toEqual({
      ok: false,
      error: 'that request is already issue #15',
    });
  });
});

describe('abandoning a request', () => {
  it('asks the bridge to abandon it, and passes on its refusal in its own words', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? 'GET' });
        return new Response(JSON.stringify({ request: { state: 'abandoned' } }), { status: 200 });
      }),
    );
    expect(await abandonRequest('a4b02784-3ae8-450b-abe9-0c93eb4d67dc')).toEqual({ ok: true });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/requests\/a4b02784-3ae8-450b-abe9-0c93eb4d67dc\/abandon$/), method: 'POST' }]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'that request is filed, so there is nothing to abandon' }), { status: 409 })));
    expect(await abandonRequest('a4b02784-3ae8-450b-abe9-0c93eb4d67dc')).toEqual({ ok: false, error: 'that request is filed, so there is nothing to abandon' });
  });
});

describe('a message to a bot', () => {
  it('says which subject it is about, so a message about a console request reaches that request', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ answered: false }), { status: 200 });
      }),
    );

    expect(await sendMessage('ottoexampleco', 'Put the readme at the root.', 'request:a4b02784')).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: expect.stringMatching(/\/v1\/threads\/ottoexampleco\/messages$/),
        body: { text: 'Put the readme at the root.', subject: 'request:a4b02784' },
      },
    ]);
  });
});

describe('the repositories OpenADLC works in, from settings', () => {
  function recording(status = 200, body: unknown = {}) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(body), { status });
      }),
    );
    return calls;
  }

  it('removes one through the bridge’s own route, and says why when the bridge will not', async () => {
    const calls = recording(200, { notDone: [] });
    expect(await removeRepository('fleetadlc-testbed')).toEqual({ ok: true, report: { notDone: [] } });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/repos\/fleetadlc-testbed\/remove$/), method: 'POST', body: undefined }]);

    recording(404, { error: 'unknown repository' });
    expect(await removeRepository('nothing')).toEqual({ ok: false, error: 'unknown repository' });
  });

  it('sends what the review step chose, and hands back what could not be done', async () => {
    const leftover = { step: 'collaborator', what: 'irisexampleco is still a collaborator', why: 'refused', action: { label: 'Collaborators on GitHub', url: 'https://github.com/janedoe/app/settings/access' } };
    const calls = recording(200, { notDone: [leftover] });
    const result = await removeRepository('app', { crewAccess: true, labels: false });
    expect(result).toEqual({ ok: true, report: { notDone: [leftover] } });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/repos\/app\/remove$/), method: 'POST', body: { crewAccess: true, labels: false } }]);
  });

  it('reads what removing one would do, before anything is pressed', async () => {
    const calls = recording(200, { removal: { repository: 'janedoe/app', tasks: [] } });
    expect(await repositoryRemoval('app')).toEqual({ ok: true, removal: { repository: 'janedoe/app', tasks: [] } });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/repos\/app\/removal$/), method: 'GET', body: undefined }]);

    recording(404, { error: 'unknown repository' });
    expect(await repositoryRemoval('nothing')).toEqual({ ok: false, error: 'unknown repository' });

    // Refused for who is asking: the dialog must not then say it can still be removed.
    recording(403, { error: 'this needs an admin' });
    expect(await repositoryRemoval('app')).toEqual({ ok: false, error: 'this needs an admin', refused: true });
  });

  it('changes one’s colour as it changes the rest of its settings', async () => {
    const calls = recording();
    expect(await updateRepoSettings('fleetadlc-testbed', { color: 'teal' })).toEqual({ ok: true });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/repos\/fleetadlc-testbed$/), method: 'PATCH', body: { color: 'teal' } }]);
  });

  it('reverts a design memory supersede through the bridge’s route, and passes on its refusal', async () => {
    const calls = recording(200, { restored: { id: 'old', state: 'accepted' }, retired: { id: 'new', state: 'retired' } });
    expect(await revertDesignMemory('api', 'new')).toEqual({ ok: true, restored: { id: 'old', state: 'accepted' }, retired: { id: 'new', state: 'retired' } });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/repos\/api\/design-memory\/new\/revert$/), method: 'POST', body: undefined }]);

    recording(409, { error: 'it replaced nothing that is still superseded' });
    expect(await revertDesignMemory('api', 'new')).toEqual({ ok: false, error: 'it replaced nothing that is still superseded' });
  });

  it('sets a crew member’s color through the bridge, and passes on a refusal', async () => {
    const calls = recording();
    expect(await setCrewColor('builder', 'rose')).toEqual({ ok: true });
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/crew\/builder$/), method: 'PATCH', body: { color: 'rose' } }]);

    recording(400, { error: "a crew member's color is one of sand, blue, mint, violet, rose, sky, olive, green, or null for its role's tint" });
    expect(await setCrewColor('builder', 'chartreuse')).toEqual({
      ok: false,
      error: "a crew member's color is one of sand, blue, mint, violet, rose, sky, olive, green, or null for its role's tint",
    });
  });
});

describe('pausing and resuming some repositories', () => {
  it('names them to the bridge, and everything when none are named', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const pause = { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ paused: null, repos: url.endsWith('/pause') ? { api: pause } : {} }), { status: 200 });
      }),
    );

    expect(await pauseWork('a migration is running', ['api'])).toEqual({ ok: true, pauses: { paused: null, repos: { api: pause } } });
    expect(await resumeWork(['api'])).toEqual({ ok: true, pauses: { paused: null, repos: {} } });
    await resumeWork();
    await pauseWork('');
    await resumeWork(undefined, { keepRepos: true });
    expect(calls).toEqual([
      { url: expect.stringMatching(/\/v1\/work\/pause$/), body: { reason: 'a migration is running', repos: ['api'] } },
      { url: expect.stringMatching(/\/v1\/work\/resume$/), body: { repos: ['api'] } },
      { url: expect.stringMatching(/\/v1\/work\/resume$/), body: {} },
      { url: expect.stringMatching(/\/v1\/work\/pause$/), body: { reason: '' } },
      { url: expect.stringMatching(/\/v1\/work\/resume$/), body: { keepRepos: true } },
    ]);
  });

  it('passes on the bridge’s refusal of a repository it does not know', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'OpenADLC does not work in nope' }), { status: 400 })),
    );
    expect(await pauseWork('', ['nope'])).toEqual({ ok: false, error: 'OpenADLC does not work in nope' });
  });
});

describe('a promote held for a person', () => {
  it('is released, or its repository switched to automatic, through the bridge’s routes', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), method: init.method ?? 'GET' });
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    expect(await releasePromote('app', 'abc1234def')).toEqual({ ok: true });
    expect(await switchToAutomatic('app')).toEqual({ ok: true });
    expect(calls).toEqual([
      { url: expect.stringMatching(/\/v1\/repos\/app\/deploys\/abc1234def\/release$/), method: 'POST' },
      { url: expect.stringMatching(/\/v1\/repos\/app\/delivery\/automatic$/), method: 'POST' },
    ]);
  });

  it('passes on the bridge’s refusal in its own words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'app@abc1234 is not held for a person' }), { status: 409 })));
    expect(await releasePromote('app', 'abc1234def')).toEqual({ ok: false, error: 'app@abc1234 is not held for a person' });
  });
});

describe('Stop all on a folded card', () => {
  it('asks the bridge to stop every task, past one it refuses, and names the ones that did not stop', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(String(url).replace(/^.*\/v1\/tasks\/([^/]+)\/stop$/, '$1'));
        return String(url).includes('bbbbbbbb-2')
          ? new Response(JSON.stringify({ error: 'that task is running again' }), { status: 409 })
          : new Response(JSON.stringify({ releasedLease: null }), { status: 200 });
      }),
    );

    const result = await stopTasks(['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3']);

    expect(asked).toEqual(['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3']);
    expect(result).toEqual({
      ok: false,
      error: '2 of 3 stopped; this one did not: task bbbbbbbb: that task is running again',
      failed: ['bbbbbbbb-2'],
    });
  });

  it('is fine when every one stopped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ releasedLease: null }), { status: 200 })));
    expect(await stopTasks(['aaaaaaaa-1', 'bbbbbbbb-2'])).toEqual({ ok: true });
  });
});

describe('a name put into a bridge path', () => {
  function recording() {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ token: 't', expiresInSeconds: 60 }), { status: 200 });
      }),
    );
    return urls;
  }

  // A `?bot=` link once named `x/../../repos/web/remove?`, and "stop all its
  // work" became POST /v1/repos/web/remove, sent as the admin who pressed it.
  const CRAFTED = 'x/../../repos/web/remove?';

  it('is encoded when a bot is restarted, so it cannot steer the call to another route', async () => {
    const urls = recording();
    await restartBot(CRAFTED);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/v1\/bots\/x%2F\.\.%2F\.\.%2Frepos%2Fweb%2Fremove%3F\/restart$/);
  });

  it('is encoded when a session is stopped, or its terminal asked for', async () => {
    const urls = recording();
    await killSession(CRAFTED, '../x#');
    await requestAttachToken(CRAFTED, '../x#');
    expect(urls[0]).toMatch(/\/v1\/sessions\/x%2F\.\.%2F\.\.%2Frepos%2Fweb%2Fremove%3F\/\.\.%2Fx%23\/kill$/);
    expect(urls[1]).toMatch(/\/v1\/terminal\/x%2F\.\.%2F\.\.%2Frepos%2Fweb%2Fremove%3F\/\.\.%2Fx%23\/token$/);
  });

  it('is encoded when a gate is answered', async () => {
    const urls = recording();
    await answerGate('../work/resume#', 'yes');
    expect(urls[0]).toMatch(/\/v1\/gates\/\.\.%2Fwork%2Fresume%23\/answer$/);
  });
});

describe('restarting a task on a fresh computer', () => {
  it('says the task was stopped when starting it again is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/stop')
          ? new Response(JSON.stringify({ releasedLease: null }), { status: 200 })
          : new Response(JSON.stringify({ error: 'the bot is busy' }), { status: 409 }),
      ),
    );
    expect(await restartTaskFresh('task-1')).toEqual({
      ok: false,
      error: 'it was stopped, with its branch kept, but could not be started again: the bot is busy',
    });
  });
});
