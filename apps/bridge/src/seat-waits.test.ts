import { describe, expect, it } from 'vitest';
import { seatWaitFrom, standingSeatWaits } from './seat-waits.js';

/**
 * Which issues wait on a busy seat, as the board reads it from the
 * `stage.waiting_on_seat` events: until a task starts on the issue, or it
 * leaves the stage it waited in.
 */

const WAIT = { subjectRef: 'openadlc#141', repo: 'openadlc', issue: 141, stage: 'spec', seat: 'openadlc-sage-janedoe', botId: 'bot-spec', maxTasks: 1 };
const IN_DESIGN = [{ repoName: 'openadlc', number: 141, stage: 'spec' }];

describe('an issue a busy seat turned away', () => {
  it('waits on that seat, since it was turned away', () => {
    const standing = standingSeatWaits([{ at: '2026-10-23T13:46:34.000Z', payload: WAIT }], IN_DESIGN, [
      // #137's design, which held the seat: another issue's task.
      { subjectRef: 'openadlc#137', createdAt: '2026-10-23T06:00:00.000Z' },
    ]);

    expect([...standing.values()]).toEqual([{ ...WAIT, since: '2026-10-23T13:46:34.000Z' }]);
  });

  it('is no longer waiting once a task starts on it', () => {
    const standing = standingSeatWaits([{ at: '2026-10-23T13:46:34.000Z', payload: WAIT }], IN_DESIGN, [
      { subjectRef: 'openadlc#141', createdAt: '2026-10-23T13:47:29.000Z' },
    ]);

    expect(standing.size).toBe(0);
  });

  it('is no longer waiting once it has left the stage it waited in, or the board', () => {
    const events = [{ at: '2026-10-23T13:46:34.000Z', payload: WAIT }];

    expect(standingSeatWaits(events, [{ repoName: 'openadlc', number: 141, stage: 'build' }], []).size).toBe(0);
    expect(standingSeatWaits(events, [], []).size).toBe(0);
  });

  it('waits since the first time it was turned away after its last task, across a restart that said it again', () => {
    const standing = standingSeatWaits(
      [
        { at: '2026-10-23T15:00:00.000Z', payload: { ...WAIT, seat: 'openadlc-sage-renamed' } },
        { at: '2026-10-23T14:00:00.000Z', payload: WAIT },
        // Before its last task: that wait ended when the task started.
        { at: '2026-10-23T09:00:00.000Z', payload: WAIT },
      ],
      IN_DESIGN,
      [{ subjectRef: 'openadlc#141', createdAt: '2026-10-23T10:00:00.000Z' }],
    );

    expect(standing.get('openadlc#141')).toEqual({ ...WAIT, seat: 'openadlc-sage-renamed', since: '2026-10-23T14:00:00.000Z' });
  });

  it('reads nothing from an event that does not say a wait', () => {
    expect(seatWaitFrom({ at: '2026-10-23T13:46:34.000Z', payload: null })).toBeNull();
    expect(seatWaitFrom({ at: '2026-10-23T13:46:34.000Z', payload: { subjectRef: 'openadlc#141' } })).toBeNull();
  });
});
