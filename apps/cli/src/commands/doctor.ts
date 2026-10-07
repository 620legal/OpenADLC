import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bots, closePool, costs, credentials, describeDatabase, hosts, lastGithubDelivery, settings, waitForDatabase } from '@fleetadlc/db';
import { credentialKind, fleetHome, getSecretStore, webhookSecretRef, type SecretStore } from '@fleetadlc/github';
import { actionTarget, stepNamed, type HealthView } from '@fleetadlc/shared';
import { githubClientId } from '../client-id.js';
import { bridgeHeaders } from '../console-link.js';
import { healthUrl } from './up.js';
import { LOCAL_DRIVER_NOTES, LOCAL_DRIVER_WARNING, dockerProbe, hasPublishedDatabasePassword, homeIsOpen, type InstallConfig } from '../install.js';
import { keeperPid } from '../processes.js';
import { DOCKER_NOT_RUNNING, START_DOCKER, addressesInstallDatabase, existingDatabaseContainer, postgresBindings, publishedPostgresPort, upDriver, type PortBinding } from './up.js';
import { ui } from '../ui.js';

const run = promisify(execFile);

/**
 * Why this install cannot trust a GitHub delivery, or null when a secret is
 * configured in any of the places the bridge reads.
 *
 * The messages are fixed strings. A secret is a signing key, so it must not be
 * interpolated into what `fleetadlc doctor` prints.
 */
export function webhookTrustGap(input: {
  installSecret: string;
  environmentSecret: string | undefined;
  storedSecret: string | null;
}): { message: string; remedy: string } | null {
  const present = [input.installSecret, input.environmentSecret ?? '', input.storedSecret ?? ''].some(
    (value) => value.length > 0,
  );
  if (present) return null;
  return {
    message: 'this install has no webhook secret, so every GitHub delivery is refused',
    remedy:
      'generate one with `openssl rand -hex 32` and store it — `fleetadlc init` does, and so does the onboarding walkthrough. ' +
      'Put the same value on the GitHub webhook. The bridge does not accept an unsigned delivery in any configuration.',
  };
}

/**
 * Which places holding a webhook secret disagree with the one the bridge uses,
 * or null when none do. It names places and never includes a value.
 *
 * The bridge prefers the secret store's to its environment, and `fleetadlc up` starts
 * it with the install file's secret over an exported one. A secret anywhere
 * else is not what a delivery is verified against, so an operator who gave
 * GitHub that one had every delivery refused while doctor said a secret was
 * configured.
 */
export function webhookSecretMismatch(input: {
  installSecret: string;
  environmentSecret: string | undefined;
  storedSecret: string | null;
}): { message: string; remedy: string } | null {
  const places = [
    { name: 'the secret store', value: input.storedSecret ?? '' },
    { name: 'install.json', value: input.installSecret },
    { name: 'FLEETADLC_WEBHOOK_SECRET', value: input.environmentSecret ?? '' },
  ].filter((place) => place.value.length > 0);
  const [used, ...rest] = places;
  const ignored = rest.filter((place) => place.value !== used?.value);
  if (!used || ignored.length === 0) return null;
  return {
    message: `the webhook secret in ${ignored.map((place) => place.name).join(' and ')} differs from the one in ${used.name}, which is what the bridge verifies against`,
    remedy: `GitHub must sign with the one in ${used.name}. Give it that value, or make the others match it.`,
  };
}

/**
 * Why the platform database lets in whoever knows OpenADLC's published
 * password, or null when the url this process connects with has another.
 *
 * A database that takes it takes a superuser login from anything that reaches
 * its port — a task's computer through `host.docker.internal` among them — and
 * a superuser can rewrite the webhook secret, the humans, the ledger and the
 * audit trail. The fix depends on who runs the server: `fleetadlc up` changes
 * the password of the container it keeps, and of no other. Never includes a
 * password.
 */
