# 0046. A sent-back card is read from its newest move and its patch wait

- **Status:** accepted
- **Date:** 2026-11-10

## Context

On 2026-11-09 a managed repository's issue sat in Build for 21 hours. Its pull request had been sent back and no builder round was running on it. The card said only "Leased to the builder · held for pull request #N · sent back ×1", and Needs you had nothing.

- `holdOf` (`apps/bridge/src/waiting.ts`) returned the lease hold first. The `leased` reason is never stuck, so `stuckItems` (`attention.ts`) never raised it.
- The send-back's reason never reached the card. It was kept only in `stage_moves`, which the builder's round reads as `sent-back.md`.
- Start it now asked the dispatcher. The dispatcher never starts an issue a lease holds (#153), and a lease holding a pull request never expires (`expireStaleLeases`), rightly.
- The lease comment said "until 08:49", a time that stops applying once a pull request holds the lease.

ADR 0044 made a round a busy builder turned away wait on the builder's seat (`patch.round_waiting`). The card did not say that either.

## Decision

- **The send-back is the issue's newest `stage_moves` row, and only one into Build from Review.** It must be of kind `send_back` or `person`. `stageMoves.newestMoves` reads every held lease's issue in one query, served by `stage_moves_issue`. Any later move replaces it, so a card that left Build and came back another way shows nothing old. There is no new record: the card and `sent-back.md` read the same row.
  - `SendBackFacts` carries `by`, `kind`, `at`, `pr`, `words` and `reason`. `by` is `openadlc` for CI or the merge line, a seat's name for the lead, and a login for a person. `words` is the reason's first line, without links, at most 160 characters. `reason` is the whole reason, at most 600 characters.
- **A Build card whose lease holds its open pull request, with a send-back, waits as `sent_back`, not `leased`.** Its round is `waiting` while #273's `patch.round_waiting` stands for the pull request, with `on` from the wait's `busyWith`. Otherwise it is `not_started`.
  - A running, queued or question-paused round never reaches here: the card has work going, or a question open.
  - Without such a move the card stays `leased`, as before.
- **It is stuck only when nothing will start its round.** That means a `not_started` round, no `needs-human` or `do:human`, and longer than `STUCK_AFTER_MS` (3 minutes, the free-seat threshold) since the send-back or its last task's end, whichever is later. A waiting round is never stuck: the runner starts it when the builder has room.
- **Needs you raises it as a `work_stuck` item** ("No builder round has started on #P for N min"). The detail quotes the reason, and the first action is `start_work`, labelled **Start the builder round**. No item is raised while a stopped review, or a failed task not tried again, stands on the issue or its pull request: each of those already says what to do.
- **Start it now on a Build item whose lease holds a pull request opens the patch round** through `SendBack.startHeldRound`, never the dispatcher. A person's move from Review to Build (`backFromReview`) opens it the same way. The route, its role (`user`), its held-label refusal and its audit (`item.started`) do not change. Its `started` lines now say "started patch round N on #P", or that the round waits for the builder, and Needs you says that line.
- **The lease comment gives no expiry once a pull request holds the lease.** A lease going on from an open pull request says it holds until that pull request merges or closes. A fresh lease gives its time, in `HH:MM UTC`, as the deadline for a pull request to open.

## What this rules out

- **Extending `leased` with the send-back and the round.** `leased` is also the reason before a build starts and after a merge. Its card text, its `since` and its stuck rule would then branch on fields that are only sometimes there. A reason of its own keeps each line and each rule one case.
- **A `send_back.recorded` event written at send-back time.** It would duplicate `stage_moves`, and give a second record that can disagree with what `sent-back.md` tells the builder.
- **A separate `POST …/patch-round` route.** It would need a new role entry, a new action kind and a new console button, for what Start it now already means on a card: start what this card waits for.
- **A dispatcher change.** A lease holding an open pull request must keep holding it. A fresh build beside an open pull request is the failure the lease exists to prevent.

## What would make this worth revisiting

- A send-back that is not a stage move: for example, a round sent back while the card stays in Review. The card would then need a record other than `stage_moves`.
- Rounds that routinely take longer than three minutes to be queued after a send-back. That would raise false alarms, and want a threshold of their own for held cards.
