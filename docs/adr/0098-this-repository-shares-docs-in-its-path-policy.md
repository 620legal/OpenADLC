# 0098. This repository shares docs in its path policy

- **Status:** accepted
- **Date:** 2026-11-26

## Context

Builds in OpenADLC's own repository waited on each other because both named
the same docs page: #374 and #385 were held back by `docs/architecture.md` and
`docs/troubleshooting.md` until a person took the paths out of their Expected
paths by hand. Two edits to one doc merge or resolve easily, and `docs/` is
always inside a lease here (`ALWAYS_IN_SCOPE`, `packages/shared/src/checks.ts`),
so it is named by many issues at once.

The repository had no `.github/openadlc.yml`; its delivery rules came from the
stored row (`repos.delivery_rules`), which holds `testing: { on: release }`.
When the file is present it wins over the stored rules (`effectiveDelivery`,
`source: 'file'`), and a `paths.shared` list in it replaces
`DEFAULT_SHARED_PATHS` rather than adding to it.

## Decision

OpenADLC's own repository keeps its delivery rules and path policy in
`.github/openadlc.yml`:

- `version: 1` and `testing.on: release`, as the stored row held, so a merged
  card still waits in Ship for a release;
- `paths.shared` is every entry of `DEFAULT_SHARED_PATHS`, in order, then
  `docs/**`;
- `paths.exclusive`, `production` and `stacking` are left out, so the
  defaults stay (`production` filled with the repository's recorded production
  choice first, as for the stored row; `stacking` true).

`tests/openadlc-path-policy.test.ts` holds the file to this: it parses, it
ships as before apart from `paths`, its shared list is the defaults plus
`docs/**`, docs pages at any depth are shared, and migrations and code are not.

Consequences:

- A conflict round whose files are all under `docs/` is re-checked by the lead
  alone (`allShared` in `conflict-round.ts`). A Human review path such as
  `docs/platform-plan.md` still needs its named person through `mergeDecision`;
  the conflict round decides only which crew seats review again.
- The stored row is no longer read for this repository. Changing how it ships
  is an edit to this file in a pull request.
- A new entry in `DEFAULT_SHARED_PATHS` must be added to this file too; the
  test fails until it is.
- The plan-change hold (`Gates.blockers`) does not read the path policy, but
  no plan change asks for a docs file, since `docs/` is always in a lease.

## What this rules out

- **Adding `docs/**` to `DEFAULT_SHARED_PATHS`.** That would change every
  managed repository's default. `docs/**` is safe to share here because `docs/`
  is always in this repository's scope and its pages are prose edited side by
  side; that is not true of every repository, where docs may be generated or
  owned by one change at a time.
- **Taking docs paths out of Expected paths by hand**, as was done for #374 and
  #385. It needs a person each time and is lost on the next issue.

## What would make this worth revisiting

Docs edits in flight starting to conflict in ways the merge line or a
lead-only conflict round cannot resolve cleanly, or `docs/` no longer being
always in scope for this repository. Or `paths.shared` gaining an "add to the
default" form, at which point this file could list `docs/**` alone.
