import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingKey } from '@fleetadlc/db';
import type { EngineUpdateResult, EngineUpdateStart, EngineUpdateStatus, EngineVersions } from '@fleetadlc/shared';

vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },

  audit: vi.fn(async () => undefined),
  settings: { allSettings: vi.fn(async () => ({})), setSetting: vi.fn(async () => undefined) },
}));

import {
  DEFAULT_SCHEDULE,
  EngineUpdates,
  engineUpdateAttention,
  isDue,
  lastSlotAtOrBefore,
  nextSlotAfter,
  registerEngineUpdateRoutes,
  scheduleFrom,
  type Schedule,
} from './engine-updates.js';
import { Router } from './router.js';

/**
 * The bridge's half of the weekly engine update: the clock that decides a
 * run is owed, and the record of how each ended. hostd answers from memory
 * here; `apps/hostd/src/engine-updates.test.ts` is the run itself.
 */

const CLAUDE = '@anthropic-ai/claude-code';
const CODEX = '@openai/codex';
const PINS: EngineVersions = { [CLAUDE]: '2.1.282', [CODEX]: '0.155.1', '@xai-official/grok': '1.0.41' };

const SUNDAY_1800 = { ...DEFAULT_SCHEDULE };

// ------------------------------------------------------------------ the week

describe('this week’s slot', () => {
  it('is last Sunday at 18:00 on the install’s clock, and the next one is the coming Sunday', () => {
    // Thursday morning in Jerusalem (IDT, UTC+3).
    const thursday = new Date('2026-09-24T09:00:00Z');
    expect(lastSlotAtOrBefore(thursday, SUNDAY_1800, 'Asia/Jerusalem').toISOString()).toBe('2026-09-20T15:00:00.000Z');
    expect(nextSlotAfter(thursday, SUNDAY_1800, 'Asia/Jerusalem').toISOString()).toBe('2026-09-27T15:00:00.000Z');
  });

  it('is the slot itself at 18:00 exactly, and the week before a minute earlier', () => {
    const slot = new Date('2026-09-27T15:00:00Z');
    expect(lastSlotAtOrBefore(slot, SUNDAY_1800, 'Asia/Jerusalem').toISOString()).toBe(slot.toISOString());
    expect(lastSlotAtOrBefore(new Date('2026-09-27T14:59:00Z'), SUNDAY_1800, 'Asia/Jerusalem').toISOString()).toBe(
      '2026-09-20T15:00:00.000Z',
    );
  });

  it('is the same instant on two clocks only when they agree it is past 18:00 on Sunday', () => {
    const instant = new Date('2026-09-27T16:00:00Z');
    // London reads 17:00 on Sunday: not yet.
    expect(lastSlotAtOrBefore(instant, SUNDAY_1800, 'Europe/London').toISOString()).toBe('2026-09-20T17:00:00.000Z');
    // Tokyo reads 01:00 on Monday: Sunday's 18:00 has passed.
    expect(lastSlotAtOrBefore(instant, SUNDAY_1800, 'Asia/Tokyo').toISOString()).toBe('2026-09-27T09:00:00.000Z');
  });

  it('stays at 18:00 on the wall when the clocks change', () => {
    // New York leaves daylight time on 1 November 2026.
    expect(nextSlotAfter(new Date('2026-10-26T12:00:00Z'), SUNDAY_1800, 'America/New_York').toISOString()).toBe(
      '2026-11-01T23:00:00.000Z',
    );
    expect(lastSlotAtOrBefore(new Date('2026-10-26T12:00:00Z'), SUNDAY_1800, 'America/New_York').toISOString()).toBe(
      '2026-10-25T22:00:00.000Z',
    );
    // Berlin leaves summer time on 25 October 2026, the morning of the slot.
    expect(nextSlotAfter(new Date('2026-10-20T12:00:00Z'), SUNDAY_1800, 'Europe/Berlin').toISOString()).toBe(
      '2026-10-25T17:00:00.000Z',
    );
  });

  it('is at the hour on the wall even when the clocks went forward a few hours before it', () => {
    // New York goes to daylight time at 02:00 on 8 March 2026. At 06:00
    // that morning the offset is not the one it was at midnight, and a slot
    // worked out with midnight's offset lands an hour late.
    const early: Schedule = { enabled: true, day: 'sunday', time: '06:00' };
    expect(nextSlotAfter(new Date('2026-03-05T12:00:00Z'), early, 'America/New_York').toISOString()).toBe(
      '2026-03-08T10:00:00.000Z',
    );
  });

  it('follows another day and time', () => {
    const wednesday: Schedule = { enabled: true, day: 'wednesday', time: '09:30' };
    expect(nextSlotAfter(new Date('2026-09-24T09:00:00Z'), wednesday, 'UTC').toISOString()).toBe('2026-09-30T09:30:00.000Z');
    expect(lastSlotAtOrBefore(new Date('2026-09-24T09:00:00Z'), wednesday, 'UTC').toISOString()).toBe(
      '2026-09-23T09:30:00.000Z',
    );
  });
});

