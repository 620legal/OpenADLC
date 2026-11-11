# 0059. The admins are told when a held approval's person is not in People

- **Status:** accepted
- **Date:** 2026-11-11

## Context

A held Human-review approval goes to its named person when someone in People
has their GitHub login. When no one does, ADR 0057 routed it to the approvers,
with `audience.notInPeople` saying why. ADR 0058 then put it under the
approvers' Waiting on others, not counted and not pushed, because none of them
can decide it.

So nobody was told. An admin who does not approve never saw the card. The
approval waited until someone happened to open Needs you. The only thing that
moves it is adding the person to People, and only an admin can do that.

The owner's rule from #308 is "the badge counts only what you can act on". For
an admin, adding the person is something they can act on. The owner chose the
admins plus the approvers as the audience (#313).

## Decision

- **The audience is the admins and the approvers.** `kindAudience`'s fallback
  for a held approval whose login is not in People is `for: 'approvers'`,
  `name: 'admins and approvers'`. Its `people` are the admins and the
  approvers together, without duplicates. `Audience.admins` lists the admin
  ids among them, and `notInPeople` names the login. With nobody in either
  group it is everyone, with `notInPeople` and without `admins`. `for` stays
  `approvers`: `notInPeople` already marks the case, so no `switch` on
  `AudienceFor` changes. Amends ADR 0057's fallback.
- **An admin's copy is theirs.** `forViewer` takes the router's console role.
  For an admin on a `notInPeople` decision that is not theirs, it sets
  `decision.addToPeople: true` and never `waitsOnOther`, whatever `mayDecide`
  answered. So the item counts in Work and the header's badge. Its card leads
  with **Add @x to People so this goes to them**, a link to Settings → People,
  then Remind and Discuss. It reads "Why it waits:", because the admin is not
  asked to approve. A non-admin approver keeps ADR 0058's treatment.
- **The admins are pushed once, under a key of their own.** `WaitingNotices`
  sends such an item to `audience.admins` only, with the text "@x is not in
  People, so pull request #N waits with no one to approve it. Add them in
  Settings → People." It is recorded as `notify.merge_waiting` with
  `item: '<id>@<since>#not-in-people'`. The occurrence's own key stays free, so
  once the person is in People and the audience is `person`, they are pushed
  as before. The baseline and the unread checks come first, as for every
  item. Amends ADR 0058's "not pushed to people who cannot decide it", which
  now has this exception for the admins.
- A local install routes nothing, and is unchanged.

## What this rules out

- **A new `AudienceFor` value (`admins_and_approvers`).** Every `switch` on
  `for` in both apps would need a case, for nothing `notInPeople` does not
  already say.
- **The console deciding the admin's treatment from `useRole()` and
  `audience.notInPeople`.** The bridge sets `waitsOnOther`, which drives the
  count. Splitting the rule between the bridge and the console would let the
  count and the button drift apart, so the bridge says it once, with
  `addToPeople`.
- **Recording the admins' push under the occurrence's key.** The person would
  then never be pushed once they are added.
- **Editing ADR 0058.** A record is written once (`docs/adr/README.md`). This
  one amends it.

## What would make this worth revisiting

The person could be reached some other way than through People: OpenADLC
learns a login's devices or email without a People entry. The admins would
then not be the only way to move it, and the approval could go to the person
directly.

After an upgrade, the admins get one push for each such approval that was
already waiting after the install's first look, since nobody was told about
them before. If that turns out to be noisy on installs with many, the push
needs a baseline of its own.
