import type { BotConfig } from '@fleetadlc/shared';
import * as bots from '../store/bots.js';

/**
 * Writes config/bots.yaml into the bots table, which is what `fleetadlc up` does
 * on every start.
 *
 * Each entry is a seat, and the row is found by it. It used to be found by
 * the bot's name, which was fine while a name never changed; now a bot takes
 * its account's handle when one connects, and a seed keyed by the name would
 * find nothing under `builder` and add a second builder beside
 * `fleetadlc-atlas-janedoe`.
 *
 * Its own module so a test can run the loop the seed runs, rather than only
 * the rule it calls: the rule was right once and the seed still wrote the
 * wrong value.
 *
 * Returns the seats it could not write, with the reason, rather than stopping
 * at the first: one seat whose name another bot already has (an account whose
 * handle is `qa`, connected to another seat) must not keep the other eight
 * from being seeded.
 */
export async function writeCrew(
  crew: BotConfig[],
  hostId: string | null,
): Promise<{ slot: string; reason: string }[]> {
  const refused: { slot: string; reason: string }[] = [];
  for (const bot of crew) {
    const existing = await bots.getBotBySlot(bot.slot);
    // An assignment made in the console is kept, engine and all: a builder
    // moved onto an xAI account runs grok after a restart too, though the file
    // still says claude. Which account a bot is, the file never says.
    const kept = bots.keptOnReseed(existing, { engine: bot.engine, model: bot.model });
    try {
      await bots.seedBot({
        slot: bot.slot,
        displayName: bot.displayName,
        role: bot.role,
        engine: kept.engine,
        model: kept.model,
        hostId,
        skills: bot.skills,
        sidecarDb: bot.sidecarDb,
        // What each of its task computers is given, and how many it runs at
        // once when the file says; see `seedBot`.
        cpus: bot.cpus,
        memoryGb: bot.memoryGb,
        maxTasks: bot.maxTasks ?? null,
      });
    } catch (error) {
      refused.push({ slot: bot.slot, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return refused;
}
