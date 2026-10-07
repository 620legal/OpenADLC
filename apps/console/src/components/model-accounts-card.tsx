'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { AccountsStep } from '@/components/accounts-step';
import { SettingsCard } from '@/components/settings-sections';
import type { AccountRef, CrewBot } from '@/lib/model-onboarding';

/**
 * Settings' AI models: every model account, what it is, whether it works and
 * what it offers, with adding, signing in, checking and removing one.
 *
 * These lived only on the walkthrough's accounts step, so a key that changed
 * or a subscription that signed out sent a person back through setup to fix
 * it. The section is that step itself (`AccountsStep`, `place="settings"`),
 * not a second copy of it; which bot uses which account stays under Crew.
 *
 * Crew's pickers are drawn on the server from the accounts it read, so an
 * account added or removed here refreshes the page: the new one is there to
 * choose without a reload. That refresh leaves this card as it is, so the
 * note an account's first check left stays on screen. The page keys the card
 * on which account each bot thinks with (`modelAccountsKey`), so a bot moved
 * on its Crew row, which refreshes the page too, draws it again with its
 * tags current.
 */
export function ModelAccountsCard({ initial = null }: { initial?: AccountRef[] | null }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountRef[] | null>(initial);
  const [crew, setCrew] = useState<CrewBot[] | null>(null);
  const known = useRef<string | null>(initial ? accountIds(initial) : null);
  const onAccounts = useCallback(
    (next: AccountRef[]): void => {
      setAccounts(next);
      known.current = followAccounts(known.current, next, () => router.refresh());
    },
    [router],
  );
  return (
    <SettingsCard id="models" title="AI models" line="The accounts the crew thinks with, and the models each one offers.">
      <AccountsStep accounts={accounts} crew={crew} onAccounts={onAccounts} onCrew={setCrew} place="settings" />
    </SettingsCard>
  );
}

/** The accounts, as a set, in a form two reads can be compared by. */
export function accountIds(accounts: readonly Pick<AccountRef, 'id'>[]): string {
  return accounts
    .map((account) => account.id)
    .sort()
    .join(',');
}

/** Whether a read added or removed an account since the last one; the first read is not a change. */
export function accountsChanged(before: string | null, now: string): boolean {
  return before !== null && before !== now;
}

/**
 * What a read of the accounts does to the page: refreshes it when an account
 * was added or removed since the last read, so Crew's pickers have it. Returns
 * the accounts to compare the next read with.
 */
export function followAccounts(known: string | null, next: readonly Pick<AccountRef, 'id'>[], refresh: () => void): string {
  const ids = accountIds(next);
  if (accountsChanged(known, ids)) refresh();
  return ids;
}

