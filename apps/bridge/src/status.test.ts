import { describe, expect, it } from 'vitest';
import { STAGE_KEYS } from '@fleetadlc/shared';
import { renderStatusMarkdown, statusDrift, statusIssueTarget, type StatusReport } from './status.js';

const api = { fullName: 'org/api' };
const web = { fullName: 'org/web' };

describe('which issue FLEETADLC_STATUS_ISSUE names', () => {
  it('is nothing when unset, as before', () => {
    expect(statusIssueTarget(undefined, [api, web])).toBeNull();
    expect(statusIssueTarget('', [api, web])).toBeNull();
    expect(statusIssueTarget('  ', [api, web])).toBeNull();
  });

  it('is the named repository’s issue, whatever else is managed, matched without regard to case', () => {
    expect(statusIssueTarget('org/web#12', [api, web])).toEqual({ repo: 'org/web', number: 12 });
    expect(statusIssueTarget('Org/Web#12', [api, web])).toEqual({ repo: 'org/web', number: 12 });
  });

  it('refuses a bare number even on an install with one repository, whose meaning would move when a second is added', () => {
    for (const managed of [[web], [api, web]]) {
      expect(statusIssueTarget('12', managed)).toEqual({ refusal: expect.stringContaining('it must be <owner>/<name>#<number>') });
      expect(statusIssueTarget('#12', managed)).toEqual({ refusal: expect.stringContaining('it must be <owner>/<name>#<number>') });
    }
  });

  it('refuses a repository the install does not manage, and a value that names no issue', () => {
    expect(statusIssueTarget('someone/else#12', [api, web])).toEqual({
      refusal: expect.stringContaining('which this install does not manage; it must be <owner>/<name>#<number>'),
    });
    for (const value of ['org/web', 'twelve', 'org/web#0', 'org/web#x', 'org/web#12 ', ' org/web#12', 'org/web#12x', 'org/web# 12']) {
      expect(statusIssueTarget(value, [api, web]), value).toEqual({ refusal: expect.stringContaining('it must be <owner>/<name>#<number>') });
    }
  });
});

describe('the status issue’s body', () => {
  const bot = (name: string, now: string, subjectRef: string | null, paused = false): StatusReport['crew'][number] => ({
    name,
    displayName: name,
    role: 'implement',
    engine: 'claude',
    status: 'active',
    now,
    subjectRef,
    paused,
    githubLogin: null,
    authorization: 'active',
    sessions: 1,
  });
  const status: StatusReport = {
    generatedAt: '2026-10-01T00:00:00.000Z',
    hosts: [{ name: 'build-box-7', driver: 'docker', status: 'online', lastSeenAt: null }],
    hostd: { ok: true, driver: 'docker' },
    crew: [
      bot('builder', 'implement on web#41', 'web#41'),
      bot('builder-2', 'implement on api#9', 'api#9'),
      bot('builder-3', 'implement on api#10 (waiting on a person)', 'api#10', true),
      bot('lead', 'nothing running', null),
    ],
    board: Object.fromEntries(STAGE_KEYS.map((stage) => [stage, 1])) as StatusReport['board'],
    budget: { period: '2026-10', capUsd: 100, spentUsd: 12.5, state: 'ok' },
    openGates: 2,
    activeLeases: 3,
    recentEvents: [],
    identity: { mode: 'local', detail: '' },
    jobs: [],
  };

  it('shows only the target repository’s subjects, and names no host', () => {
    const body = renderStatusMarkdown(status, { repo: 'org/web' });
    expect(body).toContain('| implement on web#41 |');
    expect(body).toContain('| builder-2 | implement | claude | working in another repository |');
    expect(body).toContain('| working in another repository (waiting on a person) |');
    expect(body).toContain('| nothing running |');
    expect(body).not.toMatch(/api#/);
    expect(body).not.toContain('build-box-7');
    expect(body).not.toContain('**Host:**');
    expect(body).toContain('$12.50 of $100.00');
  });
});

describe('the drift the status issue gets', () => {
  it('is the target repository’s, by issue, name or full name; the rest that need a person are only counted', () => {
    const drift = [
      { kind: 'stage_mismatch', subject: 'web#3', detail: 'a', repaired: false },
      { kind: 'stage_mismatch', subject: 'web#4', detail: 'b', repaired: true },
      { kind: 'github_unreadable', subject: 'web', detail: 'c', repaired: false },
      { kind: 'github_unreadable', subject: 'org/web', detail: 'd', repaired: false },
      { kind: 'stage_mismatch', subject: 'webapp#5', detail: 'e', repaired: false },
      { kind: 'stage_mismatch', subject: 'api#41', detail: 'f', repaired: false },
      { kind: 'stage_mismatch', subject: 'api#42', detail: 'g', repaired: true },
      { kind: 'stale_host', subject: 'hostd', detail: 'h', repaired: false },
      { kind: 'orphaned_task', subject: 'builder', detail: 'i', repaired: false },
    ] as Parameters<typeof statusDrift>[0];
    const { entries, others } = statusDrift(drift, { repo: 'org/web' });
    expect(entries.map((entry) => entry.subject)).toEqual(['web#3', 'web#4', 'web', 'org/web']);
    expect(others).toBe(4);
  });
});
