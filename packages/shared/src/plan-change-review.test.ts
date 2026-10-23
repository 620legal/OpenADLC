import { describe, expect, it } from 'vitest';
import { parseHumanReviewPaths } from './human-review.js';
import { headlineFor, messageKindFor, OPENADLC_EVENTS } from './markers.js';
import {
  designerLimits,
  keepsForPerson,
  keptForPerson,
  outsideInWords,
  parsePlanChangeVerdict,
  pathsNamedIn,
  underHumanReview,
  withoutExpectedPaths,
} from './plan-change-review.js';

const RULES = parseHumanReviewPaths(
  [
    '## Human review',
    '',
    '- `config/` @janedoe',
    '- `apps/bridge/src/gates.ts` @janedoe',
    '- `crew/skills/*/tools.yaml` @janedoe',
    '- `*.tf` @janedoe',
    '',
  ].join('\n'),
)!;

describe('the paths of a plan change that only a person may approve', () => {
  it('are the ones a Human-review rule covers, and the folders that hold one', () => {
    expect(
      underHumanReview(
        ['config/review.yaml', 'apps/bridge/src/', 'apps/bridge/src/gates.test.ts', 'crew/skills/qa/tools.yaml', 'crew/skills/qa/SKILL.md', 'infra/main.tf', 'docs/a.md'],
        RULES,
      ),
    ).toEqual(['config/review.yaml', 'apps/bridge/src/', 'crew/skills/qa/tools.yaml', 'infra/main.tf']);
  });

  it('are every path when the rules could not be read, said as that and never as Human review', () => {
    // Unknown holds: a section the parser could not read covers nothing it
    // meant to, and a standing approval or the designer would have granted it.
    // On 2026-10-22 the card said `apps/probe60-more/util.ts` was under Human
    // review, in a repository whose AGENTS.md had no such section.
    const kept = keptForPerson(['apps/probe60-more/util.ts'], null, 'main');
    expect(kept.humanReview).toEqual([]);
    expect(kept.rulesUnread?.what).toBe('OpenADLC could not read the Human-review rules in AGENTS.md on `main`');
    expect(kept.rulesUnread?.fix).toBe('Add a `## Human review` section to AGENTS.md on `main`, or fix the line of it OpenADLC cannot read; until then a person approves every path');
    expect(keepsForPerson(kept)).toBe(true);
    expect(keptForPerson(['apps/x.ts'], null, null).rulesUnread?.what).toContain('on the default branch');

    const read = keptForPerson(['config/review.yaml', 'apps/x.ts'], RULES, 'main');
    expect(read).toEqual({ humanReview: ['config/review.yaml'], rulesUnread: null });
    expect(keepsForPerson(keptForPerson(['apps/x.ts'], RULES, 'main'))).toBe(false);
  });

  // On a scratch install no GitHub account could read AGENTS.md, and the
  // message said to add a `## Human review` section and that "the
  // repository’s card in Needs you names it": neither was true, and there
  // was no such card.
  it('says why the rules could not be read when that is known, and points at no card', () => {
    const unread = (cause: Parameters<typeof keptForPerson>[3]) => keptForPerson(['apps/x.ts'], null, 'main', cause).rulesUnread!;

    expect(unread({ cause: 'no-account', account: 'openadlc-flow' })).toEqual({
      what: 'OpenADLC could not read AGENTS.md on `main` for its Human-review rules: openadlc-flow, the account it reads GitHub with, is not connected',
      fix: 'Until it is, a person approves every path. Run: openadlc auth login --bot openadlc-flow',
    });
    expect(unread({ cause: 'no-access', account: 'openadlc-flow', status: 401 })).toEqual({
      what: 'OpenADLC could not read AGENTS.md on `main` for its Human-review rules: GitHub no longer accepts openadlc-flow’s sign-in',
      fix: 'Until it is reconnected, a person approves every path. Run: openadlc auth login --bot openadlc-flow',
    });
    expect(unread({ cause: 'no-access', account: 'openadlc-flow', status: 404 })).toEqual({
      what: 'OpenADLC could not read AGENTS.md on `main` for its Human-review rules: GitHub would not let openadlc-flow read the repository',
      fix: 'Give openadlc-flow read access to the repository on GitHub; until then a person approves every path',
    });
    expect(unread({ cause: 'no-file' })).toEqual({
      what: 'OpenADLC found no AGENTS.md on `main` to read the Human-review rules from',
      fix: 'Add AGENTS.md with a `## Human review` section on `main`; until then a person approves every path',
    });
    expect(unread({ cause: 'no-section' })).toEqual({
      what: 'AGENTS.md on `main` has no `## Human review` section to read the rules from',
      fix: 'Add a `## Human review` section to AGENTS.md on `main`; until then a person approves every path',
    });
    expect(unread({ cause: 'unreadable-line', line: 12, reason: 'it names two paths; give each its own line' })).toEqual({
      what: 'OpenADLC cannot read line 12 of AGENTS.md on `main`, a Human-review rule: it names two paths; give each its own line',
      fix: 'Write line 12 as one path or glob, then the logins who must approve it; until then a person approves every path',
    });
    expect(unread({ cause: 'read-failed', status: 502 }).what).toBe('OpenADLC could not read AGENTS.md on `main` for its Human-review rules: GitHub answered 502');
    expect(unread({ cause: 'read-failed', status: null }).what).toBe('OpenADLC could not read AGENTS.md on `main` for its Human-review rules: GitHub did not answer');

    const all = [
      { cause: 'no-account', account: 'openadlc-flow' },
      { cause: 'no-access', account: 'openadlc-flow', status: 403 },
      { cause: 'no-file' },
      { cause: 'no-section' },
      { cause: 'unreadable-line', line: 3, reason: 'it names no path before the logins' },
      { cause: 'read-failed', status: 500 },
      null,
    ] as const;
    for (const cause of all) {
      const said = unread(cause);
      expect(`${said.what} ${said.fix}`).not.toMatch(/Needs you|card/);
      // Each follows "but" on the card, so none starts with a word of its own.
      expect(said.what).toMatch(/^(OpenADLC|AGENTS\.md) /);
      // Only a section that is missing is one to add.
      if (cause?.cause !== 'no-section' && cause?.cause !== 'no-file' && cause !== null) expect(said.fix).not.toContain('Add a `## Human review` section');
    }
  });
});

