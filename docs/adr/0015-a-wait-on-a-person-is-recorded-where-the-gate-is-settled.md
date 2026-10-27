# 0015. A wait on a person is recorded where the gate is settled

- **Status:** accepted
- **Date:** 2026-10-27

## Context

A crew pull request that changes a path `AGENTS.md`'s Human review names
someone for waits on that person after the lead approves it: `review-gate`
reads `waiting on @<login>`. Needs you said nothing (#199). Its "waits for you
to merge it" card is made only for a pull request that is green at the front of
the merge line. A crew branch's CI runs only once the line asks for it, so a
pull request held on a person never gets there. Its "approval again" card is
made only when an earlier approval stops counting on the diff.

The bridge already works out everything the card needs in
`Automation.reviewStanding` each time it settles the gate: on a review delivery
(`onReview`) and on the gate sweep. Nothing wrote it down. Needs you reads only
the store, every fifteen seconds. `automation.ts` is a Human review path.

## Decision

What the review gate waits on reaches Needs you as an event, recorded where the
gate is settled, once for each head and person. The attention read never calls
`reviewStanding` or GitHub for it.

- `review.person_asked_again` was already recorded this way, for a person whose
  approval counts for nothing on the diff.
- `review.person_awaited` is new. Its payload is `{subjectRef, repo, pr, issue,
  login, head, paths}`. It is recorded once the lead's approval counts and the
  gate waits on `@login`, and only for a pull request with its own issue.
  `awaitPeople` in `task-service.ts` takes the people from what `reviewStanding`
  already returns: the `@login`s that `seatsWaitedOn` reads from the gate, less
  those in `peopleNotCounted`. The paths are the Human review rules that name
  the person and match a changed file.

Needs you shows the newest wait for each pull request and person until one of
these: that person gives a verdict (`review.submitted_on`), a newer
`review.round_opened` arrives, the issue leaves Review, or the pull request
closes. When both cards would apply to the same person and pull request, the
approve-again card wins. Both items carry `awaiting`, so the board card says the
same as Needs you.

## What this rules out

- **Reading the standing live in the attention read.** That means calling
  `reviewStanding` for every pull request in Review. Each call makes several
  GitHub reads on the automation token, every fifteen seconds. That is the cost
  `ClosedSubjects` exists to avoid.
- **Changing `reviewStanding` to return the awaited people and their paths.**
  It would be cleaner, but `automation.ts` is a Human review path that #199
  said not to change, and everything needed can be read from what it already
  returns.
- **Driving the card from the `review:human:<login>` labels.** They are set
  when the pull request opens, before the lead approves, so they cannot say
  "not before the lead".
- **A card on a person's own pull request** (one with no issue). The named
  person often wrote it themselves.

## What would make this worth revisiting

- `review-gate`'s description stops naming the people it waits on, or names
  them before the crew's seats have approved. `awaitedPeople` reads the people
  from those words, and checks the lead itself in case the order changes.
- More people are named than fit in the status's 140 characters. Today a name
  that is cut off gets no card until the list gets shorter.
- `reviewStanding` becomes cheap enough to read live. Then the event would be a
  copy kept for no reason.
