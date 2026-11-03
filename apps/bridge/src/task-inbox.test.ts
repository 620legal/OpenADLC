import { describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({
  bots: { getBotById: vi.fn() },
  taskInbox: { take: vi.fn(), release: vi.fn(), settle: vi.fn() },
  tasks: { getTask: vi.fn() },
  threads: { ensureThread: vi.fn(), addMessage: vi.fn() },
}));

import type { InboxRow } from '@openadlc/db';
import { TaskInbox } from './task-inbox.js';

/**
 * A person's message to a live task is read by its session, or — once the
 * task is no longer live — goes where it would have gone had it arrived then.
 */

function row(input: Partial<InboxRow & { fresh: boolean }> = {}): InboxRow & { fresh: boolean } {
  return {
    id: 'inbox-1',
    taskId: 'task-1',
    messageId: 'm-9',
    botId: 'b-builder',
    role: 'implement',
    subjectRef: 'app#5',
    sender: 'janedoe@example.com',
    senderAccess: 'user',
    text: 'Also handle the empty state.',
    githubUrl: 'https://github.com/acme/app/issues/5#issuecomment-9',
    state: 'queued',
    createdAt: '2026-11-02T12:00:00.000Z',
    settledAt: null,
    fresh: true,
    ...input,
  };
}

const READ = { item: { key: 'app#5' }, view: { stage: 'review' }, repo: { id: 'repo-app', name: 'app', fullName: 'acme/app' } } as never;

function inbox(rows: { take?: (InboxRow & { fresh: boolean })[]; release?: InboxRow[]; settle?: InboxRow[] } = {}) {
  const said: { row: InboxRow; text: string }[] = [];
  const start = vi.fn(async () => ({ kind: 'starts' as const, what: 'patch round 2 on pull request #7' }));
  const read = vi.fn(async () => READ);
  const store = {
    take: vi.fn(async () => rows.take ?? []),
    release: vi.fn(async () => rows.release ?? []),
    settle: vi.fn(async () => rows.settle ?? []),
  };
  const service = new TaskInbox({
    store,
    starts: { start },
    read,
    bot: async (id) => (id === 'b-builder' ? { name: 'builder' } : null),
    say: async (one, text) => void said.push({ row: one, text }),
  });
  return { service, store, start, read, said };
}

describe('a message its session takes', () => {
  it('is handed over in message.md’s words, as read while it worked, and the thread says it was read', async () => {
    const { service, store, said } = inbox({ take: [row()] });

    const taken = await service.take('task-1', 'take-1');

    expect(store.take).toHaveBeenCalledWith('task-1', 'take-1');
    expect(taken).toHaveLength(1);
    expect(taken[0]?.id).toBe('inbox-1');
    expect(taken[0]?.text).toMatch(/^# janedoe wrote to the builder in the OpenADLC console while you worked/);
    expect(taken[0]?.text).toContain('This message reached you while you worked');
    expect(taken[0]?.text.trim().endsWith('Also handle the empty state.')).toBe(true);
    // Never the sender's address.
    expect(taken[0]?.text).not.toContain('@example.com');
    expect(said).toEqual([{ row: expect.objectContaining({ messageId: 'm-9' }), text: 'read by its session' }]);
  });

  it('is nothing when nothing waits', async () => {
    const { service, said } = inbox();

    expect(await service.take('task-1', 'take-1')).toEqual([]);
    expect(said).toEqual([]);
  });

  it('is handed over again to a take asked twice, and the thread says it was read only the first time', async () => {
    const { service, said } = inbox({ take: [row({ fresh: false }), row({ id: 'inbox-2' })] });

    const taken = await service.take('task-1', 'take-1');

    expect(taken.map((one) => one.id)).toEqual(['inbox-1', 'inbox-2']);
    expect(said).toEqual([{ row: expect.objectContaining({ id: 'inbox-2' }), text: 'read by its session' }]);
  });

  it('is put back when its runner never got the take, and the thread takes back that it was read', async () => {
    const { service, store, said } = inbox({ release: [row()] });

    expect(await service.release('task-1', 'take-1')).toBe(1);

    expect(store.release).toHaveBeenCalledWith('task-1', 'take-1');
    expect(said).toEqual([{ row: expect.objectContaining({ messageId: 'm-9' }), text: 'not read after all: its session never got it' }]);
  });
});

describe('a message its task ended before reading', () => {
  it('runs as a new message would, from its own seat, words, sender and access, on the item as it is now', async () => {
    const { service, store, start, read } = inbox({ settle: [row({ state: 'returned' })] });

    expect(await service.settle('task-1')).toBe(1);

    expect(store.settle).toHaveBeenCalledWith('task-1');
    expect(read).toHaveBeenCalledWith('app#5');
    expect(start).toHaveBeenCalledWith({
      route: { bot: 'builder', botId: 'b-builder', role: 'implement', subject: 'app#5' },
      read: READ,
      text: 'Also handle the empty state.',
      identity: 'janedoe@example.com',
      access: 'user',
      message: { id: 'm-9', githubUrl: 'https://github.com/acme/app/issues/5#issuecomment-9' },
    });
  });

  it('is found by the sweep when no runner said its task ended: a cancel, or reconcile failing a silent host', async () => {
    vi.useFakeTimers();
    try {
      const { service, store, start } = inbox({ settle: [row({ state: 'returned' })] });

      const stop = service.sweep(30_000);
      await vi.advanceTimersByTimeAsync(0);
      // Once at start, for what waited through a restart, for every task.
      expect(store.settle).toHaveBeenCalledWith(undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.settle).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts nothing for a seat that is gone, and goes on with the rest', async () => {
    const { service, start } = inbox({ settle: [row({ botId: 'b-gone' }), row({ id: 'inbox-2' })] });

    expect(await service.settle()).toBe(2);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('goes on with the rest when one fails to start', async () => {
    const { service, start } = inbox({ settle: [row(), row({ id: 'inbox-2' })] });
    start.mockRejectedValueOnce(new Error('GitHub did not answer'));

    expect(await service.settle()).toBe(2);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
