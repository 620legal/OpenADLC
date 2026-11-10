import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({ leases: { setLeaseState: vi.fn(async () => null) } }));

import { leases } from '@openadlc/db';
import { startBuild, utcTime } from './build-start.js';

/**
 * The lease comment said "until 2026-11-09T08:49:00.000Z", and a lease that
 * holds a pull request never expires: a card held for 21 hours read as a
 * lease long run out (ADR 0046).
 */
const NOW = new Date('2026-11-10T08:00:00.000Z');

function start(extra: Partial<Parameters<typeof startBuild>[1]> = {}) {
  const automation = { assignIssue: vi.fn(async () => undefined), comment: vi.fn(async () => 'url') };
  const taskService = { open: vi.fn(async () => ({ taskId: 'task-1', session: 's' })) };
  const run = startBuild(
    { taskService: taskService as never, automation: automation as never, now: () => NOW },
    {
      leaseId: 'lease-1',
      repo: { name: 'OpenADLC', fullName: '620legal/OpenADLC' },
      issue: 274,
      bot: { id: 'bot-builder', name: 'builder' },
      declaredPaths: ['apps/bridge/src/waiting.ts'],
      expiresAt: '2026-11-10T08:49:00.000Z',
      ...extra,
    },
  );
  return { run, automation, taskService };
}

const comment = (automation: ReturnType<typeof start>['automation']) => String((automation.comment.mock.calls[0] as unknown[] | undefined)?.[2]);

beforeEach(() => vi.mocked(leases.setLeaseState).mockClear());

describe('the lease comment', () => {
  it('gives no time when it goes on from an open pull request, and says it holds until that merges or closes', async () => {
    const { run, automation } = start({ continueBranch: 'agent/builder/274-issue-274', continuePull: 281 });
    await run;
    const said = comment(automation);
    expect(said).toBe(
      'Leased to `builder`. Going on from branch `agent/builder/274-issue-274`, whose pull request #281 is still open; the lease holds until that pull request merges or closes.',
    );
    expect(said).not.toMatch(/\d\d:\d\d/);
    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-1', 'in_task');
  });

  it('gives a fresh lease’s time as the deadline for a pull request to open, in UTC', async () => {
    const { run, automation } = start();
    await run;
    expect(comment(automation)).toBe(
      'Leased to `builder`. Working on branch `agent/builder/274-issue-274`. If no pull request opens by 08:49 UTC, the lease lets go; once one opens, it holds until the pull request merges or closes.',
    );
    expect(comment(automation)).not.toContain('2026-11-10T');
  });

  it('says the same on a build gone on from its branch, and on a stacked one', async () => {
    const going = start({ continueBranch: 'agent/builder/274-issue-274' });
    await going.run;
    expect(comment(going.automation)).toContain('where the last build stopped before opening its pull request. If no pull request opens by 08:49 UTC');
    const stacked = start({ stackOn: { issue: 273, pr: 278, branch: 'agent/builder/273-issue-273' } });
    await stacked.run;
    expect(comment(stacked.automation)).toContain('it merges after #278. If no pull request opens by 08:49 UTC');
  });
});

describe('a time in a comment', () => {
  it('is HH:MM UTC today, with the date on another day, and nothing for one that is not a time', () => {
    expect(utcTime('2026-11-10T23:05:00.000Z', NOW)).toBe('23:05 UTC');
    expect(utcTime('2026-11-11T00:30:00.000Z', NOW)).toBe('2026-11-11 00:30 UTC');
    expect(utcTime('soon', NOW)).toBeNull();
  });
});
