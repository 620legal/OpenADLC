#!/usr/bin/env node
/**
 * Proves the part of the implement loop that only GitHub can confirm: a task
 * clones the repository with a brokered token, branches under `agent/`, commits
 * with a signature, pushes, and opens a pull request that the platform can then
 * label, request reviews on and gate.
 *
 * It cleans up after itself: the pull request is closed and the branch deleted.
 *
 *   node tests/github-live-pr.mjs           # run and clean up
 *   node tests/github-live-pr.mjs --keep    # leave the pull request open
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bots, closePool, repos, waitForDatabase } from '@fleetadlc/db';
import {
  GitHubApiError,
  GitHubClient,
  accessTokenRef,
  generateSigningKey,
  getSecretStore,
  internalSecretRef,
  refreshTokenRef,
  signingKeyRef,
  TokenBroker,
} from '@fleetadlc/github';
import { automationBotOf, redactSecrets, resolveBotRef } from '@fleetadlc/shared';

const run = promisify(execFile);
const keep = process.argv.includes('--keep');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
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

async function tokenFor(botName) {
  const bot = await bots.getBotByName(botName);
  const login = bot?.githubLogin ?? botName;
  const fromBridge = await tokenFromBridge(botName);
  if (fromBridge) return { token: fromBridge, login };
  const store = getSecretStore();

  const refresh = await store.get(refreshTokenRef(botName));
  if (refresh && process.env.FLEETADLC_GITHUB_CLIENT_ID) {
    const broker = new TokenBroker({ clientId: process.env.FLEETADLC_GITHUB_CLIENT_ID });
    const brokered = await broker.tokenFor(botName, login);
    return { token: brokered.token, login };
  }

  const staticToken = await store.get(accessTokenRef(botName));
  if (!staticToken) throw new Error(`${botName} is not connected; run: fleetadlc auth login --bot ${botName}`);
  return { token: staticToken, login };
}

/** Mirrors what hostd does per task: an agent holding the signing key, nothing on disk. */
async function startSigningAgent(botName) {
  const store = getSecretStore();
  let privateKey = await store.get(signingKeyRef(botName));

  if (!privateKey) {
    const pair = generateSigningKey(botName);
    await store.set(signingKeyRef(botName), pair.privateKey);
    privateKey = pair.privateKey;
  }

  const dir = mkdtempSync(join(tmpdir(), `fleetadlc-live-agent-`));
  const socket = join(dir, 'agent.sock');
  await run('ssh-agent', ['-a', socket]);

  const { spawn } = await import('node:child_process');
  const add = spawn('ssh-add', ['-'], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
  add.stdin.end(privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`);
  await new Promise((resolve, reject) => {
    add.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ssh-add exited ${code}`))));
    add.on('error', reject);
  });

  const { stdout } = await run('ssh-add', ['-L'], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
  return {
    socket,
    publicKey: stdout.trim().split('\n')[0],
    stop: async () => {
      await run('ssh-agent', ['-k'], { env: { ...process.env, SSH_AUTH_SOCK: socket } }).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main() {
  await waitForDatabase();

  const repo = (await repos.listRepos())[0];
  if (!repo) throw new Error('no repository is configured');

  // The bot to push as: FLEETADLC_LIVE_BUILDER by seat or name, else the
  // automation bot, found by its role — whatever handle its account gave it.
  const crew = await bots.listBots();
  const builder = process.env.FLEETADLC_LIVE_BUILDER
    ? resolveBotRef(crew, process.env.FLEETADLC_LIVE_BUILDER)
    : automationBotOf(crew);
  if (!builder) throw new Error(`no bot ${process.env.FLEETADLC_LIVE_BUILDER ?? 'with the automation role'} on this install`);
  const builderName = builder.name;
  const { token, login } = await tokenFor(builderName);
  const client = new GitHubClient({ token, actingAs: login });

  console.log(`\nlive pull request checks against ${repo.fullName} as ${login}\n`);

  const stamp = Date.now().toString(36);
  const branch = `agent/${builderName}/live-${stamp}`;
  const workdir = mkdtempSync(join(tmpdir(), 'fleetadlc-live-wt-'));
  const agent = await startSigningAgent(builderName);

  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    SSH_AUTH_SOCK: agent.socket,
    GIT_AUTHOR_NAME: builderName,
    GIT_COMMITTER_NAME: builderName,
    GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
    GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com`,
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'gpg.format',
    GIT_CONFIG_VALUE_0: 'ssh',
    GIT_CONFIG_KEY_1: 'user.signingkey',
    GIT_CONFIG_VALUE_1: `key::${agent.publicKey}`,
    GIT_CONFIG_KEY_2: 'commit.gpgsign',
    GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_3: 'gpg.ssh.program',
    GIT_CONFIG_VALUE_3: existsSync('/usr/bin/ssh-keygen') ? '/usr/bin/ssh-keygen' : 'ssh-keygen',
    // The token reaches git as a header, from the environment. In the remote's
    // URL it was in git's arguments, so a failed clone or push printed it in
    // the error, and the clone wrote it into the mirror's config.
    GIT_CONFIG_KEY_4: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_4: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };

  const git = (args, cwd = workdir) => run('git', args, { cwd, env: gitEnv, maxBuffer: 16 * 1024 * 1024 });

  // Outside the try, so the finally can take them down too: closing them only
  // at the end of the try left an open pull request and its branch in the real
  // repository whenever a label, status or comment step threw on the way.
  let pull = null;
  let pushed = false;
  let cleanedUp = false;
  const cleanUp = async () => {
    if (pull) {
      await client.request('PATCH', `/repos/${repo.fullName}/pulls/${pull.number}`, { state: 'closed' }).catch((error) => {
        console.error(`  could not close #${pull.number}: ${error instanceof Error ? error.message : error}`);
      });
    }
    if (pushed) {
      await client.request('DELETE', `/repos/${repo.fullName}/git/refs/heads/${branch}`).catch((error) => {
        console.error(`  could not delete ${branch}: ${error instanceof Error ? error.message : error}`);
      });
    }
    cleanedUp = true;
  };

  try {
    // 1. Clone with the brokered token, the way hostd warms a mirror.
    const remote = `https://github.com/${repo.fullName}.git`;
    const mirror = join(workdir, 'mirror.git');
    await git(['clone', '--bare', '--depth', '1', remote, mirror], workdir);
    check('clones the repository with a brokered token', existsSync(join(mirror, 'HEAD')));

    // 2. A worktree off the default branch, then the agent branch.
    const tree = join(workdir, 'wt');
    await git(['worktree', 'add', '--detach', tree, 'HEAD'], mirror);
    await git(['checkout', '-B', branch], tree);
    check('creates a worktree and an agent branch', existsSync(join(tree, 'README.md')), branch);

    // 3. A commit the platform signs.
    const marker = join(tree, 'tests', 'fixtures', `live-${stamp}.txt`);
    await run('mkdir', ['-p', join(tree, 'tests', 'fixtures')]);
    writeFileSync(
      marker,
      [
        'Written by tests/github-live-pr.mjs to prove the implement loop can branch,',
        'sign, push and open a pull request against a real repository.',
        `run: ${stamp}`,
      ].join('\n'),
    );
    await git(['add', '-A'], tree);
    await git(['commit', '-m', `Prove the live pull request path (${stamp})`], tree);

    // The commit object itself is the evidence: local verification would need an
    // allowed-signers file, but GitHub verifies against the account's key.
    const { stdout: raw } = await git(['cat-file', 'commit', 'HEAD'], tree);
    check(
      'signs the commit with the key held in the agent',
      raw.includes('gpgsig'),
      raw.includes('gpgsig') ? 'gpgsig header present' : 'no signature on the commit object',
    );

    const { stdout: author } = await git(['log', '-1', '--format=%an <%ae>'], tree);
    check('authors the commit as the bot', author.includes(login), author.trim());

    // 4. Push the work branch.
    await git(['push', remote, `${branch}:${branch}`], tree);
    pushed = true;
    const onGitHub = await client
      .request('GET', `/repos/${repo.fullName}/git/ref/heads/${branch}`)
      .then(() => true)
      .catch(() => false);
    check('pushes the branch', onGitHub, branch);

    // 5. Open it as a draft, the way the implement skill does.
    pull = await client.request('POST', `/repos/${repo.fullName}/pulls`, {
      title: `Live check: the implement loop can open a pull request (${stamp})`,
      head: branch,
      base: repo.defaultBranch,
      draft: true,
      body: [
        'Opened by `tests/github-live-pr.mjs`.',
        '',
        '### What this proves',
        '- a task can clone with a brokered token, branch under `agent/`, sign and push',
        '- the platform can open a draft pull request and then label and gate it',
        '',
        'This pull request closes itself when the check finishes.',
      ].join('\n'),
    });
    check('opens a draft pull request', pull.draft === true, `#${pull.number}`);

    // 6. The automation the bridge performs on a new pull request.
    await client.addLabels(repo.fullName, pull.number, ['do:ai', 'area:infra']);
    const labelled = await client.request('GET', `/repos/${repo.fullName}/issues/${pull.number}`);
    check(
      'labels the pull request',
      labelled.labels.some((label) => label.name === 'do:ai'),
      labelled.labels.map((label) => label.name).join(', '),
    );

    const files = await client.listPullFiles(repo.fullName, pull.number);
    check('reads the changed files the reviewer rules need', files.length === 1, files.join(', '));

    await client.setCommitStatus(repo.fullName, pull.head.sha, {
      state: 'pending',
      context: 'review-gate',
      description: 'live check: pull request is still a draft',
    });
    const draftStatus = await client.request('GET', `/repos/${repo.fullName}/commits/${pull.head.sha}/status`);
    check(
      'holds review-gate while the pull request is a draft',
      draftStatus.statuses.find((entry) => entry.context === 'review-gate')?.state === 'pending',
    );

    // 7. Ready for review, then the gate goes green once reviews would be in.
    await client.request('PATCH', `/repos/${repo.fullName}/pulls/${pull.number}`, { draft: false }).catch(() => {
      // Undrafting needs GraphQL on some plans; the status path below is what matters.
    });
    await client.setCommitStatus(repo.fullName, pull.head.sha, {
      state: 'success',
      context: 'review-gate',
      description: 'live check: every requested review has been posted',
    });
    const greenStatus = await client.request('GET', `/repos/${repo.fullName}/commits/${pull.head.sha}/status`);
    check(
      'turns review-gate green',
      greenStatus.statuses.find((entry) => entry.context === 'review-gate')?.state === 'success',
    );

    // 8. A review comment, as a reviewer bot would leave.
    await client.comment(
      repo.fullName,
      pull.number,
      [
        '**Live check review.** Verdict: approve.',
        '',
        'Verified: the branch was pushed by the platform, the diff is one fixture file, and the',
        '`review-gate` status moved from pending to success as the rules say it should.',
      ].join('\n'),
    );
    const comments = await client.request('GET', `/repos/${repo.fullName}/issues/${pull.number}/comments`);
    check('posts a review comment', comments.length >= 1, `${comments.length} comment(s)`);

    // 9. The reviewer rules name accounts; requesting one that does not exist
    //    must fail loudly rather than silently leave the pull request
    //    unreviewed. Asked of this suite's own pull request, and only GitHub's
    //    refusal of the reviewer counts: on pull request #1 any error passed,
    //    a missing pull request included.
    let refusal = null;
    try {
      await client.requestReviewers(repo.fullName, pull.number, ['this-account-does-not-exist-fleetadlc']);
    } catch (error) {
      refusal = error;
    }
    check(
      'requesting an unknown reviewer fails loudly',
      refusal instanceof GitHubApiError && refusal.status === 422,
      refusal ? String(refusal.message ?? refusal).slice(0, 120) : 'GitHub accepted it',
    );

    if (!keep) {
      await cleanUp();
      const branchGone = await client
        .request('GET', `/repos/${repo.fullName}/git/ref/heads/${branch}`)
        .then(() => false)
        .catch(() => true);
      check('closes the pull request and deletes the branch', branchGone, `#${pull.number}`);
    } else {
      console.log(`\n  left ${pull.html_url} open for inspection`);
    }
  } finally {
    if (!keep && !cleanedUp) await cleanUp();
    await agent.stop();
    rmSync(workdir, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live pull request checks passed\n`);
  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\nlive pull request checks failed: ${redactSecrets(String(error instanceof Error ? error.message : error))}\n`);
  await closePool();
  process.exit(1);
});
