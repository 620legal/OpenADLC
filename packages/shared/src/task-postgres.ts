/**
 * A Postgres server of a task's own, for a repository whose checks need one.
 *
 * A seat that runs checks (`sidecarDb`) gets a database and a plain role on
 * the host's shared task server (`openadlc-taskdb`). That is not enough for a
 * repository whose migrations create server-wide roles through an admin
 * connection, under fixed names, on the port its Makefile defaults to: a
 * managed repository's builders stopped at `ECONNREFUSED 127.0.0.1:55432`,
 * because a task's role on the shared server can create no role, and two
 * tasks making `app_rw` there at once would collide. So a person can give the
 * repository servers of its own, one set per task: each in the task's
 * computer's network namespace, listening on loopback at the port the
 * repository names, with the superuser, password and database its Makefile's
 * defaults name. Those are local-development defaults, and fine as such: the
 * server is reachable only from inside that one task's computer, and goes
 * with it.
 *
 * The setting is a person's, in Settings → Repositories (the bridge's
 * `/v1/repos/:name/task-postgres`, an admin's), never a file in the
 * repository: the crew writes the repository, and an image or a port the
 * crew chose would run beside every task.
 *
 * It also says where the task's `DATABASE_URL` comes from (`databaseUrl`).
 * A repository's Postgres suites can read it as their GitHub CI gives it, a
 * superuser's, to create and drop roles and databases of their own; local CI
 * runs `make ci` with what `make setup` had, so a builder cannot point it
 * anywhere itself. Given the shared server's URL, such suites stopped at
 * `permission denied to create role`, and given none they had nothing to
 * read. So the setting can name one of its own servers instead.
 */

/** What a task is told it has: `127.0.0.1:<port>` for each server, comma-separated, in the order the setting lists them. */
export const TASK_POSTGRES_ENV = 'OPENADLC_TASK_POSTGRES';

/** How many servers one task may be given; each is a container with its own memory and CPU. */
export const TASK_POSTGRES_MAX_SERVERS = 4;

export interface TaskPostgresServer {
  /** Where it listens in the task's computer, on loopback: the port the repository's Makefile defaults to. */
  port: number;
  /** The server's superuser, made with it (`POSTGRES_USER`). */
  superuser: string;
  /** The superuser's password: the repository's local-development default, as its URLs give it. */
  password: string;
  /** The database the server is made with (`POSTGRES_DB`). */
  database: string;
  /** What it runs: an image `isTaskPostgresImage` allows. */
  image: string;
}

/**
 * Where a task's `DATABASE_URL` comes from: `none`, so the Makefile's own
 * `?=` defaults apply; `shared`, its database on the shared server, a plain
 * role; or one of the setting's own servers, named by its port, as that
 * server's superuser (`postgres://<superuser>:<password>@127.0.0.1:<port>/<database>`,
 * which hostd builds where it puts the task's environment together). The
 * setting holds only the port, so its password stays where the server's
 * already is.
 */
export type TaskPostgresDatabaseUrl = 'none' | 'shared' | { port: number };

export interface TaskPostgresSetting {
  servers: TaskPostgresServer[];
  /**
   * `none` unless a person chose otherwise: a repository that has servers of
   * its own keeps its Makefile's defaults, and a `DATABASE_URL` from OpenADLC
   * overrides them (`?=`). A row from before the choice existed says
   * `sharedDatabase: true` for `shared`, and false or nothing for `none`.
   */
  databaseUrl: TaskPostgresDatabaseUrl;
}

/**
 * Who publishes the images a task's server may run: pgvector's, and Docker's
 * official `postgres`. Docker Hub names both, with or without its
 * `docker.io/` and `library/` prefixes. A server runs inside a task's
 * computer, beside its work, its token and its session, so it is never an
 * image the crew or a repository names.
 */
const TASK_POSTGRES_REPOSITORIES: Readonly<Record<string, string>> = {
  'pgvector/pgvector': 'pgvector/pgvector',
  'docker.io/pgvector/pgvector': 'pgvector/pgvector',
  postgres: 'postgres',
  'library/postgres': 'postgres',
  'docker.io/library/postgres': 'postgres',
  'docker.io/postgres': 'postgres',
};

/** The images, as a person reads them; `pgvector/pgvector:pg16` is one. */
export const TASK_POSTGRES_IMAGES: readonly string[] = ['pgvector/pgvector:<tag>', 'postgres:<tag>'];

/** Docker's own grammar for a tag, and a digest. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Whether an image is one a task's server may run: an allowed repository at a
 * tag, at a digest, or at both (`pgvector/pgvector:pg16@sha256:…`), which is
 * how to pin it. A bare name is refused: `latest` moves under every task.
 */
export function isTaskPostgresImage(image: string): boolean {
  const [named, digest, ...more] = image.split('@');
  if (more.length > 0 || !named) return false;
  if (digest !== undefined && !DIGEST.test(digest)) return false;
  const { repository, tag } = nameAndTag(named);
  if (!Object.hasOwn(TASK_POSTGRES_REPOSITORIES, repository)) return false;
  if (tag === null) return digest !== undefined;
  return TAG.test(tag);
}