describe('whether this week’s run is owed', () => {
  const zone = 'Asia/Jerusalem';
  const lastWeek = new Date('2026-09-20T15:00:00Z');
  const thisWeek = new Date('2026-09-27T15:00:00Z');

  it('is owed once the slot has passed, however long after — a laptop asleep at 18:00 runs it on waking', () => {
    expect(isDue(new Date('2026-09-27T15:00:00Z'), SUNDAY_1800, lastWeek, zone)).toBe(true);
    expect(isDue(new Date('2026-09-28T05:30:00Z'), SUNDAY_1800, lastWeek, zone)).toBe(true);
    expect(isDue(new Date('2026-09-27T14:59:00Z'), SUNDAY_1800, lastWeek, zone)).toBe(false);
  });

  it('is owed once a week: not again after it ran, and one run for weeks slept through', () => {
    expect(isDue(new Date('2026-09-28T05:30:00Z'), SUNDAY_1800, thisWeek, zone)).toBe(false);
    // Asleep for three Sundays: the most recent slot is owed, and only it.
    expect(isDue(new Date('2026-10-12T08:00:00Z'), SUNDAY_1800, lastWeek, zone)).toBe(true);
    expect(isDue(new Date('2026-10-12T08:00:00Z'), SUNDAY_1800, new Date('2026-10-11T15:00:00Z'), zone)).toBe(false);
  });

  it('is never owed while off, or before the first slot is remembered', () => {
    expect(isDue(new Date('2026-09-28T05:30:00Z'), { ...SUNDAY_1800, enabled: false }, lastWeek, zone)).toBe(false);
    expect(isDue(new Date('2026-09-28T05:30:00Z'), SUNDAY_1800, null, zone)).toBe(false);
  });

  it('reads the schedule as stored, and a value it cannot read as the default', () => {
    expect(scheduleFrom({})).toEqual({ enabled: true, day: 'sunday', time: '18:00' });
    expect(scheduleFrom({ engineUpdates: 'off', engineUpdateDay: 'Friday', engineUpdateTime: '07:15' })).toEqual({
      enabled: false,
      day: 'friday',
      time: '07:15',
    });
    expect(scheduleFrom({ engineUpdateDay: 'someday', engineUpdateTime: '25:00' })).toEqual(DEFAULT_SCHEDULE);
  });
});

// ------------------------------------------------------------------ a fake hostd

function result(partial: Partial<EngineUpdateResult> = {}): EngineUpdateResult {
  return {
    state: 'updated',
    trigger: 'schedule',
    requestedBy: 'schedule',
    from: PINS,
    to: { ...PINS, [CODEX]: '0.156.1' },
    latest: { ...PINS, [CODEX]: '0.156.1' },
    checks: [
      {
        kind: 'model',
        cli: 'claude',
        state: 'passed',
        model: 'claude-opus-5-5',
        configured: ['newest:opus'],
        account: { id: 'a', label: 'Anthropic Max', provider: 'anthropic', kind: 'subscription' },
        bots: ['fleetadlc-atlas-janedoe'],
        detail: 'claude-opus-5-5 (newest:opus) on Anthropic Max: answered: OK',
      },
    ],
    reason: 'codex 0.155.1 → 0.156.1',
    startedAt: '2026-09-27T15:02:00.000Z',
    finishedAt: '2026-09-27T15:09:00.000Z',
    refreshed: ['fleetadlc-atlas-janedoe'],
    deferred: [],
    ...partial,
  };
}

class FakeHostd {
  status: EngineUpdateStatus = {
    driver: 'docker',
    applicable: true,
    reason: '',
    image: 'fleetadlc-bot:latest',
    inUse: PINS,
    inUseSource: 'label',
    previous: null,
    running: null,
    last: null,
  };
  starts: { input: { trigger: string; hold: EngineVersions; minReleaseAgeDays?: number }; identity: string | undefined }[] = [];
  /** How the next run ends, after `polls` looks. */
  outcome: EngineUpdateResult = result();
  polls = 1;
  /** Holds a run open until a test lets it go. */
  hang = false;
  down = false;
  rollbacks: string[] = [];

  engineUpdateStatus = async (): Promise<EngineUpdateStatus> => {
    if (this.down) throw Object.assign(new Error('hostd is not answering'), { status: 502 });
    if (this.status.running && !this.hang) {
      this.polls -= 1;
      if (this.polls < 0) this.status = { ...this.status, running: null, last: this.outcome };
    }
    return this.status;
  };

  startEngineUpdate = async (input: { trigger: string; hold: EngineVersions; minReleaseAgeDays?: number }, identity?: string): Promise<EngineUpdateStart> => {
    if (this.down) throw Object.assign(new Error('hostd is not answering'), { status: 502 });
    this.starts.push({ input, identity });
    if (!this.status.applicable) {
      const skipped = result({ state: 'skipped', reason: this.status.reason, to: null, checks: [], startedAt: this.outcome.startedAt });
      this.status = { ...this.status, last: skipped };
      return { running: false, startedAt: skipped.startedAt, joined: false, last: skipped };
    }
    this.status = { ...this.status, running: { startedAt: this.outcome.startedAt, trigger: input.trigger } };
    return { running: true, startedAt: this.outcome.startedAt, joined: false, last: null };
  };

  rollbackEngines = async (identity: string): Promise<EngineUpdateResult> => {
    this.rollbacks.push(identity);
    const rolled = result({
      state: 'rolled-back',
      trigger: 'rollback',
      requestedBy: identity,
      from: { ...PINS, [CODEX]: '0.156.1' },
      to: PINS,
      latest: null,
      checks: [],
      reason: 'codex 0.156.1 → 0.155.1',
      startedAt: '2026-09-28T07:00:00.000Z',
      finishedAt: '2026-09-28T07:00:08.000Z',
    });
    this.status = { ...this.status, last: rolled };
    return rolled;
  };
}

function memory(initial: Partial<Record<SettingKey, string>> = {}) {
  const data: Partial<Record<SettingKey, string>> = { ...initial };
  return {
    data,
    store: {
      all: async () => ({ ...data }),
      set: async (key: SettingKey, value: string) => {
        if (value === '') delete data[key];
        else data[key] = value;
      },
    },
  };
}

function updates(options: { hostd?: FakeHostd; stored?: Partial<Record<SettingKey, string>>; now?: string } = {}) {
  const hostd = options.hostd ?? new FakeHostd();
  const { data, store } = memory(options.stored);
  const entries: { actor: string; action: string; target: string; payload?: Record<string, unknown> }[] = [];
  let now = new Date(options.now ?? '2026-09-28T05:30:00Z');
  const service = new EngineUpdates({
    hostd,
    store,
    audit: async (entry) => void entries.push(entry),
    now: () => now,
    timeZone: 'Asia/Jerusalem',
    pollMs: 1,
    silentMs: 20,
    log: () => undefined,
  });
  return { service, hostd, data, entries, at: (iso: string) => (now = new Date(iso)) };
}

