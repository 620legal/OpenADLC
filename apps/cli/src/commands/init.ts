import { closePool, settings } from '@fleetadlc/db';
import { getSecretStore, webhookSecretRef } from '@fleetadlc/github';
import {
  LOCAL_DRIVER_NOTES,
  LOCAL_DRIVER_WARNING,
  chooseDriver,
  configPath,
  defaultConfig,
  dockerProbe,
  loadConfig,
  saveConfig,
  settleWebhookSecret,
  storedDriver,
  type DriverProbe,
} from '../install.js';
import { ui } from '../ui.js';

/**
 * Where setup happens, which is no longer here.
 *
 * This used to ask seven questions at a prompt and write `install.json`. Setting
 * up an install therefore needed a terminal, and the onboarding page — the thing
 * built to walk somebody through setup — could report that the GitHub App client
 * id was missing while offering no way to supply it.
 *
 * The console owns that now. Two things cannot move there and are flags here
 * instead: the database url, because the bridge has to reach the database before
 * it can read any setting out of it, and the driver, because hostd reads it when
 * it starts. Neither is asked for. With no driver named, init picks docker when
 * Docker answers and the bot image is built, local otherwise, and writes it down.
 */
export async function init(
  root: string,
  options: { driver?: string; databaseUrl?: string },
  probe: DriverProbe = dockerProbe,
): Promise<void> {
  const existing = loadConfig(root);
  const changes: string[] = [];

  let driver: 'local' | 'docker' | undefined;
  if (options.driver) {
    if (options.driver !== 'local' && options.driver !== 'docker') {
      ui.fail(`driver must be local or docker, not ${options.driver}`);
      process.exitCode = 1;
      return;
    }
    driver = options.driver;
    changes.push(`driver ${options.driver}`);
  } else if (storedDriver() === undefined) {
    // Written down, so the choice does not flip when Docker stops or starts.
    // A driver install.json already names is never changed here.
    const choice = await chooseDriver(probe);
    driver = choice.driver;
    changes.push(`driver ${choice.driver}`);
    ui.ok(`driver: ${choice.driver}, because ${choice.reason}`);
    if (choice.driver === 'local') {
      ui.warn(LOCAL_DRIVER_WARNING);
      for (const note of LOCAL_DRIVER_NOTES) ui.note(note);
    }
  }
  if (options.databaseUrl) {
    changes.push('database url');
    // `main` filled DATABASE_URL from the install file before this ran. Left
    // alone, the secret below would be looked for in, and written to, the
    // database this install is moving away from.
    process.env.DATABASE_URL = options.databaseUrl;
  }

  // An install with no webhook secret refuses every delivery. Keep one the
  // install file, the secret store or the environment already has, and generate
  // one only when none of them does. The value is stored and not printed: it is
  // a signing key.
  const settled = await settleWebhookSecret(
    {
      ...defaultConfig(root),
      ...existing,
      ...(driver ? { driver } : {}),
      ...(options.databaseUrl ? { databaseUrl: options.databaseUrl } : {}),
    },
    {
      environment: process.env.FLEETADLC_WEBHOOK_SECRET,
      // The settings table is where an older install kept it, until its bridge
      // next starts and moves it into the secret store.
      stored: async () => (await getSecretStore().get(webhookSecretRef())) ?? (await settings.getSetting('webhookSecret')),
      // A running bridge reads the secret store on the next delivery, so a
      // generated secret takes effect without a restart.
      store: (secret) => getSecretStore().set(webhookSecretRef(), secret),
    },
  );
  await closePool().catch(() => undefined);
  if (settled.source !== 'install') changes.push('webhook secret');

  if (changes.length > 0) {
    saveConfig(settled.config);
    ui.ok(`saved ${configPath()} — ${changes.join(', ')}`);
    if (settled.source === 'generated') {
      ui.note('A webhook secret was generated and stored. It is not printed.');
      ui.note('GitHub must sign with that same value. The onboarding walkthrough sends it when it can.');
    } else if (settled.source === 'environment') {
      ui.note('The webhook secret in FLEETADLC_WEBHOOK_SECRET was kept and saved with the install. It is not printed.');
    } else if (settled.source === 'stored') {
      ui.note('The webhook secret the bridge already verifies against was saved with the install. It is not printed.');
    }
    ui.note('Restart the stack for a driver or database change to take effect: fleetadlc down && fleetadlc up');
    ui.plain();
  }

  const consoleUrl = `http://127.0.0.1:${existing.ports.console}`;
  const running = await fetch(`${consoleUrl}/onboarding`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok)
    .catch(() => false);

  ui.heading('Setting up this install');
  if (running) {
    ui.step(`Open ${consoleUrl}/onboarding`);
    ui.note('Organization, GitHub App client id, gate approvers, public url and webhook');
    ui.note('secret are all set there, and take effect without a restart.');
  } else {
    ui.step('fleetadlc up');
    ui.note(`Then open ${consoleUrl}/onboarding, where everything else is set.`);
    const using = driver ?? existing.driver;
    ui.note(
      `\`fleetadlc up\` needs no other configuration: it runs each task with the ${using} driver` +
        (using === 'docker' ? ', in a container of its own.' : ', as this user on this machine.'),
    );
  }
}
