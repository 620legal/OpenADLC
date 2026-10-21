import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanReviewersFor, parseHumanReviewPaths } from '@openadlc/shared';
import { describe, expect, it } from 'vitest';

/**
 * The files that define how the crew is held in check wait for the
 * maintainer's approval; everything else is the crew's to review. The list
 * named only `config/`, `infra/`, the workflows and the plan, so the merge
 * decision, the gates, the access rule, the parser of the list itself and each
 * skill's `tools.yaml` could land on the lead bot's approval alone. This reads
 * the real AGENTS.md the way the bridge does.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = parseHumanReviewPaths(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')) ?? [];
const maintainer = rules.find((rule) => rule.path === 'config/')?.logins ?? [];

const GUARDED = [
  'config/bots.yaml',
  'config/review.yaml',
  'infra/gcp/main.tf',
  '.github/workflows/ci.yml',
  '.github/scripts/scope-check.mjs',
  '.github/CODEOWNERS',
  'docs/platform-plan.md',
  'apps/bridge/src/automation.ts',
  'apps/bridge/src/merge-line.ts',
  'apps/bridge/src/gates.ts',
  'packages/shared/src/access.ts',
  'packages/shared/src/authorship.ts',
  'packages/shared/src/human-review.ts',
  'packages/shared/src/checks.ts',
];

const skillTools = readdirSync(join(ROOT, 'crew', 'skills'))
  .map((skill) => `crew/skills/${skill}/tools.yaml`)
  .filter((path) => existsSync(join(ROOT, path)));

describe('the Human review section of this repository', () => {
  it('names one person, for config/ as for the rest', () => {
    expect(maintainer).toHaveLength(1);
  });

  it.each([...GUARDED, ...skillTools])('waits on the maintainer for %s', (file) => {
    // A file that moved would leave its rule guarding nothing.
    expect(existsSync(join(ROOT, file)), file).toBe(true);
    expect(humanReviewersFor([file], rules)).toEqual(maintainer);
  });

  it('waits on the maintainer for a script the workflows have yet to run', () => {
    // CODEOWNERS and the scripts beside scope-check.mjs were the crew's to
    // change: a pull request could take the maintainer off a CODEOWNERS line,
    // or add a crew account to one, or change what a workflow runs, on the
    // lead's approval alone.
    expect(humanReviewersFor(['.github/scripts/release-check.mjs'], rules)).toEqual(maintainer);
  });

  it('covers every skill’s tools.yaml there is', () => {
    expect(skillTools.length).toBeGreaterThan(0);
  });

  it.each([
    'crew/skills/implement/SKILL.md',
    'crew/roles/review_lead.md',
    'crew/templates/repo/AGENTS.md',
    'crew/templates/repo/.github/workflows/ci.yml',
    'apps/bridge/src/api.ts',
    'apps/bridge/src/automation.test.ts',
  ])('leaves %s to the crew', (file) => {
    expect(humanReviewersFor([file], rules)).toEqual([]);
  });
});

describe('.github/CODEOWNERS', () => {
  const lines = readFileSync(join(ROOT, '.github', 'CODEOWNERS'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('owns nothing outright, which would hold every pull request for a person', () => {
    expect(lines.filter((line) => line.split(/\s+/)[0] === '*')).toEqual([]);
  });

  it('names the same paths as the Human review section, each for the same person', () => {
    const owned = lines.map((line) => line.split(/\s+/));
    expect(owned.map(([path]) => path)).toEqual(rules.map((rule) => `/${rule.path}`));
    for (const [path, ...owners] of owned) expect(owners, path).toEqual(maintainer.map((login) => `@${login}`));
  });
});
