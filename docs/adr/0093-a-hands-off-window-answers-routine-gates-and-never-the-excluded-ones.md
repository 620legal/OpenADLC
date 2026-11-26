# 0093. A hands-off window answers routine gates, and never the excluded ones

- **Status:** accepted
- **Date:** 2026-11-26

## Context

Long runs stalled on gates a person would approve anyway. One example is a
builder's plan change that touches no path under Human review. Another is a
question whose answer the bot already recommended. The standing approval (#77,
`StandingCover` in `apps/bridge/src/gates.ts`) settles the first kind, but
only for one issue's plan changes. Nothing settles the second kind. #383 asks
for a time-boxed mode per repository that answers both. It must never reach
any decision the install keeps for a person: a Human-review path, a merge, a
bot approving its own work, a release, deploy or promote, a host check,
`scope:cross-cutting`, raising a cap, or anything that loosens a rule.

The codebase has no separate "spec approval" gate. A spec or design approval
is the design seat's question (spec skill, step 3), which the code calls the
spec gate.

## Decision

**The window.** A repository has at most one open hands-off window, a row in
`hands_off_windows` (migration 0175):

- Its duration is `1h`, `8h`, `24h` or `until_off`.
- It records who set it: the console identity, and the GitHub login and id
  the device-code sign-in proved. It records when it was set and when it ends.
- It ends in one of three ways: `expired`, `cap` (with the cap's words), or
  `turned_off` (with who did it).
- The table is not backed up, so a restore starts with every window off.

**Who turns it on and off.** `apps/bridge/src/hands-off-routes.ts` turns a
window on the way the release cut is held (ADR 0072):

- The console person's linked GitHub account must have Approves on in People.
  This is asked before a fresh device-code sign-in and again after it.
- The account that approved the code must be the linked one, by id and login,
  and must not be an account the crew uses.
- A window already open, or one opened during the sign-in, refuses the request.
- Every refusal, before or after the sign-in, is audited as
  `hands_off.refused`.

Anyone signed in to the console may turn a window off, at once, because
turning it off only tightens.

**How it ends.** A window turns itself off when its time passes, and a row
whose time has passed is never answered as open, even before the sweep ends
it. It also turns itself off at a monthly cap:

- The bridge's minute sweep ends a window when the global month total (when
  `stopLeasing`) or the repository's own month total is reached.
- A gate opened while any monthly cap refuses the asking bot ends the window
  too.
- A task's own cost cap does not end it.

Every start and end is audited as `hands_off.on` or `hands_off.off`. Both rows
name the window, who set it, when, and when it ends; an end adds who ended it,
why, and the cap's words. The activity feed shows these as `hands_off.on`,
`hands_off.off` and `hands_off.answered`.

**What it answers.** Only `Gates.open` consults the window, and only through
the cover in `apps/bridge/src/hands-off.ts`. The cover is an allow-list. Gates
the window settles are answered only if they were opened while it was on. It
settles:

| Gate | While the window is on |
|---|---|
| Plan change, no path under Human review on the base branch | Approved as it is asked |
| Plan change with a Human-review path, or rules unreadable | Asks a person |
| Question from an `intake`, `spec`, `implement` or `request` task on an issue or a console request, whose `recommended` is exactly one of its `options` | Answered with that option |
| Question with no `recommended`, one that matches no option, or an open question | Asks a person |
| Question routed to a person role the setter does not hold, or `addressedTo` another login | Asks a person |
| Question on an issue whose Expected paths name a Human-review path, or labelled `scope:cross-cutting` or `openadlc:ignore`, or whose issue or rules cannot be read | Asks a person |
| The cost-cap question (raising a cap) | Asks a person; the window stays on |
| Any question on a pull request: review, patch, conflict, deploy | Asks a person |
| Merge (`mergeDecision`), held Human-review approval, held merge, sign-off, promote, deploy, host check, release cut, labels, Settings | Unchanged: none of these is decided in `Gates.open` |

A gate the window settles posts no question, adds no `needs-human` and sends
no notification. Its record on the issue reads "**Answered by hands-off
mode**, set by `login` at `<time>`", with the question and the answer, and it
names the login without an `@`, so it notifies nobody. The `gate.answer` audit
row carries channel `hands_off` and the window, and the task resumes as from
any other answer.

A gate the window cannot cover is opened exactly as before. Its thread says
why, and the window stays on. A read that fails covers nothing.

**The `recommended` contract.** The question marker has an optional
`recommended`. `parseQuestion` keeps it only when, trimmed, it equals one of
the parsed options exactly, case and all. It is null for an open question and
for a plan change. hostd forwards it to `/internal/tasks/:id/gate`, and
`Gates.answer` accepts a hands-off answer only when it is exactly that option,
on a gate that is neither a plan change nor the cost-cap question. The
triage, spec and implement skills say when to set it. The skills whose
questions are never covered (`pr-review`, `resolve-conflict`, `deploy`) say
nothing about it.

**The boundary.** `hands-off.ts`, `hands-off-routes.ts` and
`packages/db/src/store/hands-off.ts` are under Human review.
`hands-off-exclusions.test.ts` fails when anything outside `gates.ts`,
`api.ts`, `main.ts`, the window's own modules and the db index imports the
window or its store. It also fails when the merge, held approvals, promotes,
host checks or releases mention it.

## What this rules out

- **Widening `standing_plan_approvals` to mean the whole repository when the
  issue is null.** Its rows end when an issue's pull request merges, and it
  holds no duration or proof. Its readers (the board, the cards,
  `endStandingApproval`) would each have to learn the null case.
- **A deny-list of gate kinds inside the cover.** With a deny-list, a gate
  added later would be answered until someone remembered to exclude it. With
  the allow-list, every new gate asks a person until someone decides
  otherwise.
- **Answering questions already waiting when the window opens.** A person may
  already be reading them, and the standing approval also covers only later
  requests.
- **Covering questions on a pull request.** Those are the crew judging work
  under review, which is the "a bot approving its own work" exclusion.
- **Letting only an approver turn a window off.** Turning it off only takes
  the person back into the loop, so asking for more than a console sign-in
  would keep a mode on that someone wanted off.

## What would make this worth revisiting

- A gate that is decided in `Gates.open` but should never be answered without
  a person, such as a new kind of question a bot asks about merging or
  releasing. The allow-list keeps it out by its task kind and subject, but the
  table above would need a row.
- Hands-off answers that people routinely refuse after the fact, which would
  mean `recommended` is set too freely by the skills.
- An install where People and the roles are commonly unreadable. Every routed
  question would then ask a person, and the mode would answer little.
