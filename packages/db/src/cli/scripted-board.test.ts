import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '@fleetadlc/shared';

// The board clears what it wrote last time in one transaction. Nothing was
// written before, so the clear has nothing to find.
vi.mock('../client.js', () => ({
  withTransaction: vi.fn(async (work: (client: { query: () => Promise<unknown> }) => Promise<unknown>) =>
    work({ query: async () => ({ rows: [], rowCount: 0 }) }),
  ),
}));
vi.mock('../store/bots.js', () => ({ listBots: vi.fn() }));
vi.mock('../store/repos.js', () => ({ listRepos: vi.fn() }));
vi.mock('../store/issues.js', () => ({ upsertIssue: vi.fn(async () => undefined) }));
vi.mock('../store/tasks.js', () => ({
  createTask: vi.fn(async () => ({ id: 'task-1' })),
  updateTaskState: vi.fn(async () => undefined),
  addTaskCost: vi.fn(async () => 0),
}));
vi.mock('../store/threads.js', () => ({
  ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
  addMessage: vi.fn(async () => undefined),
  createGate: vi.fn(async () => ({ id: 'gate-1', question: 'which?', options: [], githubCommentUrl: null })),
}));
vi.mock('../store/costs.js', () => ({
  recordUsage: vi.fn(async () => undefined),
  refreshBudget: vi.fn(async () => undefined),
  currentPeriod: () => '2026-09',
}));

import * as bots from '../store/bots.js';
import * as costs from '../store/costs.js';
import * as repos from '../store/repos.js';
import { scriptedLedgerModel, seedScriptedBoard } from './scripted-board.js';

function crewMember(partial: Partial<Bot>): Bot {
  return {
    id: `bot-${partial.name}`,
    name: 'builder',
    slot: 'builder',
    displayName: 'Builder',
    role: 'implement',
    engine: 'claude',
    model: 'claude-sonnet-5',
    githubLogin: null,
    hostId: null,
    container: 'bot-builder',
    status: 'stopped',
    skills: [],
    sidecarDb: false,
    modelAccountId: null,
    modelSetAt: null,
    ...partial,
  };
}

beforeEach(() => {
  vi.mocked(costs.recordUsage).mockClear();
  vi.mocked(repos.listRepos).mockResolvedValue([
    { id: 'repo-1', name: 'scripted', fullName: 'local/scripted' } as never,
  ]);
});

describe('the scripted board ledger', () => {
  it('records a resolved id for a bot the console set to follow a family', async () => {
    // The ledger refuses `newest:`, so a bot assigned one stopped the whole
    // scripted seed at its first usage row.
    vi.mocked(bots.listBots).mockResolvedValue([
      crewMember({ name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', model: 'newest:opus' }),
      crewMember({ name: 'intake', slot: 'intake', role: 'intake', model: 'newest:haiku' }),
      crewMember({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', engine: 'grok', model: 'grok-4' }),
    ]);

    await seedScriptedBoard();

    const rows = vi.mocked(costs.recordUsage).mock.calls.map((call) => call[0]);
    expect(rows).toHaveLength(3);
    for (const entry of rows) expect(entry.model).not.toMatch(/^newest:/);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ botId: 'bot-fleetadlc-atlas-janedoe', model: 'claude-opus-5', modelAlias: 'newest:opus' }),
        expect.objectContaining({ botId: 'bot-intake', model: 'claude-haiku-4-5', modelAlias: 'newest:haiku' }),
        expect.objectContaining({ botId: 'bot-lead-reviewer', model: 'grok-4', modelAlias: null }),
      ]),
    );
  });

  it('passes a pinned id through', () => {
    expect(scriptedLedgerModel('gpt-5-codex')).toEqual({ model: 'gpt-5-codex', modelAlias: null });
    expect(scriptedLedgerModel('newest:codex')).toEqual({ model: 'gpt-5-codex', modelAlias: 'newest:codex' });
  });
});
