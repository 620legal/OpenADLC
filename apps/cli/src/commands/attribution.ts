import { getSecretStore, type SecretStore } from '@fleetadlc/github';
import { bridgeHeaders } from '../console-link.js';
import type { InstallConfig } from '../install.js';
import { ui } from '../ui.js';

interface Rotated {
  kid: string;
  retiredKid: string;
  oldKeyChecksUntil: string | null;
}

/**
 * `fleetadlc attribution rotate [--drop-old]`: a new key for signing the
 * crew's posts, made by the running bridge (`POST /v1/attribution/rotate`).
 *
 * Through the bridge rather than the secret store: the bridge keeps the key
 * ring in memory, and a key written to the store beside it would not be used
 * to sign or check anything until it restarted. True when the key changed.
 */
export async function rotateAttribution(
  config: Pick<InstallConfig, 'ports'>,
  options: { dropOld: boolean },
  deps: { fetch?: typeof fetch; store?: SecretStore } = {},
): Promise<boolean> {
  const call = deps.fetch ?? fetch;
  const where = `127.0.0.1:${config.ports.bridge}`;
  let response: Response;
  try {
    response = await call(`http://${where}/v1/attribution/rotate`, {
      method: 'POST',
      headers: { ...(await bridgeHeaders(deps.store ?? getSecretStore())), 'content-type': 'application/json' },
      body: JSON.stringify({ dropOld: options.dropOld }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // No console secret yet says to start the install too; anything else is a bridge that is not up.
    const missing = error instanceof Error && error.message.includes('no console secret');
    ui.fail(missing ? error.message : `the bridge is not answering on ${where}; start the install with fleetadlc up and run this again`);
    process.exitCode = 1;
    return false;
  }
  if (!response.ok) {
    const said = ((await response.json().catch(() => null)) as { error?: string } | null)?.error;
    ui.fail(`the bridge did not rotate the key: ${said ?? `it answered ${response.status}`}`);
    process.exitCode = 1;
    return false;
  }

  const rotated = (await response.json()) as Rotated;
  ui.ok(`the crew's posts are signed with key ${rotated.kid} from now on (it was ${rotated.retiredKid})`);
  if (rotated.oldKeyChecksUntil) {
    ui.note(`key ${rotated.retiredKid} keeps checking posts signed before now until ${rotated.oldKeyChecksUntil.slice(0, 10)}`);
  } else {
    ui.warn(`key ${rotated.retiredKid} and every key before it no longer check anything`);
    ui.note(
      'with signatures enforced (attributionMode: enforce), crew reviews posted under them no longer count toward a merge: ' +
        'open pull requests wait for a fresh lead review. In audit mode nothing is held',
    );
  }
  ui.note('take a new backup now (fleetadlc backup): an older one restores the old key');
  return true;
}
