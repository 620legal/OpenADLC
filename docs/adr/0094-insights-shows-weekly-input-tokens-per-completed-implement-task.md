# 0094. Insights shows weekly input tokens per completed implement task

- **Status:** accepted
- **Date:** 2026-11-26

## Context

#380 put the project map in every implement session's starting context
(docs/adr/0088). It was meant to cut the exploring a session does before it
writes code, and #385 asks whether it did. The only evidence is the ledger's
`tokens_in` on real runs. Scripted engines report fixed usage, so they cannot
show a difference.

Two facts shape where the answer can come from:

- No crew task can read the platform database. Every task gets only its own
  task database (`0152_repo_task_postgres.sql`), and `ledger` and `tasks` are
  reachable only from the bridge, or by a person with `psql` on the host.
- The after window fills only weeks after the change is running, long after
  any build that could add a figure has merged.

A person chose, on #385, a figure on Insights plus a runbook query, over a
runbook alone or a bridge job that posts the result once.

## Decision

`GET /v1/insights` returns `implementInput` on each summary, overall and per
repository, and the Insights page shows it as a table titled **Input tokens per
implement task**:

- **The tasks**: completed implement tasks (`tasks.kind = 'implement'`, state
  `done`) with at least one ledger row.
- **A task's input**: the sum of its rows' `ledger.tokens_in`, which is all
  input, cache reads and writes included (docs/adr/0092).
- **The weeks**: 12 UTC weeks, each starting Monday 00:00, the current partial
  week last. A task falls in the week of its `started_at`, because a session
  gets its context when it starts. The weeks do not follow the page's
  7/30-day period, because a drop shows only across weeks.
- **The figures**: p25, median and p75, computed as Postgres
  `round(percentile_cont(p) … ::numeric)` computes them (`percentile` in
  `apps/bridge/src/insights.ts`). The page and the runbook's query therefore
  agree for any week.
- **Small weeks**: under 5 tasks, a week gives its count and no figure.
- **Billed and subscription**: tasks whose rows are all billed, all on a
  subscription, or a mix are counted apart in `byRun`, and together for the
  figures. These are token counts, not costs, so the rule that keeps billed
  and estimated spend apart (docs/adr/0050) does not apply.

A before/after comparison for one change is a person's query, from
`docs/runbooks/compare-implement-input-tokens.md`: the 30 days before the
change merged, against the days after the install started running it, with no
figure while either side has fewer than 20 tasks. For #380, #386 posts it.

A change reaches sessions when the install runs it, not when it merges. The
after cut is the first `openadlc.updated` audit row whose `to` commit contains
the merge commit. Tasks that started between the merge and that row count on
neither side.

## What this rules out

- **Before/after windows computed on Insights.** These would need #380's
  commit, or a setting that names a commit, in the bridge, and would serve one
  question once. The weekly series shows this change and any later one
  without it.
- **A bridge job that posts the result unattended.** It would be code kept for
  a one-time question, and the person who answered #385 chose against it.
- **A crew task running the query.** No task can reach the platform database,
  and giving one access to read the ledger is not worth one measurement.
- **The merge time as the after cut.** Tasks that started between the merge and
  the install's update had no map, and counting them as "after" would blur the
  difference the comparison is looking for.
- **Following the page's 7/30-day period.** Seven days is one week, which shows
  no trend.

## What would make this worth revisiting

- If the ledger's `tokens_in` stopped meaning all input: an engine that reports
  cached input apart from it, or a change to docs/adr/0092. Then the weekly
  figures would change meaning partway through the series.
- If before/after questions about session context became routine. Then a
  setting that names cuts on Insights would earn its keep over a runbook.
- If implement tasks became so few that most weeks fall under 5. Then the
  weeks should widen to months.
