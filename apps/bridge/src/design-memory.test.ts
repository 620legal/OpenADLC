import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { designMemory as store } from '@fleetadlc/db';

/**
 * What the design stage remembers about a repository: proposed only by the
 * design task's own signed comment, accepted by a person's answer to that
 * design or by the move to build, a supersede said out loud and revertible,
 * given to design tasks alone at a summary's size, and corrected by an admin.
 */

const world = vi.hoisted(() => ({
  entries: [] as store.DesignMemoryEntry[],
  stage: 'spec' as string,
  tasks: {} as Record<string, { id: string; kind: string; repoId: string; subjectRef: string; botId: string }>,
  bots: {} as Record<string, { id: string; name: string }>,
  gates: [] as { taskId: string | null; state: string; answeredBy: string | null }[],
  audit: [] as Record<string, unknown>[],
  events: [] as { type: string; payload: Record<string, unknown> }[],
}));

vi.mock('@fleetadlc/db', () => {
  let next = 1;
  const make = (repoId: string, entry: Record<string, unknown>, source: { subject: string; url: string | null; by: string | null; task: string }) => ({
    id: `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`,
    repoId,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    state: 'proposed',
    supersedes: (entry.supersedes as string | undefined) ?? null,
    sourceSubject: source.subject,
    sourceUrl: source.url,
    sourceTask: source.task,
    adrPath: null,
    proposedBy: source.by,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date(Date.UTC(2026, 8, 30, 10, next)).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return {
    audit: vi.fn(async (entry: Record<string, unknown>) => void world.audit.push(entry)),
    recordEvent: vi.fn(async (event: { type: string; payload: Record<string, unknown> }) => {
      world.events.push(event);
      return 'event-1';
    }),
    repos: {
      getRepoByName: vi.fn(async (name: string) =>
        name === 'api' ? { id: 'repo-1', name: 'api', fullName: 'acme/api' } : name === 'web' ? { id: 'repo-2', name: 'web', fullName: 'acme/web' } : null,
      ),
      listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'api', fullName: 'acme/api' }]),
    },
    issues: { getIssue: vi.fn(async () => ({ stage: world.stage, prChangedPaths: [] })) },
    tasks: { getTask: vi.fn(async (id: string) => world.tasks[id] ?? null) },
    bots: { getBotById: vi.fn(async (id: string) => world.bots[id] ?? null) },
    threads: { listGatesForSubject: vi.fn(async () => world.gates) },
    designMemory: {
      DESIGN_MEMORY_KINDS: ['decision', 'constraint', 'convention', 'glossary'],
      DESIGN_MEMORY_STATES: ['proposed', 'accepted', 'superseded', 'retired'],
      propose: vi.fn(async (repoId: string, entries: Record<string, unknown>[], source: { subject: string; url: string | null; by: string | null; task: string }) => {
        const made = entries.map((entry) => make(repoId, entry, source));
        world.entries.push(...(made as never[]));
        return made;
      }),
      // As the store does it: only what a design task proposed, narrowed as asked.
      acceptFor: vi.fn(async (repoId: string, subjects: string[], by: string, only: { sourceTask?: string; ids?: string[] } = {}) => {
        const accepted = world.entries.filter(
          (one) =>
            one.repoId === repoId &&
            subjects.includes(one.sourceSubject ?? '') &&
            one.state === 'proposed' &&
            one.sourceTask &&
            (!only.sourceTask || one.sourceTask === only.sourceTask) &&
            (!only.ids || only.ids.includes(one.id)),
        );
        for (const one of accepted) Object.assign(one, { state: 'accepted', decidedBy: by });
        const superseded = world.entries.filter((one) => one.state === 'accepted' && accepted.some((entry) => entry.supersedes === one.id));
        for (const one of superseded) Object.assign(one, { state: 'superseded' });
        return { accepted, superseded };
      }),
      revertSupersede: vi.fn(async (id: string, by: string) => {
        const replacer = world.entries.find((one) => one.id === id);
        const old = world.entries.find((one) => one.id === replacer?.supersedes && one.state === 'superseded');
        if (!replacer || !old) return null;
        Object.assign(old, { state: 'accepted', decidedBy: by });
        Object.assign(replacer, { state: 'retired' });
        return { restored: { ...old }, retired: { ...replacer } };
      }),
      listForRepo: vi.fn(async (repoId: string, states?: string[]) => world.entries.filter((one) => one.repoId === repoId && (!states || states.includes(one.state)))),
      listForSubjects: vi.fn(async (subjects: string[]) => world.entries.filter((one) => subjects.includes(one.sourceSubject ?? ''))),
      getEntry: vi.fn(async (id: string) => { const found = world.entries.find((one) => one.id === id); return found ? { ...found } : null; }),
      updateEntry: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const found = world.entries.find((one) => one.id === id);
        if (found) Object.assign(found, patch);
        return found ?? null;
      }),
      decisionsWithoutAdr: vi.fn(async () => []),
    },
  };
});

