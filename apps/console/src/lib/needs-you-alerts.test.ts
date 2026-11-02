import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from './api';
import {
  batchText,
  chime,
  CLAIM_FOR_MS,
  CLAIMED_KEY,
  claimAcrossTabs,
  claimInTurn,
  CLAIM_LOCK,
  type LocksLike,
  consoleName,
  FAVICON_RING,
  faviconSvg,
  newItems,
  notificationText,
  titleFor,
  type AudioContextLike,
} from './needs-you-alerts';

function subject(partial: Partial<AttentionItem['subject']> = {}): AttentionItem['subject'] {
  return { repo: 'OpenADLC', number: 42, title: 'Add a health endpoint', ref: 'OpenADLC#42', url: null, ...partial };
}

describe('the tab title', () => {
  it('carries the count while anything waits', () => {
    expect(titleFor(2, 'OpenADLC', true)).toBe('(2) OpenADLC');
    expect(titleFor(2, consoleName({ name: 'Acme' }), true)).toBe('(2) Acme');
  });

  it('is the plain name at nothing, for a count that could not be read, and with the switch off', () => {
    expect(titleFor(0, 'OpenADLC', true)).toBe('OpenADLC');
    expect(titleFor(null, 'OpenADLC', true)).toBe('OpenADLC');
    expect(titleFor(3, 'OpenADLC', false)).toBe('OpenADLC');
  });

  it('names the console as its header does', () => {
    expect(consoleName({ name: null })).toBe('OpenADLC');
    expect(consoleName({ name: 'Acme' })).toBe('Acme');
  });
});

describe('what a notification says', () => {
  const question = { headline: 'The builder has a question', subject: subject() };

  it('names the bot and the issue, with the repository only when there are several', () => {
    expect(notificationText(question, ['OpenADLC'])).toBe('The builder has a question about #42');
    expect(notificationText(question, ['OpenADLC', 'web'])).toBe('The builder has a question about OpenADLC#42');
  });

  it('leaves a headline that names its number as it is', () => {
    expect(notificationText({ headline: 'Pull request #12 waits for you to merge it', subject: subject({ number: 12 }) }, ['OpenADLC'])).toBe(
      'Pull request #12 waits for you to merge it',
    );
  });

  it('names a request with no number by its title, and says the headline alone with nothing to name', () => {
    expect(notificationText({ headline: 'Intake has a question', subject: subject({ number: null, ref: null }) }, ['OpenADLC'])).toBe(
      'Intake has a question about “Add a health endpoint”',
    );
    expect(notificationText({ headline: 'Intake has a question', subject: subject({ number: null, ref: null, title: null }) }, ['OpenADLC'])).toBe(
      'Intake has a question',
    );
  });

  it('says several at once as one', () => {
    expect(batchText(3)).toBe('3 new items need you');
  });
});

describe('what is new', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };

  it('is nothing on the first read, which only sets the baseline', () => {
    const first = newItems(null, [a, b]);
    expect(first.fresh).toEqual([]);
    expect([...first.seen!]).toEqual(['a', 'b']);
  });

  it('is an id not seen before, and only that', () => {
    const first = newItems(null, [a]);
    expect(newItems(first.seen, [a, b]).fresh).toEqual([b]);
  });

  it('is not an item that went and came back', () => {
    let seen = newItems(null, [a]).seen;
    seen = newItems(seen, []).seen;
    expect(newItems(seen, [a]).fresh).toEqual([]);
  });

  it('changes nothing, the baseline included, for a read with no items', () => {
    expect(newItems(null, null)).toEqual({ fresh: [], seen: null });
    const seen = newItems(null, [a]).seen;
    expect(newItems(seen, null)).toEqual({ fresh: [], seen });
    // The read after is still measured against the first.
    expect(newItems(seen, [a, b]).fresh).toEqual([b]);
  });
});

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe('two tabs open', () => {
  it('leaves an item another tab claimed to that tab', () => {
    const store = memory();
    expect(claimAcrossTabs(['a', 'b'], store, 1_000)).toEqual(['a', 'b']);
    expect(claimAcrossTabs(['b', 'c'], store, 2_000)).toEqual(['c']);
  });

  it('drops a claim once it is old', () => {
    const store = memory({ [CLAIMED_KEY]: JSON.stringify({ a: 0 }) });
    expect(claimAcrossTabs(['a'], store, CLAIM_FOR_MS - 1)).toEqual([]);
    expect(claimAcrossTabs(['a'], store, CLAIM_FOR_MS * 3)).toEqual(['a']);
    expect(JSON.parse(store.values.get(CLAIMED_KEY)!)).toEqual({ a: CLAIM_FOR_MS * 3 });
  });

  it('claims every id itself when storage throws or holds something else', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(claimAcrossTabs(['a', 'b'], broken, 1)).toEqual(['a', 'b']);
    expect(claimAcrossTabs(['a'], memory({ [CLAIMED_KEY]: 'not json' }), 1)).toEqual(['a']);
  });
});

