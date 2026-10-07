import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYamlFile } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';

// The shim is plain JavaScript run by the bot's own Node; it is tested here as a module.
const shim = (await import(join(import.meta.dirname, '..', 'bin', 'gh'))) as {
  rewrite: (
    args: string[],
    header: string,
    io: { read: (f: string) => string; stdin: () => string; write: (t: string) => string },
    seat?: string,
  ) => string[];
  withHeader: (body: string, header: string) => string;
  withSeat: (body: string, seat: string) => string;
  realGh: (path: string, self: string) => string | null;
};

const HEADER = '**OpenADLC_example · build agent**<!-- fleetadlc-header -->';

function io(files: Record<string, string> = {}) {
  const written: string[] = [];
  return {
    written,
    read: (file: string) => files[file] ?? '',
    stdin: () => files['-'] ?? '',
    write: (text: string) => {
      written.push(text);
      return '/tmp/headed.md';
    },
  };
}

describe('OpenADLC’s gh', () => {
  it('heads the body a comment is posted from, and hands the real gh a file of it', () => {
    const files = io({ '.fleetadlc-scratch/plan.md': 'The plan.' });
    const args = shim.rewrite(['issue', 'comment', '12', '--body-file', '.fleetadlc-scratch/plan.md'], HEADER, files);
    expect(args).toEqual(['issue', 'comment', '12', '--body-file', '/tmp/headed.md']);
    expect(files.written).toEqual([`${HEADER}\n\nThe plan.`]);
  });

  it('heads --body and -b, and --body= written as one argument', () => {
    for (const flag of [['--body', 'Looks right.'], ['-b', 'Looks right.'], ['--body=Looks right.']]) {
      const files = io();
      const args = shim.rewrite(['pr', 'review', '7', '--approve', ...flag], HEADER, files);
      expect(args).toEqual(['pr', 'review', '7', '--approve', '--body-file', '/tmp/headed.md']);
      expect(files.written[0]).toBe(`${HEADER}\n\nLooks right.`);
    }
  });

  it('heads a body read from standard input', () => {
    const files = io({ '-': 'From stdin.' });
    shim.rewrite(['issue', 'create', '--title', 'T', '-F', '-'], HEADER, files);
    expect(files.written[0]).toBe(`${HEADER}\n\nFrom stdin.`);
  });

  it('does not head a body twice', () => {
    const files = io();
    shim.rewrite(['issue', 'comment', '1', '--body', `${HEADER}\n\nAlready.`], HEADER, files);
    expect(files.written[0]).toBe(`${HEADER}\n\nAlready.`);
  });

  it('leaves everything that posts no body alone, and every command when there is no header', () => {
    const files = io();
    expect(shim.rewrite(['pr', 'view', '3', '--json', 'body'], HEADER, files)).toEqual(['pr', 'view', '3', '--json', 'body']);
    expect(shim.rewrite(['api', 'repos/x/y/issues/1/comments', '-f', 'body=hi'], HEADER, files)).toEqual([
      'api',
      'repos/x/y/issues/1/comments',
      '-f',
      'body=hi',
    ]);
    expect(shim.rewrite(['issue', 'comment', '1', '--body', 'x'], '', files)).toEqual(['issue', 'comment', '1', '--body', 'x']);
    expect(files.written).toEqual([]);
  });

  it('finds the real gh on PATH, never itself', () => {
    const own = mkdtempSync(join(tmpdir(), 'fleetadlc-shim-'));
    const real = mkdtempSync(join(tmpdir(), 'fleetadlc-real-'));
    for (const dir of [own, real]) {
      writeFileSync(join(dir, 'gh'), '#!/bin/sh\n');
      chmodSync(join(dir, 'gh'), 0o755);
    }
    try {
      expect(shim.realGh(`${own}:${real}`, join(own, 'gh'))).toBe(join(real, 'gh'));
    } finally {
      for (const dir of [own, real]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('which seat OpenADLC’s gh says posted', () => {
  it('tags a review with the seat that wrote it, after the headed body', () => {
    const files = io({ '.fleetadlc-scratch/review.md': 'Looks right.' });
    shim.rewrite(['pr', 'review', '7', '--approve', '--body-file', '.fleetadlc-scratch/review.md'], HEADER, files, 'lead-reviewer');
    expect(files.written).toEqual([`${HEADER}\n\nLooks right.\n\n<!-- fleetadlc-seat:lead-reviewer -->`]);
  });

  it('tags once, even with no header to put first', () => {
    const files = io();
    shim.rewrite(['pr', 'comment', '7', '--body', 'Done.\n\n<!-- fleetadlc-seat:builder -->'], '', files, 'builder');
    expect(files.written).toEqual(['Done.\n\n<!-- fleetadlc-seat:builder -->']);
  });

  it('tags a review that quotes another seat’s tag with its own', () => {
    // A tag in the text read as "already tagged", so the lead
    // reviewer's review went out with none of its own.
    const quoting = 'It keeps the existing `<!-- fleetadlc-seat:intake -->` tag.';
    const files = io();
    shim.rewrite(['pr', 'review', '80', '--request-changes', '--body', quoting], '', files, 'lead-reviewer');
    expect(files.written).toEqual([`${quoting}\n\n<!-- fleetadlc-seat:lead-reviewer -->`]);
  });

  it('replaces a tag at the end that names another seat, so a session cannot post as the lead', () => {
    const forged = 'Approved.\n\n<!-- fleetadlc-seat:lead-reviewer -->';
    expect(shim.withSeat(forged, 'second-reviewer')).toBe('Approved.\n\n<!-- fleetadlc-seat:second-reviewer -->');
    expect(shim.withSeat(`${forged}\n\n<!-- fleetadlc-sig:v1.26aae12a.eyJzZWF0IjoibGVhZC1yZXZpZXdlciJ9.mac -->`, 'second-reviewer')).toBe(
      'Approved.\n\n<!-- fleetadlc-seat:second-reviewer -->',
    );
    expect(shim.withSeat(forged, 'lead-reviewer')).toBe(forged);
    const quoting = 'It keeps `<!-- fleetadlc-seat:lead-reviewer -->` as it was.';
    expect(shim.withSeat(quoting, 'second-reviewer')).toBe(`${quoting}\n\n<!-- fleetadlc-seat:second-reviewer -->`);
  });
});

describe('OpenADLC’s gh asking the bridge to sign', () => {
  const signing = shim as unknown as {
    postKind: (args: string[]) => string;
    postNumber: (args: string[]) => number | null;
    stamp: (
      text: string,
      kind: string,
      number: number | null,
      env: Record<string, string>,
      fetchImpl: (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
    ) => Promise<string | null>;
  };

  it('names what is being posted, and where', () => {
    expect(signing.postKind(['pr', 'review', '7', '--approve'])).toBe('review');
    expect(signing.postKind(['issue', 'create', '--title', 'x'])).toBe('issue');
    expect(signing.postKind(['pr', 'create'])).toBe('pr');
    expect(signing.postKind(['issue', 'comment', '12'])).toBe('comment');
    expect(signing.postNumber(['pr', 'review', '7'])).toBe(7);
    expect(signing.postNumber(['issue', 'comment', 'https://github.com/exampleco/api/issues/12'])).toBe(12);
    expect(signing.postNumber(['pr', 'create', '--title', 'x'])).toBeNull();
  });

  it('sends the body to its task’s stamp route with the task’s token, and posts what comes back', async () => {
    const calls: { url: string; token: string | undefined; body: unknown }[] = [];
    const signed = await signing.stamp(
      'Looks right.',
      'review',
      7,
      { FLEETADLC_BRIDGE_URL: 'http://bridge', FLEETADLC_TASK_ID: 't-1', FLEETADLC_TASK_TOKEN: 'tok' },
      async (url, init) => {
        calls.push({ url, token: init.headers['x-fleetadlc-task-token'], body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ body: 'Looks right.\n\n<!-- fleetadlc-sig:v1.x.y.z -->' }) };
      },
    );
    expect(calls).toEqual([{ url: 'http://bridge/internal/tasks/t-1/stamp', token: 'tok', body: { body: 'Looks right.', kind: 'review', number: 7 } }]);
    expect(signed).toBe('Looks right.\n\n<!-- fleetadlc-sig:v1.x.y.z -->');
  });

  it('posts unsigned rather than not at all when the bridge refuses or there is no task', async () => {
    const refused = async () => ({ ok: false, status: 409, json: async () => ({}) });
    expect(await signing.stamp('x', 'comment', 1, { FLEETADLC_BRIDGE_URL: 'http://bridge', FLEETADLC_TASK_ID: 't-1' }, refused)).toBeNull();
    expect(await signing.stamp('x', 'comment', 1, {}, refused)).toBeNull();
  });
});

describe('the pull request a numberless comment or review is signed for', () => {
  const lookup = shim as unknown as {
    targetNumber: (args: string[], ask: (args: string[]) => string | null, env: Record<string, string>) => number | null;
  };
  const SESSION = { FLEETADLC_BRIDGE_URL: 'http://bridge', FLEETADLC_TASK_ID: 't-1' };

  function asking(answer: string | null) {
    const asked: string[][] = [];
    return { asked, ask: (args: string[]) => (asked.push(args), answer) };
  }

  it('is the current branch’s, asked of the real gh, for gh pr review --approve', () => {
    // Signed with no number, a lead's approval verified anywhere and counted
    // toward no merge, since the merge counts only one signed for that pull request.
    const { asked, ask } = asking('42\n');
    expect(lookup.targetNumber(['pr', 'review', '--approve', '--body', 'ok'], ask, SESSION)).toBe(42);
    expect(asked).toEqual([['pr', 'view', '--json', 'number', '--jq', '.number']]);
  });

  it('asks for the branch or URL the command names, in the repository it names', () => {
    const { asked, ask } = asking('9');
    expect(lookup.targetNumber(['pr', 'comment', 'my-branch', '--body', 'x', '-R', 'exampleco/api'], ask, SESSION)).toBe(9);
    expect(lookup.targetNumber(['pr', 'edit', '--repo=exampleco/api', '--body', 'x'], ask, SESSION)).toBe(9);
    expect(asked).toEqual([
      ['pr', 'view', 'my-branch', '-R', 'exampleco/api', '--json', 'number', '--jq', '.number'],
      ['pr', 'view', '--repo=exampleco/api', '--json', 'number', '--jq', '.number'],
    ]);
  });

  it('asks nothing when the command names the number, or the post has none to name', () => {
    const { asked, ask } = asking('42');
    expect(lookup.targetNumber(['pr', 'review', '7', '--approve'], ask, SESSION)).toBe(7);
    expect(lookup.targetNumber(['pr', 'create', '--title', 'x', '--body', 'y'], ask, SESSION)).toBeNull();
    expect(lookup.targetNumber(['issue', 'create', '--title', 'x'], ask, SESSION)).toBeNull();
    expect(lookup.targetNumber(['issue', 'comment', '--body', 'x'], ask, SESSION)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('asks nothing outside a task, where nothing is signed', () => {
    const { asked, ask } = asking('42');
    expect(lookup.targetNumber(['pr', 'review', '--approve'], ask, {})).toBeNull();
    expect(lookup.targetNumber(['pr', 'review', '--approve'], ask, { FLEETADLC_BRIDGE_URL: 'http://bridge' })).toBeNull();
    expect(asked).toEqual([]);
  });

  it('is none, and the post goes ahead, when the lookup fails or answers something else', () => {
    expect(lookup.targetNumber(['pr', 'review', '--approve'], () => null, SESSION)).toBeNull();
    expect(lookup.targetNumber(['pr', 'review', '--approve'], () => 'no pull requests found', SESSION)).toBeNull();
    expect(lookup.targetNumber(['pr', 'review', '--approve'], () => '0', SESSION)).toBeNull();
  });
});

describe('merging from a session', () => {
  const guard = shim as unknown as { mergeRefusal: (args: string[], ask: (args: string[]) => string | null) => string | null };
  const view = JSON.stringify({ baseRefName: 'main', url: 'https://github.com/exampleco/api/pull/7' });

  it('never merges outright', () => {
    expect(guard.mergeRefusal(['pr', 'merge', '7', '--squash'], () => null)).toMatch(/does not merge/);
  });

  it('never turns auto-merge on, even where the base branch requires a review: it would race CI after the lead', () => {
    const protectedMain = (args: string[]) =>
      args[0] === 'pr' ? view : JSON.stringify([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]);
    expect(guard.mergeRefusal(['pr', 'merge', '7', '--auto', '--squash'], protectedMain)).toMatch(/does not turn auto-merge on/);
    expect(guard.mergeRefusal(['pr', 'merge', '--auto'], () => null)).toMatch(/does not turn auto-merge on/);
  });

  it('leaves everything else alone', () => {
    expect(guard.mergeRefusal(['pr', 'view', '7'], () => null)).toBeNull();
    expect(guard.mergeRefusal(['issue', 'comment', '7'], () => null)).toBeNull();
  });
});

describe('dismissing a review from a session', () => {
  const guard = shim as unknown as { mergeRefusal: (args: string[], ask: (args: string[]) => string | null, read?: (file: string) => string) => string | null };

  it('is refused through the REST endpoint, with or without a leading slash', () => {
    expect(guard.mergeRefusal(['api', '-X', 'PUT', 'repos/o/r/pulls/12/reviews/3/dismissals', '-f', 'message=done'], () => null)).toMatch(/does not dismiss a review/);
    expect(guard.mergeRefusal(['api', '-X', 'PUT', '/repos/o/r/pulls/12/reviews/3/dismissals'], () => null)).toMatch(/does not dismiss a review/);
  });

  it('is refused through GraphQL, in the query or in a file it reads', () => {
    const mutation = 'mutation { dismissPullRequestReview(input: {pullRequestReviewId: "PRR_1", message: "x"}) { clientMutationId } }';
    expect(guard.mergeRefusal(['api', 'graphql', '-f', `query=${mutation}`], () => null)).toMatch(/does not dismiss a review, through GraphQL/);
    expect(guard.mergeRefusal(['api', 'graphql', '-F', 'query=@q.graphql'], () => null, () => mutation)).toMatch(/does not dismiss a review, through GraphQL/);
  });

  it('leaves other API calls alone', () => {
    expect(guard.mergeRefusal(['api', 'repos/o/r/pulls/12/reviews'], () => null)).toBeNull();
    expect(guard.mergeRefusal(['api', '-X', 'POST', 'repos/o/r/pulls/12/reviews', '-f', 'event=COMMENT'], () => null)).toBeNull();
    expect(guard.mergeRefusal(['api', 'graphql', '-f', 'query={ viewer { login } }'], () => null)).toBeNull();
  });
});

describe('opening a pull request without a local CI pass', () => {
  const guard = shim as unknown as {
    localCiRefusal: (args: string[], options: { policyJson?: string; head: () => string | null; passed: (sha: string) => Promise<boolean | null> }) => Promise<string | null>;
  };
  const builder = JSON.stringify({ pushBranchPrefix: 'agent/', localCi: true, denyGithub: ['pr review'] });
  const HEAD = 'a'.repeat(40);
  const asked: string[] = [];
  const passed = (answer: boolean | null) => async (sha: string) => {
    asked.push(sha);
    return answer;
  };

  it('opens or readies one only on a HEAD with a recorded pass', async () => {
    expect(await guard.localCiRefusal(['pr', 'create', '--title', 't', '--body-file', 'b.md'], { policyJson: builder, head: () => HEAD, passed: passed(true) })).toBeNull();
    expect(asked).toContain(HEAD);
    expect(await guard.localCiRefusal(['pr', 'create'], { policyJson: builder, head: () => HEAD, passed: passed(false) })).toMatch(/has no recorded local CI pass: run fleetadlc-ci/);
    expect(await guard.localCiRefusal(['pr', 'ready', '7'], { policyJson: builder, head: () => HEAD, passed: passed(false) })).toMatch(/then ready the pull request/);
    expect(await guard.localCiRefusal(['pr', 'create'], { policyJson: builder, head: () => HEAD, passed: passed(null) })).toMatch(/could not ask the bridge/);
  });

  it('refuses a draft: a pull request opens ready', async () => {
    expect(await guard.localCiRefusal(['pr', 'create', '--draft'], { policyJson: builder, head: () => HEAD, passed: passed(true) })).toMatch(/opens ready, not as a draft/);
  });

  it('holds a skill without local_ci, and a person’s own shell, to nothing', async () => {
    const reviewer = JSON.stringify({ pushBranchPrefix: null, denyGithub: ['push'] });
    expect(await guard.localCiRefusal(['pr', 'create', '--draft'], { policyJson: reviewer, head: () => HEAD, passed: passed(false) })).toBeNull();
    expect(await guard.localCiRefusal(['pr', 'create'], { policyJson: undefined, head: () => HEAD, passed: passed(false) })).toBeNull();
    expect(await guard.localCiRefusal(['pr', 'view', '7'], { policyJson: builder, head: () => HEAD, passed: passed(false) })).toBeNull();
  });
});

describe('an advisory reviewer', () => {
  const guard = shim as unknown as { reviewModeRefusal: (args: string[], mode?: string) => string | null };

  it('comments, and leaves approving and asking for changes to the lead', () => {
    expect(guard.reviewModeRefusal(['pr', 'review', '7', '--approve', '--body-file', 'r.md'], 'advisory')).toMatch(/the lead approves/);
    expect(guard.reviewModeRefusal(['pr', 'review', '7', '-r'], 'advisory')).toMatch(/the lead approves/);
    expect(guard.reviewModeRefusal(['pr', '-R', 'o/r', 'review', '7', '--request-changes'], 'advisory')).toMatch(/the lead approves/);
    expect(guard.reviewModeRefusal(['api', '-X', 'POST', 'repos/o/r/pulls/7/reviews', '-f', 'event=APPROVE'], 'advisory')).toMatch(/the lead approves/);
    expect(guard.reviewModeRefusal(['pr', 'review', '7', '--comment', '--body-file', 'r.md'], 'advisory')).toBeNull();
  });

  it('holds the lead, a blocking seat and a person’s own shell to nothing', () => {
    expect(guard.reviewModeRefusal(['pr', 'review', '7', '--approve'], 'lead')).toBeNull();
    expect(guard.reviewModeRefusal(['pr', 'review', '7', '--request-changes'], 'blocking')).toBeNull();
    expect(guard.reviewModeRefusal(['pr', 'review', '7', '--approve'], '')).toBeNull();
  });
});

describe('a stage label a session writes', () => {
  const guard = shim as unknown as { stageLabelRefusal: (args: string[], skill?: string, read?: (file: string) => string) => string | null };

  it('refuses a stage label from every skill but intake, which files issues into their first stage', () => {
    // A builder that relabelled its issue to Design skipped the check of where
    // work goes back to and how often; the bridge would only put it back.
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'adlc:spec'], 'implement')).toMatch(/send_back marker/);
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--remove-label=adlc:review'], 'pr-review')).toMatch(/adlc:review/);
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'start:now,adlc:build'], 'spec')).toMatch(/adlc:build/);
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'sdlc:build'], 'deploy')).toMatch(/sdlc:build/);
    expect(guard.stageLabelRefusal(['issue', '-R', 'o/r', 'create', '-l', 'adlc:build'], 'qa')).toMatch(/adlc:build/);
  });

  it('refuses adlc:ci to every skill, intake’s included: the merge line puts it on after the lead approved', () => {
    expect(guard.stageLabelRefusal(['pr', 'edit', '7', '--add-label', 'adlc:ci'], 'implement')).toMatch(/does not add or remove adlc:ci/);
    expect(guard.stageLabelRefusal(['pr', 'edit', '7', '--remove-label', 'adlc:ci'], 'triage')).toMatch(/does not add or remove adlc:ci/);
    expect(guard.stageLabelRefusal(['pr', 'edit', '7', '--add-label', 'adlc:ci'], '')).toBeNull();
  });

  it('refuses scope:cross-cutting to every skill, so a builder cannot waive the scope check on its own work', () => {
    expect(guard.stageLabelRefusal(['pr', 'edit', '7', '--add-label', 'scope:cross-cutting'], 'implement')).toMatch(/does not put on scope:cross-cutting/);
    expect(guard.stageLabelRefusal(['pr', 'edit', '7', '--remove-label=Scope:Cross-Cutting'], 'triage')).toMatch(/plan_change/);
    expect(guard.stageLabelRefusal(['pr', 'create', '-l', 'docs,scope:cross-cutting'], 'implement')).toMatch(/scope:cross-cutting/);
    expect(guard.stageLabelRefusal(['pr', 'edit', '7', '--add-label', 'scope:cross-cutting'], '')).toBeNull();
  });

  it('refuses a stage label written through `gh api` to every skill, intake’s included', () => {
    // Through the API a session set adlc:done, and the issues that depended
    // on it went ahead as though it had merged.
    const labels = 'repos/exampleco/api/issues/7/labels';
    expect(guard.stageLabelRefusal(['api', '-X', 'POST', labels, '-f', 'labels[]=adlc:done'], 'implement')).toMatch(/adlc:done/);
    expect(guard.stageLabelRefusal(['api', `/${labels}`, '-f', 'labels[]=adlc:build'], 'triage')).toMatch(/adlc:build/);
    expect(guard.stageLabelRefusal(['api', '--method', 'PUT', labels, '--input', 'labels.json'], 'spec', () => '{"labels":["sdlc:review"]}')).toMatch(/sdlc:review/);
    expect(guard.stageLabelRefusal(['api', '-X', 'DELETE', `${labels}/adlc%3Abuild`], 'implement')).toMatch(/adlc:build/);
    expect(guard.stageLabelRefusal(['api', '-X', 'POST', labels, '-f', 'labels[]=scope:cross-cutting'], 'implement')).toMatch(/scope:cross-cutting/);
    expect(guard.stageLabelRefusal(['api', '-X', 'POST', labels, '--input', '-'], 'implement')).toMatch(/as fields/);
    // Other labels, other endpoints and a person's own shell are not this guard's.
    expect(guard.stageLabelRefusal(['api', '-X', 'POST', labels, '-f', 'labels[]=blocked'], 'implement')).toBeNull();
    expect(guard.stageLabelRefusal(['api', 'repos/exampleco/api/issues/7'], 'implement')).toBeNull();
    expect(guard.stageLabelRefusal(['api', '-X', 'POST', labels, '-f', 'labels[]=adlc:done'], '')).toBeNull();
  });

  it('limits intake to filing into Design or Build', () => {
    expect(guard.stageLabelRefusal(['issue', 'create', '--label', 'adlc:spec,priority:p2'], 'triage')).toBeNull();
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'adlc:build', '--remove-label', 'adlc:intake'], 'triage')).toBeNull();
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'adlc:done'], 'triage')).toMatch(/Design or Build/);
    expect(guard.stageLabelRefusal(['issue', 'create', '-l', 'adlc:review'], 'triage')).toMatch(/adlc:review/);
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'adlc:intake'], 'triage')).toMatch(/adlc:intake/);
  });

  it('refuses the labels that choose a pull request’s review to the session whose pull request it is', () => {
    // `deps` and `revert` sent a pull request to the lead alone, and
    // `scope:cross-cutting` passes the scope check: a builder could choose its
    // own review.
    expect(guard.stageLabelRefusal(['pr', 'edit', '1', '--add-label', 'deps'], 'implement')).toMatch(/does not put on deps/);
    expect(guard.stageLabelRefusal(['pr', 'create', '--label', 'Revert'], 'implement')).toMatch(/does not put on revert/);
    expect(guard.stageLabelRefusal(['issue', 'edit', '1', '--add-label=blocked,scope:cross-cutting'], 'implement')).toMatch(/the lead in its signed approval/);
    expect(guard.stageLabelRefusal(['pr', 'edit', '1', '--remove-label', 'deps'], 'triage')).toMatch(/does not take off deps/);
    expect(guard.stageLabelRefusal(['pr', 'edit', '1', '--add-label', 'revert'], 'deploy')).toMatch(/does not put on revert/);
    expect(guard.stageLabelRefusal(['pr', 'edit', '1', '--add-label', 'scope:cross-cutting'], 'triage')).toMatch(/scope:cross-cutting/);
  });

  it('lets deploy open a revert with its label, triage file an issue as deps, and a person’s shell do either', () => {
    expect(guard.stageLabelRefusal(['pr', 'create', '--label', 'revert', '--title', 'Revert 1a2b3c4d'], 'deploy')).toBeNull();
    expect(guard.stageLabelRefusal(['issue', 'create', '--label', 'deps', '--title', 'Bump'], 'triage')).toBeNull();
    expect(guard.stageLabelRefusal(['pr', 'edit', '1', '--add-label', 'deps,revert,scope:cross-cutting'], '')).toBeNull();
  });

  it('refuses deps on a pull request to every skill, triage’s and deploy’s included', () => {
    for (const skill of ['implement', 'triage', 'deploy']) {
      expect(guard.stageLabelRefusal(['pr', 'create', '--label', 'deps'], skill)).toMatch(/does not put on deps/);
    }
    expect(guard.stageLabelRefusal(['pr', 'create', '--label=fix,revert'], 'pr-review')).toMatch(/does not put on revert/);
  });

  it('lets intake write one, any skill write other labels, and a person’s own shell do anything', () => {
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'adlc:build'], 'triage')).toBeNull();
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'blocked', '--remove-label', 'start:now'], 'spec')).toBeNull();
    expect(guard.stageLabelRefusal(['issue', 'edit', '7', '--add-label', 'adlc:spec'], '')).toBeNull();
    expect(guard.stageLabelRefusal(['issue', 'view', '7', '--json', 'labels'], 'implement')).toBeNull();
  });
});

