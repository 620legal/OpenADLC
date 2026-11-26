# Routines

A routine is a console request that files itself on a schedule. It holds a
repository, the request's text and details, a kind, and a cadence at a time
of day in a time zone. Each time it falls due, the bridge files it as an
ordinary console request, in the name of the person who last set it, and
intake, gates, caps and leases treat that request as they treat any other.

Use one for work you would otherwise ask for by hand every week: a dependency
review, a check that the docs still match the code, a weekly report.

The decision behind it is
[ADR 0090](adr/0090-a-routine-files-a-console-request-as-its-owner-from-a-claimed-slot.md).

## Who may change one

Anyone with console access can open **Routines** and watch them. Creating,
editing, pausing, resuming and deleting a routine takes:

- a GitHub account linked to you in **Settings → Your GitHub account**, and
- Approves on for you in **Settings → People**.

Anyone else gets an error that says which of the two is missing, and the page
shows them no create or edit controls.

**Whose name a routine files in.** The person who created it, or the
approver who last edited it. Editing a routine makes you its owner, so a
routine never files a request in the name of someone who did not write what
it says. Pausing, resuming and deleting leave the owner as it was.

## Cadences and time zones

- **Daily**, at a time.
- **Weekly**, on a day from Monday to Sunday, at a time.
- **Monthly**, on a day from 1 to 31, at a time. A month that lacks the day
  (29, 30 or 31) runs it on its last day: a routine set for the 31st runs on
  28 February, or the 29th in a leap year.

The time is read on the wall clock of the routine's IANA time zone (such as
`Europe/Paris` or `America/New_York`), so it stays at the same local time
across a change to or from summer time:

- A time the spring change skips runs the length of the gap later: 02:30 in
  Berlin on the change day runs at 03:30.
- A time the autumn change repeats runs once, at its first occurrence.

The console starts a new routine in your browser's time zone.

A routine is refused, with what to fix, when its repository is not one the
install manages, its request text is empty, its time zone is not an IANA
zone, its time is not `HH:MM`, or its cadence has no day, or a day out of
range, where it needs one.

## Templates

A new routine starts from one of these, or from **Blank**. Each fills in the
text, details, kind and cadence, and everything stays editable.

| Template | Cadence | Kind |
|---|---|---|
| Weekly dependency review | Mondays at 09:00 | chore |
| Nightly docs-drift check (docs that no longer match the code) | Every day at 02:00 | chore |
| Monday project-health report (open issues, stuck items, flaky checks, spend) | Mondays at 08:00 | chore |

There is no Discover template: a Discover run is started by its own command,
not by a request, so a routine cannot start one.

## When a run is skipped

When a routine falls due it files nothing, and says why on the Routines page,
in this order:

1. **Work is paused**, across the install or in the routine's repository.
2. **The monthly cap is reached**: the cap that stops leasing
   (`costs.onCap.stopLeasing`).
3. **Its owner no longer has Approves on, or is no longer in People.** The
   routine stays unpaused and checks again at each run, so it files again
   once its owner has Approves back, or once an approver edits it and so
   takes it over.
4. **The request it filed last is still open**: queued, being triaged,
   waiting on questions, or filed with an issue or pull request still open.
   Runs never pile up behind one another.

A skipped run still moves the next run on, so skips never fire later in a
burst.

If filing itself fails (for example, intake is not connected to GitHub), the
routine shows the error, and the next attempt is its next slot, not the next
minute.

## Downtime

The bridge looks for routines that fall due every minute
(`OPENADLC_JOB_ROUTINES_MINUTES`; 0 stops every routine). A routine that
missed one or more slots while the bridge was down runs once when it comes
back, not once per missed slot, and its next run is the next slot after that.

A routine and its next run are kept in the database (the `routines` table),
so they survive a restart.

## Pausing and deleting

**Pause** keeps the routine and stops its runs; a paused routine shows no
next run. **Resume** sets its next run to its next slot from now.

**Delete** removes the routine. The requests it already filed stay; each one
records which routine filed it until that routine is deleted.
