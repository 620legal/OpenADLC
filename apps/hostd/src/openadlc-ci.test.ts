import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `openadlc-ci`, the session's way to run the repository's checks: it asks the
 * bridge, waits, and says what happened. It never reports a result — hostd
 * does — so all it can do is start a run and read one.
 */

const BIN = join(import.meta.dirname, '..', 'bin', 'openadlc-ci');
const cli = (await import(BIN)) as {
  runLocalCi: (options: {
    env: Record<string, string>;
    fetchImpl: (url: string, init: { body: string; signal?: AbortSignal }) => Promise<Response>;
    sleep: (ms: number) => Promise<void>;
    log: (line: string) => void;
    now?: () => number;
    head?: () => string | null;
    stateDir?: string;
  }) => Promise<number>;
};

const ENV = { OPENADLC_BRIDGE_URL: 'http://bridge', OPENADLC_TASK_ID: 'task-1', OPENADLC_TASK_TOKEN: 'token' };
// Started when the test clock reads 0.
const run = (state: string, extra: Record<string, unknown> = {}) => ({ id: 'run-1', taskId: 'task-1', state, headSha: 'abc1234def', exitCode: null, logTail: 'ci: green', reason: null, startedAt: new Date(0).toISOString(), ...extra });
const MINUTE = 60_000;
/** Polls of a run still going, one every five seconds, for this many minutes. */
const runningFor = (minutes: number) => Array.from({ length: minutes * 12 }, () => ({ run: run('running') }));
const AGAIN = 'Run openadlc-ci again now, in the foreground: it joins this same run. Do not end your turn, or run it in the background, while it runs.';
const START = 'http://bridge/internal/tasks/task-1/local-ci';
const PASS = 'http://bridge/internal/tasks/task-1/local-ci/pass';
const STATUS = 'http://bridge/internal/tasks/task-1/local-ci/status';
/** The bridge's answer when hostd did not answer it within its 15 seconds. */
const hostdLate = () => new Response(JSON.stringify({ error: 'hostd did not answer in time. It may be busy; try again in a moment.' }), { status: 504 });

const SHA = 'abc1234def0123456789abc1234def0123456789';

/** Where each session's calls leave the run for the next; see `leftRun`. */
const STATE = mkdtempSync(join(tmpdir(), 'openadlc-ci-test-'));
afterAll(() => rmSync(STATE, { recursive: true, force: true }));

/**
 * What the bridge says of the run: in turn from a list whose last answer
 * stays, as a finished run stays finished, or by the session's clock.
 */
type Statuses = Record<string, unknown>[] | ((at: number) => Record<string, unknown>);

/** Which starts, and which reads of a run, hostd did not answer the bridge about in time (a 504). */
type Stalls = { start?: (start: number) => boolean; read?: (read: number) => boolean };

function bridge(statuses: Statuses, passed: boolean | 'unreachable' = false, at: () => number = () => 0, timesOut: (read: number) => boolean = () => false, stalls: Stalls = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const signals: unknown[] = [];
  let reads = 0;
  let starts = 0;
  const status = () => (typeof statuses === 'function' ? statuses(at()) : statuses.length > 1 ? statuses.shift() : statuses[0]) ?? { run: run('running') };
  const fetchImpl = async (url: string, init: { body: string; signal?: AbortSignal }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    signals.push(init.signal);
    if (url.endsWith('/local-ci/pass')) {
      return passed === 'unreachable' ? new Response('{}', { status: 502 }) : new Response(JSON.stringify({ passed, run: null }), { status: 200 });
    }
    if (url === START) return stalls.start?.(++starts) ? hostdLate() : new Response(JSON.stringify({ run: run('running') }), { status: 200 });
    // As `AbortSignal.timeout` fails a request.
    if (timesOut(++reads)) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (stalls.read?.(reads)) return hostdLate();
    return new Response(JSON.stringify(status()), { status: 200 });
  };
  return { calls, signals, fetchImpl };
}

/**
 * One task session: each `call()` is one `openadlc-ci`, against the same
 * bridge, clock and temporary directory, so a second call finds the run the
 * first one left going. `waited` is how long that call held the shell, and
 * `idle` the time between two calls.
 */
