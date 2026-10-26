import { describe, expect, it } from 'vitest';
import { COMPOSE_FILES, postgresFromCompose, type ComposePostgresRead, type ComposePostgresServer } from './task-postgres-compose.js';
import { parseTaskPostgres, TASK_POSTGRES_MAX_SERVERS } from './task-postgres.js';

/** acme/app's docker-compose.yml on main. */
const APP_COMPOSE = `services:
  postgres:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app_db }
    ports: ['55432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U app -d app_db']
      interval: 2s
      timeout: 3s
      retries: 30
`;

function servers(read: ComposePostgresRead): ComposePostgresServer[] {
  if (!read.ok) throw new Error(`expected servers, got: ${read.why}`);
  return read.servers;
}

function why(read: ComposePostgresRead): string {
  if (read.ok) throw new Error(`expected no servers, got ${JSON.stringify(read.servers)}`);
  return read.why;
}

/** One service's server, from a file with that service alone. */
const one = (service: string) => servers(postgresFromCompose(`services:\n${service}`, 'docker-compose.yml'))[0]!;

describe('the Postgres servers a repository’s Compose file starts', () => {
  it('reads app’s file as app’s one server, with nothing left to give, which a save takes as it is', () => {
    const read = postgresFromCompose(APP_COMPOSE, 'docker-compose.yml');

    expect(read).toEqual({
      ok: true,
      servers: [
        { service: 'postgres', port: 55432, superuser: 'app', password: 'app', database: 'app_db', image: 'pgvector/pgvector:pg16', notes: [], refusal: null },
      ],
      notes: [],
    });
    const [{ service: _service, notes: _notes, refusal: _refusal, ...server }] = servers(read) as [ComposePostgresServer];
    expect(parseTaskPostgres({ servers: [server] })).toEqual({ ok: true, setting: { servers: [{ ...server, port: 55432 }], sharedDatabase: false } });
  });

  it('looks for the names Compose looks for, in its order', () => {
    expect(COMPOSE_FILES).toEqual(['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']);
  });

  it('reads the long port syntax, published as a number or a string', () => {
    expect(one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: pw }\n    ports:\n      - target: 5432\n        published: "55433"\n        host_ip: 127.0.0.1\n        protocol: tcp\n`).port).toBe(55433);
    expect(one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: pw }\n    ports: [{ target: 5432, published: 55434 }]\n`).port).toBe(55434);
  });

  it('reads the short syntax with an address, an IPv6 address or a protocol, and takes the mapping to 5432 over another', () => {
    const port = (ports: string) => one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: pw }\n    ports: ${ports}\n`);
    expect(port(`['127.0.0.1:55432:5432']`).port).toBe(55432);
    expect(port(`['[::1]:55435:5432/tcp']`).port).toBe(55435);
    expect(port(`['8080:80', '55436:5432']`).port).toBe(55436);
    expect(port(`['55437:5432/udp', '55438:5432']`).port).toBe(55438);

    const other = port(`['55439:5433']`);
    expect(other.port).toBe(55439);
    expect(other.notes.filter((note) => note.field === 'port')).toEqual([{ field: 'port', text: 'the file maps 55439 to 5433 in its container, not 5432: check it is the one the Makefile reaches' }]);
  });

  it('leaves the port to give when the file publishes none on the host, or a range', () => {
    for (const ports of ['', "\n    ports: ['5432']", "\n    ports: ['127.0.0.1::5432']", '\n    ports: [5432]']) {
      const server = one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: pw }${ports}\n`);
      expect(server.port, ports).toBeNull();
      expect(server.notes.filter((note) => note.field === 'port'), ports).toEqual([{ field: 'port', text: "the file publishes no port for it on the host: give the port the repository's Makefile reaches it on" }]);
    }
    const range = one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: pw }\n    ports: ['55440-55449:5432']\n`);
    expect(range.port).toBeNull();
    expect(range.notes[0]?.text).toBe("the file publishes it on 55440-55449, not one port: give the port the repository's Makefile reaches it on");
  });

  it('reads environment as a list, a value with = in it whole', () => {
    const server = one(`  db:\n    image: postgres:16\n    environment:\n      - POSTGRES_USER=app\n      - POSTGRES_PASSWORD=s3cr=t\n      - POSTGRES_DB=app_test\n    ports: ['55432:5432']\n`);
    expect(server).toMatchObject({ superuser: 'app', password: 's3cr=t', database: 'app_test', notes: [] });
  });

  it('reads a value a number in the map, as the image is given it', () => {
    expect(one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: 1234 }\n    ports: ['55432:5432']\n`).password).toBe('1234');
  });

  it('takes the default the file gives a variable, and says so, since a .env could set another', () => {
    const server = one(
      `  db:\n    image: \${PG_IMAGE:-pgvector/pgvector:pg17}\n    environment:\n      POSTGRES_USER: \${DB_USER:-app}\n      POSTGRES_PASSWORD: \${DB_PASSWORD-app}\n      POSTGRES_DB: \${DB_NAME:-\${DB_USER:-app}_db}\n    ports: ['\${PG_PORT:-55432}:5432']\n`,
    );
    expect(server).toMatchObject({ port: 55432, superuser: 'app', password: 'app', database: 'app_db', image: 'pgvector/pgvector:pg17', refusal: null });
    expect(server.notes).toEqual([
      { field: 'image', text: "the file's default for $PG_IMAGE" },
      { field: 'superuser', text: "the file's default for $DB_USER" },
      { field: 'database', text: "the file's default for $DB_NAME, $DB_USER" },
      { field: 'password', text: "the file's default for $DB_PASSWORD" },
    ]);
  });

  it('leaves a value to give when a variable has no default, or comes from the shell, a file or $$', () => {
    const server = one(
      `  db:\n    image: postgres:16\n    environment:\n      - POSTGRES_USER\n      - POSTGRES_PASSWORD=\${DB_PASSWORD}\n      - POSTGRES_DB=$$literal\n    ports: ['\${PG_PORT}:5432']\n`,
    );
    expect(server).toMatchObject({ port: null, superuser: '', password: '', database: '$literal' });
    expect(server.notes).toEqual([
      { field: 'port', text: 'its ports name $PG_PORT, which the file gives no default: give the port' },
      { field: 'superuser', text: 'POSTGRES_USER takes its value from the shell or a .env file, which are not read here: give it' },
      { field: 'password', text: 'POSTGRES_PASSWORD is ${DB_PASSWORD}, and the file gives $DB_PASSWORD no default: give it' },
    ]);

    const secret = one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD_FILE: /run/secrets/pg }\n    ports: ['55432:5432']\n`);
    expect(secret.password).toBe('');
    expect(secret.notes).toContainEqual({ field: 'password', text: 'POSTGRES_PASSWORD_FILE reads it from a file, which is not read here: give it' });
  });

  it('takes the image’s defaults where the file sets none, and leaves the password, which has none, to give', () => {
    const server = one(`  db:\n    image: postgres:16\n    ports: ['55432:5432']\n`);
    expect(server).toMatchObject({ superuser: 'postgres', database: 'postgres', password: '' });
    expect(server.notes).toEqual([
      { field: 'superuser', text: "the file sets no POSTGRES_USER, so this is the image's default" },
      { field: 'database', text: "the file sets no POSTGRES_DB, so this is the image's default, its superuser's name" },
      { field: 'password', text: "the file sets no POSTGRES_PASSWORD: give the one the repository's own database URLs use" },
    ]);

    const named = one(`  db:\n    image: postgres:16\n    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: pw }\n    env_file: .env\n    ports: ['55432:5432']\n`);
    expect(named.database).toBe('app');
    expect(named.notes).toEqual([
      { field: 'database', text: "the file sets no POSTGRES_DB, so this is the image's default, its superuser's name, and its env_file, which is not read here, may set another" },
    ]);
  });

  it('reads a service that takes its settings from an anchor through <<', () => {
    const read = postgresFromCompose(
      `x-pg: &pg\n  image: pgvector/pgvector:pg16\n  environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app_db }\nservices:\n  postgres:\n    <<: *pg\n    ports: ['55432:5432']\n`,
      'compose.yaml',
    );
    expect(servers(read)).toMatchObject([{ port: 55432, superuser: 'app', password: 'app', database: 'app_db', image: 'pgvector/pgvector:pg16' }]);
  });

  it('gives one server per Postgres service, in the file’s order, and passes over the rest', () => {
    const read = postgresFromCompose(
      `services:\n  api:\n    build: .\n  main:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: a }\n    ports: ['55432:5432']\n  cache:\n    image: redis:7\n  exporter:\n    image: prometheuscommunity/postgres-exporter:v0.15.0\n  audit:\n    image: docker.io/library/postgres:17\n    environment: { POSTGRES_PASSWORD: b }\n    ports: ['55433:5432']\n`,
      'docker-compose.yml',
    );
    expect(servers(read).map((server) => [server.service, server.port, server.image])).toEqual([
      ['main', 55432, 'postgres:16'],
      ['audit', 55433, 'docker.io/library/postgres:17'],
    ]);
  });

  it('suggests a Postgres image outside the allowlist as written, with what a save would say of it', () => {
    const read = postgresFromCompose(
      `services:\n  db:\n    image: bitnami/postgresql:16\n    environment: { POSTGRES_PASSWORD: pw }\n    ports: ['55432:5432']\n  bare:\n    image: postgres\n    environment: { POSTGRES_PASSWORD: pw }\n    ports: ['55433:5432']\n`,
      'docker-compose.yml',
    );
    const [bitnami, bare] = servers(read);
    const saved = (image: string) => {
      const said = parseTaskPostgres({ servers: [{ port: 55432, superuser: 'postgres', password: 'pw', database: 'postgres', image }] });
      return said.ok ? null : said.error;
    };
    expect(bitnami?.image).toBe('bitnami/postgresql:16');
    expect(bitnami?.refusal).toBe(saved('bitnami/postgresql:16'));
    expect(bitnami?.refusal).toMatch(/^bitnami\/postgresql:16 is not an image a task's server may run: use pgvector\/pgvector:<tag> or postgres:<tag>/);
    expect(bare?.image).toBe('postgres');
    expect(bare?.refusal).toBe(saved('postgres'));
  });

  it('gives at most a task’s worth of servers, and says it left the rest', () => {
    const services = Array.from({ length: 5 }, (_, index) => `  pg${index}:\n    image: postgres:16\n    environment: { POSTGRES_PASSWORD: pw }\n    ports: ['${55432 + index}:5432']\n`).join('');
    const read = postgresFromCompose(`services:\n${services}`, 'compose.yaml');
    expect(servers(read)).toHaveLength(TASK_POSTGRES_MAX_SERVERS);
    expect(read.ok && read.notes).toEqual([`compose.yaml starts 5 Postgres services, and a task can have at most ${TASK_POSTGRES_MAX_SERVERS}: these are the first ${TASK_POSTGRES_MAX_SERVERS}`]);
  });

  it('says a file with no Postgres service has none, and what its services run', () => {
    expect(why(postgresFromCompose(`services:\n  api:\n    image: node:20\n  cache:\n    image: redis:7\n  web:\n    build: .\n`, 'docker-compose.yml'))).toBe(
      'docker-compose.yml has no Postgres service: none of its services runs pgvector/pgvector or postgres (api (node:20), cache (redis:7), web (no image: it is built))',
    );
    expect(why(postgresFromCompose(`services:\n  db:\n    image: \${DB_IMAGE}\n`, 'compose.yaml'))).toMatch(/^compose\.yaml has no Postgres service/);
  });

  it('says a file that does not read, or has no services, cannot be filled from', () => {
    expect(why(postgresFromCompose('services:\n  db: [unclosed\n', 'docker-compose.yml'))).toMatch(/^docker-compose\.yml does not read as YAML: /);
    expect(why(postgresFromCompose('services: {}\na: 1\na: 2\n', 'docker-compose.yml'))).toMatch(/^docker-compose\.yml does not read as YAML: /);
    for (const text of ['', 'version: "3.8"\n', '- a\n- b\n', 'services: [db]\n', 'services: {}\n']) {
      expect(why(postgresFromCompose(text, 'compose.yml')), text).toBe('compose.yml has no services: Compose starts what its top-level services: map names');
    }
  });
});
