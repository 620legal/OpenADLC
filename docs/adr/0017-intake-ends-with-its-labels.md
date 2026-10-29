# 0017. An issue leaves intake only with its labels

- **Status:** accepted
- **Date:** 2026-10-29

## Context

Intake must give every issue one `priority:`, one `area:` and exactly one
`do:` label. Only routing read them (`missingForRouting`), when the dispatcher
considered an issue for Build. On #203, intake's comment said it had put
`area:general` on, and it never had. Intake's own `gh issue edit` put
`adlc:spec` on, the webhook accepted that first move out of intake and stored
the stage as Design, and intake's end (`StageHandoff.afterIntake`) moved spec
to spec. Design ran and finished; only then did routing find no area, put
`needs-triage` on and take `start:now` off. The issue sat for 23 hours until a
person labelled it.

## Decision

An issue leaves intake only with the three labels, checked by one shared rule,
`missingLabels` (`packages/shared/src/readiness.ts`), which `missingForRouting`
also calls. The check runs at two points:

- **At the label.** When a crew account's stage label moves an issue out of
  intake and one of the three is missing, the webhook puts the stage back in
  intake and audits `stage.forward_refused` with the labels it lacks. It starts
  nothing: intake is usually still running, and its end decides.
- **At the end.** When intake's task ends on an issue still in intake,
  `afterIntake` reads the labels as GitHub has them now (the stored row can be
  behind), falling back on the stored ones. With one missing it does not move
  the stage, audits `intake.labels_missing`, and staffs intake again with
  `missing-labels.md` naming what is missing.

The retry counts toward intake's tries (`intakeGaveUp`, two in a week). It is
checked before staffing, because a brief otherwise skips the cap: a brief there
means a person's message, and a person's message overrides it. Past the cap the
issue is an `intake.stalled` card in Needs you, as it already was. A console
request's own triage has the subject `request:<id8>`, so it is not a try on the
issue, and a console issue gets one retry more than one opened on GitHub.

The triage skill also reads its labels back after applying them, and its
receipt lists the labels as read back.

## What this rules out

- **Checking only in `afterIntake`, moving the issue back from Design.** By
  then the webhook has stored Design. Moving it back is a backward
  `stage_moves` row, which send-back limits count, and Design could start in
  the gap between the stage label and the task's end.
- **Refusing the stage label in hostd's `gh` shim until the three are on.**
  The shim sees one call at a time and cannot tell what the issue already
  carries, and it would not catch #203, where the area label was never sent.
- **A copy of the label checks beside routing's.** Two copies drift; the rule
  is `missingLabels`, and anything asking whether an issue has its labels
  calls it.

## What would make this worth revisiting

Intake giving an issue a label the dispatcher needs that is not one of these
three, or routing no longer needing one of them: the rule would then be wrong
at intake's end as well as at routing. Or intake's tries proving too few for
a label retry on top of the shaping it already does.