describe('a review or build session reading comments from GitHub', () => {
  const guard = shim as unknown as { unfilteredReadRefusal: (args: string[], skill?: string) => string | null };

  it.each([
    ['issue', 'view', '42', '--comments'],
    ['issue', 'view', '42', '-c'],
    ['issue', 'view', '42', '--json', 'title,comments'],
    ['issue', 'view', '42', '--json=comments'],
    ['pr', 'view', '7', '--comments'],
    ['pr', '-R', 'o/r', 'view', '7', '--json', 'reviews'],
    ['pr', 'view', '7', '--json', 'body,comments'],
    ['api', 'repos/o/r/issues/42/comments'],
    ['api', '/repos/o/r/issues/42/comments?per_page=100', '--paginate'],
    ['api', 'repos/{owner}/{repo}/pulls/7/comments'],
    ['api', 'repos/o/r/pulls/7/reviews'],
    ['api', '-X', 'GET', 'repos/o/r/pulls/7/reviews', '-f', 'per_page=100'],
  ])('refuses gh %s, naming the documents to read instead', (...args) => {
    for (const skill of ['pr-review', 'implement']) {
      const refusal = guard.unfilteredReadRefusal(args, skill);
      expect(refusal).toContain('issue.md');
      expect(refusal).toContain('pull-request.md');
    }
  });

  it.each([
    ['issue', 'comment', '42', '--body-file', '.fleetadlc-scratch/plan.md'],
    ['pr', 'review', '7', '--comment', '--body-file', '.fleetadlc-scratch/review.md'],
    ['api', '-X', 'POST', 'repos/o/r/issues/42/comments', '-f', 'body=done'],
    ['api', 'repos/o/r/pulls/7/reviews', '--input', '.fleetadlc-scratch/review.json'],
    ['api', 'repos/o/r/issues/42/comments', '-f', 'body=done'],
    ['api', '--method=POST', 'repos/o/r/pulls/7/comments'],
    ['issue', 'view', '42', '--json', 'labels'],
    ['pr', 'view', '7', '--json', 'headRefOid,files'],
    ['api', 'repos/o/r/pulls/7/files'],
  ])('lets gh %s through', (...args) => {
    expect(guard.unfilteredReadRefusal(args, 'pr-review')).toBeNull();
    expect(guard.unfilteredReadRefusal(args, 'implement')).toBeNull();
  });

  it('holds only the review and build skills, and never a person’s own shell', () => {
    expect(guard.unfilteredReadRefusal(['issue', 'view', '42', '--comments'], 'triage')).toBeNull();
    expect(guard.unfilteredReadRefusal(['issue', 'view', '42', '--comments'], '')).toBeNull();
  });
});

