import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(async () => []) }));

import { query } from '../client.js';
import { allSettings, mergeSettingJson, removeSettingJsonKey, setSettings, settingDigest } from './settings.js';

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

describe('settings too large to read on every request', () => {
  it('are left out of every setting unless asked for, as a backup does', async () => {
    await allSettings();
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('not (key = any($1::text[]))');
    expect(params).toEqual([['consoleLogo']]);

    vi.mocked(query).mockClear();
    vi.mocked(query).mockResolvedValueOnce([
      { key: 'consoleName', value: 'Acme Legal' },
      { key: 'consoleLogo', value: 'data:image/png;base64,iVBORw0KGgo=' },
    ] as never);
    expect(await allSettings({ large: true })).toEqual({ consoleName: 'Acme Legal', consoleLogo: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toBe('select key, value from settings');
  });

  it('are told apart by a digest and their first characters, read in one statement without the value', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ digest: 'abc123', head: 'data:image/svg+xml;base64,PHN2Zy' }] as never);
    expect(await settingDigest('consoleLogo')).toEqual({ digest: 'abc123', head: 'data:image/svg+xml;base64,PHN2Zy' });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('md5(value)');
    expect(String(sql)).toContain('left(value, 40)');
    expect(params).toEqual(['consoleLogo']);

    expect(await settingDigest('consoleLogo')).toBeNull();
  });
});
