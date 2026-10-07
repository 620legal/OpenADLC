# Role playbooks

A **skill** is what a bot does on one task. A **role** is what a bot is
accountable for across every task. Skills live in `crew/skills/`; roles live here, are
mounted read-only into the container, and are the first context a task is given.

Keep a role short. If a rule can be a check, it belongs in a check, not here.

Each file states what the bot owns, what it never does and who it hands to;
some also say what they escalate. The crew is defined in
[`config/bots.yaml`](../../config/bots.yaml).

**One file per role, named for the role.** `crew/roles/<role>.md` is what hostd reads,
with no mapping in between. There used to be one: nine roles shared four
playbooks, so the spec bot was briefed as a builder, QA as a reviewer, and the
automation account as intake — three bots told they were something else, and
nothing said so, because a missing playbook is only a warning in a log.
`apps/hostd/src/playbooks.test.ts` is what fails now when a role arrives without
one, when a playbook is left behind after a rename, or when one grows past the
length at which anybody still reads it.