function session(statuses: Statuses, options: { head?: string | null; passed?: boolean | 'unreachable'; env?: Record<string, string>; timesOut?: (read: number) => boolean; stalls?: Stalls } = {}) {
  let clock = 0;
  const { calls, signals, fetchImpl } = bridge(statuses, options.passed, () => clock, options.timesOut, options.stalls);
  const stateDir = mkdtempSync(join(STATE, 'session-'));
  const call = async (head = options.head) => {
    const lines: string[] = [];
    const from = clock;
    const before = calls.length;
    const code = await cli.runLocalCi({
      env: options.env ?? ENV,
      fetchImpl,
      sleep: async (ms) => void (clock += ms),
      log: (line) => lines.push(line),
      now: () => clock,
      head: () => head ?? null,
      stateDir,
    });
    return { code, lines, calls, asked: calls.slice(before).map((one) => one.url), waited: clock - from };
  };
  return { call, calls, signals, idle: (ms: number) => void (clock += ms) };
}

async function cli_(statuses: Statuses, options: { head?: string | null; passed?: boolean | 'unreachable' } = {}) {
  return session(statuses, options).call();
}

describe('openadlc-ci', () => {
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

  /**
   * One call waited for the whole run, up to 65 minutes. A shell tool holds a
   * command for about ten, so on #22 the call went to the background, the
   * builder ended its turn to wait for it, and the task's container was torn
   * down with make ci still running. Each call now waits a step inside that.
   */
  it('exits 3 when make ci is still going after its wait, and says to run it again in the foreground', async () => {
    const { code, lines, waited } = await cli_([...runningFor(9), { run: run('passed', { exitCode: 0 }), recorded: true }]);
    expect(code).toBe(3);
    expect(waited).toBeLessThan(9 * MINUTE);
    expect(lines.at(-1)).toBe(`openadlc-ci: make ci is still running (run run-1, 8 min so far). ${AGAIN}`);
  });

  it('joins the same run on the next call, counts its minutes from its start, and answers its result', async () => {
    const { call, calls } = session([...runningFor(20), { run: run('passed', { exitCode: 0 }), recorded: true }], { head: SHA });
    expect((await call()).code).toBe(3);
    const second = await call();
    expect(second.code).toBe(3);
    expect(second.lines.at(-1)).toMatch(/still running \(run run-1, 16 min so far\)/);
    const third = await call();
    expect(third.code).toBe(0);
    expect(third.lines.at(-1)).toMatch(/passed on abc1234def, recorded/);
    // Every call asked for the run, which hostd answers with the one going, and read only that one.
    expect(calls.filter((c) => c.url === START)).toHaveLength(3);
    const read = calls.filter((c) => c.url.endsWith('/local-ci/status')).map((c) => (c.body as { run?: string }).run);
    expect([...new Set(read)]).toEqual(['run-1']);
  });

  it('waits OPENADLC_CI_WAIT_SECONDS a call when it is set', async () => {
    const { call } = session([...runningFor(5), { run: run('passed', { exitCode: 0 }), recorded: true }], { env: { ...ENV, OPENADLC_CI_WAIT_SECONDS: '60' } });
    const first = await call();
    expect(first.code).toBe(3);
    expect(first.waited).toBe(MINUTE);
    expect(first.lines.at(-1)).toMatch(/still running \(run run-1, 1 min so far\)/);
  });

  /**
   * hostd joins only a run still going. A run that ended between two calls,
   * failed or stopped by hostd at its limit, was started over by the next
   * call: another whole make ci on the same commit, to the same end.
   */
  it('answers from the run it left going when that run ended between two calls, rather than running make ci again', async () => {
    const reason = 'make ci did not finish within 60 minutes, so it was stopped: find what keeps it running';
    // Still going at the first call's last read, stopped before the next call.
    const { call, idle } = session((at) => (at <= 8 * MINUTE ? { run: run('running') } : { run: run('failed', { exitCode: 124, reason }) }), { head: SHA });
    expect((await call()).code).toBe(3);
    idle(30_000);

    const second = await call();
    expect(second.code).toBe(1);
    expect(second.lines.at(-1)).toBe(`openadlc-ci: ${reason}`);
    expect(second.asked).not.toContain(START);
    // Once it has answered, the next call is a run of its own, as a builder
    // rerunning a flaky suite means it to be.
    expect((await call()).asked).toContain(START);
  });

  it('reads the run it left only for the commit it left it on', async () => {
    const { call, idle } = session((at) => (at <= 8 * MINUTE ? { run: run('running') } : { run: run('failed', { exitCode: 1 }) }), { head: SHA });
    expect((await call()).code).toBe(3);
    idle(30_000);
    const other = await call('def5678abc0123456789def5678abc0123456789');
    expect(other.asked).toEqual(['http://bridge/internal/tasks/task-1/local-ci/pass', START, 'http://bridge/internal/tasks/task-1/local-ci/status']);
  });

  it('gives every request a time limit, and exits 3, not 2, when a read of a run it knows takes too long', async () => {
    // A bridge, or a hostd behind it, that never answered held the call past
    // its step, and past the shell tool's limit, as one long wait had.
    const { call, signals, idle } = session((at) => (at < 2 * MINUTE ? { run: run('running') } : { run: run('passed', { exitCode: 0 }), recorded: true }), {
      head: SHA,
      timesOut: (read) => read === 3,
    });
    const first = await call();
    expect(first.code).toBe(3);
    expect(first.lines.at(-1)).toBe(`openadlc-ci: the bridge did not answer within 20 seconds about run run-1, so make ci may still be running. ${AGAIN}`);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);

    // The next call reads that run first, and answers from it.
    idle(2 * MINUTE);
    const second = await call();
    expect(second.code).toBe(0);
    expect(second.asked).toEqual(['http://bridge/internal/tasks/task-1/local-ci/pass', 'http://bridge/internal/tasks/task-1/local-ci/status', 'http://bridge/internal/tasks/task-1/local-ci/status']);
  });

  /**
   * The bridge gives hostd 15 seconds, and says so with a 504. Read as a
   * refusal, a stall exited 2, forgot the run, and dropped the line that
   * says not to end the turn: the way to #22, where a builder ended its
   * session with make ci still running in its computer.
   */
  it('exits 3, not 2, and keeps the run, when hostd did not answer the bridge about it in time', async () => {
    const { call, idle } = session((at) => (at < 2 * MINUTE ? { run: run('running') } : { run: run('passed', { exitCode: 0 }), recorded: true }), {
      head: SHA,
      stalls: { read: (read) => read === 3 },
    });
    const first = await call();
    expect(first.code).toBe(3);
    expect(first.lines.at(-1)).toBe(`openadlc-ci: hostd did not answer the bridge in time about run run-1, so make ci may still be running. ${AGAIN}`);

    idle(2 * MINUTE);
    const second = await call();
    expect(second.code).toBe(0);
    expect(second.asked).toEqual([PASS, STATUS, STATUS]);
  });

  it('exits 3 when a start went unanswered, says it may have started, and joins it on the next call', async () => {
    const { call } = session([{ run: run('passed', { exitCode: 0 }), recorded: true }], { head: SHA, stalls: { start: (start) => start === 1 } });
    const first = await call();
    expect(first.code).toBe(3);
    expect(first.lines.at(-1)).toBe(
      'openadlc-ci: hostd did not answer the bridge in time when asked to start make ci, so it may have started. ' +
        'Run openadlc-ci again now, in the foreground: it joins the run if one started, or starts it. Do not end your turn, or run it in the background, while it may be running.',
    );

    const second = await call();
    expect(second.code).toBe(0);
    expect(second.asked).toEqual([PASS, START, STATUS]);
  });

  it('keeps joining past hostd’s own limit on make ci, so it is hostd’s failed run and its reason the bot sees', async () => {
    const reason = 'make ci did not finish within 60 minutes, so it was stopped: find what keeps it running';
    // Running for an hour and a bit, then failed by hostd at its limit.
    const { call } = session([...runningFor(61), { run: run('failed', { exitCode: 124, reason }) }]);
    const codes: number[] = [];
    let last: Awaited<ReturnType<typeof call>>;
    do {
      last = await call();
      codes.push(last.code);
      expect(last.waited).toBeLessThan(9 * MINUTE);
    } while (last.code === 3 && codes.length < 20);
    expect(codes).toEqual([3, 3, 3, 3, 3, 3, 3, 1]);
    expect(last.lines.at(-1)).toBe(`openadlc-ci: ${reason}`);
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
