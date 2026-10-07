import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, waitForDatabase } from '@fleetadlc/db';
import { costsFileSchema, envInt, envOr, loadYamlFile } from '@fleetadlc/shared';
import { Dispatcher } from './dispatcher.js';
import { fleetHome, getSecretStore, internalSecretRef } from '@fleetadlc/github';

function loadCosts() {
  const path = join(envOr('FLEETADLC_CONFIG_ROOT', join(process.cwd(), 'config')), 'costs.yaml');
  return existsSync(path) ? loadYamlFile(path, costsFileSchema) : costsFileSchema.parse({});
}

/**
 * The options this program reads. The `dev` script passed `--watch-interval
 * 60`, which nothing read, so it ran every 300s and leased for real; a flag
 * that is not one of these is refused rather than ignored.
 */
const OPTIONS = ['--once', '--dry-run'];

async function main(): Promise<void> {
  const unknown = process.argv.slice(2).filter((arg) => !OPTIONS.includes(arg));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(' ')} is not an option: it takes ${OPTIONS.join(' and ')}, ` +
        'and FLEETADLC_DISPATCH_INTERVAL_SECONDS for how often it runs',
    );
  }
  const intervalSeconds = envInt('FLEETADLC_DISPATCH_INTERVAL_SECONDS', 300);
  const once = process.argv.includes('--once');
  const dryRun = process.argv.includes('--dry-run');

  // Read, not generated: the bridge owns this secret. `fleetadlc up` establishes
  // it before starting anything. Without it every call to the bridge was
  // refused, and each refused lease counted as an attempt on its issue.
  const internalSecret = await getSecretStore().get(internalSecretRef());
  if (!internalSecret) {
    throw new Error(
      `no internal secret in the secret store for this FLEETADLC_HOME (${fleetHome()}); ` +
        'run it against the install whose bridge it calls',
    );
  }

  await waitForDatabase();

  const dispatcher = new Dispatcher({
    bridgeUrl: envOr('FLEETADLC_BRIDGE_URL', 'http://127.0.0.1:47311'),
    internalSecret,
    costs: loadCosts(),
    leaseHours: envInt('FLEETADLC_LEASE_HOURS', 12),
    dryRun,
  });

  const tick = async (): Promise<void> => {
    try {
      const decisions = await dispatcher.runOnce();
      if (decisions.length === 0) {
        console.log('[dispatcher] nothing routable');
        return;
      }
      for (const decision of decisions) {
        console.log(
          `[dispatcher] ${decision.action} ${decision.repo}#${decision.issue} → ${decision.bot}: ${decision.reason}`,
        );
      }
    } catch (error) {
      console.error('[dispatcher] run failed:', error instanceof Error ? error.message : error);
    }
  };

  await tick();

  if (once) {
    await closePool();
    return;
  }

  console.log(`[dispatcher] leasing every ${intervalSeconds}s`);
  // One pass at a time. A pass can outlast the interval while its leases wait
  // on hostd, and a second one beside it leased what the first had not
  // recorded yet.
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      console.log('[dispatcher] the last pass is still running; skipping this one');
      return;
    }
    running = true;
    void tick().finally(() => {
      running = false;
    });
  }, intervalSeconds * 1000);

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// A promise nobody awaited that rejects would end the service, and with it
// what only its memory holds. It is logged with its stack and the service
// carries on; an uncaught exception still ends it.
process.on('unhandledRejection', (reason) => {
  console.error('[dispatcher] a promise rejected with nothing to catch it:', reason instanceof Error ? reason.stack : reason);
});

main().catch(async (error) => {
  console.error('[dispatcher] failed:', error instanceof Error ? error.message : error);
  await closePool();
  process.exit(1);
});