export function databasePasswordGap(databaseUrl: string, managed: boolean): { message: string; remedy: string } | null {
  if (!hasPublishedDatabasePassword(databaseUrl)) return null;
  return {
    message: 'the platform database takes the password published with OpenADLC, so anything that reaches its port can log in as its superuser',
    remedy: managed
      ? 'run `fleetadlc up`: it gives this install a password of its own and keeps it in install.json'
      : 'OpenADLC does not manage this server: change the role’s password on it (ALTER ROLE … PASSWORD), then put the new one in databaseUrl in install.json (POSTGRES_PASSWORD under the compose stack)',
  };
}

/**
 * Why the install's database container is reachable from beyond this machine,
 * or null when it is published on loopback only, or not at all.
 *
 * An older `fleetadlc up` published it on every address, where Docker's rules
 * go around a host firewall. `up` does not recreate it, since its data is in
 * an anonymous volume `docker rm` would orphan; this says how to move it.
 */
export function databaseBindingGap(
  name: string,
  bindings: readonly PortBinding[] | undefined,
): { message: string; remedy: string } | null {
  const open = (bindings ?? []).filter((binding) => binding.HostIp !== '127.0.0.1');
  if (open.length === 0) return null;
  const where = open.map((binding) => `${binding.HostIp || 'every address'}:${binding.HostPort ?? ''}`).join(', ');
  const port = open[0]?.HostPort ?? '';
  return {
    message: `${name} publishes postgres on ${where}, not on 127.0.0.1 only`,
    remedy:
      `recreate it on loopback, keeping its data: fleetadlc down; docker stop ${name}; docker rename ${name} ${name}-old; ` +
      `docker run -d --name ${name} --volumes-from ${name}-old -p 127.0.0.1:${port}:5432 pgvector/pgvector:pg16; fleetadlc up. ` +
      `Then docker rm ${name}-old, without -v (docs/self-hosting.md)`,
  };
}

/**
 * What doctor says about the install's database container: its password, and
 * whether it is published beyond loopback. The container is `fleet-db` on an
 * install from before the rename, not only `fleetadlc-db`. Looking at the new
 * name alone missed a container published on every address, and the password
 * check then had nothing to attach a binding to.
 */
export async function databaseContainerGaps(
  config: { ports: Pick<InstallConfig['ports'], 'postgres'> },
  databaseUrl: string,
  bindingsOf: (name: string) => Promise<PortBinding[] | undefined> = postgresBindings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ password: ReturnType<typeof databasePasswordGap>; exposed: ReturnType<typeof databaseBindingGap> }> {
  const container = await existingDatabaseContainer(config, env, (name) => publishedPostgresPort(name, bindingsOf));
  const bindings = await bindingsOf(container);
  const managed =
    addressesInstallDatabase(databaseUrl, config.ports.postgres) &&
    (bindings ?? []).some((binding) => binding.HostPort === String(config.ports.postgres));
  return { password: databasePasswordGap(databaseUrl, managed), exposed: databaseBindingGap(container, bindings) };
}

export interface HealthLine {
  level: 'ok' | 'warn' | 'fail' | 'unknown' | 'note';
  text: string;
}

/**
 * Text from a health row as it is safe to print to a terminal: escape
 * sequences, OSC ones (a hyperlink, a window title) whole, and every other
 * control character but a newline taken out. A card's title or detail can
 * carry text a stranger wrote, such as the seat a forged post claimed, and
 * printed raw it drove the operator's terminal.
 */
export function printable(text: string): string {
  return text
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u009c|\u001b\\)?/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

/**
 * What doctor prints for the bridge's health checks, and how many blocking
 * ones fail — the same checks that put a card on the board, asked now.
 *
 * A check that passes for every subject is one line; each failure is its own,
 * with what to do and where, a console page given as the address to open.
 */
