import { botAtStart, type WordsBot } from '@fleetadlc/shared';

/** A bot as a sentence needs it. */
type SaidBot = WordsBot & { name: string };

/**
 * A bot at the start of a sentence: "The second reviewer (janedoe-reviews)",
 * or "The second reviewer" before it has an account. The words are
 * `botInWords` in `@fleetadlc/shared`, which the console's `botLabel` matches.
 */
export function botSaid(bot: SaidBot | undefined | null): string {
  return botAtStart(bot);
}