describe('what a skill denies a session', () => {
  const guard = shim as unknown as { githubRefusal: (args: string[], policy?: string) => string | null };
  const builder = JSON.stringify({ denyGithub: ['pr review', 'workflow run', 'api'] });

  it('refuses a command the skill denies, whatever follows it', () => {
    // A builder whose tools.yaml denied `gh pr review` could post one: no
    // engine could say "gh, but not this subcommand".
    expect(guard.githubRefusal(['pr', 'review', '7', '--approve'], builder)).toMatch(/does not run `gh pr review`/);
    expect(guard.githubRefusal(['api', '-X', 'POST', 'repos/exampleco/api/pulls/7/reviews', '-f', 'event=APPROVE'], builder)).toMatch(/does not run `gh pr review`/);
    expect(guard.githubRefusal(['api', '-X', 'PUT', 'repos/exampleco/api/pulls/7/reviews/1/dismissals'], builder)).toMatch(/gh api/);
    expect(guard.githubRefusal(['workflow', 'run', 'deploy.yml'], builder)).toMatch(/gh workflow run/);
  });

  it('runs what the skill does not deny', () => {
    expect(guard.githubRefusal(['pr', 'create', '--fill'], builder)).toBeNull();
    expect(guard.githubRefusal(['pr', 'view', '7', '--json', 'reviews'], builder)).toBeNull();
    expect(guard.githubRefusal(['workflow', 'view', 'ci.yml'], builder)).toBeNull();
  });

  it('refuses a skill that denies pr review the same verdict posted through gh api', () => {
    // QA, spec and intake deny `pr review` and not `api`, so `gh api` with
    // event=APPROVE was the builder's approval the deny list did not name.
    const qa = JSON.stringify({ denyGithub: ['pr merge', 'pr review', 'workflow run'] });
    const lead = JSON.stringify({ denyGithub: ['pr merge', 'workflow run', 'push'] });
    const approve = ['api', '-X', 'POST', 'repos/o/r/pulls/7/reviews', '-f', 'event=APPROVE'];
    expect(guard.githubRefusal(approve, qa)).toMatch(/does not run `gh pr review`/);
    expect(guard.githubRefusal(['api', '-X', 'POST', 'repos/o/r/pulls/7/reviews', '-f', 'event=REQUEST_CHANGES'], qa)).toMatch(/gh pr review/);
    expect(guard.githubRefusal(['api', 'graphql', '-f', 'query=mutation { addPullRequestReview(input: {event: APPROVE}) { clientMutationId } }'], qa)).toMatch(/gh pr review/);
    expect(guard.githubRefusal(['api', '-X', 'POST', 'repos/o/r/pulls/7/reviews', '-f', 'event=COMMENT'], qa)).toBeNull();
    expect(guard.githubRefusal(['api', 'repos/o/r/pulls/7'], qa)).toBeNull();
    // The lead's skill does not deny `pr review`. Its approval still posts.
    expect(guard.githubRefusal(approve, lead)).toBeNull();
  });

  describe('under the deploy skill’s rules', () => {
    // The SRE's skill never starts deploy-testing or promote-production, and
    // its list named them; the file name, a path, a flag before the name, the
    // workflow's id, a re-run of an old promote and `gh api` all started one.
    const deploy = JSON.stringify({
      denyGithub: (parseYamlFile(join(import.meta.dirname, '..', '..', '..', 'crew', 'skills', 'deploy', 'tools.yaml')) as { deny: { github: string[] } }).deny.github,
    });

    it('refuses promote-production and deploy-testing however the workflow is named', () => {
      for (const args of [
        ['workflow', 'run', 'promote-production', '-f', 'candidate=abc1234'],
        ['workflow', 'run', 'promote-production.yml'],
        ['workflow', 'run', '.github/workflows/promote-production.yml'],
        ['workflow', 'run', '-f', 'candidate=abc1234', 'promote-production'],
        ['workflow', 'run', '--ref', 'main', 'deploy-testing.yaml'],
        ['workflow', '-R', 'exampleco/api', 'run', 'Deploy-Testing'],
      ]) {
        expect(guard.githubRefusal(args, deploy), args.join(' ')).toMatch(/does not run `gh workflow run (promote-production|deploy-testing)`/);
      }
    });

    it('refuses a workflow given by number, or not named, since its name cannot be read', () => {
      expect(guard.githubRefusal(['workflow', 'run', '81234567'], deploy)).toMatch(/given by number, or not named.*gh workflow run rollback-production/);
      expect(guard.githubRefusal(['workflow', 'run'], deploy)).toMatch(/given by number/);
    });

    it('refuses re-running a run, and gh api', () => {
      expect(guard.githubRefusal(['run', 'rerun', '99'], deploy)).toMatch(/gh run rerun/);
      expect(guard.githubRefusal(['api', 'repos/exampleco/api/pulls/7'], deploy)).toMatch(/gh api/);
      expect(guard.githubRefusal(['api', '-X', 'POST', 'repos/exampleco/api/actions/workflows/promote-production.yml/dispatches'], deploy)).toMatch(/workflow run promote-production/);
      // The rollback is allowed as `workflow run` and still refused as `api`.
      expect(guard.githubRefusal(['api', 'repos/exampleco/api/actions/workflows/rollback-production.yml/dispatches', '-f', 'ref=main'], deploy)).toMatch(/gh api/);
    });

    it('still rolls production back, and reads runs', () => {
      expect(guard.githubRefusal(['workflow', 'run', 'rollback-production'], deploy)).toBeNull();
      expect(guard.githubRefusal(['workflow', 'run', 'rollback-production', '-f', 'to=v41'], deploy)).toBeNull();
      expect(guard.githubRefusal(['run', 'view', '99', '--log-failed'], deploy)).toBeNull();
      expect(guard.githubRefusal(['run', 'list', '--workflow', 'deploy-testing', '--limit', '5'], deploy)).toBeNull();
    });
  });

  it('holds a person’s own shell, which has no skill, to nothing', () => {
    expect(guard.githubRefusal(['pr', 'review', '7', '--approve'], undefined)).toBeNull();
    expect(guard.githubRefusal(['pr', 'review', '7', '--approve'], '')).toBeNull();
  });

  it('posts nothing when the rules cannot be read', () => {
    expect(guard.githubRefusal(['issue', 'comment', '7'], '{not json')).toMatch(/could not read/);
  });

  it('reads the command past a flag given before the subcommand', () => {
    // cobra takes `-R` before `review`, and the list was read only up to the
    // first flag: `gh pr -R o/r review 1 --approve` went through as `gh pr`.
    expect(guard.githubRefusal(['pr', '-R', 'exampleco/api', 'review', '1', '--approve'], builder)).toMatch(/gh pr review/);
    expect(guard.githubRefusal(['pr', '--repo', 'exampleco/api', 'review', '1'], builder)).toMatch(/gh pr review/);
    expect(guard.githubRefusal(['pr', '-R', 'exampleco/review', 'view', '1'], builder)).toBeNull();
  });

  it('defines no alias, and expands one already there before reading the list', () => {
    const withAliases = guard as unknown as {
      githubRefusal: (args: string[], policy: string, ask: (args: string[]) => string | null) => string | null;
    };
    const ask = (args: string[]) => (args.join(' ') === 'alias list' ? "rv: pr review\nsh: '!gh pr review 1 --approve'\nco: pr checkout\n" : null);

    expect(withAliases.githubRefusal(['alias', 'set', 'rv', 'pr review'], builder, ask)).toMatch(/does not define gh aliases/);
    expect(withAliases.githubRefusal(['alias', 'import', '-'], builder, ask)).toMatch(/does not define gh aliases/);
    expect(withAliases.githubRefusal(['rv', '1', '--approve'], builder, ask)).toMatch(/gh pr review/);
    expect(withAliases.githubRefusal(['sh'], builder, ask)).toMatch(/runs a shell command/);
    expect(withAliases.githubRefusal(['co', '7'], builder, ask)).toBeNull();
    expect(withAliases.githubRefusal(['alias', 'list'], builder, ask)).toBeNull();
  });

  const skills = join(import.meta.dirname, '..', '..', '..', 'crew', 'skills');
  const deniedBy = (skill: string) =>
    (parseYamlFile(join(skills, skill, 'tools.yaml')) as { deny?: { github?: string[] } }).deny?.github ?? [];
  const withTools = readdirSync(skills).filter((skill) => existsSync(join(skills, skill, 'tools.yaml')));

  it('is given only commands OpenADLC’s gh or git can refuse, by every skill', () => {
    // `pr review dismiss` and `deployment approve` were listed once. Neither is
    // a gh command, so nothing could ever refuse them. `push` is OpenADLC's git's.
    const commands = ['pr create', 'pr merge', 'pr review', 'workflow run', 'workflow run deploy-testing', 'workflow run promote-production', 'run rerun', 'api', 'issue edit', 'push'];
    for (const skill of withTools) {
      for (const entry of deniedBy(skill)) {
        expect(
          commands.some((command) => entry === command || entry.startsWith(`${command} `)),
          `${skill}: ${entry}`,
        ).toBe(true);
      }
    }
  });

  it('refuses a skill that denies workflow run the same call made through gh api', () => {
    // QA, spec and triage deny `workflow run` and not `api`. The dispatch
    // endpoint is that command: a promote posted there ran with nothing holding it.
    for (const skill of ['qa', 'spec', 'triage', 'pr-review']) {
      const policy = JSON.stringify({ denyGithub: deniedBy(skill) });
      expect(guard.githubRefusal(['api', '-X', 'POST', 'repos/exampleco/app/actions/workflows/promote-production.yml/dispatches', '-f', 'ref=main'], policy), skill).toMatch(/workflow run/);
      expect(guard.githubRefusal(['api', 'repos/exampleco/app/actions/workflows/promote-production/dispatches', '-f', 'ref=main'], policy), skill).toMatch(/workflow run/);
      expect(guard.githubRefusal(['api', 'repositories/123/actions/workflows/promote-production.yml/dispatches'], policy), skill).toMatch(/workflow run/);
      expect(guard.githubRefusal(['api', 'repos/exampleco/app/actions/workflows/promote-production.yml/dispatches#'], policy), skill).toMatch(/workflow run/);
      expect(guard.githubRefusal(['api', 'repos/exampleco/app/actions/runs/9'], policy), skill).toBeNull();
    }
    const deploy = JSON.stringify({ denyGithub: deniedBy('deploy') });
    expect(guard.githubRefusal(['api', '-X', 'POST', 'repos/exampleco/app/actions/workflows/promote-production.yml/dispatches'], deploy)).toMatch(/workflow run promote-production|gh api/);
    expect(guard.githubRefusal(['api', 'repos/exampleco/app/actions/workflows/81234567/dispatches', '-f', 'ref=main'], deploy)).toMatch(/given by number|gh api/);
    expect(guard.githubRefusal(['api', 'repos/exampleco/app/actions/workflows/%E0/dispatches'], deploy)).toMatch(/not a valid encoding/);
    expect(guard.githubRefusal(['api', '-X', 'POST', 'repos/exampleco/app/actions/runs/99/rerun'], deploy)).toMatch(/gh run rerun/);
    expect(guard.githubRefusal(['api', 'repositories/123/actions/runs/99/rerun-failed-jobs'], deploy)).toMatch(/gh run rerun/);
  });

  it('refuses the deploy skill a promote by either name, and lets it run the rollback', () => {
    // OpenADLC dispatches the promote, after the soak or a person's release:
    // on a plan with no environment reviewer, one a session started ran unheld.
    const policy = JSON.stringify({ denyGithub: deniedBy('deploy') });
    expect(guard.githubRefusal(['workflow', 'run', 'promote-production', '--ref', 'main'], policy)).toContain('workflow run promote-production');
    expect(guard.githubRefusal(['workflow', 'run', 'promote-production.yml'], policy)).toContain('promote-production');
    expect(guard.githubRefusal(['workflow', 'run', 'rollback-production', '--ref', 'main'], policy)).toBeNull();
  });

  it('never denies a skill a gh command its own SKILL.md tells it to run', () => {
    // deploy denied `pr merge` while its skill opens a revert with auto-merge
    // enabled: once the list was enforced, the rollback waited for a person.
    for (const skill of withTools) {
      const policy = JSON.stringify({ denyGithub: deniedBy(skill) });
      const doc = readFileSync(join(skills, skill, 'SKILL.md'), 'utf8')
        // What a skill must never do is named there on purpose.
        .replace(/^## Never\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');
      const commands = [...doc.matchAll(/(?:^|`)\s*gh ((?:[a-z-]+ ?){1,2})/gm)].map((match) => match[1]!.trim().split(' '));
      // A skill that tells its session to turn auto-merge on runs `gh pr merge --auto`; one that says not to does not.
      if (/gh pr merge [^\n]*--auto/.test(doc)) commands.push(['pr', 'merge', '--auto']);
      for (const words of commands) expect(guard.githubRefusal(words, policy), `${skill}: gh ${words.join(' ')}`).toBeNull();
    }
  });
});