describe('two tabs claiming at once', () => {
  it('reads and writes the claim only while holding the lock every tab shares', async () => {
    let held = false;
    const touched: boolean[] = [];
    const base = memory();
    const store = {
      getItem: (key: string) => (touched.push(held), base.getItem(key)),
      setItem: (key: string, value: string) => (touched.push(held), base.setItem(key, value)),
    };
    const names: string[] = [];
    const lock: LocksLike = {
      async request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
        names.push(name);
        held = true;
        try {
          return await callback();
        } finally {
          held = false;
        }
      },
    };
    expect(await claimInTurn(['a'], store, () => 1, lock)).toEqual(['a']);
    expect(await claimInTurn(['a'], store, () => 2, lock)).toEqual([]);
    expect(names).toEqual([CLAIM_LOCK, CLAIM_LOCK]);
    expect(touched).toEqual([true, true, true, true]);
  });

  it('claims without a lock where the browser has none, or refuses one', async () => {
    expect(await claimInTurn(['a'], memory(), () => 1, undefined)).toEqual(['a']);
    const refusing: LocksLike = { request: () => Promise.reject(new Error('SecurityError')) };
    const store = memory();
    expect(await claimInTurn(['a'], store, () => 1, refusing)).toEqual(['a']);
    expect(await claimInTurn(['a'], store, () => 2, refusing)).toEqual([]);
  });
});

/** WCAG's relative luminance of a `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('the tab icon', () => {
  it('is an SVG with a ring that stands out on a light tab strip and a dark one', () => {
    const svg = decodeURIComponent(faviconSvg().replace('data:image/svg+xml,', ''));
    expect(faviconSvg().startsWith('data:image/svg+xml,')).toBe(true);
    expect(svg).toContain(`stroke="${FAVICON_RING}"`);
    expect(contrast(FAVICON_RING, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(FAVICON_RING, '#202124')).toBeGreaterThanOrEqual(3);
  });
});

describe('the chime', () => {
  function audio(options: { resume?: () => Promise<void>; construct?: () => void } = {}) {
    const started: number[] = [];
    const closed: number[] = [];
    const Context = class {
      currentTime = 0;
      destination = {};
      constructor() {
        options.construct?.();
      }
      resume = options.resume ?? (async () => undefined);
      close = async () => void closed.push(1);
      createOscillator() {
        return { type: '', frequency: { value: 0 }, connect: () => undefined, start: (at = 0) => void started.push(at), stop: () => undefined, onended: null };
      }
      createGain() {
        const gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
        return { gain, connect: () => undefined };
      }
    };
    return { Context: Context as unknown as AudioContextLike, started, closed };
  }

  it('plays one quiet note', () => {
    const { Context, started } = audio();
    chime(Context);
    expect(started).toEqual([0]);
  });

  it('fails silently where sound is blocked or missing', async () => {
    const rejected = audio({ resume: () => Promise.reject(new Error('NotAllowedError')) });
    expect(() => chime(rejected.Context)).not.toThrow();
    const throwing = audio({
      construct: () => {
        throw new Error('no audio');
      },
    });
    expect(() => chime(throwing.Context)).not.toThrow();
    expect(() => chime(undefined)).not.toThrow();
    // A rejected resume is caught, not left unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // And its context is closed: a suspended one never ends its note to close itself.
    expect(rejected.closed).toHaveLength(1);
  });
});
