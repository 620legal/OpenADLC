import { PERMISSION_NAMES } from '@fleetadlc/shared';
import { ACCOUNTS_STEP, RECONNECT, accountInWords, accountTrouble, atStart, stepHref, stepNamed } from './health/words.js';
import { NO_PULL_REQUEST, NOTHING_PUSHED } from './build-left.js';
import { NO_REVIEW, NOT_POSTED } from './review-left.js';

/**
 * Why a task stopped, as the person who has to do something about it reads it.
 *
 * A card on the board said "Engine exited 1: unexpected status 401
 * Unauthorized: Missing bearer or basic authentication in header, url:
 * https://api.openai.com/v1/responses, cf-ray: …" and offered "Open thread".
 * Every word of that was true and none of it said what to do. The causes a
 * person can fix are few and recognisable — an account signed out, a key
 * refused, a permission the app lacks, a signing key GitHub does not know, a
 * host service that is not running — so each is said as a sentence with the
 * one thing to press, and the text as it arrived stays behind "Details".
 */

export type FailureAction =
  | { kind: 'open_page'; label: string; href: string }
  | { kind: 'open_url'; label: string; url: string }
  | { kind: 'run_command'; label: string; command: string };

export interface FailureContext {
  /** Who it was, as it reads inside a sentence (`botInWords`): "the builder (janedoe-bot)"; `atStart` capitalises it where a sentence starts. */
  bot: string;
  /** The account the bot thinks with, when it has one. */
  account?: { label: string; provider: 'anthropic' | 'openai' | 'xai'; kind: 'key' | 'subscription' } | null;
  /** The app's permissions page, when OpenADLC knows the app. */
  permissionsUrl?: string | null;
}

export interface FailureWords {
  /** One or two plain sentences: what happened, and what to do. */
  sentence: string;
  /** The one thing to press for it, besides trying again. */
  action: FailureAction | null;
  /** The reason as it arrived, for "Details"; null when the sentence is all of it. */
  raw: string | null;
}

const PROVIDER = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI' } as const;

/** The provider a failure names by its address, whatever account the bot has. */
function providerIn(text: string): string | null {
  if (/api\.openai\.com|chatgpt\.com/i.test(text)) return 'OpenAI';
  if (/api\.anthropic\.com|claude\.ai/i.test(text)) return 'Anthropic';
  if (/api\.x\.ai|\bgrok\b/i.test(text)) return 'xAI';
  return null;
}

/**
 * The reason without the plumbing it came through: which route of hostd's it
 * reached the bridge by, the JSON it was wrapped in, the engine's exit code,
 * and the request ids and addresses a provider adds for its own support desk.
 */
export function withoutTransport(reason: string): string {
  let text = reason.trim().replace(/^hostd refused:\s*/i, '');
  text = text.replace(/^(?:GET|POST|PUT|PATCH|DELETE)\s+https?:\/\/\S+\s*(?:→|->)\s*\d{3}:?\s*/i, '');
  const json = /^\{[\s\S]*\}$/.exec(text.trim());
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as Record<string, unknown>;
      const said = [parsed.error, parsed.message, parsed.detail].find((value) => typeof value === 'string');
      if (typeof said === 'string') text = said;
    } catch {
      // Not JSON after all; what is there is what there is.
    }
  }
  text = text.replace(/^engine exited(?: with)?(?: code)? \d+:\s*/i, '');
  text = text.replace(/unexpected status (\d{3})(?: [A-Za-z][A-Za-z ]*?)?:\s*/i, '$1: ');
  text = text.replace(/,?\s*url:\s*https?:\/\/\S+/gi, '');
  text = text.replace(/,?\s*cf-ray:\s*\S+/gi, '');
  text = text.replace(/,?\s*(?:x-)?request[-_ ]?id:\s*\S+/gi, '');
  return text.replace(/\s{2,}/g, ' ').replace(/[\s,]+$/, '').trim();
}

/**
 * The sentence for a task that gave no reason at all. The board reads it to
 * keep unexplained failures apart, so it is said in one place.
 */
