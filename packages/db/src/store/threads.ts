import { redactSecrets } from '@fleetadlc/shared';
import type { Gate, Message, MessageKind } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

export interface ThreadRow {
  id: string;
  bot_id: string;
  repo_id: string | null;
  subject_ref: string;
  /**
   * The role and the seat of the bot the thread was opened for, as they were
   * then (migration 0028). Seats sharing one GitHub account are told apart by
   * these, not by the bot's name, which follows the account. Null only on a
   * row read by a test that builds threads by hand.
   */
  role?: string | null;
  seat?: string | null;
}

const THREAD_COLUMNS = 'id, bot_id, repo_id, subject_ref, role, seat';

interface MessageRow {
  id: string;
  thread_id: string;
  kind: MessageKind;
  author: string;
  text: string;
  note: string | null;
  payload: Record<string, unknown> | null;
  github_url: string | null;
  at: Date;
}

interface GateRow {
  id: string;
  task_id: string | null;
  thread_id: string | null;
  question: string;
  options: string[];
  state: Gate['state'];
  answer: string | null;
  answered_by: string | null;
  answered_at: Date | null;
  addressed_to: string | null;
  github_comment_url: string | null;
  created_at: Date;
  context?: string | null;
  added_needs_human?: boolean;
}

/**
 * A gate as the bridge reads it to answer it: with whether opening it put
 * `needs-human` on its subject, so answering it takes off only a label the
 * crew's question put there and never a person's hold.
 */
export type GateRecord = Gate & { addedNeedsHuman?: boolean };

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind,
    author: row.author,
    text: row.text,
    note: row.note,
    payload: row.payload,
    githubUrl: row.github_url,
    at: row.at.toISOString(),
  };
}

function toGate(row: GateRow): GateRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    threadId: row.thread_id,
    question: row.question,
    options: row.options,
    state: row.state,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at?.toISOString() ?? null,
    addressedTo: row.addressed_to,
    githubCommentUrl: row.github_comment_url,
    // Optional on the type; a query that did not select it leaves it out
    // rather than failing every gate it reads.
    ...(row.created_at ? { createdAt: row.created_at.toISOString() } : {}),
    ...(row.context !== undefined ? { context: row.context } : {}),
    ...(row.added_needs_human !== undefined ? { addedNeedsHuman: row.added_needs_human } : {}),
  };
}

export async function ensureThread(input: {
  botId: string;
  repoId: string | null;
  subjectRef: string;
}): Promise<ThreadRow> {
  // The role and seat are the bot's when the thread is first written and are
  // never changed after: a seat given another role later must not move what
  // was said in the old one. `coalesce` only fills a row written before 0028.
  const row = await queryOne<ThreadRow>(
    `insert into threads (bot_id, repo_id, subject_ref, role, seat)
     select $1, $2, $3, b.role, b.slot from bots b where b.id = $1
     on conflict (bot_id, subject_ref) do update set
       repo_id = coalesce(excluded.repo_id, threads.repo_id),
       role = coalesce(threads.role, excluded.role),
       seat = coalesce(threads.seat, excluded.seat),
       updated_at = now()
     returning ${THREAD_COLUMNS}`,
    [input.botId, input.repoId, input.subjectRef],
  );
  if (!row) throw new Error(`failed to ensure a thread: there is no bot ${input.botId}`);
  return row;
}

export async function listThreadsForBot(botId: string): Promise<ThreadRow[]> {
  return query<ThreadRow>(
    `select ${THREAD_COLUMNS} from threads where bot_id = $1 order by updated_at desc`,
    [botId],
  );
}

/** Every bot's thread about one subject: a subject a second bot picked up has two. */
export async function listThreadsForSubject(subjectRef: string): Promise<ThreadRow[]> {
  return query<ThreadRow>(
    `select ${THREAD_COLUMNS} from threads where subject_ref = $1 order by created_at`,
    [subjectRef],
  );
}

/**
 * Every thread about any of a work item's subjects — its request, its issue,
 * its pull request — whichever bot each is with, oldest first. The item's
 * conversation is these read together.
 */
export async function listThreadsForSubjects(subjectRefs: readonly string[]): Promise<ThreadRow[]> {
  if (subjectRefs.length === 0) return [];
  return query<ThreadRow>(
    `select ${THREAD_COLUMNS} from threads where subject_ref = any($1::text[]) order by created_at`,
    [[...subjectRefs]],
  );
}

