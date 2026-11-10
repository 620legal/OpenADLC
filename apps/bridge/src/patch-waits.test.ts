import { describe, expect, it } from 'vitest';
import { PATCH_ROUND_WAITING, patchWaitFrom, standingPatchWaits } from './patch-waits.js';

const payload = (extra: Record<string, unknown> = {}) => ({
  subjectRef: 'app#31',
  repo: 'app',
  pr: 31,
  issue: 7,
  botId: 'bot-builder',
  bot: 'builder',
  round: 1,
  by: 'openadlc',
  head: 'h1',
  busyWith: 'running `implement` on app#280',
  ...extra,
});
const inBuild = [{ repoName: 'app', number: 7, stage: 'build', prNumber: 31 }];

describe('a patch round waiting on its builder', () => {
  it('is recorded under its own event type, which the board reads', () => {
    expect(PATCH_ROUND_WAITING).toBe('patch.round_waiting');
  });

  it('reads an event as a wait, and passes over one that does not read as one', () => {
    expect(patchWaitFrom({ at: '2026-11-09T21:00:53Z', payload: payload() })).toMatchObject({ subjectRef: 'app#31', round: 1, since: '2026-11-09T21:00:53Z' });
    expect(patchWaitFrom({ at: '2026-11-09T21:00:53Z', payload: { subjectRef: 'app#31' } })).toBeNull();
    expect(patchWaitFrom({ at: '2026-11-09T21:00:53Z', payload: null })).toBeNull();
  });

  it('stands until a patch task is opened on its pull request at or after it', () => {
    const events = [{ at: '2026-11-09T21:00:53Z', payload: payload() }];
    expect(standingPatchWaits(events, inBuild, []).get('app#31')).toMatchObject({ since: '2026-11-09T21:00:53Z' });
    // A task of another kind, or on another subject, answers nothing.
    expect(
      standingPatchWaits(events, inBuild, [
        { subjectRef: 'app#31', kind: 'review', createdAt: '2026-11-09T22:00:00Z' },
        { subjectRef: 'app#280', kind: 'patch', createdAt: '2026-11-09T22:00:00Z' },
      ]).size,
    ).toBe(1);
    // A round from before it does not answer it either.
    expect(standingPatchWaits(events, inBuild, [{ subjectRef: 'app#31', kind: 'patch', createdAt: '2026-11-09T20:00:00Z' }]).size).toBe(1);
    expect(standingPatchWaits(events, inBuild, [{ subjectRef: 'app#31', kind: 'patch', createdAt: '2026-11-09T21:00:53Z' }]).size).toBe(0);
    expect(standingPatchWaits(events, inBuild, [{ subjectRef: 'app#31', kind: 'patch', createdAt: '2026-11-10T08:00:00Z' }]).size).toBe(0);
  });

  it('ends when the issue leaves Build, or is no longer on the board with that pull request', () => {
    const events = [{ at: '2026-11-09T21:00:53Z', payload: payload() }];
    expect(standingPatchWaits(events, [{ ...inBuild[0]!, stage: 'review' }], []).size).toBe(0);
    expect(standingPatchWaits(events, [{ ...inBuild[0]!, prNumber: 40 }], []).size).toBe(0);
    expect(standingPatchWaits(events, [], []).size).toBe(0);
  });

  it('of several events, takes since from the first and everything else from the newest', () => {
    const events = [
      { at: '2026-11-10T08:00:00Z', payload: payload({ by: 'lead-reviewer', head: 'h2', busyWith: 'running `review` on app#290', round: 2 }) },
      { at: '2026-11-09T21:00:53Z', payload: payload() },
    ];
    expect(standingPatchWaits(events, inBuild, []).get('app#31')).toMatchObject({
      since: '2026-11-09T21:00:53Z',
      by: 'lead-reviewer',
      head: 'h2',
      busyWith: 'running `review` on app#290',
      round: 2,
    });
    // Only the events after the newest round count: one the round answered is over.
    expect(standingPatchWaits(events, inBuild, [{ subjectRef: 'app#31', kind: 'patch', createdAt: '2026-11-09T22:00:00Z' }]).get('app#31')).toMatchObject({
      since: '2026-11-10T08:00:00Z',
    });
  });
});
