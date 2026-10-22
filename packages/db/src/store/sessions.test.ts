import { describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(async () => ({
    id: 's-1',
    bot_id: 'bot-1',
    task_id: null,
    name: 'implement-1',
    cmd: 'claude',
    state: 'working',
    pid: 7,
    last_line: null,
    observed_at: new Date('2026-10-04T10:00:00Z'),
  })),
}));

import { query, queryOne } from '../client.js';
import { observeSession, recentLines } from './sessions.js';

describe('the last line a session printed', () => {
  it('is kept with secrets taken out, since the crew page reads it back', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    await observeSession({ botId: 'bot-1', taskId: null, name: 'implement-1', cmd: 'claude', state: 'working', pid: 7, lastLine: `echo ${token}` });

    const stored = vi.mocked(queryOne).mock.calls[0]?.[1] as unknown[];
    expect(String(stored[6])).not.toContain(token);
  });
});

describe('the latest lines of several sessions', () => {
  it('are read in one query, the newest few of each, and given back oldest first by session', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { session_id: 's-1', line: '[tool] Read: src/prices.ts' },
      { session_id: 's-1', line: '[tool] Bash: pnpm test' },
      { session_id: 's-2', line: '[tool] Bash: gh pr diff 31' },
    ]);
    const lines = await recentLines(['s-1', 's-2', 's-3'], 20);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    const statement = String(sql).replace(/\s+/g, ' ');
    expect(statement).toContain('row_number() over (partition by session_id order by seq desc) as n');
    expect(statement).toContain('where session_id = any($1::uuid[])');
    expect(statement).toContain('where n <= $2 order by session_id, seq');
    expect(params).toEqual([['s-1', 's-2', 's-3'], 20]);
    expect(lines).toEqual(
      new Map([
        ['s-1', ['[tool] Read: src/prices.ts', '[tool] Bash: pnpm test']],
        ['s-2', ['[tool] Bash: gh pr diff 31']],
      ]),
    );
  });

  it('asks nothing for no sessions', async () => {
    vi.mocked(query).mockClear();
    expect(await recentLines([], 20)).toEqual(new Map());
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});
