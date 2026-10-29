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
- [0009](0009-work-items.md): every issue, pull request and request gets a work item number of the install's own, never reused, numbered in opened order from history and linked automatically
- [0010](0010-console-name-and-logo.md): the console's name and logo are two settings, the logo a checked data URL kept out of every request's read, read by every role and drawn only through `<img>`, served sandboxed
- [0011](0011-a-request-is-answered-once-saved.md): a console request is answered once it is saved, with a prediction (`starting`, or its place in line), and its triage starts after; a failed start is said on its thread
- [0012](0012-a-request-files-one-issue-per-repository.md): a console request files one issue per managed repository it concerns, recorded in `request_issues`; an issue joins it only while its triage runs, and its triage signs for the managed repository it posts to, only on its request's issues
- [0013](0013-dependencies-across-repositories.md): a dependency may name an issue in another managed repository as `owner/name#N`; `parseDependencyRefs` replaced `parseDependencies`, one outside the install never ships, and stacking stays same-repository
- [0014](0014-the-bots-image-is-stamped-with-its-recipe.md): the bots' image carries `openadlc.recipe`, the digest of the files it is built from; an image behind its recipe is rebuilt with the versions it has, and the bridge starts that run once per recipe
- [0015](0015-a-wait-on-a-person-is-recorded-where-the-gate-is-settled.md): what the review gate waits on reaches Needs you as an event recorded where the gate is settled, once per head (`review.person_asked_again`, `review.person_awaited`), and is never read live from GitHub by the attention read
- [0017](0017-intake-ends-with-its-labels.md): an issue leaves intake only with its `priority:`, `area:` and one `do:` label, checked by `missingLabels` when intake's stage label comes in and when its task ends; a retry for a missing one counts toward intake's tries