const LAST_WEEK = '2026-09-20T15:00:00.000Z';
const THIS_WEEK = '2026-09-27T15:00:00.000Z';

/** The slot a tool's schedule remembers. The old `engineUpdateSlot` is migrated into this. */
function toolSlot(data: Partial<Record<SettingKey, string>>, id = 'claude'): string | null {
  const parsed = JSON.parse(data.systemToolSchedules ?? '{}') as Record<string, { slot?: string | null; mode?: string; time?: string }>;
  return parsed[id]?.slot ?? null;
}

// ------------------------------------------------------------------ the clock

describe('the engines job', () => {
  it('remembers the first slot it sees without running anything, so a new install waits for Sunday', async () => {
    const { service, hostd, data } = updates({ now: '2026-09-24T09:00:00Z' });

    const lines = await service.tick();

    expect(hostd.starts).toEqual([]);
    expect(toolSlot(data)).toBe(LAST_WEEK);
    expect(lines.at(-1)).toBe(
      'engine updates run every Sunday at 18:00 (Asia/Jerusalem); the first is at 2026-09-27T15:00:00.000Z',
    );
  });

  it('runs a slot slept through when it wakes, follows it to the end, and records it once', async () => {
    const { service, hostd, data, entries } = updates({ stored: { engineUpdateSlot: LAST_WEEK, engineUpdateHold: '{"@openai/codex":"0.157.0"}' } });

    const lines = await service.tick();

    expect(hostd.starts).toEqual([
      {
        input: {
          trigger: 'schedule',
          hold: { [CODEX]: '0.157.0' },
          // Unset: the default.
          minReleaseAgeDays: 3,
          only: ['@anthropic-ai/claude-code', '@openai/codex', '@xai-official/grok', 'gh', 'node'],
        },
        identity: 'schedule',
      },
    ]);
    expect(toolSlot(data)).toBe(THIS_WEEK);
    expect(lines.at(-1)).toBe("this week's engine update: updated — codex 0.155.1 → 0.156.1");
    expect(entries).toEqual([
      {
        actor: 'schedule',
        action: 'engines.updated',
        target: 'bot-image',
        payload: expect.objectContaining({
          trigger: 'schedule',
          from: PINS,
          to: { ...PINS, [CODEX]: '0.156.1' },
          changes: 'codex 0.155.1 → 0.156.1',
          refreshed: ['fleetadlc-atlas-janedoe'],
        }),
      },
    ]);
    expect(JSON.parse(data.engineUpdateLast ?? 'null')).toMatchObject({ state: 'updated', startedAt: '2026-09-27T15:02:00.000Z' });
    // Something newer went in, so what a rollback held back is moot.
    expect(data.engineUpdateHold).toBeUndefined();

    // The next look, the same week: nothing owed, nothing recorded again.
    await service.tick();
    expect(hostd.starts).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });

  it('does not count a week hostd never took, and tries again at the next look', async () => {
    const hostd = new FakeHostd();
    hostd.down = true;
    const { service, data } = updates({ hostd, stored: { engineUpdateSlot: LAST_WEEK } });

    const lines = await service.tick();

    expect(lines.at(-1)).toMatch(/did not start: hostd is not answering; the next look tries again/);
    expect(toolSlot(data)).toBe(LAST_WEEK);

    hostd.down = false;
    await service.tick();
    expect(hostd.starts).toHaveLength(1);
    expect(toolSlot(data)).toBe(THIS_WEEK);
  });

  it('writes nothing to the audit log when there was nothing newer, and keeps it as the last check', async () => {
    const hostd = new FakeHostd();
    hostd.outcome = result({ state: 'current', to: null, checks: [], reason: 'every engine is already the newest version' });
    const { service, data, entries } = updates({ hostd, stored: { engineUpdateSlot: LAST_WEEK } });

    await service.tick();

    expect(entries).toEqual([]);
    expect(JSON.parse(data.engineUpdateLast ?? 'null')).toMatchObject({ state: 'current', finishedAt: '2026-09-27T15:09:00.000Z' });
  });

  it('records a failure with its reason, and puts it where a person will see it', async () => {
    const hostd = new FakeHostd();
    const reason = 'claude-opus-5-5 (newest:opus) on Anthropic Max: Invalid API key · Fix external API key';
    hostd.outcome = result({ state: 'failed', reason, to: { ...PINS, [CLAUDE]: '2.1.290' } });
    const { service, entries } = updates({ hostd, stored: { engineUpdateSlot: LAST_WEEK } });

    await service.tick();

    expect(entries).toEqual([
      {
        actor: 'schedule',
        action: 'engines.update_failed',
        target: 'bot-image',
        payload: expect.objectContaining({ reason, from: PINS, to: { ...PINS, [CLAUDE]: '2.1.290' } }),
      },
    ]);
    const view = await service.view();
    expect(view.attention).toEqual({
      kind: 'engine-update-failed',
      title: 'The engine update did not go in — the bots are still on the engines they had',
      detail: reason,
      at: '2026-09-27T15:09:00.000Z',
      href: '/settings#engine-updates',
    });
    expect(await service.attention()).toEqual(view.attention);
  });

  it('reads a failed update without writing, so a schedule that cannot be saved does not hide it', async () => {
    const { data, store } = memory({
      engineUpdateLast: JSON.stringify({
        state: 'failed',
        reason: 'The candidate image did not build.',
        finishedAt: '2026-09-24T10:00:00.000Z',
      }),
    });
    store.set = async () => {
      throw new Error('settings cannot be written');
    };
    const service = new EngineUpdates({
      hostd: new FakeHostd(),
      store,
      audit: async () => undefined,
      now: () => new Date('2026-09-27T15:00:00.000Z'),
    });

    await expect(service.lastResult()).resolves.toMatchObject({ state: 'failed', reason: 'The candidate image did not build.' });
    await expect(service.attention()).resolves.toMatchObject({ kind: 'engine-update-failed' });
    expect(data.systemToolSchedules).toBeUndefined();
  });

  it('records a run hostd finished that nobody recorded, from a bridge that restarted mid-run', async () => {
    const hostd = new FakeHostd();
    hostd.status = { ...hostd.status, last: result({ requestedBy: 'ada', trigger: 'console' }) };
    const { service, entries } = updates({ hostd, stored: { engineUpdateSlot: THIS_WEEK } });

    const lines = await service.tick();
    await service.tick();

    expect(lines[0]).toBe('recorded the engine update hostd finished at 2026-09-27T15:09:00.000Z: updated');
    expect(entries.map((entry) => [entry.actor, entry.action])).toEqual([['ada', 'engines.updated']]);
  });

  it('counts a run hostd forgot — it restarted — as failed, rather than waiting for it for ever', async () => {
    const hostd = new FakeHostd();
    const { service } = updates({ hostd, stored: { engineUpdateSlot: LAST_WEEK } });
    hostd.engineUpdateStatus = async () => ({ ...hostd.status, running: null, last: null });

    const lines = await service.tick();

    expect(lines.at(-1)).toMatch(/failed — hostd no longer knows the run/);
    expect((await service.lastResult())?.state).toBe('failed');
  });

  it('is off when the console turned it off', async () => {
    const { service, hostd } = updates({ stored: { engineUpdates: 'off', engineUpdateSlot: LAST_WEEK } });
    expect(await service.tick()).toEqual(['engine updates are off']);
    expect(hostd.starts).toEqual([]);
  });
});

