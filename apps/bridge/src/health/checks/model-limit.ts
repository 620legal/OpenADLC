import type { HealthRow } from '@openadlc/db';
import type { Bot, HealthAction, ModelAccount } from '@openadlc/shared';
import { usageLimit, type UsageLimit } from '../../usage-limit.js';
import type { CheckResult, HealthCheck } from '../types.js';
import { ACCOUNTS_STEP, accountInWords, accountTrouble, atStart } from '../words.js';

/**
 * A model account at its usage or spend limit: the row `model-limit:<accountId>`
 * is the hold, and the only record of it
 * (docs/adr/0096-a-model-accounts-usage-limit-is-a-health-row-and-its-tasks-end-held.md).
 *
 * The row is opened only by a task ending on the limit (`HealthRegistry.raise`
 * from the task state route), never by this check: no cheap call shows a
 * limit coming. Listing models, which `model-account` does, goes on passing
 * through one. What this check does is clear it, and only on a passing check
 * of the account — the one-line prompt a session's credential is given
 * (`verifyModelAccount`), or a person's Verify that passed after the hold
 * began. A reset time only says when to check: the incident's message named
 * a weekly limit that resets beside a monthly spend limit that does not, and
 * a clock alone would have started every held task into the same wall.
 */

export const MODEL_LIMIT_CHECK = 'model-limit';

/** How often a hold with no reset time, or one past it, is checked again: an admin may raise the limit at any time. */
export const RECHECK_MS = 15 * 60_000;

export interface ModelLimitReader {
  /** The check's own rows as they stand. */
  rows(): Promise<HealthRow[]>;
  accounts(): Promise<ModelAccount[]>;
  crew(): Promise<Bot[]>;
  /** Runs the account's CLI with a one-line prompt, as `verifyModelAccount` does, and records the result on its row. */
  verify(account: ModelAccount): Promise<{ ok: boolean; message: string }>;
}

/** The facts a `model-limit` row keeps, which the card, the dispatcher and the recovery read. */
export interface LimitFacts {
  accountId: string;
  /** The account as a sentence names it, for the dispatcher's and the start's words, which have no account to read. */
  accountName: string;
  botIds: string[];
  kind: UsageLimit['kind'];
  words: string;
  resetsAt: string | null;
  url: string | null;
  /** When the hold began: the first task that ended on it. A raise on a held account keeps it. */
  since: string;
  lastCheckedAt: string;
}

const KIND_WORDS: Record<UsageLimit['kind'], string> = {
  spend: 'spend limit',
  weekly: 'weekly limit',
  session: 'usage limit',
  credit: 'credit limit',
  quota: 'quota',
};

/** "spend limit", "quota": what a card and a task's words call a kind of limit. */
export function limitInWords(kind: unknown): string {
  return KIND_WORDS[kind as UsageLimit['kind']] ?? 'usage limit';
}

/** "27 Nov 11:00 UTC": a reset time as a card says it, in UTC so every reader sees the same. */
export function resetInWords(at: string | Date): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  const month = date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const time = date.toISOString().slice(11, 16);
  return `${date.getUTCDate()} ${month} ${time} UTC`;
}

function names(bots: readonly Pick<Bot, 'name'>[]): string {
  const all = bots.map((bot) => bot.name);
  if (all.length <= 1) return all[0] ?? 'No bot';
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}

/** The card for an account at its limit, as the state route raises it and this check keeps it. */
export function limitFailure(
  account: Pick<ModelAccount, 'id' | 'label' | 'provider' | 'kind'>,
  users: readonly Pick<Bot, 'id' | 'name'>[],
  limit: { kind: UsageLimit['kind']; words: string; resetsAt: string | null; url: string | null },
  at: { since: string; lastCheckedAt: string },
): Extract<CheckResult, { ok: false }> {
  const think = users.length === 1 ? 'thinks' : 'think';
  const resets = limit.resetsAt ? ` It says it resets ${resetInWords(limit.resetsAt)}.` : '';
  const action: HealthAction = limit.url ? { label: 'Raise the limit', url: limit.url } : { label: 'Open the model accounts', href: ACCOUNTS_STEP };
  const facts: LimitFacts = {
    accountId: account.id,
    accountName: accountInWords(account),
    botIds: users.map((bot) => bot.id),
    kind: limit.kind,
    words: limit.words,
    resetsAt: limit.resetsAt,
    url: limit.url,
    since: at.since,
    lastCheckedAt: at.lastCheckedAt,
  };
  return {
    subject: account.id,
    ok: false,
    severity: 'blocking',
    title: `${atStart(accountInWords(account))} is at its ${limitInWords(limit.kind)}`,
    detail:
      `${names(users)} ${think} with it, and nothing more is started on it until it works again.${resets} ` +
      'The held work starts again by itself once a check of the account passes; press Verify on the model accounts step after raising the limit to check now.',
    action,
    facts: facts as unknown as Record<string, unknown>,
  };
}

