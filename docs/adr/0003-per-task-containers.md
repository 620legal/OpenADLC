# 0003. A computer per task, and several tasks per seat

- **Status:** accepted
- **Date:** 2026-09-30

## Context

Every seat had one long-lived container, `bot-<name>`, with a Postgres sidecar
on a network of its own, and every task the seat ran was a tmux session in it.
One running task per container was the collision guarantee (D5), so running
two builds at once meant a second seat: a second GitHub account to create and
connect, a second container, a second sidecar.

That model had costs that grew with the crew:

- **Concurrency was paid for in accounts.** A repository at `concurrency: 3`
  needed three builder seats, each a real GitHub account a person had to create
  and authorize, though all three did the same job as the same role.
- **A container outlived everything that made it right.** A login, a mount, an
  environment variable and an image are fixed when a container is made, so a
  bot moved to another account, a moved checkout or a new image meant
  recreating a container that might be in use; `whileIdle` existed only to
  find a moment when it was not.
- **Nothing a task left behind was really gone.** The seat's home, its caches,
  its globally installed tools and its database carried from one task to the
  next, across repositories, until the per-repository homes narrowed it.
- **Sizes were never applied.** `cpus` and `memoryGb` were read from
  `config/bots.yaml` and dropped; every container ran on two CPUs and 4 GB.
- **The mirror was the tasks' own.** A worktree committed straight into its
  bot's bare mirror, whose fetch prunes and force-updates every branch, so it
  could protect only the branch of the task being resumed.

## Decision

A task gets a computer of its own; a seat is a GitHub identity and a chat,
never a machine; and how many tasks run at once is a number.

- **Per-task containers.** hostd makes a container for each task when it
  starts (`task-<id8>`) and removes it when the task ends. Its size is its
  seat's; it runs at most 4096 processes and with `no-new-privileges`, since
  the engines' own sandboxes are off inside it. It mounts its own folder (`work/slots/<task>`: the clone, the
  briefing, the home) at the path it has on the host, its repository's cache
  volume at `/cache`, its repository's pnpm store at `/pnpm-store` read-only,
  the skills, playbooks, runner and `gh` read-only, and its
  account's login only when its account needs one. Its credentials are injected
  per task, as before; its signing agent runs inside it and dies with it.
- **One network, closed between its members.** Every task's container is on
  one network per install, `fleetadlc-tasks`, made with inter-container
  traffic off. Tasks reach hostd, the bridge, the proxy and the task database
  through the host gateway.
- **A database per task on one server.** `fleetadlc-taskdb`, one per host,
  published only on the host's gateway; each task a login role and a database
  of its own, from a template with the common extensions, closed to every other
  role, limited in connections, dropped with the task.
- **A clone per task from one mirror per repository.** The mirror is only
  hostd's, under a lock, and its branches are only the remote's. A task's
  branch is kept between its computers under `refs/fleetadlc/tasks/<task>`.
- **Paused tasks give their computer back** after
  `FLEETADLC_PAUSED_KEEP_MINUTES` (D12), so take-over and a quick answer still
  find it, and a question open for a day does not hold a container.
- **Concurrency is a number.** A seat runs up to `bots.max_tasks` tasks at once
  (Crew → "tasks at once"), all as its one identity; a host runs up to
  `hosts.capacity_tasks`. The collision guarantee is the lease and the
  dispatcher's overlap check on declared paths, which it always was in fact:
  two containers on two accounts never stopped two builds from editing the same
  file.
- **A warm pool hides a cold start**, off by default (`FLEETADLC_WARM_POOL`):
  containers made ahead, keyed by image, repository and login, claimed by
  renaming and resizing one rather than making it.
- **The local driver keeps working**, with a task's folder and tmux sessions on
  the host as its computer, for development (D9).

## What this rules out

- **More seats for more concurrency.** It asked a person to create and connect
  an account for capacity, and made the roster a function of throughput. A
  seat that needs isolation of identity still can have its own account.
- **A network per task.** It isolates as well and runs out: Docker's default
  address pools hold about thirty bridge networks, and a busy host would refuse
  the thirty-first task.
- **A Postgres per task.** It isolates better and costs a container start and a
  wait for Postgres on every task. Per-role isolation on a shared server is the
  trade; a superuser compromise reaches every task's database on the host,
  which docs/security.md says.
- **Reusing a container across tasks of one seat.** It is the model being left:
  whatever one task leaves — a process, a file in `/tmp`, a global install — is
  in the next one's computer.
- **`git worktree` from a shared mirror.** A worktree's `.git` names its mirror
  by absolute path, so the mirror would have to be mounted into every
  container, writable, and one task's fetch would still prune another's branch.
- **Sharing more of the cache.** Only npm's cache, which verifies what it
  holds, is shared and written by a repository's tasks; a global prefix or
  `~/.cache` shared between seats could be planted by one task and run by the
  next. pnpm's store was shared too, on the claim that it verifies itself, and
  it does not: for a package it already holds, pnpm trusts its own index, so a
  writable shared store is not safe. Each repository's store is now a volume
  every task mounts read-only and hostd alone fills, from the task's lockfile,
  in a container of its own (`apps/hostd/src/pnpm-store.ts`).

## What would make this worth revisiting

- A cold start long enough that the warm pool has to be on everywhere, or a
  host too small for `capacity_tasks` computers at its seats' sizes.
- Docker's ICC setting failing to keep two tasks apart on a supported platform
  (`docs/unverified.md` lists it).
- Subscription logins that cannot be shared by concurrent tasks. Codex and
  Grok refresh their own tokens in the account's one login directory, mounted
  into every task on it, the way several CLI windows on one laptop share a
  home; two tasks refreshing at the same moment could race. If that is ever
  seen — a task signed out mid-run — the fix is to serialise the refresh, not
  the tasks.
