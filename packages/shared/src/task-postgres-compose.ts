import { parse as parseYaml } from 'yaml';
import { TASK_POSTGRES_MAX_SERVERS, taskPostgresImageRefusal, taskPostgresRepositoryOf, type TaskPostgresServer } from './task-postgres.js';

/**
 * A repository's Postgres servers for its tasks, as its own Compose file
 * starts them on a laptop: what Settings → Repositories → "Postgres for its
 * tasks" fills in for a person to confirm, rather than type.
 *
 * On v0.1.10 a person opened that form for 620legal/core, saw only examples,
 * pressed Save and was told "server 1 has no port", while every value it
 * wanted was in core's docker-compose.yml: `pgvector/pgvector:pg16`,
 * `55432:5432`, and `core`, `core`, `core_db` as `POSTGRES_USER`,
 * `POSTGRES_PASSWORD` and `POSTGRES_DB`.
 *
 * The file comes from GitHub, so it is data: it is read, never run and never
 * saved from. What it suggests reaches the setting only when a person presses
 * Save, and is checked then as anything typed is (`parseTaskPostgres`). An
 * image outside the allowlist is suggested as the file writes it, with what
 * Save would say of it, rather than swapped for one that is allowed.
 */

/** The names Compose looks for in a project's directory, in the order it takes the first it finds. */
export const COMPOSE_FILES: readonly string[] = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

/** A field of the form a note is about, or null for the server as a whole. */
export type ComposeNoteField = keyof TaskPostgresServer | null;

/** One server a Compose file starts, as the form is filled with it. */
export interface ComposePostgresServer {
  /** The Compose service it is. */
  service: string;
  /** The host side of its port mapping, which is where the repository's URLs reach it; null when the file publishes none. */
  port: number | null;
  /** `POSTGRES_USER`, else the image's default, `postgres`; empty when the file leaves it to something not read here. */
  superuser: string;
  /** `POSTGRES_PASSWORD`; empty when the file does not give it, which the image has no default for. */
  password: string;
  /** `POSTGRES_DB`, else the image's default, its superuser's name. */
  database: string;
  /** As the file writes it, a default it gives a variable taken. Not pinned: what a host already has is not known here. */
  image: string;
  /** What was taken as a default, and what is still to be given, by the field it is about. */
  notes: { field: ComposeNoteField; text: string }[];
  /** What a save would say of its image, when the allowlist refuses it; null when it allows it. */
  refusal: string | null;
}

export type ComposePostgresRead =
  | { ok: true; servers: ComposePostgresServer[]; notes: string[] }
  | { ok: false; why: string };

type Fields = Record<string, unknown>;
const isMap = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The port Postgres listens on in its container, unless told otherwise. */
const POSTGRES_PORT = '5432';

/**
 * An image that is a Postgres server to the eye, allowed or not: the allowed
 * repositories at any tag, and the images that are Postgres under another
 * publisher. Those are suggested with the refusal, so a person sees why the
 * service they run was not taken as it is.
 */
function isPostgresImage(image: string): boolean {
  if (taskPostgresRepositoryOf(image) !== null) return true;
  const repository = (image.trim().split('@')[0] ?? '').replace(/:[^/:]*$/, '').toLowerCase();
  // The name itself, not one that has it in it: `postgres-exporter` reads a server, and is not one.
  return /^(postgres|postgresql|pgvector|postgis|timescaledb)(-ha|-repmgr)?$/.test(repository.split('/').pop() ?? '');
}

/**
 * The servers a Compose file starts, from its text: one per service whose
 * image is Postgres, at most a task's worth, in the file's order. A file that
 * does not parse, has no services or none that is Postgres says so.
 */
export function postgresFromCompose(text: string, file: string): ComposePostgresRead {
  let raw: unknown;
  try {
    // Compose files share settings through anchors and `<<` merges; an
    // error throws, and nothing from the file is printed to the bridge's log.
    raw = parseYaml(text, { merge: true, logLevel: 'error' });
  } catch (error) {
    const said = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return { ok: false, why: `${file} does not read as YAML: ${said}` };
  }
  const services = isMap(raw) ? raw.services : undefined;
  if (!isMap(services) || Object.keys(services).length === 0) {
    return { ok: false, why: `${file} has no services: Compose starts what its top-level services: map names` };
  }
  const found: ComposePostgresServer[] = [];
  const others: string[] = [];
  for (const [name, service] of Object.entries(services)) {
    if (!isMap(service)) continue;
    const image = typeof service.image === 'string' ? interpolate(service.image) : null;
    if (!image || image.value === null || !isPostgresImage(image.value)) {
      others.push(typeof service.image === 'string' ? `${name} (${service.image})` : `${name} (no image: ${Object.hasOwn(service, 'build') ? 'it is built' : 'none given'})`);
      continue;
    }
    found.push(serverOf(name, service, { ...image, value: image.value }));
  }
  if (found.length === 0) {
    const listed = others.length > 0 ? ` (${others.slice(0, 6).join(', ')}${others.length > 6 ? ', …' : ''})` : '';
    return { ok: false, why: `${file} has no Postgres service: none of its services runs pgvector/pgvector or postgres${listed}` };
  }
  const notes =
    found.length > TASK_POSTGRES_MAX_SERVERS
      ? [`${file} starts ${found.length} Postgres services, and a task can have at most ${TASK_POSTGRES_MAX_SERVERS}: these are the first ${TASK_POSTGRES_MAX_SERVERS}`]
      : [];
  return { ok: true, servers: found.slice(0, TASK_POSTGRES_MAX_SERVERS), notes };
}

