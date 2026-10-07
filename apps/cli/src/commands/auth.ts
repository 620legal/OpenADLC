import { bots, closePool, credentials } from '@fleetadlc/db';
import {
  GitHubClient,
  credentialKind,
  getSecretStore,
  internalSecretRef,
  pollForUserToken,
  requestDeviceCode,
  type UserToken,
} from '@fleetadlc/github';
import { resolveBotRef, roleLabel, sameLogin, stepNamed } from '@fleetadlc/shared';
import { githubClientId } from '../client-id.js';
import { reachDatabase } from '../database.js';
import type { InstallConfig } from '../install.js';
import { confirm, ui } from '../ui.js';

/**
 * Which bots `fleetadlc auth login` connects: every one with `--all`, or the one
 * `--bot` names — by its seat (`builder`), by the name it goes by now, or by
 * the persona an older guide called it. A bot is renamed when its account
 * connects, so the seat is the name that is still right afterwards.
 */
export function botsToConnect<T extends { name: string; slot: string; githubLogin: string | null }>(
  crew: readonly T[],
  options: { bot?: string; all?: boolean },
): T[] {
  if (options.all) return [...crew];
  const wanted = options.bot ?? '';
  const found = resolveBotRef(crew, wanted) ?? crew.find((bot) => sameLogin(bot.githubLogin, wanted));
  return found ? [found] : [];
}

/** What the bridge said to a seat's sign-in. */
export type BridgeConnect =
  | { state: 'connected'; login: string; bot: string; joined?: string; warning?: string }
  | { state: 'refused'; message: string }
  /** Not answering, or no secret to ask it with: nothing was stored. */
  | { state: 'unreachable' };

/**
 * Hands a seat's fresh sign-in to the bridge, which connects it as the
 * console does (`Onboarding.connect`): a seat signing in as an account its
 * group already holds joins it, one the other group holds is refused, and a
 * seat changing account leaves its old one first. This did it on its own and
 * refused every account another seat held, so `auth login --all` connected
 * one seat per account of the two-account crew the docs recommend; and it
 * filed the sign-in under the seat's name, over a shared account's. The token
 * goes to 127.0.0.1 only, and is written only by the bridge.
 */
