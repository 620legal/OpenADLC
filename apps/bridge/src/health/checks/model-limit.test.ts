import type { HealthRow } from '@openadlc/db';
import type { Bot, ModelAccount } from '@openadlc/shared';
import { describe, expect, it, vi } from 'vitest';
import { checkDue, limitFailure, limitRowOf, modelLimitCheck, resetInWords, type ModelLimitReader } from './model-limit.js';

/**
 * The check that clears a model account's usage-limit hold: only a passing
 * check of the account does, and the reset time only says when to check.
 */

const SINCE = '2026-11-25T14:00:00.000Z';
const ACCOUNT: ModelAccount = { id: 'acct-1', provider: 'anthropic', kind: 'subscription', label: 'Shared Claude', createdAt: '2026-10-01T00:00:00.000Z' };
const BUILDER = { id: 'bot-builder', name: 'openadlc-atlas-janedoe', modelAccountId: 'acct-1' } as Bot;
const LIMIT_TEXT = "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage";

function row(facts: Record<string, unknown>): HealthRow {
  const failing = limitFailure(
    ACCOUNT,
    [BUILDER],
    { kind: 'spend', words: LIMIT_TEXT, resetsAt: (facts.resetsAt as string | null) ?? null, url: 'https://claude.ai/admin-settings/usage' },
    { since: SINCE, lastCheckedAt: (facts.lastCheckedAt as string) ?? SINCE },
  );
  return {
    id: 'model-limit:acct-1',
    checkId: 'model-limit',
    subject: 'acct-1',
    state: 'failing',
    severity: 'blocking',
    title: failing.title,
    detail: failing.detail,
    action: failing.action,
    facts: { ...failing.facts, ...facts },
    waitingFor: [],
    failingSince: SINCE,
    checkedAt: SINCE,
    notifiedAt: null,
    fixedAt: null,
    fixedTitle: null,
    fixedDismissedAt: null,
  };
}

function reader(rows: HealthRow[], options: { account?: Partial<ModelAccount>; verify?: { ok: boolean; message: string }; crew?: Bot[] } = {}) {
  const verify = vi.fn(async () => options.verify ?? { ok: false, message: LIMIT_TEXT });
  const subject: ModelLimitReader = {
    rows: async () => rows,
    accounts: async () => [{ ...ACCOUNT, ...options.account }],
    crew: async () => options.crew ?? [BUILDER],
    verify,
  };
  return { subject, verify };
}

const at = (iso: string) => new Date(iso);