function serverOf(service: string, raw: Fields, image: Interpolated & { value: string }): ComposePostgresServer {
  const notes: ComposePostgresServer['notes'] = [];
  const note = (field: ComposeNoteField, text: string) => notes.push({ field, text });
  const environment = environmentOf(raw.environment);
  // An env_file sets the server's environment as well, and is another file, which is not read here.
  const elsewhere = raw.env_file !== undefined ? ', and its env_file, which is not read here, may' : '';

  if (image.defaulted.length > 0) note('image', `the file's default for ${variables(image.defaulted)}`);
  const refusal = taskPostgresImageRefusal(image.value.trim());

  const port = hostPortOf(raw.ports);
  if (port.note) note('port', port.note);

  /** A variable as the file sets it: its value, or undefined when the file does not name it, or null when it names it and leaves its value to what is not read. */
  const valueOf = (variable: string, field: keyof TaskPostgresServer): string | null | undefined => {
    if (!environment.has(variable)) {
      if (environment.has(`${variable}_FILE`)) {
        note(field, `${variable}_FILE reads it from a file, which is not read here: give it`);
        return null;
      }
      return undefined;
    }
    const given = environment.get(variable);
    if (given === null || given === undefined) {
      note(field, `${variable} takes its value from the shell or a .env file, which are not read here: give it`);
      return null;
    }
    const read = interpolate(given);
    if (read.value === null) {
      note(field, `${variable} is ${given}, and the file gives ${variables(read.unknown)} no default: give it`);
      return null;
    }
    if (read.defaulted.length > 0) note(field, `the file's default for ${variables(read.defaulted)}`);
    return read.value;
  };

  let superuser = valueOf('POSTGRES_USER', 'superuser');
  if (superuser === undefined) {
    superuser = 'postgres';
    note('superuser', `the file sets no POSTGRES_USER, so this is the image's default${elsewhere ? `${elsewhere} set another` : ''}`);
  }
  let database = valueOf('POSTGRES_DB', 'database');
  if (database === undefined) {
    database = superuser ?? '';
    note(
      'database',
      superuser === null
        ? "the file sets no POSTGRES_DB, so it is the image's default, its superuser's name, which is not known here: give it"
        : `the file sets no POSTGRES_DB, so this is the image's default, its superuser's name${elsewhere ? `${elsewhere} set another` : ''}`,
    );
  }
  let password = valueOf('POSTGRES_PASSWORD', 'password');
  if (password === undefined) {
    password = '';
    note('password', `the file sets no POSTGRES_PASSWORD${elsewhere}: give the one the repository's own database URLs use`);
  }

  return {
    service,
    port: port.port,
    superuser: superuser ?? '',
    password: password ?? '',
    database: database ?? '',
    image: image.value.trim(),
    notes,
    refusal,
  };
}

/** `$NAME`, or several, as a note names them. */
function variables(names: readonly string[]): string {
  return [...new Set(names)].map((name) => `$${name}`).join(', ');
}

/**
 * A service's environment, in either form Compose takes: a map, or a list of
 * `NAME=value`. A name with no value is the shell's (null), which is not
 * known here.
 */
function environmentOf(raw: unknown): Map<string, string | null> {
  const found = new Map<string, string | null>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const equals = entry.indexOf('=');
      if (equals < 0) found.set(entry.trim(), null);
      else found.set(entry.slice(0, equals).trim(), entry.slice(equals + 1));
    }
  } else if (isMap(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      found.set(name, typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null);
    }
  }
  return found;
}

/** One port mapping, as either of Compose's syntaxes writes it. */
interface Mapping {
  host: string | null;
  container: string;
  protocol: string;
}

/**
 * The host side of the mapping to Postgres's port in its container, which is
 * what the repository's URLs and Makefile reach it at. A mapping to another
 * port is taken when none is to 5432, and said; none with a host side is no
 * port, and said.
 */
