#!/usr/bin/env node
/**
 * Checks what happens when a person intervenes: killing a session must leave the
 * branch and the issue alone and put the work back on the board, and restarting a
 * bot — which cancels its tasks and gives their computers back — must not lose
 * the repository's mirror.
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/kill-and-restart.mjs
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bots, closePool, issues, leases, listAudit, query, repos, tasks, waitForDatabase } from '@fleetadlc/db';
import { fleetHome, getSecretStore, internalSecretRef } from '@fleetadlc/github';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const run = promisify(execFile);
const BRIDGE = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
const HOSTD = process.env.FLEETADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';

// hostd authenticates its callers; the suite presents the same secret the bridge
// does, read from the secret store.
const SECRET = await getSecretStore().get(internalSecretRef());

function authHeaders(onBehalfOf) {
  return {
    'content-type': 'application/json',
    'x-fleetadlc-internal-secret': SECRET ?? '',
    ...(onBehalfOf ? { 'x-fleetadlc-on-behalf-of': onBehalfOf } : {}),
  };
}
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * The newest audit row now. The checks read only rows written after it: audit
 * rows outlive a run that failed partway, and a check that read the latest
 * matching row passed on the last run's.
 */
async function auditMark() {
  const rows = await query('select coalesce(max(id), 0) as id from audit');
  return Number(rows[0]?.id ?? 0);
}

async function waitFor(predicate, timeoutMs = 30_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return null;
}

