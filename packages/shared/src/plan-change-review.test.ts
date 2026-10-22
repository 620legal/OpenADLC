import { describe, expect, it } from 'vitest';
import { parseHumanReviewPaths } from './human-review.js';
import { headlineFor, messageKindFor, OPENADLC_EVENTS } from './markers.js';
import {
  designerLimits,
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

  it('are every path when the rules could not be read', () => {
    // Unknown holds: a section the parser could not read covers nothing it
    // meant to, and a standing approval or the designer would have granted it.
    expect(underHumanReview(['apps/hostd/src/x.ts'], null)).toEqual(['apps/hostd/src/x.ts']);
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
