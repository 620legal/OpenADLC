# Did a change to what sessions are given change how much they read?

Use this when a change altered an implement session's starting context, for
example the project map (#380), and you want to know whether sessions read
less afterwards. It compares completed implement tasks' input tokens in the
30 days before the change with those from after the install started running
it. The result is a comment posted on the change's issue and its pull request.

Insights (`/insights`) has a weekly section, **Input tokens per implement
task**, that shows the trend without a query
(docs/adr/0094-insights-shows-weekly-input-tokens-per-completed-implement-task.md).
This runbook gives the exact before/after for one change. No crew task can
read the platform database, so a person runs it.

The query only reads. It writes nothing to the ledger or anywhere else.

## What is counted

- **A task**: one row in `tasks` with `kind = 'implement'` and `state = 'done'`.
  A task that failed, was stopped or is still running is not counted. Neither
  is a task with no ledger row.
- **Its input**: the sum of `ledger.tokens_in` over its rows. That is all the
  input the engine read, cache reads and writes included
  (docs/adr/0092-the-ledger-records-cache-tokens-as-part-of-tokens-in.md), so
  it means the same before and after #367.
- **Its side**: decided by `tasks.started_at`, because a session gets its
  context when it starts.
- **Billed and subscription runs**: counted together, and also apart. A task
  whose rows are all billed is `billed`, one whose rows are all on a
  subscription is `subscription`, and one with some of each is `mixed`.

## 1. Find the before cut: when the change merged

```bash
gh pr view <pr> --repo 620legal/OpenADLC --json mergedAt,mergeCommit
```

`mergedAt` is the before cut. The before window is the 30 days that end at
it. Keep `mergeCommit.oid` for step 2.

For #380, the pull request is #400.

## 2. Find the after cut: when the install started running it

A merge is not when sessions got the change. The install runs a change only
after self-update takes a release that contains it (docs/adr/0007), and
self-update writes an `openadlc.updated` audit row, with the commit it moved to
in its payload's `to`.

List the updates since the merge:

```sql
select at, payload->>'to' as to_commit
  from audit
 where action = 'openadlc.updated' and at >= '<mergedAt>'
 order by at;
```

In an OpenADLC checkout, walk the rows in order. The after cut is the `at` of
the first row for which this exits 0:

```bash
git merge-base --is-ancestor <mergeCommit> <to_commit>
```

Tasks that started between the two cuts are in neither window: the change had
merged, but the install was not running it yet.

If there is no such row, the install has not run the change yet. Stop here.
An install that runs from a checkout and never self-updates has no row: use the
time it was restarted on a commit that contains the change, and say so in the
comment.

## 3. Reach the database

On the host, take `databaseUrl` from `$OPENADLC_HOME/install.json` (0600), and:

```bash
psql "<databaseUrl>" -v before_cut='<mergedAt>' -v after_cut='<the after cut>'
```

## 4. Run the query

```sql
with per_task as (
  select t.id, t.started_at, sum(l.tokens_in)::bigint as tokens_in,
         bool_and(l.billed) as all_billed, bool_or(l.billed) as any_billed
    from tasks t join ledger l on l.task_id = t.id
   where t.kind = 'implement' and t.state = 'done' and t.started_at is not null
   group by t.id
), sided as (
  select tokens_in,
         case when started_at >= :'before_cut'::timestamptz - interval '30 days'
                   and started_at < :'before_cut'::timestamptz then 'before'
              when started_at >= :'after_cut'::timestamptz then 'after' end as side,
         case when all_billed then 'billed' when not any_billed then 'subscription' else 'mixed' end as run
    from per_task
)
select side, run, count(*) as tasks,
       round(percentile_cont(0.25) within group (order by tokens_in)::numeric) as p25,
       round(percentile_cont(0.5)  within group (order by tokens_in)::numeric) as median,
       round(percentile_cont(0.75) within group (order by tokens_in)::numeric) as p75
  from sided where side is not null
 group by grouping sets ((side), (side, run))
 order by side desc, run nulls first;
```

The rows where `run` is empty are each side's billed and subscription tasks
together. The other rows give each kind on its own.

Insights uses the same per-task sum and the same percentiles, so for any one
week the page agrees with this query run over that week.

## 5. Read it, and post it

- **Either side has fewer than 20 tasks in total**: post nothing yet. Run it
  again later; the after side fills as implement tasks complete. If a comment
  is wanted anyway, say how many tasks each side has and give no figure.
- **Both sides have at least 20**: post one comment with:
  - the two cuts, and how you found the after cut (the audit row's `at` and
    `to`)
  - the count on each side
  - p25, median and p75 for all tasks together on each side, and the change in
    the median
  - billed and subscription: if, for a kind present on both sides, the median
    moved the other way from the median of all tasks, say the kinds differ and
    give their rows apart. Otherwise, one line saying the two kinds agree, with
    the counts of each.
  - the query exactly as you ran it, with the `-v` values

Post it on the change's issue and on its pull request. For #380, that is #386's
step: post on #385 and on #380.

## If it does not work

- **`permission denied` on psql**: you are not using the URL from
  `install.json`, or not on the host. The database port is not published
  beyond the machine.
- **The after side stays at 0**: `after_cut` is later than every task. Check
  step 2's row again; a time with no zone is read in the session's zone, so
  give it as ISO with `Z`.
- **The figures do not match Insights for a week**: Insights counts each UTC
  week from Monday 00:00. Run this, with the week's Monday and the Monday after
  it, and compare its row with the page's:

  ```sql
  select count(*) as tasks,
         round(percentile_cont(0.25) within group (order by tokens_in)::numeric) as p25,
         round(percentile_cont(0.5)  within group (order by tokens_in)::numeric) as median,
         round(percentile_cont(0.75) within group (order by tokens_in)::numeric) as p75
    from (select sum(l.tokens_in)::bigint as tokens_in
            from tasks t join ledger l on l.task_id = t.id
           where t.kind = 'implement' and t.state = 'done'
             and t.started_at >= '<monday>' and t.started_at < '<next monday>'
           group by t.id) per_task;
  ```

  A task counts only once it is done, so the current week's figure moves as
  tasks finish.