export async function connectThroughBridge(
  port: number,
  secret: string | null,
  input: { bot: string; token: UserToken; actor: string },
  send: typeof fetch = fetch,
): Promise<BridgeConnect> {
  if (!secret) return { state: 'unreachable' };
  let response: Response;
  try {
    response = await send(`http://127.0.0.1:${port}/internal/bots/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': secret },
      body: JSON.stringify(input),
      // Joining an account lets the seat into every repository, which takes a while.
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    return { state: 'unreachable' };
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string; login?: string; bot?: string; joined?: string; warning?: string };
  if (!response.ok) return { state: 'refused', message: body.error ?? `the bridge answered ${response.status}` };
  return {
    state: 'connected',
    login: body.login ?? '',
    bot: body.bot ?? input.bot,
    ...(body.joined ? { joined: body.joined } : {}),
    ...(body.warning ? { warning: body.warning } : {}),
  };
}

/** Whether the bridge answers at all, asked before anyone is sent to approve a code. */
async function bridgeAnswers(port: number, send: typeof fetch = fetch): Promise<boolean> {
  return send(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) })
    .then((response) => response.ok)
    .catch(() => false);
}

function bridgeDown(again: string): void {
  ui.fail(`the bridge is not running. Run: fleetadlc up, then ${again}`);
  ui.note('the bridge connects each seat, so nothing was stored');
}

/**
 * Connects a seat to a GitHub account with the OAuth device flow. A person
 * signs in as that account once; OpenADLC keeps its refresh token and mints
 * short-lived user tokens from then on. An app with token expiry off hands out
 * no refresh token, and the non-expiring user token is stored instead, with a
 * warning. No personal access token is ever created.
 *
 * Whichever account approves is the account the bot is. The bridge stores it
 * (`connectThroughBridge`), so a seat may join an account another seat of its
 * group is on, as in the console.
 */
export async function authLogin(config: InstallConfig, options: { bot?: string; all?: boolean }): Promise<void> {
  await reachDatabase();
  // The walkthrough stores it in settings; see `githubClientId`.
  const clientId = await githubClientId(config);
  if (!clientId) {
    ui.fail('no GitHub App client id is configured');
    // Not `fleetadlc init`, which this used to name: it sets only the driver and
    // the database url, and the client id is the console's.
    ui.note(`Create the app on ${stepNamed('app')} of the console walkthrough, or set FLEETADLC_GITHUB_CLIENT_ID.`);
    ui.note('The CLI, like the bridge, uses the client id the console stored, then FLEETADLC_GITHUB_CLIENT_ID, then install.json.');
    ui.note('The app needs "Device flow" enabled and "Expire user authorization tokens" on.');
    await closePool();
    process.exitCode = 1;
    return;
  }

  const crew = await bots.listBots();
  if (crew.length === 0) {
    ui.fail('no bots are configured; run `fleetadlc up` once so config/bots.yaml is loaded');
    await closePool();
    process.exitCode = 1;
    return;
  }

  const seats = `seats: ${crew.map((bot) => (bot.name === bot.slot ? bot.slot : `${bot.slot} (${bot.name})`)).join(', ')}`;
  // `fleetadlc auth login` alone, the likeliest first try, said "no bot named
  // (none given)" and not what to type instead.
  if (!options.bot?.trim() && !options.all) {
    ui.fail('name a bot: fleetadlc auth login --bot SEAT, or --all for every bot');
    ui.note(seats);
    await closePool();
    process.exitCode = 2;
    return;
  }

  const targets = botsToConnect(crew, options);

  if (targets.length === 0) {
    ui.fail(`no bot named ${options.bot}`);
    ui.note(seats);
    await closePool();
    process.exitCode = 1;
    return;
  }

  const secret = await getSecretStore().get(internalSecretRef());
  if (!secret || !(await bridgeAnswers(config.ports.bridge))) {
    bridgeDown(options.all ? 'fleetadlc auth login --all' : `fleetadlc auth login --bot ${targets[0]?.slot ?? '<seat>'}`);
    await closePool();
    process.exitCode = 1;
    return;
  }

  let connectedAny = false;

  for (const target of targets) {
    // Read again: connecting the one before may have renamed nothing here, but
    // it did change who holds which account.
    const bot = (await bots.getBotById(target.id)) ?? target;
    ui.heading(`Connect the ${roleLabel(bot.role)} (${bot.name})`);

    ui.step(
      bot.githubLogin
        ? `Sign in to GitHub as ${bot.githubLogin} (not as yourself) and approve the OpenADLC app.`
        : `Sign in to GitHub as the account this bot should be (not as yourself) and approve the OpenADLC app.`,
    );
    const code = await requestDeviceCode({ clientId });

    ui.plain(`    open ${code.verificationUri} and enter this code:`);
    ui.bigCode(code.userCode);
    ui.note(`the code is valid for ${Math.round(code.expiresIn / 60)} minutes`);

    let token;
    try {
      token = await pollForUserToken({
        clientId,
        deviceCode: code.deviceCode,
        intervalSeconds: code.interval,
        expiresInSeconds: code.expiresIn,
        onPending: (waited) => {
          if (waited % 15 === 0) ui.note(`still waiting for approval (${waited}s)`);
        },
      });
    } catch (error) {
      ui.fail(error instanceof Error ? error.message : 'device authorization failed');
      continue;
    }

    // Who approved, asked before anything is stored, so a person who signed
    // in as the wrong account can say no.
    const client = new GitHubClient({ token: token.accessToken, actingAs: bot.githubLogin ?? bot.name });
    const viewer = await client.viewer().catch(() => null);
    if (!viewer) {
      ui.fail('GitHub did not say which account approved, so nothing was stored');
      continue;
    }
    const login = viewer.login;

    if (bot.githubLogin && !sameLogin(bot.githubLogin, login)) {
      ui.warn(`that authorization is for ${login}, and ${bot.name} was ${bot.githubLogin}`);
      if (!(await confirm(`Make ${login} the ${roleLabel(bot.role)}'s account?`))) {
        ui.fail(`skipped ${bot.name}; sign in as ${bot.githubLogin} and try again`);
        continue;
      }
    }

    const answer = await connectThroughBridge(config.ports.bridge, secret, { bot: bot.slot, token, actor: 'fleetadlc auth login' });
    if (answer.state === 'unreachable') {
      bridgeDown(`fleetadlc auth login --bot ${bot.slot}`);
      process.exitCode = 1;
      break;
    }
    if (answer.state === 'refused') {
      ui.fail(answer.message);
      continue;
    }
    connectedAny = true;
    if (answer.joined) {
      // `joined` is the seat already on the account, by name, which is the
      // account's handle once it connects: "joined janedoe-crew with
      // janedoe-crew" said nothing. Its role says which seat it is.
      const holder = (await bots.listBots()).find((other) => other.name === answer.joined || other.slot === answer.joined);
      ui.ok(`the ${roleLabel(bot.role)} is connected as ${answer.login}, sharing it with the ${holder ? roleLabel(holder.role) : answer.joined}`);
    } else ui.ok(`the ${roleLabel(bot.role)} is connected as ${answer.login}`);
    if (answer.bot !== bot.name) ui.ok(`${bot.name} is now ${answer.bot}`);
    if (answer.warning) ui.warn(answer.warning);
    if (!token.refreshToken) {
      ui.warn('this app issues non-expiring user tokens; turn on token expiration for short-lived credentials');
    }
  }

  if (!connectedAny && targets.length > 0) process.exitCode = 1;
  await closePool();
}