describe('a run a person starts', () => {
  it('refuses a second Update now while one runs, since the tool it names is not in that run', async () => {
    const { service, hostd } = updates();
    hostd.polls = 3;

    const first = service.start({ trigger: 'console', actor: 'ada', only: [CODEX], tools: ['codex'] });
    const second = service.start({ trigger: 'console', actor: 'grace', only: ['@xai-official/grok'], tools: ['grok'] });

    await expect(second).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^an update is already running/) });
    expect(hostd.starts).toHaveLength(1);
    await (await first).done;
  });

  it('lets a schedule’s look join the run going, and claims nothing for it', async () => {
    const { service, hostd, data } = updates();
    hostd.polls = 3;

    const first = await service.start({ trigger: 'console', actor: 'ada' });
    const second = await service.start({
      trigger: 'schedule',
      actor: 'schedule',
      claims: [{ id: 'grok', slot: new Date(THIS_WEEK) }],
    });

    expect(hostd.starts).toHaveLength(1);
    expect(second).toMatchObject({ joined: true, startedAt: first.startedAt });
    expect(await second.done).toEqual(await first.done);
    // Grok was not in that run, so its week is still owed.
    expect(toolSlot(data, 'grok')).not.toBe(new Date(THIS_WEEK).toISOString());
  });

  it('refuses Update now when hostd is already running a run this bridge did not start', async () => {
    const { service, hostd } = updates();
    hostd.startEngineUpdate = async () => ({ running: true, startedAt: '2026-09-28T05:00:00.000Z', joined: true, last: null });

    await expect(service.start({ trigger: 'console', actor: 'ada', tools: ['grok'] })).rejects.toMatchObject({
      status: 409,
      message: 'an update is already running (started 2026-09-28T05:00:00.000Z); press Update now again once it has finished',
    });
  });

  it('records a run a restarted bridge finds finished against the tools the run was started for', async () => {
    const first = updates();
    first.hostd.hang = true;
    await first.service.start({ trigger: 'console', actor: 'ada', only: ['@xai-official/grok'], tools: ['grok'] });
    expect(JSON.parse(first.data.systemToolRun ?? '{}')).toEqual({ startedAt: first.hostd.outcome.startedAt, tools: ['grok'] });

    // The bridge restarts; hostd finishes the run, whose result names every
    // engine in `latest`, and the new bridge records it at its next look.
    const { service, hostd, data } = updates({ hostd: first.hostd, stored: { ...first.data } });
    hostd.status = { ...hostd.status, running: null, last: result({ trigger: 'console', to: { ...PINS, '@xai-official/grok': '1.0.42' } }) };
    await service.tick();

    expect(Object.keys(JSON.parse(data.systemToolLast ?? '{}'))).toEqual(['grok']);
    expect(data.systemToolRun).toBeUndefined();
  });

  it('records a run that names no tools against the three engines, which is what hostd runs then', async () => {
    const { service, hostd, data } = updates();
    hostd.hang = true;
    await service.start({ trigger: 'console', actor: 'ada' });
    expect(JSON.parse(data.systemToolRun ?? '{}').tools).toEqual(['claude', 'codex', 'grok']);
  });

  it('writes a run that stopped before it asked about any tool against no tool', async () => {
    const { service, data } = updates();
    await service.record(
      result({ state: 'failed', from: {}, to: null, latest: null, checks: [], reason: 'hostd no longer knows the run' }),
      'fleetadlc',
    );
    expect(JSON.parse(data.systemToolLast ?? '{}')).toEqual({});
    expect(JSON.parse(data.engineUpdateLast ?? '{}')).toMatchObject({ state: 'failed' });
  });

  it('says hostd is not answering, rather than claiming a run', async () => {
    const hostd = new FakeHostd();
    hostd.down = true;
    const { service } = updates({ hostd });
    await expect(service.start({ trigger: 'console', actor: 'ada' })).rejects.toMatchObject({ status: 502 });
  });

  it('records a run hostd could not do at all as its answer, without an audit entry', async () => {
    const hostd = new FakeHostd();
    hostd.status = { ...hostd.status, driver: 'local', applicable: false, reason: 'not applicable: the local driver runs the host’s own CLIs' };
    const { service, entries } = updates({ hostd });

    const started = await service.start({ trigger: 'console', actor: 'ada' });

    expect((await started.done).state).toBe('skipped');
    expect((await service.lastResult())?.reason).toBe('not applicable: the local driver runs the host’s own CLIs');
    expect(entries).toEqual([]);
  });
});