const DESIGN = (entries: unknown) => `The design.\n<!-- fleetadlc:{"event":"plan_posted"} -->\n<!-- fleetadlc:${JSON.stringify({ event: 'design_memory', entries })} -->`;

/** The design task on api#12, its seat, and a builder on the same issue. */
const SPEC = { id: 'task-spec', kind: 'spec', repoId: 'repo-1', subjectRef: 'api#12', botId: 'bot-se' };
const BUILD = { id: 'task-build', kind: 'implement', repoId: 'repo-1', subjectRef: 'api#12', botId: 'bot-builder' };
const OTHER_SPEC = { id: 'task-spec-13', kind: 'spec', repoId: 'repo-1', subjectRef: 'api#13', botId: 'bot-se' };
const signed = (task: { id: string }, seat: string) => ({ verified: true, seat, task: task.id });
const design = (entries: unknown, signature: { verified: boolean; seat: string | null; task: string | null } | null = signed(SPEC, 'system-engineer')) => ({
  repoName: 'api',
  issueNumber: 12,
  body: DESIGN(entries),
  commentUrl: 'https://github.com/acme/api/issues/12#c',
  signature,
});

beforeEach(() => {
  world.entries = [];
  world.stage = 'spec';
  world.tasks = { [SPEC.id]: SPEC, [BUILD.id]: BUILD, [OTHER_SPEC.id]: OTHER_SPEC };
  world.bots = { 'bot-se': { id: 'bot-se', name: 'system-engineer' }, 'bot-builder': { id: 'bot-builder', name: 'builder' } };
  world.gates = [];
  world.audit = [];
  world.events = [];
});