export const NO_REASON = 'It stopped without saying why.';

/** The first sentence of it, capitalised and bounded, as a card has room for. */
function firstSentence(text: string): string {
  if (!text) return NO_REASON;
  const sentence = /^([\s\S]+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  const capped = sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence;
  const ended = /[.!?…]$/.test(capped) ? capped : `${capped}.`;
  return ended.charAt(0).toUpperCase() + ended.slice(1);
}

/** The permission GitHub named as the one it wanted, as the app's page names it. */
function permissionNamed(text: string): string | null {
  const accepted = /x-accepted-github-permissions:?\s*([a-z_]+)=/i.exec(text);
  const name = accepted?.[1];
  if (!name) return null;
  return PERMISSION_NAMES[name]?.label ?? name;
}

export function explainFailure(reason: string | null | undefined, context: FailureContext): FailureWords {
  const raw = (reason ?? '').trim();
  if (!raw) return { sentence: NO_REASON, action: null, raw: null };
  const plain = withoutTransport(raw);
  const bot = context.bot;
  const account = context.account ?? null;
  const detailOf = (sentence: string): string | null => (sentence === raw ? null : raw);

  // A review task that ended with no review on the pull request. What the bot
  // said is why, and comes first: its own words can name a 401 or a sign-in
  // that is not the account's at all.
  if (raw.startsWith(NOT_POSTED)) {
    const sentence = `${atStart(bot)} wrote its review but never posted it on the pull request, so the review does not count. Try again.`;
    return { sentence, action: null, raw: detailOf(sentence) };
  }
  if (raw.startsWith(NO_REVIEW)) {
    const said = /It said: “([\s\S]*)”$/.exec(raw)?.[1]?.trim();
    const sentence = said
      ? `${atStart(bot)} ended without posting its review. It said: “${firstSentence(said)}”`
      : `${atStart(bot)} ended without posting its review, and did not say why. Open its thread, then try again.`;
    return { sentence, action: null, raw: detailOf(sentence) };
  }

  // A build that ended with no pull request (`build-left.ts`): its branch
  // holds the work, or nothing was pushed at all.
  if (raw.startsWith(NO_PULL_REQUEST)) {
    const branch = /its commits are on (\S+?),/.exec(raw)?.[1];
    const sentence = `${atStart(bot)} pushed its work${branch ? ` to ${branch}` : ''} and ended twice without opening the pull request. Open it from the branch, or try again.`;
    return { sentence, action: null, raw: detailOf(sentence) };
  }
  if (raw.startsWith(NOTHING_PUSHED)) {
    const sentence = `${atStart(bot)} finished without pushing a commit or opening a pull request. Open its thread to see why, then try again.`;
    return { sentence, action: null, raw: detailOf(sentence) };
  }

  // Stopped by OpenADLC itself, not by anything wrong with the work: nothing
  // starts it again, so trying again is the whole of it.
  if (/hostd shutting down/i.test(raw)) {
    const sentence = `OpenADLC stopped while ${bot} was working, and nothing started the work again. Try again to pick it up.`;
    return { sentence, action: null, raw: detailOf(sentence) };
  }
  if (/container restarted/i.test(raw)) {
    const sentence = `The computer ${bot} was working on restarted. Try again to start the work over.`;
    return { sentence, action: null, raw: detailOf(sentence) };
  }
  if (/host stopped reporting|hostd (?:is not answering|did not answer)|ECONNREFUSED 127\.0\.0\.1:47312|connect ECONNREFUSED/i.test(raw)) {
    return {
      sentence: 'OpenADLC’s host service did not answer, so the work could not run. Start OpenADLC with `fleetadlc up` if it has stopped, then try again.',
      action: { kind: 'run_command', label: 'Run fleetadlc up', command: 'fleetadlc up' },
      raw,
    };
  }

  // GitHub, not a model provider.
  if (/Resource not accessible by integration|x-accepted-github-permissions/i.test(raw)) {
    const named = permissionNamed(raw);
    return {
      sentence:
        `GitHub refused ${bot}: the OpenADLC app lacks ${named ? `“${named}”` : 'a permission this needs'}. ` +
        'Add it on the app’s permissions page, then try again.',
      action: context.permissionsUrl
        ? { kind: 'open_url', label: 'Open the app’s permissions', url: context.permissionsUrl }
        : { kind: 'open_page', label: `Open ${stepNamed('app')}`, href: stepHref('app') },
      raw,
    };
  }
  // GH006 alone is any protected-branch refusal; only a signature is this one.
  if (/verified signatures|unverified|gpg failed to sign|failed to sign|signing failed|could not sign|required_signatures|signature(?:s)? (?:is |are )?required/i.test(raw)) {
    return {
      sentence: `GitHub refused a commit by ${bot}: it was not signed with a key its account has. Reconnect ${bot} so GitHub learns its signing key, then try again.`,
      action: { kind: 'open_page', label: `Reconnect ${bot}`, href: RECONNECT },
      raw,
    };
  }
  if (/bad credentials|authorization is no longer valid|is not connected to GitHub|github\.com.*\b401\b/i.test(raw)) {
    return {
      sentence: `GitHub no longer accepts the sign-in of ${bot}. Reconnect it, then try again.`,
      action: { kind: 'open_page', label: `Reconnect ${bot}`, href: RECONNECT },
      raw,
    };
  }

  // The model account the bot thinks with.
  const trouble = accountTrouble(raw);
  const provider = providerIn(raw) ?? (account ? PROVIDER[account.provider] : null);
  // A key is never signed in: a provider's "not authenticated" said of one is
  // the key refused, and "sign it in again" was a step a key account lacks.
  if (trouble === 'signed-out' && account?.kind === 'key') {
    return {
      sentence: `${provider ?? 'The model provider'} did not accept the key of ${accountInWords(account)} ${bot} thinks with. Check the key on ${stepNamed('models')}, then try again.`,
      action: { kind: 'open_page', label: 'Check the key', href: ACCOUNTS_STEP },
      raw,
    };
  }
  if (trouble === 'signed-out') {
    return {
      sentence: account
        ? `${atStart(accountInWords(account))} ${bot} thinks with is signed out. Sign it in again on ${stepNamed('models')}, then try again.`
        : `The model account of ${bot} is signed out. Sign it in again on ${stepNamed('models')}, then try again.`,
      action: { kind: 'open_page', label: 'Sign in again', href: ACCOUNTS_STEP },
      raw,
    };
  }
  if (trouble === 'no-secret') {
    return {
      sentence: account
        ? `No ${account.kind === 'subscription' ? 'sign-in' : 'key'} is stored for ${accountInWords(account)} ${bot} thinks with. Add it on ${stepNamed('models')}, then try again.`
        : `No key is stored for the model account of ${bot}. Add it on ${stepNamed('models')}, then try again.`,
      action: { kind: 'open_page', label: 'Add the key', href: ACCOUNTS_STEP },
      raw,
    };
  }
  if (trouble === 'refused') {
    const noKey = /missing bearer|no api key|api key (?:is )?missing/i.test(raw);
    const who = provider ?? 'The model provider';
    const subscription = account?.kind === 'subscription';
    return {
      sentence:
        `${who} refused a request from ${bot}${noKey ? ': no key came with it' : ''} (401). ` +
        (subscription
          ? `Sign ${account ? accountInWords(account) : 'its account'} in again on ${stepNamed('models')}, then try again.`
          : `Check the key of ${account ? accountInWords(account) : 'its model account'} on ${stepNamed('models')}, then try again.`),
      action: subscription
        ? { kind: 'open_page', label: 'Sign in again', href: ACCOUNTS_STEP }
        : { kind: 'open_page', label: 'Check the key', href: ACCOUNTS_STEP },
      raw,
    };
  }

  const sentence = firstSentence(plain);
  return { sentence, action: null, raw: sentence === raw ? null : raw };
}
