#!/usr/bin/env node
/**
 * What only a real Docker daemon can say about a task's own Postgres server
 * (#136): that a repository a person gave one (Settings → Repositories, the
 * bridge's `PUT /v1/repos/:name/task-postgres`) gets it in each task's
 * computer; that the task reaches it at 127.0.0.1:<port> as the configured
 * superuser and can make server-wide roles there; that a second task at
 * once has its own, and cannot reach the first's; that the server goes with
 * its computer; and that one whose computer went some other way is swept.
 * The unit tests drive the driver against a Docker that answers from a
 * script; this is the claim they cannot make.
 *
 * It starts real containers, so it runs only when asked, against a scratch
 * install on the docker driver. It deletes every task and lease, as
 * docker-computers.mjs does, and puts back the repository's setting and its
 * builder's seat as it found them:
 *
 *   OPENADLC_DOCKER_COMPUTERS=1 node tests/all.mjs
 *   OPENADLC_SCRATCH_DRIVER=docker tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/task-postgres.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bots, closePool, issues, leases, query, repos, waitForDatabase } from '@openadlc/db';
import { consoleSecretRef, getSecretStore, internalSecretRef } from '@openadlc/github';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const run = promisify(execFile);
const BRIDGE = process.env.OPENADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
const HOSTD = process.env.OPENADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';
const INSTALL = process.env.OPENADLC_INSTALL_ID ?? 'default';
const NETWORK = process.env.OPENADLC_BOT_PREFIX ? `${process.env.OPENADLC_BOT_PREFIX}tasks` : 'openadlc-tasks';
const SECRET = await getSecretStore().get(internalSecretRef());
const CONSOLE_SECRET = await getSecretStore().get(consoleSecretRef());
/** 620legal/core's local Postgres, as its docker-compose.yml and Makefile name it. */
const CORE = { port: 55432, superuser: 'core', password: 'core', database: 'core_db', image: 'pgvector/pgvector:pg16' };

const internal = { 'content-type': 'application/json', 'x-openadlc-internal-secret': SECRET ?? '' };
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function docker(...args) {
  try {
    const { stdout } = await run('docker', args, { maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? '') };
  }
}

async function waitFor(predicate, timeoutMs = 60_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return null;
}

/**
 * A Postgres client small enough to pass to `node -e` in a task's computer,
 * which has node and no psql: the startup message, SCRAM-SHA-256 (the
 * image's rule for every TCP connection), and one simple query. It prints
 * `{ rows, error }` as JSON: every row of every statement, or what the server
 * refused.
 */
