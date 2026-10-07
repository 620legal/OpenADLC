import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The integration suites write to the install they run against: leases,
 * tasks, budgets, and deliveries signed with its own secret. They found it at
 * FLEETADLC_BRIDGE_URL, which defaults to 127.0.0.1:47311, so on a machine that
 * runs OpenADLC a suite started without a scratch install's exports wrote into
 * the real board.
 *
 * They run only against an install whose engines are scripted, which the
 * bridge says in `/healthz`: a scratch install (tests/scratch.sh), or CI's.
 * That alone was not enough. A bridge that did not answer let the suite carry
 * on, and `fleetadlc down` stops the bridge but leaves the database running, so
 * kill-and-restart.mjs deleted a stopped real install's tasks and leases. So
 * this fails closed: no answer is a refusal, every variable that names the
 * install has to be exported, and FLEETADLC_HOME may not be ~/.fleetadlc.
 */
export const INSTALL_VARIABLES = ['FLEETADLC_BRIDGE_URL', 'FLEETADLC_HOSTD_URL', 'DATABASE_URL', 'FLEETADLC_HOME'];

/**
 * Why a suite may not run against the install the environment names, or null
 * when it may. `health` is the bridge's `/healthz` answer, null when it did not
 * answer; `home` is the user's home directory.
 */
export function whyNotScratch({ env, health, home }) {
  const missing = INSTALL_VARIABLES.filter((name) => !env[name]);
  if (missing.length > 0) {
    return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, and the defaults are a real install's`;
  }
  const given = env.FLEETADLC_HOME.replace(/^~(?=\/|$)/, home);
  if (resolve(given) === resolve(join(home, '.fleetadlc'))) {
    return `FLEETADLC_HOME is ${resolve(given)}, the real install's home`;
  }
  const bridge = env.FLEETADLC_BRIDGE_URL;
  if (!health) {
    return `no bridge answers at ${bridge}, so nothing says the install there is a scratch one, and its database may still be running`;
  }
  if (health.scripted !== true) return `the install at ${bridge} is a real one, and this suite writes to it`;
  return null;
}

export async function refuseARealInstall() {
  const bridge = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
  const health = await fetch(`${bridge}/healthz`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const reason = whyNotScratch({ env: process.env, health, home: homedir() });
  if (reason) {
    console.error(
      [
        `refusing to run: ${reason}.`,
        'Run it against a scratch install:',
        '  tests/scratch.sh up && eval "$(tests/scratch.sh env)"',
      ].join('\n'),
    );
    process.exit(2);
  }
}
