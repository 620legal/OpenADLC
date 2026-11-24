// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { HOW_THIS_WORKS_CHANGED, storedStripOpen, storeStripOpen, stripKey, type StripChange } from './how-this-works-preferences';

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    values,
  };
}

const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

describe('a How this works strip’s remembered state', () => {
  it('is open on a first visit', () => {
    expect(storedStripOpen('costs', 'a@x', memory())).toBe(true);
    expect(storedStripOpen('costs', 'a@x', null)).toBe(true);
  });

  it('stays collapsed for the person who collapsed it, and no one else, on that strip alone', () => {
    const store = memory();
    storeStripOpen('costs', 'a@x', false, store);
    expect(storedStripOpen('costs', 'a@x', store)).toBe(false);
    expect(storedStripOpen('costs', 'b@x', store)).toBe(true);
    expect(storedStripOpen('releases', 'a@x', store)).toBe(true);
    expect(store.values.get(stripKey('costs', 'a@x'))).toBe('closed');
  });

  it('is open again once opened again', () => {
    const store = memory();
    storeStripOpen('costs', 'a@x', false, store);
    storeStripOpen('costs', 'a@x', true, store);
    expect(storedStripOpen('costs', 'a@x', store)).toBe(true);
    expect(store.values.get(stripKey('costs', 'a@x'))).toBe('open');
  });

  it('reads a value it does not know as open', () => {
    const store = memory();
    store.values.set(stripKey('costs', 'a@x'), 'sideways');
    expect(storedStripOpen('costs', 'a@x', store)).toBe(true);
  });

  it('never touches storage without an identity', () => {
    const store = memory();
    const said = vi.fn();
    window.addEventListener(HOW_THIS_WORKS_CHANGED, said);
    try {
      expect(storedStripOpen('costs', null, store)).toBe(true);
      storeStripOpen('costs', null, false, store);
    } finally {
      window.removeEventListener(HOW_THIS_WORKS_CHANGED, said);
    }
    expect(store.getItem).not.toHaveBeenCalled();
    expect(store.setItem).not.toHaveBeenCalled();
    expect(said).not.toHaveBeenCalled();
  });

  it('is open, and does not throw, when storage throws', () => {
    expect(storedStripOpen('costs', 'a@x', throwing)).toBe(true);
    expect(() => storeStripOpen('costs', 'a@x', false, throwing)).not.toThrow();
  });

  it('says the change to this tab, with the new state, even when storage refused it', () => {
    const changes: StripChange[] = [];
    const listen = (event: Event) => changes.push((event as CustomEvent<StripChange>).detail);
    window.addEventListener(HOW_THIS_WORKS_CHANGED, listen);
    try {
      storeStripOpen('host-checks', 'a@x', false, memory());
      storeStripOpen('host-checks', 'a@x', true, throwing);
    } finally {
      window.removeEventListener(HOW_THIS_WORKS_CHANGED, listen);
    }
    expect(changes).toEqual([
      { strip: 'host-checks', identity: 'a@x', open: false },
      { strip: 'host-checks', identity: 'a@x', open: true },
    ]);
  });

  it('encodes the identity in its key, so its dots and colons cannot run into the separators', () => {
    expect(stripKey('needs-you', 'ann.lee@x.org')).toBe('openadlc.howThisWorks.needs-you.ann.lee%40x.org');
    expect(stripKey('needs-you', 'a:b')).toBe('openadlc.howThisWorks.needs-you.a%3Ab');
    expect(stripKey('needs-you', 'a.b')).not.toBe(stripKey('needs-you', 'a%2Eb'));
  });
});