const PG_CLIENT = String.raw`
const net = require('net');
const crypto = require('crypto');
const [host, port, user, password, database, sql] = process.argv.slice(1);
const say = (out) => { process.stdout.write(JSON.stringify(out)); process.exit(out.error ? 3 : 0); };
const message = (type, body) => { const head = Buffer.alloc(5); head.write(type, 0); head.writeInt32BE(body.length + 4, 1); return Buffer.concat([head, body]); };
const cstr = (text) => Buffer.from(text + '\0');
const socket = net.connect(Number(port), host);
socket.setTimeout(10000, () => say({ error: 'timed out' }));
socket.on('error', (error) => say({ error: error.code || error.message }));
socket.on('connect', () => {
  const params = Buffer.concat([cstr('user'), cstr(user), cstr('database'), cstr(database), Buffer.from([0])]);
  const body = Buffer.alloc(4); body.writeInt32BE(196608, 0);
  const all = Buffer.concat([body, params]);
  const head = Buffer.alloc(4); head.writeInt32BE(all.length + 4, 0);
  socket.write(Buffer.concat([head, all]));
});
const nonce = crypto.randomBytes(18).toString('base64');
const firstBare = 'n=,r=' + nonce;
let pending = Buffer.alloc(0);
let serverSignature = null;
const rows = [];
let error = null;
let asked = false;
socket.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const type = String.fromCharCode(pending[0]);
    const length = pending.readInt32BE(1);
    if (pending.length < length + 1) return;
    const body = pending.subarray(5, length + 1);
    pending = pending.subarray(length + 1);
    if (type === 'R') {
      const code = body.readInt32BE(0);
      if (code === 10) {
        const first = Buffer.from('n,,' + firstBare);
        const size = Buffer.alloc(4); size.writeInt32BE(first.length, 0);
        socket.write(message('p', Buffer.concat([cstr('SCRAM-SHA-256'), size, first])));
      } else if (code === 11) {
        const serverFirst = body.subarray(4).toString();
        const fields = Object.fromEntries(serverFirst.split(',').map((part) => [part[0], part.slice(2)]));
        const salted = crypto.pbkdf2Sync(password, Buffer.from(fields.s, 'base64'), Number(fields.i), 32, 'sha256');
        const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
        const storedKey = crypto.createHash('sha256').update(clientKey).digest();
        const finalBare = 'c=biws,r=' + fields.r;
        const auth = firstBare + ',' + serverFirst + ',' + finalBare;
        const signature = crypto.createHmac('sha256', storedKey).update(auth).digest();
        const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]));
        const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
        serverSignature = crypto.createHmac('sha256', serverKey).update(auth).digest('base64');
        socket.write(message('p', Buffer.from(finalBare + ',p=' + proof.toString('base64'))));
      } else if (code === 12) {
        if (body.subarray(4).toString() !== 'v=' + serverSignature) say({ error: 'the server did not prove it knows the password' });
      } else if (code !== 0) {
        say({ error: 'authentication method ' + code + ' is not SCRAM' });
      }
    } else if (type === 'E') {
      const parts = body.toString().split('\0');
      error = (parts.find((part) => part.startsWith('M')) || 'Munknown').slice(1);
      if (!asked) say({ error });
    } else if (type === 'D') {
      const count = body.readInt16BE(0);
      const row = [];
      let at = 2;
      for (let column = 0; column < count; column += 1) {
        const size = body.readInt32BE(at); at += 4;
        row.push(size < 0 ? null : body.subarray(at, at + size).toString()); at += Math.max(size, 0);
      }
      rows.push(row);
    } else if (type === 'Z') {
      if (!asked) { asked = true; socket.write(message('Q', cstr(sql))); }
      else { socket.end(message('X', Buffer.alloc(0))); say({ rows, error }); }
    }
  }
});
`;

/** One query from inside a container, over TCP, as the configured superuser unless told otherwise. */
async function pg(container, sql, { host = '127.0.0.1', port = CORE.port, user = CORE.superuser, password = CORE.password, database = CORE.database } = {}) {
  const answer = await docker('exec', container, 'node', '-e', PG_CLIENT, host, String(port), user, password, database, sql);
  try {
    return JSON.parse(answer.stdout || '{}');
  } catch {
    return { error: answer.stderr || answer.stdout || `exit ${answer.code}` };
  }
}

/** Whether a TCP connection from inside a container to an address opens within three seconds. */
async function reaches(container, host, port) {
  const script = `const s=require('net').connect(${port},${JSON.stringify(host)});s.setTimeout(3000);s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(2));s.on('error',()=>process.exit(1));`;
  return (await docker('exec', container, 'node', '-e', script)).code === 0;
}

