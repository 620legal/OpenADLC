# 0057. A held approval says why it came to the approvers, and anyone may remind the person

- **Status:** accepted
- **Date:** 2026-11-11

## Context

A crew pull request that changes a path AGENTS.md's Human review names someone
for waits on that person's approval. On a cloud install its Needs-you card goes
to them when someone in People has their GitHub login. When no one does,
`kindAudience` hands it to the approvers, and before this decision the card
said only "For approvers". No approver can decide it: Approve and Reject are
the named person's
([ADR 0036](0036-a-person-decides-a-held-human-review-approval-from-the-console.md)).
OpenADLC itself never reached the person. On one install such a card sat for
six hours with no one able to act on it (#307).

The card can also show whether GitHub has a review request out to the person,
but [ADR 0036](0036-a-person-decides-a-held-human-review-approval-from-the-console.md)
and [ADR 0015](0015-a-wait-on-a-person-is-recorded-where-the-gate-is-settled.md) keep `GET /v1/attention`
from reading GitHub live.

## Decision

- **The audience says who is missing.** `Audience.notInPeople` carries the
  awaited login whenever a held approval falls back, to the approvers or, when
  no one approves, to everyone. It is not set when People could not be read at
  all (`unread: 'none'`): then OpenADLC cannot say who is missing. With
  `unread: 'last'` it comes from the last read that worked, like the rest of
  that audience. The card says "@x is not in People, so this came to the
  approvers.", and an admin also gets a link to `/settings#people`.
- **The card reads GitHub's request on its own route.**
  `GET /v1/items/:subject/pull/human-review/request?login=` reads the pull
  request's timeline (`reviewRequestOf`): the newest `review_requested` of the
  login, unless a `review_request_removed` of them or a review by them came
  after it. It is kept for 60 s per `repo#pr@login`. The attention read still
  makes no GitHub call.
- **Remind re-requests the review.**
  `POST /v1/items/:subject/pull/human-review/remind` has role `user`, so anyone
  the card reaches can press it, and it decides nothing.
  - It asks GitHub as the automation account. When a request is pending,
    `removeReviewRequest` runs first and then `requestReviewers`, because GitHub
    notifies a reviewer only when it requests them.
  - It runs once an hour per pull request and person, from anyone. A second
    Remind within the hour answers 429 with `remindAfter`.
  - It is audited as `pull.human_review_reminded` on target `repo#pr@login`,
    and that row is the throttle.
  - A refusal from GitHub writes no row and throttles nothing.

## What this rules out

- **Reading the request in `GET /v1/attention`.** That is one timeline read
  per held approval, per viewer, on every refresh. It would also undo ADR
  0036's "reading Needs you makes no GitHub call".
- **Recording `review_requested` deliveries as events.** That needs the
  webhook, and it would miss every request made before it shipped. A cached
  read answers "as read from the pull request" directly.
- **Reminding with an `@login` comment as the app.** It adds noise to the pull
  request and leaves GitHub's review list as it was.
- **Throttling per presser.** Ten approvers could then send ten requests in
  the same hour.
- **Letting an approver decide on the person's behalf, or pushing a
  notification to them.** Who decides is unchanged, and someone not in People
  has no device OpenADLC knows of.

## What would make this worth revisiting

- If GitHub notified an already-requested reviewer on a repeated request, the
  removal would be needless.
- If OpenADLC came to record review requests from the webhook, the card could
  read them from the database instead.
- If the person could be reached some other way than GitHub's request (a
  People entry made from the card, say), Remind might not be needed.
