import { hasIgnoreLabel, type BoardCard, type StageKey } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

interface IssueRow {
  id: string;
  repo_id: string;
  repo_name: string;
  number: number;
  title: string;
  stage: StageKey;
  labels: string[];
  declared_paths: string[];
  pr_changed_paths: string[];
  body: string;
  url: string | null;
  pr_number: number | null;
  updated_at: Date;
  created_at: Date;
  vouched_title?: string | null;
  vouched_body?: string | null;
  vouched_by?: string | null;
  vouched_at?: Date | null;
}

const SELECT = `
  select i.id, i.repo_id, r.name as repo_name, i.number, i.title, i.stage, i.labels,
         i.declared_paths, i.pr_changed_paths, i.body, i.url, i.pr_number, i.updated_at, i.created_at,
         i.vouched_title, i.vouched_body, i.vouched_by, i.vouched_at
  from issues i join repos r on r.id = i.repo_id
`;

/**
 * The title and body a person with access, or the crew, last stood behind on
 * an issue whose author OpenADLC does not act for: what the crew reads,
 * whatever the author has edited it to since.
 */
export interface VouchedText {
  title: string;
  body: string;
  /** Who vouched: the person who acted on it, or the crew account that rewrote it. */
  by: string;
  at: string;
}

export interface IssueRecord {
  id: string;
  repoId: string;
  repoName: string;
  number: number;
  title: string;
  stage: StageKey;
  labels: string[];
  declaredPaths: string[];
  /** What the pull request actually touches, once there is one. */
  prChangedPaths: string[];
  /** What the issue says, including what it declares it waits for. */
  body: string;
  url: string | null;
  prNumber: number | null;
  updatedAt: string;
  /** When the issue was filed. How long it has been waiting, which is its age. */
  createdAt: string;
  /** The text vouched for, on a stranger's issue; null on every other (`setVouched`). */
  vouched?: VouchedText | null;
}

function toIssue(row: IssueRow): IssueRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    repoName: row.repo_name,
    number: row.number,
    title: row.title,
    stage: row.stage,
    labels: row.labels,
    declaredPaths: row.declared_paths,
    prChangedPaths: row.pr_changed_paths ?? [],
    body: row.body ?? '',
    url: row.url,
    prNumber: row.pr_number,
    updatedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    vouched:
      row.vouched_at && row.vouched_title !== null && row.vouched_title !== undefined
        ? { title: row.vouched_title, body: row.vouched_body ?? '', by: row.vouched_by ?? '', at: row.vouched_at.toISOString() }
        : null,
  };
}

const PRIORITY_LABELS = ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3'] as const;

/**
 * Where a priority label puts an issue in the order.
 *
 * Anything unlabelled ranks after every labelled issue. It used to share the
 * bottom rank with `priority:p3`, which meant an old issue nobody had
 * prioritised outranked a p3 somebody had — "not triaged" reading as "as
 * urgent as the lowest priority we have" is the wrong way round.
 */
export function priorityRank(labels: readonly string[]): number {
  const index = PRIORITY_LABELS.findIndex((label) => labels.includes(label));
  return index === -1 ? PRIORITY_LABELS.length : index;
}

/**
 * The order "next" is in, for the board and the dispatcher alike.
 *
 * These were two orders: the dispatcher leased by priority then age, and the
 * board showed whatever was touched last, so the card on top of a column was
 * not the card the crew would pick up next. A comment on a p3 pushed it above a
 * p0 that had been waiting three days. One comparator, used by both queries, is
 * what stops them disagreeing again.
 */
export function byNextFirst(a: IssueRecord, b: IssueRecord): number {
  const priority = priorityRank(a.labels) - priorityRank(b.labels);
  if (priority !== 0) return priority;

  const age = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (age !== 0) return age;

  // Only so that two issues filed in the same instant — which seeding and
  // importing both do — come back in the same order on every read.
  return a.number - b.number || a.repoName.localeCompare(b.repoName);
}