async function main() {
  await waitForDatabase();

  const repo = (await repos.listRepos())[0];
  if (!repo) throw new Error('no repository is configured');
  const builder = await bots.getBotById(repo.ownerBotId);
  if (!builder) throw new Error('the repository has no owner bot');

  console.log(`\nkill and restart checks against ${builder.name}\n`);

  await query('delete from tasks');
  await query('delete from leases');
  await query(`update issues set labels = array_remove(labels, 'start:now') where repo_id = $1`, [repo.id]);

  // A long-running task to interrupt: the skill sleeps instead of finishing.
  const issue = await issues.upsertIssue({
    repoId: repo.id,
    number: 950,
    title: 'Integration: a task a person interrupts',
    stage: 'build',
    labels: ['adlc:build', 'start:now', 'do:ai', 'priority:p1'],
    declaredPaths: ['tests/kill/**'],
    url: null,
    prNumber: null,
  });

  const lease = await leases.createLease({
    repoId: repo.id,
    issueNumber: issue.number,
    botId: builder.id,
    declaredPaths: issue.declaredPaths,
    expiresAt: new Date(Date.now() + 3600_000),
  });

  const started = await fetch(`${BRIDGE}/internal/dispatch/lease`, {
    method: 'POST',
    // `/internal/dispatch/lease` starts a real task, so it is no longer served
    // to whatever reached the port.
    headers: authHeaders(),
    body: JSON.stringify({
      leaseId: lease.id,
      repo: repo.name,
      issue: issue.number,
      bot: builder.name,
      declaredPaths: issue.declaredPaths,
      expiresAt: null,
    }),
  }).then((response) => response.json());

  const taskId = started.task?.taskId;
  check('a task is running to interrupt', Boolean(taskId), started.task?.session ?? '');

  const task = await waitFor(async () => {
    const current = await tasks.getTask(taskId);
    return current?.worktree ? current : null;
  }, 20_000);
  check('the task has a worktree and a branch', Boolean(task?.worktree && task?.branch), task?.branch ?? '');

  const sessionName = task.tmuxSession?.split('/').at(-1);
  const branchExisted = task.branch;

  // What the demo repository held before the kill, so that afterwards the
  // check can say nothing was rewritten. It used to look for "fatal" in
  // `git branch --list`'s output, where git never writes it, so it passed
  // whatever happened to the repository.
  const repoPath = process.env.FLEETADLC_SCRIPTED_REPO_PATH;
  const revOf = async (ref) =>
    repoPath ? (await run('git', ['rev-parse', '--verify', '-q', ref], { cwd: repoPath }).catch(() => ({ stdout: '' }))).stdout.trim() : '';
  const mainBefore = await revOf('refs/heads/main');
  const branchBefore = branchExisted ? await revOf(`refs/heads/${branchExisted}`) : '';

  // The task may finish on its own before the kill lands: the demo skill is fast.
  // Either way, killing the session must not leave the row claiming to run.
  const beforeKill = await auditMark();
  await fetch(`${HOSTD}/bots/${builder.name}/sessions/${sessionName}/kill`, {
    method: 'POST',
    headers: authHeaders('kill test'),
    body: '{}',
  });

  const settled = await waitFor(async () => {
    const current = await tasks.getTask(taskId);
    return current && current.state !== 'running' && current.state !== 'queued' ? current : null;
  }, 30_000);

  check('the task no longer claims to be running', Boolean(settled), settled ? settled.state : 'still running');
  check(
    'the reason says what happened',
    Boolean(settled?.exitReason && settled.exitReason.length > 0),
    settled?.exitReason ?? '',
  );

  const releasedLease = await query('select state from leases where id = $1', [lease.id]);
  check(
    'the lease is no longer held, so the issue is back on the board',
    ['released', 'expired'].includes(releasedLease[0]?.state),
    releasedLease[0]?.state,
  );

  // The bare mirror is what makes the next task cheap; it must survive. There
  // is one per repository now, not one per bot.
  const workRoot = process.env.FLEETADLC_WORK_ROOT ?? join(fleetHome(), 'work');
  const mirror = join(workRoot, 'mirrors');
  check('the bare mirror survives an interrupted task', existsSync(mirror), mirror);

  const killAudit = (await listAudit(50)).filter((row) => row.id > beforeKill);
  check(
    'the kill is audited with the identity that did it',
    killAudit.some((row) => row.action === 'session.kill' && row.actor === 'kill test via platform'),
  );

  // The identity used to be a field in the body, so anything that could reach
  // the port could sign the audit log with any name it liked.
  const forgedKill = await fetch(`${HOSTD}/bots/${builder.name}/sessions/${sessionName}/kill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity: 'somebody else' }),
  });
  check('killing a session without the secret is refused', forgedKill.status === 401, `status ${forgedKill.status}`);
  check(
    'the refused kill named nobody in the audit log',
    !(await listAudit(10)).some((row) => row.actor === 'somebody else'),
  );

  // Restarting a bot cancels its tasks, which gives back their computers; the
  // repository's mirror is hostd's, not a computer's, and stays.
  const beforeRestart = await auditMark();
  const restart = await fetch(`${HOSTD}/bots/${builder.name}/restart`, {
    method: 'POST',
    headers: authHeaders('restart test'),
    body: '{}',
  });
  check('the bot restarts', restart.ok, `status ${restart.status}`);
  check('the mirror is still there after a restart', existsSync(mirror));
  // A task's directory goes with its computer: nothing of the interrupted
  // task is left under the work root's task folders.
  check('the interrupted task’s computer is given back', !existsSync(join(workRoot, 'slots', taskId)), join(workRoot, 'slots', taskId));

  const restartAudit = (await listAudit(50)).filter((row) => row.id > beforeRestart);
  check(
    'the restart is audited',
    restartAudit.some((row) => row.action === 'bot.restart' && row.actor === 'restart test via platform'),
  );

  const botAfter = await bots.getBotByName(builder.name);
  check('the bot is running again after the restart', botAfter?.status === 'running', botAfter?.status ?? '');

  // An interruption never rewrites history: main is where it was, and the
  // branch the task had pushed to, if it got that far, still holds that work.
  if (repoPath) {
    check('the demo repository’s main was not rewritten', (await revOf('refs/heads/main')) === mainBefore, mainBefore.slice(0, 7));
    if (branchBefore) {
      const branchAfter = await revOf(`refs/heads/${branchExisted}`);
      const kept =
        branchAfter !== '' &&
        (await run('git', ['merge-base', '--is-ancestor', branchBefore, branchAfter], { cwd: repoPath }).then(
          () => true,
          () => false,
        ));
      check('the branch the task pushed still holds what it pushed', kept, `${branchExisted} ${branchBefore.slice(0, 7)} → ${branchAfter.slice(0, 7) || 'gone'}`);
    }
  }

  // What was written: hostd records the identity with the principal after it.
  await query(`delete from audit where actor in ('kill test via platform', 'restart test via platform')`);
  await query('delete from tasks');
  await query('delete from leases');
  await query('delete from issues where repo_id = $1 and number >= 900', [repo.id]);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} kill and restart checks passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const failure of failed) console.log(`  ${failure.name}`);
  }
  console.log();

  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\nkill and restart checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});