/** The bridge's console API as a person, the way the console's server and the CLI call it. */
async function asPerson(method, path, body, { secret = CONSOLE_SECRET } = {}) {
  const response = await fetch(`${BRIDGE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-openadlc-identity': 'task-postgres suite', ...(secret ? { 'x-openadlc-console-secret': secret } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Leases an issue to the bot and starts its task through the bridge, as the dispatcher would. */
async function startTask(repo, bot, number) {
  const issue = await issues.upsertIssue({
    repoId: repo.id,
    number,
    title: `Integration: a Postgres server of its own ${number}`,
    stage: 'build',
    labels: ['adlc:build', 'start:now', 'do:ai', 'priority:p1'],
    declaredPaths: [`tests/postgres/${number}/**`],
    url: null,
    prNumber: null,
  });
  const lease = await leases.createLease({
    repoId: repo.id,
    issueNumber: issue.number,
    botId: bot.id,
    declaredPaths: issue.declaredPaths,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const answer = await fetch(`${BRIDGE}/internal/dispatch/lease`, {
    method: 'POST',
    headers: internal,
    body: JSON.stringify({ leaseId: lease.id, repo: repo.name, issue: issue.number, bot: bot.name, botId: bot.id, declaredPaths: issue.declaredPaths, expiresAt: null }),
  }).then((response) => response.json());
  const taskId = answer.task?.taskId ?? null;
  const ready = taskId
    ? await waitFor(async () => {
        const rows = await query('select container, state from tasks where id = $1', [taskId]);
        return rows[0]?.container && rows[0].state === 'running' ? rows[0] : null;
      }, 120_000)
    : null;
  return { taskId, container: ready?.container ?? null };
}

/** This install's task computers on the daemon, by name. */
async function computers() {
  const listed = await docker('ps', '--filter', `label=openadlc.install=${INSTALL}`, '--filter', 'label=openadlc.kind=computer', '--format', '{{.Names}}');
  return listed.stdout.split('\n').filter(Boolean);
}

/**
 * Holds the scripted session still once its runner starts, by PID inside the
 * computer. A scripted implement run says its five lines in under a second
 * and its task ends, taking the computer with it; held, the task stays
 * running, and its computer and server stay, while the checks look. tmux is
 * stopped first: it starts a stopped pane's process again. The observer
 * cannot read a held computer's sessions, so it stops nothing there; `letGo`
 * starts everything again before the task is cancelled.
 */
const HOLD = [
  'i=0',
  'while [ $i -lt 2400 ]; do',
  '  for p in /proc/[0-9]*; do',
  '    c=$(tr "\\0" " " < $p/cmdline 2>/dev/null) || continue',
  '    case "$c" in node\\ */skill-runner.mjs*)',
  '      for t in /proc/[0-9]*; do case "$(tr "\\0" " " < $t/cmdline 2>/dev/null)" in tmux\\ *) kill -STOP "${t#/proc/}" ;; esac; done',
  '      kill -STOP "${p#/proc/}"; exit 0 ;;',
  '    esac',
  '  done',
  '  i=$((i+1)); sleep 0.05',
  'done',
].join('\n');
const LET_GO = 'for p in /proc/[0-9]*; do grep -q "^State:.*(stopped)" $p/status 2>/dev/null && kill -CONT "${p#/proc/}"; done; true';

async function letGo(container) {
  if (container) await docker('exec', '-u', '0', container, 'sh', '-c', LET_GO);
}

/** A task started as the dispatcher would, its session held still once it is up (`HOLD`). */
async function startHeld(repo, bot, number) {
  const before = new Set(await computers());
  const starting = startTask(repo, bot, number);
  const made = await waitFor(async () => (await computers()).find((name) => !before.has(name)) ?? null, 120_000, 100);
  if (made) await docker('exec', '-d', '-u', '0', made, 'sh', '-c', HOLD);
  return starting;
}

async function cancel(taskId) {
  await fetch(`${HOSTD}/tasks/${taskId}/cancel`, { method: 'POST', headers: internal, body: JSON.stringify({ reason: 'the task postgres suite is done' }) }).catch(() => undefined);
}

async function inspect(name) {
  const found = await docker('container', 'inspect', name);
  return found.code === 0 ? (JSON.parse(found.stdout)[0] ?? null) : null;
}

/** What the task's session was started with, read from its runner's environment in the computer. */
async function sessionEnv(container) {
  const script =
    'for p in /proc/[0-9]*; do e=$(tr "\\0" "\\n" < $p/environ 2>/dev/null) || continue; ' +
    'case "$e" in *OPENADLC_SKILL=*) printf "%s\\n" "$e"; exit 0 ;; esac; done';
  const found = await docker('exec', container, 'sh', '-c', script);
  return Object.fromEntries(
    found.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

async function main() {
  await waitForDatabase();
  const health = await fetch(`${HOSTD}/healthz`).then((response) => response.json()).catch(() => null);
  if (health?.driver !== 'docker') {
    console.log(`\nhostd at ${HOSTD} runs the ${health?.driver ?? 'unknown'} driver; this suite is for docker. Start a scratch install on the docker driver: OPENADLC_SCRATCH_DRIVER=docker tests/scratch.sh up && eval "$(tests/scratch.sh env)"\n`);
    await closePool();
    process.exit(2);
  }

  const repo = (await repos.listRepos())[0];
  const builder = repo ? await bots.getBotById(repo.ownerBotId) : null;
  if (!repo || !builder) throw new Error('no repository with an owner bot');
  console.log(`\ntask postgres checks against ${builder.name} in ${repo.name}\n`);

  const before = { setting: await repos.getTaskPostgres(repo.id), seat: (await query('select sidecar_db, max_tasks from bots where id = $1', [builder.id]))[0] };
  await query('delete from tasks');
  await query('delete from leases');
  // A seat that runs checks, two tasks at once, each in a computer of its own.
  await query('update bots set sidecar_db = true, max_tasks = 2 where id = $1', [builder.id]);

  const started = [];
  const leftovers = [];
  try {
    const path = `/v1/repos/${encodeURIComponent(repo.name)}/task-postgres`;
    const unsigned = await asPerson('PUT', path, { servers: [CORE] }, { secret: null });
    check('the setting is refused to a caller without the console secret, as a task would be', unsigned.status === 401, `status ${unsigned.status}`);
    const outside = await asPerson('PUT', path, { servers: [{ ...CORE, image: 'someone/postgres:16' }] });
    check('an image outside the allowlist is refused with what to do', outside.status === 400 && /pgvector\/pgvector:<tag> or postgres:<tag>/.test(String(outside.body.error)), String(outside.body.error ?? '').slice(0, 80));
    const saved = await asPerson('PUT', path, { servers: [CORE] });
    check('a person sets core’s server for the repository', saved.status === 200 && saved.body.taskPostgres?.servers?.[0]?.port === 55432, `status ${saved.status}`);
    check('the install says it can give a task one', saved.body.supported?.ok === true, JSON.stringify(saved.body.supported));

    const first = await startHeld(repo, builder, 970);
    started.push(first);
    check('a task starts in a computer of its own', Boolean(first.container), first.container ?? 'no container recorded');
    const second = await startHeld(repo, builder, 971);
    started.push(second);
    check('a second task at once starts in another', Boolean(second.container) && second.container !== first.container, second.container ?? 'none');
    if (!first.container || !second.container) throw new Error('the tasks did not start; the rest has nothing to check');

    const servers = [`${first.container}-pg55432`, `${second.container}-pg55432`];
    const [one, two] = await Promise.all(servers.map(inspect));
    const [computerOne, computerTwo] = await Promise.all([inspect(first.container), inspect(second.container)]);
    check('each task has its own server, running', one?.State?.Status === 'running' && two?.State?.Status === 'running', servers.join(', '));
    check(
      'each server is in its own task’s computer’s network namespace',
      one?.HostConfig?.NetworkMode === `container:${computerOne?.Id}` && two?.HostConfig?.NetworkMode === `container:${computerTwo?.Id}`,
      `${one?.HostConfig?.NetworkMode?.slice(0, 22)}…, ${two?.HostConfig?.NetworkMode?.slice(0, 22)}…`,
    );
    check(
      'no server publishes a port or joins a network',
      Object.keys(one?.HostConfig?.PortBindings ?? {}).length === 0 && Object.keys(one?.NetworkSettings?.Networks ?? {}).length === 0,
      JSON.stringify(one?.HostConfig?.PortBindings ?? {}),
    );

    const env = await sessionEnv(first.container);
    check('the session is told where its server is', env.OPENADLC_TASK_POSTGRES === '127.0.0.1:55432', env.OPENADLC_TASK_POSTGRES ?? 'unset');
    check('and gets no DATABASE_URL from OpenADLC, so the Makefile’s own defaults apply', !('DATABASE_URL' in env));

    const who = await pg(first.container, "select current_user, (select rolsuper::text from pg_roles where rolname = current_user), current_database(), host(inet_server_addr()), current_setting('port')");
    check(
      'the task reaches its server at 127.0.0.1:55432 as the configured superuser',
      !who.error && who.rows?.[0]?.join(' ') === 'core true core_db 127.0.0.1 55432',
      who.error ?? who.rows?.[0]?.join(' '),
    );
    const roles = await pg(first.container, "create role core_rw; create role core_api_rw login password 'core_api_rw'; select string_agg(rolname, ',' order by rolname) from pg_roles where rolname like 'core\\_%'");
    check('it can make server-wide roles there, as core’s migrations do', !roles.error && roles.rows?.at(-1)?.[0] === 'core_api_rw,core_rw', roles.error ?? roles.rows?.at(-1)?.[0]);
    const asRole = await pg(first.container, 'select current_user', { user: 'core_api_rw', password: 'core_api_rw' });
    check('and log in as one of them', asRole.rows?.[0]?.[0] === 'core_api_rw', asRole.error ?? asRole.rows?.[0]?.[0]);
    const wrong = await pg(first.container, 'select 1', { password: 'not-core' });
    check('a wrong password is refused, on loopback too', Boolean(wrong.error) && /password authentication failed/.test(wrong.error), wrong.error ?? JSON.stringify(wrong));

    const theirs = await pg(second.container, "select count(*) from pg_roles where rolname = 'core_rw'");
    check('the second task’s 127.0.0.1:55432 is its own server, without the first’s roles', theirs.rows?.[0]?.[0] === '0', theirs.error ?? theirs.rows?.[0]?.[0]);
    const same = await pg(second.container, "create role core_rw; select 'made'");
    check('so the same fixed role names do not collide between tasks', same.rows?.at(-1)?.[0] === 'made', same.error ?? '');
    const address = computerOne?.NetworkSettings?.Networks?.[NETWORK]?.IPAddress ?? '';
    check('the second task cannot reach the first’s server at the first computer’s address', address !== '' && !(await reaches(second.container, address, CORE.port)), `${address}:${CORE.port}`);

    await letGo(first.container);
    await cancel(first.taskId);
    const goneComputer = await waitFor(async () => (await docker('container', 'inspect', first.container)).code !== 0, 60_000);
    const goneServer = await waitFor(async () => (await docker('container', 'inspect', servers[0])).code !== 0, 10_000);
    check('the server goes with its task’s computer', Boolean(goneComputer) && Boolean(goneServer), servers[0]);
    check('and the other task’s server is still there', (await inspect(servers[1]))?.State?.Status === 'running');
    // Let go and ended before the sweep's check: a held computer's sessions
    // cannot be read, and each look waits out the read before the reaper's turn.
    await letGo(second.container);
    await cancel(second.taskId);
    const goneSecond = await waitFor(async () => (await docker('container', 'inspect', servers[1])).code !== 0, 60_000);
    check('and goes with its own computer when that task ends', Boolean(goneSecond), servers[1]);

    // A computer that went some other way — removed by hand here — leaves a
    // server in a namespace with nothing else in it: the reaper's to sweep.
    const stand = `${process.env.OPENADLC_BOT_PREFIX ?? ''}task-postgres-probe-${Date.now().toString(36)}`;
    const image = (await inspect(second.container))?.Config?.Image ?? 'openadlc-bot:latest';
    leftovers.push(stand, `${stand}-pg55432`);
    await docker('run', '-d', '--name', stand, '--entrypoint', 'sleep', image, '600');
    await docker('run', '-d', '--name', `${stand}-pg55432`, '--network', `container:${stand}`, '--label', `openadlc.install=${INSTALL}`, '--label', 'openadlc.kind=task-postgres', '--label', `openadlc.computer=${stand}`, '--label', 'openadlc.port=55432', '--entrypoint', 'sleep', image, '600');
    await docker('rm', '-f', '-v', stand);
    const swept = await waitFor(async () => (await docker('container', 'inspect', `${stand}-pg55432`)).code !== 0, 120_000, 2000);
    check('a server whose computer is gone is swept by the reaper', Boolean(swept), `${stand}-pg55432`);
  } finally {
    for (const task of started) {
      await letGo(task.container);
      if (task.taskId) await cancel(task.taskId);
    }
    // With their volumes: the bot image declares /work one, and each run left an empty one behind.
    for (const name of leftovers) await docker('rm', '-f', '-v', name);
    await repos.setTaskPostgres(repo.id, before.setting);
    await query('update bots set sidecar_db = $2, max_tasks = $3 where id = $1', [builder.id, before.seat?.sidecar_db ?? false, before.seat?.max_tasks ?? 1]);
    await query('delete from tasks');
    await query('delete from leases');
    await query('delete from issues where repo_id = $1 and number >= 970 and number < 980', [repo.id]);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} task postgres checks passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const failure of failed) console.log(`  ${failure.name}`);
  }
  console.log();
  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\ntask postgres checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});
