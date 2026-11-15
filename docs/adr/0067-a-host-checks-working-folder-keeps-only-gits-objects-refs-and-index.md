# 0067. A host check's working folder keeps only git's objects, refs and index

- **Status:** accepted
- **Date:** 2026-11-15

## Context

A host check's account keeps one working folder per repository between runs,
so a build can be incremental
([ADR 0064](0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md)).
Each run's build is a pull request's own code. It runs as that account and can
write anything in the folder, the folder's `.git` included. The next run's
fetch and checkout then run git in that folder, for any repository, because
they all share the one account (#337).

ADR 0064 turned off what git reads from outside the folder:
`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
`core.hooksPath=/dev/null` and `core.fsmonitor=false`. Git still read the
folder's own `.git/config`. A `filter.<name>.smudge` an earlier run wrote there,
with `* filter=<name>` in `.git/info/attributes`, ran at the next checkout.

Git has no switch that stops it reading a repository's own config.
`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` cover only the global and system
files. Git also reads config from other places an earlier run can write:

- A `.git` that is a file (`gitdir: /elsewhere`) or a symlink moves the whole
  repository elsewhere. `[ -d .git ] || git init` then re-initialised
  `/elsewhere` without overwriting its config.
- `.git/commondir` makes git read its config, and more, from another directory.
- `config.worktree`, `worktrees/`, `modules/` and `objects/info/alternates` are
  read when the config or the layout points at them.

## Decision

`RECEIVE` (`apps/hostd/src/host-check.ts`) cleans the folder's `.git` from a
keep-list before every fetch. It does not remove a list of known-bad paths.

1. A `.git` that is a symlink, or that exists and is not a directory, is
   removed (`rm -rf`, which does not follow the link). The folder starts a
   fresh repository, and hostd's fallback to the full bundle covers the
   objects it lacks.
2. Every entry directly under `.git` is removed except `objects`, `refs`,
   `packed-refs`, `HEAD`, `index`, `sharedindex.*` and `shallow`
   (`RECEIVE_KEEPS`). `objects/info/alternates` and `http-alternates` go too.
3. `git init --quiet --template= .` runs every time. It writes a fresh
   `.git/config`. The empty template copies no sample hooks or `info/exclude`
   from `GIT_TEMPLATE_DIR` or the built-in path.
4. Every git call also gets `core.attributesFile=/dev/null`, because
   `~/.config/git/attributes` is read even with `GIT_CONFIG_GLOBAL=/dev/null`.
   It also gets `core.logAllRefUpdates=false`, and the fetch gets
   `--no-write-fetch-head`. With these, the run leaves nothing in `.git`
   beyond the keep-list and what `init` writes.

The fetch and checkout then read only that fresh config, their own `-c` flags,
and the head's tracked `.gitattributes`. That file can name a filter but cannot
define one, because only config can. The working tree, untracked and ignored
files included, is untouched.

The objects are kept so that the thin bundle hostd sends (`^<last head>`) still
has its prerequisites. The index is kept because its stat data lets
`checkout --force` leave unchanged files alone. Their mtimes then stay, and
`make` stays incremental. The split-index files are kept with it, or git
cannot read it.

This amends ADR 0064's "What git runs as the account".

## What this rules out

- **Removing only `.git/config`, `.git/info/` and `.git/hooks/`.** It leaves the
  gitfile, symlink and `commondir` routes open: there, nothing removed under
  `.git` is the config git reads.
- **Removing the whole `.git` every run.** It is the simplest and is safe. But
  it drops the index, so every tracked file is rewritten and the build stops
  being incremental. It also drops the objects, so every run needs the full
  bundle.
- **Overriding the local config with `git -c include.path=…` or
  `GIT_CONFIG_COUNT`.** Overriding key by key misses every key nobody listed,
  and git reads the local file whatever is added on top.

## What would make this worth revisiting

Two changes would reopen this:

- **Git gains a way not to read a repository's own config,** or a way to name
  the only config it reads. The folder could then keep its `.git` whole.
- **Something kept here becomes able to name a program.** That means an index
  extension, a ref, or an object format that git acts on at fetch or
  checkout. The keep-list would then have to shrink, or the folder would be
  made fresh each run at the cost of incremental builds.