export async function upsertIssue(input: {
  repoId: string;
  number: number;
  title: string;
  stage: StageKey;
  labels: string[];
  declaredPaths: string[];
  url: string | null;
  prNumber: number | null;
  /** What the issue says. Absent leaves whatever was already stored. */
  body?: string | null;
}): Promise<IssueRecord> {
  const row = await queryOne<IssueRow>(
    `with upserted as (
       insert into issues (repo_id, number, title, stage, labels, declared_paths, url, pr_number, body, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9, ''), now())
       on conflict (repo_id, number) do update set
         title = excluded.title,
         stage = excluded.stage,
         labels = excluded.labels,
         declared_paths = excluded.declared_paths,
         url = coalesce(excluded.url, issues.url),
         pr_number = coalesce(excluded.pr_number, issues.pr_number),
         -- Absent leaves what is stored: a caller that does not know the body
         -- must not erase it.
         body = coalesce($9, issues.body),
         updated_at = now()
       returning *
     )
     select u.id, u.repo_id, r.name as repo_name, u.number, u.title, u.stage, u.labels,
            u.declared_paths, u.pr_changed_paths, u.body, u.url, u.pr_number, u.updated_at, u.created_at,
            u.vouched_title, u.vouched_body, u.vouched_by, u.vouched_at
     from upserted u join repos r on r.id = u.repo_id`,
    [
      input.repoId,
      input.number,
      input.title,
      input.stage,
      input.labels,
      input.declaredPaths,
      input.url,
      input.prNumber,
      input.body ?? null,
    ],
  );
  if (!row) throw new Error('failed to upsert issue');
  return toIssue(row);
}

/**
 * Keeps the text vouched for on an issue: when a person with access takes up a
 * stranger's issue, and each time that person, or the crew rewriting it,
 * stands behind new text. `upsertIssue` leaves it as it is.
 */
export async function setVouched(repoId: string, number: number, text: { title: string; body: string; by: string }): Promise<void> {
  await query(
    `update issues set vouched_title = $3, vouched_body = $4, vouched_by = $5, vouched_at = now()
     where repo_id = $1 and number = $2`,
    [repoId, number, text.title, text.body, text.by],
  );
}

export async function listIssues(repoName?: string): Promise<IssueRecord[]> {
  const rows = await query<IssueRow>(`${SELECT} where ($1::text is null or r.name = $1)`, [repoName ?? null]);
  // Ordered here rather than in SQL so that this list and the dispatcher's
  // cannot drift: see `byNextFirst`.
  return rows.map(toIssue).sort(byNextFirst);
}

/**
 * The issues a builder could be given: in build, switched on with `start:now`,
 * with no question to a person outstanding, not waiting on triage, with no
 * do: label but `do:ai` (`do:human`, `do:product` and `do:legal` each wait on
 * a person, and a builder leased a product or legal decision and shipped it
 * with nobody making it), and not labelled `fleetadlc:ignore`. The dispatcher
 * decides among these in `byNextFirst` order — the order the board shows them
 * in — and what they wait on is read from their dependencies there, not from
 * a `blocked` label.
 */
export async function listRoutableIssues(repoId: string): Promise<IssueRecord[]> {
  const rows = await query<IssueRow>(
    `${SELECT}
     where i.repo_id = $1
       and i.stage = 'build'
       and 'start:now' = any(i.labels)
       and not ('needs-human' = any(i.labels))
       and not ('needs-triage' = any(i.labels))
       and not exists (select 1 from unnest(i.labels) as l where l like 'do:%' and l <> 'do:ai')
       and not (i.labels && array['fleetadlc:ignore', 'fleet:ignore']::text[])`,
    [repoId],
  );
  return rows.map(toIssue).sort(byNextFirst);
}

