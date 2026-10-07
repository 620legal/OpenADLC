import { describe, expect, it } from 'vitest';
import { deployDispatchCheck, type UndispatchedStep } from './deploy-dispatch.js';

/**
 * A promote or rollback whose dispatch kept failing was a log line and
 * nothing else. The check reads the steps the store says are still owed
 * (`deployRuns.undispatchedSince`) and puts each on the board.
 */

const REPO = { id: 'repo-1', name: 'app', fullName: 'exampleco/app' };
const NOW = new Date('2026-09-30T13:00:00Z');

function check(stuck: UndispatchedStep[]) {
  const asked: Date[] = [];
  const subject = deployDispatchCheck({
    undispatched: async (before) => {
      asked.push(before);
      return stuck;
    },
    repos: async () => [REPO],
    workflow: async (_repo, step) => (step === 'rollback' ? 'rollback-production' : 'promote-production'),
  });
  return { subject, asked };
}

describe('a deploy step that was never dispatched', () => {
  it('is a card a quarter of an hour after it was due, naming the repository, the commit, the workflow and GitHub’s reason', async () => {
    const { subject, asked } = check([
      { step: 'promote', run: { repoId: REPO.id, sha: 'abc1234def', detail: 'promote-production not dispatched: 502 Bad Gateway' } },
      { step: 'rollback', run: { repoId: REPO.id, sha: 'def5678abc', detail: 'rollback-production not dispatched: 403 rate limit' } },
    ]);

    const [promote, rollback] = await subject.run(NOW);

    expect(asked).toEqual([new Date('2026-09-30T12:45:00Z')]);
    expect(promote).toMatchObject({
      subject: 'app@abc1234:promote',
      ok: false,
      severity: 'warning',
      title: 'app: promote-production of abc1234 has not been dispatched',
      detail: expect.stringContaining('promote-production not dispatched: 502 Bad Gateway'),
      action: { url: 'https://github.com/exampleco/app/actions' },
    });
    expect(rollback).toMatchObject({
      subject: 'app@def5678:rollback',
      ok: false,
      severity: 'blocking',
      title: 'app: rollback-production of def5678 has not been dispatched',
      detail: expect.stringContaining('403 rate limit'),
    });
  });

  it('passes again once the step is dispatched: the store no longer returns it', async () => {
    const { subject } = check([]);
    expect(await subject.run(NOW)).toEqual([]);
  });
});

describe('a rollback that was dispatched and did not finish well', () => {
  function checking(unfinished: { repoId: string; sha: string; rollbackConclusion: string | null; rollbackTrouble: string | null }[]) {
    return deployDispatchCheck({
      undispatched: async () => [],
      unfinishedRollbacks: async () => unfinished,
      repos: async () => [REPO],
      workflow: async () => 'rollback-production',
    });
  }

  it('is a blocking card while its last run was cancelled or never started, saying why', async () => {
    const [card] = await checking([{ repoId: REPO.id, sha: 'def5678abc', rollbackConclusion: null, rollbackTrouble: 'rollback-production run 91 was cancelled before it finished' }]).run(NOW);

    expect(card).toMatchObject({
      subject: 'app@def5678:rollback-run',
      ok: false,
      severity: 'blocking',
      title: 'app: rollback-production after def5678 did not run',
      detail: expect.stringContaining('run 91 was cancelled before it finished'),
    });
  });

  it('is a blocking card when it ran and failed', async () => {
    const [card] = await checking([{ repoId: REPO.id, sha: 'def5678abc', rollbackConclusion: 'failure', rollbackTrouble: null }]).run(NOW);

    expect(card).toMatchObject({ severity: 'blocking', title: 'app: rollback-production after def5678 failed' });
  });

  it('goes once one succeeds: the store no longer returns it', async () => {
    expect(await checking([]).run(NOW)).toEqual([]);
  });
});
