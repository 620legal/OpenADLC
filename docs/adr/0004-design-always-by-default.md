# 0004. Design is Always by default

- **Status:** accepted
- **Date:** 2026-10-20

## Context

A repository's spec mode says which of its issues get a design pass before
Build. The plan's D7, "Spec is conditional by default", made it `conditional`:
a pass only for an issue carrying one of the repository's spec-required labels
(`touches:schema`, `touches:contract`, `touches:migration`, `size:large`,
`safety`), so that a small change did not wait on a second stage.

In practice intake seldom puts one of those labels on, so nearly every issue
went from intake straight to Build and Design ran on almost nothing. The only
control was on the repository's own page, under "What each stage may do
without asking", and nothing on the main Settings page showed the choice or
led to it.

The default also lived in five places in code: `REPO_DEFAULTS` in
`packages/shared`, which both ways of adding a repository read (the console's
add route and the `config/repos.yaml` seed), three `?? 'conditional'`
fallbacks in the bridge, and the console's `modeOf`. A sixth, the
`stage_modes` column's default in the schema (migration 0018), says
`conditional` as well, and nothing reads it: every insert writes the whole
stage map.

## Decision

A new repository's Design mode is `autonomous`: every issue gets a design pass
before Build. This supersedes D7, which now reads "Design is Always by
default".

- `REPO_DEFAULTS.stageModes.spec` is `autonomous`, for a repository added in
  the console and for one seeded from `config/repos.yaml` without
  `stageModes`. The other stages' defaults are unchanged.
- The bridge's fallbacks for a row with no `spec` stored read
  `REPO_DEFAULTS`, not a literal of their own. The console does not depend on
  `@openadlc/shared`, so `modeOf` keeps its own `autonomous`, and its test
  holds it to `REPO_DEFAULTS`.
- A repository that has `spec` stored keeps it, with no migration. Every
  insert writes the whole stage map (`{...REPO_DEFAULTS.stageModes, ...}`, or a
  backup's own map on restore), so every existing repository has `spec`
  stored, and one at `conditional` stays there until a person changes it. A
  `config/repos.yaml` that writes `spec: conditional` keeps getting it.
- The `stage_modes` column's default stays `conditional`. No insert falls
  back to it, for the reason above, so it decides nothing, and changing it
  would be a migration that changes no behaviour. The five places in code
  now agree; the column default does not, and is not read.
- `conditional` stays, as the opt-out. Settings' list of repositories says
  each one's Design choice (Always, When it matters, or Never for `untouched`)
  and links to where it is changed on the repository's page, which keeps the
  only control.
- Intake's routing is unchanged (`stageAfterIntake`, the triage skill). The
  mode always decided; only the mode a new repository gets has changed.

## What this rules out

- **Keeping `conditional` and asking intake to label more.** The rule needs
  intake to recognise a schema change, a contract or a migration from a
  request before anything has been designed. It seldom did, and the issues it
  missed are the ones a design pass is for.
- **Rewriting existing repositories to `autonomous`.** A stored mode may be a
  person's choice, and the row does not say whether it is one. Rewriting it
  would undo a setting without anyone being told.
- **Changing the four literals to `autonomous` and leaving `REPO_DEFAULTS` a
  copy of its own.** It works today and leaves the default in five places in
  code, which is how the bridge and what the store writes could come to
  disagree again.
- **A Design control on the main Settings page as well.** Two controls are two
  places that write one setting; the list shows the choice and links to the
  control.

## What would make this worth revisiting

Design's cost per issue proving too high for small changes: a design pass on
a small change costing more, in spend or in time to merge, than it saves. The
answer then is a rule for which issues earn one that intake can actually
apply, not a return to the label rule.
