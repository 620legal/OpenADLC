import { describe, expect, it } from 'vitest';
import { forgetUnowned, readUnowned, recordUnowned, unownedFrom, type UnownedStore } from './unowned-issues.js';

function memory(initial: string | null = null): UnownedStore & { value: string | null } {
  const store = {
    value: initial,
    read: async () => store.value,
    write: async (value: string) => {
      store.value = value;
    },
  };
  return store;
}

const SEVEN = { number: 7, title: 'Add 3D rubicube as rub.html', url: 'https://github.com/x/7', author: 'outside-author' };
const THREE = { number: 3, title: 'Add hello.mjs', url: 'https://github.com/x/3', author: 'outside-author' };

describe('the issues OpenADLC will not take on its own', () => {
  it('replaces a repository’s list, and says only when it changed', async () => {
    const store = memory();
    expect(await recordUnowned('testbed', [SEVEN, THREE], store)).toBe(true);
    expect(await recordUnowned('testbed', [THREE, SEVEN], store)).toBe(false);
    expect((await readUnowned(store))['testbed']?.map((one) => one.number)).toEqual([3, 7]);
    expect(await recordUnowned('testbed', [], store)).toBe(true);
    expect(await readUnowned(store)).toEqual({});
  });

  it('forgets the ones a person decided about', async () => {
    const store = memory();
    await recordUnowned('testbed', [SEVEN, THREE], store);
    await forgetUnowned('testbed', [3], store);
    expect((await readUnowned(store))['testbed']?.map((one) => one.number)).toEqual([7]);
  });

  it('reads nothing from a setting it cannot parse', () => {
    expect(unownedFrom('not json')).toEqual({});
    expect(unownedFrom('[]')).toEqual({});
    expect(unownedFrom(JSON.stringify({ x: [{ number: 'one' }] }))).toEqual({ x: [] });
  });
});