/** An image's repository and tag, its digest left off: `pgvector/pgvector:pg16` is `pgvector/pgvector` at `pg16`. */
function nameAndTag(image: string): { repository: string; tag: string | null } {
  const named = image.split('@')[0] ?? '';
  const colon = named.lastIndexOf(':');
  if (colon > named.lastIndexOf('/')) return { repository: named.slice(0, colon), tag: named.slice(colon + 1) };
  return { repository: named, tag: null };
}

/**
 * Which allowed repository an image is from, whatever its tag: `postgres` for
 * `docker.io/library/postgres:16`, null for one outside the allowlist. Read
 * from a repository's Compose file, `postgres` with no tag is still Docker's
 * Postgres, which `isTaskPostgresImage` refuses until it has one.
 */
export function taskPostgresRepositoryOf(image: string): string | null {
  const { repository } = nameAndTag(image.trim());
  return Object.hasOwn(TASK_POSTGRES_REPOSITORIES, repository) ? (TASK_POSTGRES_REPOSITORIES[repository] ?? null) : null;
}

/**
 * What a save says of an image a task's server may not run, naming it as
 * `named` (the image, or which server's image it is when it is empty); null
 * for one it may run. The Compose reader says the same of an image it found,
 * so a person sees the refusal before pressing Save, not after.
 */
export function taskPostgresImageRefusal(image: string, named: string = image): string | null {
  if (isTaskPostgresImage(image)) return null;
  return (
    `${named} is not an image a task's server may run: use ${TASK_POSTGRES_IMAGES.join(' or ')}, ` +
    'such as pgvector/pgvector:pg16, and pin it by adding @sha256:<digest> (docker buildx imagetools inspect <image> prints it)'
  );
}

/** A Postgres name a server can be made with unquoted: what `POSTGRES_USER` and `POSTGRES_DB` are. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
/** Printable ASCII: it is passed to the image as an environment variable, and typed into URLs. */
const PASSWORD = /^[\x20-\x7e]{1,100}$/;

/**
 * What to give for a field left empty. An empty field is refused as empty:
 * one refused as out of range read as though something had been typed, and
 * a person who took the form's examples for values pressed Save on a port
 * that was not there (v0.1.9).
 */
const MISSING: Readonly<Record<keyof TaskPostgresServer, string>> = {
  port: "give the port the repository's Makefile reaches it on",
  superuser: "give the superuser the repository's own database URLs log in as",
  password: "give its superuser's password, as the repository's own database URLs give it",
  database: "give the database the repository's own database URLs name",
  image: `use ${TASK_POSTGRES_IMAGES.join(' or ')}, such as pgvector/pgvector:pg16`,
};

/** Nothing given: absent, or what an empty field sends. A password is not trimmed, so only `''` is empty there. */
function missing(field: keyof TaskPostgresServer, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && (field === 'password' ? value === '' : value.trim() === '');
}

export type TaskPostgresRead = { ok: true; setting: TaskPostgresSetting | null } | { ok: false; error: string };

/**
 * A setting as a person sent it, or as the repository's row holds it, checked
 * whole: null for none (no servers), or the first thing wrong with it, saying
 * what to do. hostd reads the row through this again at each task start, so a
 * row written by hand or by an older bridge is held to the same rules.
 */
