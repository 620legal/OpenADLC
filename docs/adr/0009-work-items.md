# 0009. Work items: an install's own number for every issue, pull request and request

- **Status:** accepted
- **Date:** 2026-10-22

## Context

A piece of work in OpenADLC can be a console request, the issue intake files
from it, the pull request that builds it and the deploys that ship it. Before
this record, nothing tied those together except the issue's number, which a
request does not have until it is filed and which another repository reuses.
#27 asked for one number per piece of work, shown on the board and on an item
page, with links a person can make by hand. A person decided its shape there,
and #71 is the stored half: the tables, the numbering, the history, the
automatic links, and backup.

The person's choices on #27:

- work items are their own table, plus a link table;
- the key shows the GitHub organization as its prefix;
- nothing is written on GitHub;
- every issue and pull request gets a number, history included.

## Decision

- **Two tables and a sequence** (`migrations/0146_work_items.sql`).
  `work_items` holds a number from `work_item_number_seq`. `work_item_links`
  holds one row per issue, pull request or request, with a snapshot of its
  title, state, url and when it was opened. Each thing has at most one link
  (`(repo_id, number)`, `request_id`). No existing table gains a column.
- **The number is the identity, and is never reused.** A number is drawn with
  `nextval`, which a rollback does not give back, and an item's row is never
  deleted. A merged item, or one whose last link moved away, keeps its row and
  its number, and its `merged_into` says where it went, so its key still
  resolves. The organization prefix is for display only (`formatKey`,
  `parseKey` in `apps/bridge/src/work-items.ts`).
- **The first issue.** A link's `id` is the order things were linked in. An
  item's first issue, which #27 shows, is its issue link with the lowest id.
- **Deploys are reached through pull requests.** Deploys are not links: a
  deploy is an item's through its pull requests (`deploy_runs.pr_number`).
- **History is read once, resumably, read-only, and numbered in opened
  order** (`apps/bridge/src/work-item-backfill.ts`). On the first start
  after the upgrade, the bridge reads each managed repository's issues and
  pull requests, oldest first, a page at a time, as the automation account.
  It saves each page with the next page's number, so a restart or a rate
  limit resumes where it stopped. Once every repository is read, one
  transaction numbers everything without a link, across repositories, in the
  order it was opened. Until then nothing is numbered live, and the console
  keeps today's keys. A repository added later is read the same way and
  numbered after what is already numbered. It makes no GitHub write.
- **History is linked by branch and keywords only.** A historical pull request
  joins the issue its branch was cut for, or else the earliest-opened issue of
  its own repository that its body's closing keywords name into the default
  branch. Live deliveries and the reconciler's sweep also use GitHub's closing
  references, across managed repositories. A closed pull request whose link
  only GraphQL could have found gets an item of its own, and that cost is
  accepted.
- **Automatic links.** A request gets its item when it is created, in the same
  transaction. The issue intake files from it joins that item: an issue that
  had an item of its own first is merged into the request's, and a second
  request filed into the same issue is merged into the first one's. A pull
  request joins its branch's issue (`ownIssueOf`; a person's in-repository
  branch counts, a fork's never does). Failing that, it joins the
  lowest-numbered item among the issues it closes; failing both, it gets an
  item of its own. Its claim is worked out again when it opens, is reopened,
  is edited or is marked ready. An issue nothing claims gets its own item.
- **Automatic linking never overrides a person.** A link with `linked_by` set
  is never moved. Automatic linking never merges two items that each hold an
  issue, and never moves an issue's link.
- **A restore keeps free numbers and renumbers taken ones.** History in an
  archive carries `workItems`. A restore keeps each archived number that no
  item here holds. A taken one gets the next free number, which the restore
  counts and says. The sequence is moved past the highest number. The restore
  can be undone, and the numbers an undo frees are not handed out again. An
  archive without `workItems` restores as before, and the history read numbers
  what it lacks.

## What this rules out

- **A column on `issues`, `requests` or `tasks`.** A pull request has no row of
  its own, and a work item can hold several issues once a person links them
  (#27). A link table holds both without a new table per kind.
- **Numbering live while the history is read.** New work would take the low
  numbers, and the oldest work would be numbered last.
- **GitHub's closing references for history.** Batched at 100 pull requests
  per query, they would be exact. But they would be a second history read,
  with its own paging and rate limit, and would only change which item an
  old, closed pull request with no keywords joins. Its own item is an
  acceptable answer, and #27's linking by hand fixes any that matter.
- **Keeping the history read's rows after numbering.** They would be a stale
  copy of GitHub. The links' snapshots are what is kept.
- **Writing the number to GitHub** (a label, a title prefix, a comment). The
  person ruled it out on #27: the number is the install's, and a second
  install reading the same repositories numbers them its own way.
- **Reusing a freed number** after a merge, an undo, or a failed transaction:
  a key someone wrote down would then name other work.

## What would make this worth revisiting

- A repository's history becoming too large to read once on upgrade at about
  two calls per 100 issues and pull requests, or GitHub offering a cheap bulk
  read of closing references, which would make history linking exact.
- Two installs needing to share numbers. The number is per install by design,
  so this would need one numbering authority.
- The number of items an automatic claim gets wrong becoming large enough that
  linking by hand does not keep up.
