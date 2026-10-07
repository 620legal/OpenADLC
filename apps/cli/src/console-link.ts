import { createHmac } from 'node:crypto';
import { consoleSecretRef, getSecretStore, type SecretStore } from '@fleetadlc/github';

/**
 * What the CLI holds that a browser and a task's container do not: the
 * install's console secret, read from the secret store as the internal secret
 * is. A local bridge serves `/v1` only to a caller presenting it, and the
 * console serves a browser only once it has signed in with a link minted from
 * it. Neither the link nor anything printed is the secret itself.
 */
export const CONSOLE_SECRET_HEADER = 'x-fleetadlc-console-secret';

/**
 * The console verifies this with Web Crypto (`apps/console/src/lib/sign-in.ts`).
 * The label and the lifetime are the console's; both tests check one fixed
 * vector, so the two cannot drift.
 */
const SIGN_IN_LABEL = 'fleetadlc-console-sign-in:';
const SIGN_IN_LIFETIME_SECONDS = 60 * 60;

/** A link that signs a browser in to the console, good for an hour from `now` (ms). */
export function signInLink(secret: string, consoleUrl: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SIGN_IN_LIFETIME_SECONDS;
  const signature = createHmac('sha256', secret).update(`${SIGN_IN_LABEL}${exp}`).digest('hex');
  return `${consoleUrl.replace(/\/+$/, '')}/signin?token=${exp}.${signature}`;
}

/**
 * Where this install's console is: `FLEETADLC_CONSOLE_URL` when it is set, as
 * when the console is opened under another name, else the port in
 * install.json, else the default.
 */
export function consoleUrlOf(port: number | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FLEETADLC_CONSOLE_URL?.trim();
  if (configured) return configured;
  return `http://127.0.0.1:${port ?? 47300}`;
}

/** The console secret, or a refusal that says how to get one. */
export async function consoleSecret(store: SecretStore = getSecretStore()): Promise<string> {
  const secret = await store.get(consoleSecretRef());
  if (!secret) throw new Error('this install has no console secret yet; start it with `fleetadlc up`');
  return secret;
}

/** What a CLI call to the bridge's `/v1` carries: who is asking, and the secret that makes the bridge believe it. */
export async function bridgeHeaders(store: SecretStore = getSecretStore()): Promise<Record<string, string>> {
  return {
    'x-fleetadlc-identity': process.env.USER ?? 'operator',
    [CONSOLE_SECRET_HEADER]: await consoleSecret(store),
  };
}

/**
 * `fleetadlc console-link`: a fresh sign-in link for the install
 * `FLEETADLC_HOME` points at, alone on stdout so a script can take it.
 */
export async function consoleLink(port: number | undefined, store: SecretStore = getSecretStore()): Promise<string> {
  const link = signInLink(await consoleSecret(store), consoleUrlOf(port));
  console.log(link);
  return link;
}
