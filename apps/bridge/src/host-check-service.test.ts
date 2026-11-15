import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostCheckRun } from '@openadlc/db';

vi.mock('@openadlc/db', () => ({
  repos: { getHostCheck: vi.fn() },
  hostCheckRuns: { forPull: vi.fn(), start: vi.fn(), finish: vi.fn(), carry: vi.fn(), running: vi.fn() },
}));

import { hostCheckRuns, repos } from '@openadlc/db';
import { HostCheckService, crewApprovedHead, hostCheckCardView, type HostCheckServiceDeps } from './host-check-service.js';

const HEAD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);
const REPO = { id: 'repo-1', name: 'mac-app', fullName: 'acme/mac-app' };
const SETTING = { command: 'make host-ci', timeoutMinutes: 90, required: true };

function run(extra: Partial<HostCheckRun> = {}): HostCheckRun {
  return {
    id: '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10',
    runId: 'run-1',
    repoId: 'repo-1',
    repoName: 'mac-app',
    repoFullName: 'acme/mac-app',
    prNumber: 7,
    headSha: HEAD,
    state: 'running',
    carriedFrom: null,
    command: 'make host-ci',
    timeoutMinutes: 90,
    exitCode: null,
    durationMs: null,
    logTail: null,
    reason: null,
    startedAt: '2026-11-14T10:00:00.000Z',
    finishedAt: null,
    ...extra,
  };
}

function service(extra: Partial<HostCheckServiceDeps> = {}) {
  const hostd = {
    startHostCheck: vi.fn(async () => ({ run: {} as never })),
    hostCheckRun: vi.fn(async (_runId: string) => ({ run: {} as never })),
    cancelHostCheck: vi.fn(async () => ({ cancelled: true })),
    hostCheckAccount: vi.fn(async () => ({ probe: { ok: true as const, account: 'openadlc-hostcheck', uid: 502, home: '/Users/openadlc-hostcheck' } })),
  };
  const postStatus = vi.fn(async () => undefined);
  const fingerprint = vi.fn(async (_repo: string, _base: string, sha: string) => (sha === HEAD || sha === EARLIER ? 'same-diff' : 'other'));
  const deps: HostCheckServiceDeps = {
    hostd,
    postStatus,
    fingerprint,
    fetchBot: async () => 'atlas',
    consoleUrl: 'http://localhost:47310',
    newId: () => 'run-new',
    warn: () => undefined,
    ...extra,
  };
  return { service: new HostCheckService(deps), hostd, postStatus, fingerprint };
}

beforeEach(() => {
  vi.mocked(repos.getHostCheck).mockReset().mockResolvedValue(SETTING);
  vi.mocked(hostCheckRuns.forPull).mockReset().mockResolvedValue([]);
  vi.mocked(hostCheckRuns.start).mockReset().mockImplementation(async (input) => run({ runId: input.runId, headSha: input.headSha, state: input.state ?? 'running', reason: input.reason ?? null, id: `id-${input.runId}` }));
  vi.mocked(hostCheckRuns.finish).mockReset().mockResolvedValue(null);
  vi.mocked(hostCheckRuns.carry).mockReset().mockImplementation(async (input) => run({ state: 'carried', carriedFrom: input.from, headSha: input.headSha, id: 'carried-id' }));
  vi.mocked(hostCheckRuns.running).mockReset().mockResolvedValue([]);
});

