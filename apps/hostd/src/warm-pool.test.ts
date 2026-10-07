import { describe, expect, it, vi } from 'vitest';
import { WARM_MAX_AGE_MS, WarmPool, warmTargets, type WarmComputer, type WarmHost, type WarmKey } from './warm-pool.js';

const IMAGE = 'sha256:new';
const OLD = 'sha256:old';

/** A host that makes warm computers on demand and writes down what it discarded. */
function host(image: string | null = IMAGE) {
  let made = 0;
  const discarded: string[] = [];
  const fake: WarmHost & { image: string | null } = {
    image,
    makeWarm: vi.fn(async (key: WarmKey): Promise<WarmComputer> => {
      made += 1;
      return { name: `warm-${made}`, repoKey: key.repoKey, slotDir: `/work/slots/warm-${made}`, image: fake.image, madeAt: 1_000 };
    }),
    discard: vi.fn(async (name: string) => void discarded.push(name)),
    imageId: async () => fake.image,
  };
  return { fake, discarded };
}

function pool(options: Partial<ConstructorParameters<typeof WarmPool>[0]> & { host: WarmHost }) {
  return new WarmPool({ enabled: true, max: 3, room: () => 4, activeRepos: async () => [], now: () => 2_000, ...options });
}

describe('which warm computers the pool keeps', () => {
  it('is one for work on no repository, then one per repository worked in lately, up to the limit', () => {
    expect(warmTargets(['acme__api', 'acme__web', 'acme__api'], 3)).toEqual([{ repoKey: null }, { repoKey: 'acme__api' }, { repoKey: 'acme__web' }]);
    expect(warmTargets(['acme__api', 'acme__web'], 2)).toEqual([{ repoKey: null }, { repoKey: 'acme__api' }]);
    expect(warmTargets(['acme__api'], 0)).toEqual([]);
  });

  it('makes what is missing, never more than FLEETADLC_WARM_POOL_MAX', async () => {
    const { fake } = host();
    const warm = pool({ host: fake, max: 2, activeRepos: async () => ['acme__api', 'acme__web'] });

    await warm.fill();

    expect(warm.list().map((computer) => computer.repoKey)).toEqual([null, 'acme__api']);
    await warm.fill();
    expect(fake.makeWarm).toHaveBeenCalledTimes(2);
  });

  it('never takes the room a task would have: none when the host runs all it can', async () => {
    const { fake } = host();
    let room = 1;
    const warm = pool({ host: fake, room: () => room, activeRepos: async () => ['acme__api'] });

    await warm.fill();
    expect(warm.list()).toHaveLength(1);

    room = 0;
    await warm.fill();
    expect(warm.list()).toHaveLength(0);
  });

  it('makes nothing when it is off, which it is by default', async () => {
    const { fake } = host();
    const warm = pool({ host: fake, enabled: false });

    await warm.fill();

    expect(fake.makeWarm).not.toHaveBeenCalled();
    expect(warm.take({ repoKey: null }, IMAGE)).toBeNull();
  });
});

describe('claiming a warm computer', () => {
  it('takes one made for the task’s repository on the image in use, once', async () => {
    const { fake } = host();
    const warm = pool({ host: fake, activeRepos: async () => ['acme__api'] });
    await warm.fill();

    const claimed = warm.take({ repoKey: 'acme__api' }, IMAGE);

    expect(claimed?.repoKey).toBe('acme__api');
    expect(warm.holds(claimed!.name)).toBe(false);
    expect(warm.take({ repoKey: 'acme__api' }, IMAGE)).toBeNull();
    // Another repository's cache is not this one's.
    expect(warm.take({ repoKey: 'acme__web' }, IMAGE)).toBeNull();
  });

  it('never hands out one on an image the engine update has replaced', async () => {
    const { fake } = host(OLD);
    const warm = pool({ host: fake });
    await warm.fill();

    expect(warm.take({ repoKey: null }, IMAGE)).toBeNull();
  });
});

describe('draining warm computers', () => {
  it('drains one on a replaced image and one more than a day old, and makes them again', async () => {
    const { fake, discarded } = host(OLD);
    let now = 2_000;
    const warm = pool({ host: fake, now: () => now });
    await warm.fill();
    const first = warm.list()[0]!.name;

    fake.image = IMAGE;
    await warm.fill();
    expect(discarded).toEqual([first]);
    expect(warm.list().map((computer) => computer.image)).toEqual([IMAGE]);

    now = 1_000 + WARM_MAX_AGE_MS + 1;
    await warm.fill();
    expect(discarded).toHaveLength(2);
    expect(warm.list()).toHaveLength(1);
  });
});