export function parseTaskPostgres(input: unknown): TaskPostgresRead {
  if (input === null || input === undefined) return { ok: true, setting: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: "the setting is { servers: [{ port, superuser, password, database, image }], databaseUrl: 'none' | 'shared' | { port } }; send { servers: [] } to turn it off" };
  }
  const raw = input as { servers?: unknown; databaseUrl?: unknown; sharedDatabase?: unknown };
  const choice = databaseUrlOf(raw);
  if (!choice.ok) return choice;
  if (!Array.isArray(raw.servers)) {
    return { ok: false, error: 'servers is a list of servers, each { port, superuser, password, database, image }; an empty list turns it off' };
  }
  if (raw.servers.length > TASK_POSTGRES_MAX_SERVERS) {
    return { ok: false, error: `a task can have at most ${TASK_POSTGRES_MAX_SERVERS} servers of its own; each is a container beside it, with memory and CPU of its own` };
  }
  const servers: TaskPostgresServer[] = [];
  for (const [index, entry] of raw.servers.entries()) {
    const which = `server ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: `${which} is { port, superuser, password, database, image }` };
    const server = entry as Record<string, unknown>;
    const none = (field: keyof TaskPostgresServer): TaskPostgresRead => ({ ok: false, error: `${which} has no ${field}: ${MISSING[field]}` });
    if (missing('port', server.port)) return none('port');
    const port = typeof server.port === 'string' && /^\d+$/.test(server.port.trim()) ? Number(server.port.trim()) : server.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, error: `${which}'s port is a whole number from 1024 to 65535: the port the repository's Makefile reaches it on, such as 55432` };
    }
    if (servers.some((other) => other.port === port)) {
      return { ok: false, error: `two servers cannot both listen on ${port} in one task's computer: give each a port of its own` };
    }
    for (const field of ['superuser', 'database'] as const) {
      const value = server[field];
      if (missing(field, value)) return none(field);
      if (typeof value !== 'string' || !IDENTIFIER.test(value.trim())) {
        return { ok: false, error: `${which}'s ${field} is a Postgres name: lower-case letters, digits and _, starting with a letter or _, at most 63 of them` };
      }
    }
    if (missing('password', server.password)) return none('password');
    if (typeof server.password !== 'string' || !PASSWORD.test(server.password)) {
      return { ok: false, error: `${which} needs its superuser's password, as the repository's own database URLs give it: 1 to 100 printable characters` };
    }
    if (missing('image', server.image)) return none('image');
    const image = typeof server.image === 'string' ? server.image.trim() : '';
    const refused = taskPostgresImageRefusal(image, image || `${which}'s image`);
    if (refused) return { ok: false, error: refused };
    servers.push({ port, superuser: (server.superuser as string).trim(), password: server.password, database: (server.database as string).trim(), image });
  }
  const databaseUrl = choice.databaseUrl;
  if (typeof databaseUrl === 'object' && !servers.some((server) => server.port === databaseUrl.port)) {
    const ports = servers.map((server) => server.port).join(', ');
    return {
      ok: false,
      error:
        servers.length === 0
          ? `DATABASE_URL is to come from the server on ${databaseUrl.port}, and there are no servers: add that server, or send databaseUrl 'none'`
          : `DATABASE_URL is to come from the server on ${databaseUrl.port}, and none of the servers listens there: name one of theirs (${ports}), or send databaseUrl 'shared' or 'none'`,
    };
  }
  if (servers.length === 0) return { ok: true, setting: null };
  return { ok: true, setting: { servers, databaseUrl } };
}

const DATABASE_URL_SHAPE =
  "databaseUrl is 'none', 'shared' or { port }: no DATABASE_URL, the task's database on the shared server, or the superuser's on the server listening on that port";

/**
 * Where `DATABASE_URL` comes from, as sent or stored. `sharedDatabase` is how
 * a row said it before there was a choice of server, and still reads as it
 * did; sent beside `databaseUrl` the two could say different things, so only
 * one is taken.
 */
function databaseUrlOf(raw: { databaseUrl?: unknown; sharedDatabase?: unknown }): { ok: true; databaseUrl: TaskPostgresDatabaseUrl } | { ok: false; error: string } {
  if (raw.sharedDatabase !== undefined && typeof raw.sharedDatabase !== 'boolean') {
    return { ok: false, error: 'sharedDatabase is true or false: whether each task also gets a database on the shared server as DATABASE_URL' };
  }
  if (raw.databaseUrl === undefined) return { ok: true, databaseUrl: raw.sharedDatabase === true ? 'shared' : 'none' };
  if (raw.sharedDatabase !== undefined) {
    return { ok: false, error: "send databaseUrl alone: sharedDatabase is the older way to say databaseUrl 'shared', and the two can disagree" };
  }
  if (raw.databaseUrl === 'none' || raw.databaseUrl === 'shared') return { ok: true, databaseUrl: raw.databaseUrl };
  if (raw.databaseUrl && typeof raw.databaseUrl === 'object' && !Array.isArray(raw.databaseUrl)) {
    const given = (raw.databaseUrl as { port?: unknown }).port;
    const port = typeof given === 'string' && /^\d+$/.test(given.trim()) ? Number(given.trim()) : given;
    if (typeof port === 'number' && Number.isInteger(port)) return { ok: true, databaseUrl: { port } };
  }
  return { ok: false, error: DATABASE_URL_SHAPE };
}

/** The server whose superuser a task's `DATABASE_URL` logs in as; null when it is the shared server's or there is none. */
export function databaseUrlServer(setting: TaskPostgresSetting | null): TaskPostgresServer | null {
  const choice = setting?.databaseUrl;
  if (!setting || typeof choice !== 'object') return null;
  return setting.servers.find((server) => server.port === choice.port) ?? null;
}

/** What a task is told, as `TASK_POSTGRES_ENV` says it: where each server listens in its computer. */
export function taskPostgresAddresses(servers: readonly Pick<TaskPostgresServer, 'port'>[]): string[] {
  return servers.map((server) => `127.0.0.1:${server.port}`);
}

/** The setting with its passwords left out, for the audit log and anything else that is read by more than the admins. */
export function withoutPasswords(setting: TaskPostgresSetting | null): unknown {
  if (!setting) return null;
  return { ...setting, servers: setting.servers.map(({ password: _password, ...rest }) => rest) };
}
