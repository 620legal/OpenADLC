import { threads } from '@fleetadlc/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatermarkStream, botProbe } from './thread-stream.js';

/**
 * The watcher's bookkeeping, which is the part that goes wrong quietly.
 *
 * A stream that keeps probing after the last panel closed is the polling this
 * replaced, moved somewhere nobody looks at. A stream that stops probing while
 * somebody is still listening is a panel that has silently stopped updating.
 * Neither shows up as an error.
 */
let watermark: { latest: string; count: number };
let probes: number;

beforeEach(() => {
  watermark = { latest: '1', count: 1 };
  probes = 0;
  vi.spyOn(threads, 'threadWatermark').mockImplementation(async () => {
    probes += 1;
    return watermark;
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets the probe's promise settle as well as its timer fire. */
async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(10);
  }
}

describe('telling a panel when to re-read', () => {
  it('says nothing while nothing changes', async () => {
    // The whole point. A panel open on an idle bot should cost one connection
    // and no messages, where it used to cost a request every five seconds.
    const stream = new WatermarkStream(10);
    const seen: string[] = [];
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => seen.push(mark));

    await tick(5);
    expect(probes).toBeGreaterThan(1);
    expect(seen).toEqual([]);
  });

  it('says so once when something does', async () => {
    const stream = new WatermarkStream(10);
    const seen: string[] = [];
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => seen.push(mark));

    await tick(2);
    watermark = { latest: '2', count: 2 };
    await tick(3);

    expect(seen).toHaveLength(1);
  });

  it('notices a message being removed, not only added', async () => {
    // The newest id alone would not move when a message is deleted, and the
    // panel would keep showing one that is gone.
    const stream = new WatermarkStream(10);
    const seen: string[] = [];
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => seen.push(mark));

    await tick(2);
    watermark = { latest: '1', count: 0 };
    await tick(2);

    expect(seen).toHaveLength(1);
  });

  it('tells every panel open on the same bot, from one probe', async () => {
    // Two people watching one bot is one watcher, not two.
    const stream = new WatermarkStream(10);
    const first: string[] = [];
    const second: string[] = [];
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => first.push(mark));
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => second.push(mark));

    await tick(2);
    const before = probes;
    watermark = { latest: '9', count: 9 };
    await tick(2);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    // One probe per tick, not one per subscriber.
    expect(probes - before).toBeLessThanOrEqual(3);
    expect(stream.watching).toBe(1);
  });

  it('stops probing when the last panel closes', async () => {
    // Otherwise this is the old polling, moved into the bridge where nobody
    // sees it and nothing ever stops it.
    const stream = new WatermarkStream(10);
    const stopFirst = stream.subscribe('bot:bot-1', botProbe('bot-1'), () => undefined);
    const stopSecond = stream.subscribe('bot:bot-1', botProbe('bot-1'), () => undefined);

    await tick(2);
    stopFirst();
    expect(stream.watching).toBe(1);

    stopSecond();
    expect(stream.watching).toBe(0);

    const after = probes;
    await tick(5);
    expect(probes).toBe(after);
  });

  it('watches each bot separately', async () => {
    const stream = new WatermarkStream(10);
    stream.subscribe('bot:bot-1', botProbe('bot-1'), () => undefined);
    stream.subscribe('bot:bot-2', botProbe('bot-2'), () => undefined);
    expect(stream.watching).toBe(2);
  });

  it('survives a database blip rather than dropping the stream', async () => {
    // A failed probe is not a reason to disconnect a person. The panel stays
    // connected and the next probe tries again.
    const stream = new WatermarkStream(10);
    const seen: string[] = [];
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => seen.push(mark));

    await tick(2);
    vi.mocked(threads.threadWatermark).mockRejectedValueOnce(new Error('connection terminated'));
    await tick(2);

    expect(stream.watching).toBe(1);
    watermark = { latest: '3', count: 3 };
    await tick(3);
    expect(seen).toHaveLength(1);
  });

  it('announces a change made before the first interval’s probe', async () => {
    // The panel reads when the stream opens. A baseline taken one interval
    // later took in whatever was written in between, and never said so.
    const stream = new WatermarkStream(1_000);
    const seen: string[] = [];
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => seen.push(mark));

    await vi.advanceTimersByTimeAsync(300);
    watermark = { latest: '2', count: 2 };
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen).toEqual(['2:2']);
  });

  it('has its baseline once ready settles, for a second panel as well', async () => {
    const stream = new WatermarkStream(1_000);
    const seen: string[] = [];
    stream.subscribe('bot:bot-1', botProbe('bot-1'), () => undefined);
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => seen.push(mark));

    await stream.ready('bot:bot-1');
    expect(probes).toBe(1);
    watermark = { latest: '2', count: 2 };
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen).toEqual(['2:2']);
  });
});

describe('watching a work item as well as a bot', () => {
  it('keeps one watcher per key, each with its own probe', async () => {
    // A bot's panel and an item's view are different keys: neither the
    // bot's probe nor the item's stands in for the other.
    const stream = new WatermarkStream(10);
    let itemMark = 'a';
    let itemProbes = 0;
    const itemProbe = async (): Promise<string> => {
      itemProbes += 1;
      return itemMark;
    };
    const onItem: string[] = [];
    const onBot: string[] = [];
    stream.subscribe('item:api#12', itemProbe, (mark) => onItem.push(mark));
    stream.subscribe('bot:bot-1', botProbe('bot-1'), (mark) => onBot.push(mark));
    expect(stream.watching).toBe(2);

    await tick(2);
    itemMark = 'b';
    await tick(2);

    expect(onItem).toEqual(['b']);
    expect(onBot).toEqual([]);
    expect(itemProbes).toBeGreaterThan(1);
  });

  it('asks the first subscriber’s probe only, however many open the same item', async () => {
    const stream = new WatermarkStream(10);
    const first = vi.fn(async () => 'x');
    const second = vi.fn(async () => 'y');
    stream.subscribe('item:api#12', first, () => undefined);
    stream.subscribe('item:api#12', second, () => undefined);

    await tick(3);
    expect(first).toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(stream.watching).toBe(1);
  });
});
