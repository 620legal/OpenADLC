import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(async () => []) }));

import { query } from '../client.js';
import { mergeSettingJson, removeSettingJsonKey, setSettings } from './settings.js';

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

describe('settings that say one thing together', () => {
  it('are written in one statement, so none is left beside another’s old value', async () => {
    await setSettings({ publicUrl: 'https://persons-own-1.trycloudflare.com', webhookMode: 'address' }, 'openadlc');

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('on conflict (key) do update');
    expect(params).toEqual([[], ['publicUrl', 'webhookMode'], ['https://persons-own-1.trycloudflare.com', 'address'], 'openadlc']);
  });

  it('clears each that is empty in the same statement, as one setting is cleared', async () => {
    await setSettings({ publicUrl: '', webhookMode: '' }, 'openadlc');

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('delete from settings where key = any($1::text[])');
    expect(params).toEqual([['publicUrl', 'webhookMode'], [], [], 'openadlc']);
  });
});
