import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Routine, RoutineFields, RoutineOwner } from '@openadlc/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVES_OFF_FOR_ROUTINES,
  NOT_LINKED_FOR_ROUTINES,
  registerRoutineRoutes,
  ROUTINE_CREATED,
  ROUTINE_DELETED,
  ROUTINE_EDITED,
  RoutineRoutes,
  type RoutineRouteDeps,
} from './routine-routes.js';
import { HttpFailure, Router } from './router.js';

const NOW = new Date('2026-11-26T09:00:20.000Z');
const BODY = {
  repo: 'app',
  text: 'Review the dependencies',
  details: 'One change per pull request.',
  kind: 'chore',
  cadence: { every: 'week', weekday: 1 },
  time: '09:00',
  timeZone: 'Europe/Berlin',
};

/** People and their linked accounts: Ada and Bea approve, Cy does not, and Dee has linked nothing. */
const LINKS: Record<string, { githubLogin: string; githubUserId: number }> = {
  'ada@example.com': { githubLogin: 'ada', githubUserId: 1 },
  'bea@example.com': { githubLogin: 'bea', githubUserId: 2 },
  'cy@example.com': { githubLogin: 'cy', githubUserId: 3 },
};
const APPROVERS = new Set([1, 2]);

function harness() {
  const rows = new Map<string, Routine>();
  const audits: { actor: string; action: string; target: string; payload: Record<string, unknown> }[] = [];
  let made = 0;
  const toRoutine = (id: string, input: RoutineFields & { owner: RoutineOwner; by: string; nextRunAt: Date }, before?: Routine): Routine => ({
    id,
    repoId: input.repoId,
    repo: input.repoId === 'repo-app' ? 'app' : 'api',
    repoFullName: `acme/${input.repoId === 'repo-app' ? 'app' : 'api'}`,
    text: input.text,
    details: input.details,
    kind: input.kind,
    cadence: input.cadence,
    time: input.time,
    timeZone: input.timeZone,
    paused: before?.paused ?? false,
    owner: input.owner,
    createdBy: before?.createdBy ?? input.by,
    updatedBy: input.by,
    createdAt: before?.createdAt ?? NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    nextRunAt: before?.paused ? null : input.nextRunAt.toISOString(),
    lastRunAt: null,
    lastRequestId: null,
    lastRequestState: null,
    lastOutcome: null,
    lastSkipReason: null,
  });
  const store: RoutineRouteDeps['store'] = {
    list: vi.fn(async () => [...rows.values()]),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    create: vi.fn(async (input) => {
      made += 1;
      const routine = toRoutine(`0b6f1d1c-6c55-4c1c-9a59-${String(made).padStart(12, '0')}`, input);
      rows.set(routine.id, routine);
      return routine;
    }),
    update: vi.fn(async (id, input) => {
      const before = rows.get(id);
      if (!before) return null;
      const routine = toRoutine(id, input, before);
      rows.set(id, routine);
      return routine;
    }),
    setPaused: vi.fn(async (id, paused, next, by) => {
      const before = rows.get(id);
      if (!before) return null;
      const routine = { ...before, paused, nextRunAt: paused ? null : (next?.toISOString() ?? null), updatedBy: by };
      rows.set(id, routine);
      return routine;
    }),
    remove: vi.fn(async (id) => rows.delete(id)),
  };
  const routes = new RoutineRoutes({
    store,
    managedRepos: async () => [
      { id: 'repo-app', name: 'app' },
      { id: 'repo-api', name: 'api' },
    ],
    linkOf: async (identity) => LINKS[identity] ?? null,
    approves: async (id) => APPROVERS.has(id),
    audit: async (entry) => {
      audits.push(entry);
    },
    now: () => NOW,
  });
  return { routes, store, rows, audits };
}

async function refusal(promise: Promise<unknown>): Promise<HttpFailure> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof HttpFailure)) throw new Error(`expected an HttpFailure, got ${String(error)}`);
  return error;
}

describe('creating a routine', () => {
  it('records the approver as its owner and sets its first run from now', async () => {
    const { routes, audits } = harness();
    const created = await routes.create('ada@example.com', BODY);
    expect(created).toMatchObject({
      repo: 'app',
      text: 'Review the dependencies',
      owner: { identity: 'ada@example.com', login: 'ada', githubId: 1 },
      createdBy: 'ada@example.com',
      // Monday the 30th, 09:00 in Berlin.
      nextRunAt: '2026-11-30T08:00:00.000Z',
    });
    expect(audits).toEqual([{ actor: 'ada@example.com', action: ROUTINE_CREATED, target: `routine:${created.id}`, payload: { repo: 'app', login: 'ada', nextRunAt: '2026-11-30T08:00:00.000Z' } }]);
  });

  it('falls due on the next tick when it is set for the current minute', async () => {
    const { routes } = harness();
    const created = await routes.create('ada@example.com', { ...BODY, cadence: { every: 'day' }, time: '09:00', timeZone: 'UTC' });
    expect(created.nextRunAt).toBe('2026-11-26T09:00:00.000Z');
  });

  it('refuses what it cannot keep with a 400 that names the field and what to fix', async () => {
    const { routes, store } = harness();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ repo: 'acme/x' }, 'repo', 'acme/x is not managed by this install'],
      [{ text: '  ' }, 'text', 'request text is empty'],
      [{ timeZone: 'Mars/Base' }, 'timeZone', '"Mars/Base" is not an IANA zone'],
      [{ cadence: { every: 'month', day: 0 } }, 'cadence', 'from 1 to 31'],
      [{ cadence: { every: 'month', day: 32 } }, 'cadence', 'from 1 to 31'],
    ];
    for (const [patch, field, words] of cases) {
      const failure = await refusal(routes.create('ada@example.com', { ...BODY, ...patch }));
      expect(failure.status, field).toBe(400);
      expect(failure.details).toEqual({ field });
      expect(failure.message).toContain(words);
    }
    expect(store.create).not.toHaveBeenCalled();
  });
});