/**
 * The labels GitHub has, on a row that is already on the board.
 *
 * An insert has to name a stage. An issue labelled `fleetadlc:ignore` with no
 * stage of its own is not intake's, and inserting it as one is what the
 * sweep then staffs — the label replaced by a stage. Updating nothing, when
 * the issue was never stored, is the point.
 */
export async function setIssueLabels(repoId: string, number: number, labels: readonly string[]): Promise<void> {
  await query(`update issues set labels = $3, updated_at = now() where repo_id = $1 and number = $2`, [
    repoId,
    number,
    labels,
  ]);
}

/** An issue whose change is being made: see `workInFlight`. */
export interface WorkInFlight {
  number: number;
  /** The files it said it would touch and the files its pull request does. */
  paths: string[];
  /** Whether a build or a patch round of it is queued, running or waiting on a person now. */
  building: boolean;
}

/**
 * The changes being made in a repository, read from the work itself: every
 * issue in build or review that a builder has started or that has a pull
 * request. These are what a second change to the same files would collide
 * with. Nothing here is a record that has to be released: an issue that
 * merges, closes or leaves those stages is simply not in the list.
 */
export async function workInFlight(repoId: string): Promise<WorkInFlight[]> {
  const rows = await query<{ number: number; declared_paths: string[] | null; pr_changed_paths: string[] | null; building: boolean }>(
    `select i.number, i.declared_paths, i.pr_changed_paths,
            exists (select 1 from tasks t
                     where t.state in ('queued', 'running', 'paused')
                       and ((t.kind = 'implement' and t.subject_ref = r.name || '#' || i.number)
                            -- A patch round: work sent back from review, in build again
                            -- with its lease and its pull request. It is filed under the
                            -- pull request, and leasing the issue beside it would start a
                            -- second build of the same change.
                            or (t.kind = 'patch' and i.pr_number is not null and t.subject_ref = r.name || '#' || i.pr_number))) as building
       from issues i join repos r on r.id = i.repo_id
      where i.repo_id = $1
        and i.stage in ('build', 'review')
        and (i.pr_number is not null
             or exists (select 1 from tasks t where t.kind = 'implement' and t.subject_ref = r.name || '#' || i.number))`,
    [repoId],
  );
  return rows.map((row) => ({
    number: row.number,
    paths: [...new Set([...(row.declared_paths ?? []), ...(row.pr_changed_paths ?? [])])],
    building: row.building,
  }));
}

export async function setIssueStage(repoId: string, number: number, stage: StageKey): Promise<void> {
  await query(
    `update issues set
       stage = $3,
       labels = array_append(
         -- sdlc: is the stage prefix from before the rename; a move replaces it too.
         -- By name: adlc:ci shares the prefix and is no stage.
         array(select label from unnest(labels) as label
                where label not in ('adlc:intake','adlc:spec','adlc:build','adlc:review','adlc:merged','adlc:done',
                                    'sdlc:intake','sdlc:spec','sdlc:build','sdlc:review','sdlc:merged','sdlc:done')),
         $4
       ),
       updated_at = now()
     where repo_id = $1 and number = $2`,
    [repoId, number, stage, `adlc:${stage}`],
  );
}

/** Drops an issue from the read model; GitHub remains its record. */
export async function forget(repoId: string, number: number): Promise<void> {
  await query('delete from issues where repo_id = $1 and number = $2', [repoId, number]);
}

/**
 * The board's cards. Not an issue labelled `fleetadlc:ignore`: the board is
 * for the work the crew does, and a person said the crew leaves that one
 * alone. Its row is kept, so taking the label off brings the card back where
 * it was; the bridge leaves its pull request off the board as well
 * (`ignoredSubjects` in apps/bridge/src/work.ts).
 */