export async function authStatus(): Promise<void> {
  await reachDatabase();
  const crew = await bots.listBots();

  ui.heading('GitHub accounts');
  let anyStatic = false;
  for (const bot of crew) {
    const record = await credentials.getCredential(bot.id);
    // The seat, then the account: a connected bot's name is its account's handle.
    const label = `${bot.slot.padEnd(18)} ${(bot.githubLogin ?? 'no account').padEnd(24)}`;
    const kind = await credentialKind(bot.name);
    if (kind === 'static') anyStatic = true;

    if (!record || record.status === 'unauthorized') {
      // An install whose app issues non-expiring tokens has the secret but no
      // authorization row, and it can still act.
      if (kind === 'static') {
        ui.ok(`${label} connected with a stored token (no expiry, so nothing refreshes)`);
        continue;
      }
      ui.warn(`${label} not connected — fleetadlc auth login --bot ${bot.slot}`);
      continue;
    }
    if (record.status !== 'active') {
      ui.fail(`${label} ${record.status} — fleetadlc auth login --bot ${bot.slot}`);
      continue;
    }

    const expiry = record.tokenExpiresAt ? new Date(record.tokenExpiresAt) : null;
    const stale = expiry !== null && expiry.getTime() < Date.now();
    ui.ok(`${label} connected${stale ? ' (token stale; refreshes on next use)' : ''}`);
  }

  ui.plain();
  // Said only when it is true: a seat connected through an app with token
  // expiry off has its non-expiring user token stored, and this note claimed
  // otherwise under the line that said so.
  if (anyStatic) {
    ui.warn('the app issues non-expiring user tokens, so OpenADLC stores that token itself');
    ui.note('turn on "Expire user authorization tokens" on the app’s settings page, then run fleetadlc auth login again for those seats');
  } else {
    ui.note('OpenADLC stores a refresh token per account; user tokens are minted per task and expire in 8 hours.');
  }
  await closePool();
}