export async function addMessage(input: {
  threadId: string;
  kind: MessageKind;
  author: string;
  text: string;
  note?: string | null;
  payload?: Record<string, unknown> | null;
  githubUrl?: string | null;
}): Promise<Message> {
  const row = await queryOne<MessageRow>(
    `insert into messages (thread_id, kind, author, text, note, payload, github_url)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, thread_id, kind, author, text, note, payload, github_url, at`,
    [
      input.threadId,
      input.kind,
      input.author,
      // A thread shows what a task said and why it failed, and a failed git
      // command's reason once carried the bot's token; see `redactSecrets`.
      redactSecrets(input.text),
      input.note == null ? null : redactSecrets(input.note),
      input.payload ? JSON.stringify(input.payload) : null,
      input.githubUrl ?? null,
    ],
  );
  if (!row) throw new Error('failed to add message');
  await query('update threads set updated_at = now() where id = $1', [input.threadId]);
  return toMessage(row);
}

export async function listMessages(threadIds: readonly string[], limit = 200): Promise<Message[]> {
  if (threadIds.length === 0) return [];
  const rows = await query<MessageRow>(
    `select id, thread_id, kind, author, text, note, payload, github_url, at
     from messages where thread_id = any($1) order by at desc limit $2`,
    [threadIds, limit],
  );
  return rows.map(toMessage).reverse();
}

/**
 * A cheap answer to "has anything happened to this bot's threads".
 *
 * The stream watches this rather than re-reading the messages: a panel left
 * open overnight is a query a second, and returning two hundred rows each time
 * to discover that none of them changed is most of the cost of the polling this
 * replaces. Message ids are random, so `latest` is only the greatest id, not
 * the newest message: `count` is what notices a message added or deleted. The
 * two together miss a deletion and an addition between the same two probes,
 * when the new id sorts below the greatest.
 */
export async function threadWatermark(botId: string): Promise<{ latest: string; count: number }> {
  const row = await queryOne<{ latest: string | null; count: string }>(
    `select max(m.id::text) as latest, count(*)::text as count
       from messages m
       join threads t on t.id = m.thread_id
      where t.bot_id = $1`,
    [botId],
  );
  return { latest: row?.latest ?? '', count: Number(row?.count ?? 0) };
}

/**
 * The same cheap question as `threadWatermark`, about a work item's subjects
 * rather than one bot: a message added or removed in any thread about them, a
 * question asked or answered, a task started, paused or ended. The item view
 * shows all of those, and a watermark of messages alone left it showing a
 * task as running after it had ended.
 */
export async function subjectsWatermark(subjectRefs: readonly string[]): Promise<string> {
  if (subjectRefs.length === 0) return '';
  const row = await queryOne<{ latest: string | null; count: string; gates: Date | null; tasks: Date | null }>(
    `select (select max(m.id::text) from messages m join threads t on t.id = m.thread_id where t.subject_ref = any($1::text[])) as latest,
            (select count(*)::text from messages m join threads t on t.id = m.thread_id where t.subject_ref = any($1::text[])) as count,
            (select max(g.updated_at) from gates g
               left join tasks k on k.id = g.task_id
               left join threads t on t.id = g.thread_id
              where k.subject_ref = any($1::text[]) or t.subject_ref = any($1::text[])) as gates,
            (select max(k.updated_at) from tasks k where k.subject_ref = any($1::text[])) as tasks`,
    [[...subjectRefs]],
  );
  return [row?.latest ?? '', row?.count ?? '0', row?.gates?.toISOString() ?? '', row?.tasks?.toISOString() ?? ''].join(':');
}

