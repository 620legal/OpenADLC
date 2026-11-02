import { query, queryOne } from '../client.js';
import type { Role } from './users.js';

/**
 * A person's message to a live task, waiting for its session's next turn.
 *
 * Each row ends once: `taken` by the task's own runner, or `returned` when
 * the task stopped being live first, for the bridge to start the role's work
 * with it as a new message would. Both are one `update … where state =
 * 'queued' returning`, so when a take and a settle race for a row, one of
 * them gets it and the other sees nothing. Kept as thread events instead, a
 * message could have been read live and started again, or neither; kept in
 * the bridge's memory, a restart lost it. See
 * docs/adr/0028-a-message-to-a-running-task-waits-in-its-inbox.md.
 */
export interface InboxRow {
  id: string;
  taskId: string;
  messageId: string;
  botId: string;
  role: string;
  subjectRef: string;
  sender: string;
  senderAccess: Role;
  text: string;
  githubUrl: string | null;
  state: 'queued' | 'taken' | 'returned';
  createdAt: string;
  settledAt: string | null;
}

interface Row {
  id: string;
  task_id: string;
  message_id: string;
  bot_id: string;
  role: string;
  subject_ref: string;
  sender: string;
  sender_access: Role;
  text: string;
  github_url: string | null;
  state: InboxRow['state'];
  created_at: Date;
  settled_at: Date | null;
}

const COLUMNS = 'id, task_id, message_id, bot_id, role, subject_ref, sender, sender_access, text, github_url, state, created_at, settled_at';

function toRow(row: Row): InboxRow {
  return {
    id: row.id,
    taskId: row.task_id,
    messageId: row.message_id,
    botId: row.bot_id,
    role: row.role,
    subjectRef: row.subject_ref,
    sender: row.sender,
    senderAccess: row.sender_access,
    text: row.text,
    githubUrl: row.github_url,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    settledAt: row.settled_at?.toISOString() ?? null,
  };
}

/**
 * A task a message may wait for: queued, whose runner reads its inbox before
 * its first turn, or running on an engine that takes messages. Paused is not
 * live, whoever paused it: its next session is a new task's worth of reading.
 */
const LIVE = `(t.state = 'queued' or (t.state = 'running' and t.takes_messages is true))`;

/**
 * Queues a message for a task, in the same statement that checks the task is
 * live. Null when it is not, any more: the task ended between the decision
 * and this write, and the caller decides again.
 */
export async function enqueue(input: {
  taskId: string;
  messageId: string;
  botId: string;
  role: string;
  subjectRef: string;
  sender: string;
  senderAccess: Role;
  text: string;
  githubUrl: string | null;
}): Promise<InboxRow | null> {
  const row = await queryOne<Row>(
    `insert into task_inbox (task_id, message_id, bot_id, role, subject_ref, sender, sender_access, text, github_url)
     select t.id, $2, $3, $4, $5, $6, $7, $8, $9
     from tasks t
     where t.id = $1 and ${LIVE}
     returning ${COLUMNS}`,
    [input.taskId, input.messageId, input.botId, input.role, input.subjectRef, input.sender, input.senderAccess, input.text, input.githubUrl],
  );
  return row ? toRow(row) : null;
}

/**
 * What the task's session takes for its next turn, oldest first, each row
 * now `taken`. Only while the task is running: a task that ended has nobody
 * to read it, and its rows are the settle's.
 */
export async function take(taskId: string): Promise<InboxRow[]> {
  const rows = await query<Row>(
    `update task_inbox i set state = 'taken', settled_at = now()
     where i.task_id = $1 and i.state = 'queued'
       and exists (select 1 from tasks t where t.id = i.task_id and t.state = 'running')
     returning ${COLUMNS.split(', ').map((column) => `i.${column}`).join(', ')}`,
    [taskId],
  );
  return rows.map(toRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The rows whose task is no longer queued or running, now `returned`, oldest
 * first: one task's when named (its runner said it ended), every task's for
 * the sweep that catches a cancel or a host reconcile failed.
 */
export async function settle(taskId?: string): Promise<InboxRow[]> {
  const rows = await query<Row>(
    `update task_inbox i set state = 'returned', settled_at = now()
     where i.state = 'queued'
       and ($1::uuid is null or i.task_id = $1::uuid)
       and not exists (select 1 from tasks t where t.id = i.task_id and t.state in ('queued', 'running'))
     returning ${COLUMNS.split(', ').map((column) => `i.${column}`).join(', ')}`,
    [taskId ?? null],
  );
  return rows.map(toRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
