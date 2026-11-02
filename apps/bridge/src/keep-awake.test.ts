import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { InFlight } from '@openadlc/db';
import { KEEP_AWAKE_GRACE_MS, KeepAwake, onPath, type KeepAwakeDeps, type Slept } from './keep-awake.js';

const NOTHING: InFlight = { tasks: 0, merges: 0, deploys: 0 };
const START = Date.parse('2026-11-02T10:00:00.000Z');

class FakeChild extends EventEmitter {
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

/** A bridge on a Mac with caffeinate, its clocks and what is in flight in the test's hands. */
function rig(overrides: Partial<KeepAwakeDeps> = {}) {
  const world = {
    inFlight: { ...NOTHING } as InFlight,
    setting: null as string | null,
    wall: START,
    mono: 1_000,
    failing: false,
  };
  const children: FakeChild[] = [];
  const spawn = vi.fn((_command: string, _args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const slept: Slept[] = [];
  const asked = vi.fn();
  const keepAwake = new KeepAwake({
    inFlight: async () => {
      if (world.failing) throw new Error('connection terminated');
      return world.inFlight;
    },
    setting: async () => world.setting,
    recordSleep: async (one) => void slept.push(one),
    slept: asked,
    spawn,
    platform: 'darwin',
    onPath: () => true,
    wall: () => world.wall,
    mono: () => world.mono,
    pid: 4242,
    log: () => undefined,
    ...overrides,
  });
  /** Both clocks move on together, as they do while the machine is awake. */
  const pass = (ms: number) => {
    world.wall += ms;
    world.mono += ms;
  };
  return { world, children, spawn, slept, asked, keepAwake, pass };
}

describe('holding the host awake while work is in flight', () => {
  for (const [source, counts] of [
    ['a task queued or running', { tasks: 1, merges: 0, deploys: 0 }],
    ['a merge waiting on CI', { tasks: 0, merges: 1, deploys: 0 }],
    ['a deploy waiting or running', { tasks: 0, merges: 0, deploys: 1 }],
  ] as const) {
    it(`holds one caffeinate -i, tied to the bridge, for ${source}`, async () => {
      const { world, spawn, keepAwake, pass } = rig();
      world.inFlight = counts;
      await keepAwake.tick();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith('caffeinate', ['-i', '-w', '4242']);
      expect(keepAwake.state()).toEqual({ available: true, holding: true });

      // Exactly one: further ticks with work in flight start nothing more.
      for (let i = 0; i < 5; i += 1) {
        pass(30_000);
        await keepAwake.tick();
      }
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  }

  it('holds nothing while nothing is in flight', async () => {
    const { spawn, keepAwake } = rig();
    await keepAwake.tick();
    expect(spawn).not.toHaveBeenCalled();
    expect(keepAwake.state().holding).toBe(false);
  });

  it('lets go a minute after the last tick that saw work, and not before', async () => {
    const { world, children, keepAwake, pass } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    world.inFlight = NOTHING;

    pass(KEEP_AWAKE_GRACE_MS - 1_000);
    await keepAwake.tick();
    expect(children[0]?.killed).toEqual([]);
    expect(keepAwake.state().holding).toBe(true);

    pass(1_000);
    await keepAwake.tick();
    expect(children[0]?.killed).toEqual(['SIGTERM']);
    expect(keepAwake.state().holding).toBe(false);
  });

  it('measures the grace on the monotonic clock, so a wall clock stepped back does not hold it', async () => {
    const { world, children, keepAwake, pass } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    world.inFlight = NOTHING;
    world.wall -= 10 * 60_000;
    pass(KEEP_AWAKE_GRACE_MS);
    await keepAwake.tick();
    expect(children[0]?.killed).toEqual(['SIGTERM']);
  });

  it('does not flap between one task and the next', async () => {
    const { world, spawn, children, keepAwake, pass } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    world.inFlight = NOTHING;
    pass(30_000);
    await keepAwake.tick();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    pass(30_000);
    await keepAwake.tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0]?.killed).toEqual([]);
  });

  it('starts another when caffeinate dies on its own while work is in flight, and none once nothing is', async () => {
    const { world, spawn, children, keepAwake, pass } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    children[0]?.emit('exit');
    expect(keepAwake.state().holding).toBe(false);

    pass(30_000);
    await keepAwake.tick();
    expect(spawn).toHaveBeenCalledTimes(2);

    children[1]?.emit('exit');
    world.inFlight = NOTHING;
    pass(KEEP_AWAKE_GRACE_MS);
    await keepAwake.tick();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('lets go on the next tick when the switch is turned off, and takes no new one', async () => {
    const { world, spawn, children, keepAwake, pass } = rig();
    world.inFlight = { tasks: 2, merges: 1, deploys: 0 };
    await keepAwake.tick();
    world.setting = 'off';
    pass(30_000);
    await keepAwake.tick();
    expect(children[0]?.killed).toEqual(['SIGTERM']);
    pass(30_000);
    await keepAwake.tick();
    expect(spawn).toHaveBeenCalledTimes(1);

    // `on`, or the setting absent, is on.
    world.setting = 'on';
    pass(30_000);
    await keepAwake.tick();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('holds nothing, and fails nothing, on a host that is not macOS', async () => {
    const { world, spawn, keepAwake } = rig({ platform: 'linux' });
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await expect(keepAwake.tick()).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    expect(keepAwake.state()).toEqual({ available: false, holding: false });
  });

  it('holds nothing on a Mac with no caffeinate on its PATH', async () => {
    const { world, spawn, keepAwake } = rig({ onPath: () => false });
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    expect(spawn).not.toHaveBeenCalled();
    expect(keepAwake.state().available).toBe(false);
  });

  it('stops trying once a spawn finds no caffeinate after all', async () => {
    const { world, spawn, children, keepAwake, pass } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    children[0]?.emit('error', Object.assign(new Error('spawn caffeinate ENOENT'), { code: 'ENOENT' }));
    expect(keepAwake.state()).toEqual({ available: false, holding: false });
    pass(30_000);
    await keepAwake.tick();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('neither starts nor stops caffeinate when what is in flight cannot be read', async () => {
    const { world, spawn, children, keepAwake, pass } = rig();
    world.failing = true;
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    expect(spawn).not.toHaveBeenCalled();

    world.failing = false;
    await keepAwake.tick();
    expect(spawn).toHaveBeenCalledTimes(1);

    // Well past the grace, with the database down: the assertion stays.
    world.failing = true;
    pass(KEEP_AWAKE_GRACE_MS * 3);
    await keepAwake.tick();
    expect(children[0]?.killed).toEqual([]);
  });

  it('lets go and clears its timer at shutdown', async () => {
    vi.useFakeTimers();
    try {
      const { world, spawn, children, keepAwake } = rig();
      world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
      keepAwake.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      await keepAwake.stop();
      expect(children[0]?.killed).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ticks every 30 seconds once started', async () => {
    vi.useFakeTimers();
    try {
      const inFlight = vi.fn(async () => NOTHING);
      const { keepAwake } = rig({ inFlight });
      keepAwake.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(inFlight).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(inFlight).toHaveBeenCalledTimes(2);
      await keepAwake.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills the child synchronously for the exit handler', async () => {
    const { world, children, keepAwake } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    keepAwake.killNow();
    expect(children[0]?.killed).toEqual(['SIGTERM']);
  });
});

describe('noticing the machine slept', () => {
  const FORTY_SEVEN_MINUTES = 47 * 60_000;

  it('records a sleep after a tick that saw work, with what it saw', async () => {
    const { world, slept, asked, keepAwake, pass } = rig();
    world.inFlight = { tasks: 2, merges: 1, deploys: 0 };
    await keepAwake.tick();
    pass(30_000);
    await keepAwake.tick();

    // Suspended: the wall clock runs on, the monotonic one stands still.
    world.wall += FORTY_SEVEN_MINUTES;
    world.mono += 2_000;
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();

    expect(slept).toEqual([
      {
        sleptAt: new Date(START + 30_000).toISOString(),
        wokeAt: new Date(START + 30_000 + FORTY_SEVEN_MINUTES).toISOString(),
        seconds: 47 * 60,
        inFlight: { tasks: 2, merges: 1, deploys: 0 },
        keepAwake: 'holding',
      },
    ]);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('says keep-awake was off, or could not hold here', async () => {
    for (const [overrides, setting, was] of [
      [{}, 'off', 'off'],
      [{ platform: 'linux' as const }, null, 'unavailable'],
    ] as const) {
      const { world, slept, keepAwake } = rig(overrides);
      world.setting = setting;
      world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
      await keepAwake.tick();
      world.wall += 10 * 60_000;
      await keepAwake.tick();
      expect(slept.map((one) => one.keepAwake)).toEqual([was]);
    }
  });

  it('records a sleep whose wake tick cannot read the database, once', async () => {
    const { world, slept, keepAwake, pass } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();

    // The pooled connection died with the sleep: the wake tick's read fails.
    world.wall += FORTY_SEVEN_MINUTES;
    world.failing = true;
    await keepAwake.tick();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toMatchObject({ seconds: 47 * 60, inFlight: { tasks: 1, merges: 0, deploys: 0 } });

    world.failing = false;
    pass(30_000);
    await keepAwake.tick();
    expect(slept).toHaveLength(1);
  });

  it('writes a sleep it could not write on the next tick, and only once', async () => {
    let down = true;
    const written: Slept[] = [];
    const { world, keepAwake, pass } = rig({
      recordSleep: async (one) => {
        if (down) throw new Error('connection terminated');
        written.push(one);
      },
    });
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    world.wall += FORTY_SEVEN_MINUTES;
    await keepAwake.tick();
    expect(written).toEqual([]);

    down = false;
    pass(30_000);
    await keepAwake.tick();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ sleptAt: new Date(START).toISOString(), inFlight: { tasks: 1, merges: 0, deploys: 0 } });

    pass(30_000);
    await keepAwake.tick();
    expect(written).toHaveLength(1);
  });

  it('does not say it was holding when caffeinate could not be started', async () => {
    const { world, slept, keepAwake } = rig({
      spawn: () => {
        throw new Error('spawn EAGAIN');
      },
    });
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    world.wall += 10 * 60_000;
    await keepAwake.tick();
    expect(slept.map((one) => one.keepAwake)).toEqual(['unavailable']);
  });

  it('records nothing after a tick that saw no work', async () => {
    const { world, slept, keepAwake } = rig();
    await keepAwake.tick();
    world.wall += 10 * 60_000;
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    expect(slept).toEqual([]);
  });

  it('records nothing for an event loop blocked as long, where the monotonic clock moved too', async () => {
    const { world, slept, keepAwake, pass } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    pass(120_001 + 60_000);
    await keepAwake.tick();
    expect(slept).toEqual([]);
  });

  it('records nothing for a gap of 90 seconds, however the clocks moved', async () => {
    const { world, slept, keepAwake } = rig();
    world.inFlight = { tasks: 1, merges: 0, deploys: 0 };
    await keepAwake.tick();
    world.wall += 90_000;
    await keepAwake.tick();
    expect(slept).toEqual([]);
  });
});

describe('looking for caffeinate', () => {
  it('finds an executable in a PATH directory, and nothing in none', () => {
    expect(onPath('node', process.env.PATH)).toBe(true);
    expect(onPath('surely-no-such-command-here', process.env.PATH)).toBe(false);
    expect(onPath('node', '')).toBe(false);
  });
});