function hostPortOf(raw: unknown): { port: number | null; note: string | null } {
  const mappings: Mapping[] = [];
  const unknown: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const mapping = mappingOf(entry, unknown);
    if (mapping && mapping.protocol === 'tcp') mappings.push(mapping);
  }
  const published = mappings.filter((mapping) => mapping.host !== null && mapping.host !== '');
  const chosen = published.find((mapping) => mapping.container === POSTGRES_PORT) ?? published[0];
  if (!chosen?.host) {
    if (unknown.length > 0) return { port: null, note: `its ports name ${variables(unknown)}, which the file gives no default: give the port` };
    return { port: null, note: "the file publishes no port for it on the host: give the port the repository's Makefile reaches it on" };
  }
  if (!/^\d+$/.test(chosen.host)) {
    return { port: null, note: `the file publishes it on ${chosen.host}, not one port: give the port the repository's Makefile reaches it on` };
  }
  const port = Number(chosen.host);
  return {
    port,
    note: chosen.container === POSTGRES_PORT ? null : `the file maps ${port} to ${chosen.container} in its container, not ${POSTGRES_PORT}: check it is the one the Makefile reaches`,
  };
}

function mappingOf(entry: unknown, unknown: string[]): Mapping | null {
  if (typeof entry === 'number') return { host: null, container: String(entry), protocol: 'tcp' };
  if (isMap(entry)) {
    // The long syntax: `{ target: 5432, published: "55432", protocol: tcp }`.
    const target = typeof entry.target === 'number' || typeof entry.target === 'string' ? String(entry.target) : null;
    if (target === null) return null;
    let host: string | null = null;
    if (typeof entry.published === 'number') host = String(entry.published);
    else if (typeof entry.published === 'string') {
      const read = interpolate(entry.published);
      if (read.value === null) unknown.push(...read.unknown);
      host = read.value;
    }
    return { host, container: target, protocol: typeof entry.protocol === 'string' ? entry.protocol.toLowerCase() : 'tcp' };
  }
  if (typeof entry !== 'string') return null;
  const read = interpolate(entry);
  if (read.value === null) {
    unknown.push(...read.unknown);
    return null;
  }
  // The short syntax: `[[ip:]host:]container[/protocol]`, an IPv6 address in brackets.
  let rest = read.value.trim();
  let protocol = 'tcp';
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    protocol = rest.slice(slash + 1).toLowerCase();
    rest = rest.slice(0, slash);
  }
  if (rest.startsWith('[')) rest = rest.slice(rest.indexOf(']') + 1).replace(/^:/, '');
  const parts = rest.split(':');
  const container = parts[parts.length - 1] ?? '';
  const host = parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
  return { host, container, protocol };
}

/** A value with Compose's variables read as unset, which is all that is known of them here. */
interface Interpolated {
  /** Null when a variable with no default decides it. */
  value: string | null;
  /** The variables whose default the file gives was taken. */
  defaulted: string[];
  /** The variables with no default. */
  unknown: string[];
}

/**
 * Compose's interpolation, with every variable unset: the shell and the
 * project's `.env` are not read, so `${NAME:-default}` and `${NAME-default}`
 * are their default, `${NAME:+alt}` is empty, `$$` is `$`, and `$NAME`,
 * `${NAME}` and `${NAME:?error}` are not known.
 */
function interpolate(text: string): Interpolated {
  const defaulted: string[] = [];
  const unknown: string[] = [];
  const value = expand(text, defaulted, unknown);
  return { value: unknown.length > 0 ? null : value, defaulted, unknown };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

function expand(text: string, defaulted: string[], unknown: string[]): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char !== '$') {
      out += char;
      at += 1;
      continue;
    }
    const next = text[at + 1];
    if (next === '$') {
      out += '$';
      at += 2;
    } else if (next === '{') {
      const close = closing(text, at + 1);
      if (close < 0) {
        out += text.slice(at);
        break;
      }
      out += substitute(text.slice(at + 2, close), defaulted, unknown);
      at = close + 1;
    } else {
      const name = NAME.exec(text.slice(at + 1))?.[0];
      if (name) unknown.push(name);
      else out += '$';
      at += 1 + (name?.length ?? 0);
    }
  }
  return out;
}

/** Where the brace opened at `open` closes, counting those opened inside it; -1 when it does not. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '{') depth += 1;
    else if (text[at] === '}' && --depth === 0) return at;
  }
  return -1;
}

function substitute(inner: string, defaulted: string[], unknown: string[]): string {
  const name = NAME.exec(inner)?.[0];
  if (!name) {
    unknown.push(inner);
    return '';
  }
  const rest = inner.slice(name.length);
  const operator = /^:?[-?+]/.exec(rest)?.[0];
  if (rest === '' || !operator || operator.endsWith('?')) {
    unknown.push(name);
    return '';
  }
  if (operator.endsWith('+')) return '';
  defaulted.push(name);
  return expand(rest.slice(operator.length), defaulted, unknown);
}
