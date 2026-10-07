import { describe, expect, it } from 'vitest';
import type { Bot } from '@fleetadlc/shared';
import { blockersOf, causeOfFailure, crewChecks, isPrerequisiteRow, waitingOnBlocked, type HealthAnswer, type SigningReader } from './crew.js';

/**
 * What a task needs before it can start, read from the checks' last answers,
 * and which failed tasks a passing check explains.
 */

const SEAT = { id: 'bot-security', name: 'fleetadlc-cipher-janedoe' };
const failing = (id: string, detail = 'Do the thing.'): HealthAnswer => ({ id, state: 'failing', title: 'Title', detail });

describe('which rows decide whether a bot can work', () => {
  it('are the sign-in, the access to a repository and the host service, whoever they are about', () => {
    expect(isPrerequisiteRow('bot-sign-in:bot-security')).toBe(true);
    expect(isPrerequisiteRow('bot-access:bot-security:fleetadlc')).toBe(true);
    expect(isPrerequisiteRow('hostd')).toBe(true);
  });

  it('are not the webhook, the app’s permissions or a model account', () => {
    expect(isPrerequisiteRow('webhook')).toBe(false);
    expect(isPrerequisiteRow('app-permissions:issues')).toBe(false);
    expect(isPrerequisiteRow('engine-sign-in:claude')).toBe(false);
  });
});

describe('what keeps a seat from working', () => {
  it('is nothing when every row passes or is not about it', () => {
    const rows: HealthAnswer[] = [
      { id: 'bot-sign-in:bot-security', state: 'ok', title: null, detail: null },
      failing('bot-sign-in:bot-lead'),
      failing('bot-access:bot-lead:fleetadlc'),
      failing('bot-access:bot-security:other-repo'),
    ];
    expect(blockersOf(rows, SEAT, 'fleetadlc')).toEqual([]);
  });

  it('is its own sign-in, with what the card tells a person to do', () => {
    expect(blockersOf([failing('bot-sign-in:bot-security', 'Reconnect it.')], SEAT, 'fleetadlc')).toEqual([
      { row: 'bot-sign-in:bot-security', kind: 'sign-in', why: 'fleetadlc-cipher-janedoe cannot sign in to GitHub', instruction: 'Reconnect it.' },
    ]);
  });

  it('is its access to the repository the task is in, and only that one', () => {
    const rows = [failing('bot-access:bot-security:fleetadlc', 'Invite it.')];
    expect(blockersOf(rows, SEAT, 'fleetadlc').map((blocker) => blocker.why)).toEqual(['fleetadlc-cipher-janedoe cannot work in fleetadlc']);
    expect(blockersOf(rows, SEAT, 'other')).toEqual([]);
    expect(blockersOf(rows, SEAT, null)).toEqual([]);
  });

  it('is the host service for every seat, listed after the seat’s own', () => {
    const rows = [failing('hostd'), failing('bot-sign-in:bot-security')];
    expect(blockersOf(rows, SEAT, 'fleetadlc').map((blocker) => blocker.kind)).toEqual(['sign-in', 'host']);
  });

  it('falls back to the title when a row has no detail', () => {
    const rows: HealthAnswer[] = [{ id: 'hostd', state: 'failing', title: 'hostd is down', detail: null }];
    expect(blockersOf(rows, SEAT, null)[0]?.instruction).toBe('hostd is down');
  });
});

describe('a gate that waits on seats that cannot work', () => {
  const blocked = new Map([
    ['fleetadlc-cipher-janedoe', blockersOf([failing('bot-sign-in:bot-security')], SEAT, 'fleetadlc')],
    ['fleetadlc-atlas-janedoe', blockersOf([failing('hostd')], { id: 'bot-atlas', name: 'fleetadlc-atlas-janedoe' }, 'fleetadlc')],
  ]);

  it('names the reviewer account and what is wrong with it', () => {
    expect(waitingOnBlocked('waiting on fleetadlc-sydney-janedoe, fleetadlc-cipher-janedoe', blocked)).toBe(
      'waiting on the reviewer account: fleetadlc-cipher-janedoe cannot sign in to GitHub',
    );
  });

  it('names the host service when that is all that is wrong', () => {
    expect(waitingOnBlocked('waiting on fleetadlc-atlas-janedoe', blocked)).toBe('waiting on the host service: OpenADLC’s host service is not answering');
  });

  it('says a paused seat as one a person paused, not as the host or an account', () => {
    const paused = new Map([
      ['fleetadlc-vega-janedoe', [{ row: 'seat-paused:fleetadlc-vega-janedoe', kind: 'paused' as const, why: 'fleetadlc-vega-janedoe is paused by janedoe: changing its model', instruction: 'Resume it on the Crew page.' }]],
    ]);
    expect(waitingOnBlocked('waiting on fleetadlc-vega-janedoe', paused)).toBe('waiting on a paused seat: fleetadlc-vega-janedoe is paused by janedoe: changing its model');
  });

  it('leads with the account when both are wrong, and leaves the host out until the account is fixed', () => {
    expect(waitingOnBlocked('waiting on fleetadlc-atlas-janedoe, fleetadlc-cipher-janedoe', blocked)).toBe(
      'waiting on the reviewer account: fleetadlc-cipher-janedoe cannot sign in to GitHub',
    );
  });

  it('is null for a gate that waits on nobody blocked, on people, or on something else', () => {
    expect(waitingOnBlocked('waiting on fleetadlc-sydney-janedoe', blocked)).toBeNull();
    expect(waitingOnBlocked('waiting on @janedoe', blocked)).toBeNull();
    expect(waitingOnBlocked('changes requested', blocked)).toBeNull();
  });
});

