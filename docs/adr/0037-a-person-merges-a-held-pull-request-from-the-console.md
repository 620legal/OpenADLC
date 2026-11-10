# 0037. A person merges a held pull request from the console

- **Status:** accepted
- **Date:** 2026-11-10

## Context

The merge line holds a pull request for a person when `mergeDecision` refuses
to land it. Before this, the hold's Needs-you card offered only "Merge it on
GitHub". The owner asked for an explicit decision instead: Merge, Leave it and
Discuss on a held merge, and Release, Keep holding and Discuss on a held
promote, each with what it does next (#255).

Two constraints come from the owner:
- Merge is offered only when the hold is not a failed or missing required
  check.
- Merge never stands in for a named person's Human-review approval, which is
  decided on its own card (ADR 0036).

The merge line records only `mergeDecision`'s *first* reason. Several holds
return before the Human review approvals are checked: a change to how CI runs
that a person merges, `needs-human`, a crew pull request with no lease. So the
stored reason alone cannot show that a named person's approval is in place. A
Merge offered from it could land a change to `.github/workflows/` without the
approval `AGENTS.md` asks for.

## Decision

**A console Merge is the person's own merge.** It is
`PUT /repos/{repo}/pulls/{n}/merge`, sent with `sha` set to the head the card
showed and `merge_method: squash`, as the merge line merges. It uses ADR
0018's one-post device token, posted by the account linked to the console
person (#251), and the token is revoked after. The app never merges on a
person's say, and only the merge line merges as the app.

**Every unmet rule has a kind.** `mergeBlockers(facts)` in
`apps/bridge/src/automation.ts` runs every rule `mergeDecision` runs, in the
same order and with the same words, without stopping at the first. Each unmet
rule gets a kind:
- `person`: a hold a person may decide;
- `check`: a required check;
- `review`: a crew review, a request for changes, or a request taken away;
- `human_review`: a login `AGENTS.md`'s Human review names;
- `unknown`: something that could not be read;
- `github`: something GitHub will not merge;
- `outside`: a head or base the line does not land;
- `scope`: files outside a crew lease.

A person may merge only over `person`. `mergeDecision` is not edited. A parity
test (`automation.test.ts`) holds `mergeBlockers(f)[0].reason` to
`mergeDecision(f).reason` for one fixture per refusal. The live press also
fails closed: if `mergeDecision` refuses and `mergeBlockers` finds nothing,
the press refuses.

The `person` holds are:
- `needs-human` or `openadlc:paused`;
- GitHub's `behind`, or `blocked` with no cause OpenADLC can name;
- a crew pull request that closes no issue, or has no lease;
- a change to how CI runs when a person merges those here, no security seat
  is set up, or signatures cannot be checked;
- seats on a shared account, or a seat's approval of this diff, when nothing
  here can check a signature.

An approval that fails a signature check that *can* run is `review`: it may be
a forgery (`docs/runbooks/unsigned-post.md`). Three merge-line holds also
count as `person`: auto-merge off, GitHub not read in full, and the app with
no token.

`personMayMergeOver(reason)` reads the stored first reason, with no GitHub
call, so the card can decide whether to offer Merge. It is an allowlist that
fails closed.

**The rules are checked again on the current head, twice.** The bridge rereads
`mergeFacts` when Merge is pressed and again once the code is approved. On any
non-`person` blocker it merges nothing and writes `pull.person_merge_refused`,
and the card offers no Merge on that head again. The press is also refused
when:
- the linked account cannot write to the repository, as GitHub's
  `collaborators/{login}/permission` says, cached ten minutes;
- the account is a crew account;
- the head moved since the person looked.

GitHub's own branch rules apply after all of these. A refusal from GitHub is
shown in GitHub's words (`pull.person_merge_failed`).

**The card never offers Merge while a Human-review approval is awaited**
(an `approval:` or `approve-again:` item stands). It says whose approval it
waits for.

**Leave it and Keep holding are install-wide acknowledgements**
(`acknowledgements`, ADR 0031), posted to `POST /v1/attention/leave` with only
the item id. The bridge works out the occurrence itself:
- for a held merge, the head, a digest of the reason, and the newest
  `REVIEW_SUBMITTED_ON` event;
- for a held promote, the sha.

So the card comes back when any of those changes. Only an item in the viewer's
own Needs you can be left. No migration.

**Discuss** is ADR 0036's message to the lead reviewer or the builder.
`about.kind` `held_merge` or `held_promote` audits it as
`pull.held_merge_discussed` or `deploy.promote_discussed`.

## What this rules out

- **Judging from the stored reason alone.** It needs no reserved file. But to
  be safe it must withhold Merge on every hold that returns early, which are
  the commonest holds a person merges (CI changes, `needs-human`). The owner
  chose against it.
- **Recording the blockers in `merge-line.ts` when the hold is set.** That is a
  second reserved file, and the list would be stale by the time a person
  presses Merge, so the press would recompute it anyway.
- **The app merging on a person's say.** The issue rules it out. It would also
  blur "only the merge line merges as the app".
- **Per-viewer dismissal.** It needs a new table and a migration. Every other
  dismissal here (the design-memory notice, health cards) is install-wide.

## What would make this worth revisiting

- A new refusal in `mergeDecision`. The parity test fails until
  `mergeBlockers` gives it a kind, and a person must not be let merge over it
  by default.
- GitHub letting the app merge on a person's behalf with their identity
  recorded. The one-post token would then not be needed.
- People wanting a Leave it that hides a card only for themselves. That needs
  per-viewer acknowledgements.
