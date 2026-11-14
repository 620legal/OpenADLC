import type { TaskDatabaseView } from '../../hostd-client.js';
import type { HealthCheck } from '../types.js';

/** The card's title, which the docs repeat. */
export const TASK_DATABASE_TITLE = 'Tasks are starting without a database';

/**
 * A seat that runs checks (`sidecarDb`) gets a database for each task on the
 * host's task database server. When that server cannot start, the task
 * starts anyway, with no database, and its `make ci` runs without one. That
 * was the only sign: a second install on one machine asked Docker for the
 * first's port, and `openadlc doctor` and `status` both called it healthy.
 *
 * hostd owns the container, so hostd says how it is (`GET /task-database`).
 * Asking also has hostd start a server that nothing has asked for yet, or
 * one that failed. hostd not answering is the `hostd` check's card, and a
 * server still starting is not a failure yet, so neither one answers here.
 */
export function taskDatabaseCheck(deps: {
  crew: () => Promise<{ name: string; sidecarDb: boolean }[]>;
  taskDatabase: () => Promise<TaskDatabaseView>;
}): HealthCheck {
  return {
    id: 'task-database',
    proves: 'Each task of a seat that runs checks gets a database of its own',
    how: 'asks hostd how the host’s task database server is, when any seat has sidecarDb on',
    everyMinutes: 5,
    steps: [],
    async run() {
      const seats = (await deps.crew()).filter((bot) => bot.sidecarDb).map((bot) => bot.name);
      if (seats.length === 0) return [{ ok: true }];
      const view = await deps.taskDatabase().catch(() => null);
      if (!view) return [{ ok: null, reason: 'hostd is not answering, so its task database server is not known' }];
      if (view.state === 'none') return [{ ok: null, reason: 'hostd runs the local driver, which has no task database server' }];
      if (view.state === 'idle' || view.state === 'starting') {
        return [{ ok: null, reason: `the task database server is ${view.state === 'idle' ? 'not started yet' : 'starting'}` }];
      }
      if (view.state === 'running') return [{ ok: true, fixed: 'Tasks get a database again' }];

      const port = view.port ?? 47433;
      const holders = view.holders ?? [];
      return [
        {
          ok: false,
          severity: 'blocking',
          title: TASK_DATABASE_TITLE,
          detail:
            `${seats.join(', ')} ${seats.length === 1 ? 'has' : 'have'} sidecarDb on, but ` +
            `the task database server${view.container ? ` (${view.container})` : ''} on port ${port} is not running, ` +
            'so each task they start runs its checks with no database. ' +
            (view.error ? `hostd said: ${view.error}. ` : '') +
            (holders.length > 0 ? `Port ${port} is published by ${holders.join(', ')}. ` : '') +
            'Set ports.taskdb in install.json to a free port, e.g. 48433, then run `openadlc down && openadlc up`, ' +
            'while no task is running: moving the port drops the databases of tasks running then.',
          action: { label: 'Move the task database port', command: 'openadlc down && openadlc up' },
          facts: { port, ...(view.container ? { container: view.container } : {}), holders },
        },
      ];
    },
  };
}