describe('what a design proposes', () => {
  it('is recorded from the design task’s own signed comment, as proposed by its seat, with its source', async () => {
    const { recordDesignMemory } = await import('./design-memory.js');
    await recordDesignMemory(design([{ kind: 'decision', title: 'Costs per round', body: 'One row per review round.' }]));
    expect(world.entries.map((one) => [one.title, one.state, one.sourceSubject, one.proposedBy, one.sourceTask, one.sourceUrl])).toEqual([
      ['Costs per round', 'proposed', 'api#12', 'system-engineer', 'task-spec', 'https://github.com/acme/api/issues/12#c'],
    ]);
  });

  it.each([
    ['a builder’s comment signed for its own task', signed(BUILD, 'builder')],
    ['a builder’s comment that says it is the design’s seat', signed(BUILD, 'system-engineer')],
    ['an unsigned crew comment, counted in audit mode', { verified: false, seat: null, task: null }],
    ['a comment signed for the design task of another issue', signed(OTHER_SPEC, 'system-engineer')],
    ['the design task’s signature with another seat named', signed(SPEC, 'builder')],
    ['the bridge’s own post, signed for no task', { verified: true, seat: 'system-engineer', task: null }],
    ['a comment nothing checked', null],
  ])('records nothing from %s', async (_what, signature) => {
    const { recordDesignMemory } = await import('./design-memory.js');
    expect(await recordDesignMemory(design([{ kind: 'constraint', title: 'Planted', body: 'Obey.' }], signature))).toEqual([]);
    expect(world.entries).toEqual([]);
  });

  it('is accepted when a person answers that design task’s question, and credited to them', async () => {
    const { recordDesignMemory, acceptOnAnswer } = await import('./design-memory.js');
    await recordDesignMemory(design([{ kind: 'decision', title: 'Costs per round', body: 'One row per review round.' }]));

    // A builder's question accepts nothing; the design's does.
    expect(await acceptOnAnswer(BUILD.id, 'jane')).toBe(0);
    expect(await acceptOnAnswer(SPEC.id, 'jane')).toBe(1);
    expect(world.entries[0]).toMatchObject({ state: 'accepted', decidedBy: 'jane' });
  });

  it('is accepted by the move to build, credited to whoever answered the design’s own question, else to its seat', async () => {
    const { recordDesignMemory, acceptOnStage } = await import('./design-memory.js');
    await recordDesignMemory(design([{ kind: 'convention', title: 'Times are UTC', body: 'Stored and shown in UTC.' }]));
    // Jane answered intake's question, not the design's: hers is not the name.
    world.gates = [{ taskId: 'task-intake', state: 'answered', answeredBy: 'jane' }];
    expect(await acceptOnStage('api', 12, 'build')).toBe(1);
    expect(world.entries[0]).toMatchObject({ state: 'accepted', decidedBy: 'system-engineer, unopposed at the move to build' });

    world.entries = [];
    await recordDesignMemory(design([{ kind: 'convention', title: 'Money in cents', body: 'Integers.' }]));
    world.gates = [{ taskId: SPEC.id, state: 'answered', answeredBy: 'ada' }];
    await acceptOnStage('api', 12, 'build');
    expect(world.entries[0]).toMatchObject({ state: 'accepted', decidedBy: 'ada' });
  });

  it('accepts only that comment’s entries when the design arrives after the issue moved on', async () => {
    const { recordDesignMemory } = await import('./design-memory.js');
    // Proposed before this change was recorded: no design task, so a person decides it.
    world.entries.push({
      id: '00000000-0000-4000-8000-000000000999', repoId: 'repo-1', kind: 'constraint', title: 'From before', body: 'b', state: 'proposed', supersedes: null,
      sourceSubject: 'api#12', sourceUrl: null, sourceTask: null, adrPath: null, proposedBy: 'acme-crew', decidedBy: null, decidedAt: null,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    });
    world.stage = 'build';
    await recordDesignMemory(design([{ kind: 'glossary', title: 'Round', body: 'One review of one head.' }]));
    expect(world.entries.map((one) => [one.title, one.state])).toEqual([
      ['From before', 'proposed'],
      ['Round', 'accepted'],
    ]);
  });

  it('never accepts on its own a proposal no design task made, on the move to build or in the sweep', async () => {
    const { acceptOnStage, sweepDesignMemory } = await import('./design-memory.js');
    world.entries.push({
      id: '00000000-0000-4000-8000-000000000998', repoId: 'repo-1', kind: 'constraint', title: 'From before', body: 'b', state: 'proposed', supersedes: null,
      sourceSubject: 'api#12', sourceUrl: null, sourceTask: null, adrPath: null, proposedBy: 'acme-crew', decidedBy: null, decidedAt: null,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    });
    world.stage = 'build';
    expect(await acceptOnStage('api', 12, 'build')).toBe(0);
    expect(await sweepDesignMemory()).toEqual([]);
    expect(world.entries[0]?.state).toBe('proposed');
  });

  it('says a supersede on the issue and to the board, naming both entries and how to revert', async () => {
    const { recordDesignMemory, acceptOnStage, sayDesignMemoryWith } = await import('./design-memory.js');
    const said: { repo: string; issue: number; body: string }[] = [];
    sayDesignMemoryWith(async (repo, issue, body) => {
      said.push({ repo, issue, body });
      return 'https://github.com/acme/api/issues/12#issuecomment-9';
    });
    world.entries.push({
      id: '00000000-0000-4000-8000-000000000997', repoId: 'repo-1', kind: 'constraint', title: 'Never log credentials', body: 'b', state: 'accepted', supersedes: null,
      sourceSubject: 'api#3', sourceUrl: null, sourceTask: 'task-old', adrPath: null, proposedBy: 'system-engineer', decidedBy: 'jane', decidedAt: '2026-09-01T00:00:00Z',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    });
    await recordDesignMemory(design([{ kind: 'constraint', title: 'Log what helps', body: 'b', supersedes: '00000000-0000-4000-8000-000000000997' }]));

    await acceptOnStage('api', 12, 'build');

    expect(world.entries.find((one) => one.title === 'Never log credentials')?.state).toBe('superseded');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ repo: 'acme/api', issue: 12 });
    expect(said[0]?.body).toContain('“Log what helps” replaces “Never log credentials”');
    expect(said[0]?.body).toContain('Settings → Repositories → api → Design memory');
    expect(world.events).toEqual([
      expect.objectContaining({
        type: 'design_memory.superseded',
        payload: expect.objectContaining({ repo: 'api', issue: 12, commentUrl: 'https://github.com/acme/api/issues/12#issuecomment-9' }),
      }),
    ]);
  });
});

