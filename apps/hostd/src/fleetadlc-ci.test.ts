import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `fleetadlc-ci`, the session's way to run the repository's checks: it asks the
 * bridge, waits, and says what happened. It never reports a result — hostd
 * does — so all it can do is start a run and read one.
 */

const BIN = join(import.meta.dirname, '..', 'bin', 'fleetadlc-ci');
const cli = (await import(BIN)) as {
  runLocalCi: (options: {
    env: Record<string, string>;
    fetchImpl: (url: string, init: { body: string }) => Promise<Response>;
    sleep: (ms: number) => Promise<void>;
    log: (line: string) => void;
    now?: () => number;
    head?: () => string | null;
  }) => Promise<number>;
};

const ENV = { FLEETADLC_BRIDGE_URL: 'http://bridge', FLEETADLC_TASK_ID: 'task-1', FLEETADLC_TASK_TOKEN: 'token' };
const run = (state: string, extra: Record<string, unknown> = {}) => ({ id: 'run-1', taskId: 'task-1', state, headSha: 'abc1234def', exitCode: null, logTail: 'ci: green', reason: null, ...extra });

const SHA = 'abc1234def0123456789abc1234def0123456789';

function bridge(statuses: Record<string, unknown>[], passed: boolean | 'unreachable' = false) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/local-ci/pass')) {
      return passed === 'unreachable' ? new Response('{}', { status: 502 }) : new Response(JSON.stringify({ passed, run: null }), { status: 200 });
    }
    const answer = url.endsWith('/local-ci') ? { run: run('running') } : (statuses.shift() ?? { run: run('running') });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { calls, fetchImpl };
}

async function cli_(statuses: Record<string, unknown>[], options: { head?: string | null; passed?: boolean | 'unreachable' } = {}) {
  const lines: string[] = [];
  const { calls, fetchImpl } = bridge(statuses, options.passed);
  let clock = 0;
  const code = await cli.runLocalCi({
    env: ENV,
    fetchImpl,
    sleep: async (ms) => void (clock += ms),
    log: (line) => lines.push(line),
    now: () => clock,
    head: () => options.head ?? null,
  });
  return { code, lines, calls };
}

describe('fleetadlc-ci', () => {
  it('is executable, so a session can run it by name', () => {
    expect(statSync(BIN).mode & 0o111).not.toBe(0);
  });

  it('starts a run with the task’s token, waits, and exits 0 once the pass is recorded', async () => {
    const { code, lines, calls } = await cli_([{ run: run('running') }, { run: run('passed', { exitCode: 0 }), recorded: false }, { run: run('passed', { exitCode: 0 }), recorded: true }]);

    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('http://bridge/internal/tasks/task-1/local-ci');
    expect(calls[1]).toEqual({ url: 'http://bridge/internal/tasks/task-1/local-ci/status', body: { run: 'run-1' } });
    expect(lines.at(-1)).toMatch(/passed on abc1234def, recorded/);
  });

  it('exits 1 with the end of the log when make ci failed', async () => {
    const { code, lines } = await cli_([{ run: run('failed', { exitCode: 2, logTail: 'FAIL a.test.ts' }), recorded: true }]);
    expect(code).toBe(1);
    expect(lines).toContain('FAIL a.test.ts');
    expect(lines.at(-1)).toMatch(/make ci failed \(exit 2\)/);
  });

  it('waits past hostd’s own limit on make ci, so it is hostd’s failed run and its reason the bot sees', async () => {
    const reason = 'make ci did not finish within 60 minutes, so it was stopped: find what keeps it running';
    // Running for an hour and a bit, then failed by hostd at its limit.
    const statuses = [...Array.from({ length: 61 * 12 }, () => ({ run: run('running') })), { run: run('failed', { exitCode: 124, reason }) }];
    const { code, lines } = await cli_(statuses);
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe(`fleetadlc-ci: ${reason}`);
  });

  it('exits 2 and says what to do when the run was refused', async () => {
    const { code, lines } = await cli_([{ run: run('refused', { reason: 'the worktree has changes that are not committed (a.ts): commit them' }) }]);
    expect(code).toBe(2);
    expect(lines.at(-1)).toMatch(/not run — the worktree has changes/);
  });

  it('answers from the record for a HEAD that already passed, and starts no second make ci', async () => {
    // A shell tool's timeout ends the first call; the second came after the
    // run had passed and started make ci over again on the same commit.
    const { code, lines, calls } = await cli_([], { head: SHA, passed: true });
    expect(code).toBe(0);
    expect(calls).toEqual([{ url: 'http://bridge/internal/tasks/task-1/local-ci/pass', body: { sha: SHA } }]);
    expect(lines.at(-1)).toMatch(/already passed on abc1234def/);
  });

  it('runs the checks for a HEAD with no pass, or when the record cannot be read', async () => {
    for (const passed of [false, 'unreachable'] as const) {
      const { code, calls } = await cli_([{ run: run('passed', { exitCode: 0 }), recorded: true }], { head: SHA, passed });
      expect(code).toBe(0);
      expect(calls.map((call) => call.url)).toEqual([
        'http://bridge/internal/tasks/task-1/local-ci/pass',
        'http://bridge/internal/tasks/task-1/local-ci',
        'http://bridge/internal/tasks/task-1/local-ci/status',
      ]);
    }
  });

  it('says it is no task session when it is run outside one', async () => {
    const lines: string[] = [];
    const code = await cli.runLocalCi({ env: {}, fetchImpl: async () => new Response('{}'), sleep: async () => undefined, log: (line) => lines.push(line) });
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/not an OpenADLC task session/);
  });
});