describe('the paths a design names', () => {
  it('are the paths in its text, in backticks or not, and nothing that is only a word', () => {
    const design = [
      '## Write sequence',
      '1. Add the column in `packages/db/migrations/0148_x.sql`.',
      '2. Read it in packages/db/src/store/leases.ts (and its test).',
      '3. Show it on the card: apps/console/src/lib/attention-card.ts.',
      'Nothing else changes, e.g. the merge line, and/or the gate.',
      '<!-- openadlc:{"event":"plan_posted"} -->',
    ].join('\n');
    expect(pathsNamedIn(design)).toEqual([
      'packages/db/migrations/0148_x.sql',
      'packages/db/src/store/leases.ts',
      'apps/console/src/lib/attention-card.ts',
    ]);
  });
});

describe('what the designer’s approval counts for', () => {
  const design = ['apps/hostd/src/skill-runner.ts', 'packages/shared/src/markers.ts'];

  it('counts for a path the design names, and for those beside it: its package, its tests, docs', () => {
    const limits = designerLimits({
      paths: ['apps/hostd/src/skill-runner.ts', 'apps/hostd/src/task-runner.ts', 'packages/shared/src/markers.test.ts', 'docs/architecture.md'],
      designPaths: design,
      humanReview: [],
    });
    expect(limits).toEqual({ counts: true, outside: [] });
  });

  it('does not count for a path in another package, and says which and why', () => {
    const limits = designerLimits({
      paths: ['apps/hostd/src/skill-runner.ts', 'apps/console/src/lib/api.ts'],
      designPaths: design,
      humanReview: [],
    });
    expect(limits.counts).toBe(false);
    expect(limits.outside).toEqual([{ path: 'apps/console/src/lib/api.ts', why: 'the design neither names it nor anything beside it' }]);
  });

  it('never counts for a path under Human review, even one the design names', () => {
    const limits = designerLimits({ paths: ['apps/hostd/src/skill-runner.ts'], designPaths: design, humanReview: ['apps/hostd/src/skill-runner.ts'] });
    expect(limits.counts).toBe(false);
    expect(limits.outside[0]?.why).toMatch(/Human review/);
  });

  it('does not count, for any path, when the Human-review rules could not be read, and says that once', () => {
    const rulesUnread = keptForPerson([], null, 'main').rulesUnread;
    const limits = designerLimits({ paths: ['apps/hostd/src/skill-runner.ts', 'packages/shared/src/markers.ts'], designPaths: design, humanReview: [], rulesUnread });
    expect(limits.counts).toBe(false);
    expect(limits.outside.map((entry) => entry.path)).toEqual(['apps/hostd/src/skill-runner.ts', 'packages/shared/src/markers.ts']);
    for (const entry of limits.outside) expect(entry.why).not.toMatch(/under Human review/);
    const said = outsideInWords(limits.outside);
    expect(said.startsWith('`apps/hostd/src/skill-runner.ts`, `packages/shared/src/markers.ts`: OpenADLC could not read the Human-review rules in AGENTS.md on `main`')).toBe(true);
    expect(said.match(/could not read/g)).toHaveLength(1);
  });

  it('does not count where the issue had no design to judge against', () => {
    const limits = designerLimits({ paths: ['apps/hostd/src/skill-runner.ts'], designPaths: null, humanReview: [] });
    expect(limits.counts).toBe(false);
    expect(limits.outside[0]?.why).toMatch(/no design/);
  });

  it('does not count for a folder wider than one package, or a glob', () => {
    const limits = designerLimits({ paths: ['apps/', 'apps/*/src/x.ts'], designPaths: design, humanReview: [] });
    expect(limits.outside.map((entry) => entry.path)).toEqual(['apps/', 'apps/*/src/x.ts']);
  });

  it('counts for a root file only when the design names it', () => {
    expect(designerLimits({ paths: ['Makefile'], designPaths: ['Makefile'], humanReview: [] }).counts).toBe(true);
    expect(designerLimits({ paths: ['Makefile'], designPaths: ['README.md'], humanReview: [] }).counts).toBe(false);
  });
});

