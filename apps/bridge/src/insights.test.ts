import { describe, expect, it } from 'vitest';
import { aggregateInsights, median, parallelBuilds, withoutIgnored } from './insights.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
const H = 60 * 60 * 1000;

const REPOS = [
  { id: 'repo-a', name: 'api' },
  { id: 'repo-b', name: 'web' },
];

function data(over: Partial<Parameters<typeof aggregateInsights>[0]> = {}): Parameters<typeof aggregateInsights>[0] {
  return { repos: REPOS, moves: [], builds: [], requests: [], landed: [], events: [], ...over };
}

describe('how fast work moves', () => {
  it('counts what merged in the window, from its request to its merge, and the time in each stage', () => {
    const moves = [
      { repoId: 'repo-a', issueNumber: 1, from: null, to: 'intake', kind: 'forward', at: hoursAgo(10) },
      { repoId: 'repo-a', issueNumber: 1, from: 'intake', to: 'build', kind: 'forward', at: hoursAgo(9) },
      { repoId: 'repo-a', issueNumber: 1, from: 'build', to: 'review', kind: 'forward', at: hoursAgo(7) },
      { repoId: 'repo-a', issueNumber: 1, from: 'review', to: 'merged', kind: 'forward', at: hoursAgo(6) },
      // Merged before the window: not counted.
      { repoId: 'repo-b', issueNumber: 2, from: 'review', to: 'merged', kind: 'forward', at: hoursAgo(24 * 9) },
    ];
    const requests = [{ repoId: 'repo-a', issueNumber: 1, createdAt: hoursAgo(11) }];
    const landed = [{ repoId: 'repo-a', prNumber: 5, enteredAt: hoursAgo(6.5), mergedAt: hoursAgo(6) }];

    const result = aggregateInsights(data({ moves, requests, landed }), { days: 7, now: NOW });

    expect(result.overall.merged).toBe(1);
    expect(result.overall.perDay).toBe(0.14);
    // From the request, an hour before the issue's first stage.
    expect(result.overall.cycleMs).toBe(5 * H);
    expect(result.overall.stages).toEqual({ intake: 1 * H, design: null, build: 2 * H, review: 1 * H, mergeLine: 0.5 * H });
    expect(result.repos.find((repo) => repo.repo === 'web')?.merged).toBe(0);
  });

  it('counts a merge in a repository that deploys nothing, whose issue goes from review straight to done', () => {
    // Read only as moves to merged, eight merges in a day counted as none.
    const moves = [
      { repoId: 'repo-a', issueNumber: 3, from: 'build', to: 'review', kind: 'forward', at: hoursAgo(3) },
      { repoId: 'repo-a', issueNumber: 3, from: 'review', to: 'done', kind: 'forward', at: hoursAgo(2) },
      // A merged issue later shipped is one merge, not two.
      { repoId: 'repo-a', issueNumber: 4, from: 'review', to: 'merged', kind: 'forward', at: hoursAgo(5) },
      { repoId: 'repo-a', issueNumber: 4, from: 'merged', to: 'done', kind: 'forward', at: hoursAgo(4) },
    ];
    expect(aggregateInsights(data({ moves }), { days: 7, now: NOW }).overall.merged).toBe(2);
  });

  it('counts send-backs in the window by the stage they left', () => {
    const moves = [
      { repoId: 'repo-a', issueNumber: 3, from: 'review', to: 'build', kind: 'send_back', at: hoursAgo(2) },
      { repoId: 'repo-a', issueNumber: 4, from: 'review', to: 'build', kind: 'send_back', at: hoursAgo(3) },
      { repoId: 'repo-a', issueNumber: 5, from: 'build', to: 'spec', kind: 'send_back', at: hoursAgo(4) },
    ];
    expect(aggregateInsights(data({ moves }), { days: 7, now: NOW }).overall.sendBacks).toEqual({ review: 2, build: 1 });
  });
});