describe('asking for a host check', () => {
  it('runs the command and limit from the repository’s settings, whatever the pull request says', async () => {
    const { service: hostChecks, hostd, postStatus } = service();
    // Nothing of the pull request is read: its body, branch and files are not even given.
    const line = await hostChecks.request(REPO, 7, HEAD, 'main');
    expect(hostd.startHostCheck).toHaveBeenCalledWith({ runId: 'run-new', repo: 'acme/mac-app', pr: 7, head: HEAD, command: 'make host-ci', timeoutMinutes: 90, bot: 'atlas' });
    expect(hostCheckRuns.start).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-new', command: 'make host-ci', timeoutMinutes: 90, headSha: HEAD }));
    expect(postStatus).toHaveBeenCalledWith('acme/mac-app', HEAD, { state: 'pending', description: 'running make host-ci', targetUrl: 'http://localhost:47310/host-checks/id-run-new' });
    expect(line).toContain('host check started');
  });

  it('does nothing for a repository with no host check', async () => {
    vi.mocked(repos.getHostCheck).mockResolvedValue(null);
    const { service: hostChecks, hostd } = service();
    await expect(hostChecks.request(REPO, 7, HEAD, 'main')).resolves.toBeNull();
    expect(hostd.startHostCheck).not.toHaveBeenCalled();
  });

  it.each(['running', 'passed', 'failed', 'carried'] as const)('starts nothing on a head that already has a %s run', async (state) => {
    vi.mocked(hostCheckRuns.forPull).mockResolvedValue([run({ state })]);
    const { service: hostChecks, hostd } = service();
    await expect(hostChecks.request(REPO, 7, HEAD, 'main')).resolves.toBeNull();
    expect(hostd.startHostCheck).not.toHaveBeenCalled();
  });

  it('carries a pass to a new head with the same changes, saying where it came from, and builds nothing', async () => {
    vi.mocked(hostCheckRuns.forPull).mockResolvedValue([run({ headSha: EARLIER, state: 'passed' })]);
    const { service: hostChecks, hostd, postStatus } = service();
    const line = await hostChecks.request(REPO, 7, HEAD, 'main');
    expect(hostd.startHostCheck).not.toHaveBeenCalled();
    expect(hostCheckRuns.carry).toHaveBeenCalledWith(expect.objectContaining({ headSha: HEAD, from: EARLIER }));
    expect(postStatus).toHaveBeenCalledWith('acme/mac-app', HEAD, expect.objectContaining({ state: 'success', description: `passed on ${EARLIER.slice(0, 7)}, which has the same changes` }));
    expect(line).toContain('carried');
  });

  it('runs a new head whose changes differ from the head that passed', async () => {
    vi.mocked(hostCheckRuns.forPull).mockResolvedValue([run({ headSha: EARLIER, state: 'passed' })]);
    const { service: hostChecks, hostd } = service({ fingerprint: async (_repo, _base, sha) => sha });
    await hostChecks.request(REPO, 7, HEAD, 'main');
    expect(hostCheckRuns.carry).not.toHaveBeenCalled();
    expect(hostd.startHostCheck).toHaveBeenCalled();
  });

  it('does not run while the account is not fit, and says what to do once per head', async () => {
    const { service: hostChecks, hostd, postStatus } = service();
    hostd.hostCheckAccount.mockResolvedValue({ probe: { ok: false, account: 'openadlc-hostcheck', problem: 'can_read', path: '/Users/jane/.openadlc', detail: 'openadlc-hostcheck can read /Users/jane/.openadlc' } } as never);
    const line = await hostChecks.request(REPO, 7, HEAD, 'main');
    expect(hostd.startHostCheck).not.toHaveBeenCalled();
    expect(line).toContain('chmod 700 /Users/jane/.openadlc');
    expect(postStatus).toHaveBeenCalledWith('acme/mac-app', HEAD, expect.objectContaining({ state: 'error' }));
  });
});

describe('recording what hostd reported', () => {
  it.each([
    ['passed', 'success'],
    ['failed', 'failure'],
    ['refused', 'error'],
  ] as const)('posts %s as %s, linking to the run in the console', async (state, posted) => {
    vi.mocked(hostCheckRuns.finish).mockResolvedValue(run({ state, durationMs: 2_520_000, exitCode: state === 'failed' ? 2 : 0 }));
    const { service: hostChecks, postStatus } = service();
    await expect(hostChecks.record({ runId: 'run-1', state })).resolves.toBe(true);
    expect(postStatus).toHaveBeenCalledWith('acme/mac-app', HEAD, expect.objectContaining({ state: posted, targetUrl: 'http://localhost:47310/host-checks/0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10' }));
  });

  it('posts nothing for a cancelled run, or for a report of a run already ended', async () => {
    vi.mocked(hostCheckRuns.finish).mockResolvedValueOnce(run({ state: 'cancelled' })).mockResolvedValueOnce(null);
    const { service: hostChecks, postStatus } = service();
    await expect(hostChecks.record({ runId: 'run-1', state: 'cancelled' })).resolves.toBe(true);
    await expect(hostChecks.record({ runId: 'run-1', state: 'passed' })).resolves.toBe(false);
    expect(postStatus).not.toHaveBeenCalled();
  });
});

describe('the reason a status carries (#335)', () => {
  const token = `ghp_${'x'.repeat(36)}`;
  /** The store's own redaction, as `finish` and `start` apply it. */
  const kept = async (reason: string) => {
    const actual = await vi.importActual<typeof import('@openadlc/db')>('@openadlc/db');
    return actual.hostCheckRuns.keptReason(reason);
  };

  it('posts the stored reason of a failed run, with a token-like string masked and a long one capped', async () => {
    vi.mocked(hostCheckRuns.finish).mockImplementation(async (_runId, outcome) => run({ state: outcome.state, reason: outcome.reason ? await kept(outcome.reason) : null }));
    const { service: hostChecks, postStatus } = service();
    await hostChecks.record({ runId: 'run-1', state: 'failed', reason: `a hook printed ${token} ${'z'.repeat(5_000)}` });
    const description = (postStatus.mock.calls[0] as unknown[] | undefined)?.[2] as { description: string };
    expect(description.description).toContain('a hook printed');
    expect(description.description).not.toContain(token);
    expect(description.description.length).toBeLessThanOrEqual(1_000);
  });

  it('posts a refused head’s stored reason, not the one it built', async () => {
    vi.mocked(hostCheckRuns.start).mockImplementation(async (input) => run({ runId: input.runId, state: 'refused', reason: input.reason ? await kept(input.reason) : null, id: 'refused-id' }));
    const { service: hostChecks, hostd, postStatus } = service();
    hostd.hostCheckAccount.mockResolvedValue({ probe: { ok: false, account: 'openadlc-hostcheck', problem: 'can_sudo', detail: `openadlc-hostcheck can run sudo without a password (${token})` } } as never);
    const line = await hostChecks.request(REPO, 7, HEAD, 'main');
    const description = ((postStatus.mock.calls[0] as unknown[] | undefined)?.[2] as { description: string }).description;
    expect(description).toMatch(/^not run: openadlc-hostcheck can run sudo without a password/);
    expect(description).not.toContain(token);
    expect(line).not.toContain(token);
  });
});

