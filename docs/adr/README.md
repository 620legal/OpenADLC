# Decisions

One file per decision that would otherwise be re-argued: `NNNN-short-title.md`.

A decision record says what was decided, what it rules out, and what would make
it worth revisiting. It is written once and not edited afterwards — a decision
that changed is a new record that supersedes the old one, because the point of
the file is the reasoning available at the time.

The template is `0000-template.md`.

The decisions OpenADLC was built on so far are the D-table in
[platform-plan.md](../platform-plan.md#12-decisions), one row each. A decision
taken from here on is a record in this folder; the plan's table links to one
only where it changed a decision the table already had (0003, from D5 and D12;
0004, from D7). The records:

- [0001](0001-attachments-in-the-database.md): attachments live in the database
- [0002](0002-design-memory.md): the design stage remembers, in ADRs and a summary of them
- [0003](0003-per-task-containers.md): a computer per task, and several tasks per seat
- [0004](0004-design-always-by-default.md): Design is Always by default; `conditional` is a repository's opt-out (supersedes D7)
- [0005](0005-ruleset-bypass-is-the-app-or-a-person.md): a ruleset bypass is OpenADLC's app or a person who is not a crew account
- [0006](0006-abandoned-is-a-label.md): an issue closed without merging is Done, labelled `openadlc:abandoned`, and not shipped
- [0007](0007-self-update-follows-verified-releases.md): self-update takes only verified releases, prepared beside the install, and the checkout stays the install
- [0008](0008-a-close-stops-the-tasks-paused-on-it.md): a close stops every task paused on the issue or its pull request, at the close only, and a person's Stop ends a task waiting on a question