describe('what holds it up', () => {
  it('names the files work waited on, how often and for how long, and suggests splitting one that held up three', () => {
    const wait = (issue: number, paths: string[], kind = 'building', at = hoursAgo(5)) => ({
      type: 'overlap.waited',
      at,
      payload: { repo: 'api', issue, on: [1], paths, kind },
    });
    const clear = (issue: number, waitedMs: number) => ({ type: 'overlap.cleared', at: hoursAgo(4), payload: { repo: 'api', issue, waitedMs } });
    const events = [
      wait(2, ['Makefile']),
      wait(3, ['Makefile', 'README.md']),
      wait(4, ['Makefile'], 'exclusive'),
      clear(2, 1 * H),
      clear(3, 2 * H),
      { type: 'conflict.resolved', at: hoursAgo(3), payload: { repo: 'api', pr: 9, review: 'lead-only' } },
      { type: 'conflict.resolved', at: hoursAgo(3), payload: { repo: 'api', pr: 10, review: 'full' } },
      { type: 'conflict.sent_back', at: hoursAgo(3), payload: { repo: 'api', pr: 11 } },
    ];

    const result = aggregateInsights(data({ events }), { days: 7, now: NOW });
    const api = result.repos.find((repo) => repo.repo === 'api')!;

    expect(api.overlap.waits).toBe(3);
    expect(api.overlap.byKind).toEqual({ exclusive: 1, building: 2 });
    expect(api.overlap.totalWaitMs).toBe(3 * H);
    expect(api.overlap.medianWaitMs).toBe(1.5 * H);
    expect(api.overlap.hotFiles[0]).toEqual({ path: 'Makefile', waits: 3, waitedMs: 3 * H });
    expect(api.overlap.hotFiles[1]).toEqual({ path: 'README.md', waits: 1, waitedMs: 2 * H });
    expect(api.conflicts).toEqual({ resolvedLeadOnly: 1, resolvedFull: 1, sentBack: 1, resolving: 0 });
    expect(result.suggestions).toEqual([
      { repo: 'api', path: 'Makefile', waits: 3, text: 'Makefile held up 3 builds this week — consider splitting it (include mk/*.mk, one file per feature)' },
    ]);
    // Another repository's events are not this one's.
    expect(result.repos.find((repo) => repo.repo === 'web')?.overlap.waits).toBe(0);
  });

  it('counts a conflict reviewed again in full once, not also as sent back to build', () => {
    const events = [
      { type: 'conflict.resolving', at: hoursAgo(4), payload: { repo: 'api', pr: 12, review: 'full' } },
      { type: 'conflict.resolved', at: hoursAgo(3), payload: { repo: 'api', pr: 12, review: 'full' } },
      { type: 'conflict.sent_back', at: hoursAgo(3), payload: { repo: 'api', pr: 12, why: 'a conflicted file is not a shared one' } },
      { type: 'conflict.resolving', at: hoursAgo(4), payload: { repo: 'api', pr: 13, review: 'lead-only' } },
      { type: 'conflict.resolved', at: hoursAgo(3), payload: { repo: 'api', pr: 13, review: 'full' } },
      { type: 'conflict.sent_back', at: hoursAgo(3), payload: { repo: 'api', pr: 13, why: 'the resolution changed files beyond the conflict' } },
      { type: 'conflict.sent_back', at: hoursAgo(2), payload: { repo: 'api', pr: 14, why: 'the pull request could not be read' } },
    ];
    const api = aggregateInsights(data({ events }), { days: 7, now: NOW }).repos.find((repo) => repo.repo === 'api')!;
    expect(api.conflicts).toMatchObject({ resolvedFull: 2, sentBack: 1 });
  });

  it('credits each wait’s time to the files that wait was on, not the issue’s last wait', () => {
    const events = [
      { type: 'overlap.waited', at: hoursAgo(10), payload: { repo: 'api', issue: 2, on: [1], paths: ['Makefile'], kind: 'building' } },
      { type: 'overlap.cleared', at: hoursAgo(8), payload: { repo: 'api', issue: 2, waitedMs: 100 * 60_000 } },
      { type: 'overlap.waited', at: hoursAgo(3), payload: { repo: 'api', issue: 2, on: [5], paths: ['README.md'], kind: 'building' } },
      { type: 'overlap.cleared', at: hoursAgo(2), payload: { repo: 'api', issue: 2, waitedMs: 60_000 } },
    ];

    const hot = aggregateInsights(data({ events }), { days: 7, now: NOW }).overall.overlap.hotFiles;

    expect(hot).toEqual([
      { path: 'Makefile', waits: 1, waitedMs: 100 * 60_000 },
      { path: 'README.md', waits: 1, waitedMs: 60_000 },
    ]);
  });

  it('reads nothing into an install with none of the events yet', () => {
    const result = aggregateInsights(data(), { days: 30, now: NOW });
    expect(result.overall).toMatchObject({ merged: 0, cycleMs: null, overlap: { waits: 0, medianWaitMs: null, hotFiles: [] } });
    expect(result.suggestions).toEqual([]);
  });

  it('narrows to one repository when asked', () => {
    const result = aggregateInsights(data(), { days: 7, now: NOW, repo: 'web' });
    expect(result.repos.map((repo) => repo.repo)).toEqual(['web']);
  });
});