export function healthLines(checks: readonly HealthView[], consoleUrl: string): { lines: HealthLine[]; blocking: number } {
  const lines: HealthLine[] = [];
  const add = (line: HealthLine) => lines.push({ ...line, text: printable(line.text) });
  let blocking = 0;
  const base = consoleUrl.replace(/\/+$/, '');
  const order: string[] = [];
  for (const check of checks) if (!order.includes(check.check)) order.push(check.check);

  for (const id of order) {
    const rows = checks.filter((check) => check.check === id);
    const failing = rows.filter((row) => row.state === 'failing');
    const unknown = rows.filter((row) => row.state === 'unknown');
    if (failing.length === 0 && unknown.length === 0) {
      add({ level: 'ok', text: rows[0]?.proves ?? id });
      continue;
    }
    for (const row of failing) {
      if (row.severity === 'blocking') blocking += 1;
      add({ level: row.severity === 'blocking' ? 'fail' : 'warn', text: row.title ?? row.proves });
      if (row.detail) add({ level: 'note', text: row.detail.replace(/\*\*/g, '') });
      if (row.action) {
        const target = actionTarget(row.action);
        const where = 'href' in row.action ? `${base}${target}` : 'command' in row.action ? `run \`${target}\`` : target;
        add({ level: 'note', text: `→ ${row.action.label}: ${where}` });
      }
      if (row.waitingFor.length > 0) add({ level: 'note', text: `after: ${row.waitingFor.join(', ')}` });
    }
    if (unknown.length > 0 && failing.length === 0) {
      const why = [...new Set(unknown.map((row) => row.detail).filter(Boolean))].join('; ');
      add({ level: 'unknown', text: `${rows[0]?.proves ?? id} — not known yet${why ? `: ${why}` : ''}` });
    }
  }
  return { lines, blocking };
}

/**
 * Runs the bridge's checks now and prints them. The number of blocking
 * failures, which doctor counts as problems and exits non-zero on, or null
 * when the bridge could not be asked.
 */
