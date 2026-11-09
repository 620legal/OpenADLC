# 0034. One list of people

- **Status:** accepted
- **Date:** 2026-11-09

## Context

An install described its people in three lists that did not know about each
other: `users` (0025), the console's emails with Admin or User; the `humans`
setting, the GitHub logins that approve, pinned by account id in `humanIds`;
and `person_github_accounts` (0156), the account a person proved by device
code, used only for sign-offs. Person roles (ADR 0032) took their members from
`humans`, so on an install where `humans` was empty nobody could hold a role,
and the card pointed at a section that did not exist.

The owner asked that a person be one entry — sign-in, email, GitHub account and
name — that can hold zero, one or more roles, and that a person can answer
whether they use the console or GitHub (#251). `users` is keyed by email, so it
could not hold someone known only by a GitHub login.

## Decision

- **An install's people are one table, `people`, keyed by a person id.** Name,
  optional email (the console sign-in), console role (null means no console),
  GitHub login, `github_user_id` (the pin), `github_linked_at` (set only by the
  person's own device-code link), and `approves`. `users` and
  `person_github_accounts` are copied in once by 0162 and no longer read.
- **`humans` is derived: the logins of the people with Approves on.** With
  none, it is `OPENADLC_HUMANS`, as an unset `humans` row was. The `humans`
  settings row is gone; `PATCH /v1/install {humans}` turns Approves on for
  exactly those logins and off for everyone else. `humanIds` pins only
  environment logins.
- **Person role members are person ids, filtered to existing people.**
  Removing a person prunes them from every role in the same transaction. Roles
  no longer depend on Approves. This supersedes ADR 0032's "members are always
  a subset of live humans".
- **On GitHub, any person may answer a question; approvals need Approves.**
  `mayAnswerGates` also accepts a person matched by the delivery's account id
  when the gate is not `needsApprover` (a plan change or the cost-cap
  question). Reviews, reserved paths and production still read `humans`.
- **A gate records the person who answered** (`gates.answered_by_person`, no
  foreign key): from the console by email, the operator on a local install;
  from GitHub by account id. `answered_by` keeps the identity as written.
- **A person is matched on GitHub by account id, never by login alone.**
  `github_login` is not unique; `github_user_id` is. A link that changes an
  approving person's account turns Approves off.
- **Admins name a GitHub login; only the person confirms it.** No route sets
  `github_linked_at`. A device-code link of an account held by an email-less,
  unlinked person merges that person in.

## What this rules out

- **Extending `users`.** It meant rebuilding the primary key of a table every
  request reads, left `person_github_accounts` and `humanIds` as separate lists
  to keep in step, and kept roles naming logins, so a person with no GitHub
  login still could not hold one. The owner chose against it.
- **`OPENADLC_HUMANS` as rows that always approve, alongside People.** A union
  would widen who approves on any install with both a saved list and the
  environment set. The saved list replaced the environment before, and People
  keeps that precedence.
- **Matching a GitHub comment to a person by login.** GitHub frees a renamed
  account's login for anyone to take, so the account id decides.

## What would make this worth revisiting

Answers routed by role (the next request) needing a person to be someone other
than one console identity and one GitHub account: several accounts per person,
or one account shared by several people.
