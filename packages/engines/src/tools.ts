import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ToolsPolicy } from './types.js';

interface RawToolsFile {
  allow?: {
    shell?: string[];
    git?: { push_branch_prefix?: string; force_push?: boolean; local_ci?: boolean };
    files?: { write_within?: string[] };
  };
  deny?: {
    shell?: string[];
    github?: string[];
  };
}

export function loadToolsPolicy(path: string): ToolsPolicy {
  const raw = parseYaml(readFileSync(path, 'utf8')) as RawToolsFile;
  return {
    allow: {
      shell: raw.allow?.shell ?? [],
      git: {
        pushBranchPrefix: raw.allow?.git?.push_branch_prefix,
        forcePush: raw.allow?.git?.force_push ?? false,
        localCi: raw.allow?.git?.local_ci ?? false,
      },
      files: { writeWithin: raw.allow?.files?.write_within ?? [] },
    },
    deny: {
      shell: raw.deny?.shell ?? [],
      github: raw.deny?.github ?? [],
    },
  };
}

/**
 * Expands `<declared_paths>` in a skill's write scope with the paths the issue
 * declared. This is what the task is told it may write (`writeScopeLine` in
 * hostd). No engine enforces the paths: a non-empty scope turns the file tools
 * on everywhere in the worktree, and CI's scope check refuses a diff outside
 * the lease (docs/security.md).
 */
export function resolveWriteScope(policy: ToolsPolicy, declaredPaths: readonly string[]): string[] {
  const scope = policy.allow.files?.writeWithin ?? [];
  return scope.flatMap((entry) => (entry === '<declared_paths>' ? [...declaredPaths] : [entry]));
}

/**
 * The variable OpenADLC's own `git` and `gh` read a task's git and GitHub rules
 * from (`apps/hostd/bin/git` and `apps/hostd/bin/gh`, first on a session's
 * PATH).
 *
 * No engine has a permission for "push only to agent/", "never force", or "no
 * `gh pr review`": Claude Code and Grok Build allow or deny a command by its
 * first words, and Codex runs whatever its sandbox lets through. So these rules
 * were loaded and applied by nobody, and a reviewer with `git` allowed could
 * push whatever `deny.github: [push]` said. They are applied instead by the
 * commands themselves, which every engine runs the same way, and each engine
 * puts this variable in the environment of what it starts.
 */
export const TOOLS_POLICY_ENV = 'OPENADLC_TOOLS_POLICY';

/**
 * The write scopes that still leave a skill read-only to OpenADLC's `git` and
 * `rg` (`readOnly` in OPENADLC_TOOLS_POLICY). The guard against `--output`,
 * `-c core.pager=…` and `rg --pre` was first written for skills with no write
 * scope at all, which left out four of the five skills that write nothing a
 * repository keeps: discover, triage and pr-review write their GitHub bodies to
 * `.openadlc-scratch/**`, and spec writes ADRs too. Neither scope is a place a
 * write runs a program from: `.openadlc-scratch/**` is never committed and
 * holds only what the session posts with `--body-file` or its own notes, and
 * `docs/adr/**` is Markdown that reaches the repository only in a pull request
 * the merge line holds like any other — not a hook, configuration, or code the
 * host runs (docs/adr/0097-a-skill-that-writes-only-scratch-and-adrs-is-read-only-to-openadlcs-git-and-rg.md).
 */
export const READ_ONLY_WRITE_SCOPES = ['.openadlc-scratch/**', 'docs/adr/**'] as const;

/**
 * Whether a skill writes nothing but scratch and ADRs, so OpenADLC's `git` and
 * `rg` refuse it what runs a program or writes a file. Derived from the write
 * scope rather than a flag in `tools.yaml`, so a new skill is guarded from the
 * start rather than once someone remembers to set it.
 */
export function isReadOnly(policy: ToolsPolicy): boolean {
  const scopes: readonly string[] = READ_ONLY_WRITE_SCOPES;
  return (policy.allow.files?.writeWithin ?? []).every((entry) => scopes.includes(entry));
}

/** What OpenADLC's `git`, `gh` and `rg` read, as the environment an engine runs under. */
export function toolsPolicyEnv(policy: ToolsPolicy): Record<string, string> {
  return {
    [TOOLS_POLICY_ENV]: JSON.stringify({
      pushBranchPrefix: policy.allow.git?.pushBranchPrefix ?? null,
      forcePush: policy.allow.git?.forcePush ?? false,
      localCi: policy.allow.git?.localCi ?? false,
      denyGithub: policy.deny.github,
      readOnly: isReadOnly(policy),
    }),
  };
}

/**
 * Whether a policy's shell lists let a command's first word run. A test aid,
 * not a guard: no engine consults it, each hands the lists to its own CLI
 * (`shellRules` in claude.ts, grok's run home). The tests that read a skill's
 * declared policy use it (engines.test.ts, tests/deploy-path.test.ts).
 */
export function isShellAllowed(policy: ToolsPolicy, command: string): boolean {
  const binary = command.trim().split(/\s+/)[0] ?? '';
  if (policy.deny.shell.includes(binary)) return false;
  return policy.allow.shell.includes(binary);
}
