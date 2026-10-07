import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The settings row `humanIds`, as the store keeps it. */
const stored = vi.hoisted(() => ({ humanIds: null as string | null }));

vi.mock('@fleetadlc/db', () => ({
  settings: {
    getSetting: vi.fn(async (key: string) => (key === 'humanIds' ? stored.humanIds : null)),
    mergeSettingJson: vi.fn(async (_key: string, fields: Record<string, unknown>) => {
      stored.humanIds = JSON.stringify({ ...(stored.humanIds ? JSON.parse(stored.humanIds) : {}), ...fields });
    }),
    removeSettingJsonKey: vi.fn(async (_key: string, field: string) => {
      const pins = stored.humanIds ? (JSON.parse(stored.humanIds) as Record<string, unknown>) : {};
      delete pins[field];
      stored.humanIds = JSON.stringify(pins);
    }),
  },
}));

import { isPinnedHuman, movedHumans, pinnedHumanIds, repinHumans, resolveHumanIdsWith } from './human-ids.js';

/** GitHub as far as these ask it: the account behind each login. */
const accounts: Record<string, number | false> = {};
const resolve = vi.fn(async (login: string) => accounts[login.toLowerCase()] ?? null);

beforeEach(() => {
  stored.humanIds = null;
  for (const login of Object.keys(accounts)) delete accounts[login];
  resolve.mockClear();
  resolveHumanIdsWith(resolve);
});

describe('one of the install’s people, by account', () => {
  it('counts a delivery from the account the login was pinned to', async () => {
    stored.humanIds = JSON.stringify({ janedoe: 101 });
    expect(await isPinnedHuman(['JaneDoe'], 'janedoe', 101)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses the same login from another account: the name was taken over', async () => {
    stored.humanIds = JSON.stringify({ janedoe: 101 });
    expect(await isPinnedHuman(['janedoe'], 'janedoe', 999)).toBe(false);
  });

  it('refuses a delivery that names no account, and a login that is not listed', async () => {
    stored.humanIds = JSON.stringify({ janedoe: 101 });
    expect(await isPinnedHuman(['janedoe'], 'janedoe', undefined)).toBe(false);
    expect(await isPinnedHuman(['janedoe'], 'alexsmith', 101)).toBe(false);
  });

  it('pins a login on its first use, and refuses when GitHub cannot be asked', async () => {
    accounts.janedoe = 101;
    expect(await isPinnedHuman(['janedoe'], 'janedoe', 101)).toBe(true);
    expect(await pinnedHumanIds()).toEqual({ janedoe: 101 });

    // Not yet pinned, and GitHub does not answer: nobody is admitted as it.
    expect(await isPinnedHuman(['alexsmith'], 'alexsmith', 202)).toBe(false);
    expect(await pinnedHumanIds()).toEqual({ janedoe: 101 });
  });
});

describe('saving the install’s people', () => {
  it('pins each login added, forgets one taken out, and leaves an existing pin where it was', async () => {
    stored.humanIds = JSON.stringify({ janedoe: 101, gone: 7 });
    accounts.janedoe = 999;
    accounts.alexsmith = 202;

    const result = await repinHumans(['janedoe', 'AlexSmith', 'nobody-yet'], 'admin@exampleco.test');

    expect(result).toEqual({ pinned: ['alexsmith'], unresolved: ['nobody-yet'] });
    // A save does not move janedoe to whoever holds the name today.
    expect(await pinnedHumanIds()).toEqual({ janedoe: 101, alexsmith: 202 });
  });
});

describe('a pinned login that names another account now', () => {
  it('is found, with what it was pinned to and what it names now, or that it names none', async () => {
    stored.humanIds = JSON.stringify({ janedoe: 101, alexsmith: 202, samlee: 303 });
    accounts.janedoe = 999;
    accounts.alexsmith = false;
    accounts.samlee = 303;

    const found = await movedHumans(['janedoe', 'alexsmith', 'samlee', 'unpinned', 'quiet'], resolve);

    expect(found.moved).toEqual([
      { login: 'janedoe', pinned: 101, now: 999 },
      { login: 'alexsmith', pinned: 202, now: false },
    ]);
    expect(found.unknown).toEqual([]);
  });

  it('calls a login GitHub did not answer for unknown, not moved', async () => {
    stored.humanIds = JSON.stringify({ janedoe: 101 });
    expect(await movedHumans(['janedoe'], resolve)).toEqual({ moved: [], unknown: ['janedoe'] });
  });
});
