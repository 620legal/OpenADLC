# 0032. Person roles are one install setting, filtered by humans

- **Status:** accepted; superseded in part by [0034](0034-one-list-of-people.md):
  members are person ids from People, not a subset of live `humans`
- **Date:** 2026-11-05

## Context

An admin groups the install's people into roles (Product, Legal, Engineering,
and custom ones) so that a later change can route a Needs-you item to the role
it concerns. A bare "role" already means two other things in the code: an
access role (`admin`/`user`, `apps/bridge/src/roles.ts`) and a crew seat's role
(`config/bots.yaml`). So this one is a **person role** (`personRoles`,
`PersonRole`).

The install's people, `humans`, come from two sources. One is the settings
row. When that is unset, the other is `OPENADLC_HUMANS` or install.json
(`effectiveConfig`). A role can only be held by one of them, and the issue
asked that nobody taken out of `humans` should stay in a role.

## Decision

- **Roles are one install setting, `personRoles`.** It is JSON,
  `{roles: [{id, name?, members}]}`, with no migration.
- **Product, Legal and Engineering are constants** in
  `packages/shared/src/people-roles.ts`. Their names are never stored, so no
  write can rename or delete them. A missing or unreadable row reads as those
  three roles with no one in them.
- **A custom role gets an id once.** The bridge assigns `pr_` and 8 random hex
  characters when the role is added, and the id never changes, across renames
  too. The later routing work refers to that id.
- **Members are always filtered by the live `humans`.** Every read shows a
  member only if they are among the live `humans`, whichever source those come
  from.
  - When `PATCH /v1/install` saves `humans`, the stored setting is pruned and
    audited as `people_roles.pruned`. A person taken out and later put back
    does not quietly get their old roles back.
  - If the prune fails, it is logged, and the read filter still hides the
    member.
- **Two writers, and only two.** `PUT /v1/people-roles` (admins only) replaces
  the whole list and is audited as `people_roles.changed`. The prune is the
  other. `PATCH /v1/install` refuses the key.

## What this rules out

- **A table of roles and members.** That would need a migration and a store
  for what is a short list. It would also need a backup change, where the
  settings table is already backed up and restored whole.
- **Storing the fixed roles' names.** A write could then rename Product. An
  install with nothing stored would also need a seed.
- **Using the name as a custom role's id.** A rename would break whatever
  routes to it.
- **Cleaning up only when `humans` is saved.** A `humans` from
  `OPENADLC_HUMANS` or install.json changes without a save, and would leave
  stale members showing.
- **Cleaning up only on read.** A person put back in `humans` would get every
  role they had before.
- **Editing roles one at a time.** That is more routes and more audit shapes.
  Saving the whole list matches Settings → Egress, and two admins saving at
  once is last writer wins, as it is there.

## What would make this worth revisiting

- Roles held per repository rather than per install.
- Enough people or roles that saving the whole list races in practice.
- Routing that needs more on a role than a name and its people, such as a
  fallback or an order.
