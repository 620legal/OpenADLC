import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_PORTS } from '@fleetadlc/shared';
import { fleetHome } from '@fleetadlc/github';

const run = promisify(execFile);

export interface InstallConfig {
  /** `local` runs everything on this machine; `docker` runs each task in its own container. */
  driver: 'local' | 'docker';
  organization: string;
  /** Client id of the OpenADLC GitHub App, with device flow enabled. */
  githubClientId: string;
  databaseUrl: string;
  ports: { console: number; bridge: number; hostd: number; postgres: number };
  humans: string[];
  repoRoot: string;
  /** Where GitHub can reach this bridge, for the webhook. */
  publicUrl: string;
  /**
   * The secret GitHub signs webhook deliveries with.
   *
   * It lives here because it has to survive a restart. The bridge reads
   * `FLEETADLC_WEBHOOK_SECRET` from its environment and refuses every delivery when
   * that value is empty — it does not skip the check. An operator who exported
   * the secret in one shell and later restarted from another would otherwise
   * have an install that accepts nothing from GitHub until this file supplies
   * it again. `fleetadlc init` generates one rather than leaving it empty.
   */
  webhookSecret: string;
  /**
   * Which bot is the automation account — the one that writes labels,
   * assignments, reviewer requests and statuses — when it is not the bot whose
   * role is `automation`. A seat or a name; unset on a new install, because
   * the role is the answer. Older installs have `flow` here, which is read as
   * the seat that persona was.
   */
  automationBotName?: string;
  /**
   * Names people open OpenADLC under beyond loopback, an address, and the
   * configured URLs: a LAN hostname, a tunnel to the console. The bridge and
   * the console refuse any other `Host` (docs/security.md). Kept here, not
   * only exported, so a `fleetadlc up` from another shell keeps them.
   */
  allowedHosts?: string[];
}

/**
 * `allowedHosts` as the services read it. The file is written by hand, and
 * `"allowedHosts": "mybox.lan"` is as clear as a list, so a string is taken
 * as one; anything else is refused with what to write, rather than crashing
 * `fleetadlc up` on a `.join` it does not have.
 */
export function allowedHostsOf(config: Pick<InstallConfig, 'allowedHosts'>): string {
  const value: unknown = config.allowedHosts;
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(',');
  throw new Error(
    `"allowedHosts" in ${configPath()} must be a list of names, e.g. "allowedHosts": ["mybox.lan"]`,
  );
}

export function configPath(): string {
  return join(fleetHome(), 'install.json');
}

function defaultDatabaseUrl(port: number): string {
  return `postgres://fleetadlc:fleetadlc@127.0.0.1:${port}/fleetadlc_db`;
}

export function defaultConfig(repoRoot: string): InstallConfig {
  return {
    driver: 'local',
    organization: '',
    githubClientId: '',
    databaseUrl: defaultDatabaseUrl(DEFAULT_PORTS.postgres),
    ports: {
      console: DEFAULT_PORTS.console,
      bridge: DEFAULT_PORTS.bridge,
      hostd: DEFAULT_PORTS.hostd,
      postgres: DEFAULT_PORTS.postgres,
    },
    humans: [],
    repoRoot,
    publicUrl: '',
    webhookSecret: '',
  };
}

/**
 * `driver` as hostd is to read it: `docker` or `local`, in any case. Anything
 * else is refused with what to write. hostd used to take any other value as
 * `local`, the driver with no isolation, and a typo here ran every session on
 * the host.
 */
export function driverOf(config: Pick<InstallConfig, 'driver'>): InstallConfig['driver'] {
  const value: unknown = config.driver;
  const driver = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (driver === 'local' || driver === 'docker') return driver;
  throw new Error(`"driver" in ${configPath()} is ${JSON.stringify(value)}; write "driver": "docker" or "driver": "local"`);
}

/**
 * The driver install.json itself names, or undefined when it names none or
 * there is no file. `loadConfig` fills a missing one with `local`, so a choice
 * someone made and a default nobody made looked the same.
 */
