# 0073. A lease is never held for a closed pull request

- **Status:** accepted
- **Date:** 2026-11-15

## Context

A lease linked to a pull request has no expiry. It waits for the pull
request, and the pull request's close (`releaseForPullRequest`) or the end of
the verification after its merge lets it go. `issues.pr_number` is never
cleared: merge history, `startHeldRound` and the card read it.

On OpenADLC#329 (2026-11-14/15), #334 closed unmerged and its lease was
released. The issue was leased again, and the builder's task paused on a
question while the card was still in Review, naming #334. When that task
ended, `settlePausedLeases` adopted the issue's number while the issue was in
review, and put the lease back in task on closed #334 with no expiry. Nothing
let it go after that. The close had already happened, `expireStaleLeases`
skips a null expiry, and reconcile said nothing had drifted. A person moved
the card from Review back to Build, and `openHeldRound` refused with "#334 is
closed", in bridge.log only. The dispatcher starts nothing on an issue a lease
holds (#153), so the card sat in Build with nothing running and nothing to
say why.

The database has no reliable record of a pull request's state.
`work_item_links` is filled only on an install whose work is numbered, and
`merge_lines` records only what the line merged.

## Decision

**A lease is never linked to, or put back in a task for, a pull request that
is closed.** A pull request counts as closed when it is closed unmerged, or
merged while its issue is not in Merged. A merged pull request whose issue is
in Merged is the hold for the verification after the merge. That hold is
unchanged: its own release and the reconciler's one-day backstop end it.

**Where closed is read from.** `settlePausedLeases` takes an optional
`pullOpen(repoId, prNumber)`, which the bridge builds from the automation
account's read of GitHub (`pullOpenReader`, `apps/bridge/src/task-service.ts`).
It is used at a task's end, at the task service's stops, and in the
reconciler's sweep. `work_item_links` (`closed` or `merged`) and `merge_lines`
(`merged`) count too, and when one of them already says closed, GitHub is not
asked. The settle reads its candidates, asks once for each pull request, then
writes in one statement that checks again that each lease is paused and has
nothing unfinished under it. A closed pull request is treated as none:

- If the last task finished, the lease is held in task with no link, until
  `holdUntil`.
- Otherwise it is released, keeping the lease's own number as history.

The audit's `closedPull` names the pull request that was set aside.

**An unknown state keeps today's adoption.** That covers no reader, GitHub
not answering, and no local record. If a lease whose pull request is in fact
open were released, its patch round and QA would find no lease. The
reconciler sweeps up a lease left this way. It names each active lease's pull
request for its GitHub read. An active lease whose issue is open and not in
Merged or Done, linked to a pull request it read as closed, is released with
`releaseForClosedPull`. That is one audited statement, and it runs only while
the lease is still on that pull request with no task queued, running or
paused under it. The release is reported as drift `lease_on_closed_pull`.
This is the only case where the rule depends on the sweep rather than on the
settle itself.

**A person's move from Review back to Build with a closed pull request lets
the lease go** (`SendBack.fromPerson`). The move reads the pull request once.
If it is closed, no patch round opens. Instead `releaseUnlessWorkedUnder`
lets go of the lease, audited as the person's `lease.released`, and the
dispatch the move already asks for starts a fresh build. That build is
briefed from the move just recorded (`sent-back.md`). A task still under the
lease, such as a build paused on a question, is the build, and keeps it.

**A move back to Build that still starts no round records `review.stalled`**
with the reason, once for each head. The board shows it on the card as a
stopped review. Needs you's Start the builder round still answers the person
who pressed it.

hostd's `cancel` is deliberately unchanged. hostd has no GitHub client, so it
has only the local evidence, and the reconciler covers it.

## What this rules out

- **A column or table recording each pull request's state.** It would be a
  schema change for something GitHub already answers. It would need
  backfilling, and it would drift whenever a webhook was lost, which is the
  drift this decision is about.
- **Never adopting `issues.pr_number` in the settle.** The adoption exists
  because the lease's own link is best-effort: a lost webhook, or the
  scheduler's recovery writing only the issue. Without it, leases whose pull
  request is open would be released, and patch rounds would find nothing.
- **Clearing `issues.pr_number` when a pull request closes.** Merge history,
  `startHeldRound` and the card depend on it never being cleared, and clearing
  it would not free a lease already stuck.
- **Releasing on an unknown state.** That would strand an open pull request's
  patch round whenever GitHub is briefly unreadable.

## What would make this worth revisiting

The database coming to hold every pull request's state reliably, for example
`work_item_links` on every install with no lost closes. The settle could then
decide from it alone, and the reconciler's sweep would become a backstop
rather than the answer for an unknown state.
