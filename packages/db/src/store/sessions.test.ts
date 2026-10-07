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

import { queryOne } from '../client.js';
import { observeSession } from './sessions.js';

describe('the last line a session printed', () => {
  it('is kept with secrets taken out, since the crew page reads it back', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    await observeSession({ botId: 'bot-1', taskId: null, name: 'implement-1', cmd: 'claude', state: 'working', pid: 7, lastLine: `echo ${token}` });

    const stored = vi.mocked(queryOne).mock.calls[0]?.[1] as unknown[];
    expect(String(stored[6])).not.toContain(token);
  });
});
