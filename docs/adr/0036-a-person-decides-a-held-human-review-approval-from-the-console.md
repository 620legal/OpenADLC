# 0036. A person decides a held Human-review approval from the console

- **Status:** accepted
- **Date:** 2026-11-10

## Context

A crew pull request that changes a path `AGENTS.md`'s `## Human review` names
a person for waits on that person's approval of its head once the lead's
approval counts. Needs you already raised a card for it (`approval:…`, and
`approve-again:…` after a push). Its only button was "Review it on GitHub".
The owner asked for explicit Approve, Reject and Discuss buttons on that card,
with a plain description of the decision, so the person can answer it without
going to GitHub (#254).

The merge gate (`mergeDecision`, `apps/bridge/src/automation.ts`) counts a
named person only through a GitHub `APPROVED` review from their own login. The
review must be on the head, or on an earlier head with the same diff, and from
an account with write access. That file is under Human review itself. ADR 0018
already lets a console person post one thing from their own account, through a
device-flow token that is used once and never kept. #251 (ADR 0034) pins each
person's GitHub account by id, set only by their own sign-in.

## Decision

The same two Needs-you items carry a `decision`. It holds:
- what the change does, from the issue's Outcome;
- why the person is asked, the paths and the rule that names them;
- what the crew's reviewers found, recorded with the wait as `reviews` on `review.person_awaited`, so reading Needs you makes no GitHub call;
- the diff link;
- what each button does next.

`GET /v1/attention` adds, for the viewer only, whether the decision is theirs (`yours`), and why not.

- **Approve** is the person's own GitHub review. It is an `APPROVE` review
  with `commit_id` set to the head they saw, posted with the ADR 0018 one-post
  token. It is posted only if the account that approved the device code is
  the account linked to the console person, is not a crew account, and the
  head has not moved meanwhile. `mergeDecision` is unchanged, and counts it
  exactly as it counts a review submitted on GitHub, the same-diff rule
  included. The `pull_request_review` delivery clears the card, as it does
  for a review made on GitHub.
- **Reject** takes no sign-in. The bridge checks that the console person's
  linked account id is the awaited login's id. It requires a reason that is
  not empty, posts the reason as the app, writes `pull.human_review_rejected`,
  and calls `SendBack.reviewRound` with `by: '@login'`. That is the call a
  person's request for changes on GitHub makes. It happens once per head; the
  audit row is the guard.
- **Discuss** is the item's message box (`POST /v1/items/:subject/messages`).
  It goes to the lead reviewer by default, or to the builder, and starts that
  role's work through `MessageStarts`. It carries
  `about: {kind: 'human_review', …}`, so the route writes
  `pull.human_review_discussed`. It decides nothing.

Approve and Reject are refused by the bridge in each of these cases:
- 403 when the viewer is not the person;
- 409, with a link to Settings, when the viewer has linked no account;
- 409, "reload", when the head moved or the wait no longer stands.

The console leaving the buttons out for anyone else is a courtesy, not the check.

## What this rules out

- **Recording a console approval in the bridge and counting it in
  `mergeDecision`.** It would need no device code. But it changes the merge
  gate, a Human review path. A reader of GitHub would also never see the
  approval, so "approving from the console and from GitHub mean the same
  thing" would not hold.
- **Posting Reject as a `REQUEST_CHANGES` review through the device flow.** It
  costs a sign-in for something that grants no new authority: a console person
  could already send work back by messaging the builder.
- **Discuss as a plain comment that starts nothing.** A person who chooses
  Discuss expects an answer. The owner chose a review run over a note nobody
  answers.
- **Matching the person by login.** A login can be renamed and then taken by
  someone else. The account id is the pin, as in ADR 0034.
- **Keeping the token for a second decision.** ADR 0018 holds: the token posts
  one review and is revoked.

## What would make this worth revisiting

- GitHub letting an app record a review on a person's behalf that its rulesets
  count as theirs.
- `mergeDecision` coming to count something other than a GitHub review from
  the named person.
- People wanting several held approvals decided in one sign-in. Each Approve
  is one code today.
