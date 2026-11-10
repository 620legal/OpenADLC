#!/usr/bin/env node
/**
 * Migration 0162 (#251, docs/adr/0034-one-list-of-people.md) moves three lists
 * into `people`: the console's `users`, the linked accounts in
 * `person_github_accounts`, and the `humans` setting with its `humanIds` pins.
 * The unit tests read the SQL as text; only Postgres says what it does to the
 * rows. Each case applies 0001–0161 in a schema of its own, seeds the old
 * lists, applies 0162, and checks the people it left, then drops the schema.
 *
 * It writes nothing outside the schemas it makes, but it still runs only
 * against a scratch install, as every suite here does (scratch-only.mjs):
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/people-migration.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from '@openadlc/db';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'packages', 'db', 'migrations');
const PEOPLE = '0162_people.sql';

function files() {
  return readdirSync(migrations)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/**
 * Applies every migration before 0162 in a fresh schema, runs `seed`, applies
 * 0162, and hands the client to `check`. The schema goes whatever happens.
 */
async function inSchema(name, seed, check) {
  const client = await getPool().connect();
  const schema = `people_migration_${name}_${process.pid}`;
  try {
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}, public`);
    for (const file of files()) {
      if (file >= PEOPLE) break;
      await client.query(readFileSync(join(migrations, file), 'utf8'));
    }
    await seed(client);
    await client.query(readFileSync(join(migrations, PEOPLE), 'utf8'));
    return await check(client);
  } finally {
    await client.query(`set search_path to public`).catch(() => undefined);
    await client.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
    client.release();
  }
}

async function people(client) {
  const { rows } = await client.query(
    `select email, console_role, github_login, github_user_id::text as github_user_id,
            github_linked_at is not null as confirmed, approves, added_how
       from people order by coalesce(email, github_login)`,
  );
  return rows;
}

async function setting(client, key) {
  const { rows } = await client.query('select value from settings where key = $1', [key]);
  return rows[0]?.value ?? null;
}

function addUser(client, email, role) {
  return client.query(`insert into users (email, role, added_by) values ($1, $2, 'test')`, [email, role]);
}

function put(client, key, value) {
  return client.query(`insert into settings (key, value) values ($1, $2)`, [key, value]);
}

/** Each case, by name: what to seed, and the checks on what 0162 left. */
export const CASES = [
  {
    name: 'users only',
    async seed(client) {
      await addUser(client, 'ada@example.com', 'admin');
      await addUser(client, 'grace@example.com', 'user');
    },
    async check(client) {
      const rows = await people(client);
      return [
        ['each user is one person', rows.length === 2 && rows[0].email === 'ada@example.com' && rows[1].email === 'grace@example.com'],
        ['console roles carry over', rows[0].console_role === 'admin' && rows[1].console_role === 'user'],
        ['nobody approves', rows.every((row) => !row.approves)],
      ];
    },
  },
  {
    name: 'humans only',
    async seed(client) {
      await put(client, 'humans', 'Ada, grace,ada');
      await put(client, 'humanIds', JSON.stringify({ ada: 101, grace: 202 }));
    },
    async check(client) {
      const rows = await people(client);
      return [
        ['one GitHub-only person per login, case-insensitively', rows.length === 2 && rows.every((row) => row.email === null)],
        ['each approves', rows.every((row) => row.approves && row.added_how === 'humans')],
        ['each keeps its pin', rows[0].github_user_id === '101' && rows[1].github_user_id === '202'],
        ['no console role', rows.every((row) => row.console_role === null)],
        ['the humans row is gone', (await setting(client, 'humans')) === null],
      ];
    },
  },
  {
    name: 'both, with a linked account',
    async seed(client) {
      await addUser(client, 'ada@example.com', 'admin');
      await client.query(
        `insert into person_github_accounts (identity, github_login, github_user_id) values ('ada@example.com', 'ada', 101)`,
      );
      await put(client, 'humans', 'ada');
      await put(client, 'humanIds', JSON.stringify({ ada: 101 }));
      await put(client, 'personRoles', JSON.stringify({ roles: [{ id: 'product', members: ['ada'] }] }));
    },
    async check(client) {
      const rows = await people(client);
      const ada = rows[0];
      const { rows: ids } = await client.query(`select id::text from people`);
      const roles = JSON.parse((await setting(client, 'personRoles')) ?? 'null');
      return [
        ['one person', rows.length === 1],
        ['with email, confirmed account and Approves on', ada?.email === 'ada@example.com' && ada.github_user_id === '101' && ada.confirmed && ada.approves],
        ['a role member login becomes the person id', roles?.roles?.[0]?.members?.[0] === ids[0]?.id],
        ['the humans row is gone', (await setting(client, 'humans')) === null],
      ];
    },
  },
  {
    name: 'both, without a link',
    async seed(client) {
      await addUser(client, 'ada@example.com', 'admin');
      await put(client, 'humans', 'ada');
      await put(client, 'humanIds', JSON.stringify({ ada: 101 }));
    },
    async check(client) {
      const rows = await people(client);
      const byEmail = rows.find((row) => row.email === 'ada@example.com');
      const byLogin = rows.find((row) => row.github_login === 'ada');
      return [
        ['two people', rows.length === 2],
        ['the user does not approve', byEmail && !byEmail.approves && byEmail.github_login === null],
        ['the login approves, pinned, with no email', byLogin && byLogin.approves && byLogin.email === null && byLogin.github_user_id === '101'],
      ];
    },
  },
];

/** Runs every case, prints each check, and says whether all passed. */
export async function runPeopleMigration(log = console.log) {
  let ok = true;
  for (const each of CASES) {
    const results = await inSchema(each.name.replace(/\W+/g, '_'), each.seed, each.check);
    for (const [what, passed] of results) {
      ok &&= Boolean(passed);
      log(`${passed ? '  ok  ' : ' FAIL '} ${each.name}: ${what}`);
    }
  }
  return ok;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { refuseARealInstall } = await import('./scratch-only.mjs');
  // Before anything else is read or written: see scratch-only.mjs.
  await refuseARealInstall();
  const ok = await runPeopleMigration().finally(() => closePool());
  process.exit(ok ? 0 : 1);
}
