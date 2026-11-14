# 0060. The owner of a person's account may approve production

- **Status:** accepted
- **Date:** 2026-11-14

## Context

Repository setup asks how a repository's production ships. "After a person
approves" names GitHub logins, and `POST /v1/repo-setup/production` refused any
login equal to the install's `organization` setting, because an organization
cannot review a deployment. That setting holds the owner's login whatever kind
of account it is. On an install owned by a person's account, the owner is
usually the only person there, and the walkthrough's step 11 prefills their
login (`approversFor` offers the owner only when it is a `User`). So saving
failed with "is the organization", and the repository was left with no
production choice.

The bridge already reads whether an account is a `User` or an `Organization`.
It does this through `AppReach`'s cached lookup (`accountTypeOf` with the
automation token, cached for `ACCOUNT_TYPE_MS`), which the app-reach check uses.

## Decision

Production's reviewers refuse the install's owner login only when GitHub says
the owner is an `Organization`. When it is a `User`, the login is saved like
any other person's. When the type is unknown (the lookup answers null, fails,
or the bridge has no `AppReach`), the save is not refused on that ground, and
the `production` environment's own check reports a reviewer GitHub cannot
hold. Crew accounts are still refused first, before any lookup.

The type is read from `AppReach.accountType`, now public. The route asks only
when a reviewer equals the owner's login, so a save that names other people
makes no GitHub call. A route does not call `accountTypeOf` itself.

## What this rules out

- **Calling `accountTypeOf` directly from the route.** It needs the automation
  token minted in the route. Testing it would mean mocking `github-accounts.js`
  for the whole of `api.test.ts`, where other routes call it for real.
- **A separate `accountType` dependency on the console API.** It would be a
  second, uncached path to the same answer, wired in `main.ts`.
- **Refusing when the type is unknown.** A GitHub outage would then block a
  person-owned install from saving, which is the failure this decision fixes.
  The environment check already reports a reviewer GitHub cannot hold.

## What would make this worth revisiting

- If GitHub let an organization review a deployment, or let a person's account
  hold a reviewer it cannot hold today.
- If the unrecorded fallback in `RepoSetup.productionReviewers`, which still
  strips the owner's login whatever its type, were made type-aware. The same
  lookup should serve it.
