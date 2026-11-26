import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DiscoverRun, ProposalInput, StoredProposal } from '@openadlc/db';
import { proposalFingerprint } from '@openadlc/shared';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverService, EMPTY_REPOSITORY_NOTE, registerDiscoverRoutes, type DiscoverDeps } from './discover.js';
import { requestPrefixOf } from './request-context.js';
import { Router, WithStatus } from './router.js';
import { BotBusyError, SpendingCapError } from './task-service.js';

/**
 * Discover runs as the bridge starts, records and ends them (#370,
 * docs/adr/0089). The store is in memory and holds the one-live-run rule as
 * the partial index does; the task service is a stand-in whose arguments are
 * what is asserted, since `open` is the path that applies the caps and
 * writes the ledger.
 */

const REPO = { id: 'repo-1', name: 'OpenADLC', fullName: '620legal/OpenADLC', defaultBranch: 'main' };
const SEAT = { id: 'bot-intake', name: 'intake' };
const COMMIT = 'a'.repeat(40);

const GOOD = {
  lens: 'improve',
  key: 'finish-csv-export',
  title: 'Finish the CSV export',
  description: 'The handler returns an empty file.',
  status: 'partial',
  evidence: [{ file: 'apps/web/src/export.ts', line: 12 }],
};

function memoryStore() {
  const runs: DiscoverRun[] = [];
  const proposals: StoredProposal[] = [];
  let next = 0;
  const make = (input: { repoId: string; lenses: string[]; startedBy: string }, state: DiscoverRun['state'], note: string | null = null): DiscoverRun => {
    next += 1;
    const id = `${String(next).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const run: DiscoverRun = {
      id,
      repoId: input.repoId,
      taskId: null,
      lenses: input.lenses,
      state,
      commit: null,
      proposalCount: 0,
      droppedCount: 0,
      note,
      reason: null,
      startedBy: input.startedBy,
      createdAt: new Date(Date.UTC(2026, 10, 26, 10, next)).toISOString(),
      endedAt: state === 'running' ? null : new Date().toISOString(),
    };
    runs.push(run);
    return run;
  };
  const live = (repoId: string) => runs.find((run) => run.repoId === repoId && run.state === 'running');
  return {
    runs,
    proposals,
    startRun: vi.fn(async (input: { repoId: string; lenses: string[]; startedBy: string }) => {
      const running = live(input.repoId);
      return running ? { conflict: running } : { run: make(input, 'running') };
    }),
    recordEmpty: vi.fn(async (input: { repoId: string; lenses: string[]; startedBy: string; note: string }) => {
      const running = live(input.repoId);
      return running ? { conflict: running } : { run: make(input, 'done', input.note) };
    }),
    attachTask: vi.fn(async (runId: string, taskId: string) => {
      const run = runs.find((one) => one.id === runId);
      if (run) run.taskId = taskId;
    }),
    record: vi.fn(async (runId: string, input: { commit: string; proposals: readonly ProposalInput[]; dropped: number; note: string | null }) => {
      const run = runs.find((one) => one.id === runId);
      if (!run || run.state !== 'running' || run.commit) return false;
      Object.assign(run, { commit: input.commit, proposalCount: input.proposals.length, droppedCount: input.dropped, note: input.note });
      for (const one of input.proposals) proposals.push({ ...one, id: `p-${proposals.length}`, runId, repoId: run.repoId, createdAt: run.createdAt });
      return true;
    }),
    finish: vi.fn(async (runId: string, state: 'done' | 'failed', reason?: string | null) => {
      const run = runs.find((one) => one.id === runId && one.state === 'running');
      if (!run) return null;
      Object.assign(run, { state, reason: reason ?? null, endedAt: new Date().toISOString() });
      return run;
    }),
    getRun: vi.fn(async (id: string) => runs.find((one) => one.id === id) ?? null),
    runByPrefix: vi.fn(async (prefix: string) => runs.find((one) => one.id.replace(/-/g, '').startsWith(prefix)) ?? null),
    runOfTask: vi.fn(async (taskId: string) => runs.find((one) => one.taskId === taskId) ?? null),
    proposalsOf: vi.fn(async (runId: string) => proposals.filter((one) => one.runId === runId)),
    latestDoneProposals: vi.fn(async (repoId: string, limit: number) => {
      const last = runs.filter((run) => run.repoId === repoId && run.state === 'done' && run.commit).at(-1);
      return last ? proposals.filter((one) => one.runId === last.id).slice(0, limit) : [];
    }),
    removeRun: vi.fn(async (id: string) => {
      const at = runs.findIndex((one) => one.id === id && one.taskId === null);
      if (at >= 0) runs.splice(at, 1);
    }),
  };
}

function world(overrides: Partial<DiscoverDeps> = {}) {
  const store = memoryStore();
  const tasks = new Map<string, { id: string; skill: string | null; subjectRef: string }>();
  let opened = 0;
  const open = vi.fn(async (input: Parameters<DiscoverDeps['open']>[0]) => {
    opened += 1;
    const taskId = `task-${opened}`;
    tasks.set(taskId, { id: taskId, skill: input.skill, subjectRef: input.subjectRef });
    input.recorded?.({ taskId, bot: input.bot });
    return { taskId, session: `session-${opened}` };
  });
  const audit = vi.fn(async () => undefined);
  const deps: DiscoverDeps = {
    store,
    repo: async (name) => (name === REPO.name || name.toLowerCase() === REPO.fullName.toLowerCase() ? REPO : null),
    repoById: async (id) => (id === REPO.id ? REPO : null),
    intakeSeat: async () => SEAT,
    open,
    defaultBranchState: async () => 'present',
    busyWords: async () => 'running `triage` on request:ab12cd34',
    audit,
    task: async (id) => tasks.get(id) ?? null,
    ...overrides,
  };
  return { service: new DiscoverService(deps), store, open, audit, tasks };
}

const runOf = (answer: WithStatus) => (answer.body as { run: { id: string; state: string; note: string | null; taskId: string | null; proposalCount: number } }).run;

describe('starting a Discover run', () => {
  it('opens an intake task on the run’s subject, with the discover skill, on the intake seat', async () => {
    const { service, open, audit, store } = world();
    const answer = await service.start({ name: '620legal/OpenADLC', lenses: undefined, actor: 'ana' });

    expect(answer).toBeInstanceOf(WithStatus);
    expect(answer.status).toBe(202);
    const run = runOf(answer);
    expect(run).toMatchObject({ state: 'running', taskId: 'task-1' });
    // `open` is the path that holds every task to the spending caps and the per-task cap, and writes its usage to the ledger.
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        bot: 'intake',
        botId: 'bot-intake',
        repo: 'OpenADLC',
        kind: 'intake',
        subjectType: 'request',
        subjectRef: `discover:${run.id.replace(/-/g, '').slice(0, 8)}`,
        skill: 'discover',
        whenBlocked: 'refuse',
      }),
    );
    expect(store.runs[0]?.lenses).toEqual(['improve']);
    expect(audit).toHaveBeenCalledWith({ actor: 'ana', action: 'discover.started', target: '620legal/OpenADLC', payload: { run: run.id, lenses: ['improve'] } });
  });

  it('refuses a repository the install does not manage, saying what to do', async () => {
    const { service, open } = world();
    await expect(service.start({ name: 'someone/else', lenses: undefined, actor: 'ana' })).rejects.toMatchObject({
      status: 404,
      message: 'someone/else is not a repository this install manages; add it in Settings → Repositories first',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses an empty list of lenses and a lens that does not exist, naming the ones that do', async () => {
    const { service, store } = world();
    await expect(service.start({ name: 'OpenADLC', lenses: [], actor: 'ana' })).rejects.toMatchObject({ status: 400, message: 'name at least one lens: improve' });
    await expect(service.start({ name: 'OpenADLC', lenses: ['competitors'], actor: 'ana' })).rejects.toMatchObject({
      status: 400,
      message: 'there is no lens competitors; the lenses are: improve',
    });
    await expect(service.start({ name: 'OpenADLC', lenses: 'improve', actor: 'ana' })).rejects.toMatchObject({ status: 400 });
    expect(store.runs).toEqual([]);
  });

  it('refuses a second run while one is running, naming it', async () => {
    const { service } = world();
    const first = runOf(await service.start({ name: 'OpenADLC', lenses: ['improve'], actor: 'ana' }));
    await expect(service.start({ name: 'OpenADLC', lenses: ['improve'], actor: 'ben' })).rejects.toMatchObject({
      status: 409,
      message: `a Discover run is already running on 620legal/OpenADLC: run ${first.id}`,
    });
  });

  it('refuses while the intake seat is busy, saying with what, and leaves no run behind', async () => {
    const { service, store } = world({
      open: vi.fn(async () => {
        throw new BotBusyError('intake');
      }),
    });
    await expect(service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' })).rejects.toMatchObject({
      status: 409,
      message: 'intake, the intake seat, is running `triage` on request:ab12cd34; start the Discover run again once it is free',
    });
    expect(store.runs).toEqual([]);
  });

  it('answers a spending cap’s refusal in its own words, and leaves no run behind', async () => {
    const refusal = new SpendingCapError('intake', 'the monthly cap of $100 is spent');
    const { service, store } = world({
      open: vi.fn(async () => {
        throw refusal;
      }),
    });
    await expect(service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' })).rejects.toBe(refusal);
    expect(store.runs).toEqual([]);
  });

  it('records an empty repository’s run as done with its note, and starts no task', async () => {
    const { service, open, store } = world({ defaultBranchState: async () => 'empty' });
    const answer = await service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' });
    expect(answer.status).toBe(202);
    expect(runOf(answer)).toMatchObject({ state: 'done', note: EMPTY_REPOSITORY_NOTE, proposalCount: 0, taskId: null });
    expect(open).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(1);
  });

  it('fails the run when hostd refuses the task, and says so', async () => {
    const { service, store } = world({ open: vi.fn(async () => ({ taskId: 'task-9', session: null, error: 'no computer' })) });
    await expect(service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' })).rejects.toMatchObject({ status: 502 });
    expect(store.runs[0]).toMatchObject({ state: 'failed', reason: 'hostd refused: no computer' });
  });

  it('is not a console request, so the request filing and the queue leave its subject alone', async () => {
    const { service, open } = world();
    await service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' });
    const subject = (open.mock.calls[0]?.[0] as { subjectRef: string }).subjectRef;
    expect(requestPrefixOf(subject)).toBeNull();
    // Nor is it an issue: its end hands no stage on.
    const { StageHandoff } = await import('./stage-handoff.js');
    const stages = new StageHandoff({} as never, {} as never);
    expect(await stages.onTaskDone({ kind: 'intake', subjectRef: subject, skill: 'discover' })).toBeNull();
  });
});

describe('what a run’s session reports', () => {
  async function running() {
    const at = world();
    const run = runOf(await at.service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' }));
    return { ...at, run, taskId: run.taskId as string };
  }

  it('stores each proposal with its fingerprint, the commit and the counts', async () => {
    const { service, store, run, taskId } = await running();
    const answer = await service.record(taskId, {
      commit: COMMIT,
      proposals: [{ ...GOOD, evidence: ['apps/web/src/export.ts:12'] }, { ...GOOD, key: 'bad', status: 'maybe' }],
      dropped: 2,
      note: 'Read apps/web.',
    });
    expect(answer).toEqual({ stored: 1, dropped: 3 });
    expect(store.proposals).toEqual([expect.objectContaining({ ...GOOD, fingerprint: proposalFingerprint('improve', 'finish-csv-export'), runId: run.id })]);
    expect(store.runs[0]).toMatchObject({ commit: COMMIT, proposalCount: 1, droppedCount: 3, note: 'Read apps/web.' });
  });

  it('refuses a report from a task that is not discover, or not the run’s, and a second report', async () => {
    const { service, tasks, taskId } = await running();
    tasks.set('task-triage', { id: 'task-triage', skill: 'triage', subjectRef: tasks.get(taskId)!.subjectRef });
    await expect(service.record('task-triage', { commit: COMMIT, proposals: [] })).rejects.toMatchObject({ status: 409 });
    tasks.set('task-other', { id: 'task-other', skill: 'discover', subjectRef: tasks.get(taskId)!.subjectRef });
    await expect(service.record('task-other', { commit: COMMIT, proposals: [] })).rejects.toMatchObject({ status: 409 });

    await service.record(taskId, { commit: COMMIT, proposals: [GOOD] });
    await expect(service.record(taskId, { commit: COMMIT, proposals: [GOOD] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already recorded') });
  });

  it('refuses a commit that is not one, and proposals that are not a list', async () => {
    const { service, taskId } = await running();
    await expect(service.record(taskId, { commit: 'HEAD', proposals: [] })).rejects.toMatchObject({ status: 400 });
    await expect(service.record(taskId, { commit: COMMIT, proposals: 'none' })).rejects.toMatchObject({ status: 400 });
  });

  it('keeps a done run’s note when it found nothing', async () => {
    const { service, store, tasks, taskId } = await running();
    await service.record(taskId, { commit: COMMIT, proposals: [], note: 'Nothing half-built here.' });
    const task = tasks.get(taskId)!;
    expect(await service.missing(task)).toBeNull();
    await service.ended(task, 'done', 'stored 0 proposals');
    expect(store.runs[0]).toMatchObject({ state: 'done', proposalCount: 0, note: 'Nothing half-built here.' });
  });

  it('fails a task that ended done without its proposals, and its run with it', async () => {
    const { service, store, tasks, taskId } = await running();
    const task = tasks.get(taskId)!;
    const missing = await service.missing(task);
    expect(missing).toBe('the Discover run ended without its proposals');
    await service.ended(task, 'failed', missing);
    expect(store.runs[0]).toMatchObject({ state: 'failed', reason: 'the Discover run ended without its proposals' });
  });

  it('fails its run on any other end, with the task’s reason', async () => {
    const { service, store, tasks, taskId } = await running();
    await service.ended(tasks.get(taskId)!, 'stopped', 'stopped by ana');
    expect(store.runs[0]).toMatchObject({ state: 'failed', reason: 'stopped by ana' });
  });

  it('asks nothing of a task that is not discover', async () => {
    const { service } = await running();
    expect(await service.missing({ id: 'task-x', skill: 'triage', subjectRef: 'request:ab12cd34' })).toBeNull();
  });
});

describe('a run’s context', () => {
  it('names the repository, the lenses and the marker, and the last done run’s keys', async () => {
    const { service, taskId, tasks } = await (async () => {
      const at = world();
      const first = runOf(await at.service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' }));
      await at.service.record(first.taskId as string, { commit: COMMIT, proposals: [GOOD] });
      await at.service.ended(at.tasks.get(first.taskId as string)!, 'done', 'stored 1 proposal');
      const second = runOf(await at.service.start({ name: 'OpenADLC', lenses: undefined, actor: 'ana' }));
      return { ...at, taskId: second.taskId as string };
    })();
    const documents = await service.context(tasks.get(taskId)!.subjectRef);
    expect(documents.map((one) => one.name)).toEqual(['discover-run.md', 'earlier-proposals.md']);
    expect(documents[0]?.content).toContain('620legal/OpenADLC');
    expect(documents[0]?.content).toContain('Lenses switched on: improve.');
    expect(documents[0]?.content).toContain('"event":"discover_proposals"');
    expect(documents[1]?.content).toContain('`finish-csv-export` (improve, partial): Finish the CSV export');
  });

  it('is nothing for a subject that is not a run', async () => {
    const { service } = world();
    expect(await service.context('request:ab12cd34')).toEqual([]);
    expect(await service.context('discover:ffffffff')).toEqual([]);
  });
});

describe('the routes', () => {
  async function serve(service: DiscoverService) {
    const router = new Router(undefined, undefined, undefined, async () => 'user');
    registerDiscoverRoutes(router, service);
    const server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-openadlc-identity': 'ana@example.test' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('starts a run with 202, and reads it back with its proposals; another repository’s run is not found', async () => {
    const at = world();
    const { call, close } = await serve(at.service);
    try {
      const started = await call('POST', `/v1/repos/${encodeURIComponent('620legal/OpenADLC')}/discover`, { lenses: ['improve'] });
      expect(started.status).toBe(202);
      const run = started.body.run as { id: string; taskId: string };
      await at.service.record(run.taskId, { commit: COMMIT, proposals: [GOOD] });

      const read = await call('GET', `/v1/repos/OpenADLC/discover/runs/${run.id}`);
      expect(read.status).toBe(200);
      expect(read.body.run).toMatchObject({ id: run.id, repo: '620legal/OpenADLC', commit: COMMIT, proposalCount: 1 });
      expect(read.body.proposals).toEqual([expect.objectContaining({ key: 'finish-csv-export', evidence: GOOD.evidence })]);

      expect((await call('GET', `/v1/repos/someone%2Felse/discover/runs/${run.id}`)).status).toBe(404);
      expect((await call('GET', '/v1/repos/OpenADLC/discover/runs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await call('POST', '/v1/repos/OpenADLC/discover', { lenses: ['nope'] })).body.error).toBe('there is no lens nope; the lenses are: improve');
    } finally {
      await close();
    }
  });

  it('takes a start with no body as every lens', async () => {
    const at = world();
    const { call, close } = await serve(at.service);
    try {
      expect((await call('POST', '/v1/repos/OpenADLC/discover')).status).toBe(202);
      expect(at.store.runs[0]?.lenses).toEqual(['improve']);
    } finally {
      await close();
    }
  });
});