export function storedDriver(): InstallConfig['driver'] | undefined {
  const path = configPath();
  if (!existsSync(path)) return undefined;
  const stored = readInstallJson(path) as Partial<InstallConfig>;
  return stored.driver === undefined ? undefined : driverOf(stored as Pick<InstallConfig, 'driver'>);
}

/** The image each bot's container runs; hostd reads the same variable. */
export function botImage(): string {
  return process.env.FLEETADLC_BOT_IMAGE ?? 'fleetadlc-bot:latest';
}

/** What choosing a driver asks of this machine; the tests answer without Docker. */
export interface DriverProbe {
  /** Whether `docker info` succeeds: the daemon is running and this user may use it. */
  dockerAnswers(): Promise<boolean>;
  /** Whether `botImage()` is on this machine. */
  botImagePresent(): Promise<boolean>;
}

export const dockerProbe: DriverProbe = {
  dockerAnswers: async () =>
    run('docker', ['info'], { timeout: 10_000 }).then(
      () => true,
      () => false,
    ),
  botImagePresent: async () =>
    run('docker', ['image', 'inspect', botImage()], { timeout: 10_000 }).then(
      () => true,
      () => false,
    ),
};

/**
 * The driver for an install that names none: `docker` when Docker answers and
 * the bot image is here, `local` otherwise, and why.
 *
 * Every new install used to get `local`, under which each task runs as the
 * operator's user and can read the secret store, and nothing said so. The image
 * is required as well as Docker: `up` refuses the docker driver without it, so
 * choosing docker on Docker alone would turn a bare `up` that worked into one
 * that fails.
 */
export async function chooseDriver(probe: DriverProbe = dockerProbe): Promise<{ driver: InstallConfig['driver']; reason: string }> {
  if (!(await probe.dockerAnswers())) return { driver: 'local', reason: 'Docker is not answering on this machine (docker info failed)' };
  if (!(await probe.botImagePresent())) {
    return { driver: 'local', reason: `Docker answers, but the bot image ${botImage()} is not on this machine` };
  }
  return { driver: 'docker', reason: `Docker answers and the bot image ${botImage()} is here` };
}

/** What a task under the local driver can reach: `up` and `doctor` print it. */
export const LOCAL_DRIVER_WARNING =
  'the local driver runs each task as this user on this machine: a task can read the secret store ' +
  '(the GitHub App’s private key, every bot’s sign-in, the model keys) and install.json ' +
  '(the database password, the webhook secret), and can run anything here';

/** How to stop being on the local driver, as notes under that warning. */
export const LOCAL_DRIVER_NOTES = [
  'use the local driver only with a throwaway App, accounts and repositories',
  'to give each task a container of its own: infra/local/build-bot-image.sh, then fleetadlc init --driver docker',
] as const;

export function loadConfig(repoRoot: string): InstallConfig {
  const path = configPath();
  if (!existsSync(path)) return defaultConfig(repoRoot);
  return storedConfig(readInstallJson(path), defaultConfig(repoRoot));
}

/**
 * install.json, parsed. The file is edited by hand, and a trailing comma
 * stopped every command with JSON.parse's words alone, which do not say which
 * file they are about.
 */
function readInstallJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${path} is not valid JSON (${error.message}): fix it, or move it aside`);
  }
}

/** A key of install.json that cannot be used, with what to write instead. */
function badKey(key: string, value: unknown, write: string): Error {
  return new Error(`"${key}" in ${configPath()} is ${JSON.stringify(value)}; write ${write}`);
}

/**
 * install.json over the defaults, key by key, each checked.
 *
 * The file is edited by hand, as the README says, and it was merged one level
 * deep and never checked: `"ports": {"console": 3001}` left the other ports
 * undefined, so `up` polled `127.0.0.1:undefined` and gave Docker
 * `-p undefined:5432`, and `"humans": "alice"` made every command, `help`
 * included, die on `.join`. A key that cannot be used now stops the command
 * with its name, the file, and what to write.
 */
function storedConfig(stored: unknown, defaults: InstallConfig): InstallConfig {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error(`${configPath()} is not a JSON object; write {"driver": "local"} or delete it and run fleetadlc init`);
  }
  const file = stored as Record<string, unknown>;

  if (file.ports !== undefined && file.ports !== null && (typeof file.ports !== 'object' || Array.isArray(file.ports))) {
    throw badKey('ports', file.ports, `only the ports to change, e.g. "ports": {"console": ${DEFAULT_PORTS.console}}`);
  }
  const ports = { ...defaults.ports, ...((file.ports as Partial<InstallConfig['ports']> | null | undefined) ?? {}) };
  for (const [name, port] of Object.entries(ports)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw badKey(`ports.${name}`, port, `a port from 1 to 65535, e.g. "ports": {"${name}": ${(defaults.ports as Record<string, number>)[name] ?? 47300}}`);
    }
  }

  // A string key written as null reads as its default.
  const text = (key: 'organization' | 'githubClientId' | 'publicUrl' | 'webhookSecret' | 'databaseUrl', fallback: string): string => {
    const value = file[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string') return value;
    throw badKey(key, value, `a string, e.g. "${key}": ""`);
  };

  const humans = humansOf(file.humans);
  const config: InstallConfig = {
    ...defaults,
    ...(file as Partial<InstallConfig>),
    organization: text('organization', defaults.organization),
    githubClientId: text('githubClientId', defaults.githubClientId),
    publicUrl: text('publicUrl', defaults.publicUrl),
    webhookSecret: text('webhookSecret', defaults.webhookSecret),
    // `init` writes one, so an existing install's url stays as written; one
    // with none follows the postgres port it names.
    databaseUrl: text('databaseUrl', defaultDatabaseUrl(ports.postgres)),
    ports,
    humans,
  };
  return { ...config, driver: driverOf(config) };
}

/** `humans` as one name, names separated by commas, or a list of names. */
function humansOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value) && value.every((name) => typeof name === 'string')) return value;
  throw badKey('humans', value, 'a list of GitHub logins, e.g. "humans": ["alice"]');
}

/**
 * A signing key for an install that does not have one yet.
 *
 * An existing secret is kept: rotating it here would make GitHub and the bridge
 * disagree until somebody pasted the new value in both places. The generated
 * value is returned to the caller that stores it. Nothing in here prints it.
 */
export function ensureWebhookSecret(config: InstallConfig): { config: InstallConfig; generated: boolean } {
  if (config.webhookSecret.length > 0) return { config, generated: false };
  return {
    config: { ...config, webhookSecret: randomBytes(32).toString('hex') },
    generated: true,
  };
}

/**
 * The platform database's password before each install had its own. It is in
 * this repository and its docs, so it keeps nobody out: a database that still
 * takes it takes a superuser login from anything that reaches its port, a
 * task's computer through `host.docker.internal` included.
 */
export const PUBLISHED_DATABASE_PASSWORD = 'fleetadlc';

/**
 * The superuser an install from before the rename was created with. The
 * password is the same word as the user, and it is printed in the old
 * release's docs. Rotation used to recognise only `fleetadlc`, so `up` left
 * this one in place and `doctor` reported the url as fine.
 */
export const LEGACY_DATABASE_USER = 'fleet';
export const LEGACY_DATABASE_PASSWORD = 'fleet';

/** The user, password and database a database url names, decoded; null when it is not a url. */
export function databaseCredentials(databaseUrl: string): { user: string; password: string; database: string } | null {
  try {
    const url = new URL(databaseUrl);
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    };
  } catch {
    return null;
  }
}

export function hasPublishedDatabasePassword(databaseUrl: string): boolean {
  const credentials = databaseCredentials(databaseUrl);
  if (!credentials) return false;
  if (credentials.password === PUBLISHED_DATABASE_PASSWORD) return true;
  return credentials.user === LEGACY_DATABASE_USER && credentials.password === LEGACY_DATABASE_PASSWORD;
}

/**
 * A database password of this install's own, in place of the published one.
 *
 * `defaultConfig` keeps the published one, as the mark of "none generated
 * yet": it is called on every load, and a random value there would be a
 * different password each time. Any other password is kept. Hex needs no
 * escaping in a url or in `ALTER ROLE`. Nothing in here prints it.
 */
export function ensureDatabasePassword(config: InstallConfig): { config: InstallConfig; generated: boolean } {
  if (!hasPublishedDatabasePassword(config.databaseUrl)) return { config, generated: false };
  const url = new URL(config.databaseUrl);
  url.password = randomBytes(32).toString('hex');
  return { config: { ...config, databaseUrl: url.toString() }, generated: true };
}

/** Where the webhook secret an install ended up with came from. */
export type WebhookSecretSource = 'install' | 'stored' | 'environment' | 'generated';

/**
 * The webhook secret this install already has, or a new one when it has none.
 *
 * "Already has" is any place a running bridge could be verifying against: this
 * file, the secret store (or an older install's settings table), or
 * `FLEETADLC_WEBHOOK_SECRET`, which is where the self-hosting guide has an
 * operator put the value they gave GitHub. The store is looked at before the
 * environment because the bridge prefers it. Generating a secret over any of
 * them made GitHub and the bridge disagree, and storing it beat the
 * environment's — so every real delivery was refused while `fleetadlc doctor`
 * said a secret existed.
 *
 * Only a generated secret is stored. The one settled on is returned in the
 * config for the caller to save; nothing here prints it.
 */
export async function settleWebhookSecret(
  config: InstallConfig,
  from: {
    environment: string | undefined;
    stored: () => Promise<string | null>;
    store: (secret: string) => Promise<void>;
  },
): Promise<{ config: InstallConfig; source: WebhookSecretSource }> {
  if (config.webhookSecret.length > 0) return { config, source: 'install' };

  const stored = await from.stored().catch(() => null);
  if (stored) return { config: { ...config, webhookSecret: stored }, source: 'stored' };

  const environment = from.environment ?? '';
  if (environment.length > 0) return { config: { ...config, webhookSecret: environment }, source: 'environment' };

  const ensured = ensureWebhookSecret(config);
  // A failure means the database is not up; the install file still carries the
  // secret into the bridge's environment on the next `fleetadlc up`. The error is
  // discarded rather than shown, because a driver might quote the value.
  await from.store(ensured.config.webhookSecret).catch(() => undefined);
  return { config: ensured.config, source: 'generated' };
}

export function saveConfig(config: InstallConfig): string {
  const path = configPath();
  mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * A database url with its password replaced by `***`, for a line an operator
 * reads. Parsed rather than matched, so a password with an `@` in it, or one
 * given as `?password=`, is masked too.
 */
export function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.searchParams.has('password')) parsed.searchParams.set('password', '***');
    return parsed.toString();
  } catch {
    return '(a url that could not be read)';
  }
}

/**
 * An exported DATABASE_URL that is not the one install.json names, masked;
 * null when they agree, nothing is exported, or there is no install.json
 * (`config` null). `main` fills only what the shell has not set, so a stale
 * export from a scratch install beat install.json for the commands that open
 * the database in this process, while `up` gave the services install.json's:
 * a restore wrote settings to one database and secrets to another. Without
 * install.json the environment is all there is — the compose stack and the
 * cloud host set it that way — so it is used as before.
 */
export function databaseUrlConflict(
  config: Pick<InstallConfig, 'databaseUrl'> | null,
  env: NodeJS.ProcessEnv,
): { shell: string; install: string } | null {
  const exported = env.DATABASE_URL;
  if (!config || !exported || exported === config.databaseUrl) return null;
  return { shell: maskDatabaseUrl(exported), install: maskDatabaseUrl(config.databaseUrl) };
}

export function databaseConflictMessage(conflict: { shell: string; install: string }, home = fleetHome()): string {
  return `DATABASE_URL in this shell is ${conflict.shell}, but the install at ${home} uses ${conflict.install}. Run: unset DATABASE_URL`;
}

/** The environment every OpenADLC process is started with. */
export function serviceEnv(config: InstallConfig): Record<string, string> {
  return {
    DATABASE_URL: config.databaseUrl,
    FLEETADLC_CONFIG_ROOT: join(config.repoRoot, 'config'),
    FLEETADLC_SKILLS_ROOT: join(config.repoRoot, 'crew', 'skills'),
    FLEETADLC_ROLES_ROOT: join(config.repoRoot, 'crew', 'roles'),
    FLEETADLC_BRIDGE_PORT: String(config.ports.bridge),
    FLEETADLC_BRIDGE_URL: `http://127.0.0.1:${config.ports.bridge}`,
    FLEETADLC_HOSTD_PORT: String(config.ports.hostd),
    FLEETADLC_HOSTD_URL: `http://127.0.0.1:${config.ports.hostd}`,
    FLEETADLC_CONSOLE_PORT: String(config.ports.console),
    FLEETADLC_HOSTD_DRIVER: config.driver,
    // These four only when install.json has them, as the webhook secret below:
    // `fleetadlc github` tells an operator to export FLEETADLC_HUMANS, and an
    // empty value here replaced it, so the bridge started seeing nobody.
    ...(config.organization ? { FLEETADLC_GITHUB_ORG: config.organization } : {}),
    ...(config.githubClientId ? { FLEETADLC_GITHUB_CLIENT_ID: config.githubClientId } : {}),
    // Only when an install names one; the bridge finds the automation bot by
    // its role otherwise.
    ...(config.automationBotName ? { FLEETADLC_AUTOMATION_BOT: config.automationBotName } : {}),
    ...(config.publicUrl ? { FLEETADLC_PUBLIC_URL: config.publicUrl } : {}),
    // Only when set. This is merged over `process.env`, so an empty value here
    // would overwrite a secret the operator exported by hand. The bridge refuses
    // deliveries when no secret is configured; it does not skip the check.
    ...(config.webhookSecret ? { FLEETADLC_WEBHOOK_SECRET: config.webhookSecret } : {}),
    ...(config.humans.length > 0 ? { FLEETADLC_HUMANS: config.humans.join(',') } : {}),
    // Only when set, so a value exported by hand is not overwritten with nothing.
    ...(allowedHostsOf(config) ? { FLEETADLC_ALLOWED_HOSTS: allowedHostsOf(config) } : {}),
    // Integration suites only. `FLEETADLC_SCRIPTED_ENGINES` is never written by
    // `fleetadlc init` or stored in install.json — it has to be exported by hand,
    // which is the point: an operator cannot arrive at a fabricating install by
    // following any documented path.
    ...(process.env.FLEETADLC_SCRIPTED_ENGINES === '1'
      ? {
          FLEETADLC_SCRIPTED_ENGINES: '1',
          FLEETADLC_SCRIPTED_REPO_PATH: join(fleetHome(), 'scripted', 'testbed'),
        }
      : {}),
  };
}

/** Whether the home is open to anyone but its owner; null when there is none yet. */
export function homeIsOpen(home = fleetHome()): boolean | null {
  if (!existsSync(home)) return null;
  return (statSync(home).mode & 0o077) !== 0;
}

/**
 * Makes the home its owner's alone, as docs/configuration.md says it is, and
 * says whether it had to. `mkdirSync`'s mode does nothing to a folder that is
 * already there, so a home an older CLI made 0755 stayed that way.
 */
export function makeHomePrivate(home = fleetHome()): boolean {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!homeIsOpen(home)) return false;
  chmodSync(home, 0o700);
  return true;
}

export function runtimeDir(): string {
  // The home holds install.json and the file secret store, and run/ the
  // services' logs: neither is for anyone else on the machine. `status`, `logs`
  // or `down` before `init` used to make the home 0755.
  mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
  const dir = join(fleetHome(), 'run');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
