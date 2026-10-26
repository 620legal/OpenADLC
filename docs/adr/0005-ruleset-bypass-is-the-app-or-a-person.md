# 0005. A ruleset bypass is OpenADLC's app or a person

- **Status:** accepted
- **Date:** 2026-10-21

## Context

OpenADLC writes two rulesets on each repository it manages, `openadlc: main`
and `openadlc: agent and system branches`, and names its own GitHub App as
their bypass actor, in `always` mode, so it can write CODEOWNERS to a branch it
protects. The drift check compared the bypass list with exactly that one
entry, and apply wrote that one entry back.

On 2026-10-20 the repository's owner and admin added themselves (a `User`
entry, `always`) to `openadlc: main` so they could merge while the crew was
down. From then on `openadlc doctor` warned that the repository was not
protected the way OpenADLC sets it, and `openadlc github apply` would have
taken them off.

What the bypass list must never hold is a bot: AGENTS.md's first invariant is
that a bot cannot merge, and only the merge line merges, once `mergeDecision`
holds. A crew account on the bypass list, or holding a role on it, could merge
past every rule the ruleset holds. The owner decided: a person who is an owner
or an admin may keep the bypass, as long as that person is not part of the
crew, and no crew account can be admin.

Two facts constrain how this is told apart. A `User` bypass entry carries only
a numeric id. And the app has no Members permission, so it cannot list an
organization's owners; an owner does show as admin in a repository's
permission for that login.

## Decision

Each entry on an OpenADLC ruleset's bypass list is judged (`judgeBypass`,
`packages/github/src/rules.ts`) against the crew's standing on the repository,
read once per check or apply (`crewStanding`), on both rulesets:

- **OpenADLC's app**, as `Integration` with the app's id, in `always`. Apply
  puts it back if it is missing or in another mode.
- **A person**, kept by apply as found and named by the check: a `User` whose
  id is not a crew account's; `OrganizationAdmin` while no crew account is an
  admin of the repository; a `RepositoryRole` of a base role (maintain 2,
  write 4, admin 5) while no crew account holds that role or one above it.
- **Drift**, named in the check and taken off by apply: a `User` that is a
  crew account; any other `Integration`; a `Team`; a `DeployKey`; a custom
  `RepositoryRole`; a role a crew account holds; any type not listed here.
- **Unknown**: when a crew account's id is not known, every `User` entry that
  is not a known crew id is unknown; when a crew account's role is not known,
  so is every role entry no crew account is known to hold; when the install's
  database would not say who the crew is, both are. An unknown entry is drift
  in the check and is kept by apply as it was found. It is never passed and
  never removed.

The crew is every GitHub account it works as (`crewAccountsOf`): each seat
with an account, the automation account's and the reviewers' among them, and
each account OpenADLC holds a sign-in for with no seat on it. Each is matched
by the GitHub user id the install stored when it connected (its account's and
its sign-in's, both where they differ), never by login: ids survive a rename,
and a login freed by one can be registered by somebody else. The login an
account has now is asked by its id (`GET /user/<id>`), and its role is read
under that login from `GET /repos/<repo>/collaborators/<login>/permission`,
where an organization owner shows as admin, so repository admin stands in for
organization owner. A 404 for the id is not nobody: GitHub gives one for a
flagged or suspended account too, which keeps its role, so the id still marks
the account crew and its role is not known. A
seat with no stored id is looked up by login (`GET /users/<login>`), and a 404
there is not known: it may be a renamed account.

No crew account may be an admin of a repository. `openadlc github check`
reports it as `crew accounts`, drifted, with where to lower the role, and so
does a crew account whose role could not be read; apply reports it skipped and
changes nobody's role. On the board it is a line on the `repo-rules` card, and
the `bot-access` card for that bot, which already failed, blocking, for a bot
with admin or maintain.

Apply never adds a person. A person on the list is named by
`openadlc github check` beside the ruleset, by the `repo-rules` card when it
fails, and by `openadlc doctor` under the passing line, from the health row's
detail, which an `ok` result may now carry.

## What this rules out

- **Matching a `User` entry by login, or finding a crew account's id by its
  stored login.** The entry has no login. A crew account renamed since it
  connected answers 404 under its old login, which read as no account, so its
  id on the list was kept as a person's; and whoever registered the freed
  login was taken for crew.
- **Reading a crew that could not be read as no crew.** Every bypass on the
  rulesets then passed as a person's.
- **Asking for the Members (read) organization permission** to list owners.
  It is a new grant on every installed app, and a step a person has to take on
  the app's page, to tell apart two cases that are both already a problem: a
  crew account that is an owner is an admin of the repository.
- **Never accepting a role entry, only named `User`s.** Or chose to accept a
  role while no crew account holds it; a role a crew account holds is still
  drift.
- **Removing what could not be judged.** A moment GitHub did not answer would
  take a person off the list, which they added on purpose. Passing it instead
  would let an entry through unchecked.
- **A card of its own for a crew admin on the `repo-rules` check.** The design
  proposed one; `bot-access` already raises a blocking card for the bot, with
  where to lower it. The `crew accounts` line on the `repo-rules` card covers
  what `bot-access` cannot: a crew account whose role GitHub would not give,
  which otherwise raised no card at all.

## What would make this worth revisiting

GitHub giving rulesets a way to say who a role or a team covers, or the app
gaining a reason to hold the Members permission: the role and team entries
could then be judged by their members rather than refused or accepted by role.
Or a crew that needs a bypass of its own, which would be a change to the
invariant itself, not to this rule.
