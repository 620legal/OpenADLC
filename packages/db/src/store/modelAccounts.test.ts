import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import {
  AccountInUse,
  ModelAccountNotFound,
  VERIFY_ERROR_MAX,
  accountInUseMessage,
  clearVerification,
  create,
  list,
  recordVerification,
  remove,
} from './modelAccounts.js';

const ACCOUNT_ID = '550e8400-e29b-41d4-a716-446655440000';
const NINE = ['atlas', 'bramble', 'cedar', 'dune', 'ember', 'finch', 'grove', 'harbor', 'iris'];

function row(extra: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    provider: 'anthropic' as const,
    kind: 'key' as const,
    label: 'primary',
    created_at: new Date('2026-09-23T12:00:00.000Z'),
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a model account row', () => {
  it('lists accounts and drops anything that is not the row', async () => {
    // The secret is not a column. A mapper that spread the row would publish
    // one the moment somebody added it, so the shape is a whitelist.
    vi.mocked(query).mockResolvedValueOnce([row({ secret: 'sk-leak-me' })]);

    const accounts = await list();

    expect(accounts).toEqual([
      {
        id: ACCOUNT_ID,
        provider: 'anthropic',
        kind: 'key',
        label: 'primary',
        createdAt: '2026-09-23T12:00:00.000Z',
        verifiedAt: null,
        verifyError: null,
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('sk-leak-me');
  });

  it('inserts the provider, the kind and the label, and nothing else', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ kind: 'subscription', label: 'Claude Max' }));

    const account = await create({ provider: 'anthropic', kind: 'subscription', label: '  Claude Max  ' });

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toContain('insert into model_accounts');
    expect(params).toEqual(['anthropic', 'subscription', 'Claude Max']);
    expect(account.kind).toBe('subscription');
    expect(JSON.stringify(params)).not.toContain('sk-');
  });
});

describe('deleting an account a bot still uses', () => {
  it('names every bot and does not delete', async () => {
    vi.mocked(query).mockResolvedValue(NINE.map((name) => ({ name })));

    const error = await remove(ACCOUNT_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AccountInUse);
    expect((error as AccountInUse).message).toBe(accountInUseMessage(NINE));
    for (const name of NINE) expect((error as AccountInUse).message).toContain(name);
    for (const call of vi.mocked(query).mock.calls) {
      expect(String(call[0])).not.toContain('delete from model_accounts');
    }
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('model_account_id');
  });

  it('says which one bot, when there is only one', () => {
    expect(accountInUseMessage(['nova'])).toBe('nova still uses this account. Move it to another account under Crew first, then remove it.');
    expect(accountInUseMessage([])).toBe('a bot still uses this account. Move it to another account under Crew first, then remove it.');
  });

  it('deletes when nothing references it', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: ACCOUNT_ID }]);

    await remove(ACCOUNT_ID);

    expect(String(vi.mocked(query).mock.calls[1]?.[0])).toContain('delete from model_accounts');
  });

  it('is a missing account when the row is already gone', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(remove(ACCOUNT_ID)).rejects.toBeInstanceOf(ModelAccountNotFound);
  });

  it('still names the bots when one is assigned between the check and the delete', async () => {
    const violation = Object.assign(new Error('insert or update on table'), { code: '23503' });
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(violation)
      .mockResolvedValueOnce([{ name: 'atlas' }, { name: 'nova' }]);

    await expect(remove(ACCOUNT_ID)).rejects.toThrow('atlas, nova still use this account. Move them to another account under Crew first, then remove it.');
  });
});

describe('the last check of an account', () => {
  it('is part of the account a list returns', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      row({ kind: 'subscription', verified_at: new Date('2026-09-24T08:00:00.000Z'), verify_error: null }),
      row({ id: 'other', verified_at: new Date('2026-09-24T09:00:00.000Z'), verify_error: 'Not logged in · Please run /login' }),
    ]);

    const [passed, failed] = await list();

    expect(passed).toMatchObject({ verifiedAt: '2026-09-24T08:00:00.000Z', verifyError: null });
    expect(failed).toMatchObject({ verifiedAt: '2026-09-24T09:00:00.000Z', verifyError: 'Not logged in · Please run /login' });
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('verified_at, verify_error');
  });

  it('records when it ran and what the CLI said, and returns the account', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(
      row({ verified_at: new Date('2026-09-24T08:00:00.000Z'), verify_error: 'OAuth access token is invalid.' }),
    );

    const account = await recordVerification(ACCOUNT_ID, {
      checkedAt: '2026-09-24T08:00:00.000Z',
      error: 'OAuth access token is invalid.',
    });

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toContain('update model_accounts set verified_at = $2, verify_error = $3');
    expect(params).toEqual([ACCOUNT_ID, '2026-09-24T08:00:00.000Z', 'OAuth access token is invalid.']);
    expect(account.verifyError).toBe('OAuth access token is invalid.');
  });

  it('records a pass as a time with no error', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ verified_at: new Date('2026-09-24T08:00:00.000Z') }));

    await recordVerification(ACCOUNT_ID, { checkedAt: '2026-09-24T08:00:00.000Z', error: null });

    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual([ACCOUNT_ID, '2026-09-24T08:00:00.000Z', null]);
  });

  it('keeps no more of a message than hostd sends', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row());

    await recordVerification(ACCOUNT_ID, { checkedAt: '2026-09-24T08:00:00.000Z', error: 'x'.repeat(5_000) });

    const params = vi.mocked(queryOne).mock.calls[0]?.[1] as unknown[];
    expect(String(params[2])).toHaveLength(VERIFY_ERROR_MAX);
  });

  it('is a missing account when there is no row to record it on', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    await expect(
      recordVerification(ACCOUNT_ID, { checkedAt: '2026-09-24T08:00:00.000Z', error: null }),
    ).rejects.toBeInstanceOf(ModelAccountNotFound);
  });

  it('is forgotten when the credential it was about is replaced', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await clearVerification(ACCOUNT_ID);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('set verified_at = null, verify_error = null');
    expect(params).toEqual([ACCOUNT_ID]);
  });

  it('has somewhere to live on an install that already has accounts', () => {
    // Both nullable and added with `if not exists`: `fleetadlc up` migrates an
    // install with rows in it, and a not-null column would stop it there.
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0009_model_account_verification.sql'),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();

    expect(sql).toContain('alter table model_accounts add column if not exists verified_at timestamptz;');
    expect(sql).toContain('alter table model_accounts add column if not exists verify_error text;');
    expect(sql).not.toContain('not null');
  });
});
