# 0099. A skill that writes only scratch and ADRs is read-only to OpenADLC's git and rg

- **Status:** accepted
- **Date:** 2026-11-26

## Context

Five skills write nothing a repository keeps: discover, triage, spec,
plan-change-review and pr-review. They can still write a file or start a
program through the read commands their `tools.yaml` allows:

- `git log --output=x` writes a file;
- `git -c core.pager='sh x' log -p` and `git -c diff.x.textconv=… diff` start
  programs;
- `rg --pre CMD` runs CMD on every file it searches.

No engine can refuse these. Claude Code's and Grok Build's rules match only a
command's first words, and Codex applies no shell lists. The one place every
engine goes through is OpenADLC's own commands, first on the session's PATH,
which read `OPENADLC_TOOLS_POLICY` (#410).

#410 first defined "writes nothing" as an empty `write_within`. That covered
only plan-change-review. discover, triage and pr-review write their GitHub
bodies to `.openadlc-scratch/**`, and spec also writes `docs/adr/**`. A person
chose to count those two scopes as read-only.

## Decision

**What `readOnly` means.**

- `READ_ONLY_WRITE_SCOPES` (`packages/engines/src/tools.ts`) holds two scopes:
  `.openadlc-scratch/**` and `docs/adr/**`.
- `isReadOnly` is true when every `write_within` entry is one of them, and also
  when there is none.
- `toolsPolicyEnv` writes the result into the policy as `readOnly`.
- Writing to these two scopes still counts as read-only, for these reasons:
  - Scratch is never committed. It holds only what the session posts with
    `--body-file`, and its own notes.
  - An ADR is Markdown that reaches the repository only through a pull request,
    which the merge line holds like any other.
  - Neither is a hook, configuration, or code the host runs.
- A test over the shipped `crew/skills/*/tools.yaml` pins which skills come out
  read-only. It also fails on a skill that is in neither list.

**It is derived, not declared.** `readOnly` comes from `write_within`. There is
no flag in `tools.yaml`.

**A missing field reads as false.** `apps/hostd/bin` is mounted live into
running containers, so a session started before an update still carries a
policy without `readOnly`. Both shims treat it as a skill with a write scope.
Reading a missing field as read-only would refuse `-c` to every build already
running.

**For a read-only skill, the shims refuse rather than drop.** The refusal
exits non-zero, names what it refused and why, and runs nothing.

- **`git-check.mjs` refuses:**
  - every `-c` and `--config-env`;
  - `--git-dir`, `--work-tree` and `--exec-path=`;
  - any `GIT_CONFIG_*` entry except hostd's own five, and of those, the two
    that name a program pass only with hostd's values;
  - `--output` and its prefixes on every command, and `-o` on `format-patch`
    and `archive`;
  - `difftool`, `mergetool` and `instaweb`;
  - a `git config` that writes or opens an editor.
- **`git-check.mjs` overrides these variables instead of refusing them**,
  because engines set some of them themselves:
  - `GIT_PAGER` and `PAGER` are set to `cat`;
  - `GIT_EDITOR` and `GIT_SEQUENCE_EDITOR` are set to `true`;
  - `GIT_EXTERNAL_DIFF`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
    `SSH_ASKPASS` and `GIT_EXEC_PATH` are taken out.
- **The new `apps/hostd/bin/rg`** is plain sh.
  - It refuses `--pre`, `--pre-glob` and `--hostname-bin` by exact name,
    anywhere before `--`.
  - It drops `RIPGREP_CONFIG_PATH`.
  - Otherwise it runs the real rg that comes after it on PATH.
- A skill with a write scope gets none of this. Its existing refusals (push,
  alias keys, `grep -O`) are unchanged.

## What this rules out

- **A `read_only: true` flag in each `tools.yaml`.** It is explicit, but a new
  skill stays unguarded until someone remembers to set the flag. It would also
  change five files under Human review.
- **An empty `write_within` as the only read-only scope.** It guards one skill
  of the five, and pr-review, which may run any git command, is not that one.
- **Refusing only a list of program-running config keys.** The list has no end
  (`include.path`, `includeIf.*`, `gpg.program`, `sequence.editor`), and no
  read-only skill needs `-c`.
- **Dropping the refused options silently.** The session would not learn why
  its command did something other than what it asked for.
- **A Node check for `rg`.** It would add a Node start to every search. A sh
  `case` is enough for exact names, because rg takes no abbreviation of a long
  option.

## What would make this worth revisiting

- A read-only skill that needs `-c`, `git config` writes or `rg --pre` for its
  own work.
- A write scope that runs a program being added to `READ_ONLY_WRITE_SCOPES`.
- An rg release that accepts abbreviated long options, which would break the
  exact-name match.
- A real boundary (a read-only filesystem, or an engine rule that reads
  arguments) taking over what this guard does. It is a guard against a
  session that is talked into it, not a boundary.
