# 0035. Needs-you items follow person roles

- **Status:** accepted
- **Date:** 2026-11-10

## Context

Every Needs-you item went to everyone: each person's list, badge and desktop
alert held every item, and ntfy, Slack and the webhook all posted through one
install-wide channel. Person roles (ADR 0032, members as People's ids since
ADR 0034) existed, but nothing read them. A question for Legal reached the
whole install, and the people it was for had no way to tell it from the rest.

Who holds a role changes. An item that copied its recipients when it was made
would have to be rewritten whenever someone moved in or out of a role, and
the issue asked for the change to show on the next load without that.

## Decision

- **An item's audience is worked out on every read, and never stored.**
  `apps/bridge/src/needs-you-audience.ts` gives each `AttentionKind` a rule in
  a `Record` that must cover every kind:
  - a bot's question: the role its question marker names;
  - a plan change, a promote held for a person, an approved plan change
    waiting on paths: the approvers (people with Approves on), whatever their
    role;
  - the cost-cap question: the admins;
  - a pull request waiting on one person's approval: that person by GitHub
    login, or the approvers when People has no one by it;
  - the crew's own work (a failed task, a held merge, a stopped review, …):
    Engineering;
  - what is wrong with the install itself (health checks, failed updates, a
    design memory supersede, work stuck): the admins.
- **An audience of nobody falls back to everyone, with the reason.** No role
  named, a name the install has no role by, a role nobody holds, or no
  approvers: the item shows to everyone with "For everyone: no one holds
  Legal yet" (and its kin), and notifies through the install's channel.
- **A question names its role by name.** The question marker's optional
  `role` is the name people see (`Legal`), never a custom role's `pr_` id.
  `Gates.open` resolves it once, without regard to case, and keeps it on the
  gate by id (`gates.person_role`), so a rename keeps routing it, and as asked
  (`gates.person_role_asked`), so a card can say no role is called that. A
  `plan_change` marker's role is ignored: approvers decide plan changes.
  Members are read live.
- **`GET /v1/attention` is per viewer.** It returns the items whose audience
  includes the signed-in person, matched by email, and the ones for everyone.
  The badge, the tab title and favicon count, desktop alerts and the board's
  By state are worked out in the browser from that list, so they follow with
  no change of their own. The board's `waitingOnYou` counts the viewer's open
  questions. Anything that needs every item (`WaitingNotices`) reads them with
  their audiences, never through the route.
- **A local install routes nothing.** It has one console identity, so every
  item is that person's and notifications go to the install's channel, as
  before.
- **Each person may have a channel of their own.** The `personNotify` setting
  holds `{people: {[personId]: {kind, server?, setAt}}}`, and the target is the
  secret `notify-target:person:<id>`, written only by that person through
  `/v1/me/notifications`. An item routed to people is sent to each one's own
  channel and **never** to the install's; a person with none gets nothing
  from the bridge, and still has the badge, the desktop alert and GitHub's
  mention. The install's channel is the admins': it carries what is for
  everyone, and its health check counts only its own deliveries.
- **Who may answer is not routed.** `mayAnswerGates` and the console's answer
  routes are unchanged, and anyone with access opens an item by its link.

## What this rules out

- **Storing each item's recipients.** A role change would mean rewriting the
  open items, which the issue ruled out.
- **A `person_notify_channels` table.** It would need its own backup and
  restore plumbing in `packages/backup`, where a setting is carried whole;
  this follows ADR 0032's one-setting shape for roles, and the secrets are
  carried as the install's.
- **A channel per role.** An admin would set one channel per role, and
  everyone on it would get every item for the role; the person who chose
  this design chose a channel per person.
- **Falling back to the install's channel for a member with no channel of
  their own.** The shared channel would then reach everyone on it, which is
  what routing is for not doing.
- **Matching a question's role by id.** Bots never see a custom role's id,
  and asking them to would put an install's internals in every skill.

## What would make this worth revisiting

People asking to switch kinds of notification off for themselves, rather than
for the install: that would need per-person switches beside `personNotify`.
Or many more people than one setting row comfortably holds, at which point a
table with its own backup carriage would pay for itself.