export async function createGate(input: {
  taskId: string | null;
  threadId: string | null;
  question: string;
  options: string[];
  addressedTo?: string | null;
  githubCommentUrl?: string | null;
  /** Whether opening it put `needs-human` on its subject; a person's hold it found there is not its own. */
  addedNeedsHuman?: boolean;
}): Promise<GateRecord> {
  const row = await queryOne<GateRow>(
    `insert into gates (task_id, thread_id, question, options, addressed_to, github_comment_url, added_needs_human)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, task_id, thread_id, question, options, state, answer, answered_by, answered_at, addressed_to, github_comment_url, created_at,
               added_needs_human`,
    [
      input.taskId,
      input.threadId,
      // The bridge redacts a gate as it comes in; this is the backstop, as for
      // a message, so no caller can store a token in a question.
      redactSecrets(input.question),
      input.options.map((option) => redactSecrets(option)),
      input.addressedTo ?? null,
      input.githubCommentUrl ?? null,
      input.addedNeedsHuman ?? true,
    ],
  );
  if (!row) throw new Error('failed to create gate');
  return toGate(row);
}

export async function listOpenGates(): Promise<Gate[]> {
  const rows = await query<GateRow>(
    // With the bot's last message before it in its conversation, since the
    // question it ended on: what the card shows the question is about.
    `select g.id, g.task_id, g.thread_id, g.question, g.options, g.state, g.answer, g.answered_by, g.answered_at,
            g.addressed_to, g.github_comment_url, g.created_at,
            (select m.text from messages m
              where m.thread_id = g.thread_id and m.kind = 'bot' and m.at <= g.created_at
                and m.at > coalesce((select max(q.at) from messages q
                                      where q.thread_id = g.thread_id and q.kind in ('gate', 'you') and q.at < g.created_at),
                                    '-infinity'::timestamptz)
              order by m.at desc limit 1) as context
     from gates g where g.state = 'open' order by g.created_at`,
  );
  return rows.map(toGate);
}

/**
 * Every gate asked on a subject, by whichever of its tasks asked it, oldest
 * first. A request's triage can be paused and resumed, or started again after
 * a failure, so what was asked and answered belongs to the subject rather than
 * to the task that happened to ask it.
 */
export async function listGatesForSubject(subjectRef: string): Promise<Gate[]> {
  const rows = await query<GateRow>(
    `select g.id, g.task_id, g.thread_id, g.question, g.options, g.state, g.answer, g.answered_by, g.answered_at,
            g.addressed_to, g.github_comment_url, g.created_at
       from gates g
       join tasks t on t.id = g.task_id
      where t.subject_ref = $1
      order by g.created_at`,
    [subjectRef],
  );
  return rows.map(toGate);
}

/**
 * The gates still open on a subject, asked by any task on it: what still
 * needs `needs-human` there when one of them is answered.
 */
export async function listOpenGatesOnSubject(subjectRef: string): Promise<GateRecord[]> {
  const rows = await query<GateRow>(
    `select g.id, g.task_id, g.thread_id, g.question, g.options, g.state, g.answer, g.answered_by, g.answered_at,
            g.addressed_to, g.github_comment_url, g.created_at, g.added_needs_human
       from gates g
       join tasks t on t.id = g.task_id
      where t.subject_ref = $1 and g.state = 'open'
      order by g.created_at`,
    [subjectRef],
  );
  return rows.map(toGate);
}

/**
 * Every gate the given tasks asked, oldest first, in one read. The board asks
 * this of every task a person's answer may have ended, each time it reads
 * what needs you, and one read per task was a query each fifteen seconds for
 * every one of them.
 */
export async function listGatesForTasks(taskIds: readonly string[]): Promise<Gate[]> {
  if (taskIds.length === 0) return [];
  const rows = await query<GateRow>(
    `select id, task_id, thread_id, question, options, state, answer, answered_by, answered_at, addressed_to, github_comment_url, created_at
       from gates
      where task_id = any($1::uuid[])
      order by created_at`,
    [[...taskIds]],
  );
  return rows.map(toGate);
}

export async function getGate(id: string): Promise<GateRecord | null> {
  const row = await queryOne<GateRow>(
    `select id, task_id, thread_id, question, options, state, answer, answered_by, answered_at, addressed_to, github_comment_url, created_at,
            added_needs_human
     from gates where id = $1`,
    [id],
  );
  return row ? toGate(row) : null;
}

export async function answerGate(id: string, answer: string, answeredBy: string): Promise<Gate | null> {
  const row = await queryOne<GateRow>(
    `update gates set state = 'answered', answer = $2, answered_by = $3, answered_at = now(), updated_at = now()
     where id = $1 and state = 'open'
     returning id, task_id, thread_id, question, options, state, answer, answered_by, answered_at, addressed_to, github_comment_url, created_at`,
    [id, answer, answeredBy],
  );
  return row ? toGate(row) : null;
}