describe('rolling back', () => {
  it('is recorded, and holds back the version it undid so the next run does not take it again', async () => {
    const { service, hostd, data, entries } = updates();

    await service.rollback('ada');

    expect(hostd.rollbacks).toEqual(['ada']);
    expect(entries).toEqual([
      {
        actor: 'ada',
        action: 'engines.rolled_back',
        target: 'bot-image',
        payload: expect.objectContaining({ from: { ...PINS, [CODEX]: '0.156.1' }, to: PINS }),
      },
    ]);
    expect(JSON.parse(data.engineUpdateHold ?? '{}')).toEqual({ [CODEX]: '0.156.1' });

    await (await service.start({ trigger: 'console', actor: 'ada' })).done;
    expect(hostd.starts[0]?.input.hold).toEqual({ [CODEX]: '0.156.1' });
  });

  it('is refused while an update is running', async () => {
    const { service, hostd } = updates();
    hostd.hang = true;
    const started = await service.start({ trigger: 'console', actor: 'ada' });
    await expect(service.rollback('ada')).rejects.toMatchObject({ status: 409 });
    hostd.hang = false;
    await started.done;
  });
});

describe('how old a release must be before a run takes it', () => {
  it('is three days until an admin changes it, and the view says so', async () => {
    const { service } = updates();
    expect((await service.view()).minReleaseAgeDays).toBe(3);
  });

  it('is stored and audited when an admin changes it, and given to hostd on the next run, a person’s or the schedule’s', async () => {
    const { service, hostd, data, entries } = updates();

    const view = await service.setSchedule({ minReleaseAgeDays: 7 }, 'ada');

    expect(view.minReleaseAgeDays).toBe(7);
    expect(data.engineUpdateMinReleaseAgeDays).toBe('7');
    expect(entries).toContainEqual({
      actor: 'ada',
      action: 'engines.schedule_changed',
      target: 'bot-image',
      payload: { minReleaseAgeDays: { from: 3, to: 7 } },
    });
    await (await service.start({ trigger: 'console', actor: 'ada', only: [CODEX], tools: ['codex'] })).done;
    expect(hostd.starts[0]?.input.minReleaseAgeDays).toBe(7);
  });

  it('refuses anything but a whole number of days from 0 to 90, saying so', async () => {
    const { service, data } = updates();
    for (const bad of [-1, 91, 2.5, '3', null]) {
      await expect(service.setSchedule({ minReleaseAgeDays: bad }, 'ada')).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('minReleaseAgeDays is a whole number of days from 0 to 90'),
      });
    }
    expect(data.engineUpdateMinReleaseAgeDays).toBeUndefined();
    expect((await service.setSchedule({ minReleaseAgeDays: 0 }, 'ada')).minReleaseAgeDays).toBe(0);
  });
});

