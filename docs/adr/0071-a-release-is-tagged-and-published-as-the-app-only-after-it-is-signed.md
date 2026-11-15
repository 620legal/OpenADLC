# 0071. A release is tagged and published as the app only after it is signed

- **Status:** accepted
- **Date:** 2026-11-15

## Context

ADR 0068 has a release build one pinned default-branch commit in its own
account, and sign only fields hostd computes. ADR 0069 fixes what is signed:
the tag, version, sha256 and the artifact's download URL. ADR 0070 keeps the
built artifact and its `run.json` under hostd's work root. That leaves the
steps after a run is `built`: sign it, upload it, tag the commit and publish
the release (#344).

One fact shapes the order. The signature covers the asset's download URL, and
GitHub gives an asset its final URL
(`https://github.com/<owner>/<repo>/releases/download/<tag>/<name>`) only
once the release is published. While the release is a draft, the URL holds
an `untagged-…` path instead. Publishing creates the tag, and the issue
allows the tag only after the build and the signing have succeeded.

The issue also says the release is made as the app, with its installation
token and no new credential, and that a bot never triggers it.

## Decision

A built run is published by `ReleasePublisher` (`apps/bridge/src/release-publish.ts`), in this order:

0. **A preflight that writes nothing.**
   - The app has a client on the source repository and on the release repository.
   - No tag ruleset blocks the app (`tagCreationBlockers`).
   - `v<version>` is either free, or already on the pinned SHA. A tag on any
     other commit is refused, with "raise the version".
   - No release of the tag has been published yet.
1. **A draft release** in the release repository. Its `target_commitish` is
   the pinned SHA, or the release repository's default branch when that is
   another repository.
2. **The artifact**, streamed from hostd's own copy. It must come back
   `uploaded`, with the size hostd recorded and, where GitHub gives one, a
   `sha256:` digest that matches.
3. **The URL**, built from the uploaded asset's name as GitHub returned it,
   which may differ from the name sent, and from the release repository's
   canonical `full_name`. Nothing the release account printed is in it.
4. **Signed in hostd**, through `POST /release/runs/:id/sign`. hostd is given
   only that URL.
   - hostd takes the repository, version and sha256 from its own `run.json`.
   - It hashes its kept file again, and refuses one that changed.
   - A run is signed under one URL only: the same URL again answers the same
     signature, and another URL is refused.
   - The key is still read only in `release-sign.ts`.
5. **The manifest asset**, under the repository's `release_manifest_asset`
   (an admin's setting; null means `manifest.json`).
6. **The tag** `v<version>`, created as the app on the row's pinned SHA. The
   default branch's head is never read in the source repository. With a
   separate release repository, a tag of the same name is also made there, on
   that repository's default branch, because a release needs a tag in its own
   repository and the built commit is not in it.
7. **Published**, with `make_latest`.
8. **Read back.** GitHub's published `browser_download_url` must be the URL
   that was signed. On a mismatch the release goes back to a draft and is
   deleted, and the run fails, naming both URLs.

**Only the app's client is used.** The publisher uses `AppGate.client` and
never `deployClient`, whose fallback is the automation account.

**Only `ReleaseService` calls `publish`.**
- `record()` starts the publish when it stores a `built` report.
- `sweep()` publishes a `built` row that no publisher holds.
- A `publishing` row that no publisher holds (the bridge restarted) is
  cleaned up and failed.

There is no route to the publish, so only a run started by #345's route,
behind the Approves check and the device-code proof, is ever published.

**One release is in flight per repository** until it is published or has
failed. `release_runs_one_in_flight` covers `running`, `built` and
`publishing`, and `inFlight().releases` counts the same states.

**A failure ends the row `publish_failed`**, with a reason that names what
was left:
- the draft is deleted, or the reason names it to delete;
- once the tag is made, the reason says "`v1.4.0` is on `abc1234` in `owner/repo`. Cutting the same commit again reuses it. To build another commit, raise the version, or delete the tag at …";
- a public release that cannot be taken back to a draft is named, with "delete it there".

**The `release-tag-rules` health card** says when an active tag ruleset with a
`creation` rule covers the likely next tag and the app's
`current_user_can_bypass` is not `always`. It names the ruleset, links its
page, and clears itself once the app is added as a bypass actor. A missing
`current_user_can_bypass` is no answer, never "fine". The publish's preflight
refuses with the same words.

## What this rules out

- **Publishing first, then signing the real URL** (as a prerelease or a
  published release). The tag would exist before the signature, which the
  issue rules out, and a release would be public without its manifest.
- **Creating the tag before the draft.** A signing or upload failure would
  leave a tag on a commit with no release.
- **Signing in the bridge with fields from its row.** The key would leave
  `release-sign.ts`'s process, and the bridge's row is not the record ADR
  0068 makes authoritative.
- **`deployClient`.** Its automation-account fallback would publish under a
  second credential.
- **A route to retry a publish.** A person cuts the release again, which
  reuses a tag already on the same SHA.
- **A tag prefix setting.** The tag is always `v<version>`.

## What would make this worth revisiting

- GitHub giving a draft's asset its final download URL, or letting a release
  be published without creating its tag. Either would remove the need to
  build the URL and verify it afterwards.
- A client that verifies the manifest without the URL. The URL could then
  leave the signed message (ADR 0069), and the order could change with it.
- A repository that ships by release (`testing.on: release`) and also
  publishes to a separate release repository. Shipping by release reads the
  source repository's releases, and with a separate release repository that
  repository gets only the tag.
