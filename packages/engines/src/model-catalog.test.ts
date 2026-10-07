import { describe, expect, it, vi } from 'vitest';
import { modelListCache, MODEL_LIST_TTL_MS, type ModelListCache } from './model-catalog.js';
import type { AvailableModel } from './model-choice.js';

const OPUS_5: AvailableModel = { id: 'claude-opus-5', createdAt: '2026-04-01' };
const OPUS_6: AvailableModel = { id: 'claude-opus-6', createdAt: '2026-12-01' };

describe('a model list remembered per account', () => {
  it('asks once for every task that starts inside the window', async () => {
    const load = vi.fn(async () => [OPUS_5]);
    const cache = modelListCache();

    const first = await cache.modelsFor('account-1', load);
    const second = await cache.modelsFor('account-1', load);

    expect(first).toEqual([OPUS_5]);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not share one account’s list with another', async () => {
    const load = vi.fn(async () => [OPUS_5]);
    const cache = modelListCache();

    await cache.modelsFor('account-1', load);
    await cache.modelsFor('account-2', load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('asks again once the window has passed, so a newer model is seen', async () => {
    let clock = 1_000;
    const load = vi.fn<() => Promise<AvailableModel[]>>();
    load.mockResolvedValueOnce([OPUS_5]).mockResolvedValueOnce([OPUS_5, OPUS_6]);
    const cache = modelListCache({ ttlMs: MODEL_LIST_TTL_MS, now: () => clock });

    expect(await cache.modelsFor('account-1', load)).toEqual([OPUS_5]);
    clock += MODEL_LIST_TTL_MS - 1;
    expect(await cache.modelsFor('account-1', load)).toEqual([OPUS_5]);
    expect(load).toHaveBeenCalledTimes(1);

    clock += 1;
    expect(await cache.modelsFor('account-1', load)).toEqual([OPUS_5, OPUS_6]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between tasks that start together', async () => {
    let finish: (models: AvailableModel[]) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<AvailableModel[]>((resolve) => {
          finish = resolve;
        }),
    );
    const cache: ModelListCache = modelListCache();

    const first = cache.modelsFor('account-1', load);
    const second = cache.modelsFor('account-1', load);
    expect(load).toHaveBeenCalledTimes(1);

    finish([OPUS_5]);
    await expect(first).resolves.toEqual([OPUS_5]);
    await expect(second).resolves.toEqual([OPUS_5]);
  });

  it('forgets a failure, so the next task asks again', async () => {
    const load = vi.fn<() => Promise<AvailableModel[]>>();
    load.mockRejectedValueOnce(new Error('the provider refused this key')).mockResolvedValueOnce([OPUS_5]);
    const cache = modelListCache();

    await expect(cache.modelsFor('account-1', load)).rejects.toThrow(/refused/);
    await expect(cache.modelsFor('account-1', load)).resolves.toEqual([OPUS_5]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
