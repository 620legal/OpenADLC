#!/usr/bin/env node
/**
 * Exercises the real GitHub write path against a live repository: the paths that
 * unit tests cannot cover because they are about GitHub actually accepting what
 * the bridge sends.
 *
 * It files an issue, drives it through the stage labels, opens a gate as a
 * comment, answers it, writes the review-gate commit status, and cleans up after
 * itself. Nothing here runs in CI; it needs a connected automation account.
 *
 *   node tests/github-live.mjs            # run against the install's first repository by name (the database DATABASE_URL points at)
 *   node tests/github-live.mjs --keep     # leave the issue open for inspection
 */
import { closePool, bots, repos, tasks, threads, waitForDatabase } from '@fleetadlc/db';
import { GitHubClient, accessTokenRef, getSecretStore, internalSecretRef, refreshTokenRef, TokenBroker } from '@fleetadlc/github';
import { automationBotOf, renderGateComment, parseMarker, STAGE_LABELS } from '@fleetadlc/shared';

const keep = process.argv.includes('--keep');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * A bot's token from the bridge, as the rest of OpenADLC gets one: GitHub
 * rotates a refresh token on use, so refreshing it here while that install's
 * bridge refreshes the same one would invalidate both. Null when the bridge
 * does not answer, and only then does this suite refresh the token itself.
 */