describe('the designer’s verdict', () => {
  it('is the last plan_change_verdict marker of its message, approve or refuse, with its reason', () => {
    const text = 'The design writes the runner.\n<!-- openadlc:{"event":"plan_change_verdict","verdict":"approve","reason":"The design names the runner."} -->';
    expect(parsePlanChangeVerdict(text)).toEqual({ verdict: 'approve', reason: 'The design names the runner.' });
    expect(parsePlanChangeVerdict('<!-- openadlc:{"event":"plan_change_verdict","verdict":"REFUSE","reason":"no"} -->')).toEqual({ verdict: 'refuse', reason: 'no' });
  });

  it('is nothing for another marker, a verdict it does not know, or none at all', () => {
    expect(parsePlanChangeVerdict('<!-- openadlc:{"event":"plan_change_verdict","verdict":"maybe","reason":"x"} -->')).toBeNull();
    expect(parsePlanChangeVerdict('<!-- openadlc:{"event":"question","question":"x?"} -->')).toBeNull();
    expect(parsePlanChangeVerdict('no marker')).toBeNull();
  });

  it('is an event the bridge records, said as a line in the thread', () => {
    expect(OPENADLC_EVENTS).toContain('plan_change_verdict');
    expect(messageKindFor('plan_change_verdict')).toBe('sys');
    expect(headlineFor('plan_change_verdict')).toBe('judged a plan change');
  });
});

describe('taking approved paths back out of an issue', () => {
  it('removes exactly those lines from its Expected paths, and nothing else', () => {
    const body = ['## Outcome', 'x', '', '## Expected paths', '', '- apps/bridge/src/', '- `apps/hostd/src/skill-runner.ts`', '- docs/', '', '## Priority', 'p2'].join('\n');
    expect(withoutExpectedPaths(body, ['apps/hostd/src/skill-runner.ts'])).toBe(
      ['## Outcome', 'x', '', '## Expected paths', '', '- apps/bridge/src/', '- docs/', '', '## Priority', 'p2'].join('\n'),
    );
    expect(withoutExpectedPaths(body, ['apps/other.ts'])).toBe(body);
  });
});
