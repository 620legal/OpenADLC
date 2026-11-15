#!/usr/bin/env node
/**
 * What only a real release account can say about a release build (#343,
 * docs/adr/0070): that hostd builds a pinned commit of the scratch
 * repository as the account, through `sudo -n` and `env -i`, takes the
 * artifact out as a stream, and records the sha256 of exactly what the
 * command wrote, even when the default branch moves on after the start. The
 * unit tests (`apps/hostd/src/release-run.test.ts`) drive every step with the
 * account's processes faked; this is the claim they cannot make.
 *
 * It asks hostd directly, with the install's secret: nothing in the bridge
 * starts a release before #345's route. It commits to the scratch
 * repository's default branch, so it runs only against a scratch install, and
 * only one whose hostd names a release account (OPENADLC_RELEASE_ACCOUNT, set
 * up as docs/self-hosting.md#the-release-account says). Otherwise it says why
 * and skips. It is not in `all.mjs`:
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/release-run.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSecretStore, internalSecretRef } from '@openadlc/github';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

const HOSTD = process.env.OPENADLC_HOSTD_URL ?? 'http://127.0.0.1:47312';
const REPO_PATH = process.env.OPENADLC_SCRIPTED_REPO_PATH;
const SECRET = await getSecretStore().get(internalSecretRef());
const headers = { 'content-type': 'application/json', 'x-openadlc-internal-secret': SECRET ?? '' };
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function skip(why) {
  console.log(`skipped: ${why}`);
  process.exit(0);
}

async function hostd(method, path, body) {
  const response = await fetch(`${HOSTD}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

if (!SECRET) skip('the scratch install has no internal secret yet; start it with tests/scratch.sh up');
if (!REPO_PATH) skip('OPENADLC_SCRIPTED_REPO_PATH is not set; eval "$(tests/scratch.sh env)" first');
const account = await hostd('GET', '/release/account');
if (account.status !== 200 || !account.body.probe) {
  skip('the scratch hostd names no release account; set OPENADLC_RELEASE_ACCOUNT as docs/self-hosting.md#the-release-account says, and restart it');
}
if (!account.body.probe.ok) skip(`the release account is not fit: ${account.body.probe.detail}. Run openadlc doctor`);

// A bare scratch repository is committed to through a clone and a push; one
// with a working tree, whose checked-out branch refuses a push, in place.
const bare = execFileSync('git', ['-C', REPO_PATH, 'rev-parse', '--is-bare-repository']).toString().trim() === 'true';
const work = bare ? mkdtempSync(join(tmpdir(), 'openadlc-release-suite-')) : REPO_PATH;
if (bare) {
  process.on('exit', () => rmSync(work, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', REPO_PATH, work]);
}
const git = (...args) =>
  execFileSync('git', ['-C', work, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'release-run suite', GIT_AUTHOR_EMAIL: 'suite@example.com', GIT_COMMITTER_NAME: 'release-run suite', GIT_COMMITTER_EMAIL: 'suite@example.com' },
  })
    .toString()
    .trim();
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const publish = () => {
  if (bare) git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
};
// A version above anything earlier runs of this suite left: no `after` is sent.
const version = `0.${Math.floor(Date.now() / 1000)}`;
writeFileSync(join(work, 'VERSION'), `${version}\n`);
git('add', 'VERSION');
git('commit', '--quiet', '-m', `release-run suite: version ${version}`);
publish();
const pinned = git('rev-parse', 'HEAD');

const runId = `suite-${randomUUID()}`;
const started = await hostd('POST', '/release/runs', {
  runId,
  repo: 'acme/testbed',
  sha: pinned,
  defaultBranch: branch,
  versionFile: 'VERSION',
  versionKey: null,
  after: null,
  // The artifact is the pinned sha, as the account's environment carries it:
  // its sha256 is known here without trusting anything the account says.
  command: 'mkdir -p dist && printf "%s" "$OPENADLC_RELEASE_SHA" > dist/a.txt',
  artifact: 'dist/a.txt',
  timeoutMinutes: 5,
  clean: false,
  bot: null,
});
check('hostd takes the start', started.status === 202,`status ${started.status} ${JSON.stringify(started.body).slice(0, 200)}`);

// The branch moves on while the run goes: the run still builds the pinned commit.
git('commit', '--quiet', '--allow-empty', '-m', 'release-run suite: the branch moves on');
publish();

let run = null;
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  const read = await hostd('GET', `/release/runs/${runId}`);
  run = read.body.run ?? null;
  if (run && run.state !== 'running') break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const expected = createHash('sha256').update(pinned).digest('hex');
check('the run is built', run?.state === 'built', `${run?.state}: ${run?.reason ?? ''}`);
check('the version is the pinned commit’s, read by hostd', run?.version === version, String(run?.version));
check('the sha256 is of what the command wrote at the pinned commit', run?.sha256 === expected, `${run?.sha256} against ${expected}`);
check('the size is of the stream', run?.bytes === 40, String(run?.bytes));

const artifact = await fetch(`${HOSTD}/release/runs/${runId}/artifact`, { headers });
const bytes = Buffer.from(await artifact.arrayBuffer());
check('hostd serves its own copy', artifact.status === 200 && bytes.toString() === pinned, `status ${artifact.status}`);
check('the served copy hashes to the run’s sha256', createHash('sha256').update(bytes).digest('hex') === run?.sha256);

// Signing (#344, docs/adr/0071): hostd is given only the URL, signs the
// version and sha256 of its own record, and signs a run under one URL only.
// The publish to GitHub that follows is the bridge's, with the app, and only a
// run #345's route started reaches it; this suite checks hostd's half.
const url = `https://github.com/acme/testbed/releases/download/v${version}/a.txt`;
const signed = await hostd('POST', `/release/runs/${runId}/sign`, { url, version: '9.9.9', sha256: 'f'.repeat(64) });
if (signed.status === 409 && /release-key import/.test(String(signed.body.error))) {
  console.log(`  skip  signing — the scratch install has no key for acme/testbed: ${signed.body.error}`);
} else {
  check('hostd signs the run under the URL', signed.status === 200, `status ${signed.status} ${JSON.stringify(signed.body).slice(0, 200)}`);
  check('it signs its own version and sha256, not the body’s', signed.body.version === version && signed.body.sha256 === run?.sha256);
  const { releaseMessage } = await import('@openadlc/shared');
  const { releaseSigningKeyRef, parseReleaseKeyRecord } = await import('@openadlc/github');
  const record = parseReleaseKeyRecord(await getSecretStore().get(releaseSigningKeyRef('acme/testbed')));
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(String(signed.body.publicKey), 'base64')]), format: 'der', type: 'spki' });
  const message = releaseMessage(record?.tag ?? '', { version, sha256: run?.sha256 ?? '', url });
  check('the signature verifies against the imported key’s public half', verify(null, message, publicKey, Buffer.from(String(signed.body.sig), 'base64')));
  const again = await hostd('POST', `/release/runs/${runId}/sign`, { url: `${url}.other` });
  check('a second URL for the run is refused', again.status === 409, `status ${again.status}`);
}

const removed = await hostd('DELETE', `/release/runs/${runId}/artifact`);
check('the artifact is removed when asked', removed.status === 200 && removed.body.deleted === true, `status ${removed.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
