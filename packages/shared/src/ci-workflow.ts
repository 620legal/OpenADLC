import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

/**
 * What a repository's `ci` workflow runs, and which of its jobs the local CI
 * (`make ci`, what `openadlc-ci` runs on a builder's head) already covers.
 * The console's Checks page reads it (`apps/bridge/src/checks-view.ts`);
 * nothing here runs, reruns or decides anything.
 *
 * A builder's pass is `make ci` on its head, and GitHub's `ci` runs only once
 * the lead approved. A job of `ci` that never reaches `make ci` is one a
 * builder's pass said nothing about, which is how a pull request goes red
 * after approval with nobody having seen the failure coming. The page marks
 * those jobs "differs from GitHub".
 */

/** The Makefile target hostd's local CI runs (`openadlc-ci` runs `make ci`). */
export const LOCAL_CI_TARGET = 'ci';

/** One job of a workflow file, in file order. */
export interface CiWorkflowJob {
  /** The job's key under `jobs:`. */
  key: string;
  /** Its literal `name:`, or its key when the name is missing or an expression. */
  name: string;
  /** True when `name:` held a `${{ }}` expression, so the key stands in. */
  nameIsExpression: boolean;
  /** Every step's `run:` text, in step order. */
  runs: string[];
  /** A job that calls a reusable workflow: its job-level `uses:`. It has no runs. */
  usesWorkflow: string | null;
}

export type CiWorkflowParse = { jobs: CiWorkflowJob[] } | { error: string; line: number | null };

/**
 * A workflow file's jobs, or why they could not be read: a YAML error with
 * its line, or a document with no `jobs:` map. Never throws.
 */
export function parseCiWorkflow(text: string): CiWorkflowParse {
  let doc;
  try {
    doc = parseDocument(text, { prettyErrors: true,uniqueKeys: false });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), line: null };
  }
  const first = doc.errors[0];
  if (first) {
    const line = first.linePos?.[0]?.line ?? null;
    return { error: first.message.split('\n')[0] ?? 'the file is not YAML', line };
  }
  const root = doc.contents;
  const jobsNode = isMap(root) ? root.get('jobs', true) : null;
  if (!isMap(jobsNode)) return { error: 'the file has no jobs: map', line: null };
  const jobs: CiWorkflowJob[] = [];
  for (const pair of (jobsNode as YAMLMap).items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const body = pair.value;
    const field = (name: string): unknown => (isMap(body) ? body.get(name) : undefined);
    const rawName = field('name');
    const literal = typeof rawName === 'string' && rawName.trim() !== '' && !rawName.includes('${{') ? rawName.trim() : null;
    const uses = field('uses');
    const runs: string[] = [];
    const steps = isMap(body) ? body.get('steps', true) : null;
    if (isSeq(steps)) {
      for (const step of steps.items) {
        const run = isMap(step) ? step.get('run') : undefined;
        if (typeof run === 'string') runs.push(run);
      }
    }
    jobs.push({
      key,
      name: literal ?? key,
      nameIsExpression: typeof rawName === 'string' && rawName.includes('${{'),
      runs,
      usesWorkflow: typeof uses === 'string' ? uses : null,
    });
  }
  return { jobs };
}

/** What `make <target>` reaches in one Makefile, and which target a bare `make` runs. */
export interface MakeReach {
  targets: ReadonlySet<string>;
  /** The Makefile's first target, which a bare `make` runs; null with no Makefile. */
  first: string | null;
}

/** With no Makefile on the default branch, only `make ci` itself counts. */
export function noMakefileReach(target: string = LOCAL_CI_TARGET): MakeReach {
  return { targets: new Set([target]), first: null };
}

/**
 * The `make` calls in a shell command, each as the targets it names (empty
 * for a bare `make`). A call is `make`, `$(MAKE)` or `${MAKE}` as a command
 * word: at the start of the text, a line, or after `&&`, `||`, `;`, `|` or
 * `(`, after any `NAME=value` prefixes. Flags are skipped, and so are
 * `NAME=value` arguments. A call with `-C` or `-f` is another Makefile's and
 * left out.
 */
