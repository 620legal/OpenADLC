import { describe, expect, it } from 'vitest';
import {
  everyHumanReviewer,
  humanReviewSectionChanged,
  humanReviewLabelFor,
  humanReviewLogins,
  humanReviewersFor,
  parseHumanReviewPaths,
  pathMatches,
  unreadableHumanReviewLines,
} from './human-review.js';

const AGENTS = `# Agent notes

- Run \`make ci\` before opening a pull request.

## Human review

These paths need the named person's approval before anything merges.

- \`config/\` @janedoe
- \`infra/\` @janedoe
- \`.github/workflows/\` @janedoe @security-lead
- docs/platform-plan.md @janedoe

## Something else

- \`src/\` @not-a-reviewer
`;

describe('reading who has to approve what', () => {
  it('takes the rules from the human review section', () => {
    const rules = parseHumanReviewPaths(AGENTS);

    expect(rules).toEqual([
      { path: 'config/', logins: ['janedoe'] },
      { path: 'infra/', logins: ['janedoe'] },
      { path: '.github/workflows/', logins: ['janedoe', 'security-lead'] },
      { path: 'docs/platform-plan.md', logins: ['janedoe'] },
    ]);
  });

  it('stops at the next heading, so another section is not a rule', () => {
    const rules = parseHumanReviewPaths(AGENTS) ?? [];
    expect(rules.some((rule) => rule.logins.includes('not-a-reviewer'))).toBe(false);
  });

  it('tells "said nothing" apart from "said nothing is needed"', () => {
    // The caller holds the gate on null and releases on an empty list, so these
    // must not collapse into each other.
    expect(parseHumanReviewPaths(null)).toBeNull();
    expect(parseHumanReviewPaths('# Agent notes\n\nNothing about review here.\n')).toBeNull();
    expect(parseHumanReviewPaths('## Human review\n\nNo paths need one.\n')).toEqual([]);
  });

  it('ignores a path that names nobody, rather than holding the change for no one', () => {
    expect(parseHumanReviewPaths('## Human review\n\n- `config/`\n- `infra/` @janedoe\n')).toEqual([
      { path: 'infra/', logins: ['janedoe'] },
    ]);
  });

  it('reads the heading at any level and any case', () => {
    expect(parseHumanReviewPaths('#### HUMAN REVIEW\n\n- `a/` @x\n')).toEqual([{ path: 'a/', logins: ['x'] }]);
  });
});

describe('matching a change against a path', () => {
  it('matches a file inside a directory, not one that merely shares a prefix', () => {
    expect(pathMatches('config/', 'config/bots.yaml')).toBe(true);
    // The trap: `configuration.md` starts with `config` but is not in `config/`.
    expect(pathMatches('config/', 'configuration.md')).toBe(false);
  });

  it('matches an exact file', () => {
    expect(pathMatches('docs/platform-plan.md', 'docs/platform-plan.md')).toBe(true);
    expect(pathMatches('docs/platform-plan.md', 'docs/handoff.md')).toBe(false);
  });

  it('treats a trailing glob as the directory it is under', () => {
    expect(pathMatches('infra/**', 'infra/gcp/main.tf')).toBe(true);
    expect(pathMatches('infra/**', 'apps/bridge/src/main.ts')).toBe(false);
  });
});

describe('who a change has to wait for', () => {
  const rules = parseHumanReviewPaths(AGENTS) ?? [];

  it('nobody, when no listed path is touched', () => {
    expect(humanReviewersFor(['apps/bridge/src/main.ts', 'README.md'], rules)).toEqual([]);
  });

  it('the person a touched path names', () => {
    expect(humanReviewersFor(['config/bots.yaml'], rules)).toEqual(['janedoe']);
  });

  it('everyone a touched path names, without repeating them', () => {
    expect(humanReviewersFor(['.github/workflows/ci.yml', 'config/bots.yaml'], rules)).toEqual([
      'janedoe',
      'security-lead',
    ]);
  });

  it('nobody, when the repository lists no rules at all', () => {
    expect(humanReviewersFor(['config/bots.yaml'], [])).toEqual([]);
  });
});

