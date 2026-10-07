import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(async () => []) }));

import { query } from '../client.js';
import { mergeSettingJson, removeSettingJsonKey } from './settings.js';

beforeEach(() => {
  vi.mocked(query).mockClear();
});

describe('changing one field of a JSON setting', () => {
  it('adds a field in the database, without reading the object back first', async () => {
    await mergeSettingJson('heldItems', { 'api#7': { by: 'janedoe', at: '2026-10-02T10:00:00Z', why: null } }, 'janedoe');

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('|| excluded.value::jsonb');
    expect(params).toEqual(['heldItems', JSON.stringify({ 'api#7': { by: 'janedoe', at: '2026-10-02T10:00:00Z', why: null } }), 'janedoe']);
  });

  it('takes a field out in the database', async () => {
    await removeSettingJsonKey('heldItems', 'api#7', 'bridge');

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('value::jsonb - $2');
    expect(params).toEqual(['heldItems', 'api#7', 'bridge']);
  });
});
