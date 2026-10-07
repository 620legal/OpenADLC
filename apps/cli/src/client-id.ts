import { settings } from '@fleetadlc/db';
import type { InstallConfig } from './install.js';

/**
 * The GitHub App's client id, chosen as the bridge chooses it: the one the
 * console stored in the settings table, then `FLEETADLC_GITHUB_CLIENT_ID`, then
 * install.json (apps/bridge/src/effective-config.ts).
 *
 * The console's walkthrough creates the app and stores its client id in the
 * settings table. The CLI once read only install.json, so on an install set up
 * from the console `fleetadlc doctor` reported no client id while every bot was
 * signing in through that very app. It then put install.json first, so an
 * install whose file still named an old app had `fleetadlc auth login` sign bots
 * in through that app while the bridge refreshed their tokens with the new
 * one: GitHub refused, and the seat was marked revoked.
 */
export async function githubClientId(
  config: Pick<InstallConfig, 'githubClientId'>,
  stored: () => Promise<string | null> = () => settings.getSetting('githubClientId'),
  environment: string | undefined = process.env.FLEETADLC_GITHUB_CLIENT_ID,
): Promise<string | null> {
  const saved = (await stored().catch(() => null))?.trim();
  if (saved) return saved;
  const exported = environment?.trim();
  if (exported) return exported;
  return config.githubClientId?.trim() || null;
}
