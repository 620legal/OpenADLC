# 0018. A sign-off is posted with a token kept for one post

- **Status:** accepted
- **Date:** 2026-10-29

## Context

620legal/www's `visual-review` check stays red until the page reviewer
comments `/approve-pages` on the pull request, and `visual-signoff.mjs` counts
only that reviewer's own comment. Needs you offered "Merge it on GitHub",
which skips the sign-off, and the person had to open GitHub to comment
`/preview`, read the preview's address and the screenshots, and comment
`/approve-pages` (#207).

Posting `/approve-pages` from the console means posting as a person's own
GitHub account. OpenADLC's GitHub App asks for `administration: write` and
`pull_requests: write`, so a user token of the app, held for an owner such as
@orzelig, could approve pull requests and edit rulesets as that person. A
person chose, in the design, how a sign-off reaches GitHub.

## Decision

- A reviewer-only pull-request command is posted with a device-flow user
  token held for that one post. At each press the person approves a fresh
  code. The bridge checks the approving account is the one linked to them and
  is no crew login, posts the declared comment exactly, on exactly that pull
  request, and revokes the token with the app's client secret. The token is
  never written to the database, the secret store, a log, an audit row, a
  response or an error. Without a client secret it expires on GitHub after 8
  hours.
- A console person's GitHub account is proved by their own sign-in, in
  Settings, and kept as a login and an id only (`person_github_accounts`). An
  admin never sets it. A crew login is refused, and one account belongs to one
  person. A reviewer-only command is offered only to the person whose linked
  account is one of its reviewers.
- A command anyone may send (`/preview`) is posted as the app's installation,
  with exactly the declared text.

## What this rules out

- **Keeping the reviewer's refresh token** in the secret store, so a sign-off
  needs no code. The person chose against it: the stored token would act as an
  owner with the app's administration and pull-request rights for six months.
- **www accepting a sign-off OpenADLC records** (the app posts or sets it).
  That holds no person's credential, but it changes `visual-signoff.mjs`,
  which is out of scope, and the console would still need a mapping from a
  person to a GitHub login.
- **A per-person personal access token.** `docs/security.md` says OpenADLC never
  asks for one.
- **Showing the reviewer's button to everyone and letting the device flow
  decide.** The issue asks that it be offered only to the person mapped to the
  reviewer.
- **An admin mapping people to GitHub logins by hand.** The mapping is proved
  by the person's own sign-in instead.
- **Posting `/preview` as the automation account.** A crew post is signed,
  which changes the text, and an unsigned one is an `unattributed-post` card.
- **Storing the screenshots as the item's attachments.** Every head brings a
  new set and fills the item's room. They are read through the bridge on
  demand, with a bounded in-memory cache.

## What would make this worth revisiting

- GitHub letting an app ask a person for a token narrower than the app's own
  permissions, such as comment-only. A kept token would then cost little, and a
  sign-off could skip the code.
- www, or another repository, accepting a sign-off the app records. The
  person's own account would then not be needed at all.
- Reviewers finding a code at every sign-off too slow to use, so that they go
  back to GitHub.
