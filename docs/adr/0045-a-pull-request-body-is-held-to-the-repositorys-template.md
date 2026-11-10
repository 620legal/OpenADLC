# 0045. A pull request body is held to the repository's template

- **Status:** accepted
- **Date:** 2026-11-10

## Context

On 2026-11-09 a builder opened a pull request in a managed repository with
OpenADLC's own list (what changed, why, how it was verified). The repository's
CI checks the body against its pull request template, and it failed on six
empty sections. GitHub's CI on a crew pull request runs only after the lead
approves, so the failure came after the review was paid for.

The builder's skill said to use "the template" and then listed OpenADLC's
sections. Nothing checked the body before it reached GitHub.

## Decision

- **Where.** The check is in OpenADLC's `gh` (`templateRefusal` in
  `apps/hostd/bin/gh`), on `gh pr create` and on a `gh pr edit` that gives a
  body, after the local CI refusal and before the header and seat tag are
  added. GitHub's CI is too late. The skill step tells the builder what the
  shim will check.
- **Who.** Every task session (`OPENADLC_TASK_ID` is set), whatever its skill.
  A repository's CI judges QA's, deploy's and spec's pull requests the same
  way. A person's own shell is not checked.
- **Which template.** Read from the worktree (`git rev-parse --show-toplevel`,
  else the cwd), in GitHub's order: `pull_request_template.md` in `.github/`,
  at the root, then in `docs/`, the name in any case. Failing those, the `.md`
  files under `.github/PULL_REQUEST_TEMPLATE/`; a body passes if it satisfies
  any one of them, and a refusal is measured against the one it misses least.
  `-R` does not change it. No template, or a template with no headings, passes
  everything.
- **Headings.** ATX headings (`#`–`######`, optional closing `#`s), outside
  HTML comments and fenced code, matched by level and text, whitespace
  collapsed, case kept: a repository's CI may compare them exactly. Setext
  headings are not read.
- **Missing and empty.** A heading is missing when the body has no such
  heading. A section runs from its heading to the next line that is one of the
  template's headings, so the author's own sub-headings stay inside it. It is
  empty when only whitespace is left once HTML comments are out, which takes
  the template's placeholders, the seat tag and the markers with them.
- **No body.** A `pr create` with no body to read (`--fill`, `--template`,
  nothing) is refused where there is a template, naming the template to fill
  with `--body-file`. A `pr edit` with no body (a title, labels) passes.
- **The refusal** names every missing and every empty section and the
  template's path, and exits 1 like the shim's other refusals.
- **Templates.** Both copies of `pull_request_template.md` ask for "None"
  rather than a deleted section.

## What this rules out

- **Limiting the check to the implement skill.** The other skills' pull
  requests fail the same CI on the same rule, only later.
- **A `tools.yaml` switch.** Those files are human-review paths, and the check
  needs no per-skill setting.
- **Checking order or placeholder prose.** The skill asks for the template's
  order; a repository that compares prose is left to its own CI.
- **Setting `PR_BODY` and `PR_TITLE` in `openadlc-ci`** so the local run sees
  the body. Out of scope for #275; a follow-up.

## What would make this worth revisiting

- A managed repository whose CI checks something this does not — order,
  setext headings, placeholder text — often enough that pull requests still
  fail after approval.
- A template whose headings a builder cannot honestly fill in a task session,
  so the refusal blocks work rather than catching an omission.
- `openadlc-ci` running the repository's body check itself, which would make
  this guard redundant.
