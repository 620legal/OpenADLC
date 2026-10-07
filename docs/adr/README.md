# Decisions

One file per decision that would otherwise be re-argued: `NNNN-short-title.md`.

A decision record says what was decided, what it rules out, and what would make
it worth revisiting. It is written once and not edited afterwards — a decision
that changed is a new record that supersedes the old one, because the point of
the file is the reasoning available at the time.

The template is `0000-template.md`.

The decisions FleetADLC was built on so far are the D-table in
[platform-plan.md](../platform-plan.md#12-decisions), one row each. A decision
taken from here on is a record in this folder; the plan's table links to one
only where it changed a decision the table already had (0003, from D5 and D12).
The records:

- [0001](0001-attachments-in-the-database.md): attachments live in the database
- [0002](0002-design-memory.md): the design stage remembers, in ADRs and a summary of them
- [0003](0003-per-task-containers.md): a computer per task, and several tasks per seat
