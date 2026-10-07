import { describe, expect, it } from 'vitest';
import { modelAccountsKey } from '@/lib/model-accounts-key';
import { accountIds, accountsChanged, followAccounts } from './model-accounts-card';

/**
 * Crew's pickers are drawn on the server, so the page is read again when an
 * account is added or removed here, and this card is drawn again when a bot
 * is moved on its Crew row.
 */
describe('settings’ AI models and the rest of the page', () => {
  it('refreshes the page when an account is added, so Crew can choose it without a reload', () => {
    let refreshed = 0;
    const refresh = () => (refreshed += 1);
    const first = followAccounts(null, [{ id: 'max' }], refresh);
    expect(refreshed).toBe(0);
    const added = followAccounts(first, [{ id: 'max' }, { id: 'xai' }], refresh);
    expect(refreshed).toBe(1);
    followAccounts(added, [{ id: 'max' }], refresh);
    expect(refreshed).toBe(2);
  });

  it('does not refresh on the first read or a re-check that changes no account', () => {
    const before = accountIds([{ id: 'b' }, { id: 'a' }]);
    expect(accountsChanged(null, before)).toBe(false);
    expect(accountsChanged(before, accountIds([{ id: 'a' }, { id: 'b' }]))).toBe(false);
  });

  it('is drawn again when a bot moves accounts, and not when an account is added or removed', () => {
    const on = modelAccountsKey([{ name: 'builder', modelAccountId: 'max' }]);
    expect(modelAccountsKey([{ name: 'builder', modelAccountId: 'max' }])).toBe(on);
    expect(modelAccountsKey([{ name: 'builder', modelAccountId: 'xai' }])).not.toBe(on);
  });
});
