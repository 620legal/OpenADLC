#!/usr/bin/env node
/**
 * A person's message to a role whose task is running reaches that task's
 * session at its next turn, instead of waiting for the role's next task; one
 * its task ended before reading goes where it would have gone had it arrived
 * then; and one to a paused task waits on the thread, as before. See
 * docs/adr/0028-a-message-to-a-running-task-waits-in-its-inbox.md.
 *
 * Scripted: the scripted engine takes messages and says what it read
 * ("read a message: …"), and holds its turn open for
 * `OPENADLC_SCRIPTED_LINGER_MS` (tests/scratch.sh sets it) so there is a
 * running session to write to.
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/live-message.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bots, closePool, issues, leases, query, repos, tasks, threads, waitForDatabase } from '@openadlc/db';
import { consoleSecretRef, getSecretStore, internalSecretRef } from '@openadlc/github';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const run = promisify(execFile);
const BRIDGE = process.env.OPENADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
const HOSTD = process.env.OPENADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';
const SECRET = await getSecretStore().get(internalSecretRef());
const CONSOLE_SECRET = await getSecretStore().get(consoleSecretRef());
/** The issues this suite owns, and deletes before and after it runs. */
const NUMBERS = [961, 962];

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function hostdHeaders() {
  return { 'content-type': 'application/json', 'x-openadlc-internal-secret': SECRET ?? '' };
}

/** A person writing on an item from the console, as the console's own request does. */
async function sendMessage(subject, text, role) {
  const response = await fetch(`${BRIDGE}/v1/items/${encodeURIComponent(subject)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openadlc-identity': 'integration test',
      'x-openadlc-console-secret': CONSOLE_SECRET ?? '',
    },
    body: JSON.stringify({ text, role }),
  });
  const body = await response.text();
  return { status: response.status, body: body ? JSON.parse(body) : {} };
}

async function waitFor(predicate, timeoutMs = 30_000, everyMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return null;
}

async function runDispatcher() {
  const { stdout } = await run(process.execPath, ['apps/dispatcher/dist/main.js', '--once'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function messagesFor(botId, subjectRef) {
  const thread = (await threads.listThreadsForBot(botId)).find((entry) => entry.subject_ref === subjectRef);
  return thread ? threads.listMessages([thread.id]) : [];
}

function readyBody(what, paths) {
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
    ...paths.map((path) => `- \`${path}\``),
    '',
    '### Verification',
    '',
    'The integration suite.',
    '',
  ].join('\n');
}

async function seedIssue(repoId, number) {
  return issues.upsertIssue({
    repoId,
    number,
    title: `Integration: a message to a running build ${number}`,
    stage: 'build',
    labels: ['adlc:build', 'start:now', 'do:ai', 'priority:p1', 'area:bridge'],
    declaredPaths: [`tests/live-message-${number}/**`],
    url: null,
    prNumber: null,
    body: readyBody('A message reaches the running build.', [`tests/live-message-${number}/**`]),
  });
}

/** Stops this suite's tasks and takes away what it wrote. */
async function reset(repo) {
  const subjects = NUMBERS.map((number) => `${repo.name}#${number}`);
  const held = await query(`select id from tasks where subject_ref = any($1) and state in ('queued', 'running', 'paused')`, [subjects]);
  for (const row of held) {
    await fetch(`${HOSTD}/tasks/${row.id}/cancel`, { method: 'POST', headers: hostdHeaders(), body: JSON.stringify({ reason: 'the integration suite is resetting' }) }).catch(
      () => undefined,
    );
  }
  await waitFor(async () => {
    const left = await query(`select 1 from tasks where subject_ref = any($1) and state in ('queued', 'running')`, [subjects]);
    return left.length === 0;
  }, 20_000);
  await query('delete from task_inbox where subject_ref = any($1)', [subjects]);
  await query('delete from threads where repo_id = $1 and subject_ref = any($2)', [repo.id, subjects]);
  await query('delete from tasks where subject_ref = any($1)', [subjects]);
  await query('delete from leases where repo_id = $1 and issue_number = any($2::int[])', [repo.id, NUMBERS]);
  await query('delete from issues where repo_id = $1 and number = any($2::int[])', [repo.id, NUMBERS]);
}

/** A build of `number`, leased and running on an engine that takes messages. */
async function runningBuild(repo, number) {
  await seedIssue(repo.id, number);
  await runDispatcher();
  return waitFor(async () => {
    const found = (await tasks.listTasksOnSubjects([`${repo.name}#${number}`])).find((task) => task.kind === 'implement');
    return found && found.state === 'running' && found.takesMessages === true ? found : null;
  }, 30_000, 100);
}

