/**
 * A Postgres server of a task's own, for a repository whose checks need one.
 *
 * A seat that runs checks (`sidecarDb`) gets a database and a plain role on
 * the host's shared task server (`openadlc-taskdb`). That is not enough for a
 * repository whose migrations create server-wide roles through an admin
 * connection, under fixed names, on the port its Makefile defaults to:
 * 620legal/core's builders stopped at `ECONNREFUSED 127.0.0.1:55432`, because
 * a task's role on the shared server can create no role, and two tasks making
 * `core_rw` there at once would collide. So a person can give the repository
 * servers of its own, one set per task: each in the task's computer's network
 * namespace, listening on loopback at the port the repository names, with the
 * superuser, password and database its Makefile's defaults name. Those are
 * local-development defaults, and fine as such: the server is reachable only
 * from inside that one task's computer, and goes with it.
 *
 * The setting is a person's, in Settings → Repositories (the bridge's
 * `/v1/repos/:name/task-postgres`, an admin's), never a file in the
 * repository: the crew writes the repository, and an image or a port the
 * crew chose would run beside every task.
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

export interface TaskPostgresSetting {
  servers: TaskPostgresServer[];
  /**
   * Whether the task also gets its database on the shared server, as
   * `DATABASE_URL`. Off by default: a repository that has servers of its own
   * keeps its Makefile's defaults, and a `DATABASE_URL` from OpenADLC would
   * override them (`?=`) with a role that cannot do what its migrations do.
   */
  sharedDatabase: boolean;
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

/** The images, as a person reads them; `pgvector/pgvector:pg16` is what 620legal/core runs. */
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
  const colon = named.lastIndexOf(':');
  const repository = colon > named.lastIndexOf('/') ? named.slice(0, colon) : named;
  const tag = colon > named.lastIndexOf('/') ? named.slice(colon + 1) : null;
  if (!(repository in TASK_POSTGRES_REPOSITORIES)) return false;
  if (tag === null) return digest !== undefined;
  return TAG.test(tag);
}

/** A Postgres name a server can be made with unquoted: what `POSTGRES_USER` and `POSTGRES_DB` are. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
/** Printable ASCII: it is passed to the image as an environment variable, and typed into URLs. */
const PASSWORD = /^[\x20-\x7e]{1,100}$/;

/**
 * What to give for a field left empty. An empty field is refused as empty:
 * one refused as out of range read as though something had been typed, and
 * a person who took the form's examples for values pressed Save on a port
 * that was not there (620legal/core, v0.1.9).
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
    return { ok: false, error: 'the setting is { servers: [{ port, superuser, password, database, image }], sharedDatabase }; send { servers: [] } to turn it off' };
  }
  const raw = input as { servers?: unknown; sharedDatabase?: unknown };
  if (raw.sharedDatabase !== undefined && typeof raw.sharedDatabase !== 'boolean') {
    return { ok: false, error: 'sharedDatabase is true or false: whether each task also gets a database on the shared server as DATABASE_URL' };
  }
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
      return { ok: false, error: `${which}'s port is a whole number from 1024 to 65535: the port the repository's Makefile reaches it on (55432 for 620legal/core)` };
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
    if (!isTaskPostgresImage(image)) {
      return {
        ok: false,
        error:
          `${image || `${which}'s image`} is not an image a task's server may run: use ${TASK_POSTGRES_IMAGES.join(' or ')}, ` +
          'such as pgvector/pgvector:pg16, and pin it by adding @sha256:<digest> (docker buildx imagetools inspect <image> prints it)',
      };
    }
    servers.push({ port, superuser: (server.superuser as string).trim(), password: server.password, database: (server.database as string).trim(), image });
  }
  if (servers.length === 0) return { ok: true, setting: null };
  return { ok: true, setting: { servers, sharedDatabase: raw.sharedDatabase === true } };
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
