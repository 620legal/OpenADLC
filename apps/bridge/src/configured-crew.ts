import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { botsFileSchema, loadYamlFile, type BotConfig, type BotRole } from '@fleetadlc/shared';

/**
 * `config/bots.yaml` as the bridge reads it: the one reader, so the console's
 * proposals, the assignment route and adding or removing a seat all see the
 * same file the same way. There were two, and a change to how one tolerated a
 * bad file would not have reached the other.
 *
 * Read per request, because the file is the operator's to edit, and an
 * unreadable file is no seats rather than an error on the page: a malformed
 * file is `fleetadlc up`'s to report.
 */
export function configuredSeats(configRoot: string | undefined): BotConfig[] {
  if (!configRoot) return [];
  const path = join(configRoot, 'bots.yaml');
  if (!existsSync(path)) return [];
  try {
    return loadYamlFile(path, botsFileSchema).bots;
  } catch {
    return [];
  }
}

/**
 * The first seat the file gives a role: the one without a number, else the
 * first. What a seat added beside it from settings starts from, and what that
 * seat falls back to, since the file does not name it.
 */
export function configuredFirstOfRole(configRoot: string | undefined, role: BotRole): BotConfig | null {
  const ofRole = configuredSeats(configRoot).filter((seat) => seat.role === role);
  return ofRole.find((seat) => !/-\d+$/.test(seat.slot)) ?? ofRole[0] ?? null;
}

/**
 * What the file gives a bot: its own seat's entry, or, for a seat the file
 * does not name — `builder-2`, added from settings — its role's first seat's.
 */
export function configuredFor(configRoot: string | undefined, bot: { slot: string; role: BotRole }): BotConfig | null {
  return configuredSeats(configRoot).find((seat) => seat.slot === bot.slot) ?? configuredFirstOfRole(configRoot, bot.role);
}