describe('who may change routines', () => {
  it('is refused, with what to do, to someone without Approves or with no linked account, on every change', async () => {
    const { routes, rows, store } = harness();
    const existing = await routes.create('ada@example.com', BODY);
    const before = rows.get(existing.id);

    for (const [identity, message, url] of [
      ['cy@example.com', APPROVES_OFF_FOR_ROUTINES, '/settings#people'],
      ['dee@example.com', NOT_LINKED_FOR_ROUTINES, '/settings#your-github'],
    ] as const) {
      for (const attempt of [
        routes.create(identity, BODY),
        routes.edit(identity, existing.id, BODY),
        routes.pause(identity, existing.id, true),
        routes.pause(identity, existing.id, false),
        routes.remove(identity, existing.id),
      ]) {
        const failure = await refusal(attempt);
        expect(failure.status).toBe(403);
        expect(failure.message).toBe(message);
        expect(failure.details).toEqual({ url });
      }
    }
    expect(APPROVES_OFF_FOR_ROUTINES).toBe('Only someone in People with Approves on can change routines: an admin turns it on in Settings → People.');
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(rows.get(existing.id)).toEqual(before);
  });

  it('lets anyone read them, and tells the viewer whether they may change them and why not', async () => {
    const { routes } = harness();
    await routes.create('ada@example.com', BODY);
    expect(await routes.view('ada@example.com')).toMatchObject({ mayEdit: true, routines: [{ repo: 'app' }] });
    expect((await routes.view('ada@example.com')).templates.map((template) => template.id)).toEqual(['dependency-review', 'docs-drift', 'project-health', 'blank']);
    expect(await routes.view('cy@example.com')).toMatchObject({ mayEdit: false, why: APPROVES_OFF_FOR_ROUTINES, routines: [{ repo: 'app' }] });
    expect(await routes.view('dee@example.com')).toMatchObject({ mayEdit: false, why: NOT_LINKED_FOR_ROUTINES });
  });
});

describe('editing a routine', () => {
  it('makes the approver who edits it its owner, so it files as them', async () => {
    const { routes, audits } = harness();
    const created = await routes.create('ada@example.com', BODY);
    const edited = await routes.edit('bea@example.com', created.id, { ...BODY, repo: 'api', text: 'Review the dependencies, weekly' });
    expect(edited).toMatchObject({ repo: 'api', text: 'Review the dependencies, weekly', owner: { identity: 'bea@example.com', login: 'bea', githubId: 2 }, updatedBy: 'bea@example.com', createdBy: 'ada@example.com' });
    expect(audits.at(-1)).toMatchObject({ actor: 'bea@example.com', action: ROUTINE_EDITED, payload: { previousOwner: 'ada' } });
  });

  it('is a 404 for a routine that is not there', async () => {
    const { routes } = harness();
    expect((await refusal(routes.edit('ada@example.com', 'gone', BODY))).status).toBe(404);
    expect((await refusal(routes.pause('ada@example.com', 'gone', true))).status).toBe(404);
    expect((await refusal(routes.remove('ada@example.com', 'gone'))).status).toBe(404);
  });
});

describe('pausing, resuming and deleting', () => {
  it('pauses with no next run and resumes from now, leaving the owner as it was', async () => {
    const { routes } = harness();
    const created = await routes.create('ada@example.com', BODY);
    expect(await routes.pause('bea@example.com', created.id, true)).toMatchObject({ paused: true, nextRunAt: null, owner: { login: 'ada' } });
    expect(await routes.pause('bea@example.com', created.id, false)).toMatchObject({ paused: false, nextRunAt: '2026-11-30T08:00:00.000Z', owner: { login: 'ada' } });
  });

  it('deletes it and audits what it said', async () => {
    const { routes, rows, audits } = harness();
    const created = await routes.create('ada@example.com', BODY);
    expect(await routes.remove('bea@example.com', created.id)).toEqual({ deleted: true });
    expect(rows.size).toBe(0);
    expect(audits.at(-1)).toMatchObject({ actor: 'bea@example.com', action: ROUTINE_DELETED, payload: { text: 'Review the dependencies' } });
  });
});

describe('the routes', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('serve the six paths roles.ts names, and answer a refusal with its status and words', async () => {
    const { routes } = harness();
    const router = new Router();
    registerRoutineRoutes(router, routes);
    expect(router.table().map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/routines',
      'POST /v1/routines',
      'PATCH /v1/routines/:id',
      'POST /v1/routines/:id/pause',
      'POST /v1/routines/:id/resume',
      'DELETE /v1/routines/:id',
    ]);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/routines`;
    const post = (identity: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openadlc-identity': identity }, body: JSON.stringify(body) });

    const refused = await post('cy@example.com', BODY);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(APPROVES_OFF_FOR_ROUTINES);

    const created = await post('ada@example.com', BODY);
    expect(created.status).toBe(200);
    expect(((await created.json()) as { routine: Routine }).routine.owner.login).toBe('ada');

    const bad = await post('ada@example.com', { ...BODY, timeZone: 'Mars/Base' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: 'timeZone' });
  });
});
