import { roleLabel } from './onboarding.js';
import type { BotRole } from './types.js';

/**
 * What a bot is called in text a person reads: its role, and the GitHub
 * account it acts as — "the second reviewer (janedoe-reviews)" — or its role
 * alone before it has one, "the second reviewer".
 *
 * A bot's `name` is its account's login once one connects and its seat until
 * then (`second-reviewer`, `builder-2`). The seat is a slug for containers and
 * addresses, and printing `name` put it in health cards, board notes and
 * thread lines ("second-reviewer cannot sign in to GitHub"); a login alone
 * said which account but not which bot. Every sentence the bridge writes
 * about a bot goes through here, and the console's `botLabel` says the same
 * (`apps/console/src/lib/bot-label.test.ts` fails if the two disagree).
 */
export interface WordsBot {
  role: string;
  /** Its login once an account connects, its seat until then. */
  name?: string | null;
  /** The seat it fills, `builder-2`; what says it is the second of its kind. */
  slot?: string | null;
  githubLogin?: string | null;
}

/** Roles whose words are not a noun on their own: "the intake bot", not "the intake". */
const NEEDS_A_NOUN = new Set(['intake', 'automation', 'QA']);

/** The account a bot acts as, or null before it has one. */
export function botLogin(bot: WordsBot): string | null {
  if (bot.githubLogin) return bot.githubLogin;
  // A name that has left its seat is the account's login.
  if (bot.slot && bot.name && bot.name.toLowerCase() !== bot.slot.toLowerCase()) return bot.name;
  return null;
}

/** The role in words, numbered for the second of its kind: "builder 2". */
export function botRoleWords(bot: Pick<WordsBot, 'role' | 'slot'>): string {
  const words = roleLabel(bot.role as BotRole) || bot.role || 'bot';
  const number = /-(\d+)$/.exec(bot.slot ?? '')?.[1];
  return number && !/\d$/.test(words) ? `${words} ${number}` : words;
}

/**
 * A bot in the middle of a sentence: "the second reviewer (janedoe-reviews)",
 * "the intake bot", "builder 2 (janedoe-builds)". A numbered seat reads as a
 * name, so it takes no article.
 */
export function botInWords(bot: WordsBot | null | undefined): string {
  if (!bot) return 'a bot';
  const role = botRoleWords(bot);
  const numbered = /\d$/.test(role);
  const said = numbered ? role : `the ${role}${NEEDS_A_NOUN.has(role) ? ' bot' : ''}`;
  const login = botLogin(bot);
  return login ? `${said} (${login})` : said;
}

/** The same, starting a sentence: "The second reviewer (janedoe-reviews) cannot sign in". */
export function botAtStart(bot: WordsBot | null | undefined): string {
  const said = botInWords(bot);
  return said.charAt(0).toUpperCase() + said.slice(1);
}
