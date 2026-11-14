import { describe, expect, it, vi } from 'vitest';
import type { TaskDatabaseView } from '../../hostd-client.js';
import { TASK_DATABASE_TITLE, taskDatabaseCheck } from './task-database.js';

/**
 * A second install on one machine had no task database server, because the
 * first held its port, and nothing said so: its tasks started with no
 * database and `doctor` called it healthy.
 */

const CREW = [
  { name: 'builder', sidecarDb: true },
  { name: 'reviewer', sidecarDb: false },
];

function check(view: TaskDatabaseView | Error, crew = CREW) {
  const taskDatabase = vi.fn(async () => {
    if (view instanceof Error) throw view;
    return view;
  });
  return { check: taskDatabaseCheck({ crew: async () => crew, taskDatabase }), taskDatabase };
}

describe('the task database check', () => {
  it('fails, blocking, naming the seats, what hostd said, the holders and ports.taskdb, while a sidecarDb seat exists and the server failed', async () => {
    const { check: failing } = check({
      state: 'failed',
      container: 'second-taskdb',
      port: 47433,
      error: 'could not start second-taskdb: port is already allocated',
      holders: ['openadlc-taskdb (install default)'],
    });

    const [result] = await failing.run(new Date());

    expect(result).toMatchObject({ ok: false, severity: 'blocking', title: TASK_DATABASE_TITLE });
    if (result?.ok !== false) throw new Error('expected a failure');
    expect(result.detail).toContain('builder has sidecarDb on');
    expect(result.detail).not.toContain('reviewer');
    expect(result.detail).toContain('port is already allocated');
    expect(result.detail).toContain('Port 47433 is published by openadlc-taskdb (install default)');
    expect(result.detail).toContain('ports.taskdb');
    expect(result.action).toEqual({ label: 'Move the task database port', command: 'openadlc down && openadlc up' });
  });

  it('passes while the server runs', async () => {
    const { check: running } = check({ state: 'running', container: 'openadlc-taskdb', port: 47433 });

    expect(await running.run(new Date())).toEqual([{ ok: true, fixed: 'Tasks get a database again' }]);
  });

  it('passes with no sidecarDb seat, without asking hostd', async () => {
    const { check: none, taskDatabase } = check({ state: 'failed' }, [{ name: 'reviewer', sidecarDb: false }]);

    expect(await none.run(new Date())).toEqual([{ ok: true }]);
    expect(taskDatabase).not.toHaveBeenCalled();
  });

  it('gives no answer when hostd does not answer, or the server is starting, not started, or not there under the local driver', async () => {
    for (const view of [
      new Error('hostd is not answering'),
      { state: 'starting' as const },
      { state: 'idle' as const },
      { state: 'none' as const },
    ]) {
      const [result] = await check(view).check.run(new Date());
      expect(result?.ok).toBeNull();
    }
  });
});