async function main() {
  await waitForDatabase();
  const health = await fetch(`${BRIDGE}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`the bridge is not answering at ${BRIDGE}; start a scratch install: tests/scratch.sh up && eval "$(tests/scratch.sh env)"`);
  if (!(Number(process.env.OPENADLC_SCRIPTED_LINGER_MS) > 0)) {
    throw new Error('OPENADLC_SCRIPTED_LINGER_MS is not set, so no scripted session stays running long enough to write to: start the install with tests/scratch.sh');
  }

  const repo = (await repos.listRepos())[0];
  if (!repo) throw new Error('no repository is configured');
  const builder = await bots.getBotById(repo.ownerBotId);
  if (!builder) throw new Error('the repository has no owner bot');
  console.log(`\nlive message checks against ${repo.name}, builder ${builder.name}\n`);

  await reset(repo);
  try {
    // ------------------------------------------------- read by the running session
    console.log('a message to a running build');
    const subject = `${repo.name}#961`;
    const task = await runningBuild(repo, 961);
    if (!check('a build is running on an engine that takes messages', Boolean(task))) throw new Error('no running build to write to');

    const sent = await sendMessage(subject, 'also handle the empty state', 'implement');
    check('the message is accepted', sent.status === 200, `status ${sent.status}`);
    check('it goes to the running task, not a new one', sent.body.start?.kind === 'delivers' && sent.body.start?.taskId === task.id, JSON.stringify(sent.body.start));

    const read = await waitFor(async () => (await messagesFor(builder.id, subject)).find((message) => message.text === 'read a message: also handle the empty state'));
    check('the session’s next turn has the message in it', Boolean(read));
    const said = await messagesFor(builder.id, subject);
    check('the thread says it goes to the running session', said.some((message) => message.kind === 'sys' && / reads it at its next turn$/.test(message.text)));
    check('the thread says the session read it', said.some((message) => message.kind === 'sys' && message.text === 'read by its session'));
    const [row] = await query('select state, sender from task_inbox where task_id = $1', [task.id]);
    check('its inbox row was taken, with who sent it', row?.state === 'taken' && row?.sender === 'integration test', JSON.stringify(row ?? null));
    const ended = await waitFor(async () => {
      const current = await tasks.getTask(task.id);
      return ['done', 'failed', 'stopped', 'paused'].includes(current?.state ?? '') ? current : null;
    }, 40_000);
    check('the task ends done', ended?.state === 'done', `${ended?.state} (${ended?.exitReason})`);

    // -------------------------------------- after it ended, a message starts work
    console.log('\na message after the build ended');
    const after = await sendMessage(subject, 'one more thing', 'implement');
    check('it starts the role’s work, as before', after.body.start?.kind === 'starts', JSON.stringify(after.body.start));
    await reset(repo);

    // ----------------------------------------- the task ends before it reads it
    console.log('\na message its task ended before reading');
    const other = `${repo.name}#962`;
    const cut = await runningBuild(repo, 962);
    if (!check('a second build is running', Boolean(cut))) throw new Error('no second build to write to');
    const queued = await sendMessage(other, 'and the loading state', 'implement');
    check('it is queued for the running task', queued.body.start?.kind === 'delivers', JSON.stringify(queued.body.start));
    await fetch(`${HOSTD}/tasks/${cut.id}/cancel`, { method: 'POST', headers: hostdHeaders(), body: JSON.stringify({ reason: 'stopped by the suite before its turn ended' }) });
    // The runner's own end, or the 30 s sweep for a task cancelled under it.
    const returned = await waitFor(async () => {
      const [one] = await query('select state from task_inbox where task_id = $1', [cut.id]);
      return one?.state === 'returned' ? one : null;
    }, 45_000);
    check('the row is returned, never read', Boolean(returned));
    const restarted = await waitFor(async () => (await tasks.listTasksOnSubjects([other])).find((one) => one.kind === 'implement' && one.id !== cut.id), 30_000);
    check('the role’s work starts with it as its brief', Boolean(restarted), restarted ? `task ${restarted.id}, ${restarted.state}` : 'nothing started');
    await reset(repo);

    // --------------------------------------------------- a paused task is not live
    console.log('\na message to a paused task');
    await seedIssue(repo.id, 961);
    const pausedTask = await tasks.createTask({ botId: builder.id, repoId: repo.id, kind: 'implement', subjectType: 'issue', subjectRef: subject, skill: 'implement' });
    await tasks.updateTaskState(pausedTask.id, 'running', { takesMessages: true });
    await tasks.updateTaskState(pausedTask.id, 'paused', { exitReason: 'waiting on a person' });
    const toPaused = await sendMessage(subject, 'is this still the plan?', 'implement');
    check(
      'it is read at the next task, as before',
      toPaused.body.start?.kind === 'nothing' && /is already paused; it reads it on the thread at its next task$/.test(toPaused.body.start?.why ?? ''),
      JSON.stringify(toPaused.body.start),
    );
    const [none] = await query('select count(*)::int as n from task_inbox where task_id = $1', [pausedTask.id]);
    check('nothing is queued for it', none?.n === 0);
  } finally {
    await reset(repo);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live message checks passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const failure of failed) console.log(`  ${failure.name}`);
  }
  console.log();
  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\nlive message checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});