export function makeCallsIn(command: string): string[][] {
  const calls: string[][] = [];
  // `$(MAKE)` before the split, which cuts at `(` and `)`.
  const joined = command.replace(/\\\r?\n/g, ' ').replace(/\$\(MAKE\)|\$\{MAKE\}/g, 'make');
  for (const raw of joined.split(/\r?\n|&&|\|\||;|\||\(|\)/)) {
    const words = raw.trim().replace(/^[@+-]+/, '').trim().split(/\s+/).filter(Boolean);
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    const head = words.shift();
    if (head !== 'make' && head !== '$(MAKE)' && head !== '${MAKE}') continue;
    let elsewhere = false;
    const targets: string[] = [];
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      if (word.startsWith('#')) break;
      if (word === '-C' || word === '-f' || word.startsWith('--directory') || word.startsWith('--file') || word.startsWith('--makefile') || /^-C./.test(word) || /^-f./.test(word)) {
        elsewhere = true;
        break;
      }
      if (word.startsWith('-')) continue;
      if (word.includes('=')) continue;
      if (word.includes('$')) continue;
      targets.push(word.replace(/^['"]|['"]$/g, ''));
    }
    if (!elsewhere) calls.push(targets);
  }
  return calls;
}

interface MakeRule {
  prerequisites: string[];
  recipe: string[];
}

/** A Makefile's rules, by target, and its first target. Only what reaching needs. */
function makeRules(text: string): { rules: Map<string, MakeRule>; first: string | null } {
  const rules = new Map<string, MakeRule>();
  let first: string | null = null;
  let current: MakeRule[] = [];
  let inDefine = false;
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    if (inDefine) {
      if (/^\s*endef\b/.test(line)) inDefine = false;
      continue;
    }
    if (/^\s*define\b/.test(line)) {
      inDefine = true;
      current = [];
      continue;
    }
    if (line.startsWith('\t')) {
      for (const rule of current) rule.recipe.push(line.slice(1));
      continue;
    }
    const stripped = line.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!stripped.trim()) continue;
    // An assignment, not a rule: `X := …`, `X ?= …`, `X += …`, `X = …`.
    const colon = stripped.indexOf(':');
    const equals = stripped.search(/[:?+!]?=/);
    if (colon < 0 || (equals >= 0 && equals <= colon) || stripped.slice(colon, colon + 2) === ':=' || stripped.slice(colon, colon + 3) === '::=') {
      current = [];
      continue;
    }
    const names = stripped.slice(0, colon).trim().split(/\s+/).filter(Boolean);
    const after = stripped.slice(colon + 1).replace(/^:/, '');
    // A rule's inline recipe after `;`.
    const [prereqText, inline] = after.split(/;(.*)/s) as [string, string | undefined];
    const prerequisites = prereqText
      .split(/\s+/)
      .filter((word) => word && word !== '|' && !word.includes('$(') && !word.includes('${'));
    current = [];
    for (const name of names) {
      if (name.startsWith('.') || name.includes('$(') || name.includes('%')) continue;
      if (first === null) first = name;
      const rule = rules.get(name) ?? { prerequisites: [], recipe: [] };
      rule.prerequisites.push(...prerequisites);
      if (inline?.trim()) rule.recipe.push(inline.trim());
      rules.set(name, rule);
      current.push(rule);
    }
  }
  return { rules, first };
}

/**
 * Every target `make <target>` reaches in a Makefile: its prerequisites and
 * every target its recipe calls through `make`, `$(MAKE)` or `${MAKE}`,
 * followed to the closure. Special targets (`.PHONY` and the like), pattern
 * rules, assignments and any word holding `$(` are skipped.
 */
export function makeTargetsReached(makefileText: string, target: string = LOCAL_CI_TARGET): MakeReach {
  const { rules, first } = makeRules(makefileText);
  const reached = new Set<string>([target]);
  const queue = [target];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const rule = rules.get(name);
    if (!rule) continue;
    const next = [...rule.prerequisites];
    for (const line of rule.recipe) {
      for (const call of makeCallsIn(line)) next.push(...(call.length > 0 ? call : first ? [first] : []));
    }
    for (const one of next) {
      if (!reached.has(one)) {
        reached.add(one);
        queue.push(one);
      }
    }
  }
  return { targets: reached, first };
}

/**
 * Whether the local CI covers a workflow job: some `run:` command calls
 * `make` with a target the local CI target reaches. A bare `make` counts as
 * the Makefile's first target. Anything else, a job with no runs or one that
 * calls a reusable workflow included, is not covered.
 */
export function coveredByLocalCi(job: Pick<CiWorkflowJob, 'runs'>, reach: MakeReach): boolean {
  for (const run of job.runs) {
    for (const call of makeCallsIn(run)) {
      const targets = call.length > 0 ? call : reach.first ? [reach.first] : [];
      if (targets.some((target) => reach.targets.has(target))) return true;
    }
  }
  return false;
}

/**
 * The workflow job a run's job is, as the Actions API names it: the job's
 * name exactly, or followed by ` (…)`, which covers a matrix (`test (20)`)
 * and a name expression's forms (`ci (draft)`, `ci (after approval)`). A
 * literal name is matched before a key that stands in for an expression, so
 * `ci lookup` is never taken for `ci`.
 */
export function jobOfRun<J extends Pick<CiWorkflowJob, 'name' | 'nameIsExpression' | 'key'>>(runJobName: string, jobs: readonly J[]): J | null {
  const matches = (label: string, exact: boolean): boolean => (exact ? runJobName === label : runJobName.startsWith(`${label} (`));
  const literal = jobs.filter((job) => !job.nameIsExpression);
  const fallback = jobs.filter((job) => job.nameIsExpression);
  for (const exact of [true, false]) {
    const found = literal.find((job) => matches(job.name, exact));
    if (found) return found;
  }
  for (const exact of [true, false]) {
    const found = fallback.find((job) => matches(job.key, exact));
    if (found) return found;
  }
  return null;
}
