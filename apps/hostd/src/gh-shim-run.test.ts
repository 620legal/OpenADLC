import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * OpenADLC's `gh` run as a session runs it: the script itself, with a stand-in
 * for the real `gh` behind it on PATH that writes down every call that reaches
 * it. `gh-shim.test.ts` tests the refusals one function at a time; nothing ran
 * `main()`, which chains them, so a refusal it stopped calling would have kept
 * every test green and let the command through.
 */

const SHIM = join(import.meta.dirname, '..', 'bin', 'gh');
const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-gh-run-'));
const reached = join(dir, 'reached.log');
const fakeBin = join(dir, 'bin');

mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\necho "$@" >> "${reached}"\nexit 0\n`);
chmodSync(join(fakeBin, 'gh'), 0o755);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function gh(args: string[], env: Record<string, string> = {}) {
  rmSync(reached, { force: true });
  const run = spawnSync(process.execPath, [SHIM, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: [fakeBin, '/usr/bin', '/bin'].join(delimiter),
      HOME: dir,
      ...env,
    },
  });
  return {
    status: run.status,
    stderr: run.stderr,
    reachedGh: existsSync(reached) ? readFileSync(reached, 'utf8').trim() : null,
  };
}

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('signing a review that names no pull request, end to end', () => {
  it('asks the real gh for the current branch’s pull request before it posts', () => {
    const run = gh(['pr', 'review', '--approve', '--body', 'ok'], {
      FLEETADLC_BOT: 'lead',
      FLEETADLC_TASK_ID: 'task-1',
      // Nothing answers here: the post goes out unsigned, as before.
      FLEETADLC_BRIDGE_URL: 'http://127.0.0.1:1',
    });
    expect(run.status).toBe(0);
    const calls = (run.reachedGh ?? '').split('\n');
    expect(calls[0]).toBe('pr view --json number --jq .number');
    expect(calls[1]).toMatch(/^pr review --approve --body-file /);
  });

  it('asks nothing outside a task', () => {
    const run = gh(['pr', 'review', '--approve', '--body', 'ok'], { FLEETADLC_BOT: 'lead', FLEETADLC_BRIDGE_URL: 'http://127.0.0.1:1' });
    expect(run.status).toBe(0);
    expect(run.reachedGh).not.toContain('pr view');
    expect(run.reachedGh).toMatch(/^pr review --approve --body-file /);
  });
});

describe('the gh a session runs, end to end', () => {
  it('passes an ordinary command through to the real gh', () => {
    const run = gh(['pr', 'view', '7']);
    expect(run.status).toBe(0);
    expect(run.reachedGh).toBe('pr view 7');
  });

  it.each([
    ['gh pr merge', ['pr', 'merge', '7', '--squash']],
    ['gh pr merge --auto', ['pr', 'merge', '7', '--auto']],
    ['the REST merge endpoint', ['api', '-X', 'PUT', 'repos/exampleco/api/pulls/7/merge']],
    ['the REST merge endpoint, written with a leading slash and placeholders', ['api', '--method', 'PUT', '/repos/{owner}/{repo}/pulls/7/merge']],
    ['merging one branch into another', ['api', 'repos/exampleco/api/merges', '-f', 'base=main', '-f', 'head=agent/x']],
    ['GraphQL auto-merge', ['api', 'graphql', '-f', 'query=mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }']],
  ])('refuses %s, and the real gh never runs', (_name, args) => {
    const run = gh(args);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/not merging/);
    expect(run.reachedGh).toBeNull();
  });

  it('reads a GraphQL merge out of the file --input names, and out of -F query=@file', () => {
    const body = file('merge.json', JSON.stringify({ query: 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }' }));
    expect(gh(['api', 'graphql', '--input', body]).reachedGh).toBeNull();
    const query = file('merge.graphql', 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }');
    expect(gh(['api', 'graphql', '-F', `query=@${query}`]).reachedGh).toBeNull();
  });

  it('lets an ordinary GraphQL query through', () => {
    const run = gh(['api', 'graphql', '-f', 'query={ viewer { login } }']);
    expect(run.status).toBe(0);
    expect(run.reachedGh).toMatch(/^api graphql/);
  });

  it('refuses a GraphQL query on stdin, which it cannot read without taking it from the command', () => {
    const run = gh(['api', 'graphql', '--input', '-']);
    expect(run.status).toBe(1);
    expect(run.reachedGh).toBeNull();
  });

  describe('an advisory reviewer', () => {
    const advisory = { FLEETADLC_REVIEW_MODE: 'advisory' };

    it('cannot approve through the API, as a field or in a JSON body', () => {
      expect(gh(['api', 'repos/exampleco/api/pulls/7/reviews', '-f', 'event=APPROVE'], advisory).reachedGh).toBeNull();
      const body = file('review.json', JSON.stringify({ event: 'REQUEST_CHANGES', body: 'no' }));
      const run = gh(['api', 'repos/exampleco/api/pulls/7/reviews', '--input', body], advisory);
      expect(run.status).toBe(1);
      expect(run.reachedGh).toBeNull();
    });

    it('cannot approve through GraphQL', () => {
      const query = 'mutation { addPullRequestReview(input: {pullRequestId: "x", event: APPROVE}) { clientMutationId } }';
      expect(gh(['api', 'graphql', '-f', `query=${query}`], advisory).reachedGh).toBeNull();
    });

    it('can still comment', () => {
      const run = gh(['api', 'repos/exampleco/api/pulls/7/reviews', '-f', 'event=COMMENT', '-f', 'body=looks fine'], advisory);
      expect(run.status).toBe(0);
      expect(run.reachedGh).not.toBeNull();
    });
  });
});