describe('the check a failed task’s words point at', () => {
  const task = { botId: 'bot-security', repoName: 'fleetadlc' };

  it.each([
    ['fetch failed: Bad credentials', 'bot-sign-in:bot-security'],
    ['fleetadlc-cipher-janedoe is not connected to GitHub. Run: fleetadlc auth login --bot fleetadlc-cipher-janedoe', 'bot-sign-in:bot-security'],
    ['remote: Permission to exampleco/fleetadlc denied to fleetadlc-cipher-janedoe.', 'bot-access:bot-security:fleetadlc'],
    ['fatal: repository not found', 'bot-access:bot-security:fleetadlc'],
    ['the host stopped reporting', 'hostd'],
    ['hostd did not answer', 'hostd'],
    ['hostd refused: fetch failed', 'hostd'],
    ['fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot sign in to GitHub. Reconnect it.', 'bot-sign-in:bot-security'],
    ['fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot work in fleetadlc. Invite it.', 'bot-access:bot-security:fleetadlc'],
    ['fleetadlc-cipher-janedoe was not started: OpenADLC’s host service is not answering. Run fleetadlc up.', 'hostd'],
    [
      'fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot sign in to GitHub and OpenADLC’s host service is not answering. Reconnect it.',
      'bot-sign-in:bot-security',
    ],
  ])('%s is %s', (reason, row) => {
    expect(causeOfFailure(reason, task)).toBe(row);
  });

  it('does not take a refused connection for hostd when it could have been anything the task connected to', () => {
    expect(causeOfFailure('connect ECONNREFUSED 127.0.0.1:5432', task)).toBeNull();
    expect(causeOfFailure('engine exited 1: connect ECONNREFUSED 10.0.0.2:443', task)).toBeNull();
  });

  it('is nothing for a failure no check proves: a test that failed, a model account, or no reason at all', () => {
    expect(causeOfFailure('vitest exited with code 1', task)).toBeNull();
    expect(causeOfFailure('Claude is signed out', task)).toBeNull();
    expect(causeOfFailure(null, task)).toBeNull();
    expect(causeOfFailure(undefined, task)).toBeNull();
  });

  it('cannot say a repository’s access without knowing the repository', () => {
    expect(causeOfFailure('fatal: repository not found', { botId: 'bot-security', repoName: null })).toBeNull();
  });
});

describe('a crew account with more than its role needs', () => {
  const builder = { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe' } as Bot;

  /** Only what the access check reads: the crew, a repository, and what GitHub says the account may do there. */
  const reader = (permissions: Record<string, boolean>) =>
    ({
      crew: async () => [builder],
      repositories: async () => [{ name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' }],
      credential: async () => ({ kind: 'refresh', status: 'active' }),
      token: async () => 'token',
      github: () => ({ request: async <T>() => ({ permissions, owner: { type: 'Organization' } }) as T }),
    }) as unknown as SigningReader;

  it.each(['admin', 'maintain'])('blocks on %s, which could ship to production past the testing check', async (role) => {
    // promote-production lets admin and maintain pass emergency_override;
    // crew seats are invited with write or triage, so one that gained more is
    // a bot that could promote an untested commit.
    const [result] = await crewChecks(reader({ [role]: true, push: true, triage: true, pull: true })).access.run(new Date());
    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: `The builder (fleetadlc-atlas-janedoe) has ${role} on exampleco/app`,
      detail: expect.stringContaining('could ship to production past the testing check'),
      action: { url: 'https://github.com/exampleco/app/settings/access' },
    });
  });

  it('passes exactly write', async () => {
    const [result] = await crewChecks(reader({ push: true, triage: true, pull: true })).access.run(new Date());
    expect(result).toMatchObject({ ok: true });
  });
});
