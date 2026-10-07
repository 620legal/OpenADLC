#!/usr/bin/env node
/**
 * What only a real Docker daemon can say about a task's computer under the
 * docker driver: that each task gets a container of its own on the install's
 * network, that two tasks on that network cannot reach each other, that the
 * task database server is reachable from a task and nothing else of the host
 * is mounted, that the container and its database go when the task ends, and
 * how long a cold start takes. The unit tests drive the driver against a
 * Docker that answers from a script; this is the claim they cannot make
 * (docs/unverified.md lists it).
 *
 * It starts real containers, so it runs only when asked:
 *
 *   FLEETADLC_DOCKER_COMPUTERS=1 node tests/all.mjs
 *   FLEETADLC_SCRATCH_DRIVER=docker tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/docker-computers.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bots, closePool, issues, leases, query, repos, waitForDatabase } from '@fleetadlc/db';
import { fleetHome, getSecretStore, internalSecretRef } from '@fleetadlc/github';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const run = promisify(execFile);
const BRIDGE = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
const HOSTD = process.env.FLEETADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';
const SECRET = await getSecretStore().get(internalSecretRef());
const NETWORK = process.env.FLEETADLC_BOT_PREFIX ? `${process.env.FLEETADLC_BOT_PREFIX}tasks` : 'fleetadlc-tasks';
const TASKDB = process.env.FLEETADLC_BOT_PREFIX ? `${process.env.FLEETADLC_BOT_PREFIX}taskdb` : 'fleetadlc-taskdb';
const workRoot = process.env.FLEETADLC_WORK_ROOT ?? join(fleetHome(), 'work');

const headers = { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': SECRET ?? '' };
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function docker(...args) {
  try {
    const { stdout } = await run('docker', args, { maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim() };
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

/** Leases an issue to the bot and starts its task through the bridge, as the dispatcher would. */
async function startTask(repo, bot, number) {
  const issue = await issues.upsertIssue({
    repoId: repo.id,
    number,
    title: `Integration: a computer of its own ${number}`,
    stage: 'build',
    labels: ['adlc:build', 'start:now', 'do:ai', 'priority:p1'],
    declaredPaths: [`tests/computers/${number}/**`],
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
  const started = Date.now();
  const answer = await fetch(`${BRIDGE}/internal/dispatch/lease`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ leaseId: lease.id, repo: repo.name, issue: issue.number, bot: bot.name, botId: bot.id, declaredPaths: issue.declaredPaths, expiresAt: null }),
  }).then((response) => response.json());
  const taskId = answer.task?.taskId ?? null;
  const ready = taskId
    ? await waitFor(async () => {
        const rows = await query('select container, state from tasks where id = $1', [taskId]);
        return rows[0]?.container && rows[0].state === 'running' ? rows[0] : null;
      })
    : null;
  return { taskId, container: ready?.container ?? null, ms: Date.now() - started };
}

async function cancel(taskId) {
  await fetch(`${HOSTD}/tasks/${taskId}/cancel`, { method: 'POST', headers, body: JSON.stringify({ reason: 'the docker computers suite is done' }) }).catch(() => undefined);
}

/** Whether a TCP connection from inside a container to an address opens within three seconds. */
async function reaches(container, host, port) {
  const script = `const s=require('net').connect(${port},${JSON.stringify(host)});s.setTimeout(3000);s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(2));s.on('error',()=>process.exit(1));`;
  return (await docker('exec', container, 'node', '-e', script)).code === 0;
}

async function main() {
  await waitForDatabase();
  const health = await fetch(`${HOSTD}/healthz`).then((response) => response.json()).catch(() => null);
  if (health?.driver !== 'docker') {
    console.log(`\nhostd at ${HOSTD} runs the ${health?.driver ?? 'unknown'} driver; this suite is for docker. Start a scratch install on the docker driver: FLEETADLC_SCRATCH_DRIVER=docker tests/scratch.sh up && eval "$(tests/scratch.sh env)"\n`);
    await closePool();
    process.exit(2);
  }

  const repo = (await repos.listRepos())[0];
  const builder = repo ? await bots.getBotById(repo.ownerBotId) : null;
  if (!repo || !builder) throw new Error('no repository with an owner bot');
  console.log(`\ndocker computer checks against ${builder.name} in ${repo.name}\n`);

  await query('delete from tasks');
  await query('delete from leases');
  // Two tasks of one seat at once, each in a computer of its own.
  await query('update bots set max_tasks = 2 where id = $1', [builder.id]);

  const started = [];
  try {
    const first = await startTask(repo, builder, 960);
    started.push(first);
    check('a task gets a container of its own', Boolean(first.container), first.container ?? 'no container recorded');
    if (first.container) console.log(`        cold start: ${(first.ms / 1000).toFixed(1)}s from the lease to a running session`);

    if (first.container) {
      const inspected = JSON.parse((await docker('container', 'inspect', first.container)).stdout || '[]')[0] ?? {};
      const labels = inspected.Config?.Labels ?? {};
      check('it is labelled a computer of this install', labels['fleetadlc.kind'] === 'computer' && Boolean(labels['fleetadlc.install']), JSON.stringify(labels['fleetadlc.install']));
      check('it is on the install’s task network', Object.keys(inspected.NetworkSettings?.Networks ?? {}).includes(NETWORK));
      const slot = labels['fleetadlc.slot'] ?? '';
      const binds = (inspected.HostConfig?.Binds ?? []).filter((bind) => bind.startsWith(workRoot));
      check('only its own task directory of the work root is mounted, at its own path', binds.length === 1 && binds[0] === `${slot}:${slot}`, binds.join(', '));
      check('the task database server is reachable from it', await reaches(first.container, 'host.docker.internal', 47433));
    }

    const network = JSON.parse((await docker('network', 'inspect', NETWORK)).stdout || '[]')[0] ?? {};
    check('the task network does not let its containers reach each other', network.Options?.['com.docker.network.bridge.enable_icc'] === 'false');

    const second = await startTask(repo, builder, 961);
    started.push(second);
    check('a second task of the same seat gets a second container', Boolean(second.container) && second.container !== first.container, second.container ?? 'none');
    if (first.container && second.container) {
      const ip = (await docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, second.container)).stdout;
      await docker('exec', '-d', second.container, 'node', '-e', "require('net').createServer(()=>{}).listen(4000)");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      check('one task cannot reach another’s container', ip !== '' && !(await reaches(first.container, ip, 4000)), ip);
    }

    if (first.taskId && first.container) {
      await cancel(first.taskId);
      const gone = await waitFor(async () => (await docker('container', 'inspect', first.container)).code !== 0, 30_000);
      check('the container goes when its task ends', Boolean(gone));
      const slot = join(workRoot, 'slots', first.taskId);
      check('its directory goes with it', !existsSync(slot), slot);
      const name = `t_${first.taskId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
      const left = await docker('exec', TASKDB, 'psql', '-U', 'fleetadlc', '-d', 'postgres', '-tAc', `select 1 from pg_database where datname = '${name}'`);
      check('its database goes with it', left.stdout === '', name);
    }
  } finally {
    for (const task of started) if (task.taskId) await cancel(task.taskId);
    await query('update bots set max_tasks = 1 where id = $1', [builder.id]);
    await query('delete from tasks');
    await query('delete from leases');
    await query('delete from issues where repo_id = $1 and number >= 900', [repo.id]);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} docker computer checks passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const failure of failed) console.log(`  ${failure.name}`);
  }
  console.log();
  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\ndocker computer checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});