/**
 * Hands a claimed gate back, for an answer whose work failed after it claimed
 * it: an approval that could not edit the issue is finished by answering it
 * again, which a closed gate would refuse. Only the claim this answer made is
 * undone, so a gate someone else answered since stays answered.
 */
export async function reopenGate(id: string, answer: string, answeredBy: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update gates set state = 'open', answer = null, answered_by = null, answered_at = null, updated_at = now()
     where id = $1 and state = 'answered' and answer = $2 and answered_by = $3
     returning id`,
    [id, answer, answeredBy],
  );
  return Boolean(row);
}

/**
 * Claims a GitHub comment as the answer to a gate. False when it already
 * answered one: a delivery handled twice must not apply the same reply to
 * whichever question is open by then.
 */
export async function claimGateReply(commentId: number, gateId: string): Promise<boolean> {
  const row = await queryOne<{ comment_id: string }>(
    `insert into gate_replies (comment_id, gate_id) values ($1, $2)
     on conflict (comment_id) do nothing
     returning comment_id`,
    [commentId, gateId],
  );
  return Boolean(row);
}

/** An open question in one repository, with the subject its task was on. */
export type RepoGate = Gate & { subjectRef: string | null };

/**
 * The questions still open in one repository, oldest first: asked by a task
 * there, or in a thread about it. What removing the repository would close.
 */
export async function listOpenGatesInRepo(repoId: string): Promise<RepoGate[]> {
  const rows = await query<GateRow & { subject_ref: string | null }>(
    `select g.id, g.task_id, g.thread_id, g.question, g.options, g.state, g.answer, g.answered_by, g.answered_at,
            g.addressed_to, g.github_comment_url, g.created_at, coalesce(t.subject_ref, th.subject_ref) as subject_ref
       from gates g
       left join tasks t on t.id = g.task_id
       left join threads th on th.id = g.thread_id
      where g.state = 'open' and coalesce(t.repo_id, th.repo_id) = $1
      order by g.created_at`,
    [repoId],
  );
  return rows.map((row) => ({ ...toGate(row), subjectRef: row.subject_ref }));
}

/**
 * Closes the questions a task left open once the task has been stopped, so
 * they leave Needs you: an answer would resume nothing. Each is audited as
 * `gate.expired` with `reason`, in the same statement.
 */
export async function expireGatesOfTask(taskId: string, actor: string, reason: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `with closed as (
       update gates g set state = 'expired', updated_at = now()
        where g.task_id = $1 and g.state = 'open'
        returning g.id
     ), logged as (
       insert into audit (actor, action, target, payload)
       select $2::text, 'gate.expired', coalesce((select t.subject_ref from tasks t where t.id = $1), 'task'),
              jsonb_build_object('gateId', closed.id, 'reason', $3::text)
         from closed
     )
     select id from closed`,
    [taskId, actor, reason],
  );
  return rows.map((row) => row.id);
}

/**
 * Closes every question still open in a repository whose task is over, or
 * that no task asked, when the repository leaves OpenADLC. One asked by a task
 * that is still unfinished is left open: that task could not be stopped, and
 * its question goes with it when the removal is run again. Audited as
 * `gate.expired` with `reason`.
 */
export async function expireEndedGatesInRepo(repoId: string, actor: string, reason: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `with closing as (
       select g.id, coalesce(t.subject_ref, th.subject_ref, 'repository') as subject_ref
         from gates g
         left join tasks t on t.id = g.task_id
         left join threads th on th.id = g.thread_id
        where g.state = 'open'
          and coalesce(t.repo_id, th.repo_id) = $1
          and (t.id is null or t.state not in ('queued', 'running', 'paused'))
     ), closed as (
       update gates g set state = 'expired', updated_at = now()
         from closing
        where g.id = closing.id and g.state = 'open'
        returning g.id, closing.subject_ref
     ), logged as (
       insert into audit (actor, action, target, payload)
       select $2::text, 'gate.expired', closed.subject_ref, jsonb_build_object('gateId', closed.id, 'reason', $3::text)
         from closed
     )
     select id from closed`,
    [repoId, actor, reason],
  );
  return rows.map((row) => row.id);
}