async function tokenFromBridge(botName) {
  const bridge = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
  const secret = (await getSecretStore().get(internalSecretRef()).catch(() => null)) ?? '';
  let response;
  try {
    response = await fetch(`${bridge}/internal/tokens/${encodeURIComponent(botName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': secret },
      body: JSON.stringify({ purpose: 'call' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return null;
    throw new Error(`the bridge at ${bridge} could not be asked for ${botName}'s token: ${error?.message ?? error}`);
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok && typeof body.token === 'string') return body.token;
  throw new Error(`the bridge refused ${botName}'s token: ${typeof body.error === 'string' && body.error ? body.error : `it answered ${response.status}`}`);
}

async function clientFor(botName) {
  const bot = await bots.getBotByName(botName);
  const login = bot?.githubLogin ?? botName;
  const fromBridge = await tokenFromBridge(botName);
  if (fromBridge) return new GitHubClient({ token: fromBridge, actingAs: login });
  const store = getSecretStore();

  const refresh = await store.get(refreshTokenRef(botName));
  if (refresh && process.env.FLEETADLC_GITHUB_CLIENT_ID) {
    const broker = new TokenBroker({ clientId: process.env.FLEETADLC_GITHUB_CLIENT_ID });
    const brokered = await broker.tokenFor(botName, login);
    return new GitHubClient({ token: brokered.token, actingAs: login });
  }

  const staticToken = await store.get(accessTokenRef(botName));
  if (!staticToken) throw new Error(`${botName} is not connected; run: fleetadlc auth login --bot ${botName}`);
  return new GitHubClient({ token: staticToken, actingAs: login });
}

async function main() {
  await waitForDatabase();

  const repo = (await repos.listRepos())[0];
  if (!repo) throw new Error('no repository is configured');
  // The automation bot by its role, or the one FLEETADLC_AUTOMATION_BOT names by
  // seat or name: its name is its account's handle once one is connected.
  const automation = automationBotOf(await bots.listBots(), process.env.FLEETADLC_AUTOMATION_BOT ?? null);
  if (!automation) throw new Error('this install has no automation bot');
  const client = await clientFor(automation.name);
  const viewer = await client.viewer();

  console.log(`\nlive GitHub checks against ${repo.fullName} as ${viewer.login}\n`);

  // 1. File an issue the way intake would, with the fields the dispatcher needs.
  const created = await client.createIssue(repo.fullName, {
    title: 'Live check: the platform writing to GitHub',
    body: [
      'Filed by `tests/github-live.mjs` to prove the write path works end to end.',
      '',
      '### Outcome',
      'The bridge can file, label, comment on and resolve an issue as a real account.',
      '',
      '### Expected paths',
      '- tests/**',
      '',
      '### Verification',
      'This script closes the issue when it passes.',
    ].join('\n'),
    labels: ['adlc:intake', 'priority:p3', 'do:ai', 'area:bridge'],
  });
  check('files an issue with labels', Boolean(created.number), `#${created.number}`);

  // 2. Move it through the stages the way the bots and the bridge do.
  await client.setLabels(repo.fullName, created.number, [
    STAGE_LABELS.build,
    'priority:p3',
    'do:ai',
    'area:bridge',
    'start:now',
  ]);
  const afterMove = await client.request('GET', `/repos/${repo.fullName}/issues/${created.number}`);
  const labelNames = afterMove.labels.map((label) => label.name);
  check(
    'moves the stage label forward',
    labelNames.includes(STAGE_LABELS.build) && !labelNames.includes(STAGE_LABELS.intake),
    labelNames.filter((name) => name.startsWith('adlc:')).join(', '),
  );

  // 3. Assign it, as the bridge does when a lease is granted.
  await client.assign(repo.fullName, created.number, [viewer.login]);
  const assigned = await client.request('GET', `/repos/${repo.fullName}/issues/${created.number}`);
  check(
    'assigns the issue to the leasing account',
    assigned.assignees.some((user) => user.login === viewer.login),
    viewer.login,
  );

  // 4. Open a gate: the comment is the durable record, and the marker is what the
  //    bridge parses back out of it.
  const gateBody = renderGateComment({
    bot: 'Live check',
    taskId: 'live-check',
    question: 'Does the marker survive a round trip through the GitHub API?',
    options: ['yes', 'no'],
  });
  const gateComment = await client.comment(repo.fullName, created.number, gateBody);
  const fetched = await client.request(
    'GET',
    `/repos/${repo.fullName}/issues/comments/${gateComment.id}`,
  );
  const marker = parseMarker(fetched.body);
  check(
    'a gate comment round-trips its marker',
    marker?.event === 'question' && marker?.taskId === 'live-check',
    marker ? `options: ${marker.options?.join(', ')}` : 'no marker found',
  );

  // 5. needs-human is what holds the work; removing it is what releases it.
  await client.addLabels(repo.fullName, created.number, ['needs-human']);
  const held = await client.request('GET', `/repos/${repo.fullName}/issues/${created.number}`);
  const heldOk = held.labels.some((label) => label.name === 'needs-human');
  await client.removeLabel(repo.fullName, created.number, 'needs-human');
  const released = await client.request('GET', `/repos/${repo.fullName}/issues/${created.number}`);
  check(
    'holds and releases work with needs-human',
    heldOk && !released.labels.some((label) => label.name === 'needs-human'),
  );

  // 6. Removing a label that is already gone is the desired state, not an error.
  let idempotent = true;
  try {
    await client.removeLabel(repo.fullName, created.number, 'needs-human');
  } catch {
    idempotent = false;
  }
  check('removing an absent label is not an error', idempotent);

  // 7. review-gate: the status that holds a pull request until reviews land.
  const head = await client.request('GET', `/repos/${repo.fullName}/commits/main`);
  await client.setCommitStatus(repo.fullName, head.sha, {
    state: 'pending',
    context: 'review-gate',
    description: 'live check: waiting on reviewers',
  });
  const pending = await client.request('GET', `/repos/${repo.fullName}/commits/${head.sha}/status`);
  const pendingEntry = pending.statuses.find((entry) => entry.context === 'review-gate');
  check('sets review-gate pending', pendingEntry?.state === 'pending', pendingEntry?.description);

  await client.setCommitStatus(repo.fullName, head.sha, {
    state: 'success',
    context: 'review-gate',
    description: 'live check: every requested review has been posted',
  });
  const success = await client.request('GET', `/repos/${repo.fullName}/commits/${head.sha}/status`);
  const successEntry = success.statuses.find((entry) => entry.context === 'review-gate');
  check('turns review-gate green', successEntry?.state === 'success', successEntry?.description);

  // 8. The read paths the bridge depends on.
  // GitHub's issue index lags a moment behind a label change, so this retries
  // rather than asserting on the first answer.
  let listed = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    listed = await client.listIssues(repo.fullName, { labels: ['do:ai'], state: 'open' });
    if (listed.some((issue) => issue.number === created.number)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    'lists issues by label',
    listed.some((issue) => issue.number === created.number),
    `${listed.length} open with do:ai`,
  );

  if (!keep) {
    await client.comment(
      repo.fullName,
      created.number,
      'Live check passed: filing, labelling, assigning, gating, releasing and the review-gate status all work against this repository. Closing.',
    );
    await client.request('PATCH', `/repos/${repo.fullName}/issues/${created.number}`, {
      state: 'closed',
      state_reason: 'completed',
    });
    const closed = await client.request('GET', `/repos/${repo.fullName}/issues/${created.number}`);
    check('closes the issue it opened', closed?.state === 'closed', `#${created.number} ${closed?.state}`);
  } else {
    console.log(`\n  left ${created.htmlUrl} open for inspection`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed\n`);
  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\nlive checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});