describe('what a design task is given', () => {
  const entry = (title: string, kind: string, at: string, body = 'b'): store.DesignMemoryEntry =>
    ({ id: title, repoId: 'repo-1', kind, title, body, state: 'accepted', supersedes: null, sourceSubject: 'api#1', sourceUrl: null, adrPath: null, proposedBy: null, decidedBy: 'jane', decidedAt: at, createdAt: at, updatedAt: at }) as store.DesignMemoryEntry;

  it('is the accepted entries, decisions first and the newest of them first, with a pointer to the ADRs', async () => {
    const { designMemoryDocument } = await import('./design-memory.js');
    const document = designMemoryDocument(
      [entry('Old decision', 'decision', '2026-01-01T00:00:00Z'), entry('UTC', 'convention', '2026-05-01T00:00:00Z'), entry('New decision', 'decision', '2026-06-01T00:00:00Z'), { ...entry('Replaced', 'decision', '2026-07-01T00:00:00Z'), state: 'superseded' }],
      'acme/api',
    )!;
    expect(document.name).toBe('design-memory.md');
    const order = ['New decision', 'Old decision', 'UTC'].map((title) => document.content.indexOf(`### ${title}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(document.content).not.toContain('Replaced');
    expect(document.content).toContain('docs/adr/');
  });

  it('stays under a summary’s size, leaving the oldest out and saying so', async () => {
    const { designMemoryDocument, DESIGN_MEMORY_CHARS } = await import('./design-memory.js');
    const many = Array.from({ length: 40 }, (_, i) => entry(`Decision ${i}`, 'decision', new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), 'x'.repeat(900)));
    const document = designMemoryDocument(many, 'acme/api')!;
    expect(document.content.length).toBeLessThanOrEqual(DESIGN_MEMORY_CHARS);
    expect(document.content).toContain('### Decision 39');
    expect(document.content).not.toContain('### Decision 0\n');
    expect(document.content).toMatch(/Left out for length, older than everything above: \d+ decisions \(the ADRs under docs\/adr\/ have them\)\._$/);
  });

  it('cuts the oldest whatever their kind, and says where what it left out is kept', async () => {
    const { designMemoryDocument, DESIGN_MEMORY_CHARS } = await import('./design-memory.js');
    const decisions = Array.from({ length: 12 }, (_, i) => entry(`Decision ${i}`, 'decision', new Date(Date.UTC(2026, i % 9, 1 + i)).toISOString(), 'x'.repeat(1500)));
    const old = entry('Old constraint', 'constraint', '2025-12-01T00:00:00Z', 'y'.repeat(1200));
    const fresh = entry('New constraint', 'constraint', '2026-09-30T00:00:00Z', 'z'.repeat(1200));
    const document = designMemoryDocument([...decisions, old, fresh], 'acme/api')!;
    expect(document.content.length).toBeLessThanOrEqual(DESIGN_MEMORY_CHARS);
    expect(document.content).toContain('### New constraint');
    expect(document.content).not.toContain('### Old constraint');
    expect(document.content).toMatch(/decisions? \(the ADRs under docs\/adr\/ have them\); 1 constraint \(a person can read them in Settings → Repositories → Design memory\)\._$/);
  });

  it('is nothing when nothing is accepted yet', async () => {
    const { designMemoryDocument } = await import('./design-memory.js');
    expect(designMemoryDocument([{ ...entry('x', 'decision', '2026-01-01T00:00:00Z'), state: 'proposed' }], 'acme/api')).toBeNull();
  });

  it('names the ADR a merged decision was written in', async () => {
    const { adrFor } = await import('./design-memory.js');
    expect(adrFor('Costs are stored per review round', ['src/a.ts', 'docs/adr/0003-cache-prices.md', 'docs/adr/0004-costs-per-review-round.md'])).toBe('docs/adr/0004-costs-per-review-round.md');
    expect(adrFor('Anything', ['docs/adr/0000-template.md', 'docs/guide.md'])).toBeNull();
  });

  it('names none that shares no word with the decision, unless it is the only one, and none on a tie', async () => {
    const { adrFor } = await import('./design-memory.js');
    const title = 'Costs are stored per review round';
    expect(adrFor(title, ['docs/adr/0007-webhook-signing-secrets.md', 'docs/adr/0008-tunnel-restarts.md'])).toBeNull();
    expect(adrFor(title, ['src/a.ts', 'docs/adr/0007-webhook-signing-secrets.md'])).toBe('docs/adr/0007-webhook-signing-secrets.md');
    expect(adrFor(title, ['docs/adr/0003-costs-cache.md', 'docs/adr/0004-costs-ledger.md'])).toBeNull();
  });
});

describe('correcting it in Settings', () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    const { registerDesignMemoryRoutes } = await import('./design-memory.js');
    const { Router } = await import('./router.js');
    const router = new Router();
    registerDesignMemoryRoutes(router);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const patch = (body: Record<string, unknown>, repo = 'api') =>
    fetch(`${url}/v1/repos/${repo}/design-memory`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-fleetadlc-identity': 'admin@acme.test' }, body: JSON.stringify(body) });

  it('lists the entries, and retires one with an audit line saying what it was', async () => {
    const { recordDesignMemory } = await import('./design-memory.js');
    await recordDesignMemory(design([{ kind: 'decision', title: 'Costs per round', body: 'One row per round.' }]));
    const listed = (await (await fetch(`${url}/v1/repos/api/design-memory`)).json()) as { entries: { id: string }[] };
    expect(listed.entries).toHaveLength(1);

    const response = await patch({ id: listed.entries[0]!.id, state: 'retired' });
    expect(response.status).toBe(200);
    expect(world.entries[0]?.state).toBe('retired');
    expect(world.audit).toEqual([expect.objectContaining({ actor: 'admin@acme.test', action: 'design_memory.updated', payload: expect.objectContaining({ title: 'Costs per round', from: { state: 'proposed', kind: 'decision' } }) })]);
  });

  it('refuses a state it does not know, and an entry of another repository', async () => {
    const { recordDesignMemory } = await import('./design-memory.js');
    await recordDesignMemory(design([{ kind: 'decision', title: 'X', body: 'Y' }]));
    expect((await patch({ id: world.entries[0]!.id, state: 'forgotten' })).status).toBe(400);
    expect((await patch({ id: '00000000-0000-4000-8000-999999999999', state: 'retired' })).status).toBe(404);
    // api's entry, through web's URL.
    expect((await patch({ id: world.entries[0]!.id, state: 'retired', title: 'Changed' }, 'web')).status).toBe(404);
    expect(world.entries[0]).toMatchObject({ repoId: 'repo-1', state: 'proposed', title: 'X' });
    expect(world.audit).toEqual([]);
  });

  it('reverts a supersede: the old entry is in effect again, the new one retired, and it is audited', async () => {
    const { recordDesignMemory, acceptOnStage } = await import('./design-memory.js');
    world.entries.push({
      id: '00000000-0000-4000-8000-000000000996', repoId: 'repo-1', kind: 'constraint', title: 'Never log credentials', body: 'b', state: 'accepted', supersedes: null,
      sourceSubject: 'api#3', sourceUrl: null, sourceTask: 'task-old', adrPath: null, proposedBy: 'system-engineer', decidedBy: 'jane', decidedAt: '2026-09-01T00:00:00Z',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    });
    const [replacer] = await recordDesignMemory(design([{ kind: 'constraint', title: 'Log what helps', body: 'b', supersedes: '00000000-0000-4000-8000-000000000996' }]));
    await acceptOnStage('api', 12, 'build');
    const revert = (id: string) =>
      fetch(`${url}/v1/repos/api/design-memory/${id}/revert`, { method: 'POST', headers: { 'x-fleetadlc-identity': 'admin@acme.test' } });

    const response = await revert(replacer!.id);

    expect(response.status).toBe(200);
    expect(world.entries.map((one) => [one.title, one.state])).toEqual([
      ['Never log credentials', 'accepted'],
      ['Log what helps', 'retired'],
    ]);
    expect(world.audit).toContainEqual(
      expect.objectContaining({ actor: 'admin@acme.test', action: 'design_memory.reverted', payload: expect.objectContaining({ restored: 'Never log credentials' }) }),
    );
    expect((await revert(replacer!.id)).status).toBe(409);
  });
});