describe('changing the schedule', () => {
  it('stores it, and counts from now: a time already past today is next week’s', async () => {
    // Sunday 20:00 in Jerusalem, after this week's run.
    const { service, data, entries } = updates({ now: '2026-09-27T17:00:00Z', stored: { engineUpdateSlot: THIS_WEEK } });

    const view = await service.setSchedule({ time: '19:00' }, 'ada');

    expect(JSON.parse(data.systemToolSchedules ?? '{}')).toMatchObject({
      claude: { mode: 'schedule', day: 'sunday', time: '19:00' },
      node: { mode: 'schedule', day: 'sunday', time: '19:00' },
    });
    expect(view.due).toBe(false);
    expect(view.nextRun).toBe('2026-10-04T16:00:00.000Z');
    expect(view.schedule).toMatchObject({ time: '19:00', timeZone: 'Asia/Jerusalem', description: 'every Sunday at 19:00' });
    expect(entries).toEqual([
      {
        actor: 'ada',
        action: 'engines.schedule_changed',
        target: 'bot-image',
        payload: { enabled: true, day: 'sunday', time: '19:00', timeZone: 'Asia/Jerusalem' },
      },
    ]);
  });

  it('turns off, and back on from the next Sunday rather than one that passed while it was off', async () => {
    const { service, data } = updates({ now: '2026-10-07T09:00:00Z', stored: { engineUpdateSlot: LAST_WEEK } });

    const off = await service.setSchedule({ enabled: false }, 'ada');
    expect(off).toMatchObject({ nextRun: null, schedule: { enabled: false, description: 'off' } });
    expect(JSON.parse(data.systemToolSchedules ?? '{}').claude.mode).toBe('manual');

    const on = await service.setSchedule({ enabled: true }, 'ada');
    expect(on.due).toBe(false);
    expect(on.nextRun).toBe('2026-10-11T15:00:00.000Z');
  });

  /** Every tool scheduled for Sunday at 18:00 and run this week, but for those given. */
  function toolRows(over: Record<string, Record<string, unknown>> = {}): string {
    const rows: Record<string, unknown> = {};
    for (const id of ['claude', 'codex', 'grok', 'gh', 'node']) {
      rows[id] = { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null, ...over[id] };
    }
    return JSON.stringify(rows);
  }

  it('turns on a tool that was manual from the next slot, not the one it had when it went manual', async () => {
    // Every tool went manual in January, so the switch still sets them all.
    // (Once their rows differ, the shared switch is refused below.)
    const january = { mode: 'manual', slot: '2026-01-04T16:00:00.000Z' };
    const { service, hostd, data } = updates({
      stored: {
        systemToolSchedules: toolRows({ claude: january, codex: january, grok: january, gh: january, node: january }),
      },
    });

    await service.setSchedule({ enabled: true }, 'ada');
    await service.tick();

    expect(hostd.starts).toEqual([]);
    expect(toolSlot(data)).toBe(THIS_WEEK);
  });

  it('counts a new time zone from now, so a slot already past there is not run at once', async () => {
    // Sunday 13:00 in Jerusalem, before its 18:00; in Tokyo it is 19:00, after.
    const { service, hostd, data } = updates({ now: '2026-10-04T10:00:00Z', stored: { systemToolSchedules: toolRows() } });

    await service.setSchedule({ timeZone: 'Asia/Tokyo' }, 'ada');
    await service.tick();

    expect(hostd.starts).toEqual([]);
    expect(toolSlot(data)).toBe('2026-10-04T09:00:00.000Z');
  });

  it('refuses what is not a schedule', async () => {
    const { service } = updates();
    await expect(service.setSchedule({ day: 'someday' }, 'ada')).rejects.toMatchObject({ status: 400 });
    await expect(service.setSchedule({ time: '6pm' }, 'ada')).rejects.toMatchObject({ status: 400 });
    await expect(service.setSchedule({ enabled: 'yes' }, 'ada')).rejects.toMatchObject({ status: 400 });
    await expect(service.setSchedule({ image: 'evil:latest' }, 'ada')).rejects.toMatchObject({ status: 400 });
    await expect(service.setSchedule({ timeZone: 'Not/Azone' }, 'ada')).rejects.toMatchObject({ status: 400 });
    await expect(service.setSchedule({ tools: [{ id: 'pnpm', pin: '1' }] }, 'ada')).rejects.toMatchObject({ status: 400 });
  });

  it('stores an IANA timezone and records who changed it', async () => {
    const { service, data, entries } = updates();

    const view = await service.setSchedule({ timeZone: 'America/New_York' }, 'ada');

    expect(data.systemTimeZone).toBe('America/New_York');
    expect(view.timeZone).toBe('America/New_York');
    expect(view.schedule.timeZone).toBe('America/New_York');
    expect(entries).toEqual([
      {
        actor: 'ada',
        action: 'system.timezone_changed',
        target: 'install',
        payload: { from: 'Asia/Jerusalem', to: 'America/New_York' },
      },
    ]);
  });

  it('names a pin on a scheduled run, and leaves the pin where it was', async () => {
    const { service, hostd, data } = updates({ stored: { engineUpdateSlot: LAST_WEEK } });
    await service.setSchedule({ tools: [{ id: 'codex', pin: '0.155.1' }] }, 'ada');

    await service.tick();

    expect(hostd.starts[0]?.input).toMatchObject({ pins: { [CODEX]: '0.155.1' } });
    expect(JSON.parse(data.systemToolSchedules ?? '{}').codex.pin).toBe('0.155.1');
  });

  it('moves a pin when a person updates, to the version that went in', async () => {
    const { service, hostd, data } = updates();
    hostd.outcome = result({ trigger: 'console', requestedBy: 'ada' });
    await service.setSchedule({ tools: [{ id: 'codex', pin: '0.155.1' }] }, 'ada');

    await (await service.start({ trigger: 'console', actor: 'ada' })).done;

    expect(JSON.parse(data.systemToolSchedules ?? '{}').codex.pin).toBe('0.156.1');
  });
});

describe('a settings read that fails', () => {
  // A person's manual claude on Wednesday 03:00 and two pins: what one
  // database error used to turn into every tool on Sunday 18:00, unpinned.
  const weekly = { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null };
  const SET = JSON.stringify({
    claude: { mode: 'manual', day: 'wednesday', time: '03:00', slot: null, pin: '2.1.282' },
    codex: { ...weekly, pin: '0.40.0' },
    grok: weekly,
    gh: weekly,
    node: weekly,
  });

  /** A store whose reads fail from the `failFrom`th on. */
  function failing(failFrom: number) {
    const { data, store } = memory({ systemToolSchedules: SET });
    let reads = 0;
    const hostd = new FakeHostd();
    const entries: unknown[] = [];
    const service = new EngineUpdates({
      hostd,
      store: {
        all: async () => {
          reads += 1;
          if (reads >= failFrom) throw new Error('connection terminated');
          return store.all();
        },
        set: store.set,
      },
      audit: async (entry) => void entries.push(entry),
      now: () => new Date('2026-09-28T05:30:00Z'),
      timeZone: 'Asia/Jerusalem',
      pollMs: 1,
      silentMs: 20,
      log: () => undefined,
    });
    return { service, hostd, data, entries };
  }

  it('leaves a person’s schedules and pins as they were when it fails inside a tick', async () => {
    const { service, hostd, data } = failing(2);

    await expect(service.tick()).rejects.toThrow('connection terminated');

    expect(data.systemToolSchedules).toBe(SET);
    expect(JSON.parse(data.systemToolSchedules ?? '{}')).toMatchObject({
      claude: { mode: 'manual', day: 'wednesday', time: '03:00', pin: '2.1.282' },
      codex: { pin: '0.40.0' },
    });
    expect(hostd.starts).toEqual([]);
  });

  it('records no result, and writes no audit entry', async () => {
    const { service, data, entries } = failing(1);

    await expect(service.record(result())).rejects.toThrow('connection terminated');

    expect(data.systemToolLast).toBeUndefined();
    expect(data.engineUpdateLast).toBeUndefined();
    expect(entries).toEqual([]);
  });

  it('starts no run with an empty hold, and changes no schedule', async () => {
    const { service, hostd, data } = failing(1);

    await expect(service.start({ trigger: 'console', actor: 'ada' })).rejects.toThrow('connection terminated');
    await expect(service.setSchedule({ tools: [{ id: 'codex', pin: '0.41.0' }] }, 'ada')).rejects.toThrow('connection terminated');

    expect(hostd.starts).toEqual([]);
    expect(data.systemToolSchedules).toBe(SET);
  });

  it('still answers the Settings page and the attention list', async () => {
    const { service } = failing(1);

    expect((await service.view()).tools.length).toBeGreaterThan(0);
    expect(await service.lastResult()).toBeNull();
  });
});

