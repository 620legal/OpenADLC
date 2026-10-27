# 0014. The bots' image is stamped with its recipe, and rebuilt when a release changes it

- **Status:** accepted
- **Date:** 2026-10-27

## Context

#194: a release added uv to `infra/local/Dockerfile.bot`. After a cloud
install updated, its bots' image still had no uv, and a Python repository's
tasks could not run `make setup`.

The image was rebuilt only by an engine update, and an engine update built
only when a tool had a newer version old enough to take. With nothing newer,
Update all now ended `current` and built nothing. This time the image picked
up uv the same day only because Claude Code, Codex and Grok all had versions
due. A cloud host gives a person no shell to run `build-bot-image.sh`, and
Settings → System said the image was "kept current by the engine updates",
which was not true of its recipe.

## Decision

- **The label.** `infra/local/build-bot-image.sh` stamps the image with
  `openadlc.recipe`, beside `openadlc.engines`.
- **What the recipe is.** The value is `sha256:<hex>` over `<name> <sha256>`
  lines for `build-bot-image.sh`, `Dockerfile.bot`, `bot-init` and
  `openadlc-install` (`RECIPE_FILES`). That is every file the build reads,
  including the two `Dockerfile.bot` copies into the image. A file the
  Dockerfile starts copying joins the list: `tests/images.test.ts` fails
  otherwise.
- **One place computes the digest.** The script does
  (`--recipe-digest`). hostd asks it at every status and every run, and never
  keeps the answer, because a checkout's files change under a running hostd.
- **When an image is behind.** hostd's `GET /engines/update` reports
  `recipe: { current, built, behind }`. An image is behind when it exists,
  the current digest is known, and its label differs from that digest. A
  missing label counts as behind.
- **A behind image is rebuilt with the same pins.** On a behind image, an
  engine update with nothing newer is not `current`. It builds a candidate
  from the current recipe with every tool pinned to the version in use, and
  gh copied from `latest`. It proves the candidate as any candidate is
  proved, then swaps it in. The result is `updated` with `rebuilt: true`, and
  `to` equal to `from`. If the image does not say which version of an engine,
  Node or gh it has, the run fails without building rather than let that tool
  float. A rebuild does not clear a rollback's hold.
- **The bridge starts the run itself, once per digest.** Its engines tick
  starts a run with trigger `release`, actor `openadlc` and `only: []` when
  hostd says the image is behind and the digest is not the one stored in
  `engineRecipeRebuilt`. The digest is stored once hostd takes the run. A
  held or refused start tries again at the next look. A failed run is not
  retried by itself, only by the next recipe change or a person's Update all
  now. `engineRecipeRebuilt` is a runtime setting, left out of backups.

## What this rules out

- **A digest of `Dockerfile.bot` and the script alone.** A release that
  changed `bot-init` would leave the same gap.
- **Keying "once" on the release commit.** That would rebuild the image on
  every release, even one that changes nothing in it.
- **A separate rebuild route.** A rebuild is an engine update that moves
  nothing. Kept as one, it shares the single-run lock, the history, the
  proof and the rollback.
- **Rebuilding without pins.** That would float every tool to whatever is
  newest that day, which is a change nobody made.
- **Rebuilding under the local driver, or an image pinned to a tag this
  install does not build.**

## What would make this worth revisiting

- The recipe coming to depend on more than its files. If the Debian packages
  or uv that `Dockerfile.bot` resolves at build time came to matter between
  releases, a digest over the files would miss the change.
- The bots' image starting to ship with a release. If it did, there would be
  no host build to keep in step.