describe('builds at once', () => {
  it('is the most running at one moment, and the average while any ran', () => {
    const builds = [
      { startedAt: hoursAgo(4), endedAt: hoursAgo(2) },
      { startedAt: hoursAgo(3), endedAt: hoursAgo(1) },
      // Back to back with the second: not three at once.
      { startedAt: hoursAgo(1), endedAt: null },
    ];
    // 4h→3h one, 3h→2h two, 2h→1h one, 1h→now one: 5 build-hours over 4 hours.
    expect(parallelBuilds(builds, NOW.getTime() - 7 * 24 * H, NOW.getTime())).toEqual({ max: 2, average: 1.25 });
    expect(parallelBuilds([], 0, NOW.getTime())).toEqual({ max: 0, average: 0 });
  });

  it('takes the middle of an even count as the mean of the two, rounded', () => {
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([1, 3])).toBe(2);
    expect(median([])).toBeNull();
  });
});

describe('an issue labelled fleetadlc:ignore', () => {
  it('counts in nothing: not its moves, its request, its pull request’s merge or what it waited on', () => {
    const merging = (issueNumber: number) => [
      { repoId: 'repo-a', issueNumber, from: 'build', to: 'review', kind: 'forward', at: hoursAgo(7) },
      { repoId: 'repo-a', issueNumber, from: 'review', to: 'merged', kind: 'forward', at: hoursAgo(6) },
    ];
    const all = data({
      moves: [...merging(1), ...merging(2)],
      requests: [{ repoId: 'repo-a', issueNumber: 2, createdAt: hoursAgo(11) }],
      landed: [
        { repoId: 'repo-a', prNumber: 5, enteredAt: hoursAgo(6.5), mergedAt: hoursAgo(6) },
        { repoId: 'repo-a', prNumber: 6, enteredAt: hoursAgo(8), mergedAt: hoursAgo(6) },
      ],
      events: [{ type: 'overlap.waited', at: hoursAgo(8), payload: { repo: 'janedoe/api', issue: 2, paths: ['Makefile'] } }],
    });
    const issues = (labels: string[]) => [
      { repoId: 'repo-a', repoName: 'api', number: 1, prNumber: 5, labels: [] },
      { repoId: 'repo-a', repoName: 'api', number: 2, prNumber: 6, labels },
    ];

    const counted = aggregateInsights(withoutIgnored(all, issues(['fleetadlc:ignore'])), { days: 7, now: NOW }).overall;
    expect(counted.merged).toBe(1);
    expect(counted.stages.mergeLine).toBe(0.5 * H);
    expect(counted.overlap.waits).toBe(0);

    // The label off, it counts again.
    const back = aggregateInsights(withoutIgnored(all, issues([])), { days: 7, now: NOW }).overall;
    expect(back.merged).toBe(2);
    expect(back.overlap.waits).toBe(1);
  });
});