describe('the label says whose approval is outstanding', () => {
  it('names the person rather than the fact', () => {
    // The old label was `review:human`, which is what made any human's approval
    // look like the right one.
    expect(humanReviewLabelFor('janedoe')).toBe('review:human:janedoe');
  });
});

describe('where each named reviewer is written', () => {
  it('gives every login in the section with its line, so a card can point at it', () => {
    expect(humanReviewLogins(AGENTS)).toEqual([
      { login: 'janedoe', path: 'config/', line: 9 },
      { login: 'janedoe', path: 'infra/', line: 10 },
      { login: 'janedoe', path: '.github/workflows/', line: 11 },
      { login: 'security-lead', path: '.github/workflows/', line: 11 },
      { login: 'janedoe', path: 'docs/platform-plan.md', line: 12 },
    ]);
  });

  it('names nobody when there is no file or no section', () => {
    expect(humanReviewLogins(null)).toEqual([]);
    expect(humanReviewLogins('# Agent notes\n\n- `src/` @janedoe\n')).toEqual([]);
  });
});

/**
 * Forms a person naturally writes, which each matched nothing: the section
 * still parsed, so the bridge decided nobody was needed and merged without the
 * person it named.
 */
describe('a rule as people write it', () => {
  const reviewersOf = (line: string, file: string) =>
    humanReviewersFor([file], parseHumanReviewPaths(`## Human review\n\n${line}\n`) ?? []);

  it('matches the files each form means', () => {
    expect(reviewersOf('- `/infra/` @janedoe', 'infra/main.tf')).toEqual(['janedoe']);
    expect(reviewersOf('- `./config/` @janedoe', 'config/bots.yaml')).toEqual(['janedoe']);
    expect(reviewersOf('- `*.tf` @janedoe', 'infra/gcp/main.tf')).toEqual(['janedoe']);
    expect(reviewersOf('- `**/migrations/**` @janedoe', 'packages/db/migrations/0001_init.sql')).toEqual(['janedoe']);
    expect(reviewersOf('- `.github/workflows/*` @janedoe', '.github/workflows/ci.yml')).toEqual(['janedoe']);
    expect(reviewersOf('- `infra/` (Terraform) @janedoe', 'infra/main.tf')).toEqual(['janedoe']);
    expect(reviewersOf('- infra/ @janedoe — the Terraform', 'infra/main.tf')).toEqual(['janedoe']);
  });

  it('matches a `*` inside a path one folder at a time', () => {
    expect(pathMatches('crew/skills/*/tools.yaml', 'crew/skills/implement/tools.yaml')).toBe(true);
    expect(pathMatches('crew/skills/*/tools.yaml', 'crew/skills/implement/SKILL.md')).toBe(false);
    expect(pathMatches('crew/skills/*/tools.yaml', 'crew/templates/skills/x/tools.yaml')).toBe(false);
    expect(pathMatches('crew/skills/*/tools.yaml', 'crew/skills/a/b/tools.yaml')).toBe(false);
  });

  it('keeps a glob to what it names', () => {
    expect(reviewersOf('- `*.tf` @janedoe', 'infra/main.ts')).toEqual([]);
    expect(reviewersOf('- `**/migrations/**` @janedoe', 'packages/db/src/store.ts')).toEqual([]);
  });

  it('reads a plain path as a prefix, with or without its slash, and not as a longer name', () => {
    for (const rule of ['infra', 'infra/']) {
      expect(pathMatches(rule, 'infra/main.tf'), rule).toBe(true);
      expect(pathMatches(rule, 'infrastructure/x'), rule).toBe(false);
    }
    // A trailing star keeps reaching all the way down, as it did.
    expect(pathMatches('src/*', 'src/a/b.ts')).toBe(true);
    expect(pathMatches('docs/**', 'docs/guide/index.md')).toBe(true);
  });

  it('reads `+` and numbered items', () => {
    expect(parseHumanReviewPaths('## Human review\n\n+ secrets/ @x\n1. deploy/ @x\n2) ops/ @y\n')).toEqual([
      { path: 'secrets/', logins: ['x'] },
      { path: 'deploy/', logins: ['x'] },
      { path: 'ops/', logins: ['y'] },
    ]);
  });

  it('reads the rules under a sub-heading, and ends at a heading of the same level', () => {
    const agents = '## Human review\n\n### Infrastructure\n\n- `infra/` @janedoe\n\n### Data\n\n- `db/` @sam\n\n## Next\n\n- `src/` @nobody\n';
    expect(parseHumanReviewPaths(agents)).toEqual([
      { path: 'infra/', logins: ['janedoe'] },
      { path: 'db/', logins: ['sam'] },
    ]);
    expect(humanReviewLogins(agents).map((one) => [one.login, one.line])).toEqual([
      ['janedoe', 5],
      ['sam', 9],
    ]);
  });
});

