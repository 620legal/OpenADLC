# 0079. A submodule's git dir is kept and cleaned like the top-level `.git`

- **Status:** accepted
- **Date:** 2026-11-19

## Context

ADR 0067 cleans a kept working folder's `.git` from a keep-list before every
fetch. The list had no `modules`, so `RECEIVE` deleted `.git/modules`, the
submodules' git dirs. Each submodule's working folder stayed, with a gitfile
saying `gitdir: ../.git/modules/<name>`. The repository's own
`git submodule update --init` then failed with "could not get a repository
handle for submodule". Only a Clean build got past it, and on one install that
rebuilt a 38 GB tree over 4.4 hours (#365). The host check and the release run
share `RECEIVE` (ADR 0068), so both had the problem.

A submodule's git dir carries the same risk ADR 0067 closed for the top level.
An earlier run can plant a `filter.<name>.smudge` in
`.git/modules/<name>/config`, or a hook in its `hooks/`, and the repository's
own `submodule update` would run it. An earlier run can also replace a
submodule path's `.git` with a directory that holds a planted config.
`submodule update` treats that path as populated and runs `fetch` and
`checkout` inside it. So does the top-level fetch's on-demand recursion into
submodules.

Every account process also started in hostd's own working directory, through
`sudo`, which keeps the caller's directory. The account cannot enter that
directory by design, so `/bin/sh` printed
`shell-init: error retrieving current directory: getcwd: …` as the first line
of every build log. That line read as the cause of a failure.

## Decision

`RECEIVE` (`apps/hostd/src/host-check.ts`) keeps `.git/modules` and cleans each
module's git dir the way ADR 0067 cleans the top-level `.git`. It writes each
submodule's config and gitfile itself.

1. The top-level keep-list is `MODULE_KEEPS`: `RECEIVE_KEEPS` plus `modules`.
   Before the fetch, `.git/modules` moves to `.git/openadlc-modules`, or is
   removed if it is a symlink or not a directory.
2. Before the fetch, `unpin` removes the `.git` of every gitlink the kept index
   names. The fetch gets `--no-recurse-submodules`, so it runs git in no
   submodule.
3. After the checkout comes the submodule pass. For each gitlink in the new
   index, the pass reads its name from `.gitmodules` with `config --file`,
   which follows no `include`. The name must match
   `^[A-Za-z0-9_.@+-][A-Za-z0-9_.@+/-]*$`, with no `.`, `..` or empty part.
   - A path that is a symlink, or that exists and is not a folder, is removed.
     The path's `.git` is removed, whatever it is.
   - If the name is valid and the module's git dir was kept, with no symlink on
     the way to it, the module is kept:
     - Its `remote.origin.url` is read as data. The URL is carried over only if
       it starts with `https://`, `ssh://`, `git://`, `file://` or `/`, or has
       the scp shape. It must also have no `::`, nothing but printable ASCII
       with no spaces, and no leading `-`.
     - The git dir is cleaned to `MODULE_KEEPS` and moved back to
       `.git/modules/<name>`.
     - `init --template=` writes a fresh config, and the pass adds
       `core.bare=false` and a relative `core.worktree`.
     - Every `.git` deeper inside the module's folder is removed, and the pass
       writes `<path>/.git` as `gitdir: <relative path>`.
     - The pass then goes into the module's own submodules the same way.
   - Otherwise the folder is emptied, and the repository's
     `submodule update --init` clones it again (the fallback).
   - Modules the head no longer has go with the staging folder.
4. A gitlink path that git would never check out stops the receive with a
   message that names it. That covers a quoted path, a `.`, `..`, empty or
   `.git` part, and a symlink on the way to the path.
5. hostd starts every process with `cwd: '/'` (`nodeProcesses`,
   `apps/hostd/src/account-probe.ts`). That covers `run`, both ends of `pipe`,
   `start`, and the killer `signalAll` sends. Every path hostd gives git or the
   account is absolute.

Once `RECEIVE` ends:

- Every git dir in the folder holds only `MODULE_KEEPS` and a config the script
  wrote.
- Every submodule path's `.git` is either absent or a gitfile the script wrote,
  pointing into a git dir it cleaned.
- A kept module keeps its objects, refs, `HEAD` and index. The repository's own
  `submodule update` then checks out the pinned oid against that index, so
  files the new pin does not change keep their mtimes, and the build stays
  incremental.

The objects and the index of a submodule nested inside a kept module are the
earlier run's, and so are the module's gitlinks. An index can leave a real
nested submodule out. The pass therefore removes every `.git` inside a kept
module's folder before it writes back the gitfiles it vouches for. The cost is
that a git repository the build itself left inside a submodule's folder loses
its `.git`.

This amends ADR 0067. Its "What would make this worth revisiting" now covers
each submodule's git dir as well as the top-level `.git`.

## What this rules out

- **Removing each submodule's folder and `.git/modules` every run, so the
  repository clones them again.** This is the simplest option, and it is safe.
  But every cut would re-clone every submodule and give each of its files a new
  mtime, so the submodule would rebuild from scratch. That fails the reason for
  the change, a 38 GB tree. It survives only as the fallback for a module the
  script cannot vouch for.
- **Keeping each module's git dir whole.** This reopens what ADR 0067 closed: a
  filter or hook in `.git/modules/<name>` would run at the repository's own
  `submodule update`.
- **Trusting the gitfile or config an earlier run left.** A gitfile can point
  anywhere, and a config can name a program. Both are written fresh every run.
- **Carrying a submodule URL over as it is.** An `ext::` URL runs a command if
  the repository's command widens `protocol.allow`, and a URL that starts with
  `-` is read as an option. Banning `::` blocks every remote helper.

## What would make this worth revisiting

- **Either of ADR 0067's triggers:** git gains a way not to read a
  repository's own config, or something kept here becomes able to name a
  program. Either one now applies to each submodule's git dir too.
- **Git stops writing submodule git dirs under `.git/modules/<name>`,** or
  gives them another layout. The pass and its keep-list would then have to
  follow git's new layout.
- **The repository's own git reading the account's global config.**
  `~/.gitconfig` and `~/.config/git/attributes` are read by the build's git,
  its `submodule update` included, and an earlier run can write them. That is
  the build's environment (`hostCheckEnv`, `releaseEnv`), not `RECEIVE`'s, and
  this record leaves it as it was. Closing it would change every repository's
  build, so it is its own decision.