describe('stopping and finding lost runs', () => {
  it('asks hostd to stop a pull request’s going run, and ends it here when hostd has none', async () => {
    vi.mocked(hostCheckRuns.forPull).mockResolvedValue([run()]);
    const { service: hostChecks, hostd } = service();
    await hostChecks.cancel(REPO, 7, 'closed');
    expect(hostd.cancelHostCheck).toHaveBeenCalledWith('acme/mac-app', 7);
    expect(hostCheckRuns.finish).not.toHaveBeenCalled();

    hostd.cancelHostCheck.mockResolvedValue({ cancelled: false });
    await hostChecks.cancel(REPO, 7, 'closed');
    expect(hostCheckRuns.finish).toHaveBeenCalledWith('run-1', { state: 'cancelled', reason: 'closed' });
  });

  it('ends as lost a running row hostd answers 404 for, and leaves one hostd could not be asked about', async () => {
    vi.mocked(hostCheckRuns.running).mockResolvedValue([run({ runId: 'gone' }), run({ runId: 'unknown' })]);
    vi.mocked(hostCheckRuns.finish).mockResolvedValue(run({ state: 'lost' }));
    const { service: hostChecks, hostd } = service();
    hostd.hostCheckRun.mockImplementation(async (runId: string) => {
      throw Object.assign(new Error('x'), { status: runId === 'gone' ? 404 : 502 });
    });
    const lines = await hostChecks.sweep();
    expect(hostCheckRuns.finish).toHaveBeenCalledTimes(1);
    expect(hostCheckRuns.finish).toHaveBeenCalledWith('gone', expect.objectContaining({ state: 'lost' }));
    expect(lines).toHaveLength(1);
  });
});

describe('when a host check is asked for', () => {
  const decision = { lead: 'atlas', approvers: ['atlas', 'quill'] };
  const approvedByAll = { approved: ['atlas', 'quill'], decision, changesRequested: [], securityAsks: null, leadDue: null };

  it('runs once the lead and every approver approve the head, with no request for changes standing', () => {
    expect(crewApprovedHead(approvedByAll)).toBe(true);
  });

  it('waits for the lead’s approval to count on the head, and not while the lead is due again', () => {
    expect(crewApprovedHead({ ...approvedByAll, approved: ['quill'] })).toBe(false);
    expect(crewApprovedHead({ ...approvedByAll, leadDue: { lateAsks: [] } })).toBe(false);
  });

  it('waits for every approver, not the lead alone', () => {
    expect(crewApprovedHead({ ...approvedByAll, approved: ['atlas'] })).toBe(false);
  });

  it('does not run while an approver asks for changes on the head', () => {
    expect(crewApprovedHead({ ...approvedByAll, changesRequested: ['quill'] })).toBe(false);
  });

  it('does not run while the security seat asks for changes, though the lead approved after it', () => {
    // The security seat is no approver, so its ask is in `securityAsks` only,
    // and the lead's later approval leaves `leadDue` null.
    expect(crewApprovedHead({ ...approvedByAll, securityAsks: 'vega' })).toBe(false);
  });
});

describe('the card’s view of the head being approved', () => {
  it('shows each state of the head’s own run, and nothing of another head’s', () => {
    expect(hostCheckCardView([], HEAD).state).toBe('not_run');
    expect(hostCheckCardView([run({ headSha: EARLIER, state: 'passed' })], HEAD).state).toBe('not_run');
    expect(hostCheckCardView([run({ state: 'passed', durationMs: 60_000 })], HEAD)).toMatchObject({ state: 'passed', durationMs: 60_000, url: '/host-checks/0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10' });
    expect(hostCheckCardView([run({ state: 'carried', carriedFrom: EARLIER })], HEAD)).toMatchObject({ state: 'passed', carriedFrom: EARLIER });
    expect(hostCheckCardView([run()], HEAD)).toMatchObject({ state: 'running', startedAt: '2026-11-14T10:00:00.000Z' });
    expect(hostCheckCardView([run({ state: 'refused', reason: 'no sudo rule' })], HEAD)).toMatchObject({ state: 'refused', reason: 'no sudo rule' });
  });

  it('gives a failed run’s last forty lines', () => {
    const log = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
    const view = hostCheckCardView([run({ state: 'failed', logTail: log })], HEAD);
    expect(view.logTail?.split('\n')).toHaveLength(40);
    expect(view.logTail?.endsWith('line 99')).toBe(true);
  });

  it('says why it was not run when the account is not fit', () => {
    expect(hostCheckCardView([], HEAD, 'Run: chmod 700 /Users/jane')).toMatchObject({ state: 'not_run', reason: 'Run: chmod 700 /Users/jane', url: null });
  });
});
