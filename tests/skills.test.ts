import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockEngine, isShellAllowed, loadToolsPolicy, resolveWriteScope } from '@fleetadlc/engines';
import { designMemoryProposals, parseMarkers, parseQuestion, parseYamlFile, policyPathMatches } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';

/**
 * An index of every skill's stop conditions, each with a scenario, and a check
 * that each scenario's script agrees with what it expects.
 *
 * What this does not show: that a skill's text makes a model stop. The scripted
 * engine plays the scenario's own script — its `ask`, its `say`, the files it
 * touches — and never reads `SKILL.md`, so "the run stopped and asked" here is
 * the script doing what it was written to do. Whether a model reading the skill
 * does the same takes a model; that is a live check (docs/unverified.md), not
 * this one. The tests used to read as if it were.
 *
 * What it does catch: a skill that declares a condition under `## Stop and ask
 * when` with no scenario for it, a scenario that names nothing the skill says,
 * and a scenario whose expectation (stops, ends as) contradicts its own script
 * or whose script writes outside the paths it declares. Scenarios live next to
 * the skill they belong to, in `crew/skills/<name>/tests/`, so adding a stop
 * condition without one fails here.
 *
 * A scenario names what it covers by an id the skill writes under the bullet,
 * `<!-- scenario: outside-declared-paths -->`, not by the bullet's place in the
 * list: numbered, a condition inserted at the top re-pointed every scenario
 * below it, and pr-review's "never-5" covered the sixth bullet.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(here, '..', 'crew', 'skills');

type Ending = 'question' | 'plan_change' | 'cap' | 'complete';
const ENDINGS: readonly Ending[] = ['question', 'plan_change', 'cap', 'complete'];

interface Scenario {
  name: string;
  /** The id of what this exercises: `<!-- scenario: <id> -->` in the skill. */
  covers: string;
  /** The task's lease: every path the script touches is inside these. */
  given: { declaredPaths: string[]; costHeadroomUsd: number };
  script: {
    say: string[];
    touch: string[];
    ask?: { question: string; options: string[] };
    planChange?: { paths: string[]; reason: string };
    costUsd?: number;
  };
  expect: { stops: boolean; reason: Ending };
}

/**
 * The fields each part of a scenario may have. Anything else is refused: a
 * scenario carried `given.files` and `expect.writesWithin`, which nothing
 * read or which checked the script against itself, and looked like evidence.
 */
const FIELDS: Record<string, readonly string[]> = {
  scenario: ['name', 'covers', 'given', 'script', 'expect'],
  given: ['declaredPaths', 'costHeadroomUsd'],
  script: ['say', 'touch', 'ask', 'planChange', 'costUsd'],
  expect: ['stops', 'reason'],
};

/**
 * Checked by hand rather than with a schema library, so the harness needs no
 * dependency of its own. A scenario that does not say what it covers, or what
 * should happen, is a scenario that cannot fail — so those are errors, not
 * defaults.
 */
function readScenario(path: string): Scenario {
  const raw = parseYamlFile(path) as Record<string, unknown>;
  const fail = (why: string): never => {
    throw new Error(`${path}: ${why}`);
  };

  const given = (raw.given ?? {}) as Record<string, unknown>;
  const script = (raw.script ?? {}) as Record<string, unknown>;
  const expected = (raw.expect ?? {}) as Record<string, unknown>;

  const parts: [string, Record<string, unknown>][] = [['scenario', raw], ['given', given], ['script', script], ['expect', expected]];
  for (const [part, fields] of parts) {
    for (const field of Object.keys(fields)) {
      if (!FIELDS[part]?.includes(field)) fail(`${part === 'scenario' ? '' : `${part}.`}${field} is not a field a scenario has`);
    }
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) fail('needs a name');
  if (typeof raw.covers !== 'string' || raw.covers.length === 0) fail('must say which condition it covers');
  if (typeof expected.stops !== 'boolean') fail('must say whether the run stops');
  if (!ENDINGS.includes(expected.reason as Ending)) fail(`expect.reason must be one of ${ENDINGS.join(', ')}`);
  if (!Array.isArray(given.declaredPaths)) fail('must declare its paths, [] for none');

  return {
    name: raw.name as string,
    covers: raw.covers as string,
    given: {
      declaredPaths: given.declaredPaths as string[],
      costHeadroomUsd: (given.costHeadroomUsd ?? 5) as number,
    },
    script: {
      say: (script.say ?? []) as string[],
      touch: (script.touch ?? []) as string[],
      ...(script.ask ? { ask: script.ask as { question: string; options: string[] } } : {}),
      ...(script.planChange ? { planChange: script.planChange as { paths: string[]; reason: string } } : {}),
      ...(script.costUsd !== undefined ? { costUsd: script.costUsd as number } : {}),
    },
    expect: {
      stops: expected.stops as boolean,
      reason: expected.reason as Ending,
    },
  };
}