describe('each tool on its own', () => {
  const GROK = '@xai-official/grok';

  it('refuses a shared switch, day or time once the tools differ, and changes nothing', async () => {
    const rows = {
      claude: { mode: 'schedule', day: 'tuesday', time: '22:00', slot: THIS_WEEK, pin: null },
      codex: { mode: 'manual', day: 'sunday', time: '18:00', slot: null, pin: '0.155.1' },
      grok: { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null },
      gh: { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null },
      node: { mode: 'schedule', day: 'friday', time: '03:00', slot: THIS_WEEK, pin: null },
    };
    const stored = JSON.stringify(rows);
    const { service, data, entries } = updates({ stored: { systemToolSchedules: stored } });

    for (const input of [{ enabled: false }, { enabled: true }, { day: 'monday' }, { time: '09:00' }]) {
      const refused = service.setSchedule(input, 'ada');
      await expect(refused).rejects.toMatchObject({ status: 409 });
      await expect(refused).rejects.toThrow(/tools: \[\{ id, mode, day, time \}\]/);
    }
    // A time zone sent with it is refused too, not half applied.
    await expect(service.setSchedule({ enabled: false, timeZone: 'America/New_York' }, 'ada')).rejects.toMatchObject({
      status: 409,
    });

    expect(JSON.parse(data.systemToolSchedules ?? '{}')).toEqual(rows);
    expect(data.systemTimeZone).toBeUndefined();
    expect(entries).toEqual([]);

    // The per-tool route still moves one.
    await service.setSchedule({ tools: [{ id: 'codex', mode: 'schedule', day: 'monday', time: '09:00' }] }, 'ada');
    expect(JSON.parse(data.systemToolSchedules ?? '{}').codex).toMatchObject({ mode: 'schedule', day: 'monday', time: '09:00' });
    expect(JSON.parse(data.systemToolSchedules ?? '{}').node).toMatchObject({ day: 'friday', time: '03:00' });
  });

  it('says each tool keeps its own schedule when their days and times differ, rather than naming one', async () => {
    const rows = {
      claude: { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null },
      codex: { mode: 'manual', day: 'sunday', time: '18:00', slot: null, pin: null },
      grok: { mode: 'manual', day: 'sunday', time: '18:00', slot: null, pin: null },
      gh: { mode: 'manual', day: 'sunday', time: '18:00', slot: null, pin: null },
      node: { mode: 'schedule', day: 'wednesday', time: '09:00', slot: '2026-09-23T06:00:00.000Z', pin: null },
    };
    const { service, hostd } = updates({ stored: { systemToolSchedules: JSON.stringify(rows) } });

    const lines = await service.tick();

    expect(hostd.starts).toEqual([]);
    expect(lines.at(-1)).toBe('engine updates run on each tool’s own schedule; the next is at 2026-09-30T06:00:00.000Z');
  });

  it('names the one schedule the scheduled tools share, whatever a tool updated by hand is set to', async () => {
    const rows = {
      claude: { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null },
      codex: { mode: 'manual', day: 'monday', time: '09:00', slot: null, pin: null },
      grok: { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null },
      gh: { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null },
      node: { mode: 'schedule', day: 'sunday', time: '18:00', slot: THIS_WEEK, pin: null },
    };
    const { service } = updates({ stored: { systemToolSchedules: JSON.stringify(rows) } });

    expect((await service.tick()).at(-1)).toBe('engine updates run every Sunday at 18:00; the next is at 2026-10-04T15:00:00.000Z');
  });

  it('refuses a pin that is not a version, since hostd would drop it and the pin would never hold', async () => {
    const { service, data } = updates();
    for (const pin of ['latest', '2.1', 'v2.1.282', '^2.1.282', '', 5]) {
      await expect(service.setSchedule({ tools: [{ id: 'claude', pin }] }, 'ada')).rejects.toMatchObject({ status: 400 });
    }
    await service.setSchedule({ tools: [{ id: 'claude', pin: '2.1.282' }] }, 'ada');
    expect(JSON.parse(data.systemToolSchedules ?? '{}').claude.pin).toBe('2.1.282');
    await service.setSchedule({ tools: [{ id: 'claude', pin: null }] }, 'ada');
    expect(JSON.parse(data.systemToolSchedules ?? '{}').claude.pin).toBeNull();
  });

  it('runs only the tool whose own day and time came round', async () => {
    // Sunday at 18:00 in Jerusalem was the last slot, and was run.
    const { service, hostd, at } = updates({ stored: { engineUpdateSlot: THIS_WEEK } });
    await service.setSchedule(
      { tools: [{ id: 'codex', mode: 'manual' }, { id: 'claude', mode: 'schedule', day: 'tuesday', time: '03:00' }] },
      'ada',
    );

    // Tuesday 03:05 in Jerusalem.
    at('2026-09-29T00:05:00Z');
    await service.tick();

    expect(hostd.starts).toHaveLength(1);
    expect(hostd.starts[0]?.input).toMatchObject({ trigger: 'schedule', only: [CLAUDE] });
  });

  it('writes a one-tool run’s result against that tool, and moves only its pin', async () => {
    const { service, hostd, data } = updates();
    await service.setSchedule({ tools: [{ id: 'codex', pin: '0.155.1' }, { id: 'grok', pin: '1.0.41' }] }, 'ada');
    hostd.outcome = result({
      trigger: 'console',
      requestedBy: 'ada',
      to: { ...PINS, [GROK]: '1.0.42' },
      latest: { [GROK]: '1.0.42' },
      reason: 'grok 1.0.41 → 1.0.42',
    });

    await (await service.start({ trigger: 'console', actor: 'ada', only: [GROK], tools: ['grok'] })).done;

    const last = JSON.parse(data.systemToolLast ?? '{}');
    expect(Object.keys(last)).toEqual(['grok']);
    expect(last.grok).toMatchObject({ state: 'updated', from: '1.0.41', to: '1.0.42' });
    const schedules = JSON.parse(data.systemToolSchedules ?? '{}');
    expect(schedules.grok.pin).toBe('1.0.42');
    expect(schedules.codex.pin).toBe('0.155.1');
    const view = await service.view();
    expect(view.tools.find((tool) => tool.id === 'grok')?.last).toMatchObject({ state: 'updated', to: '1.0.42' });
    expect(view.tools.find((tool) => tool.id === 'codex')?.last).toBeNull();
  });
});

