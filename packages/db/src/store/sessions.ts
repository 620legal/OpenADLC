import { redactSecrets } from '@fleetadlc/shared';
import type { Session, SessionState } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

interface SessionRow {
  id: string;
  bot_id: string;
  task_id: string | null;
  name: string;
  cmd: string;
  state: SessionState;
  pid: number | null;
  last_line: string | null;
  observed_at: Date;
}

const SELECT = `
  select id, bot_id, task_id, name, cmd, state, pid, last_line, observed_at from sessions
`;

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    botId: row.bot_id,
    taskId: row.task_id,
    name: row.name,
    cmd: row.cmd,
    state: row.state,
    pid: row.pid,
    lastLine: row.last_line,
    observedAt: row.observed_at.toISOString(),
  };
}

export async function listSessions(botId?: string): Promise<Session[]> {
  const rows = await query<SessionRow>(
    `${SELECT} where ($1::uuid is null or bot_id = $1) order by name`,
    [botId ?? null],
  );
  return rows.map(toSession);
}

export async function getSession(botId: string, name: string): Promise<Session | null> {
  const row = await queryOne<SessionRow>(`${SELECT} where bot_id = $1 and name = $2`, [botId, name]);
  return row ? toSession(row) : null;
}

/** hostd reports what it actually sees; the console renders exactly that. */
export async function observeSession(input: {
  botId: string;
  taskId: string | null;
  name: string;
  cmd: string;
  state: SessionState;
  pid: number | null;
  lastLine: string | null;
}): Promise<Session> {
  const row = await queryOne<SessionRow>(
    `insert into sessions (bot_id, task_id, name, cmd, state, pid, last_line, observed_at)
     values ($1,$2,$3,$4,$5,$6,$7, now())
     on conflict (bot_id, name) do update set
       task_id = excluded.task_id,
       cmd = excluded.cmd,
       state = excluded.state,
       pid = excluded.pid,
       last_line = excluded.last_line,
       observed_at = now(),
       updated_at = now()
     returning id, bot_id, task_id, name, cmd, state, pid, last_line, observed_at`,
    // Redacted before it is kept: it is whatever the session last printed, a
    // token it echoed included, and it is read back on the crew page.
    [input.botId, input.taskId, input.name, input.cmd, input.state, input.pid, input.lastLine === null ? null : redactSecrets(input.lastLine)],
  );
  if (!row) throw new Error('failed to observe session');
  return toSession(row);
}

export async function removeSession(botId: string, name: string): Promise<void> {
  await query('delete from sessions where bot_id = $1 and name = $2', [botId, name]);
}

export async function removeSessionsForBot(botId: string): Promise<void> {
  await query('delete from sessions where bot_id = $1', [botId]);
}

export async function appendSessionLog(sessionId: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const next = await queryOne<{ seq: string }>(
    'select coalesce(max(seq), 0)::text as seq from session_log where session_id = $1',
    [sessionId],
  );
  let seq = Number(next?.seq ?? 0);
  const values: string[] = [];
  const params: unknown[] = [sessionId];
  for (const line of lines) {
    seq += 1;
    params.push(seq, line);
    values.push(`($1, $${params.length - 1}, $${params.length})`);
  }
  await query(`insert into session_log (session_id, seq, line) values ${values.join(',')}`, params);
  // Rolling window of the last 500 lines. OpenADLC keeps no fuller copy of a
  // session's output: what scrolls out of this window, and out of tmux's own
  // scrollback once the session ends, is gone.
  await query(
    `delete from session_log where session_id = $1 and seq <= $2`,
    [sessionId, Math.max(0, seq - 500)],
  );
}

export async function readSessionPane(sessionId: string, limit = 80): Promise<string[]> {
  const rows = await query<{ line: string }>(
    'select line from session_log where session_id = $1 order by seq desc limit $2',
    [sessionId, limit],
  );
  return rows.map((row) => row.line).reverse();
}
