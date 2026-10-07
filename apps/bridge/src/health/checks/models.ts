import type { Bot, ModelAccount, SubscriptionLogin } from '@fleetadlc/shared';
import type { CheckResult, HealthCheck } from '../types.js';
import { ACCOUNTS_STEP, accountInWords, accountTrouble, atStart, quotedName, stepNamed } from '../words.js';

export interface ModelReader {
  accounts(): Promise<ModelAccount[]>;
  crew(): Promise<Bot[]>;
  /**
   * Asks the provider what the account can call, with the account's own key
   * or sign-in. Throws the provider's words when it refuses.
   */
  models(account: ModelAccount): Promise<unknown>;
  /** Where an OpenAI subscription's sign-in stands: it has nothing that lists models to ask with. */
  login(account: ModelAccount): Promise<SubscriptionLogin>;
}

const PROVIDER: Record<ModelAccount['provider'], string> = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI' };

function names(bots: readonly Bot[]): string {
  const all = bots.map((bot) => bot.name);
  if (all.length <= 1) return all[0] ?? 'No bot';
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}

/** What to say about an account a bot thinks with, for a trouble that needs a person. */
export function accountFailure(
  account: Pick<ModelAccount, 'id' | 'label' | 'provider' | 'kind'>,
  trouble: 'signed-out' | 'refused' | 'no-secret',
  users: readonly Bot[],
): Extract<CheckResult, { ok: false }> {
  const provider = PROVIDER[account.provider];
  const who = names(users);
  const think = users.length === 1 ? 'thinks' : 'think';
  const facts = { accountId: account.id, botIds: users.map((bot) => bot.id) };
  // A key is never signed in. A provider's "not authenticated" said of one
  // read as a signed-out subscription, with a sign-in that a key cannot do;
  // it is the key refused.
  if (trouble === 'signed-out' && account.kind === 'key') trouble = 'refused';
  if (trouble === 'signed-out') {
    return {
      subject: account.id,
      ok: false,
      severity: 'blocking',
      title: `${atStart(accountInWords(account))} is signed out`,
      detail: `${who} ${think} with this ${provider} subscription, and cannot work until it is signed in again. Sign it in again on ${stepNamed('models')}.`,
      action: { label: 'Sign in again', href: ACCOUNTS_STEP },
      facts,
    };
  }
  if (trouble === 'no-secret') {
    const what = account.kind === 'subscription' ? 'token' : 'key';
    return {
      subject: account.id,
      ok: false,
      severity: 'blocking',
      title: `No ${what} is stored for ${accountInWords(account)}`,
      detail: `${who} ${think} with it, and cannot work until it has one. Add it on ${stepNamed('models')}.`,
      action: { label: `Add the ${what}`, href: ACCOUNTS_STEP },
      facts,
    };
  }
  return {
    subject: account.id,
    ok: false,
    severity: 'blocking',
    title: `${provider} refuses ${account.kind === 'subscription' ? 'the sign-in' : 'the key'}${quotedName(account)}`,
    detail:
      `${who} ${think} with it, and cannot work until ${provider} accepts it. ` +
      (account.kind === 'subscription' ? `Sign it in again on ${stepNamed('models')}.` : `Replace the key on ${stepNamed('models')}.`),
    action: account.kind === 'subscription' ? { label: 'Sign in again', href: ACCOUNTS_STEP } : { label: 'Replace the key', href: ACCOUNTS_STEP },
    facts,
  };
}

/**
 * Each model account a bot thinks with, asked with its own credential: a key
 * by listing what it can call, an xAI subscription by its own CLI listing the
 * same with its sign-in — which is what said "You are not authenticated" when
 * one was signed out. An OpenAI subscription lists nothing, so its sign-in and
 * its last check are what there is.
 *
 * An account no bot uses is not asked: it holds nothing up.
 */
export function modelAccountCheck(reader: ModelReader): HealthCheck {
  return {
    id: 'model-account',
    proves: 'Each model account a bot thinks with answers',
    how: 'asks the provider what the account can call, with the account’s own key or sign-in',
    everyMinutes: 30,
    steps: ['models'],
    async run() {
      const [accounts, crew] = await Promise.all([reader.accounts(), reader.crew()]);
      const results: CheckResult[] = [];
      for (const account of accounts) {
        const users = crew.filter((bot) => bot.modelAccountId === account.id);
        if (users.length === 0) continue;
        const facts = { accountId: account.id, botIds: users.map((bot) => bot.id) };

        if (account.kind === 'subscription' && account.provider === 'openai') {
          // A thrown error is hostd not answering, or refusing the bridge — a
          // 503, a 404, its secret — which says nothing about the sign-in. Read
          // as a failed sign-in, it sent a person through one that fixed nothing.
          const login = await reader.login(account).catch((error: unknown) => ({ state: 'unknown' as const, message: messageOf(error) }));
          if (login.state === 'unknown') {
            results.push({ subject: account.id, ok: null, reason: `hostd could not be asked: ${login.message}`, facts });
          } else if (login.state === 'signed-in') {
            results.push(
              account.verifyError
                ? { subject: account.id, ok: null, reason: `its last check said: ${account.verifyError}`, facts }
                : { subject: account.id, ok: true, fixed: `${atStart(accountInWords(account))} is signed in again`, facts },
            );
          } else if (login.state === 'signed-out') {
            results.push(accountFailure(account, 'signed-out', users));
          } else if (login.state === 'failed' && accountTrouble(login.message) !== 'unreachable') {
            results.push(accountFailure(account, 'signed-out', users));
          } else {
            results.push({ subject: account.id, ok: null, reason: login.state === 'waiting' ? 'a sign-in is under way' : 'hostd could not be asked', facts });
          }
          continue;
        }

        try {
          await reader.models(account);
          results.push({ subject: account.id, ok: true, fixed: `${atStart(accountInWords(account))} answers again`, facts });
        } catch (error) {
          const message = messageOf(error);
          // hostd relays what the CLI said with a gateway's status (502); any
          // other status is hostd's own refusal of the bridge, and its 401
          // read as "xAI refuses the sign-in".
          if (account.kind === 'subscription' && account.provider === 'xai' && hostdRefused(error)) {
            results.push({ subject: account.id, ok: null, reason: `hostd could not be asked: ${message}`, facts });
            continue;
          }
          const trouble = accountTrouble(message);
          if (trouble === 'signed-out' || trouble === 'refused' || trouble === 'no-secret') {
            results.push(accountFailure(account, trouble, users));
          } else {
            results.push({ subject: account.id, ok: null, reason: `${PROVIDER[account.provider]} could not be asked: ${message}`, facts });
          }
        }
      }
      return results;
    },
  };
}

/** Whether hostd answered with a refusal of its own, rather than relaying the CLI's or not answering. */
function hostdRefused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status !== 502 && status !== 504;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
