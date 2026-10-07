import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptedIssueBody,
  accountsThatNeverAuthor,
  addExpectedPaths,
  closedIssues,
  closingKeywords,
  CROSS_CUTTING_LABEL,
  scopeCheck,
  type ScopeIssue,
  declaredPathsOverlap,
  sameLogin,
  declaredPathsFrom,
  filesOutsideScope,
  findForbiddenAuthors,
  NEVER_AUTHORS,
  REQUIRED_CHECK,
  REVIEW_GATE_CHECK,
  unreadablePathLines,
} from './checks.js';

const forbidden = [
  { login: 'fleetadlc-sydney', why: 'a reviewer must never author what it reviews' },
  { login: 'fleetadlc-flow', why: 'the automation account never authors commits' },
];

describe('who may author a commit', () => {
  it('passes a commit written by the builder it belongs to', () => {
    expect(
      findForbiddenAuthors(
        [{ sha: 'abc1234', authorEmail: 'fleetadlc-atlas@users.noreply.github.com', authorName: 'Atlas' }],
        forbidden,
      ),
    ).toEqual([]);
  });

  it('catches a reviewer that authored code, and says why it matters', () => {
    const findings = findForbiddenAuthors(
      [{ sha: 'abc1234', authorEmail: '1234+fleetadlc-sydney@users.noreply.github.com', authorName: 'Sydney' }],
      forbidden,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain('reviewer');
  });

  it('catches the automation account by login as well as by address', () => {
    expect(
      findForbiddenAuthors(
        [{ sha: 'def5678', authorEmail: 'someone@example.com', authorName: 'Flow', authorLogin: 'fleetadlc-flow' }],
        forbidden,
      ),
    ).toHaveLength(1);
  });

  it('does not catch an account whose name merely starts the same way', () => {
    // `fleetadlc-sydney-2` is a different account from `fleetadlc-sydney`.
    expect(
      findForbiddenAuthors(
        [{ sha: 'abc1234', authorEmail: 'fleetadlc-sydney-2@users.noreply.github.com', authorName: 'Sydney 2' }],
        forbidden,
      ),
    ).toEqual([]);
  });

  it('names the account it traced the commit to, whatever the commit calls itself', () => {
    // The gate's description names the account, and an address is not one.
    expect(
      findForbiddenAuthors(
        [{ sha: 'abc1234', authorEmail: '1234+FleetADLC-Sydney@users.noreply.github.com', authorName: 'Sydney' }],
        forbidden,
      ),
    ).toEqual([
      {
        sha: 'abc1234',
        author: '1234+FleetADLC-Sydney@users.noreply.github.com',
        login: 'fleetadlc-sydney',
        reason: 'a reviewer must never author what it reviews',
      },
    ]);
  });

  it('catches a commit that only its name ties to the account', () => {
    // A bot's session commits under its own name, which is its handle. With an
    // address GitHub cannot tie to anyone, the name is all that is left.
    const findings = findForbiddenAuthors(
      [{ sha: 'abc1234', authorEmail: 'bot@container.local', authorName: 'FleetADLC-Flow', authorLogin: null }],
      forbidden,
    );
    expect(findings.map((finding) => finding.login)).toEqual(['fleetadlc-flow']);
  });

  it('lets the account GitHub matched decide first, with one finding per commit', () => {
    // Named like the reviewer, matched by GitHub to the automation account: it
    // is the automation account's commit, and it is one commit.
    const findings = findForbiddenAuthors(
      [{ sha: 'abc1234', authorEmail: 'someone@example.com', authorName: 'fleetadlc-sydney', authorLogin: 'FleetADLC-Flow' }],
      forbidden,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.login).toBe('fleetadlc-flow');
  });
});

describe('which accounts may never author', () => {
  it('is every reviewer, intake and the automation account the crew has a login for', () => {
    const crew = [
      { role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe' },
      { role: 'review_lead', githubLogin: 'fleetadlc-sydney-janedoe' },
      { role: 'review_second', githubLogin: 'fleetadlc-grok-janedoe' },
      { role: 'review_security', githubLogin: 'fleetadlc-cipher-janedoe' },
      { role: 'intake', githubLogin: 'fleetadlc-mira-janedoe' },
      { role: 'automation', githubLogin: 'janedoe-fleetadlc-flow' },
      { role: 'deploy', githubLogin: 'fleetadlc-harbor-janedoe' },
      { role: 'qa', githubLogin: 'fleetadlc-vega-janedoe' },
    ] as const;

    expect(accountsThatNeverAuthor(crew)).toEqual([
      { login: 'fleetadlc-sydney-janedoe', why: 'a reviewer must never author what it reviews' },
      { login: 'fleetadlc-grok-janedoe', why: 'a reviewer must never author what it reviews' },
      { login: 'fleetadlc-cipher-janedoe', why: 'a reviewer must never author what it reviews' },
      { login: 'fleetadlc-mira-janedoe', why: 'intake shapes issues; it does not write code' },
      { login: 'janedoe-fleetadlc-flow', why: 'the automation account sets labels and statuses; it never authors commits' },
    ]);
    expect(Object.keys(NEVER_AUTHORS).sort()).toEqual([
      'automation',
      'intake',
      'review_lead',
      'review_second',
      'review_security',
    ]);
  });

  it('leaves out a seat no account has been recorded for', () => {
    // No login, no account: nothing could have been authored as it.
    expect(
      accountsThatNeverAuthor([
        { role: 'review_lead', githubLogin: null },
        { role: 'automation', githubLogin: '  ' },
      ]),
    ).toEqual([]);
  });

  it('bars the reviewer account but not the crew account the builder shares with intake and automation', () => {
    const crew = [
      { role: 'intake', githubLogin: 'fleetadlc-crew' },
      { role: 'implement', githubLogin: 'FleetADLC-Crew' },
      { role: 'automation', githubLogin: 'fleetadlc-crew' },
      { role: 'review_lead', githubLogin: 'fleetadlc-review' },
      { role: 'review_second', githubLogin: 'fleetadlc-review' },
    ] as const;
    expect(accountsThatNeverAuthor(crew).map((account) => account.login)).toEqual(['fleetadlc-review', 'fleetadlc-review']);
  });
});

describe('what a pull request says it closes', () => {
  it('reads every keyword GitHub honours, with or without a colon', () => {
    // The scope check knew only closes, fixes and resolves, and read [6] here.
    expect(closingKeywords('Fixed #3. Closed #4. fix #5. Closes #6. resolved #7. close #8')).toEqual([3, 4, 5, 6, 7, 8]);
    expect(closingKeywords('Closes: #12')).toEqual([12]);
  });

  it('is the one parser the scope check and the bridge both read', () => {
    expect(closedIssues).toBe(closingKeywords);
    expect(closedIssues('Closes #33. Fixes #57.\n\nResolves #33 as well.')).toEqual([33, 57]);
    expect(closedIssues('A change with no linked issue')).toEqual([]);
  });

  it('reads every form GitHub does, once each', () => {
    expect(closingKeywords('Close #1, closed #2, fix #3, Fixed: #4, resolve #5, Resolved #6. Closes #1.')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reads none in code, a quote or a comment', () => {
    const body = [
      'Changes the template.',
      '',
      '```md',
      'Closes #1',
      '```',
      '',
      'It used to say `Fixes #2`.',
      '> Resolves #3',
      '<!-- closes #4 -->',
      '~~~',
      'fixes #5',
    ].join('\n');
    expect(closingKeywords(body)).toEqual([]);
  });

  it('reads none after a negation', () => {
    expect(closingKeywords('This no longer fixes #5, does not close #6, doesn’t resolve #7 and never closes #8.')).toEqual([]);
  });

  it('reads a long body of spaces in a moment', () => {
    // `\s*:?\s+` put two runs of spaces side by side, and this took seconds.
    const started = performance.now();
    expect(closingKeywords(`closes${' '.repeat(40_000)}x`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(closingKeywords('Closes :  #9, fixes  #10')).toEqual([9, 10]);
  });

  it('reads none of another repository’s issues or a link', () => {
    expect(closingKeywords('Closes exampleco/other#5, fixes https://github.com/exampleco/other/issues/6')).toEqual([]);
  });
});

describe('the scope check on a pull request', () => {
  const ISSUE = { body: '## Expected paths\n\n- src/ui/button.tsx\n' };

  function check(overrides: Partial<Parameters<typeof scopeCheck>[0]> = {}) {
    return scopeCheck({
      body: 'Fixed #12',
      prNumber: 40,
      prAuthor: 'exampleco-crew',
      labels: [],
      files: ['src/ui/button.tsx'],
      readIssue: async (): Promise<ScopeIssue> => ISSUE,
      crossCuttingBy: async () => null,
      ...overrides,
    });
  }

  it('reads the issue a "Fixed #12" closes, and passes a diff inside it', async () => {
    const verdict = await check();
    expect(verdict.exit).toBe(0);
    expect(verdict.message).toContain('within what #12 declared');
  });

  it('fails, naming the issue and the status, when an issue cannot be read', async () => {
    // A 404, a rate limit or a 5xx read as "declares nothing", and passed.
    const verdict = await check({
      readIssue: async () => {
        throw new Error('GitHub answered 401 for /issues/12');
      },
    });
    expect(verdict).toEqual({ exit: 1, message: expect.stringMatching(/could not read #12.*401/) });
  });

  it('takes nothing a pull request declares, its own body included', async () => {
    // A body that closed its own number declared its own scope.
    const readIssue = vi.fn(async (number: number): Promise<ScopeIssue> =>
      number === 41 ? { body: '## Expected paths\n\n- config/bots.yaml\n', pull_request: {} } : ISSUE,
    );
    const verdict = await check({ body: 'Closes #40. Closes #41. Closes #12.', files: ['config/bots.yaml'], readIssue });
    expect(readIssue).not.toHaveBeenCalledWith(40);
    expect(verdict.exit).toBe(1);
    expect(verdict.message).toContain('#40 is this pull request');
    expect(verdict.message).toContain('#41 is a pull request');
  });

  it(`honours ${'scope:cross-cutting'} only when someone other than the author put it on`, async () => {
    const outside = { files: ['src/billing/charge.ts'], labels: [CROSS_CUTTING_LABEL] };
    expect((await check({ ...outside, crossCuttingBy: async () => 'janedoe' })).exit).toBe(0);
    expect((await check({ ...outside, crossCuttingBy: async () => 'Exampleco-Crew' })).exit).toBe(1);
    expect((await check({ ...outside, crossCuttingBy: async () => null })).exit).toBe(1);
    expect((await check({ files: ['src/billing/charge.ts'] })).exit).toBe(1);
  });

  it('still skips a pull request that closes no issue', async () => {
    expect((await check({ body: 'A change with no linked issue', files: ['anything.ts'] })).exit).toBe(0);
  });
});

describe('whether a diff stayed in scope', () => {
  const declared = ['apps/bridge/src/**', 'packages/db/migrations'];

  it('accepts what the issue declared', () => {
    expect(
      filesOutsideScope(
        ['apps/bridge/src/api.ts', 'apps/bridge/src/api.test.ts', 'packages/db/migrations/0004_x.sql'],
        declared,
      ).inScope,
    ).toBe(true);
  });

  it('always accepts a task writing its own evidence', () => {
    // A check that refused these would teach bots not to write tests.
    expect(filesOutsideScope(['tests/pipeline.mjs', 'AGENTS.md'], declared).inScope).toBe(true);
  });

  it('accepts a unit test that sits beside a module the change declared', () => {
    // Unit tests in this repo live next to the source, not under `tests/`.
    // Declaring the module has to cover the test beside it, or the check
    // teaches a bot not to write one — or to widen the lease so it can.
    expect(
      filesOutsideScope(
        [
          'packages/shared/src/checks.ts',
          'packages/shared/src/checks.test.ts',
          'apps/console/src/app/page.tsx',
          'apps/console/src/app/page.test.tsx',
          'apps/cli/bin/fleetadlc.mjs',
          'apps/cli/bin/fleetadlc.test.mjs',
        ],
        ['packages/shared/src/checks.ts', 'apps/console/src/app/page.tsx', './apps/cli/bin/fleetadlc.mjs'],
      ),
    ).toEqual({ outside: [], inScope: true });
  });

  it('does not let a lookalike, or a test beside something undeclared, through', () => {
    // The exemption is the sibling of a declared path, not every file that
    // looks like a test. `tests/` is unconditional; this is not.
    const changed = [
      'packages/shared/src/checks.test.ts.txt',
      'packages/shared/src/checks.testing.ts',
      'packages/shared/src/checks.test.js',
      'packages/shared/src/checks.spec.ts',
      'packages/shared/src/checks.test.ts/hidden.ts',
      'packages/shared/src/checks.ts.test.ts',
      'packages/shared/src/other.test.ts',
      'apps/bridge/src/checks.test.ts',
    ];
    expect(filesOutsideScope(changed, ['packages/shared/src/checks.ts'])).toEqual({
      outside: changed,
      inScope: false,
    });
  });

  it('keeps a star on a name a prefix, and a directory a directory', () => {
    // `scheduler*` names the files that start that way, test included.
    expect(
      filesOutsideScope(
        ['apps/bridge/src/scheduler.ts', 'apps/bridge/src/scheduler.test.ts', 'packages/db/migrations/0012_jobs.sql'],
        ['apps/bridge/src/scheduler*', 'packages/db/migrations/0012_*'],
      ).inScope,
    ).toBe(true);
    // A directory without a star covers what is inside it, not its lookalikes.
    expect(filesOutsideScope(['apps/bridge-v2/src/api.ts'], ['apps/bridge']).outside).toEqual([
      'apps/bridge-v2/src/api.ts',
    ]);
  });

  it('names what nothing declared', () => {
    const verdict = filesOutsideScope(['apps/console/src/app/page.tsx', 'apps/bridge/src/api.ts'], declared);
    expect(verdict.inScope).toBe(false);
    expect(verdict.outside).toEqual(['apps/console/src/app/page.tsx']);
  });

  it('reads the declared paths out of the task form the dispatcher uses', () => {
    const body = [
      '### Outcome',
      'Something',
      '',
      '### Expected paths',
      '',
      '- apps/bridge/src',
      '- packages/db/migrations',
      '',
      '### Verification',
      'A test',
    ].join('\n');
    expect(declaredPathsFrom(body)).toEqual(['apps/bridge/src', 'packages/db/migrations']);
  });

  it('reads the paths under a heading of any level, up to the next heading', () => {
    const drafted = '## Outcome\nTrim it.\n\n## Expected paths\n- greet.mjs\n- greet.test.mjs\n\n## What it touches\n- greet\n';
    expect(declaredPathsFrom(drafted)).toEqual(['greet.mjs', 'greet.test.mjs']);
  });

  it('keeps the path and leaves what was said about it', () => {
    const drafted = '## Expected Paths\n- `greet.mjs` — modify the greet function\n- greet.test.mjs - add a test\n- docs/ (the guide)\n';
    expect(declaredPathsFrom(drafted)).toEqual(['greet.mjs', 'greet.test.mjs', 'docs/']);
  });

  it('reads a body with CRLF line endings as it reads the same body with LF', () => {
    // GitHub's web editor can save a body with CRLF, and the heading's `\n`
    // did not match `\r\n`: the issue declared nothing, and readiness sent it
    // to triage for an expected path it had.
    for (const level of ['##', '###']) {
      const lf = `${level} Outcome\nX\n\n${level} Expected paths\n\n- apps/bridge/src/gates.ts\n- docs/\n\n${level} Verification\nA test\n`;
      expect(declaredPathsFrom(lf)).toEqual(['apps/bridge/src/gates.ts', 'docs/']);
      expect(declaredPathsFrom(lf.replace(/\n/g, '\r\n'))).toEqual(['apps/bridge/src/gates.ts', 'docs/']);
      expect(declaredPathsFrom(lf.replace(/\n/g, '\r'))).toEqual(['apps/bridge/src/gates.ts', 'docs/']);
    }
    // The issue form's headings with LF, and the field's value pasted with CRLF.
    const form = '### Outcome\n\nX\n\n### Expected paths\n\n- apps/bridge/src/gates.ts\r\n- docs/\r\n\n### Verification\n\nA test';
    expect(declaredPathsFrom(form)).toEqual(['apps/bridge/src/gates.ts', 'docs/']);
  });
});

/**
 * The name a ruleset requires and the name the workflow publishes have to be the
 * same string, and they were not.
 *
 * An earlier plan named the context `gate / ci`, but GitHub publishes a check
 * run under the **job** name, so a ruleset written from it waited for a check
 * that never appeared, and the merge line, which required the same string,
 * would never have found a pull request green.
 *
 * Two files agreeing by convention is how that happened. These are the tests
 * that fail when they stop agreeing.
 */
const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);

/** The `name:` of a job, by its key in the workflow. */
function jobName(key: string): string | null {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `  ${key}:`);
  if (start < 0) return null;
  for (const line of lines.slice(start + 1, start + 6)) {
    const match = /^\s{4}name:\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, '');
    // A new job started before a name was found.
    if (/^\s{2}\S/.test(line)) break;
  }
  return null;
}

describe('the required check is named once', () => {
  it('is what the aggregate job publishes when the checks ran', () => {
    // If this fails, either rename the job or change the constant — but not one
    // without the other, which is the whole point. The name is an expression:
    // `ci` when the checks ran, something else on a draft and when a crew pull
    // request's CI waits for the lead, so neither is a `ci` check to read as
    // passing once the pull request is ready.
    const name = jobName('ci') ?? '';
    const ran = /&& '([^']+)' \|\| '([^']+)'\) \|\| '([^']+)' \}\}$/.exec(name);
    expect(ran?.[2]).toBe(REQUIRED_CHECK);
    expect(ran?.[1]).not.toBe(REQUIRED_CHECK);
    expect(ran?.[3]).not.toBe(REQUIRED_CHECK);
  });

  it('is a job in the workflow at all', () => {
    expect(workflow).toContain(`\n  ${REQUIRED_CHECK}:\n`);
  });

  it('is not the old plan\u2019s `gate / ci`, which GitHub never publishes', () => {
    // Recorded as a test so that wording cannot quietly come back: the
    // context is the job name, and a name with a slash in it is not one.
    expect(REQUIRED_CHECK).not.toContain('/');
  });

  it('names the gate the bridge sets itself, separately', () => {
    // `review-gate` is a commit status the bridge publishes, not an Actions job,
    // so it is not subject to the rule above.
    expect(REVIEW_GATE_CHECK).toBe('review-gate');
    expect(jobName(REVIEW_GATE_CHECK)).toBeNull();
  });
});

describe('whether two logins name the same account', () => {
  it('ignores case, because GitHub does', () => {
    // Say `config/bots.yaml` names `fleetadlc-flow` and the account was
    // registered as `FleetADLC-Flow`, which is what GitHub's API answers with:
    // the same account.
    expect(sameLogin('fleetadlc-flow', 'FleetADLC-Flow')).toBe(true);
    expect(sameLogin('FLEETADLC-ATLAS', 'fleetadlc-atlas')).toBe(true);
  });

  it('still tells two different accounts apart', () => {
    // The check exists to recognise a bot, so loosening it must not make every
    // account look like every other one.
    expect(sameLogin('fleetadlc-atlas', 'fleetadlc-atlas-2')).toBe(false);
    expect(sameLogin('fleetadlc-sydney', 'janedoe')).toBe(false);
  });

  it('is false when either side is missing', () => {
    // An unconnected bot has no login. Two absences are not a match: treating
    // them as one would make every unconfigured bot the author of everything.
    expect(sameLogin(null, null)).toBe(false);
    expect(sameLogin('', '')).toBe(false);
    expect(sameLogin('fleetadlc-atlas', undefined)).toBe(false);
    expect(sameLogin(undefined, 'fleetadlc-atlas')).toBe(false);
  });
});

describe('the documentation a change carries', () => {
  it('is in scope whatever the issue declared, not only lessons and runbooks', () => {
    expect(
      filesOutsideScope(['docs/development.md', 'docs/architecture.md', 'docs/lessons/x.md', 'docs/data-inventory.yaml'], ['apps/bridge/src/gates.ts'])
        .inScope,
    ).toBe(true);
  });

  it('does not make a file that only starts like the docs directory in scope', () => {
    expect(filesOutsideScope(['docsy/notes.md', 'config/docs/x.md'], ['apps/bridge/src/gates.ts']).outside).toEqual([
      'docsy/notes.md',
      'config/docs/x.md',
    ]);
  });
});

describe('adding paths to an issue’s Expected paths', () => {
  const body = [
    '## Outcome',
    'Do the thing.',
    '',
    '## Expected paths',
    '',
    '- apps/bridge/src/gates.ts',
    '- packages/db/src/store/leases.ts',
    '',
    '## What it touches',
    'The gates.',
    '',
  ].join('\n');

  it('writes each one on a line after the last, and nothing else changes', () => {
    const after = addExpectedPaths(body, ['apps/hostd/src/skill-runner.ts', 'crew/skills/x/SKILL.md']);

    expect(after).toBe(
      body.replace(
        '- packages/db/src/store/leases.ts\n',
        '- packages/db/src/store/leases.ts\n- apps/hostd/src/skill-runner.ts\n- crew/skills/x/SKILL.md\n',
      ),
    );
    expect(declaredPathsFrom(after)).toEqual([
      'apps/bridge/src/gates.ts',
      'packages/db/src/store/leases.ts',
      'apps/hostd/src/skill-runner.ts',
      'crew/skills/x/SKILL.md',
    ]);
  });

  it('is what CI’s scope check then accepts', () => {
    const file = 'apps/hostd/src/skill-runner.ts';
    expect(filesOutsideScope([file], declaredPathsFrom(body)).outside).toEqual([file]);
    expect(filesOutsideScope([file], declaredPathsFrom(addExpectedPaths(body, [file]))).outside).toEqual([]);
  });

  it('writes nothing again for a path already declared, or inside a directory that is', () => {
    expect(addExpectedPaths(body, ['apps/bridge/src/gates.ts'])).toBe(body);
    const withDirectory = body.replace('- apps/bridge/src/gates.ts', '- apps/bridge/src/');
    expect(addExpectedPaths(withDirectory, ['apps/bridge/src/gates.ts', 'apps/bridge/src/x/y.ts'])).toBe(withDirectory);
  });

  it('is the same after asking twice', () => {
    const once = addExpectedPaths(body, ['a/b.ts', 'a/b.ts']);
    expect(once.match(/- a\/b\.ts/g)).toHaveLength(1);
    expect(addExpectedPaths(once, ['a/b.ts'])).toBe(once);
  });

  it('adds the section when the body has none, and at the end of one that is last', () => {
    expect(declaredPathsFrom(addExpectedPaths('## Outcome\nX\n', ['a.ts']))).toEqual(['a.ts']);
    expect(addExpectedPaths('## Outcome\nX', ['a.ts'])).toBe('## Outcome\nX\n\n## Expected paths\n\n- a.ts\n');
    const last = '## Outcome\nX\n\n### Expected paths\n\n- one.ts';
    expect(addExpectedPaths(last, ['two.ts'])).toBe('## Outcome\nX\n\n### Expected paths\n\n- one.ts\n- two.ts');
  });

  it('adds inside the section of a body with CRLF line endings, rather than a second section', () => {
    // Not found, the section was appended again, and from then on only the
    // paths in the second one were read.
    const crlf = body.replace(/\n/g, '\r\n');
    const after = addExpectedPaths(crlf, ['z.ts']);

    expect(after.match(/Expected paths/g)).toHaveLength(1);
    expect(after).toBe(addExpectedPaths(body, ['z.ts']));
    expect(declaredPathsFrom(after)).toEqual(['apps/bridge/src/gates.ts', 'packages/db/src/store/leases.ts', 'z.ts']);
  });

  it('leaves the sections after it where they were', () => {
    const after = addExpectedPaths(body, ['z.ts']);
    expect(after.endsWith('## What it touches\nThe gates.\n')).toBe(true);
    expect(after.indexOf('- z.ts')).toBeLessThan(after.indexOf('## What it touches'));
  });
});

describe('every path on a line of Expected paths', () => {
  const section = (...lines: string[]) => `## Outcome\nX\n\n## Expected paths\n\n${lines.join('\n')}\n\n## Verification\nA test\n`;
  const both = ['apps/bridge/src/gates.ts', 'apps/bridge/src/gates.test.ts'];

  it('is read, backticked, listed with commas, or joined with "and"', () => {
    // Only the first was read, so the builder's lease left out its own test
    // file, and a second issue on that file could be leased alongside.
    expect(declaredPathsFrom(section('- `apps/bridge/src/gates.ts`, `apps/bridge/src/gates.test.ts`'))).toEqual(both);
    expect(declaredPathsFrom(section('- apps/bridge/src/gates.ts, apps/bridge/src/gates.test.ts'))).toEqual(both);
    expect(declaredPathsFrom(section('- apps/bridge/src/gates.ts and apps/bridge/src/gates.test.ts'))).toEqual(both);
    expect(declaredPathsFrom(section('- a.ts, b.ts, and c.ts — the three of them'))).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(unreadablePathLines(section('- `apps/bridge/src/gates.ts`, `apps/bridge/src/gates.test.ts`', '- a.ts, b.ts'))).toEqual([]);
  });

  it('expands a brace group into the files it names, which the overlap check then sees', () => {
    const paths = declaredPathsFrom(section('- apps/bridge/src/{gates,send-back}.ts', '- `docs/{a,b}/{c,d}.md` — the pages'));
    expect(paths).toEqual(['apps/bridge/src/gates.ts', 'apps/bridge/src/send-back.ts', 'docs/a/c.md', 'docs/a/d.md', 'docs/b/c.md', 'docs/b/d.md']);
    expect(declaredPathsOverlap(paths, ['apps/bridge/src/gates.ts'])).toBe(true);
  });

  it('still leaves what was said about a path, and a form’s empty answer', () => {
    expect(declaredPathsFrom(section('- `greet.mjs` — modify the greet function', '_No response_'))).toEqual(['greet.mjs']);
    expect(unreadablePathLines(section('- `greet.mjs` — modify the greet function', '_No response_'))).toEqual([]);
    // A path with a space in it is written in backticks, and kept whole.
    expect(declaredPathsFrom(section('- `docs/how it works.md`'))).toEqual(['docs/how it works.md']);
  });

  it('is not a sentence: a line left with a space or a brace is not declared, and is listed', () => {
    const body = section(
      '- packages/db/migrations/0037_x.sql and its test',
      '- the gates module',
      '- apps/{bridge,{hostd,cli}}/src',
      '- docs/',
    );
    expect(declaredPathsFrom(body)).toEqual(['packages/db/migrations/0037_x.sql', 'docs/']);
    expect(unreadablePathLines(body)).toEqual([
      'packages/db/migrations/0037_x.sql and its test',
      'the gates module',
      'apps/{bridge,{hostd,cli}}/src',
    ]);
  });

  it('is what a plan change sees, so it adds none of them twice', () => {
    const body = section('- `apps/bridge/src/gates.ts`, `apps/bridge/src/gates.test.ts`');
    expect(addExpectedPaths(body, ['apps/bridge/src/gates.test.ts'])).toBe(body);
  });
});

describe('a granted path that starts with a list marker’s character', () => {
  it('reads back as the path a person approved', () => {
    const after = addExpectedPaths('## Expected paths\n\n- apps/bridge/src/gates.ts\n', ['-apps/bridge/', '**/fixtures/**']);
    expect(declaredPathsFrom(after)).toEqual(['apps/bridge/src/gates.ts', '-apps/bridge/', '**/fixtures/**']);
    expect(declaredPathsFrom('## Expected paths\n\n**/migrations/**\n* docs/\n1. tests/\n')).toEqual(['**/migrations/**', 'docs/', 'tests/']);
  });
});

describe('whether two lists of paths can touch the same file', () => {
  it('says a directory holds what is below it, and a different one does not', () => {
    expect(declaredPathsOverlap(['apps/bridge/'], ['apps/bridge/src/gates.ts'])).toBe(true);
    expect(declaredPathsOverlap(['apps/bridge/src/gates.ts'], ['apps/bridge/src/webhooks.ts'])).toBe(false);
    expect(declaredPathsOverlap(['apps/hostd/src/a.ts'], ['apps/bridge/src/a.ts'])).toBe(false);
  });

  it('reads a star within a name and a double star through everything', () => {
    expect(declaredPathsOverlap(['apps/**'], ['apps/bridge/src/gates.ts'])).toBe(true);
    expect(declaredPathsOverlap(['packages/*/src/x.ts'], ['packages/db/src/x.ts'])).toBe(true);
    expect(declaredPathsOverlap(['crew/skills/spec*'], ['crew/skills/spec/SKILL.md'])).toBe(true);
    expect(declaredPathsOverlap(['crew/skills/spec*'], ['crew/skills/qa/SKILL.md'])).toBe(false);
  });

  it('finds two globs in one segment that one name can match, as the dispatcher does', () => {
    expect(declaredPathsOverlap(['apps/bridge/src/scheduler*'], ['apps/bridge/src/*.test.ts'])).toBe(true);
    expect(declaredPathsOverlap(['src/a*.ts'], ['src/b*.ts'])).toBe(false);
    expect(declaredPathsOverlap(['src/*.ts'], ['src/*.md'])).toBe(false);
  });

  it('is false when either list is empty', () => {
    expect(declaredPathsOverlap([], ['a.ts'])).toBe(false);
    expect(declaredPathsOverlap(['a.ts'], [])).toBe(false);
  });
});

/**
 * A declared path is text anybody with access can write into an issue body.
 * Matched with a RegExp, one star-filled segment backtracked for seconds, and
 * a run of trailing stars took the scope check seconds to trim.
 */
describe('a declared path made to be slow', () => {
  // The bounds catch a return of the backtracking these replaced, which took
  // seconds; a shared CI runner can take a few hundred milliseconds on its own.
  const within = (ms: number, run: () => unknown) => {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(ms);
  };

  it('is compared in linear time, however many stars a segment holds', () => {
    within(1_000, () => expect(declaredPathsOverlap(['x/' + 'a*'.repeat(30) + 'b'], ['x/' + 'a'.repeat(60)])).toBe(false));
  });

  it('is trimmed of its trailing stars in linear time', () => {
    within(1_000, () => expect(filesOutsideScope(['a/b.ts'], ['a' + '*'.repeat(30_000) + 'x']).inScope).toBe(false));
  });

  it('is left unread when a brace group would name more paths than a line of files', () => {
    // Twenty-six `{a,b}` groups are about 150 characters and used to allocate
    // millions of strings until the process aborted. The line is unreadable
    // instead, and it is decided without building them.
    const line = `- src/${'{a,b}'.repeat(30)}.ts`;
    const body = `## Expected paths\n\n${line}\n`;
    const started = performance.now();
    expect(declaredPathsFrom(body)).toEqual([]);
    expect(unreadablePathLines(body)).toEqual([`src/${'{a,b}'.repeat(30)}.ts`]);
    expect(performance.now() - started).toBeLessThan(1_000);
    // Sixteen paths, no more, still expand.
    expect(declaredPathsFrom(`## Expected paths\n\n- src/${'{a,b}'.repeat(4)}.ts\n`)).toHaveLength(16);
  });

  it('is split on its commas in linear time, and still not inside a brace group', () => {
    // Each comma scanned the rest of the line for a closing brace: a 65 KB
    // line of commas took six seconds to read.
    within(1_000, () => expect(declaredPathsFrom(`## Expected paths\n\n- a${','.repeat(65_000)}b\n`)).toEqual(['a', 'b']));
    expect(declaredPathsFrom('## Expected paths\n\n- a.ts, src/{b,c}.ts,d/{e,f}/g.ts, and h.ts\n')).toEqual([
      'a.ts',
      'src/b.ts',
      'src/c.ts',
      'd/e/g.ts',
      'd/f/g.ts',
      'h.ts',
    ]);
  });

  it('is cut at its description in linear time, however many spaces it holds', () => {
    // Each space began a fresh try at "spaces, a dash, spaces": a 65 KB line of
    // spaces took about 22 seconds to read, as did one of spaces around "and".
    within(1_000, () => expect(unreadablePathLines(`## Expected paths\n\n- a${' '.repeat(65_000)}b\n`)).toHaveLength(1));
    within(1_000, () => expect(unreadablePathLines(`## Expected paths\n\n- a${' '.repeat(32_000)}and${' '.repeat(32_000)}b\n`)).toHaveLength(0));
    expect(declaredPathsFrom('## Expected paths\n\n- src/a.ts  —  the gate (new): and more\n')).toEqual(['src/a.ts']);
  });

  it('is left out of the Expected paths when it is too long, or holds whitespace', () => {
    const long = `apps/${'a'.repeat(200)}.ts`;
    expect(declaredPathsFrom(`## Expected paths\n\n- apps/bridge/\n- ${long}\n- apps/x\tapps/y\n`)).toEqual(['apps/bridge/']);
  });
});

describe('the issue text CI reads Expected paths from', () => {
  const ACCEPTED = '### Expected paths\n\n- src/theme/**';
  const WIDENED = '### Expected paths\n\n- .github/workflows/**\n- config/**';
  const history = (over: Partial<Parameters<typeof acceptedIssueBody>[0]> = {}) => ({
    number: 40,
    body: WIDENED,
    author: 'stranger',
    authorAssociation: 'NONE',
    editor: 'stranger',
    lastEditedAt: '2026-10-04T09:00:00Z',
    revisions: [
      { editedAt: '2026-10-01T08:00:00Z', editor: 'stranger', body: ACCEPTED, deleted: false },
      { editedAt: '2026-10-04T09:00:00Z', editor: 'stranger', body: WIDENED, deleted: false },
    ],
    labelled: [
      { at: '2026-10-01T08:00:00Z', actor: 'stranger' },
      { at: '2026-10-01T10:00:00Z', actor: 'janedoe' },
    ],
    ...over,
  });

  it('is the live body for an author with access', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(acceptedIssueBody(history({ authorAssociation: association }))).toEqual({ body: WIDENED });
    }
  });

  it('is the live body for an issue never edited', () => {
    expect(acceptedIssueBody(history({ editor: null, lastEditedAt: null, body: ACCEPTED }))).toEqual({ body: ACCEPTED });
  });

  it('is the live body when somebody other than the author edited it last, which takes write access', () => {
    expect(acceptedIssueBody(history({ editor: 'janedoe' }))).toEqual({ body: WIDENED });
  });

  it('is the live body when the author edited it before anybody else took it up', () => {
    expect(acceptedIssueBody(history({ lastEditedAt: '2026-10-01T09:00:00Z' }))).toEqual({ body: WIDENED });
    // Labelled only by its author, as an issue form does: nobody accepted it yet.
    expect(acceptedIssueBody(history({ labelled: [{ at: '2026-10-01T08:00:00Z', actor: 'stranger' }] }))).toEqual({ body: WIDENED });
  });

  it('is the text from before it was taken up when the author edited it after', () => {
    expect(acceptedIssueBody(history())).toEqual({ body: ACCEPTED });
  });

  it('is a later revision by somebody with access, over the one from before', () => {
    const fixed = '### Expected paths\n\n- src/theme/**\n- src/fonts/**';
    const revisions = [...history().revisions, { editedAt: '2026-10-02T09:00:00Z', editor: 'janedoe', body: fixed, deleted: false }];
    expect(acceptedIssueBody(history({ revisions }))).toEqual({ body: fixed });
  });

  it('fails, naming the issue and what to do, when no such revision can be read', () => {
    const unreadable = history({ revisions: [{ editedAt: '2026-10-01T08:00:00Z', editor: 'stranger', body: null, deleted: false }] });
    const deleted = history({ revisions: [{ editedAt: '2026-10-01T08:00:00Z', editor: 'stranger', body: ACCEPTED, deleted: true }] });
    for (const one of [unreadable, deleted, history({ revisions: [] })]) {
      const verdict = acceptedIssueBody(one);
      expect(verdict).toEqual({ error: expect.stringContaining('#40 was edited by its author, stranger, after janedoe took it up') });
      expect('error' in verdict && verdict.error).toContain('A person with access edits #40');
    }
  });
});
