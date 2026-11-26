# 0084. A release's readiness is read, never pinned or started

- **Status:** accepted
- **Date:** 2026-11-26

## Context

Before #371, a setup problem with a release showed up only partway through a
build, in the run's log. Examples are a release account that can read the
install, a missing signing key, or a tag ruleset that stops the app. The
release page (#345, ADR 0072) now shows a checklist of what a cut needs, above
**Cut release**.

The checklist sits next to the most guarded path in the bridge:

- `ReleaseCuts` pins compare views, and a cut is built from one;
- `ReleaseService.start` has one caller, the cut's sign-in;
- the signing key is read only by hostd's signer (ADR 0069);
- the publisher tags and publishes as the app (ADR 0071).

A checklist that the page polls must not reach any of these, and must not
change what a cut does.

## Decision

- **Readiness is a read.** `GET /v1/repos/:name/release/readiness`, a `user`
  route like the other release reads, is answered by
  `apps/bridge/src/release-readiness.ts`. That module holds no release handle.
  Every dependency is a plain function. It imports the service, the cut's
  routes, the publisher and hostd's client as types only. It pins no view: a
  poll every minute would otherwise push the person's own view out of the five
  `VIEWS_PER_IDENTITY` keeps, and a cut from an evicted view is refused. It
  reads the default branch's head itself and asks the cut's own version read
  (`ReleaseCuts.version`, made public for this) at that SHA. Results are kept
  for 30 seconds per repository. Each item runs on its own with a 10-second
  timeout, so one read that fails is that item's "could not check", never the
  page's.
- **The signing key is known only by its ref being listed.**
  `hasReleaseSigningKey` in `packages/github/src/secrets.ts` compares the
  repository's ref with `store.list(prefix)` and never calls `get`. The key is
  never read, decrypted, loaded or hashed on this path. `releaseSigningKeyRef`
  is still named in three files only. The readiness module is given the
  answer as a function from `api.ts`, and does not name the store.
- **The tag check is the card's judgement.** The fourth item was first written
  as "release environment". A cut uses no GitHub environment and no Needs-you
  hold, so it was answered on #371 as the release tag instead. The item asks
  `judgeReleaseTag`, the `release-tag-rules` card's own logic
  (`health/checks/release-tag-rules.ts`), with the app's own client. It judges
  `v<version at the head>`, the tag the publish makes, or the card's likely
  next tag when the version cannot be read. It judges the source repository
  and the release repository if that is different.
- **The checklist only informs.** The console draws Cut release the same
  whatever the checklist says, and gives it nothing of the checklist. The last
  build is shown apart as "for information", and never counts toward ready.

## What this rules out

- **A read-only hostd route for key presence.** It would add a route and a
  client method for an answer the bridge can read from the same store by name
  alone. hostd's process boundary adds nothing, because `list` never reads a
  value.
- **Pinning a view to read the version.** That is what `POST …/views` does,
  but each poll would use up one of the person's five views, and a cut from an
  evicted view is refused.
- **Item 4 as the production environment.** A cut never reads it, so a pass or
  fail there would say nothing about whether a cut gets through.
- **Disabling Cut release on a failing item.** The checklist can be stale or
  unable to check. The cut's own checks, and hostd's, stay the authority.
- **Looking in the release account's home for a left-over build tree.** hostd
  never stats a path there (`release-run.ts`). The last build item says what a
  failed run leaves from the run's row alone.

## What would make this worth revisiting

- A cut that starts using a GitHub environment or a Needs-you hold: the
  checklist would then need to check it.
- A secret store whose `list` reads values: the presence check would then read
  the key.
- Readiness needing something only a pinned view holds: it would then need a
  way to read without spending a person's view.
