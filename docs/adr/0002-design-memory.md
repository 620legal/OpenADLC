# 0002. The design stage remembers, in ADRs and a summary of them

- **Status:** accepted
- **Date:** 2026-09-30

## Context

Every task starts from its issue and nothing more: a fresh worktree, a fresh
session, no memory of the last one. That is right for building and reviewing,
where the issue and the code are the whole brief, and wrong for design. A
design that does not know the repository already decided how costs are stored,
or that times are UTC, contradicts it, and a reviewer may not notice because
the contradiction is with a comment on a closed issue.

Design is the one stage with memory and context, and runs on the most capable
model the crew has. The memory has to be:

- a record that outlives FleetADLC and is read where the code is;
- small enough to give every design task without crowding out the issue;
- correctable by a person, because a wrong summary is repeated on every issue.

## Decision

GitHub is the record. A decision a design takes is written as an ADR under
`docs/adr/` in the managed repository, by the build that carries it out, in the
same pull request; the design names the file in the issue's Expected paths.

The database keeps the summary (`design_memory`, migration 0030): one entry per
decision, constraint, convention or term, proposed by the design comment's
`design_memory` marker, accepted when a person answers the design's question on
that issue or the issue moves on to build, and pointed at its ADR once the
change merges.

Only the design task on an issue proposes for it. The bridge reads the last
marker of a comment whose signature verifies to that task (its kind, its
issue and its own seat), whatever the attribution mode, and records the task
and its seat with each entry (migration 0090). A comment by any other seat, a
marker quoted inside a comment, and text the bridge echoes for a person
propose nothing; the echoes also write a person's `<!--` as text. Acceptance is
credited to the person who answered that design's own question, or else to
the design's seat, "unopposed at the move to build"; an answer to another
task's question never supplies the name. An entry recorded before the task
was kept is never accepted on its own.

Superseding an accepted entry stays automatic, with nobody asked, and is
never silent: the bridge comments on the issue naming both entries and how to
revert, and the board shows a notice that holds no work. **Revert** in Settings
puts the old entry back in effect and retires the new one, audited as
`design_memory.reverted`. Only design tasks are given it (`design-memory.md`): accepted
entries, the newest decisions first, superseded ones left out, under 16,000
characters, with a pointer to `docs/adr/` in the worktree. People read and
correct it in Settings → Repositories → Design memory: reword, accept, retire,
mark superseded; every change is audited.

## What this rules out

- **Only the ADRs.** Giving a design task every ADR is unbounded and grows
  with the repository; giving it none means it does not know what is there.
  The summary is the index the design stage reads first.
- **Only the database.** A decision kept only in FleetADLC is lost to anyone
  reading the repository, and to the repository if it ever leaves FleetADLC.
- **A memory every stage reads.** Builders and reviewers work from the issue
  and the design, which already carry what applies to the change. Memory in
  their context is tokens spent on decisions that do not bear on it, and a
  second source the design could disagree with.
- **Accepting on proposal.** A design a person has not looked at would become
  the repository's memory the moment it was posted. Acceptance waits for a
  person's answer, or for the issue to be built, which is the design being
  taken.

## What would make this worth revisiting

A repository whose accepted summary no longer fits in 16,000 characters: then
the design stage needs to be given the entries that bear on the issue rather
than the newest, and this becomes a retrieval question.
