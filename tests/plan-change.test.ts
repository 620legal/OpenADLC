import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolsPolicy, resolveWriteScope } from '@fleetadlc/engines';
import {
  PLAN_CHANGE_APPROVE,
  PLAN_CHANGE_REFUSE,
  addExpectedPaths,
  declaredPathsFrom,
  declaredPathsOverlap,
  filesOutsideScope,
  parseQuestion,
  resolveAnswer,
} from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import { pathsOverlap } from '../apps/dispatcher/src/overlap.ts';

/**
 * A task that needs a file outside its lease asks for it, and what it asks
 * with has to be what the pieces on either side read: the skill that tells a
 * bot how to ask, the parser that reads it, the tools policy that decides
 * where it may write, the overlap rule that decides whether it may have the
 * path, and the scope check that is finally run on its pull request.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const ISSUE = [
  '## Outcome',
  'Allow tasks to request path expansions.',
  '',
  '## Expected paths',
  '',
  '- apps/bridge/src/gates.ts',
  '- docs/',
  '',
  '## What it touches',
  'The gates.',
].join('\n');

describe('the overlap rule a request is held by', () => {
  // A request held by a looser rule than the one the lease was granted under
  // would let two issues onto a file. The rule used to be written twice, and
  // the copies were held equal only by a test; now there is one.
  it('is the dispatcher’s own', () => {
    expect(declaredPathsOverlap).toBe(pathsOverlap);
  });

  it('compares the paths a line with a brace group or a list is read as', () => {
    // The rule reads braces as letters: a group left unexpanded overlapped
    // nothing, and two issues on one file were leased side by side.
    const declared = declaredPathsFrom(
      '## Expected paths\n\n- apps/bridge/src/{gates,send-back}.ts\n- `docs/a.md`, `docs/b.md`\n',
    );
    expect(declared).toEqual(['apps/bridge/src/gates.ts', 'apps/bridge/src/send-back.ts', 'docs/a.md', 'docs/b.md']);
    expect(declaredPathsOverlap(declared, ['apps/bridge/src/gates.ts'])).toBe(true);
    expect(declaredPathsOverlap(declared, ['docs/b.md'])).toBe(true);
    expect(declaredPathsOverlap(declared, ['apps/bridge/src/x.ts'])).toBe(false);
  });
});

describe('the tools policy of a build task', () => {
  const policy = loadToolsPolicy(join(ROOT, 'crew', 'skills', 'implement', 'tools.yaml'));

  it('lets it write the docs whatever its lease declared, and its tests, and nothing else outside the lease', () => {
    const scope = resolveWriteScope(policy, ['apps/bridge/src/gates.ts']);

    expect(scope).toContain('docs/**');
    expect(scope).toContain('tests/**');
    expect(scope).toContain('apps/bridge/src/gates.ts');
    expect(scope.filter((entry) => !['docs/**', 'tests/**', 'AGENTS.md', '.fleetadlc-scratch/**', 'apps/bridge/src/gates.ts'].includes(entry))).toEqual([]);
  });

  it('is widened by the lease’s paths alone, so a plan change takes effect through the lease', () => {
    const before = resolveWriteScope(policy, ['apps/bridge/src/gates.ts']);
    const after = resolveWriteScope(policy, ['apps/bridge/src/gates.ts', 'apps/hostd/src/skill-runner.ts']);

    expect(after.filter((entry) => !before.includes(entry))).toEqual(['apps/hostd/src/skill-runner.ts']);
  });
});

describe('a path that is asked for, approved, and then changed', () => {
  const asked = [
    'The runner drops the field.',
    '<!-- fleetadlc:{"event":"plan_change","paths":["apps/hostd/src/skill-runner.ts"],"reason":"it forwards nothing"} -->',
  ].join('\n');

  it('is refused by the scope check until the issue’s Expected paths carry it, and passes after', () => {
    const file = 'apps/hostd/src/skill-runner.ts';
    expect(filesOutsideScope([file], declaredPathsFrom(ISSUE)).inScope).toBe(false);

    const request = parseQuestion(asked)?.planChange;
    expect(request?.paths).toEqual([file]);

    const approved = addExpectedPaths(ISSUE, request?.paths ?? []);
    expect(filesOutsideScope([file, 'apps/bridge/src/gates.ts'], declaredPathsFrom(approved)).inScope).toBe(true);
    // It does not open anything else.
    expect(filesOutsideScope(['apps/hostd/src/task-runner.ts'], declaredPathsFrom(approved)).inScope).toBe(false);
  });

  it('is offered as two choices, and the bot’s words are not one of them', () => {
    const question = parseQuestion(asked);

    expect(question?.options).toEqual([PLAN_CHANGE_APPROVE, PLAN_CHANGE_REFUSE]);
    expect(resolveAnswer('1', question?.options ?? [])).toBe(PLAN_CHANGE_APPROVE);
    expect(resolveAnswer('2', question?.options ?? [])).toBe(PLAN_CHANGE_REFUSE);
    expect(resolveAnswer('yes please', question?.options ?? [])).toBe('yes please');
  });

  it('never leaves a docs page outside the scope of a change that names none', () => {
    expect(filesOutsideScope(['docs/development.md', 'docs/anything/new.md'], ['apps/bridge/src/gates.ts']).inScope).toBe(true);
  });
});

describe('what the skills tell a bot', () => {
  const implement = read('crew/skills/implement/SKILL.md');
  const triage = read('crew/skills/triage/SKILL.md');

  it('is the marker the parser reads, in the form the implement skill shows', () => {
    const example = /<!-- fleetadlc:(\{"event":"plan_change"[^\n]*\}) -->/.exec(implement)?.[0];

    expect(example).toBeDefined();
    const question = parseQuestion(`Context.\n${example}`);
    expect(question).toMatchObject({ open: false, options: ['Approve', 'Refuse'], planChange: { paths: ['apps/hostd/src/skill-runner.ts'] } });
  });

  it('tells a builder that a file outside its lease is asked for, and that the label is not its to take', () => {
    expect(implement).toMatch(/## Asking to widen your paths/);
    expect(implement).toMatch(/`docs\/\*\*`/);
    expect(implement).toMatch(/scope:cross-cutting/);
    expect(implement).toMatch(/refuses, the task is stopped/);
  });

  it('tells triage to name the documentation a change touches in its Expected paths', () => {
    expect(triage).toMatch(/documentation it\s+changes with it/);
    expect(triage).toMatch(/`docs\/`/);
  });
});
