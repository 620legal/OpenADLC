import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * OpenADLC's `gh` run as a session runs it: the script itself, with a stand-in
 * for the real `gh` behind it on PATH that writes down every call that reaches
 * it. `gh-shim.test.ts` tests the refusals one function at a time; nothing ran
 * `main()`, which chains them, so a refusal it stopped calling would have kept
 * every test green and let the command through.
 */

const SHIM = join(import.meta.dirname, '..', 'bin', 'gh');
const dir = mkdtempSync(join(tmpdir(), 'openadlc-gh-run-'));
const reached = join(dir, 'reached.log');
const fakeBin = join(dir, 'bin');

mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\necho "$@" >> "${reached}"\nexit 0\n`);
chmodSync(join(fakeBin, 'gh'), 0o755);

// A worktree to review in: a review is signed with its HEAD. And somewhere
// that is not one.
const worktree = join(dir, 'worktree');
const nowhere = mkdtempSync(join(tmpdir(), 'openadlc-gh-run-nowhere-'));
mkdirSync(worktree);
spawnSync('git', ['init', '-q'], { cwd: worktree });
spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: worktree });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(nowhere, { recursive: true, force: true });
});

function gh(args: string[], env: Record<string, string> = {}, cwd = dir) {
  rmSync(reached, { force: true });
  const run = spawnSync(process.execPath, [SHIM, ...args], {
    cwd,
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
    const run = gh(
      ['pr', 'review', '--approve', '--body', 'ok'],
      {
        OPENADLC_BOT: 'lead',
        OPENADLC_TASK_ID: 'task-1',
        // Nothing answers here: the post goes out unsigned, as before.
        OPENADLC_BRIDGE_URL: 'http://127.0.0.1:1',
      },
      worktree,
    );
    expect(run.status).toBe(0);
    const calls = (run.reachedGh ?? '').split('\n');
    expect(calls[0]).toBe('pr view --json number --jq .number');
    expect(calls[1]).toMatch(/^pr review --approve --body-file /);
  });

  it('posts no review it would sign from where HEAD cannot be read, the head it would be signed with', () => {
    // Not a repository above it either, wherever the temporary folder is.
    const alone = { GIT_CEILING_DIRECTORIES: dirname(nowhere) };
    const run = gh(['pr', 'review', '7', '--approve', '--body', 'ok'], { OPENADLC_BOT: 'lead', OPENADLC_TASK_ID: 'task-1', OPENADLC_BRIDGE_URL: 'http://127.0.0.1:1', ...alone }, nowhere);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/run gh pr review from the worktree you reviewed/);
    expect(run.reachedGh).toBeNull();
  });

  it('asks nothing outside a task', () => {
    const run = gh(['pr', 'review', '--approve', '--body', 'ok'], { OPENADLC_BOT: 'lead', OPENADLC_BRIDGE_URL: 'http://127.0.0.1:1' });
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

  describe('a pull request body in a repository with a template', () => {
    const templated = join(dir, 'templated');
    mkdirSync(join(templated, '.github'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: templated });
    writeFileSync(
      join(templated, '.github', 'pull_request_template.md'),
      'Closes #\n\n## What changed\n\n<!-- What. -->\n\n## How to see it\n\n<!-- How. -->\n\n## What is not proven here\n\n<!-- What not. -->\n',
    );
    // A task's session; nothing answers at the bridge, so a post that goes out goes unsigned.
    const task = { OPENADLC_BOT: 'builder', OPENADLC_TASK_ID: 'task-1', OPENADLC_BRIDGE_URL: 'http://127.0.0.1:1' };

    it('refuses a body that leaves a section out, naming it, and the real gh never runs', () => {
      const body = file('short.md', 'Closes #9\n\n## What changed\n\nThis.\n\n## What is not proven here\n\nNone\n');
      const run = gh(['pr', 'create', '--title', 't', '--body-file', body], task, templated);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('"## How to see it"');
      expect(run.stderr).toContain('.github/pull_request_template.md');
      expect(run.reachedGh).toBeNull();
    });

    it('refuses a body given on stdin that leaves a section empty', () => {
      rmSync(reached, { force: true });
      const run = spawnSync(process.execPath, [SHIM, 'pr', 'edit', '7', '--body-file', '-'], {
        cwd: templated,
        encoding: 'utf8',
        input: '## What changed\n\nThis.\n\n## How to see it\n\n<!-- How. -->\n\n## What is not proven here\n\nNone\n',
        env: { PATH: [fakeBin, '/usr/bin', '/bin'].join(delimiter), HOME: dir, ...task },
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('leaves "## How to see it" empty');
      expect(existsSync(reached)).toBe(false);
    });

    it('lets a body that fills every section through', () => {
      const body = file('full.md', 'Closes #9\n\n## What changed\n\nThis.\n\n## How to see it\n\nRan it.\n\n## What is not proven here\n\nNone\n');
      const run = gh(['pr', 'create', '--title', 't', '--body-file', body], task, templated);
      expect(run.status).toBe(0);
      expect(run.reachedGh).toMatch(/^pr create --title t --body-file /);
    });

    it('holds a person’s own shell, which names no task, to nothing', () => {
      const body = file('loose.md', 'Just this.');
      const run = gh(['pr', 'create', '--title', 't', '--body-file', body], { OPENADLC_BOT: 'builder' }, templated);
      expect(run.status).toBe(0);
      expect(run.reachedGh).not.toBeNull();
    });
  });

  describe('an advisory reviewer', () => {
    const advisory = { OPENADLC_REVIEW_MODE: 'advisory' };

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