function skillNames(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The bullets under `## Stop and ask when`, joined across wrapped lines. */
export function stopConditionsOf(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^##\s+Stop and ask when\s*$/i.test(line.trim()));
  if (start < 0) return [];

  const conditions: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet?.[1]) conditions.push(bullet[1].trim());
    // A wrapped bullet continues the one before it.
    else if (line.trim() && conditions.length > 0 && /^\s+\S/.test(line)) {
      conditions[conditions.length - 1] += ` ${line.trim()}`;
    }
  }
  return conditions;
}

/** The id a bullet carries, `<!-- scenario: <id> -->`, or null. */
function scenarioIdOf(text: string): string | null {
  return /<!--\s*scenario:\s*([a-z0-9-]+)\s*-->/.exec(text)?.[1] ?? null;
}

/** Every scenario id the skill carries, wherever it is. */
function scenarioIdsIn(markdown: string): string[] {
  return [...markdown.matchAll(/<!--\s*scenario:\s*([a-z0-9-]+)\s*-->/g)].map((match) => match[1] as string);
}

function scenariosFor(skill: string): { path: string; scenario: Scenario }[] {
  const dir = join(SKILLS_ROOT, skill, 'tests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => ({ path: join(dir, name), scenario: readScenario(join(dir, name)) }));
}

/** Whether a path is inside the declared ones, read as the lease's patterns are. */
function within(path: string, declared: readonly string[]): boolean {
  return declared.some((pattern) => policyPathMatches(path, pattern));
}

/**
 * Drives one scenario through the scripted engine and reports what happened.
 * A message is read for a question or a plan change the way the runner reads
 * it (`parseQuestion`, apps/hostd/src/skill-runner.ts), since a real engine
 * asks with a marker at the end of its message.
 */
async function dryRun(scenario: Scenario): Promise<{ reason: string; wrote: string[]; widening: string[] }> {
  const engine = new MockEngine({
    say: scenario.script.say,
    touch: scenario.script.touch,
    ...(scenario.script.ask ? { ask: scenario.script.ask } : {}),
    ...(scenario.script.planChange ? { planChange: scenario.script.planChange } : {}),
    ...(scenario.script.costUsd !== undefined ? { costUsd: scenario.script.costUsd } : {}),
  });

  const wrote: string[] = [];
  let ended: string | null = null;
  let widening: string[] = [];
  let reason = 'complete';

  for await (const event of engine.run({
    skill: 'dry-run',
    prompt: scenario.name,
    workdir: here,
    costHeadroomUsd: scenario.given.costHeadroomUsd,
    tools: { allow: {}, deny: {} } as never,
  } as never)) {
    if (event.type === 'file_change') wrote.push(event.path);
    if (event.type === 'question') ended ??= 'question';
    if (event.type === 'text') {
      const asking = parseQuestion(event.text);
      if (asking?.planChange) {
        ended ??= 'plan_change';
        widening = asking.planChange.paths;
      } else if (asking) ended ??= 'question';
    }
    if (event.type === 'done') reason = event.reason;
  }

  return { reason: ended ?? reason, wrote, widening };
}

describe('every stop condition a skill declares has a scenario', () => {
  const skills = skillNames();

  it('finds the crew of skills to check', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it.each(skills)('%s has at least one dry run', (skill) => {
    const scenarios = scenariosFor(skill);
    expect(
      scenarios.length,
      `skills/${skill}/tests/ has no scenario; a skill nobody can exercise is one nobody can change safely`,
    ).toBeGreaterThan(0);
  });

  it.each(skills)('%s gives every stop condition it declares an id of its own', (skill) => {
    const markdown = readFileSync(join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf8');
    const unnamed = stopConditionsOf(markdown).filter((condition) => !scenarioIdOf(condition));
    expect(unnamed, `crew/skills/${skill}/SKILL.md: end each of these bullets with <!-- scenario: <id> -->`).toEqual([]);
    const ids = scenarioIdsIn(markdown);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index), `crew/skills/${skill}/SKILL.md uses a scenario id twice`).toEqual([]);
  });

  it.each(skills)('%s exercises every stop condition it declares', (skill) => {
    const markdown = readFileSync(join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf8');
    const declared = stopConditionsOf(markdown);
    const covered = new Set(scenariosFor(skill).map((entry) => entry.scenario.covers));

    // The point of the harness: a stop condition with no scenario is a rule
    // nobody has ever seen fire.
    const uncovered = declared.filter((condition) => !covered.has(scenarioIdOf(condition) ?? ''));
    expect(
      uncovered,
      `skills/${skill}/tests/ covers ${declared.length - uncovered.length} of ${declared.length} stop conditions`,
    ).toEqual([]);
  });

  it.each(skills)('%s has no scenario that covers something it does not say', (skill) => {
    const ids = new Set(scenarioIdsIn(readFileSync(join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf8')));
    const stray = scenariosFor(skill).filter((entry) => !ids.has(entry.scenario.covers));
    expect(
      stray.map((entry) => `${entry.path} covers ${entry.scenario.covers}`),
      `crew/skills/${skill}/SKILL.md carries no <!-- scenario: <id> --> for these`,
    ).toEqual([]);
  });
});

describe('each scenario’s script agrees with what the scenario expects (the skill’s text is not run)', () => {
  for (const skill of skillNames()) {
    for (const { path, scenario } of scenariosFor(skill)) {
      it(`${skill}: ${scenario.name}`, async () => {
        const outcome = await dryRun(scenario);

        expect(outcome.reason, `${path} expected to end as ${scenario.expect.reason}`).toBe(
          scenario.expect.reason,
        );

        if (scenario.expect.stops) {
          expect(outcome.reason, `${path} must stop rather than finish`).not.toBe('complete');
        } else {
          expect(outcome.reason, `${path} must finish rather than stop`).toBe('complete');
        }

        // The lease holds the writes; a path outside it is asked for first.
        const declared = scenario.given.declaredPaths;
        for (const file of outcome.wrote) {
          expect(within(file, declared), `${path} wrote ${file}, which is outside ${declared.join(', ') || 'its declared paths'}`).toBe(true);
        }
        for (const wanted of outcome.widening) {
          expect(within(wanted, declared), `${path} asks to widen its paths to ${wanted}, which they already hold`).toBe(false);
        }
      });
    }
  }
});

/**
 * One question at a time, preferably multiple choice with an option for an
 * open answer. An open question is only for when multiple choice (even yes or
 * no) would not work. One at a time, because the answer to the first can
 * change the assumptions, and so the second question.
 *
 * The intake bot had asked four numbered questions in one message. A skill that
 * can ask a person — one that says ask, question or stop — says how.
 */
describe('a skill that can ask a person asks one question at a time', () => {
  const read = (skill: string) => readFileSync(join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf8');
  const asking = skillNames().filter((skill) => /\bask|question|\bstop/i.test(read(skill)));

  it('is every skill that asks anything', () => {
    expect(asking).toEqual(expect.arrayContaining(['deploy', 'implement', 'pr-review', 'spec', 'triage']));
  });

  it.each(asking)('%s says so, plainly', (skill) => {
    const prose = read(skill).replace(/\s+/g, ' ');

    expect(prose).toContain('## Asking a person');
    expect(prose).toContain('Ask exactly one question per message.');
    expect(prose).toContain('Prefer choices, even just yes or no. Put the likely or recommended answer first');
    expect(prose).toContain('Ask an open question only when no set of choices could cover the answers');
    expect(prose).toContain('Never number several questions in one message');
    expect(prose).toContain('you are started again with the answer: for a console request it is in `request.md`');
    expect(prose).toContain('your next question, if you still need one, builds on it');
    expect(prose).not.toMatch(/questions numbered|all at once/i);
  });

  it.each(asking)('%s shows the question in its marker, with its choices or said to be open', (skill) => {
    const questions = parseMarkers(read(skill)).filter((marker) => marker.event === 'question');

    expect(questions.some((marker) => Array.isArray(marker.options) && marker.options.length > 1)).toBe(true);
    expect(questions.some((marker) => marker.open === true)).toBe(true);
    for (const marker of questions) {
      // Read the way the runner reads it: the question is the marker's own.
      const asked = parseQuestion(`What I found.\n<!-- fleetadlc:${JSON.stringify(marker)} -->`);
      expect(typeof marker.question, JSON.stringify(marker)).toBe('string');
      expect(asked?.question).toBe(marker.question);
      expect(asked?.context).toBe('What I found.');
      expect(asked?.open).toBe(marker.open === true);
    }
  });

  it('is what the intake playbook says too', () => {
    const playbook = readFileSync(join(here, '..', 'crew', 'roles', 'intake.md'), 'utf8').replace(/\s+/g, ' ');
    expect(playbook).toContain('one question at a time');
    expect(playbook).not.toMatch(/all at once|in one comment/i);
  });
});

/**
 * On 2026-09-30 the reviewers' sandbox denies `curl`, `wget` and
 * `docker`, and reviewers reported checks they could not run as red CI. The
 * stage flow then took CI away from reviewers altogether: every seat reviews
 * the diff, the lead goes last and decides, and GitHub's CI is the merge's to
 * wait for, after the lead approved.
 */
describe('a reviewer reviews the diff, and the lead decides last', () => {
  const skill = readFileSync(join(SKILLS_ROOT, 'pr-review', 'SKILL.md'), 'utf8');
  const section = (heading: string): string => {
    const start = skill.indexOf(`## ${heading}\n`);
    expect(start, `crew/skills/pr-review/SKILL.md has no "## ${heading}"`).toBeGreaterThanOrEqual(0);
    const rest = skill.slice(start + heading.length + 4);
    const end = rest.search(/^## /m);
    return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
  };

  it('never waits for CI, and has no CI-only verdict left', () => {
    expect(skill).not.toContain('ciOnly');
    expect(skill).not.toContain('`gh pr checks');
    expect(skill.replace(/\s+/g, ' ')).toContain('You review without CI');
    expect(section('Never')).toContain('Wait for CI, or request changes for a check that has not run');
  });

  it('holds an advisory seat to a comment, its verdict and lens in its marker', () => {
    const advisory = section('Advisory: a comment, with your verdict in its marker');
    expect(advisory).toContain('gh pr review <number> --comment');
    expect(advisory).toContain('"verdict":"request_changes","lens":"security"');
    expect(advisory).toContain('refuses you `--approve` and `--request-changes`');
  });

  it('has the lead accept a genuine widening of scope in its approval, which the bridge applies', () => {
    // The label used to come from whoever added it, the builder included; a
    // person or the lead's signed approval is who may give it now.
    const lead = section('Lead: one decision, after everyone else');
    expect(lead).toContain('"scope":"cross-cutting"');
    expect(lead).toContain('once your review\'s signature checks');
    const implement = readFileSync(join(SKILLS_ROOT, 'implement', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(implement).toContain('the bridge takes off one a crew account puts on');
  });

  it('denies the builder `gh issue edit`, which could widen its own Expected paths, and leaves it its comments', () => {
    const tools = parseYamlFile(join(SKILLS_ROOT, 'implement', 'tools.yaml')) as { deny: { github: string[] } };
    expect(tools.deny.github).toContain('issue edit');
    expect(tools.deny.github).not.toContain('issue comment');
  });

  it('denies a re-run to every skill denied `gh workflow run`, since a re-run starts a promote again', () => {
    for (const skill of skillNames()) {
      const path = join(SKILLS_ROOT, skill, 'tools.yaml');
      if (!existsSync(path)) continue;
      const denied = (parseYamlFile(path) as { deny?: { github?: string[] } }).deny?.github ?? [];
      if (denied.includes('workflow run')) expect(denied, skill).toContain('run rerun');
    }
  });

  it('has the lead read every other review and send back one consolidated list', () => {
    const lead = section('Lead: one decision, after everyone else');
    expect(lead).toContain('`reviews.md` holds every other review of this round');
    expect(lead).toContain('every finding that stands');
    expect(lead).toContain('sends the work back to build');
  });

  it('tells a blocking seat, and the lead, that the lead cannot set a blocking request for changes aside', () => {
    // The lead was told it decided over a blocking seat, approved over one,
    // and the merge waited with nothing sending the work back.
    const blocking = section('Blocking');
    expect(blocking).not.toContain('decides whether the work goes back');
    expect(blocking).toContain('the lead cannot set it aside');
    const lead = section('Lead: one decision, after everyone else');
    expect(lead).toContain('Request changes carrying its findings that stand, or ask a person whether to override it. Do not approve over it.');
  });

  it('still refuses waived invariants', () => {
    expect(section('Never')).toContain('Waive an invariant');
  });

  it('reads the issue and the plan from the bridge’s filtered documents, never from GitHub', () => {
    // A review task's issue.md had no comments, so the skill sent reviewers to
    // `gh issue view --comments`, which returns a stranger's too.
    const lead = readFileSync(join(here, '..', 'crew', 'roles', 'review_lead.md'), 'utf8').replace(/\s+/g, ' ');
    for (const text of [skill.replace(/\s+/g, ' '), lead]) {
      expect(text).toContain('`issue.md`');
      expect(text).toContain('`pull-request.md`');
      expect(text).not.toMatch(/Read the issue and the builder's plan comment, so/);
    }
    expect(skill.replace(/\s+/g, ' ')).toContain('Do not fetch comments or reviews with `gh`');
    expect(lead).toContain('never with `gh`');
  });

  it('is what the reviewer playbooks say too', () => {
    const lead = readFileSync(join(here, '..', 'crew', 'roles', 'review_lead.md'), 'utf8').replace(/\s+/g, ' ');
    expect(lead).toContain('You review last, and your review is the decision.');
    const second = readFileSync(join(here, '..', 'crew', 'roles', 'review_second.md'), 'utf8').replace(/\s+/g, ' ');
    expect(second).toContain("Approve or request changes on GitHub, unless your brief's `review part:` is `blocking`: otherwise the decision is the lead");
    const security = readFileSync(join(here, '..', 'crew', 'roles', 'review_security.md'), 'utf8').replace(/\s+/g, ' ');
    expect(security).toContain("Approve or request changes on GitHub, unless your brief's `review part:` is `blocking`");
  });

  it('takes the part and the lens from the brief, which states both', () => {
    // The part was only in the session's environment and the lens nowhere, so
    // a seat set `blocking` followed its playbook and only ever commented.
    expect(skill.replace(/\s+/g, ' ')).toContain("your task's brief gives on its `review part:` line (`lead`, `advisory` or `blocking`), with your lens on its `lens:` line");
    expect(section('Markers').replace(/\s+/g, ' ')).toContain("exactly as your brief's `lens:` line gives it");
  });

  it('carries a checklist for every lens the review rules route to, in the prompt itself', () => {
    // The checklists were files beside the skill, under a path no reviewer was
    // given and a headless session could not read, so no seat ever saw one —
    // the security seat's prompt-injection questions included. The runner puts
    // SKILL.md in the prompt, so each lens's checklist lives there.
    const rules = parseYamlFile(join(here, '..', 'config', 'review.yaml')) as { reviewers: { lens: string }[] };
    const start = skill.indexOf('## Checklists\n');
    expect(start, 'crew/skills/pr-review/SKILL.md has no "## Checklists"').toBeGreaterThanOrEqual(0);
    const rest = skill.slice(start + '## Checklists\n'.length);
    const checklists = rest.slice(0, rest.search(/^## /m));
    for (const { lens } of rules.reviewers) {
      expect(checklists, `pr-review has no "### ${lens}" checklist`).toMatch(new RegExp(`^### ${lens}\n`, 'm'));
    }
    expect(skill).not.toContain('checklists/');
    expect(existsSync(join(SKILLS_ROOT, 'pr-review', 'checklists'))).toBe(false);
    expect(section('Do this, in order')).toContain('under "Checklists" below');
  });

  it('tells the SRE it reviews as its brief says, by default as the workflows lens, and that the lead decides', () => {
    // A review task opens with the seat's playbook first, and the SRE's said
    // only that its job starts after merge.
    const sre = readFileSync(join(here, '..', 'crew', 'roles', 'deploy.md'), 'utf8').replace(/\s+/g, ' ');
    expect(sre).toContain('You follow the pr-review skill with the part and the lens your brief gives');
    expect(sre).toContain('through the `workflows` lens');
    expect(sre).toContain('the lead decides');
  });

  it('reads the code under review and never runs it', () => {
    // A review session holds the account whose approval lands the pull
    // request, so a test the builder planted ran with that token: it could
    // post an approval tagged as the lead's. hostd's recorded run is the run.
    const step = section('Do this, in order');
    expect(step).toContain("Read the pull request's code; never run it.");
    expect(step).toContain('never run its tests, its build, its scripts or its `make` targets in this session');
    expect(step).toContain('holds the account whose approval lands the pull request');
    expect(step).toContain('`local-ci.md` in the lead');
    expect(skill).not.toContain('Run what you need to verify');
    const tools = parseYamlFile(join(SKILLS_ROOT, 'pr-review', 'tools.yaml')) as { allow: { shell: string[] }; deny: { shell: string[] } };
    const runners = ['make', 'pnpm', 'npm', 'uv', 'python', 'python3', 'node'];
    for (const runner of runners) expect(tools.allow.shell, runner).not.toContain(runner);
    expect(tools.deny.shell).toEqual(expect.arrayContaining(runners));
  });

  it('does not install either: fleetadlc-install runs whatever it is given', () => {
    const tools = parseYamlFile(join(SKILLS_ROOT, 'pr-review', 'tools.yaml')) as { allow: { shell: string[] } };
    expect(tools.allow.shell).not.toContain('fleetadlc-install');
  });

  it('leaves the sandbox as it was', () => {
    const tools = parseYamlFile(join(SKILLS_ROOT, 'pr-review', 'tools.yaml')) as { deny: { shell: string[] } };
    expect(tools.deny.shell).toEqual(expect.arrayContaining(['curl', 'wget', 'docker']));
  });
});

/**
 * Design is the only stage with memory and context. What the spec skill shows
 * as its `design_memory` line has to be one the bridge can read, or every
 * design written from the example would propose nothing.
 */
describe('the design stage remembers what it decides', () => {
  const spec = readFileSync(join(SKILLS_ROOT, 'spec', 'SKILL.md'), 'utf8');

  it('shows a design_memory line the bridge reads into entries', () => {
    // The bridge reads only a comment's last marker, so the example line is
    // read as the end of a design comment, which is where the skill puts it.
    const line = spec.split('\n').find((one) => one.includes('"event":"design_memory"')) ?? '';
    const entries = designMemoryProposals(`The design.\n\n<!-- fleetadlc:{"event":"plan_posted"} -->\n${line}`);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.kind)).toContain('decision');
  });

  it('commits only ADRs, on a pull request with a recorded local CI pass', () => {
    // The maintainer kept the design stage's ADR pull requests, limited to
    // docs/adr/. Without fleetadlc-ci the lead could never approve one.
    const policy = loadToolsPolicy(join(SKILLS_ROOT, 'spec', 'tools.yaml'));
    expect(policy.allow.files?.writeWithin).toEqual(['docs/adr/**', '.fleetadlc-scratch/**']);
    expect(policy.allow.git?.pushBranchPrefix).toBe('agent/');
    expect(policy.allow.git?.forcePush).toBe(false);
    expect(policy.allow.git?.localCi).toBe(true);
    expect(isShellAllowed(policy, 'fleetadlc-ci')).toBe(true);
    // Each entry is a command prefix to the engine (`Bash(git log:*)`), so a
    // bare `git` would allow every git command, a checkout or a reset included.
    const git = policy.allow.shell.filter((entry) => entry.split(/\s+/)[0] === 'git');
    expect(git.length).toBeGreaterThan(0);
    for (const entry of git) {
      expect(
        ['git rev-parse', 'git log', 'git show', 'git ls-files', 'git grep', 'git diff', 'git status', 'git switch', 'git add', 'git commit', 'git push'],
        entry,
      ).toContain(entry);
    }
    const flat = spec.replace(/\s+/g, ' ');
    expect(flat).toContain('Write code, or any file outside `docs/adr/`, in any repository.');
    expect(flat).toContain('`Refs #<issue>`, never `Closes`');
    expect(spec).toContain('agent/$FLEETADLC_BOT/adr-NNNN-short-title');
  });

  it('names the ADR a decision is recorded in, and the builder writes it', () => {
    expect(spec).toContain('docs/adr/NNNN-short-title.md');
    const implement = readFileSync(join(SKILLS_ROOT, 'implement', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(implement).toContain("When the issue's Expected paths name an ADR");
  });
});

/**
 * QA was told to maintain its suites through pull requests, and could not get
 * one reviewed: it could not run `fleetadlc-ci`, so no pass was ever recorded
 * for its head, and its write scope named paths the bridge never declares.
 */
describe('QA changes its suites the way a builder changes code', () => {
  const policy = loadToolsPolicy(join(SKILLS_ROOT, 'qa', 'tools.yaml'));

  it('runs fleetadlc-ci, and its git and gh ask for the recorded pass', () => {
    expect(isShellAllowed(policy, 'fleetadlc-ci')).toBe(true);
    expect(policy.allow.git?.localCi).toBe(true);
  });

  it('writes only the test paths its task declares, and its scratch directory', () => {
    expect(resolveWriteScope(policy, ['tests/**'])).toEqual(['tests/**', '.fleetadlc-scratch/**']);
  });

  it('says how: a suite branch, fleetadlc-ci, then a ready pull request', () => {
    const qa = readFileSync(join(SKILLS_ROOT, 'qa', 'SKILL.md'), 'utf8');
    expect(qa).toContain('agent/$FLEETADLC_BOT/suite-<short-name>');
    expect(qa).toContain('--body-file');
    expect(qa.replace(/\s+/g, ' ')).toContain('Push, or open a pull request, on a commit `fleetadlc-ci` has not passed.');
  });
});

/**
 * `fleetadlc-install` gives one install the private registry's credential.
 * No skill allowed it, so on Claude Code and Grok a builder could not run it
 * and installed without the credential. The reviewer is left out on purpose:
 * it never runs the code under review, and an install runs its scripts.
 */
describe('the skills that install can install with the registry’s credential', () => {
  it.each(['implement', 'resolve-conflict', 'qa'])('%s allows fleetadlc-install', (skill) => {
    expect(isShellAllowed(loadToolsPolicy(join(SKILLS_ROOT, skill, 'tools.yaml')), 'fleetadlc-install pnpm install')).toBe(true);
  });

  it('the builder is told to install through it', () => {
    const implement = readFileSync(join(SKILLS_ROOT, 'implement', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(implement).toContain('Add and install packages through `fleetadlc-install`');
  });
});
