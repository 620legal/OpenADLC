#!/usr/bin/env node
/**
 * Raising a repository's concurrency is a number now: each task runs in a
 * computer of its own, and a seat runs up to its tasks at once
 * (`bots.max_tasks`). This checks that a builder with room for two takes two
 * issues at once, each in its own computer, that a second builder seat takes
 * work too, and that a third issue waits rather than going past what the
 * builders can run between them.
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/concurrency.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bots, closePool, issues, leases, query, repos, tasks, waitForDatabase } from '@fleetadlc/db';
import { getSecretStore, internalSecretRef } from '@fleetadlc/github';
import { addSecondBuilder, retireBuilder } from './second-builder.mjs';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const run = promisify(execFile);
const HOSTD = process.env.FLEETADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';
const SECRET = await getSecretStore().get(internalSecretRef());

function hostdHeaders() {
  return { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': SECRET ?? '' };
}

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function runDispatcher() {
  const { stdout } = await run(process.execPath, ['apps/dispatcher/dist/main.js', '--once'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/**
 * A body with the four sections a builder is briefed from. The dispatcher will
 * not lease an issue without them — that is its readiness guard — so a fixture that
 * omits them is testing the guard rather than what it claims to test.
 */
function readyBody(what, paths = []) {
  return [
    '### Outcome',
    '',
    what,
    '',
    '### Acceptance criteria',
    '',
    '- It does the thing.',
    '',
    '### Expected paths',
    '',
    // The paths the lease holds the work to, as the issue declares them: a
    // line that names no path is sent back to intake to be rewritten.
    ...(paths.length > 0 ? paths.map((path) => `- \`${path}\``) : ['_No response_']),
    '',
    '### Verification',
    '',
    'The integration suite.',
    '',
  ].join('\n');
}

async function seedIssue(repoId, number, paths) {
  return issues.upsertIssue({
    repoId,
    number,
    title: `Integration: concurrency ${number}`,
    stage: 'build',
    labels: ['adlc:build', 'start:now', 'do:ai', 'priority:p1', 'area:bridge'],
    declaredPaths: paths,
    url: null,
    prNumber: null,
    body: readyBody(`concurrency ${number}`, paths),
  });
}

/**
 * Ends on hostd whatever it is still holding, and waits until it says so.
 *
 * Deleting a task row does not reach hostd: its in-memory map is what enforces
 * one-task-per-container, so a row deleted out from under it leaves that bot
 * looking busy. Cancelling only the rows that *say* they are running is not
 * enough either — a task hostd still holds whose row already reads `done` is
 * exactly the case that leaks. So every row is cancelled regardless of state
 * (a cancel for something hostd is not holding is a no-op), and then we wait on
 * hostd's own count rather than on the observer's ten-second reconcile.
 */