export async function checkHealth(
  config: Pick<InstallConfig, 'ports'>,
  store: SecretStore = getSecretStore(),
): Promise<number | null> {
  let checks: HealthView[];
  try {
    const response = await fetch(`http://127.0.0.1:${config.ports.bridge}/v1/health/run`, {
      method: 'POST',
      headers: await bridgeHeaders(store),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
    checks = ((await response.json()) as { checks?: HealthView[] }).checks ?? [];
  } catch (error) {
    ui.warn(`the bridge could not run its health checks: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  if (checks.length === 0) {
    ui.note('nothing to check yet: the walkthrough sets the install up first');
    return 0;
  }
  const { lines, blocking } = healthLines(checks, `http://127.0.0.1:${config.ports.console}`);
  for (const line of lines) {
    if (line.level === 'ok') ui.ok(line.text);
    else if (line.level === 'fail') ui.fail(line.text);
    else if (line.level === 'warn') ui.warn(line.text);
    else if (line.level === 'unknown') ui.note(`? ${line.text}`);
    else ui.note(line.text);
  }
  return blocking;
}

/**
 * The bridge's checks as doctor counts them: each blocking failure, or one
 * problem, said through `fail`, when the bridge could not be asked.
 *
 * A null from `checkHealth` added nothing, so with the bridge down (its keeper
 * given up after repeated crashes) doctor printed a warning, then "no problems
 * found", and exited 0: a watchdog on its exit code never fired while
 * webhooks, gates, the merge line and the dispatcher had all stopped.
 */
export async function bridgeProblems(
  config: Pick<InstallConfig, 'ports'>,
  fail: (message: string, hint?: string) => void,
  store: SecretStore = getSecretStore(),
): Promise<number> {
  const blocking = await checkHealth(config, store);
  if (blocking !== null) return blocking;
  fail(
    `the bridge is not answering on :${config.ports.bridge}, so its health checks could not run`,
    'fleetadlc up, then see fleetadlc logs bridge',
  );
  return 0;
}

async function version(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(command, args);
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Asks hostd for something it must refuse. Everything hostd exposes starts a
 * task, kills a session or mints an attach token, so a hostd that serves an
 * unauthenticated caller is reachable-is-permitted — which is what the private
 * network alone amounted to. The call is deliberately one we want a 401 from;
 * a 200 is the finding.
 */
async function checkHostdAuthenticates(
  config: InstallConfig,
  fail: (message: string, remedy?: string) => void,
): Promise<void> {
  // Any bot will do — the answer wanted is the refusal — so a seat every
  // install has, rather than whatever this one's bots are called now.
  const url = `http://127.0.0.1:${config.ports.hostd}/bots/builder/sessions`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    ui.warn('hostd is not answering, so its authentication was not checked');
    return;
  }

  if (response.status === 401) {
    ui.ok('hostd refuses a caller without the internal secret');
  } else if (response.status === 503) {
    fail(
      'hostd has no internal secret, so it is refusing the bridge too',
      'the bridge generates it: `fleetadlc up`, or start the bridge',
    );
  } else {
    fail(
      `hostd served an unauthenticated request (${response.status})`,
      'anything that can reach :' +
        String(config.ports.hostd) +
        ' can start a task, kill a session or mint an attach token',
    );
  }
}

/** How long ago, in the roughest unit that is still useful. */
function ago(at: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** "1 question", "2 questions": every noun here takes an s. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The url this process connects with: `main` fills it from install.json, and
 * the compose stack and the cloud host set it themselves.
 */
export function databaseInUse(config: Pick<InstallConfig, 'databaseUrl'>, env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL || config.databaseUrl;
}

/**
 * The line under `Install at`: which database, never its user or password.
 * The home alone did not say it, and a stale exported DATABASE_URL was
 * another invisible way to be looking at another install.
 */
export function databaseLine(url: string): string {
  return `database: ${describeDatabase(url) ?? 'a DATABASE_URL that could not be read'}`;
}

/**
 * What `cannot reach postgres` says to look at: the url the connection used.
 * It named install.json's, while the connection had used an exported one, and
 * sent the operator to a database that worked.
 */
export function unreachableDatabaseHint(url: string): string {
  const where = describeDatabase(url);
  return where ? `DATABASE_URL points at ${where}` : 'DATABASE_URL could not be read';
}

function installHeading(config: InstallConfig): void {
  // State lives under FLEETADLC_HOME, so say which one this is: a stale value in the
  // environment is otherwise an invisible way to be looking at another install.
  ui.heading(`Install at ${fleetHome()}`);
  ui.note(databaseLine(databaseInUse(config)));
}

export async function status(config: InstallConfig, store: SecretStore = getSecretStore()): Promise<void> {
  installHeading(config);

  ui.heading('Processes');
  // An install whose engines are scripted starts its bridge without the
  // dispatcher (`bridgeDispatches` in up.ts), and the bridge says so in
  // /healthz; this line used to claim it dispatched either way.
  const scripted = await fetch(`http://127.0.0.1:${config.ports.bridge}/healthz`, { signal: AbortSignal.timeout(2000) })
    .then(async (response) => ((await response.json()) as { scripted?: boolean }).scripted === true)
    .catch(() => false);
  for (const name of ['hostd', 'bridge', 'console'] as const) {
    const pid = keeperPid(name);
    if (pid !== null) {
      const dispatching = scripted ? ', not dispatching: the integration suites do here' : ', dispatching work as it changes';
      ui.ok(`${name.padEnd(11)} running (pid ${pid})${name === 'bridge' ? dispatching : ''}`);
      continue;
    }

    // A service that answers but has no live pid file was started by something
    // else — another shell, or an install with a different FLEETADLC_HOME.
    const port =
      name === 'console' ? config.ports.console : name === 'bridge' ? config.ports.bridge : config.ports.hostd;
    const answering = await fetch(healthUrl(name, port), { signal: AbortSignal.timeout(2000) })
      .then((response) => response.ok)
      .catch(() => false);

    if (answering) {
      ui.warn(`${name.padEnd(11)} answering on :${port} but not started by this install`);
    } else {
      ui.warn(`${name.padEnd(11)} not running`);
    }
  }

  try {
    const response = await fetch(`http://127.0.0.1:${config.ports.bridge}/v1/status`, { headers: await bridgeHeaders(store), signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(String(response.status));
    const report = (await response.json()) as {
      board: Record<string, number>;
      budget: { spentUsd: number; capUsd: number; state: string };
      openGates: number;
      activeLeases: number;
      crew: { name: string; now: string; authorization: string }[];
      jobs?: { job: string; lastRunAt: string | null }[];
      identity?: { mode: string; detail: string };
    };

    ui.heading('Board');
    ui.plain(
      `    ${Object.entries(report.board)
        .map(([stage, count]) => `${stage} ${count}`)
        .join(' · ')}`,
    );

    ui.heading('Spend');
    ui.plain(
      `    $${report.budget.spentUsd.toFixed(2)} of $${report.budget.capUsd.toFixed(0)} (${report.budget.state})`,
    );
    ui.plain(
      `    ${counted(report.openGates, 'question')} waiting on a person · ${counted(report.activeLeases, 'active lease')}`,
    );

    if (report.jobs && report.jobs.length > 0) {
      ui.heading('Scheduled work');
      for (const entry of report.jobs) {
        // A job with no recorded run: one turned off, or one whose interval
        // has not yet passed since the bridge last started (each job first
        // runs one interval after start, so a restart puts the wait back).
        // Either is invisible until the work it does is missed.
        if (!entry.lastRunAt) ui.warn(`${entry.job.padEnd(12)} never run`);
        else ui.ok(`${entry.job.padEnd(12)} last ran ${ago(entry.lastRunAt)}`);
      }
    }

    ui.heading('Crew');
    for (const bot of report.crew) {
      const line = `${bot.name.padEnd(8)} ${bot.now}`;
      if (bot.authorization === 'active') ui.ok(line);
      else ui.warn(`${line}  (github: ${bot.authorization})`);
    }

    // Which way the bridge decides who a request is from: the difference
    // matters and is otherwise invisible (docs/security.md).
    if (report.identity) {
      ui.heading('Identity');
      ui.plain(`    ${report.identity.detail}`);
    }
  } catch {
    ui.warn('the bridge is not answering, so there is no board to show');
  }
}

/**
 * Where a reached month is raised.
 *
 * The amounts in config/costs.yaml are the first start's seed. A later start
 * does not copy them back, so telling somebody to edit the file leaves the
 * cap that is actually stopping work where it was.
 */
export function spendCapRemedy(): string {
  return 'Raise the cap in Settings → Spending limits, or wait for the next period.';
}

/**
 * A path as one word for a POSIX shell. Doctor prints commands to paste, and a
 * home under "Application Support" split into two paths for `rm -rf`. Double
 * quotes would still expand `$` and backticks; single quotes expand nothing.
 */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Each bot's own mirrors (`repos/`) and repository homes (`homes/`) under the
 * work root, from before a task had a computer and a clone of its own. hostd
 * carries a paused task's commits and every set-aside out of them when it
 * starts, and leaves them for a release so nothing in them is lost to an
 * upgrade; after that they only take disk.
 */
export function oldSeatFolders(workRoot: string): string[] {
  if (!existsSync(workRoot)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['mirrors', 'slots', 'cache'].includes(entry.name)) continue;
    for (const part of ['repos', 'homes']) {
      const path = join(workRoot, entry.name, part);
      if (existsSync(path)) found.push(path);
    }
  }
  return found;
}

export async function doctor(config: InstallConfig): Promise<void> {
  let problems = 0;
  const fail = (message: string, hint?: string): void => {
    problems += 1;
    ui.fail(message);
    if (hint) ui.note(hint);
  };

  installHeading(config);

  ui.heading('Tools');
  const node = process.versions.node;
  if (Number(node.split('.')[0]) >= 22) ui.ok(`node ${node}`);
  else fail(`node ${node} is too old`, 'OpenADLC needs Node 22 or newer.');

  const git = await version('git', ['--version']);
  if (git) ui.ok(git);
  else fail('git is not installed', 'Bots clone and branch with git; it is required.');

  // The driver `up` would run with, which for an install.json naming none
  // depends on what this machine can run.
  const { driver } = (await upDriver(config)).config;
  say(tmuxLine(await version('tmux', ['-V']), driver), fail);

  const docker = await version('docker', ['--version']);
  for (const line of dockerLines(docker, driver, docker ? await dockerProbe.dockerAnswers() : false)) say(line, fail);

  ui.heading('Containment');
  await checkHostdAuthenticates(config, fail);
  if (homeIsOpen()) {
    fail(`${fleetHome()} can be read by others on this machine`, `It holds install.json and the logs: chmod 700 ${shellQuote(fleetHome())}, or run fleetadlc up, which does.`);
  }
  const leftovers = oldSeatFolders(process.env.FLEETADLC_WORK_ROOT ?? join(fleetHome(), 'work'));
  if (leftovers.length > 0) {
    ui.note(
      `${leftovers.length === 1 ? 'One folder' : `${leftovers.length} folders`} of the bots' own mirrors and homes ${leftovers.length === 1 ? 'is' : 'are'} from before each task had its own computer. ` +
        'hostd has carried paused work out of them; once no task paused before the upgrade is still waiting, delete them: ' +
        `rm -rf ${leftovers.map(shellQuote).join(' ')}`,
    );
  }

  ui.heading('Database');
  // Two different failures, reported separately. One `try` around both meant a
  // fresh install — server up, schema not applied yet — printed "postgres
  // answers" and "cannot reach postgres" one line apart, and sent the operator
  // to look at a database that was fine.
  let reachable = false;
  try {
    await waitForDatabase(3, 500);
    reachable = true;
    ui.ok('postgres answers');
  } catch {
    fail('cannot reach postgres', unreachableDatabaseHint(databaseInUse(config)));
  }

  // install.json alone says nothing under the compose stack.
  const { password, exposed } = await databaseContainerGaps(config, databaseInUse(config));
  if (password) fail(password.message, password.remedy);
  else ui.ok('the platform database url does not use the password published with OpenADLC');
  if (exposed) {
    ui.warn(exposed.message);
    ui.note(exposed.remedy);
  }

  if (reachable) {
    try {
      const hostList = await hosts.listHosts();
      // Only a host some bot is on can stop anything. A row nothing uses — an
      // older name for this machine, say — is said, not failed.
      const inUse = new Set((await bots.listBots()).map((bot) => bot.hostId).filter(Boolean));
      if (hostList.length === 0) ui.warn('no host has registered yet; start hostd');
      else
        for (const host of hostList) {
          const line = hostLine(host, inUse.has(host.id), Date.now());
          if (line.kind === 'ok') ui.ok(line.text);
          else if (line.kind === 'fail') fail(line.text);
          else ui.note(line.text);
        }
    } catch {
      // The expected state before the first `fleetadlc up`, so it is not a failure.
      ui.warn('the schema is not applied yet; `fleetadlc up` applies the migrations');
    }
  }

  ui.heading('GitHub');
  const crew = await bots.listBots().catch(() => []);
  const usable: string[] = [];
  const missing: string[] = [];
  let staticOnly = 0;

  for (const bot of crew) {
    const record = await credentials.getCredential(bot.id);
    const kind = await credentialKind(bot.name);
    if (record?.status === 'active' || kind) {
      usable.push(bot.name);
      if (kind === 'static') staticOnly += 1;
    } else {
      missing.push(bot.name);
    }
  }

  // Where the walkthrough keeps it, too; see `githubClientId`. Read here, so a
  // table that could not be read is told apart from one that has none.
  const storedClientId = reachable ? await settings.getSetting('githubClientId').catch(() => undefined) : undefined;
  say(
    clientIdLine({ clientId: await githubClientId(config, async () => storedClientId ?? null), storedRead: storedClientId !== undefined, staticOnly }),
    fail,
  );

  if (usable.length > 0) ui.ok(`${usable.length} of ${crew.length} accounts can act: ${usable.join(', ')}`);
  for (const name of missing) ui.warn(`${name} is not connected — fleetadlc auth login --bot ${name}`);
  if (crew.length > 0 && usable.length === 0) {
    fail('no bot can act as a GitHub account', 'fleetadlc auth login --all');
  }

  // A missing secret used to be silent, and on a reachable bridge that meant an
  // unsigned delivery answered a gate as whatever person it named. The bridge
  // now refuses those deliveries. Doctor says why, including when the address
  // is still local: an empty secret is not a configuration that skips the check.
  // The value itself is never printed; only whether one of the three stores has it.
  // Undefined when it could not be read, which is not the same as none stored.
  // The settings table is an older install's place for it, until the bridge
  // next starts and moves it into the secret store.
  const inStore = await getSecretStore()
    .get(webhookSecretRef())
    .catch(() => null);
  const read = inStore ?? (reachable ? await settings.getSetting('webhookSecret').catch(() => undefined) : undefined);
  const storedSecret = read ?? null;
  say(webhookSecretLine({ installSecret: config.webhookSecret, environmentSecret: process.env.FLEETADLC_WEBHOOK_SECRET, storedSecret: read }), fail);
  const mismatch = webhookSecretMismatch({
    installSecret: config.webhookSecret,
    environmentSecret: process.env.FLEETADLC_WEBHOOK_SECRET,
    storedSecret,
  });
  if (mismatch) {
    ui.warn(mismatch.message);
    ui.note(mismatch.remedy);
  }

  // A webhook that never arrives looks like nothing at all: the board stays
  // empty, no bot starts, and every component reports itself healthy. In a cloud
  // install this is the single most likely thing to be wrong, because the bridge
  // is not on the public internet and something has to carry GitHub to it.
  try {
    const delivery = await lastGithubDelivery();
    if (!delivery) {
      fail(
        'GitHub has never delivered anything to this install',
        'check the OpenADLC app’s webhook, on the app’s settings page: its URL is this bridge’s `/webhooks/github` (on a cloud install `fleetadlc cloud output` prints it), and the app’s Advanced tab shows each delivery and its response',
      );
    } else {
      const age = Date.now() - Date.parse(delivery.at);
      const hours = Math.round(age / 3_600_000);
      if (age > 24 * 3_600_000) {
        ui.warn(`the last GitHub delivery was ${hours} hours ago (${delivery.type})`);
        ui.note('quiet is normal on a quiet repository; silence for days usually means the webhook stopped');
      } else {
        ui.ok(`GitHub last delivered ${delivery.type}, ${hours < 1 ? 'less than an hour' : `${hours} hours`} ago`);
      }
    }
  } catch {
    ui.warn('could not read the event log, so the webhook was not checked');
  }

  // What only a person can do, proved by its effect: the same checks that put
  // a card on the board, run now rather than read from the last run.
  ui.heading('What OpenADLC cannot do for itself');
  problems += await bridgeProblems(config, fail);

  ui.heading('Spend');
  try {
    const budget = await costs.getBudget(costs.currentPeriod());
    if (!budget) ui.warn('no budget row for this month yet');
    else if (budget.state === 'stopped')
      fail(`the monthly cap is reached ($${budget.spentUsd.toFixed(2)} of $${budget.capUsd})`, spendCapRemedy());
    else ui.ok(`$${budget.spentUsd.toFixed(2)} of $${budget.capUsd.toFixed(0)} (${budget.state})`);
  } catch {
    ui.warn('could not read the ledger');
  }

  ui.plain();
  if (problems === 0) ui.ok('no problems found');
  else {
    ui.fail(`${counted(problems, 'problem')} ${problems === 1 ? 'needs' : 'need'} attention`);
    process.exitCode = 1;
  }

  await closePool();
}

/** Said of a check that needs the database, when it is down. */
const NOT_CHECKED = 'not checked: the database is unreachable';

/** One thing the doctor says: a pass, a failure with what to do, a warning, or a note. */
export interface DoctorLine {
  kind: 'ok' | 'fail' | 'warn' | 'note';
  text: string;
  hint?: string;
}

function say(line: DoctorLine, fail: (message: string, hint?: string) => void): void {
  if (line.kind === 'fail') return fail(line.text, line.hint);
  ui[line.kind](line.text);
  if (line.hint) ui.note(line.hint);
}

/**
 * The App's client id. `storedRead` is false when the settings table could
 * not be read: then a missing one is not known to be missing, and failing it
 * sent the operator to make the app again when only postgres was down.
 */
export function clientIdLine(input: { clientId: string | null; storedRead: boolean; staticOnly: number }): DoctorLine {
  if (input.clientId) return { kind: 'ok', text: `device-flow client id ${input.clientId.slice(0, 10)}…` };
  if (!input.storedRead) return { kind: 'note', text: `GitHub App client id: ${NOT_CHECKED}` };
  if (input.staticOnly > 0) {
    // A stored token works, but nothing can be re-authorized without a client id.
    return {
      kind: 'warn',
      text: 'no device-flow client id, so a bot whose token is revoked cannot be reconnected',
      hint: 'create the app in the console walkthrough, then fleetadlc auth login --bot <name>',
    };
  }
  return { kind: 'fail', text: 'no GitHub App client id', hint: `Create the app on ${stepNamed('app')} of the console walkthrough. The app needs device flow enabled.` };
}

/** The webhook secret, by `webhookTrustGap`. `storedSecret` is undefined when the settings table could not be read. */
export function webhookSecretLine(input: { installSecret: string; environmentSecret: string | undefined; storedSecret: string | null | undefined }): DoctorLine {
  const gap = webhookTrustGap({ ...input, storedSecret: input.storedSecret ?? null });
  if (!gap) return { kind: 'ok', text: 'a webhook secret is configured, so an unsigned delivery is refused' };
  if (input.storedSecret === undefined) return { kind: 'note', text: `webhook secret: ${NOT_CHECKED}` };
  return { kind: 'fail', text: gap.message, hint: gap.remedy };
}

/**
 * What the doctor says about tmux on this machine. Under the docker driver a
 * session runs tmux inside the bot's container, so a host without it is
 * fine, and was counted as a problem.
 */
export function tmuxLine(found: string | null, driver: 'local' | 'docker'): DoctorLine {
  if (found) return { kind: 'ok', text: found };
  if (driver === 'local') return { kind: 'fail', text: 'tmux is not installed', hint: 'The local driver runs every session and take-over in tmux on this machine.' };
  return { kind: 'note', text: 'tmux is not installed here; the docker driver runs it in the bot image' };
}

/**
 * What the doctor says about Docker and the driver. Under local it says what a
 * task can reach, as `up` does, as a warning and not a problem: it said
 * "no isolation between bots" when Docker was missing and nothing when it was
 * there, while every task could read the App's private key.
 *
 * `answers` is whether `docker info` succeeded. Installed and not running, the
 * version printed fine and the doctor said nothing, while no task could start.
 */
export function dockerLines(found: string | null, driver: 'local' | 'docker', answers = true): DoctorLine[] {
  if (!found && driver === 'docker') return [{ kind: 'fail', text: 'the docker driver is selected but docker is missing' }];
  const lines: DoctorLine[] = [];
  if (found && !answers) {
    lines.push(
      driver === 'docker'
        ? { kind: 'fail', text: `${DOCKER_NOT_RUNNING}, and the docker driver runs every task in it`, hint: START_DOCKER }
        : { kind: 'note', text: `${found}, but not running` },
    );
  } else if (found) lines.push({ kind: 'ok', text: found });
  if (driver === 'local') {
    lines.push({ kind: 'warn', text: found ? LOCAL_DRIVER_WARNING : `docker is not installed, so ${LOCAL_DRIVER_WARNING}` });
    for (const note of LOCAL_DRIVER_NOTES) lines.push({ kind: 'note', text: note });
  }
  return lines;
}

/**
 * What the doctor says about one host: reporting, stopped, or an old record.
 * Only a host some bot is on can stop anything; a row nothing uses — an older
 * name for this machine, which the seed once made as 'local' — is said, not
 * failed.
 */
export function hostLine(
  host: { name: string; driver: string; lastSeenAt: string | null },
  hasBots: boolean,
  now: number,
): { kind: 'ok' | 'fail' | 'note'; text: string } {
  const stale = host.lastSeenAt ? now - new Date(host.lastSeenAt).getTime() > 60_000 : true;
  if (!stale) return { kind: 'ok', text: `host ${host.name} (${host.driver}) is reporting` };
  if (hasBots) return { kind: 'fail', text: `host ${host.name} has not reported in the last minute` };
  return { kind: 'note', text: `host ${host.name} has no bots on it and has not reported recently; it is an old record` };
}
