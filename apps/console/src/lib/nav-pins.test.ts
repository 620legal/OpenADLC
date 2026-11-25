// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_PIN_DEFAULTS, NAV_PINS_CHANGED, NAV_PINS_KEY, onPinsChange, pin, storedPins, unpin } from './nav-pins';

/** A store holding one value for the key, as localStorage would. */
function store(value: string | null) {
  const held = new Map<string, string>(value === null ? [] : [[NAV_PINS_KEY, value]]);
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, next: string) => void held.set(key, next),
    held,
  };
}

afterEach(() => localStorage.clear());

describe('what is pinned', () => {
  it('is Board, Needs you, Crew and Releases when nothing is stored', () => {
    expect(NAV_PIN_DEFAULTS).toEqual(['board', 'needs-you', 'crew', 'releases']);
    expect(storedPins(store(null))).toEqual(['board', 'needs-you', 'crew', 'releases']);
    expect(storedPins(null)).toEqual([...NAV_PIN_DEFAULTS]);
  });

  it('is the defaults for a value it cannot read, or storage that throws', () => {
    for (const bad of ['not json', '{"a":1}', '"board"', 'null', '7']) expect(storedPins(store(bad)), bad).toEqual([...NAV_PIN_DEFAULTS]);
    const throwing = {
      getItem: () => {
        throw new Error('site data blocked');
      },
    };
    expect(storedPins(throwing)).toEqual([...NAV_PIN_DEFAULTS]);
  });

  it('drops an entry that names no page, or repeats one, and keeps the rest', () => {
    expect(storedPins(store('["costs","nope","costs"]'))).toEqual(['costs']);
    expect(storedPins(store('["releases",3,null,"board"]'))).toEqual(['releases', 'board']);
  });

  it('keeps nothing pinned as nothing pinned: the person chose it', () => {
    expect(storedPins(store('[]'))).toEqual([]);
  });

  it('is read from this browser’s localStorage by default', () => {
    localStorage.setItem(NAV_PINS_KEY, '["insights"]');
    expect(storedPins()).toEqual(['insights']);
  });
});

describe('pinning and unpinning', () => {
  it('adds a page to the end, from the defaults when nothing was stored', () => {
    const held = store(null);
    pin('costs', held);
    expect(JSON.parse(held.held.get(NAV_PINS_KEY)!)).toEqual(['board', 'needs-you', 'crew', 'releases', 'costs']);
    pin('settings', held);
    expect(storedPins(held)).toEqual(['board', 'needs-you', 'crew', 'releases', 'costs', 'settings']);
  });

  it('takes a page out, keeping the others in their order', () => {
    const held = store('["releases","crew","board"]');
    unpin('crew', held);
    expect(storedPins(held)).toEqual(['releases', 'board']);
    unpin('releases', held);
    unpin('board', held);
    expect(held.held.get(NAV_PINS_KEY)).toBe('[]');
  });

  it('does nothing, and says nothing, for a page already as asked', () => {
    const held = store('["crew"]');
    const heard = vi.fn();
    window.addEventListener(NAV_PINS_CHANGED, heard);
    try {
      pin('crew', held);
      unpin('costs', held);
    } finally {
      window.removeEventListener(NAV_PINS_CHANGED, heard);
    }
    expect(held.held.get(NAV_PINS_KEY)).toBe('["crew"]');
    expect(heard).not.toHaveBeenCalled();
  });

  it('says so to this tab after each change', () => {
    const heard = vi.fn();
    const stop = onPinsChange(heard);
    pin('costs');
    unpin('costs');
    stop();
    pin('insights');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('hears another tab’s change through the storage event, and no other key’s', () => {
    const heard = vi.fn();
    const stop = onPinsChange(heard);
    window.dispatchEvent(new StorageEvent('storage', { key: 'openadlc.alerts.tab' }));
    window.dispatchEvent(new StorageEvent('storage', { key: NAV_PINS_KEY }));
    stop();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('leaves the page as it was when storage refuses the write', () => {
    const refusing = {
      getItem: () => '["crew"]',
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => pin('costs', refusing)).not.toThrow();
    expect(storedPins(refusing)).toEqual(['crew']);
  });
});