describe('the model-limit check', () => {
  it('makes no call while the reset is ahead and the account was checked within 15 minutes', async () => {
    const { subject, verify } = reader([row({ resetsAt: '2026-11-26T11:00:00.000Z', lastCheckedAt: '2026-11-25T14:10:00.000Z' })]);
    const results = await modelLimitCheck(subject).run(at('2026-11-25T14:20:00.000Z'));
    expect(verify).not.toHaveBeenCalled();
    expect(results).toEqual([expect.objectContaining({ subject: 'acct-1', ok: false })]);
  });

  it('makes one call once the reset time has passed', async () => {
    const { subject, verify } = reader([row({ resetsAt: '2026-11-25T14:15:00.000Z', lastCheckedAt: '2026-11-25T14:10:00.000Z' })]);
    const results = await modelLimitCheck(subject).run(at('2026-11-25T14:16:00.000Z'));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ ok: false, facts: { lastCheckedAt: '2026-11-25T14:16:00.000Z', since: SINCE } });
  });

  it('with no reset time, calls every 15 minutes', async () => {
    const check = modelLimitCheck(reader([row({ resetsAt: null, lastCheckedAt: '2026-11-25T14:00:00.000Z' })]).subject);
    const early = reader([row({ resetsAt: null, lastCheckedAt: '2026-11-25T14:00:00.000Z' })]);
    await modelLimitCheck(early.subject).run(at('2026-11-25T14:14:00.000Z'));
    expect(early.verify).not.toHaveBeenCalled();
    const due = reader([row({ resetsAt: null, lastCheckedAt: '2026-11-25T14:00:00.000Z' })]);
    await modelLimitCheck(due.subject).run(at('2026-11-25T14:15:00.000Z'));
    expect(due.verify).toHaveBeenCalledTimes(1);
    expect(check.id).toBe('model-limit');
  });

  it('turns ok when the account’s check passes', async () => {
    const { subject } = reader([row({ resetsAt: null, lastCheckedAt: SINCE })], { verify: { ok: true, message: 'ok' } });
    const results = await modelLimitCheck(subject).run(at('2026-11-25T15:00:00.000Z'));
    expect(results).toEqual([expect.objectContaining({ subject: 'acct-1', ok: true, fixed: 'The Anthropic subscription “Shared Claude” works again' })]);
  });

  it('turns ok, with no call, after a person’s Verify passed since the hold began', async () => {
    const { subject, verify } = reader([row({ resetsAt: '2026-11-30T00:00:00.000Z', lastCheckedAt: '2026-11-25T14:20:00.000Z' })], {
      account: { verifiedAt: '2026-11-25T14:21:00.000Z', verifyError: null },
    });
    const results = await modelLimitCheck(subject).run(at('2026-11-25T14:22:00.000Z'));
    expect(verify).not.toHaveBeenCalled();
    expect(results[0]?.ok).toBe(true);
  });

  it('does not count a Verify from before the hold, or one that failed', async () => {
    const before = reader([row({ lastCheckedAt: '2026-11-25T14:20:00.000Z' })], { account: { verifiedAt: '2026-11-25T13:00:00.000Z', verifyError: null } });
    expect((await modelLimitCheck(before.subject).run(at('2026-11-25T14:22:00.000Z')))[0]?.ok).toBe(false);
    const failed = reader([row({ lastCheckedAt: '2026-11-25T14:20:00.000Z' })], { account: { verifiedAt: '2026-11-25T14:21:00.000Z', verifyError: 'limit' } });
    expect((await modelLimitCheck(failed.subject).run(at('2026-11-25T14:22:00.000Z')))[0]?.ok).toBe(false);
  });

  it('gives no verdict when the check fails some other way', async () => {
    const { subject } = reader([row({ lastCheckedAt: SINCE })], { verify: { ok: false, message: 'hostd did not answer' } });
    const results = await modelLimitCheck(subject).run(at('2026-11-25T15:00:00.000Z'));
    expect(results[0]?.ok).toBeNull();
  });

  it('never opens a hold, and forgets one for an account nobody uses', async () => {
    const none = reader([]);
    expect(await modelLimitCheck(none.subject).run(at('2026-11-25T15:00:00.000Z'))).toEqual([]);
    expect(none.verify).not.toHaveBeenCalled();
    const unused = reader([row({ lastCheckedAt: SINCE })], { crew: [] });
    expect(await modelLimitCheck(unused.subject).run(at('2026-11-25T15:00:00.000Z'))).toEqual([]);
  });
});

describe('the card', () => {
  it('names the limit, the bots, the reset time and the link', () => {
    const card = limitFailure(
      ACCOUNT,
      [BUILDER],
      { kind: 'spend', words: LIMIT_TEXT, resetsAt: '2026-11-27T11:00:00.000Z', url: 'https://claude.ai/admin-settings/usage' },
      { since: SINCE, lastCheckedAt: SINCE },
    );
    expect(card.title).toBe('The Anthropic subscription “Shared Claude” is at its spend limit');
    expect(card.detail).toContain('openadlc-atlas-janedoe thinks with it');
    expect(card.detail).toContain('resets 27 Nov 11:00 UTC');
    expect(card.action).toEqual({ label: 'Raise the limit', url: 'https://claude.ai/admin-settings/usage' });
    expect(card.severity).toBe('blocking');
  });

  it('points at the model accounts step when the message had no link', () => {
    const card = limitFailure(ACCOUNT, [BUILDER], { kind: 'weekly', words: 'x', resetsAt: null, url: null }, { since: SINCE, lastCheckedAt: SINCE });
    expect(card.action).toEqual({ label: 'Open the model accounts', href: '/onboarding?step=models' });
    expect(card.detail).not.toContain('resets');
  });

  it('says a reset in UTC', () => {
    expect(resetInWords('2026-11-27T11:00:00.000Z')).toBe('27 Nov 11:00 UTC');
  });

  it('finds an account’s failing row and no other', () => {
    const rows = [
      { id: 'model-limit:acct-1', state: 'failing' },
      { id: 'model-limit:acct-2', state: 'ok' },
    ];
    expect(limitRowOf(rows, 'acct-1')?.id).toBe('model-limit:acct-1');
    expect(limitRowOf(rows, 'acct-2')).toBeUndefined();
    expect(limitRowOf(rows, null)).toBeUndefined();
  });

  it('is due a check by its reset, or by 15 minutes', () => {
    expect(checkDue({ lastCheckedAt: SINCE, resetsAt: '2026-11-25T14:05:00.000Z' }, at('2026-11-25T14:06:00.000Z'))).toBe(true);
    expect(checkDue({ lastCheckedAt: '2026-11-25T14:07:00.000Z', resetsAt: '2026-11-25T14:05:00.000Z' }, at('2026-11-25T14:08:00.000Z'))).toBe(false);
  });
});
