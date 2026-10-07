import { stepNamed, type OnboardingStep } from '@fleetadlc/shared';

/**
 * Where in the console a person does what a check or a failed task asks, and
 * what a provider's refusal means — said once, for the checks and for the
 * words a failed task's card uses, so the two never send somebody to
 * different places for the same thing.
 */

/** Where a bot's GitHub account is connected again: Settings → GitHub → Connected accounts. */
export const RECONNECT = '/settings#github-accounts';

/** Where a walkthrough step is done: its page in the console. */
export function stepHref(step: OnboardingStep): string {
  return `/onboarding?step=${step}`;
}

/** Where a model account is signed in again, or given a key: the walkthrough's model accounts step. */
export const ACCOUNTS_STEP = stepHref('models');

/** A step as a card or a failed task names it; one helper for every package (`@fleetadlc/shared`). */
export { stepNamed };

/** Where the crew is let into a repository: the walkthrough's access step. */
export const ACCESS_STEP = stepHref('access');

export type AccountTrouble = 'signed-out' | 'refused' | 'no-secret' | 'unreachable' | 'other';

const PROVIDER_NAME = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI' } as const;

/** What a sentence needs to name a model account. */
export interface NamedAccount {
  label: string;
  provider: keyof typeof PROVIDER_NAME;
  kind: 'key' | 'subscription';
}

/**
 * A model account as a sentence names it: "the xAI subscription", "the OpenAI
 * API account" — and the name a person gave it, in quotes, when that name says
 * more.
 *
 * The walkthrough names a new account after its provider and kind, "xAI —
 * subscription", until somebody renames it. Put into a sentence as it was, a
 * card read "xAI — subscription, the xAI subscription irisexampleco thinks with,
 * is signed out", and a check "OpenAI refuses the key on OpenAI — API key".
 */
export function accountInWords(account: NamedAccount): string {
  return `the ${PROVIDER_NAME[account.provider]} ${account.kind === 'subscription' ? 'subscription' : 'API account'}${quotedName(account)}`;
}

/** The name a person gave the account, as " “Team key”", or nothing when it only repeats its provider and kind. */
export function quotedName(account: NamedAccount): string {
  const label = account.label.trim();
  const rest = label
    .toLowerCase()
    .replace(PROVIDER_NAME[account.provider].toLowerCase(), ' ')
    .replace(/\b(?:subscription|api|key|account)\b/g, ' ')
    .replace(/[\s\p{P}]+/gu, '');
  return rest ? ` “${label}”` : '';
}

/** The sentence's first letter capitalised: an account named at the start of one. */
export function atStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a provider's or a CLI's refusal means for the person who has to fix it:
 * signed out, a key refused, nothing stored — or nothing a person can do,
 * because it was never asked.
 */
export function accountTrouble(message: string): AccountTrouble {
  if (/hostd (is not answering|did not answer)|ECONNREFUSED|fetch failed|socket hang up|timed? ?out/i.test(message)) return 'unreachable';
  if (
    /not (authenticated|signed in|logged in)|signed out|sign (this subscription |it )?in again|log ?in again|re-?authenticate|login (has )?expired|session expired/i.test(
      message,
    )
  ) {
    return 'signed-out';
  }
  if (/no (key|token) (is )?stored|has no (key|token) stored/i.test(message)) return 'no-secret';
  if (
    /\b401\b|unauthori[sz]ed|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|authentication[_ ]error|missing bearer|invalid bearer|api key .* (invalid|revoked)/i.test(
      message,
    )
  ) {
    return 'refused';
  }
  return 'other';
}