export async function boardCards(repoName?: string): Promise<BoardCard[]> {
  const issues = (await listIssues(repoName)).filter((issue) => !hasIgnoreLabel(issue.labels));
  const gateRefs = await query<{ subject_ref: string }>(
    `select distinct t.subject_ref
     from gates g join tasks t on t.id = g.task_id
     where g.state = 'open'`,
  );
  const withGate = new Set(gateRefs.map((row) => row.subject_ref));
  const assignees = await query<{ subject_ref: string; bot: string }>(
    `select t.subject_ref, b.name as bot
     from tasks t join bots b on b.id = t.bot_id
     where t.state in ('queued','running','paused')`,
  );

  return issues.map((issue) => {
    const ref = `${issue.repoName}#${issue.number}`;
    return {
      repo: issue.repoName,
      ref,
      title: issue.title,
      stage: issue.stage,
      assignees: assignees.filter((row) => row.subject_ref === ref).map((row) => row.bot),
      gateOpen: withGate.has(ref),
      url: issue.url,
      labels: issue.labels,
      updatedAt: issue.updatedAt,
    };
  });
}

/**
 * Records what an open pull request changes, so a second issue can be checked
 * against it rather than only against other leases' declared paths.
 */
export async function setPullRequestPaths(
  repoId: string,
  issueNumber: number,
  paths: string[],
): Promise<void> {
  await query('update issues set pr_changed_paths = $3, updated_at = now() where repo_id = $1 and number = $2', [
    repoId,
    issueNumber,
    paths,
  ]);
}

/**
 * Which pull request an issue's change is in. Nothing wrote this, so every
 * issue's was empty: the board could not tie a pull request's reviews to its
 * card, the dispatcher never saw an open pull request's files, and the gate sweep
 * had no pull request to settle.
 */
export async function setPullRequestNumber(repoId: string, issueNumber: number, prNumber: number): Promise<void> {
  await query(
    'update issues set pr_number = $3, updated_at = now() where repo_id = $1 and number = $2 and pr_number is distinct from $3',
    [repoId, issueNumber, prNumber],
  );
}

/**
 * Issues held by the `blocked` label, which is what this list is for. One
 * labelled `fleetadlc:ignore` is left out: the dispatcher unblocks what this
 * returns, and unblocking adds `start:now`, a change the crew makes to an
 * issue it was told to leave alone.
 */
export async function listBlockedIssues(repoId: string): Promise<IssueRecord[]> {
  const rows = await query<IssueRow>(
    `${SELECT} where i.repo_id = $1 and 'blocked' = any(i.labels) and not (i.labels && array['fleetadlc:ignore', 'fleet:ignore']::text[])`,
    [repoId],
  );
  return rows.map(toIssue);
}

/** One issue by number, for resolving what another one waits for. */
export async function getIssue(repoId: string, number: number): Promise<IssueRecord | null> {
  const rows = await query<IssueRow>(`${SELECT} where i.repo_id = $1 and i.number = $2`, [repoId, number]);
  return rows[0] ? toIssue(rows[0]) : null;
}

/**
 * Swaps `blocked` for `start:now` on the stored row.
 *
 * GitHub is the system of record and `Automation.setBlocked` is what writes it
 * there; this keeps the board from showing an issue as blocked until the
 * webhook comes back, the same way a stage move does.
 */
export async function setBlockedLabel(repoId: string, number: number, blocked: boolean): Promise<void> {
  await query(
    `update issues
        set labels = case
              when $3 then array_append(array_remove(labels, 'start:now'), 'blocked')
              else array_append(array_remove(labels, 'blocked'), 'start:now')
            end,
            updated_at = now()
      where repo_id = $1 and number = $2
        and ($3 or 'blocked' = any(labels))`,
    [repoId, number, blocked],
  );
}

/** Marks the stored row as needing intake, and takes it out of the routable set. */
export async function setTriageLabel(repoId: string, number: number): Promise<void> {
  await query(
    `update issues
        set labels = array_append(array_remove(labels, 'start:now'), 'needs-triage'),
            updated_at = now()
      where repo_id = $1 and number = $2 and not ('needs-triage' = any(labels))`,
    [repoId, number],
  );
}