/**
 * A line the parser cannot read holds the gate. Dropped, it released the paths
 * it meant to hold, and a one-character edit could disable a rule unseen.
 */
describe('a rule the parser cannot read', () => {
  const section = (line: string) => `## Human review\n\n- \`config/\` @janedoe\n${line}\n`;

  for (const [what, line] of [
    ['two backticked paths', '- `a/` `b/` @x'],
    ['two bare paths', '- a/ b/ @x'],
    ['a team', '- `.github/` @myorg/platform'],
    ['logins and no path', '- @x'],
    ['a backtick left open', '- `infra/ @x'],
  ] as const) {
    it(`makes the whole section unreadable: ${what}`, () => {
      expect(parseHumanReviewPaths(section(line))).toBeNull();
    });
  }

  it('is named with its line and what is wrong, so a person can fix it', () => {
    expect(unreadableHumanReviewLines(section('- `.github/` @myorg/platform'))).toEqual([
      { line: 4, text: '- `.github/` @myorg/platform', reason: expect.stringContaining('is a team') },
    ]);
    expect(unreadableHumanReviewLines(section('- a/ b/ @x'))[0]?.reason).toContain('two paths');
    expect(unreadableHumanReviewLines(AGENTS)).toEqual([]);
    expect(unreadableHumanReviewLines(null)).toEqual([]);
  });

  it('leaves an empty section meaning nothing needs a person, and a missing one unknown', () => {
    expect(parseHumanReviewPaths('## Human review\n\n')).toEqual([]);
    expect(parseHumanReviewPaths('# Notes\n')).toBeNull();
  });
});

describe('a pull request that changes the Human review section', () => {
  const BASE = [
    '# Agent notes',
    '',
    'Build with pnpm.',
    '',
    '## Human review',
    '',
    '- `config/` @janedoe',
    '- `infra/` @janedoe @alexexampleco',
    '',
    '## Invariants',
    '',
    'A bot never merges.',
    '',
  ].join('\n');
  const edit = (from: string, to: string) => {
    expect(BASE).toContain(from);
    return BASE.replace(from, to);
  };

  it.each([
    ['a line taken out', edit('- `config/` @janedoe\n', '')],
    ['the list emptied', edit('- `config/` @janedoe\n- `infra/` @janedoe @alexexampleco\n', '')],
    ['a rule rewritten with ./', edit('`config/`', '`./config/`')],
    ['a sub-heading put in', edit('## Human review\n', '## Human review\n\n### Paths\n')],
    ['the section taken out', edit('## Human review\n\n- `config/` @janedoe\n- `infra/` @janedoe @alexexampleco\n\n', '')],
  ])('is one with %s', (_what, head) => {
    expect(humanReviewSectionChanged(BASE, head)).toBe(true);
  });

  it('is one that deletes AGENTS.md', () => {
    expect(humanReviewSectionChanged(BASE, null)).toBe(true);
  });

  it('is not one that changes only the text around the section, or its line endings', () => {
    expect(humanReviewSectionChanged(BASE, edit('Build with pnpm.', 'Build with pnpm, then run make ci.'))).toBe(false);
    expect(humanReviewSectionChanged(BASE, edit('A bot never merges.', 'A bot never merges, and never approves.'))).toBe(false);
    expect(humanReviewSectionChanged(BASE, BASE.replace(/\n/g, '\r\n'))).toBe(false);
  });
});

describe('everyone the section names', () => {
  it('is each login once, in the order the rules name them', () => {
    const rules = parseHumanReviewPaths('## Human review\n\n- `config/` @janedoe\n- `infra/` @janedoe @alexexampleco\n') ?? [];
    expect(everyHumanReviewer(rules)).toEqual(['janedoe', 'alexexampleco']);
  });
});
