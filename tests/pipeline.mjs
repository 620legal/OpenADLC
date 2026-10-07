#!/usr/bin/env node
/**
 * Integration checks for the pipeline, against a real database and a running
 * bridge and hostd. These cover the behaviour that only appears when the pieces
 * are wired together: a lease turning into a session, a cap stopping a task, a
 * budget stopping the dispatcher, and two overlapping issues not running at once.
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/pipeline.mjs
 */
import {
  bots,
  mergeLines,
  closePool,
  costs,
  getPool,
  issues,
  leases,
  query,
  repos,
  settings,
  spendingLimits,
  tasks,
  threads,
  waitForDatabase,
} from '@fleetadlc/db';
import { connect } from 'node:net';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { consoleSecretRef, getSecretStore, fleetHome, internalSecretRef, webhookSecretRef } from '@fleetadlc/github';
import { join } from 'node:path';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const BRIDGE = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
const HOSTD = process.env.FLEETADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';
const SECRET = await getSecretStore().get(internalSecretRef());
// `/v1` is served only to the console and the CLI, which hold this; the suite reads it as they do.
const CONSOLE_SECRET = await getSecretStore().get(consoleSecretRef());

/** hostd refuses a caller without the install's secret. */
function hostdHeaders() {
  return { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': SECRET ?? '' };
}

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n${name}`);
}

/** A request fetch() will not make: the Host header has to be invalid. */
function rawRequest(port, raw) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(raw));
    const done = () => {
      socket.destroy();
      resolve();
    };
    socket.on('data', done);
    socket.on('error', done);
    socket.on('close', () => resolve());
    setTimeout(done, 1500);
  });
}

function check(name, ok, detail = '') {
  results.push({ section: currentSection, name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * Notifications the bridge decided to send, newest first.
 *
 * Read from the event log rather than the bridge's log file: where that file
 * lives depends on how the install was started, and CI starts its services
 * itself. A check that passes locally and fails on the runner for that reason
 * is testing the harness, not the platform.
 */
async function notificationsSince(id) {
  const rows = await query(
    `select id, type, payload from events where source = 'platform' and type like 'notify.%' and id > $1 order by id`,
    [id],
  );
  return rows;
}

async function latestEventId() {
  const rows = await query('select coalesce(max(id), 0) as id from events');
  return Number(rows[0]?.id ?? 0);
}

async function post(path, body) {
  const response = await fetch(`${path.startsWith('http') ? path : BRIDGE + path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fleetadlc-identity': 'integration test',
      // `/internal` is no longer served to whatever reached the port, so the
      // suite holds the secret the way the dispatcher and hostd do.
      'x-fleetadlc-internal-secret': SECRET ?? '',
      'x-fleetadlc-console-secret': CONSOLE_SECRET ?? '',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function get(path) {
  const response = await fetch(path.startsWith('http') ? path : BRIDGE + path, {
    headers: { 'x-fleetadlc-identity': 'integration test', 'x-fleetadlc-console-secret': CONSOLE_SECRET ?? '' },
  });
  return { status: response.status, body: await response.json() };
}

/**
 * The secret the running bridge will verify against.
 *
 * The secret store's wins over the environment, which is how the console
 * configures one without a restart. A scripted install may have none yet;
 * storing one here is what lets the rest of the suite sign. The value is a
 * signing key and is not printed.
 */
let webhookSigningSecret;
/** Whether that secret is one this suite wrote, and so has to take back. */
let suiteStoredSecret = false;

function secretFromInstallFile() {
  const path = join(fleetHome(), 'install.json');
  if (!existsSync(path)) return '';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.webhookSecret === 'string' ? parsed.webhookSecret : '';
  } catch {
    return '';
  }
}

async function signingSecret() {
  if (webhookSigningSecret) return webhookSigningSecret;

  // The settings table is an older bridge's place for it, until it next starts.
  const stored =
    (await getSecretStore()
      .get(webhookSecretRef())
      .catch(() => null)) ?? (await settings.getSetting('webhookSecret').catch(() => null));
  if (stored) {
    webhookSigningSecret = stored;
    return stored;
  }

  const fromEnv = process.env.FLEETADLC_WEBHOOK_SECRET || secretFromInstallFile();
  if (fromEnv) {
    webhookSigningSecret = fromEnv;
    return fromEnv;
  }

  const generated = randomBytes(32).toString('hex');
  try {
    await getSecretStore().set(webhookSecretRef(), generated);
  } catch {
    // The error can quote the value, which would print the signing key.
    throw new Error('could not store a webhook secret for the suite');
  }
  webhookSigningSecret = generated;
  suiteStoredSecret = true;
  return generated;
}

/**
 * Removes the secret the suite stored, so the install is left as it was found.
 * Only while it is still that value: one somebody saved since is theirs.
 */
async function forgetSuiteSecret() {
  if (!suiteStoredSecret) return;
  const store = getSecretStore();
  const now = await store.get(webhookSecretRef()).catch(() => null);
  if (now === webhookSigningSecret) await store.delete(webhookSecretRef()).catch(() => undefined);
}

function signBody(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * One GitHub delivery, in the shape the app's webhook sends it.
 *
 * Signed by default. `signed: false` is the forged-delivery case: no
 * `X-Hub-Signature-256` at all. `signature` sends a specific header, which is
 * how a delivery signed with the wrong key is refused.
 */
async function webhook(event, payload, options = {}) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'x-github-event': event };
  if (typeof options.signature === 'string') headers['x-hub-signature-256'] = options.signature;
  else if (options.signed !== false) headers['x-hub-signature-256'] = signBody(body, await signingSecret());

  const response = await fetch(`${BRIDGE}/webhooks/github`, {
    method: 'POST',
    headers,
    body,
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function waitFor(predicate, timeoutMs = 20_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return null;
}

/**
 * Clears this run's rows and makes the seeded demo cards unroutable, so the only
 * work the dispatcher can see is the work a check just created.
 */
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

async function resetPipelineState(repoId) {
  await releaseRunningTasks();
  await query('delete from gates');
  // A thread is unique on (bot, subject), and every section reuses the same
  // subjects (`#901` and the rest). Leaving the rows means the transcript is
  // every run this database has ever seen, and a check that reads a position
  // — or the first row that matches — is describing an older run. Messages
  // belong to the thread and go with it. Gates are already gone; the only
  // other reference is set null. Only the suite's own subjects — the issues
  // numbered from 900 that it deletes below, the pull requests it invents,
  // and the testing environment — so a real conversation in the same
  // repository is not wiped by running the suite.
  await query(`delete from threads where repo_id = $1 and subject_ref ~ '#(9[0-9]{2}|[0-9]{4,}|testing)$'`, [repoId]);
  await query('delete from session_log');
  await query('delete from sessions');
  await query('delete from tasks');
  await query('delete from leases');
  await query('delete from ledger');
  await query('delete from issues where repo_id = $1 and number >= 900', [repoId]);
  await query(`update issues set labels = array_remove(labels, 'start:now') where repo_id = $1`, [repoId]);
  // Demo issues can steal the pipeline tests. Dropping `start:now` above keeps
  // them out of the dispatcher's way; this keeps them out of the stage sweep's.
  //
  // The sweep staffs a stage in board order — priority, then age — and a stage
  // has one bot, so the seeded `priority:p1` that has sat in Spec since the
  // install came up takes the spec bot and the fixture filed a second ago never
  // starts. The board used to be ordered by `updated_at desc`, which put the
  // fixture on top by accident of being newest; that is not a property a test
  // should rest on. Stripping the priority makes a seeded card sort last, which
  // is where a card nobody has prioritised belongs anyway.
  await query(
    `update issues
        set labels = array(select label from unnest(labels) as label where label not like 'priority:%')
      where repo_id = $1 and number < 900`,
    [repoId],
  );
  await costs.refreshBudget(costs.currentPeriod(), 0.9);
}

/** The transcript for one subject, oldest first. Empty when that bot has no thread for it. */
async function messagesFor(botId, subjectRef) {
  const thread = (await threads.listThreadsForBot(botId)).find((entry) => entry.subject_ref === subjectRef);
  return thread ? threads.listMessages([thread.id]) : [];
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

async function seedIssue(repoId, number, title, declaredPaths, labels = []) {
  return issues.upsertIssue({
    repoId,
    number,
    title,
    stage: 'build',
    labels: ['adlc:build', 'start:now', 'do:ai', 'priority:p1', 'area:bridge', ...labels],
    declaredPaths,
    url: null,
    prNumber: null,
    body: readyBody(title, declaredPaths),
  });
}

/**
 * The newest audit row now. A check reads only rows written after it: audit
 * rows outlive a run that failed partway, and a check that read the latest
 * matching row passed on the last run's.
 */
async function auditMark() {
  const rows = await query('select coalesce(max(id), 0) as id from audit');
  return Number(rows[0]?.id ?? 0);
}

/** Audit rows written since `mark`, newest first. */
async function auditSince(mark) {
  return query('select id, actor, action, target, payload from audit where id > $1 order by id desc', [mark]);
}

async function runDispatcher() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ['apps/dispatcher/dist/main.js', '--once'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function main() {
  await waitForDatabase();
  getPool();

  const health = await get(`${BRIDGE}/healthz`).catch(() => null);
  if (!health || health.status !== 200) {
    throw new Error(`the bridge is not answering at ${BRIDGE}; start a scratch install: tests/scratch.sh up && eval "$(tests/scratch.sh env)"`);
  }
  const hostHealth = await get(`${HOSTD}/healthz`).catch(() => null);
  if (!hostHealth || hostHealth.status !== 200) {
    throw new Error(`hostd is not answering at ${HOSTD}; start a scratch install: tests/scratch.sh up && eval "$(tests/scratch.sh env)"`);
  }

  const repo = (await repos.listRepos())[0];
  if (!repo) throw new Error('no repository is configured');
  const builder = await bots.getBotById(repo.ownerBotId);
  if (!builder) throw new Error('the repository has no owner bot');

  console.log(`\npipeline checks against ${repo.name}, builder ${builder.name}\n`);

  // ---------------------------------------------------------------- lease to task
  section('a routable issue becomes a running task');
  await resetPipelineState(repo.id);
  await seedIssue(repo.id, 901, 'Integration: a routable issue is leased and run', ['tests/integration/**']);

  const dispatchOutput = await runDispatcher();
  check('the dispatcher leases the issue', /leased .*#901/.test(dispatchOutput), dispatchOutput.trim().split('\n').at(-1));

  const lease = await waitFor(async () => leases.getActiveLease(repo.id, 901));
  check('a lease row exists for the issue', Boolean(lease), lease ? `state ${lease.state}` : '');
  check('the lease records the declared paths', lease?.declaredPaths.includes('tests/integration/**'));
  check('the lease is held by the repository owner', lease?.botId === builder.id, builder.name);

  const task = await waitFor(async () => {
    const all = await tasks.listTasks({ botId: builder.id, limit: 10 });
    return all.find((entry) => entry.subjectRef === `${repo.name}#901`) ?? null;
  });
  if (!check('a task was opened for the issue', Boolean(task), task ? `kind ${task.kind}` : '')) {
    throw new Error('no task was opened, so the rest of this section cannot be checked');
  }
  check('the task branched under agent/', task.branch?.startsWith(`agent/${builder.name}/901-`) ?? false, task.branch ?? '');
  check('the task is bound to the lease', Boolean(lease) && task.leaseId === lease.id);

  // A task given only its skill knows the procedure and not the work, so what it
  // was briefed with is checked here rather than left to be discovered in use.
  const briefing = await waitFor(async () => {
    const said = await messagesFor(builder.id, `${repo.name}#901`);
    if (said.length === 0) return null;
    // The latest reading this task posted. A subject is reused every run, so
    // the oldest "reading" line in a thread that was not cleared is a previous
    // run, and the two only coincide on a fresh database.
    const readings = said.filter((message) => message.text.startsWith('reading'));
    return readings[readings.length - 1]?.text ?? null;
  }, 30_000);
  check('the task says what it was briefed with', Boolean(briefing), briefing ?? 'it never said');
  // `implement.md`, not `builder.md`: a role resolves to `crew/roles/<role>.md` and
  // nothing maps one role onto another's playbook any more. The name is
  // asserted rather than merely "some playbook", because the bug this replaced
  // was a bot being briefed as the wrong role — which a looser check passes.
  check('the bot reads the playbook for its role', briefing?.includes('implement.md') ?? false, briefing ?? '');
  check("the bot reads the repository's notes to agents", briefing?.includes('AGENTS.md') ?? false, briefing ?? '');

  const finished = await waitFor(async () => {
    const current = await tasks.getTask(task.id);
    return ['done', 'paused', 'failed', 'stopped'].includes(current?.state ?? '') ? current : null;
  }, 40_000);
  check('the task reaches a terminal state', Boolean(finished), finished ? `${finished.state} (${finished.exitReason})` : 'still running');
  check('the task ended as done', finished?.state === 'done', finished?.exitReason ?? '');
  check('the task recorded what it spent', (finished?.costUsd ?? 0) > 0, `$${finished?.costUsd ?? 0}`);

  const ledger = await costs.listLedger(10);
  check(
    'the ledger holds the engine invocation',
    ledger.some((entry) => entry.taskId === task.id),
    ledger[0] ? `${ledger[0].tokensIn} in, ${ledger[0].tokensOut} out` : '',
  );

  const messages = await messagesFor(builder.id, `${repo.name}#901`);
  check('the bot narrated its work in the thread', messages.length >= 2, `${messages.length} messages`);
  // The thread was cleared at the start of this run, so the first row is this
  // task's opening line — and it carries the task's id, which is what makes
  // it this run's rather than a previous one's.
  const first = messages[0];
  const opening =
    first?.kind === 'sys' && first.payload?.taskId === task.id && /engine .* cap \$/.test(first.note ?? '')
      ? first
      : null;
  check(
    'the first message says what started, with the engine and the cap',
    Boolean(opening),
    opening?.note ?? 'this task never said what started',
  );

  // The plan marker is asserted here, on the task that posts it, rather than
  // by searching every thread the bot has ever had. A later section resets
  // the thread, and a match against whatever is still lying around passes on
  // a database that has run before and fails on one that has not.
  const plan = messages.find((message) => message.payload?.event === 'plan_posted');
  check('the plan comment reaches the thread as its own kind', plan?.kind === 'draft', plan?.kind ?? 'absent');
  check('the plan says what it is', plan?.note === 'posted the plan', plan?.note ?? '');

  const worktreeGone = await waitFor(async () => {
    const { existsSync } = await import('node:fs');
    return finished?.worktree && !existsSync(finished.worktree) ? true : null;
  }, 10_000);
  check('the worktree is released when the task ends', worktreeGone === true, finished?.worktree ?? '');

  // ------------------------------------------------------------- the spec stage
  section('an issue can leave the spec stage');
  await resetPipelineState(repo.id);

  const specBot = (await bots.listBots()).find((entry) => entry.role === 'spec');
  if (!specBot) throw new Error('no spec bot is configured');

  await issues.upsertIssue({
    repoId: repo.id,
    number: 910,
    title: 'Integration: a spec issue is picked up and handed on',
    stage: 'spec',
    labels: ['adlc:spec', 'do:ai', 'priority:p1', 'touches:schema'],
    declaredPaths: ['packages/db/migrations/**'],
    url: null,
    prNumber: null,
  });

  // The sweep is what catches an issue the webhook never reported, which is the
  // case an hourly job exists for.
  const swept = await post('/internal/schedule/stages');
  check(
    'the sweep finds an issue waiting in spec with nobody on it',
    swept.body.actions?.some((line) => line.includes('#910')) ?? false,
    swept.body.actions?.[0] ?? 'nothing was swept',
  );

  const specTask = await waitFor(async () => {
    const all = await tasks.listTasks({ botId: specBot.id, limit: 20 });
    return all.find((entry) => entry.subjectRef === `${repo.name}#910`) ?? null;
  });
  check('a spec task is opened for the issue', Boolean(specTask), specTask ? `kind ${specTask.kind}` : '');

  const specDone = specTask
    ? await waitFor(async () => {
        const current = await tasks.getTask(specTask.id);
        return ['done', 'paused', 'failed', 'stopped'].includes(current?.state ?? '') ? current : null;
      }, 40_000)
    : null;
  check('the spec task finishes', specDone?.state === 'done', specDone?.exitReason ?? 'never finished');

  const handedOn = await waitFor(async () => {
    const current = (await issues.listIssues(repo.name)).find((entry) => entry.number === 910);
    return current?.stage === 'build' ? current : null;
  }, 15_000);
  check('the issue moves on to build when the spec task ends', Boolean(handedOn), handedOn?.stage ?? 'still in spec');

  // A task that finished has no session either, because its own cleanup killed
  // it. hostd stops tasks whose sessions have gone, and on a slow tick that
  // arrived after the spec task reported `done` and rewrote it to `stopped` —
  // losing the verdict the task itself gave.
  const ended = await tasks.listTasks({ states: ['done'], limit: 5 });
  const verdict = ended[0];
  if (verdict) {
    const overwritten = await tasks.stopIfRunning(verdict.id, 'a late tick found no session');
    const after = await tasks.getTask(verdict.id);
    check('a finished task keeps the ending it reported', overwritten === null && after?.state === 'done', after?.state ?? '');
  }

  // ------------------------------------------------------------- the merge line
  section('pull requests land one at a time, reverts first');
  await query('delete from merge_lines');

  await mergeLines.enter({ repoId: repo.id, prNumber: 801, headSha: 'aaa1111' });
  await mergeLines.enter({ repoId: repo.id, prNumber: 802, headSha: 'bbb2222' });
  const queued = await mergeLines.line(repo.id);
  check('eligible pull requests queue in the order they became eligible', queued.map((entry) => entry.prNumber).join(',') === '801,802', queued.map((entry) => entry.prNumber).join(','));

  // Testing is broken and the revert is the only change that matters.
  await mergeLines.enter({ repoId: repo.id, prNumber: 803, headSha: 'ccc3333', revert: true });
  const withRevert = await mergeLines.line(repo.id);
  check('a revert goes to the front', withRevert[0]?.prNumber === 803, withRevert.map((entry) => entry.prNumber).join(','));

  const front = await mergeLines.head(repo.id);
  check('only the front of the line is worked on', front?.prNumber === 803, `#${front?.prNumber}`);

  await mergeLines.setState(front.id, 'merged', { detail: 'merged' });
  const afterMerge = await mergeLines.line(repo.id);
  check('what merged leaves the line and the next one is at the front', afterMerge[0]?.prNumber === 801, afterMerge.map((entry) => entry.prNumber).join(','));

  const landingBoard = await get(`/v1/board?repo=${repo.name}`);
  check(
    'the line is visible on the board',
    (landingBoard.body.mergeLine ?? []).length === 2,
    `${(landingBoard.body.mergeLine ?? []).length} waiting`,
  );
  await query('delete from merge_lines');

  // --------------------------------------------------------------- one task per bot
  section('a seat runs no more tasks at once than it may');
  await resetPipelineState(repo.id);
  await seedIssue(repo.id, 902, 'Integration: first of two', ['tests/a/**']);
  await seedIssue(repo.id, 903, 'Integration: second of two', ['tests/b/**']);

  const openFirst = await post('/internal/dispatch/lease', {
    leaseId: (await leases.createLease({
      repoId: repo.id,
      issueNumber: 902,
      botId: builder.id,
      declaredPaths: ['tests/a/**'],
      expiresAt: new Date(Date.now() + 3600_000),
    })).id,
    repo: repo.name,
    issue: 902,
    bot: builder.name,
    declaredPaths: ['tests/a/**'],
    expiresAt: null,
  });
  check('the first task starts', openFirst.status === 200, `status ${openFirst.status}`);

  const openSecond = await post('/internal/dispatch/lease', {
    leaseId: (await leases.createLease({
      repoId: repo.id,
      issueNumber: 903,
      botId: builder.id,
      declaredPaths: ['tests/b/**'],
      expiresAt: new Date(Date.now() + 3600_000),
    })).id,
    repo: repo.name,
    issue: 903,
    bot: builder.name,
    declaredPaths: ['tests/b/**'],
    expiresAt: null,
  });
  check(
    'a second concurrent task on the same bot is refused, while the seat runs all it may at once',
    openSecond.status === 409 && /all it may run at once/.test(openSecond.body.error ?? ''),
    openSecond.body.error?.slice(0, 80) ?? `status ${openSecond.status}`,
  );

  // --------------------------------------------------------------- path overlap
  section('two pieces of work that could touch the same file never run together');
  await resetPipelineState(repo.id);
  await seedIssue(repo.id, 904, 'Integration: owns the directory', ['apps/bridge/**']);
  await seedIssue(repo.id, 905, 'Integration: wants a file inside it', ['apps/bridge/src/api.ts']);
  // Room for two, so overlap is the only thing that can hold #905 back: with
  // one, the builder being busy held it, and the check took "nothing
  // routable" for the reason. Put back as it was below.
  const overlapRoom = { concurrency: repo.concurrency, maxTasks: builder.maxTasks ?? 1 };
  await repos.updateRepoSettings(repo.name, { concurrency: 2 });
  await query('update bots set max_tasks = 2 where id = $1', [builder.id]);

  const firstPass = await runDispatcher();
  const leased904 = await leases.getActiveLease(repo.id, 904);
  const leased905 = await leases.getActiveLease(repo.id, 905);
  check('the higher-priority issue is leased', Boolean(leased904), leased904 ? 'yes' : 'no');
  check('the overlapping issue is not leased in the same pass', !leased905);

  const secondPass = await runDispatcher();
  const overlapLine = `${firstPass}\n${secondPass}`.split('\n').find((line) => /skipped \S+#905 .*overlap/.test(line));
  check('the dispatcher says it skipped #905 for the overlap', Boolean(overlapLine), overlapLine?.trim() ?? secondPass.trim().split('\n').at(-1));
  await repos.updateRepoSettings(repo.name, { concurrency: overlapRoom.concurrency });
  await query('update bots set max_tasks = $2 where id = $1', [builder.id, overlapRoom.maxTasks]);

  // --------------------------------------------------------------- lease expiry
  section('a lease with no pull request expires');
  await resetPipelineState(repo.id);
  await seedIssue(repo.id, 906, 'Integration: a lease that goes stale', ['tests/stale/**']);
  const stale = await leases.createLease({
    repoId: repo.id,
    issueNumber: 906,
    botId: builder.id,
    declaredPaths: ['tests/stale/**'],
    expiresAt: new Date(Date.now() - 60_000),
  });
  await runDispatcher();
  const expired = await query('select state from leases where id = $1', [stale.id]);
  check('the stale lease is expired', expired[0]?.state === 'expired', expired[0]?.state);
  // This run's own lease, not whichever expiry was audited last.
  const auditRow = await query(`select action from audit where action = 'lease.expired' and payload->>'leaseId' = $1`, [
    String(stale.id),
  ]);
  check('the expiry is audited', auditRow[0]?.action === 'lease.expired');

  // --------------------------------------------------------------- per-task cap
  section('a task that reaches its cap stops and asks');
  await resetPipelineState(repo.id);
  await seedIssue(repo.id, 907, 'Integration: a task that runs out of budget', ['tests/cap/**']);

  const capTask = await tasks.createTask({
    botId: builder.id,
    repoId: repo.id,
    kind: 'implement',
    subjectType: 'issue',
    subjectRef: `${repo.name}#907`,
    skill: 'implement',
    costCapUsd: 0.05,
  });

  // Usage is recorded only for a task that is running, on its bot's engine.
  await tasks.updateTaskState(capTask.id, 'running');
  const headroomBefore = await post(`/internal/tasks/${capTask.id}/headroom`, { estimateUsd: 0.01 });
  check('there is headroom before anything is spent', headroomBefore.body.stop === false, `spent $${headroomBefore.body.spent}`);

  const usage = await post(`/internal/tasks/${capTask.id}/usage`, {
    tokensIn: 40_000,
    tokensOut: 8_000,
    costUsd: 0.06,
    engine: builder.engine,
    model: 'claude-sonnet-4',
  });
  check('the cap trips once spend passes it', usage.body.stop === true, `spent $${usage.body.spent} of $${usage.body.cap}`);

  const headroomAfter = await post(`/internal/tasks/${capTask.id}/headroom`, { estimateUsd: 0.01 });
  check('there is no headroom afterwards', headroomAfter.body.stop === true);

  const gate = await post(`/internal/tasks/${capTask.id}/gate`, {
    question: `Stopped at the $0.05 cap on ${repo.name}#907. How should I proceed?`,
    options: ['continue for another $0.05', 'hand to a person', 'abandon this task'],
  });
  check('the capped task opens a gate', Boolean(gate.body.gateId), `gate ${String(gate.body.gateId).slice(0, 8)}`);

  const pausedTask = await tasks.getTask(capTask.id);
  check('opening a gate pauses the task', pausedTask?.state === 'paused', pausedTask?.exitReason ?? '');

  const openGates = await get('/v1/gates');
  check('the console can see the open gate', openGates.body.gates.length >= 1, `${openGates.body.gates.length} open`);

  const answered = await post(`/v1/gates/${gate.body.gateId}/answer`, { answer: '2' });
  check(
    'answering maps the number onto the option',
    answered.body.answer === 'hand to a person',
    answered.body.answer,
  );

  const answeredGate = await threads.getGate(gate.body.gateId);
  check('the gate records who answered', answeredGate?.answeredBy === 'integration test', answeredGate?.answeredBy ?? '');
  check('the gate is closed', answeredGate?.state === 'answered');
  const handedOff = await tasks.getTask(capTask.id);
  check('handing it to a person stops the task rather than resuming it', handedOff?.state === 'stopped', handedOff?.exitReason ?? '');

  // "continue" used to resume the task with the cap where it was, and the
  // session stopped again on its first headroom check.
  const moreTask = await tasks.createTask({
    botId: builder.id,
    repoId: repo.id,
    kind: 'implement',
    subjectType: 'issue',
    subjectRef: `${repo.name}#907`,
    skill: 'implement',
    costCapUsd: 0.05,
  });
  await tasks.updateTaskState(moreTask.id, 'running');
  await post(`/internal/tasks/${moreTask.id}/usage`, {
    tokensIn: 40_000,
    tokensOut: 8_000,
    costUsd: 0.06,
    engine: builder.engine,
    model: 'claude-sonnet-4',
  });
  // The session names an amount of its own; what is offered, and added, is
  // the install's per-task cap.
  const moreGate = await post(`/internal/tasks/${moreTask.id}/gate`, {
    question: `Stopped at the $0.05 cap on ${repo.name}#907 after $0.06. How should I proceed?`,
    options: ['continue for another $1000', 'hand to a person', 'abandon this task'],
  });
  const offered = (await threads.getGate(moreGate.body.gateId))?.options?.[0] ?? '';
  const step = Number(/^continue for another \$(\d+(?:\.\d+)?)$/.exec(offered)?.[1] ?? NaN);
  check('the cap’s question offers the per-task cap, not what the session asked for', step > 0 && step < 1000, offered);
  await post(`/v1/gates/${moreGate.body.gateId}/answer`, { answer: '1' });
  const raised = await tasks.getTask(moreTask.id);
  check(
    'continuing raises the task’s cap by what was offered',
    Math.abs((raised?.costCapUsd ?? 0) - (0.05 + step)) < 1e-9,
    `cap $${raised?.costCapUsd}`,
  );
  const headroomRaised = await post(`/internal/tasks/${moreTask.id}/headroom`, { estimateUsd: 0.01 });
  check('and the task has headroom again', headroomRaised.body.stop === false, `spent $${headroomRaised.body.spent}`);

  // --------------------------------------------------------------- monthly cap
  section('the monthly cap stops new leasing');
  await resetPipelineState(repo.id);
  await seedIssue(repo.id, 908, 'Integration: work that should not be leased', ['tests/budget/**']);

  const period = costs.currentPeriod();
  await query('update budgets set cap_usd = 0.01 where period = $1', [period]);
  await costs.recordUsage({
    taskId: null,
    botId: builder.id,
    engine: 'claude',
    model: 'claude-sonnet-4',
    tokensIn: 1000,
    tokensOut: 1000,
    costUsd: 5,
  });
  const stopped = await costs.refreshBudget(period, 0.9);
  check('the budget reports stopped', stopped.state === 'stopped', `$${stopped.spentUsd} of $${stopped.capUsd}`);

  const cappedRun = await runDispatcher();
  check(
    'the dispatcher leases nothing and says why',
    /not leasing new work/.test(cappedRun),
    cappedRun.trim().split('\n').at(-1),
  );
  check('no lease was created while stopped', !(await leases.getActiveLease(repo.id, 908)));

  await query('update budgets set cap_usd = 1500 where period = $1', [period]);
  const restored = await costs.refreshBudget(period, 0.9);
  check('raising the cap lets the crew lease work again', restored.state === 'ok', restored.state);

  // --------------------------------------------------------------- console reads
  section('the console reads what actually happened');
  const board = await get('/v1/board?repo=all');
  check('the board renders six columns', board.body.columns.length === 6);
  check(
    'every column carries a mode',
    board.body.columns.every((column) => typeof column.mode === 'string' && column.mode.length > 0),
  );
  const statusView = await get('/v1/status');
  check('the status view reports the host', statusView.body.hosts.length >= 1, statusView.body.hosts[0]?.name);
  check('the status view reports spend', typeof statusView.body.budget.spentUsd === 'number');
  const costsView = await get('/v1/costs');
  check('the costs view breaks spend down by bot', costsView.body.byBot.length >= 1);
  const auditView = await get('/v1/audit');
  check(
    'privileged actions are audited',
    auditView.body.audit.some((entry) => entry.action === 'gate.answer'),
  );

  // ------------------------------ an underspecified issue goes to intake, not a bot
  // Routability asked only for `adlc:build` and `start:now`, so an issue with no
  // declared paths was leased — and the overlap check that keeps two changes off
  // the same file then had nothing to compare.
  section('an issue that does not say enough is sent to triage');
  await resetPipelineState(repo.id);

  await issues.upsertIssue({
    repoId: repo.id,
    number: 960,
    title: 'Integration: a request with no expected paths',
    stage: 'build',
    labels: ['adlc:build', 'start:now', 'do:ai', 'priority:p1', 'area:bridge'],
    declaredPaths: [],
    url: null,
    prNumber: null,
    body: readyBody('Says what it wants but not where.'),
  });

  const beforeTriage = await auditMark();
  await runDispatcher();
  const underspecified = await issues.getIssue(repo.id, 960);
  check(
    'an issue without expected paths is not leased',
    !(await leases.listActiveLeases(repo.id)).some((lease) => lease.issueNumber === 960),
    (await leases.listActiveLeases(repo.id)).map((lease) => lease.issueNumber).join(', ') || 'nothing leased',
  );
  check(
    'it gains needs-triage so intake can shape it',
    underspecified?.labels.includes('needs-triage') === true,
    underspecified?.labels.join(', ') ?? 'gone',
  );
  check(
    'and it stops being routable, so the next pass does not say it again',
    underspecified?.labels.includes('start:now') === false,
    underspecified?.labels.join(', ') ?? '',
  );

  const triageAudit = await auditSince(beforeTriage);
  check(
    'the reason is recorded, not just the label',
    triageAudit.some(
      (row) =>
        row.action === 'issue.triaged' &&
        row.target === `${repo.name}#960` &&
        String(row.payload?.reason ?? '').includes('expected path'),
    ),
    triageAudit.find((row) => row.action === 'issue.triaged')?.payload?.reason ?? 'nothing recorded',
  );

  // The guard is not simply refusing everything: a complete issue still goes out.
  await seedIssue(repo.id, 961, 'Integration: a request that says enough', ['src/complete/**']);
  await runDispatcher();
  check(
    'a complete issue is still leased',
    (await leases.listActiveLeases(repo.id)).some((lease) => lease.issueNumber === 961),
    (await leases.listActiveLeases(repo.id)).map((lease) => lease.issueNumber).join(', ') || 'none',
  );

  // ------------------------------------ an issue stops waiting when its work ships
  // `blocked` was a note: nothing removed it, so an issue stayed blocked until
  // somebody noticed the thing it waited for had landed.
  section('an issue is unblocked when what it waited for has shipped');
  await resetPipelineState(repo.id);

  // The dependency: merged, but not yet anywhere it can be seen.
  await issues.upsertIssue({
    repoId: repo.id,
    number: 950,
    title: 'Integration: the thing that has to land first',
    stage: 'merged',
    labels: ['adlc:merged', 'do:ai'],
    declaredPaths: ['src/dep/**'],
    url: null,
    prNumber: 9501,
    body: '### Outcome\n\nThe dependency.\n',
  });

  await issues.upsertIssue({
    repoId: repo.id,
    number: 951,
    title: 'Integration: the thing that waits',
    stage: 'build',
    labels: ['adlc:build', 'blocked', 'do:ai', 'priority:p1', 'area:bridge'],
    declaredPaths: ['src/waiter/**'],
    url: null,
    prNumber: null,
    // Ready in every other respect, so what is being checked is the unblocking
    // and not the dispatcher's readiness guard sending it to triage instead.
    body: `${readyBody('Waits for #950.', ['src/waiter/**'])}\n### Dependencies\n\n- #950 — has to land first\n`,
  });

  await runDispatcher();
  const stillBlocked = await issues.getIssue(repo.id, 951);
  check(
    'a merge alone does not unblock it',
    stillBlocked?.labels.includes('blocked') === true,
    stillBlocked?.labels.join(', ') ?? 'gone',
  );

  // Now it has reached testing, which is what the plan waits for: a merge is not
  // a release.
  await query(`update issues set labels = array_append(labels, 'deployed:testing') where repo_id = $1 and number = 950`, [
    repo.id,
  ]);

  const beforeUnblock = await auditMark();
  await runDispatcher();
  const unblocked = await issues.getIssue(repo.id, 951);
  check(
    'reaching testing unblocks it on the next run',
    unblocked?.labels.includes('blocked') === false,
    unblocked?.labels.join(', ') ?? 'gone',
  );
  check(
    'and it is routable rather than merely unlabelled',
    unblocked?.labels.includes('start:now') === true,
    unblocked?.labels.join(', ') ?? '',
  );

  const unblockAudit = await auditSince(beforeUnblock);
  check(
    'the change is recorded against the automation account',
    unblockAudit.some((row) => row.action === 'issue.unblocked' && row.target === `${repo.name}#951`),
    unblockAudit.find((row) => row.action === 'issue.unblocked')?.actor ?? 'nothing recorded',
  );

  // ----------------------------------------- an unsigned delivery cannot answer a gate
  // The body names the person. Without a signature that person is whoever the
  // sender typed, so the delivery is refused and the gate stays open. The same
  // body with a valid signature is the verified delivery, and that is who the
  // answer is attributed to.
  section('an unsigned webhook cannot answer a gate');
  await resetPipelineState(repo.id);

  const gateTask = await tasks.createTask({
    botId: builder.id,
    repoId: repo.id,
    kind: 'implement',
    subjectType: 'issue',
    subjectRef: `${repo.name}#970`,
    skill: 'implement',
    costCapUsd: 0.05,
  });
  const openedGate = await post(`/internal/tasks/${gateTask.id}/gate`, {
    question: 'Ship it?',
    options: ['yes', 'no'],
  });
  check(
    'a gate is open to be answered from GitHub',
    Boolean(openedGate.body.gateId),
    openedGate.body.error ?? `status ${openedGate.status}`,
  );

  const forgedComment = {
    action: 'created',
    repository: { name: repo.name, full_name: repo.fullName },
    issue: { number: 970 },
    comment: { body: 'yes', user: { login: 'alice', id: 4242 }, html_url: 'https://github.test/c/970', author_association: 'COLLABORATOR' },
  };

  const unsigned = await webhook('issue_comment', forgedComment, { signed: false });
  check('a delivery with no signature is refused', unsigned.status === 401, `status ${unsigned.status}`);
  const afterUnsigned = openedGate.body.gateId ? await threads.getGate(openedGate.body.gateId) : null;
  check('the gate stays open', afterUnsigned?.state === 'open', afterUnsigned?.state ?? 'gone');
  check('and it is not attributed to the person the body named', !afterUnsigned?.answeredBy, afterUnsigned?.answeredBy ?? '');

  const forgedSignature = await webhook('issue_comment', forgedComment, { signature: `sha256=${'ab'.repeat(32)}` });
  check('a forged signature is refused', forgedSignature.status === 401, `status ${forgedSignature.status}`);
  check(
    'the gate is still open after the forgery',
    (await threads.getGate(openedGate.body.gateId))?.state === 'open',
  );

  // Signed is not the same as allowed. A gate is answered from GitHub by one of
  // the install's humans, or by somebody GitHub says holds triage or more; a
  // scratch install reaches no GitHub, so only the humans list can say yes,
  // and the COLLABORATOR label says nothing on its own. Each of the humans is
  // pinned to its GitHub account id, so a reply counts only from that account;
  // GitHub is not reachable here, so the pin is written as the bridge keeps it.
  const humansBefore = await settings.getSetting('humans').catch(() => null);
  const humanIdsBefore = await settings.getSetting('humanIds').catch(() => null);
  await settings.setSetting('humans', 'alice', 'pipeline');
  await settings.setSetting('humanIds', JSON.stringify({ alice: 4242 }), 'pipeline');
  try {
    const notAllowed = await webhook('issue_comment', {
      ...forgedComment,
      comment: { ...forgedComment.comment, user: { login: 'bob', id: 4343 }, html_url: 'https://github.test/c/971' },
    });
    check('a signed reply from somebody not allowed to answer is accepted as a delivery', notAllowed.status === 200, `status ${notAllowed.status}`);
    const afterNotAllowed = await threads.getGate(openedGate.body.gateId);
    check(
      'and leaves the gate open: a label is not a permission',
      afterNotAllowed?.state === 'open',
      `${afterNotAllowed?.state ?? 'gone'} by ${afterNotAllowed?.answeredBy ?? 'nobody'}`,
    );

    // Whether it was believed is read off the gate. The response also carries
    // what follows an answer, resuming the task on hostd, which is not this check.
    const signedDelivery = await webhook('issue_comment', forgedComment);
    check(
      'the same delivery with a valid signature is not refused',
      signedDelivery.status !== 401,
      `status ${signedDelivery.status}`,
    );
    const afterSigned = await threads.getGate(openedGate.body.gateId);
    check(
      'the gate is answered as the person the verified delivery names, one of the humans',
      afterSigned?.state === 'answered' && afterSigned?.answeredBy === 'alice',
      `${afterSigned?.state ?? 'gone'} by ${afterSigned?.answeredBy ?? 'nobody'}`,
    );
  } finally {
    // An empty value clears the setting, which is what it was when there was none.
    await settings.setSetting('humans', humansBefore ?? '', 'pipeline');
    await settings.setSetting('humanIds', humanIdsBefore ?? '', 'pipeline');
  }

  // ---------------------------------------- every delivered event is dealt with
  // Five types were received and dropped. A dropped event is not a decision,
  // and the next reader cannot tell it from an oversight. Some of these the app
  // is not subscribed to (`check_suite`, `pull_request_review_comment`); one
  // that arrives anyway is still recorded as decided.
  section('a delivered event is handled or decided about');
  await resetPipelineState(repo.id);

  const deliveries = [
    ['push', { repository: { name: repo.name, full_name: repo.fullName }, ref: 'refs/heads/main' }],
    ['deployment', { repository: { name: repo.name, full_name: repo.fullName }, deployment: { environment: 'testing' } }],
    ['deployment_status', { repository: { name: repo.name, full_name: repo.fullName }, deployment_status: { state: 'success' } }],
    ['check_suite', { repository: { name: repo.name, full_name: repo.fullName }, action: 'completed' }],
    [
      'pull_request_review_comment',
      {
        action: 'created',
        repository: { name: repo.name, full_name: repo.fullName },
        pull_request: { number: 4242 },
        comment: {
          body: 'this branch is not covered',
          html_url: 'https://github.test/c/1',
          user: { login: 'janedoe' },
          author_association: 'OWNER',
          path: 'src/a.ts',
          line: 12,
        },
      },
    ],
  ];

  let accepted = 0;
  for (const [event, payload] of deliveries) {
    const response = await webhook(event, payload);
    if (response.ok) accepted += 1;
    else check(`${event} is accepted`, false, `status ${response.status}`);
  }
  check('every delivered type is accepted', accepted === deliveries.length, `${accepted}/${deliveries.length}`);

  // The real assertion: none of them is left sitting in the event log unhandled.
  const unprocessed = await query(
    `select type from events where source = 'github' and processed_at is null and at > now() - interval '2 minutes'`,
  );
  check(
    'none of them is left unprocessed',
    unprocessed.length === 0,
    unprocessed.map((row) => row.type).join(', ') || 'none',
  );

  // An alert had nowhere to become work.
  const alert = await post('/internal/alerts', {
    fingerprint: 'integration-alert',
    title: 'Latency above the objective',
    description: 'p99 has been over 800ms for ten minutes.',
    repo: repo.name,
  });
  check('an alert has somewhere to go', alert.status === 200, `status ${alert.status}`);
  const alertAgain = await post('/internal/alerts', {
    fingerprint: 'integration-alert',
    title: 'Latency above the objective',
    repo: repo.name,
  });
  check(
    'the same alert twice is the same answer, not two issues',
    JSON.stringify(alert.body) === JSON.stringify(alertAgain.body),
    alertAgain.body.reason ?? '',
  );
  const alertNoTitle = await post('/internal/alerts', { fingerprint: 'x', repo: repo.name });
  check('an alert with no title is refused', alertNoTitle.status === 400, `status ${alertNoTitle.status}`);

  // ------------------------------------------------ a red testing run comes back out
  // The deploy path exists now, and a red smoke is the only thing in the
  // platform that starts work without a person asking: testing is never fixed
  // forward.
  //
  // Only the smoke. A failed *deploy* means the revision never reached
  // testing — the environment is still serving the previous one and is fine —
  // so reverting `main` would be a second change for a commit whose only fault
  // is that the deploy did not run. That becomes an issue, and the SRE's task
  // to diagnose it on a system/deploy-path- branch, instead.
  section('a red smoke puts the change back out, and a red deploy does not');

  const deployBot = (await bots.listBots()).find((entry) => entry.role === 'deploy');
  check('the crew has a deploy bot to revert with', Boolean(deployBot), deployBot?.name ?? 'none');

  await resetPipelineState(repo.id);
  // The first revert of a commit starts past a monthly cap, so only a smoke
  // on the default branch, of a commit the bridge saw reach testing, asks
  // for one. The authorisation is once per commit; a run of this
  // suite before this one would have used it.
  await query(`delete from audit where action like 'spending.revert_%' and target like $1`, [`${repo.name}@%`]);

  // A red smoke-testing workflow on a pull request's branch — a file a
  // builder can commit — asks for nothing.
  const prSmoke = await webhook('workflow_run', {
    action: 'completed',
    repository: { name: repo.name, full_name: repo.fullName },
    workflow_run: {
      name: 'smoke-testing',
      conclusion: 'failure',
      head_sha: 'aaaa0003c0ffeeba5e0000000000000000000003',
      event: 'pull_request',
      head_branch: 'agent/builder/3-issue-3',
    },
  });
  check('a smoke on a pull request’s branch fails: the delivery is accepted', prSmoke.ok, `status ${prSmoke.status}`);
  const prRevert = await waitFor(async () => {
    const open = await tasks.listTasks({ limit: 20 });
    return open.find((entry) => entry.branch?.startsWith('system/revert-')) ?? null;
  }, 4_000);
  check('a smoke on a pull request’s branch fails: no revert task opens', !prRevert, prRevert?.branch ?? 'nothing opened');

  const deployed = await webhook('deployment_status', {
    repository: { name: repo.name, full_name: repo.fullName },
    deployment: { sha: 'aaaa0001c0ffeeba5e0000000000000000000001', ref: repo.defaultBranch, environment: 'testing' },
    deployment_status: { state: 'success', environment: 'testing' },
  });
  check('the commit reaches testing: the delivery is accepted', deployed.ok, `status ${deployed.status}`);

  const smokeDelivered = await webhook('workflow_run', {
    action: 'completed',
    repository: { name: repo.name, full_name: repo.fullName },
    workflow_run: {
      name: 'smoke-testing',
      conclusion: 'failure',
      head_sha: 'aaaa0001c0ffeeba5e0000000000000000000001',
      html_url: 'https://github.com/example/example/actions/runs/1',
      event: 'workflow_run',
      head_branch: repo.defaultBranch,
    },
  });
  check('the smoke fails: the delivery is accepted', smokeDelivered.ok, `status ${smokeDelivered.status}`);

  const revert = await waitFor(async () => {
    const open = await tasks.listTasks({ limit: 20 });
    return open.find((entry) => entry.branch?.startsWith('system/revert-')) ?? null;
  }, 20_000);
  check('the smoke fails: a revert task opens on a system/ branch', Boolean(revert), revert?.branch ?? 'nothing opened');
  check(
    'the smoke fails: and the deploy bot is the one holding it',
    Boolean(revert) && revert.botId === deployBot?.id,
    revert ? (await bots.getBotById(revert.botId))?.name ?? '' : '',
  );

  // The half this used to get wrong. A build that failed, a migration that
  // failed or a runner that died all leave testing on the previous revision,
  // and there is nothing on the environment for a revert to take back.
  for (const [what, event, payload] of [
    [
      'the deploy itself fails',
      'deployment_status',
      {
        repository: { name: repo.name, full_name: repo.fullName },
        deployment: { sha: 'aaaa0002c0ffeeba5e0000000000000000000002', ref: repo.defaultBranch, environment: 'testing' },
        deployment_status: { state: 'failure', environment: 'testing' },
      },
    ],
    [
      'the deploy workflow fails',
      'workflow_run',
      {
        action: 'completed',
        repository: { name: repo.name, full_name: repo.fullName },
        workflow_run: {
          name: 'deploy-testing',
          conclusion: 'failure',
          head_sha: 'aaaa0004c0ffeeba5e0000000000000000000004',
          event: 'push',
          head_branch: repo.defaultBranch,
        },
      },
    ],
  ]) {
    await resetPipelineState(repo.id);
    const delivered = await webhook(event, payload);
    check(`${what}: the delivery is accepted`, delivered.ok, `status ${delivered.status}`);

    // Deliberately a wait-and-see rather than an immediate read: a revert that
    // arrives a second late would still be wrong, and an assertion that checks
    // too early would pass on it.
    const late = await waitFor(async () => {
      const open = await tasks.listTasks({ limit: 20 });
      return open.find((entry) => entry.branch?.startsWith('system/revert-')) ?? null;
    }, 4_000);
    check(`${what}: no revert task opens`, !late, late?.branch ?? 'nothing opened');
  }

  // ------------------------------------------------ saving limits waits its turn
  // Two saves at once each checked a repository cap against the global one
  // it had read before either wrote. A save now reads the rows only
  // once it holds the lock, in its transaction: held elsewhere, the save
  // waits, and then plans against what is there.
  section('a save of the spending limits plans against the rows once it has the lock');
  {
    const lockHolder = await getPool().connect();
    const before = await spendingLimits.amountOf('global', 'month_total');
    try {
      await lockHolder.query('select pg_advisory_lock(hashtext($1))', [spendingLimits.SAVE_LOCK]);
      let seen = null;
      const saving = spendingLimits.saveLimits({
        seed: { monthlyCapUsd: 1500, perTaskCapUsd: 15 },
        actor: 'pipeline-suite',
        plan: (current) => {
          seen = current.find((row) => row.scope === 'global' && row.kind === 'month_total')?.amountUsd ?? null;
          return { writes: [], result: null };
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      check('the save waits while another holds the lock', seen === null, `planned against ${seen}`);
      await spendingLimits.setLimit('global', 'month_total', 4321);
      await lockHolder.query('select pg_advisory_unlock(hashtext($1))', [spendingLimits.SAVE_LOCK]);
      await saving;
      check('the save plans against what the other wrote', seen === 4321, `planned against ${seen}`);
    } finally {
      lockHolder.release();
      if (before != null) await spendingLimits.setLimit('global', 'month_total', before);
    }
  }

  // ------------------------------------------------ one revert per commit past a cap
  // Two red smokes of one commit delivered at once each asked whether the
  // commit's revert was authorised before either wrote. The check and
  // the write run under a lock on the commit, so exactly one of them is first,
  // and an authorisation given back is there for the next one.
  section('two authorisations of one commit at once: exactly one is first');
  {
    const subject = `pipeline-suite@${randomBytes(4).toString('hex')}`;
    try {
      const answers = await Promise.all(
        Array.from({ length: 4 }, (_, index) => spendingLimits.authorizeRevert(subject, { suite: 'pipeline', index })),
      );
      check('exactly one of four at once is authorised', answers.filter(Boolean).length === 1, answers.join(', '));
      const written = await query(`select action from audit where target = $1 order by id`, [subject]);
      check('and one authorisation is written', written.length === 1, written.map((row) => row.action).join(', '));

      const [releasedAgain, taken] = await Promise.all([
        spendingLimits.releaseRevert(subject, { suite: 'pipeline' }),
        spendingLimits.releaseRevert(subject, { suite: 'pipeline' }),
      ]);
      check('given back once, whoever asks at once', [releasedAgain, taken].filter(Boolean).length === 1, `${releasedAgain}, ${taken}`);
      const again = await Promise.all([spendingLimits.authorizeRevert(subject, {}), spendingLimits.authorizeRevert(subject, {})]);
      check('and authorised again for exactly one', again.filter(Boolean).length === 1, again.join(', '));

      check('held for a task that could not start', await spendingLimits.holdRevert(subject, 'task-held'), 'not held');
      check('and a red smoke then is not authorised', !(await spendingLimits.authorizeRevert(subject, {})), 'authorised');
      check('a hold is not moved to another task', !(await spendingLimits.holdRevert(subject, 'task-other')), 'moved');

      // Two retries of the held task at once: the hold is spent by one.
      const spends = await Promise.all([spendingLimits.spendHeldRevert(subject, 'task-held'), spendingLimits.spendHeldRevert(subject, 'task-held')]);
      check('a hold is spent by exactly one of two retries at once', spends.filter(Boolean).length === 1, spends.join(', '));
      check('and not by a later retry of the same task', !(await spendingLimits.spendHeldRevert(subject, 'task-held')), 'spent again');
      check('a spent authorisation is not held for the retry’s new task', !(await spendingLimits.holdRevert(subject, 'task-retry', 'task-held')), 'held');
      check('but is held again for the task a refused retry leaves', await spendingLimits.holdRevert(subject, 'task-held', 'task-held'), 'not held');
      const actions = (await query(`select action from audit where target = $1 order by id`, [subject])).map((row) => row.action);
      check(
        'the trail ends held for that task',
        actions.at(-1) === 'spending.revert_held' && actions.includes('spending.revert_spent'),
        actions.join(', '),
      );
    } finally {
      await query(`delete from audit where target = $1`, [subject]);
    }
  }

  // Production is not answered by reverting main. `rollback-production` shifts
  // traffic back, and a second change to the default branch during an incident
  // is the last thing anybody needs.
  await resetPipelineState(repo.id);
  await webhook('deployment_status', {
    repository: { name: repo.name, full_name: repo.fullName },
    deployment: { sha: 'aaaa0003c0ffeeba5e0000000000000000000003', ref: repo.defaultBranch, environment: 'production' },
    deployment_status: { state: 'failure', environment: 'production' },
  });
  const afterProdFailure = await tasks.listTasks({ limit: 20 });
  check(
    'a red production deploy does not revert the default branch',
    afterProdFailure.every((entry) => !entry.branch?.startsWith('system/revert-')),
    afterProdFailure.map((entry) => entry.branch ?? entry.kind).join(', ') || 'no tasks',
  );

  // A deploy still happening is not a verdict. Acting on one would label a pull
  // request as live somewhere the moment a deploy started.
  await resetPipelineState(repo.id);
  const inProgress = await webhook('deployment_status', {
    repository: { name: repo.name, full_name: repo.fullName },
    deployment: { sha: 'aaaa0004c0ffeeba5e0000000000000000000004', ref: repo.defaultBranch, environment: 'testing' },
    deployment_status: { state: 'in_progress', environment: 'testing' },
  });
  check('a deploy in progress is accepted', inProgress.ok, `status ${inProgress.status}`);
  check(
    'and nothing acts on it until it has a verdict',
    (await tasks.listTasks({ limit: 20 })).length === 0,
    `${(await tasks.listTasks({ limit: 20 })).length} tasks`,
  );

  // ------------------------------------------- somebody is told they are waited on
  // A gate was a GitHub comment and a console row, so a task could sit paused
  // until somebody happened to look at the board.
  section('opening a gate tells the person it is addressed to');
  await resetPipelineState(repo.id);
  await seedIssue(repo.id, 940, 'Integration: a task that has to ask', ['tests/notify/**']);

  const notifyLease = await leases.createLease({
    repoId: repo.id,
    issueNumber: 940,
    botId: builder.id,
    declaredPaths: ['tests/notify/**'],
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const notifyStart = await post('/internal/dispatch/lease', {
    leaseId: notifyLease.id,
    repo: repo.name,
    issue: 940,
    bot: builder.name,
    declaredPaths: ['tests/notify/**'],
    expiresAt: null,
  });
  const notifyTask = notifyStart.body.task?.taskId;

  const beforeGate = await latestEventId();
  const gateOpened = await post(`/internal/tasks/${notifyTask}/gate`, {
    question: 'Which of these should it be?',
    options: ['this', 'that'],
    addressedTo: 'janedoe',
  });
  check('the gate opens', Boolean(gateOpened.body.gateId), gateOpened.body.gateId ?? '');

  const notices = await notificationsSince(beforeGate);
  check('one notification goes out', notices.length === 1, `${notices.length}`);
  check(
    'it names the person it is addressed to',
    notices[0]?.payload?.to === 'janedoe',
    notices[0]?.payload?.to ?? 'nobody',
  );
  check(
    'and it links straight to the work item’s conversation, where the question is answered',
    String(notices[0]?.payload?.link ?? '').includes('?item='),
    notices[0]?.payload?.link ?? '',
  );

  // Answering is the work resuming. Telling somebody their own answer landed is
  // the kind of noise that makes the next notification ignorable.
  const beforeAnswer = await latestEventId();
  await post(`/v1/gates/${gateOpened.body.gateId}/answer`, { answer: 'this' }).catch(() => undefined);
  const afterAnswer = await notificationsSince(beforeAnswer);
  check('answering it notifies nobody', afterAnswer.length === 0, `${afterAnswer.length} notification(s)`);

  // ------------------------------------------------- the status view is edited
  // Ninety-six comments a day on one issue is how a status view stops being
  // read. The body is rewritten; a comment is only for what needs a person.
  section('the status view is rewritten, not appended to');
  const statusFirst = await post('/internal/schedule/status');
  const statusSecond = await post('/internal/schedule/status');
  check(
    'the status job reports what it did',
    (statusFirst.body.actions ?? []).length > 0,
    statusFirst.body.actions?.[0] ?? '',
  );
  check(
    'two consecutive runs do the same thing, with no comment between them',
    JSON.stringify(statusFirst.body.actions) === JSON.stringify(statusSecond.body.actions) &&
      !(statusSecond.body.actions ?? []).some((line) => line.includes('comment')),
    statusSecond.body.actions?.[0] ?? '',
  );

  // -------------------------------------------------- the recurring work runs
  // Each of these covers a case where no webhook will ever arrive, so nothing
  // else would notice the work was not happening.
  section('the recurring work has a job, and firing it twice is safe');

  for (const job of ['credentials', 'deps', 'deploy']) {
    const first = await post(`/internal/schedule/${job}`);
    const second = await post(`/internal/schedule/${job}`);
    const firstActions = first.body.actions ?? [];
    const secondActions = second.body.actions ?? [];
    check(`${job} reports what it did`, firstActions.length > 0, firstActions[0] ?? 'nothing');
    // Idempotence is what separates a schedule from a nuisance: an hourly job
    // that files an issue an hour is worse than no job. The deploy sweep is
    // allowed to start a task on the first firing; the second must not start
    // another, and every other answer is the same twice. A start is the deploy
    // bot's task or, as the bridge wires it, the app dispatching the
    // repository's workflow.
    const started = (line) => line.startsWith('started a testing deploy') || line.includes(': dispatched ');
    check(
      `${job} is safe to fire twice`,
      secondActions.every((line) => !started(line)) &&
        (firstActions.some(started) || JSON.stringify(firstActions) === JSON.stringify(secondActions)),
      secondActions[0] ?? '',
    );
  }

  const unknownJob = await post('/internal/schedule/not-a-job');
  check(
    'an unknown job is named rather than silently doing nothing',
    (unknownJob.body.actions ?? []).some((line) => line.includes('no job named')),
    unknownJob.body.actions?.[0] ?? '',
  );

  const statusWithJobs = await get('/v1/status');
  const jobNames = (statusWithJobs.body.jobs ?? []).map((entry) => entry.job);
  check(
    'fleetadlc status can list every job',
    ['reconcile', 'status', 'budget', 'stages', 'merge', 'qa', 'credentials', 'deps', 'deploy'].every((job) =>
      jobNames.includes(job),
    ),
    jobNames.join(', '),
  );
  check(
    'and when each last ran',
    ['credentials', 'deploy'].every((job) =>
      (statusWithJobs.body.jobs ?? []).some((entry) => entry.job === job && entry.lastRunAt),
    ),
    (statusWithJobs.body.jobs ?? [])
      .filter((entry) => entry.job === 'credentials' || entry.job === 'deploy')
      .map((entry) => `${entry.job} ${entry.lastRunAt ?? 'never'}`)
      .join(', '),
  );

  // ------------------------------------------------------ something starts QA
  // The `qa` skill was written and the QA seat configured with it, and nothing ever
  // opened a QA task — so the journeys and the readiness report were
  // unreachable however correct the skill was.
  section('the QA bot has something that starts it');

  // The bridge reads the environment at start-up, so which half of this runs
  // depends on the install under test. Both are behaviour worth pinning: an
  // install with nowhere to point must refuse rather than report green against
  // nothing.
  const fired = await post('/internal/schedule/qa');
  const firedActions = fired.body.actions ?? [];

  if (process.env.FLEETADLC_TESTING_URL) {
    check(
      'firing the job opens a QA run',
      firedActions.some((line) => line.includes('opened a QA run')),
      firedActions[0] ?? '',
    );

    const qaBot = (await bots.listBots()).find((entry) => entry.role === 'qa');
    const qaTask = await waitFor(async () => {
      const open = await tasks.listTasks({ limit: 20 });
      return open.find((entry) => entry.botId === qaBot?.id) ?? null;
    }, 30_000);
    check('the QA run is a real task', Boolean(qaTask), qaTask?.subjectRef ?? 'none');

    await waitFor(async () => {
      const current = qaTask ? await tasks.getTask(qaTask.id) : null;
      return current && current.state !== 'running' && current.state !== 'queued' ? current : null;
    }, 40_000);

    const qaMessages = qaBot ? await messagesFor(qaBot.id, `${repo.name}#testing`) : [];
    const report = qaMessages.find((message) => message.payload?.event === 'verified');
    check('it ends with a readiness report a person will see', Boolean(report), report?.note ?? 'no report');
  } else {
    check(
      'refuses to open a QA run with no testing environment to point at',
      firedActions.some((line) => line.includes('no testing environment')),
      firedActions[0] ?? '',
    );
  }

  // -------------------------------------------- structured events in the thread
  // The `fleetadlc:` events were declared, but only `question` was ever produced,
  // so the bridge learned what a bot did from GitHub's webhooks and nothing at all
  // about a step that leaves no GitHub trace — a plan posted, a task that
  // stopped on its own terms.
  section('a skill speaks in structured events');

  // A stop leaves no GitHub trace of its own, so it has to be driven: the
  // intake skill asks a question, which pauses the task, which is the path that
  // produces the event. Nothing else in this suite pauses through the runner.
  const intakeBot = (await bots.listBots()).find((entry) => entry.role === 'intake');
  await issues.upsertIssue({
    repoId: repo.id,
    number: 930,
    title: 'Integration: a request that is missing what intake needs',
    stage: 'intake',
    labels: ['adlc:intake', 'start:now', 'do:ai', 'priority:p2'],
    declaredPaths: [],
    url: null,
    prNumber: null,
  });
  await post('/internal/schedule/stages');

  const intakeTask = await waitFor(async () => {
    const open = await tasks.listTasks({ states: ['paused', 'running', 'done'], limit: 20 });
    return open.find((entry) => entry.subjectRef === `${repo.name}#930`) ?? null;
  }, 30_000);
  check('a task the intake skill has to ask about starts', Boolean(intakeTask), intakeTask?.state ?? 'none');

  await waitFor(async () => {
    const current = intakeTask ? await tasks.getTask(intakeTask.id) : null;
    return current && current.state !== 'running' && current.state !== 'queued' ? current : null;
  }, 30_000);

  // This subject's own thread. Searching every thread the builder has ever
  // had let a plan or a stop from an earlier run satisfy the check, which is
  // why it passed on a database that had already seen the suite and said
  // nothing about the task just started. The plan marker is checked on the
  // implement task above: this skill does not post one.
  //
  // Opening the gate pauses the task, and the runner posts its stop line only
  // after the gate's request returns, so the wait above can end before that
  // line is written. Reading the thread once then sometimes found no stop at
  // all, so it is waited for instead.
  const stoppedIn = async () => {
    const messages = intakeBot ? await messagesFor(intakeBot.id, `${repo.name}#930`) : [];
    return messages.some((message) => message.payload?.event === 'stopped') ? messages : null;
  };
  const eventMessages = (await waitFor(stoppedIn, 15_000)) ?? (intakeBot ? await messagesFor(intakeBot.id, `${repo.name}#930`) : []);

  const stopEvent = eventMessages.find((message) => message.payload?.event === 'stopped');
  check('the stop comment reaches the thread as its own kind', stopEvent?.kind === 'sys', stopEvent?.kind ?? 'absent');

  // The whole point of the marker: a comment without one is not reinterpreted.
  const narration = eventMessages.find((message) => !message.payload?.event && message.kind === 'bot');
  check('a comment with no marker is still narration', Boolean(narration), narration?.kind ?? 'none found');

  // ------------------------------------------------- the internal API is shut
  // `/internal` used to be held by the private network alone, so an
  // unauthenticated request could start a real task on any bot with arbitrary
  // declared paths, force a task done, open a gate as a bot, or push the
  // monthly budget to `stopped`.
  section('the internal API refuses a caller without the secret');
  // The automation bot by its role: its name is its account's handle once one
  // is connected, and the route is refused whatever it is called.
  const automationBot = (await bots.listBots()).find((entry) => entry.role === 'automation');
  const internalRoutes = [
    [`/internal/tokens/${automationBot?.name ?? 'automation'}`, { purpose: 'task' }],
    ['/internal/bots/reconcile', {}],
    [
      '/internal/dispatch/lease',
      { leaseId: randomUUID(), repo: repo.name, issue: 1, bot: builder.name, declaredPaths: ['**'] },
    ],
    [`/internal/tasks/${randomUUID()}/state`, { state: 'done' }],
    [`/internal/tasks/${randomUUID()}/usage`, { costUsd: 9999 }],
    [`/internal/tasks/${randomUUID()}/gate`, { question: 'forged' }],
    [`/internal/tasks/${randomUUID()}/message`, { kind: 'you', text: 'forged' }],
    [`/internal/tasks/${randomUUID()}/headroom`, { estimateUsd: 1 }],
    ['/internal/schedule/merge-line', {}],
    ['/internal/events', { source: 'forged', type: 'forged' }],
  ];

  let refusedAll = true;
  for (const [path, payload] of internalRoutes) {
    const response = await fetch(`${BRIDGE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status !== 401) {
      refusedAll = false;
      check(`${path} refuses an unauthenticated caller`, false, `status ${response.status}`);
    }
  }
  check(
    `all ${internalRoutes.length} internal routes refuse an unauthenticated caller`,
    refusedAll,
    refusedAll ? 'every one answered 401' : 'see above',
  );

  // The budget is the one with a lasting consequence, so check it did not move.
  const budgetAfter = await costs.getBudget(costs.currentPeriod());
  check(
    'a forged usage report did not reach the ledger',
    Number(budgetAfter?.spentUsd ?? 0) < 9999,
    `$${Number(budgetAfter?.spentUsd ?? 0).toFixed(2)}`,
  );

  // ------------------------------------------------- surviving a bad request
  // Both services parsed the request line against the Host header, and Node
  // hands an invalid authority straight through — so one unauthenticated
  // request used to stop the process, ahead of routing and of every
  // authentication check. This runs last because it would take the rest of the
  // suite with it.
  //
  // The ports are the install under test's. Written as 47311 and 47312, these
  // checks failed against a scratch install, and on a machine that runs OpenADLC
  // aimed the malformed request at the real one.
  section('a malformed request does not stop a service');
  for (const [name, port, target] of [
    ['bridge', Number(new URL(BRIDGE).port), 'GET /healthz HTTP/1.1'],
    ['hostd', Number(new URL(HOSTD).port), 'GET /healthz HTTP/1.1'],
  ]) {
    await rawRequest(port, `${target}\r\nHost: ]\r\nConnection: close\r\n\r\n`);
    const alive = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) })
      .then((response) => response.ok)
      .catch(() => false);
    check(`${name} survives an invalid Host header`, alive);
  }

  // hostd's upgrade listener is synchronous, so a throw there is fatal in a way
  // the HTTP routes are not.
  await rawRequest(
    Number(new URL(HOSTD).port),
    'GET /terminal HTTP/1.1\r\nHost: ]\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      // RFC 6455's sample nonce, encoded here rather than written out for a secret scanner to raise.
      `Sec-WebSocket-Key: ${Buffer.from('the sample nonce').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const gatewaySurvived = await fetch(`${HOSTD}/healthz`, { signal: AbortSignal.timeout(4000) })
    .then((response) => response.ok)
    .catch(() => false);
  check('hostd survives an invalid Host on the terminal upgrade', gatewaySurvived);

  // --------------------------------------------------------------- clean up
  await resetPipelineState(repo.id);
  await query('delete from audit');
  await forgetSuiteSecret();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} pipeline checks passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const failure of failed) console.log(`  ${failure.section}: ${failure.name}`);
  }
  console.log();

  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\npipeline checks failed: ${error instanceof Error ? error.message : error}\n`);
  await forgetSuiteSecret();
  await closePool();
  process.exit(1);
});
