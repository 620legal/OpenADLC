# Contributing to OpenADLC

## Before you write code

Open an issue describing the outcome you want, its acceptance criteria, and the
paths you expect to touch. That is the same shape OpenADLC's own
intake bot produces, and it is what makes a change reviewable.

## Your first pull request

1. **The issue.** File it with the Task form, or write the same headings
   yourself: Outcome, Acceptance criteria, Expected paths (one path per line,
   under a heading of any level) and Verification. Expected paths is what the
   scope check holds your diff to, so name the files you expect to change, and
   their tests.
2. **The pull request.** Say which issue it answers with `Closes #N` (`Fixes`
   and `Resolves` count too). Without one the scope check has nothing to
   compare against: it skips and passes, and the reviewer does that work.
3. **Leaving the declared paths.** If the change has to touch a file outside
   the issue's Expected paths, say why in the pull request. Only people with
   triage access can add the `scope:cross-cutting` label; a maintainer adds it
   when the reason holds.
4. **Before you push**, run `make ci`, as
   [docs/development.md](../docs/development.md) says.
5. **Who reviews it.** OpenADLC's crew does not act for an author without
   access to the repository, and its merge line does not land a pull request
   from a fork ([docs/security.md](../docs/security.md)). A maintainer reviews
   yours and merges it.

## Licensing your contribution

OpenADLC is Apache-2.0, and what you contribute is licensed to the project
under the same licence: inbound=outbound, as
[GitHub's Terms of Service, section D.6](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
says. The files under `crew/templates/`, which OpenADLC writes into the
repositories it manages, are Apache-2.0 or 0BSD at the user's choice
([crew/templates/LICENSE](../crew/templates/LICENSE)), and so are this
repository's own copies of three of them, kept identical to the shipped ones:
`.github/ISSUE_TEMPLATE/task.yml`, `.github/ISSUE_TEMPLATE/bug.yml` and
`.github/pull_request_template.md`. What you contribute to any of those is
licensed under both. There is no CLA and no sign-off: commit as
you normally would. When a bot or an AI assistant had a part in a change,
that is recorded as a `Co-authored-by` trailer, never as a sign-off.

## Getting set up

```bash
pnpm install
pnpm build
pnpm test
```

There is no demo mode. `fleetadlc up` starts the install `FLEETADLC_HOME` points at,
`~/.fleetadlc` by default, which on a machine that runs OpenADLC is the real one. To
see a change work end to end, start a scratch install beside it, as
[docs/development.md](../docs/development.md) says.

## Where to start

- [docs/development.md](../docs/development.md): building, checking, and a scratch
  install to watch a change work without touching a real one.
- [docs/architecture.md](../docs/architecture.md): the parts, how they talk, and one
  request from start to finish, with a glossary.
- The README in each package under `apps/` and `packages/`, and
  [tests/README.md](../tests/README.md) for the suites.

## What a good change looks like

- **One issue, one pull request.** If it needs two titles, it is two changes.
- **Tests as evidence.** A test that would fail without your change. The suites to
  copy from: `packages/github/src/device-auth.test.ts` for protocol behaviour,
  `apps/dispatcher/src/overlap.test.ts` for pure logic.
- **Code that reads like the code around it.** Match the naming and the comment
  density you find. Comments explain constraints, not what the next line does.
- **Errors a person can act on.** `${bot} is not connected to GitHub. Run: fleetadlc auth login --bot ${bot}`
  beats `unauthorized`.
- **No new dependency in a change that is not about dependencies.**
- **Documentation when behaviour changes**, in the same pull request: the guide
  or README that describes it, and `docs/platform-plan.md` when a rule changed.

## Things to be careful with

- **Credentials.** OpenADLC never asks for a personal access token. A credential
  is kept only where [docs/security.md](../docs/security.md#secrets)'s Secrets
  table says it lives (keys and tokens in the secret store,
  `packages/github/src/secrets.ts`). A change that writes one anywhere else
  (another file, a log, a GitHub comment, a container's disk) will be rejected.
- **Invariants.** A bot cannot merge (only the merge line does, as the app, once
  `mergeDecision` holds: the lead's approval of that head, or of an earlier
  head with the same diff against the base, GitHub Actions' `ci` on it, and
  the approval of each person AGENTS.md, on the base branch, names under Human
  review for the paths it touches; a change to how CI runs also
  needs the security reviewer or a person), never approves a deploy (the
  repository's environment rules release it), and cannot dismiss a review. If a
  change makes one of those possible, it is wrong even if the tests pass.
- **The ledger.** Usage is recorded before an engine's output is acted on, so a
  cap trips between invocations. Do not move that write later.
- **The database.** Migrations are forward-only, numbered, and never edited once
  merged.

## Reviews

Expect review on correctness first, then quality, then safety — the same three
lenses the platform's own reviewers use. Findings come as
`[severity] file:line — what is wrong; the rule; what to change`. A `blocker`
holds the merge until it changes or a person overrides it, a `major` until it
changes or the reviewer accepts your reason, and a `minor` is advisory.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Everyone taking part is expected to follow the
[code of conduct](CODE_OF_CONDUCT.md).