/** The failing `model-limit` row of an account, from any list of health rows. */
export function limitRowOf<T extends { id: string; state: string }>(rows: readonly T[], accountId: string | null | undefined): T | undefined {
  if (!accountId) return undefined;
  return rows.find((row) => row.id === `${MODEL_LIMIT_CHECK}:${accountId}` && row.state === 'failing');
}

export function modelLimitCheck(reader: ModelLimitReader): HealthCheck {
  return {
    id: MODEL_LIMIT_CHECK,
    proves: 'No model account a bot thinks with is at its usage or spend limit',
    how: 'runs the account’s CLI with a one-line prompt once its limit says it resets, or every 15 minutes while it is held',
    everyMinutes: 5,
    steps: ['models'],
    // Each verify runs a CLI on hostd; several held accounts take a while.
    timeoutMs: 3 * 60_000,
    async run(now) {
      const failing = (await reader.rows()).filter((row) => row.checkId === MODEL_LIMIT_CHECK && row.state === 'failing');
      if (failing.length === 0) return [];
      const [accounts, crew] = await Promise.all([reader.accounts(), reader.crew()]);
      const results: CheckResult[] = [];
      for (const row of failing) {
        const accountId = row.subject ?? '';
        const account = accounts.find((one) => one.id === accountId);
        const users = crew.filter((bot) => bot.modelAccountId === accountId);
        // Gone, or nobody thinks with it: it holds nothing up, and the row is forgotten.
        if (!account || users.length === 0) continue;
        const facts = row.facts as Partial<LimitFacts>;
        const since = typeof facts.since === 'string' ? facts.since : (row.failingSince ?? now.toISOString());
        const works = { subject: accountId, ok: true as const, fixed: `${atStart(accountInWords(account))} works again`, facts: { accountId } };

        // A person's Verify that passed after the hold began.
        if (account.verifiedAt && !account.verifyError && Date.parse(account.verifiedAt) > Date.parse(since)) {
          results.push(works);
          continue;
        }

        const standing: CheckResult = {
          subject: accountId,
          ok: false,
          severity: row.severity ?? 'blocking',
          title: row.title ?? '',
          detail: row.detail ?? '',
          action: row.action ?? { label: 'Open the model accounts', href: ACCOUNTS_STEP },
          facts: { ...row.facts, botIds: users.map((bot) => bot.id) },
        };
        if (!checkDue(facts, now)) {
          results.push(standing);
          continue;
        }

        const answer = await reader.verify(account).catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
        if (answer.ok) {
          results.push(works);
          continue;
        }
        const limit = usageLimit(answer.message, account.provider, now);
        if (limit) {
          results.push(
            limitFailure(
              account,
              users,
              { kind: limit.kind, words: limit.words, resetsAt: limit.resetsAt?.toISOString() ?? null, url: limit.url ?? (facts.url ?? null) },
              { since, lastCheckedAt: now.toISOString() },
            ),
          );
          continue;
        }
        // Signed out, or hostd not answering: `model-account` speaks for
        // those. The hold stands, checked again on the next run once due.
        const trouble = accountTrouble(answer.message);
        results.push({
          subject: accountId,
          ok: null,
          reason: `its check did not say whether the limit lifted (${trouble}): ${answer.message.slice(0, 200)}`,
          facts: { ...row.facts, lastCheckedAt: now.toISOString() },
        });
      }
      return results;
    },
  };
}

/**
 * Whether the account is due a check: its reset time has passed since it was
 * last checked, or it has not been checked for `RECHECK_MS`. The second rule
 * is what clears a limit with no reset time, and one an admin raised early.
 */
export function checkDue(facts: Partial<LimitFacts>, now: Date): boolean {
  const last = typeof facts.lastCheckedAt === 'string' ? Date.parse(facts.lastCheckedAt) : Number.NEGATIVE_INFINITY;
  const resets = typeof facts.resetsAt === 'string' ? Date.parse(facts.resetsAt) : Number.NaN;
  if (Number.isFinite(resets) && resets <= now.getTime() && last < resets) return true;
  return now.getTime() - last >= RECHECK_MS;
}
