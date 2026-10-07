/**
 * Turns config/bots.yaml and config/repos.yaml into rows, and (with --scripted-board)
 * seeds a demo board for the integration suites: a card in each column, an
 * open gate, running tasks with session names, and non-zero ledger lines.
 */
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { botsFileSchema, costsFileSchema, envOr, hostdDriverFromEnv, loadYamlFile, reposFileSchema, resolveBotRef } from '@fleetadlc/shared';
import { closePool, waitForDatabase } from '../client.js';
import { migrate } from '../migrate.js';
import * as bots from '../store/bots.js';
import * as costs from '../store/costs.js';
import * as hosts from '../store/hosts.js';
import * as repos from '../store/repos.js';
import { writeCrew } from './seed-crew.js';
import { writeRepos } from './seed-repos.js';
import { seedScriptedBoard } from './scripted-board.js';
import { scriptedStandIn } from './scripted-repo.js';

const configRoot = envOr('FLEETADLC_CONFIG_ROOT', join(process.cwd(), 'config'));

async function seedCrew(): Promise<void> {
  const path = join(configRoot, 'bots.yaml');
  if (!existsSync(path)) {
    console.log(`[seed] no ${path}; skipping the crew`);
    return;
  }

  const { bots: crew } = loadYamlFile(path, botsFileSchema);
  const host = await hosts.ensureHost({
    // The name hostd registers itself under (apps/hostd/src/config.ts). With
    // 'local' here, the seed made a host row hostd never reported to and put
    // every bot on it, and `fleetadlc doctor` said that host had stopped.
    name: envOr('FLEETADLC_HOST_NAME', hostname()),
    driver: hostdDriverFromEnv(),
    capacityBots: crew.length,
  });

  const refused = await writeCrew(crew, host.id);
  console.log(`[seed] ${crew.length - refused.length} bots`);
  if (refused.length > 0) {
    for (const seat of refused) console.error(`[seed] the ${seat.slot} seat was not written: ${seat.reason}`);
    process.exitCode = 1;
  }
}

/**
 * The bot a repository's `owner` means. `config/repos.yaml` names a seat
 * (`builder`), because that is what stays put when an account connects; a
 * bot's current name works too, and so does a persona from a file written
 * before seats existed.
 */
async function ownerOf(reference: string): Promise<{ id: string } | null> {
  return resolveBotRef(await bots.listBots(), reference);
}

async function seedRepos(): Promise<void> {
  const path = join(configRoot, 'repos.yaml');
  if (!existsSync(path)) {
    console.log(`[seed] no ${path}; skipping repositories`);
    return;
  }

  const { repos: list } = loadYamlFile(path, reposFileSchema);
  const { unknownOwners: unknown, refused } = await writeRepos(list);
  console.log(`[seed] ${list.length - refused.length} repositories`);
  if (refused.length > 0) {
    for (const repo of refused) {
      console.error(
        `[seed] ${repo.fullName} was not written: ${repo.reason}. ` +
          'Take that entry out of config/repos.yaml, then run: fleetadlc seed',
      );
    }
    process.exitCode = 1;
  }
  if (unknown.length > 0) {
    for (const repo of unknown) {
      console.error(
        `[seed] ${repo.fullName}'s owner "${repo.owner}" is no bot in this install, so nothing builds there. ` +
          'Set owner in config/repos.yaml to a seat from config/bots.yaml (builder), then run: fleetadlc seed',
      );
    }
    process.exitCode = 1;
  }
}

async function seedBudget(): Promise<void> {
  const path = join(configRoot, 'costs.yaml');
  const config = existsSync(path) ? loadYamlFile(path, costsFileSchema) : costsFileSchema.parse({});
  await costs.ensureBudget(costs.currentPeriod(), config.monthlyCapUsd, config.warningAt);
  console.log(`[seed] budget for ${costs.currentPeriod()} at $${config.monthlyCapUsd}`);
}

/**
 * Gives the integration suite a repository when the config names none.
 *
 * Called only for `--scripted-board`. A normal seed leaves the table empty,
 * which is what makes the walkthrough ask which repository this install is for.
 */
async function ensureScriptedRepository(): Promise<void> {
  const existing = await repos.listRepos();
  const crew = await bots.listBots();
  const spec = scriptedStandIn(existing.length, crew);
  if (!spec) return;

  const owner = await ownerOf(spec.owner);
  await repos.upsertRepo({
    name: spec.name,
    fullName: spec.fullName,
    ownerBotId: owner?.id ?? null,
    concurrency: spec.concurrency,
    stageModes: spec.stageModes as Record<string, never>,
    specRequiredLabels: spec.specRequiredLabels,
    humanReviewPaths: spec.humanReviewPaths,
    defaultBranch: spec.defaultBranch,
  });
  console.log(`[seed] scripted repository ${spec.fullName}, owned by ${spec.owner}`);
}

async function main(): Promise<void> {
  await waitForDatabase();
  await migrate();
  await seedCrew();
  await seedRepos();
  await seedBudget();
  // Only the integration suites pass this; `fleetadlc up` never does, unless it
  // was started with FLEETADLC_SCRIPTED_ENGINES, which is the same suite.
  if (process.argv.includes('--scripted-board')) {
    await ensureScriptedRepository();
    await seedScriptedBoard();
  }
  await closePool();
}

main().catch(async (error) => {
  console.error('[seed] failed:', error instanceof Error ? error.message : error);
  await closePool();
  process.exit(1);
});