describe('what the console is shown', () => {
  it('has the versions in use, npm’s newest, the last result, the schedule and the next run', async () => {
    const { service } = updates({
      now: '2026-09-28T05:30:00Z',
      stored: { engineUpdateSlot: THIS_WEEK, engineUpdateLast: JSON.stringify(result({ state: 'current', to: null })) },
    });

    const view = await service.view();

    expect(view).toMatchObject({
      schedule: { enabled: true, day: 'sunday', time: '18:00', description: 'every Sunday at 18:00' },
      nextRun: '2026-10-04T15:00:00.000Z',
      due: false,
      hostd: { reachable: true },
      applicable: true,
      inUse: PINS,
      latest: { ...PINS, [CODEX]: '0.156.1' },
      last: { state: 'current' },
      attention: null,
    });
  });

  it('still says what it knows when hostd does not answer', async () => {
    const hostd = new FakeHostd();
    hostd.down = true;
    const { service } = updates({ hostd, stored: { engineUpdateSlot: LAST_WEEK } });

    const view = await service.view();

    expect(view).toMatchObject({ hostd: { reachable: false, detail: 'hostd is not answering' }, inUse: null, due: true });
  });

  it('has nothing for a person to act on unless the last run failed', () => {
    expect(engineUpdateAttention(null)).toBeNull();
    expect(engineUpdateAttention(result())).toBeNull();
    expect(engineUpdateAttention(result({ state: 'current' }))).toBeNull();
    expect(engineUpdateAttention(result({ state: 'failed', reason: 'x' }))?.detail).toBe('x');
  });
});

// ------------------------------------------------------------------ the routes

describe('the console’s routes', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  async function serve(service: EngineUpdates): Promise<(method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>> {
    const router = new Router();
    registerEngineUpdateRoutes(router, service);
    const http = createServer((request, response) => void router.handle(request, response));
    server = http;
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    return async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-fleetadlc-identity': 'ada' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
  }

  /** Ends a run a test held open, so its follow loop does not go on polling after the test. */
  async function letGo(service: EngineUpdates, hostd: FakeHostd): Promise<void> {
    hostd.hang = false;
    await vi.waitFor(async () => expect((await service.view()).running ?? null).toBeNull());
  }

  it('show the view, start a run for the person asking, change the schedule and roll back', async () => {
    const { service, hostd } = updates();
    hostd.hang = true;
    const call = await serve(service);

    expect((await call('GET', '/v1/engines/updates')).body).toMatchObject({ schedule: { description: 'every Sunday at 18:00' } });

    const started = await call('POST', '/v1/engines/updates');
    expect(started.status).toBe(200);
    expect(started.body.running).toMatchObject({ trigger: 'console' });
    expect(hostd.starts[0]).toMatchObject({ input: { trigger: 'console' }, identity: 'ada' });

    expect((await call('PATCH', '/v1/engines/updates', { day: 'saturday', time: '21:30' })).body).toMatchObject({
      schedule: { day: 'saturday', time: '21:30' },
    });
    expect((await call('PATCH', '/v1/engines/updates', { time: 'late' })).status).toBe(400);
    expect((await call('PATCH', '/v1/engines/updates', ['enabled'])).status).toBe(400);

    // Refused while the run it started is still going, and so is another Update now.
    expect((await call('POST', '/v1/engines/updates/rollback')).status).toBe(409);
    expect(await call('POST', '/v1/engines/updates', { tools: ['grok'] })).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/^an update is already running/) },
    });
    hostd.hang = false;
    await (await service.start({ trigger: 'schedule', actor: 'schedule' })).done;
    expect((await call('POST', '/v1/engines/updates/rollback')).body).toMatchObject({ last: { state: 'rolled-back' } });
  });

  it('update one tool when the body names it, and refuse a tool that is not one', async () => {
    const { service, hostd } = updates();
    hostd.hang = true;
    const call = await serve(service);

    expect((await call('POST', '/v1/engines/updates', { tools: ['pnpm'] })).status).toBe(400);
    expect((await call('POST', '/v1/engines/updates', { tools: [] })).status).toBe(400);
    expect((await call('POST', '/v1/engines/updates', { tools: 'grok' })).status).toBe(400);
    expect(hostd.starts).toEqual([]);

    const started = await call('POST', '/v1/engines/updates', { tools: ['grok'] });
    expect(started.status).toBe(200);
    expect(hostd.starts[0]).toMatchObject({ input: { trigger: 'console', only: ['@xai-official/grok'] }, identity: 'ada' });
    expect(hostd.starts[0]?.input).not.toHaveProperty('pins');
    await letGo(service, hostd);
  });

  it('update every tool when the body names none', async () => {
    const { service, hostd } = updates();
    hostd.hang = true;
    const call = await serve(service);

    await call('POST', '/v1/engines/updates', {});

    expect(hostd.starts[0]?.input).toMatchObject({
      only: ['@anthropic-ai/claude-code', '@openai/codex', '@xai-official/grok', 'gh', 'node'],
    });
    await letGo(service, hostd);
  });

  it('say so when hostd is not answering', async () => {
    const hostd = new FakeHostd();
    hostd.down = true;
    const call = await serve(updates({ hostd }).service);
    expect(await call('POST', '/v1/engines/updates')).toEqual({ status: 502, body: { error: 'hostd is not answering' } });
  });
});