async function releaseRunningTasks() {
  const held = await query('select id from tasks');
  for (const row of held) {
    await fetch(`${HOSTD}/tasks/${row.id}/cancel`, {
      method: 'POST',
      headers: hostdHeaders(),
      body: JSON.stringify({ reason: 'the integration suite is resetting' }),
    }).catch(() => undefined);
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${HOSTD}/healthz`).then((r) => r.json()).catch(() => null);
    if (!health || health.activeTasks === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function reset(repoId) {
  await releaseRunningTasks();
  await query('delete from gates');
  await query('delete from sessions');
  await query('delete from tasks');
  await query('delete from leases');
  await query('delete from issues where repo_id = $1 and number >= 900', [repoId]);
  await query(`update issues set labels = array_remove(labels, 'start:now') where repo_id = $1`, [repoId]);
}

const tmuxBin = process.env.FLEETADLC_TMUX_BIN ?? 'tmux';

async function listTmuxSessions() {
  try {
    const { stdout } = await run(tmuxBin, ['list-sessions', '-F', '#{session_name}']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function killTmuxSession(name) {
  await run(tmuxBin, ['kill-session', '-t', `=${name}`]).catch(() => undefined);
}

async function listHostSessions(bot) {
  const response = await fetch(`${HOSTD}/bots/${encodeURIComponent(bot)}/sessions`, {
    headers: hostdHeaders(),
  }).catch(() => null);
  if (!response?.ok) return [];
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body.sessions) ? body.sessions : [];
}

async function killHostSession(bot, session) {
  await fetch(`${HOSTD}/bots/${encodeURIComponent(bot)}/sessions/${encodeURIComponent(session)}/kill`, {
    method: 'POST',
    headers: hostdHeaders(),
  }).catch(() => undefined);
}

/** What retiring the second builder reaches on a live install. */
const liveRetireDeps = {
  query,
  listHostSessions,
  killHostSession,
  listTmuxSessions,
  killTmuxSession,
};

async function main() {
  await waitForDatabase();

  const repo = (await repos.listRepos())[0];
  if (!repo) throw new Error('no repository is configured');
  const owner = await bots.getBotById(repo.ownerBotId);
  if (!owner) throw new Error('the repository has no owner bot');

  console.log(`\nconcurrency checks on ${repo.name}, owner ${owner.name}\n`);
  const originalConcurrency = repo.concurrency;
  const originalMaxTasks = owner.maxTasks ?? 1;
  // Set only once this run has inserted the second builder: the one bot the
  // suite may retire at the end.
  let created = null;

  try {
    // ------------------------------------------------ concurrency 2, one builder
    await reset(repo.id);
    await repos.updateRepoSettings(repo.name, { concurrency: 2 });
    await seedIssue(repo.id, 921, ['tests/one/**']);
    await seedIssue(repo.id, 922, ['tests/two/**']);

    await query('update bots set max_tasks = 1 where id = $1', [owner.id]);
    const missingSecond = await runDispatcher();
    check(
      'says what is missing when concurrency outruns what the builders run between them',
      /combined maxTasks is 1/.test(missingSecond),
      missingSecond.split('\n').find((line) => line.includes('maxTasks'))?.trim() ?? '',
    );
    check(
      'still leases what the one builder can take',
      /leased .*#921/.test(missingSecond),
      'the first issue went out',
    );

    // ------------------------------------------------ one builder, two at once
    await reset(repo.id);
    await query('update bots set max_tasks = 2 where id = $1', [owner.id]);
    await seedIssue(repo.id, 931, ['tests/eleven/**']);
    await seedIssue(repo.id, 932, ['tests/twelve/**']);
    await seedIssue(repo.id, 933, ['tests/thirteen/**']);

    await runDispatcher();
    const onOneSeat = await leases.listActiveLeases(repo.id);
    check('one builder with room for two takes two issues at once', onOneSeat.length === 2, `${onOneSeat.length} active lease(s)`);
    check('both are its own', onOneSeat.every((lease) => lease.botId === owner.id));
    check('the third issue waits', !onOneSeat.some((lease) => lease.issueNumber === 933));
    // Both have to have started before their sessions are compared: two
    // tasks with none yet were two empty sets, equal, and the check passed.
    let twoTasks = [];
    for (let attempt = 0; attempt < 120 && twoTasks.length < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
      twoTasks = (await tasks.listTasks({ botId: owner.id, states: ['queued', 'running'], limit: 10 })).filter((task) => task.tmuxSession);
    }
    check(
      'each runs in a computer and a session of its own',
      twoTasks.length === 2 &&
        new Set(twoTasks.map((task) => task.tmuxSession)).size === 2 &&
        new Set(twoTasks.map((task) => task.worktree)).size === 2,
      twoTasks.map((task) => task.tmuxSession).join(', ') || 'neither started within 30 seconds',
    );
    await query('update bots set max_tasks = 1 where id = $1', [owner.id]);

    // ------------------------------------------------ add the second builder
    await reset(repo.id);
    const added = await addSecondBuilder(owner, bots);
    const second = added.bot;
    if (added.created) created = second.name;
    check(
      'a second builder seat exists',
      Boolean(second.id),
      added.created ? second.name : `${second.name}, already configured; left in place afterwards`,
    );

    await seedIssue(repo.id, 923, ['tests/three/**']);
    await seedIssue(repo.id, 924, ['tests/four/**']);
    await seedIssue(repo.id, 925, ['tests/five/**']);

    const twoAtOnce = await runDispatcher();
    const active = await leases.listActiveLeases(repo.id);
    const holders = new Set(active.map((lease) => lease.botId));

    check('two issues are leased at once', active.length === 2, `${active.length} active lease(s)`);
    check('they are held by two different seats', holders.size === 2, `${holders.size} distinct builder(s)`);
    check(
      'the second builder took one of them',
      active.some((lease) => lease.botId === second.id),
      twoAtOnce
        .split('\n')
        .filter((line) => line.includes('leased'))
        .map((line) => line.trim().split('→')[1]?.trim().split(':')[0])
        .join(', '),
    );
    check('the third issue waits', !active.some((lease) => lease.issueNumber === 925));

    const running = await tasks.listTasks({ limit: 10 });
    const perBot = new Map();
    for (const task of running) {
      if (['running', 'queued'].includes(task.state)) {
        perBot.set(task.botId, (perBot.get(task.botId) ?? 0) + 1);
      }
    }
    check(
      'no seat runs more tasks than its tasks at once',
      [...perBot.values()].every((count) => count <= 1),
      [...perBot.values()].join(', ') || 'none running',
    );

    // ------------------------------------------------ back to one
    await reset(repo.id);
    await repos.updateRepoSettings(repo.name, { concurrency: 1 });
    await seedIssue(repo.id, 926, ['tests/six/**']);
    await seedIssue(repo.id, 927, ['tests/seven/**']);

    await runDispatcher();
    const afterLowering = await leases.listActiveLeases(repo.id);
    check(
      'lowering concurrency goes back to one at a time',
      afterLowering.length === 1,
      `${afterLowering.length} active lease(s)`,
    );
    // ------------------------------------- overlap with an open pull request
    // Overlap was checked only against other leases' declared paths. A pull
    // request that is open but whose implement task has ended claimed nothing,
    // so a second issue touching the same files could go out and the two would
    // meet as a merge conflict a bot cannot resolve.
    await reset(repo.id);
    await repos.updateRepoSettings(repo.name, { concurrency: 1 });

    // An issue whose pull request is open and touches src/shared/**.
    await issues.upsertIssue({
      repoId: repo.id,
      number: 926,
      title: 'Integration: a change already in review',
      stage: 'review',
      labels: ['adlc:review', 'do:ai'],
      declaredPaths: ['src/shared/**'],
      url: null,
      prNumber: 8261,
    });
    await issues.setPullRequestPaths(repo.id, 926, ['src/shared/config.ts']);

    // A new issue that would touch the same file. No lease claims it — the
    // implement task behind #926 is over — so only the pull request stands
    // between them.
    await seedIssue(repo.id, 927, ['src/shared/**']);
    const collided = await runDispatcher();
    const afterCollision = await leases.listActiveLeases(repo.id);
    check(
      'an issue overlapping an open pull request is not leased',
      !afterCollision.some((lease) => lease.issueNumber === 927),
      collided
        .split('\n')
        .filter((line) => line.includes('#927'))
        .map((line) => line.trim())
        .join(' ') || 'nothing said about #927',
    );

    // And the guard is not simply refusing everything.
    await seedIssue(repo.id, 928, ['docs/elsewhere/**']);
    await runDispatcher();
    const afterClear = await leases.listActiveLeases(repo.id);
    check(
      'an issue that touches nothing in flight still goes out',
      afterClear.some((lease) => lease.issueNumber === 928),
      afterClear.map((lease) => lease.issueNumber).join(', ') || 'none',
    );
  } finally {
    try {
      await reset(repo.id);
      await repos.updateRepoSettings(repo.name, { concurrency: originalConcurrency });
    } finally {
      await query('update bots set max_tasks = $2 where id = $1', [owner.id, originalMaxTasks]);
      if (created) {
        const orphans = await retireBuilder(created, liveRetireDeps);
        check(
          'no tmux session outlives the bot row it belongs to',
          orphans.length === 0,
          orphans.join(', ') || 'none',
        );
      }
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} concurrency checks passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const failure of failed) console.log(`  ${failure.name}`);
  }
  console.log();

  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\nconcurrency checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});
