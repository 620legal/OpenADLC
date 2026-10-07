/**
 * The board `seed.ts --scripted-board` writes: a card in each column, an open
 * gate, running tasks (named sessions, but no `sessions` rows: hostd writes
 * those), and ledger lines with made-up, non-zero numbers.
 *
 * It lives apart from seed.ts because seed.ts is a program. Its last line runs
 * the seed, unconditionally, so a test that wants the board imports it from
 * here instead of importing the program and hoping a guard stops it.
 */
import { createHash } from 'node:crypto';
import { withTransaction } from '../client.js';
import * as bots from '../store/bots.js';
import * as costs from '../store/costs.js';
import * as issues from '../store/issues.js';
import * as repos from '../store/repos.js';
import * as tasks from '../store/tasks.js';
import * as threads from '../store/threads.js';
import { SCRIPTED_REPO_FULL_NAME } from './scripted-repo.js';

/**
 * The model a demo usage row records for a bot.
 *
 * A bot the console set to `newest:opus` keeps the alias on its row, and the
 * ledger refuses an alias, so the scripted board used to stop at its first
 * usage row. Nothing is listed from a provider here. A family stands in for
 * the id a real task would have resolved to, with the alias beside it, which
 * is the shape a real row has.
 */
const SCRIPTED_RESOLUTION: Record<string, string> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  codex: 'gpt-5-codex',
  grok: 'grok-4',
};

export function scriptedLedgerModel(configured: string): { model: string; modelAlias: string | null } {
  if (!configured.startsWith('newest:')) return { model: configured, modelAlias: null };
  const family = configured.slice('newest:'.length).trim().toLowerCase();
  return { model: SCRIPTED_RESOLUTION[family] ?? `${family}-scripted`, modelAlias: configured };
}

/**
 * On every message and ledger line the board writes: in the message's payload,
 * and as the ledger line's prompt hash, since no prompt produced that spend.
 * The clear deletes only lines that carry it.
 */
const SCRIPTED_BOARD_MARK = 'scripted-board';

/**
 * Subjects the scripted board writes a task for. The intake and implement refs
 * are also the cards those bots appear on, and the threads the console opens.
 */
function scriptedSubjects(repoName: string): { intake: string; implement: string; review: string } {
  return {
    intake: `${repoName}#41`,
    implement: `${repoName}#43`,
    review: `${repoName}#144`,
  };
}

/**
 * The id the board's task on `subject` always has.
 *
 * The dispatcher can lease the same card to the same bot, and that task differs
 * from the board's in nothing the clear could match on. A fixed id is what makes
 * a task the board's, and the gate and ledger lines that hang off it with it.
 */
function scriptedTaskId(repoId: string, subject: string): string {
  const hex = createHash('sha256').update(`${SCRIPTED_BOARD_MARK}:${repoId}:${subject}`).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Drops the rows an earlier run of this board wrote, so the caller can write
 * them again.
 *
 * The cards are an upsert, so a second run already leaves one of each. The
 * task, the thread and the gate were inserts. Every restart added another copy
 * of the same conversation and another copy of the bot's name on the card. The
 * ledger lines for those tasks are replaced in the same pass, which is what
 * re-timestamps them on every restart.
 *
 * Matching on the subject alone deleted every bot's rows on #41, #43 and #144,
 * in whichever repository listed first: on an install with a real one, real
 * tasks, threads and spend, and the budget refresh after it then counted too
 * little. Each statement here names what the board wrote instead, in the
 * repository it writes to.
 *
 * The four deletes are one transaction, so a clear that fails partway leaves
 * the last board whole rather than, say, its gate gone and its task still
 * there. The writes after it go through the stores, on the pool rather than
 * this client, so they are outside it. A run that fails among them leaves part
 * of a board, and every row of that part carries a fixed id or the mark, so the
 * next run's clear takes it.
 */
async function clearScriptedBoard(
  repoId: string,
  subjects: readonly string[],
  taskIds: readonly string[],
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `delete from messages m
         using threads t
        where m.thread_id = t.id
          and t.repo_id = $1
          and t.subject_ref = any($2::text[])
          and m.payload @> $3::jsonb`,
      [repoId, subjects, JSON.stringify({ seed: SCRIPTED_BOARD_MARK })],
    );
    await client.query('delete from gates where task_id = any($1::uuid[])', [taskIds]);
    await client.query('delete from ledger where task_id = any($1::uuid[]) and prompt_hash = $2', [
      taskIds,
      SCRIPTED_BOARD_MARK,
    ]);
    await client.query('delete from tasks where id = any($1::uuid[]) and repo_id = $2', [taskIds, repoId]);
  });
}

/**
 * Writes the board into the stand-in repository, and nowhere else.
 *
 * It used to take whichever repository listed first. With a real one
 * configured, #41 to #46 are somebody's issues, and the cards were upserted
 * over them. The stand-in exists only when nothing else is configured, so an
 * install with a repository of its own gets no board.
 */
export async function seedScriptedBoard(): Promise<void> {
  const repoList = await repos.listRepos();
  const repo = repoList.find((entry) => entry.fullName === SCRIPTED_REPO_FULL_NAME);
  if (!repo) {
    console.log(`[seed] no ${SCRIPTED_REPO_FULL_NAME} repository; the scripted board is written only there`);
    return;
  }

  const crew = await bots.listBots();
  const byRole = (role: string) => crew.find((bot) => bot.role === role);

  const cards = [
    {
      number: 41,
      title: 'Console: show the cost of the task on the card',
      stage: 'intake' as const,
      labels: ['adlc:intake', 'priority:p2', 'area:console', 'do:ai'],
      paths: ['apps/console/'],
    },
    {
      number: 42,
      title: 'Leases: expire a lease that never produced a pull request',
      stage: 'spec' as const,
      labels: ['adlc:spec', 'priority:p1', 'area:dispatcher', 'do:ai', 'touches:schema'],
      paths: ['apps/dispatcher/', 'packages/db/'],
    },
    {
      number: 43,
      title: 'Device flow: re-authorize a bot whose refresh token was revoked',
      stage: 'build' as const,
      labels: ['adlc:build', 'priority:p0', 'area:auth', 'do:ai', 'start:now'],
      paths: ['packages/github/'],
    },
    {
      number: 44,
      title: 'Board: order cards by priority then age',
      stage: 'review' as const,
      labels: ['adlc:review', 'priority:p2', 'area:console', 'do:ai'],
      paths: ['apps/console/src/board/'],
    },
    {
      number: 45,
      title: 'hostd: drop the worktree when a task ends',
      stage: 'merged' as const,
      labels: ['adlc:merged', 'priority:p1', 'area:hostd', 'do:ai'],
      paths: ['apps/hostd/'],
    },
    {
      number: 46,
      title: 'Docs: write the self-hosting guide',
      stage: 'done' as const,
      labels: ['adlc:done', 'priority:p3', 'area:docs', 'do:ai'],
      paths: ['docs/'],
    },
  ];

  for (const card of cards) {
    await issues.upsertIssue({
      repoId: repo.id,
      number: card.number,
      title: card.title,
      stage: card.stage,
      labels: card.labels,
      declaredPaths: card.paths,
      url: `https://github.com/${repo.fullName}/issues/${card.number}`,
      prNumber: card.stage === 'review' || card.stage === 'merged' ? card.number + 100 : null,
    });
  }

  const builder = byRole('implement');
  const reviewer = byRole('review_lead');
  const intake = byRole('intake');
  const subjects = scriptedSubjects(repo.name);
  const ids = {
    intake: scriptedTaskId(repo.id, subjects.intake),
    implement: scriptedTaskId(repo.id, subjects.implement),
    review: scriptedTaskId(repo.id, subjects.review),
  };
  await clearScriptedBoard(
    repo.id,
    [subjects.intake, subjects.implement, subjects.review],
    [ids.intake, ids.implement, ids.review],
  );
  const mark = { seed: SCRIPTED_BOARD_MARK };

  if (builder) {
    const task = await tasks.createTask({
      id: ids.implement,
      botId: builder.id,
      repoId: repo.id,
      kind: 'implement',
      subjectType: 'issue',
      subjectRef: subjects.implement,
      skill: 'implement',
      branch: `agent/${builder.name}/43-device-flow-reauthorize`,
      costCapUsd: 15,
    });
    await tasks.updateTaskState(task.id, 'running', {
      worktree: `/work/${builder.name}/wt/${task.id}`,
      tmuxSession: `${builder.name}/implement`,
    });
    await costs.recordUsage({
      taskId: task.id,
      botId: builder.id,
      engine: builder.engine,
      ...scriptedLedgerModel(builder.model),
      promptHash: SCRIPTED_BOARD_MARK,
      tokensIn: 18_400,
      tokensOut: 4_200,
      costUsd: 0.31,
    });
    await tasks.addTaskCost(task.id, 0.31);

    const thread = await threads.ensureThread({
      botId: builder.id,
      repoId: repo.id,
      subjectRef: subjects.implement,
    });
    await threads.addMessage({
      threadId: thread.id,
      kind: 'sys',
      author: 'fleetadlc',
      text: `${builder.displayName} started implement on ${subjects.implement}`,
      note: `engine ${builder.engine} · model ${builder.model} · cap $15`,
      payload: mark,
    });
    await threads.addMessage({
      threadId: thread.id,
      kind: 'bot',
      author: builder.name,
      text: 'Re-derived the premises from HEAD. The refresh token is rotated on every use, so the stored copy has to be replaced inside the same transaction that mints the new access token.',
      note: 'plan posted to the issue',
      payload: mark,
    });
  }

  if (intake) {
    const task = await tasks.createTask({
      id: ids.intake,
      botId: intake.id,
      repoId: repo.id,
      kind: 'intake',
      subjectType: 'issue',
      subjectRef: subjects.intake,
      skill: 'triage',
      costCapUsd: 15,
    });
    await tasks.updateTaskState(task.id, 'paused', { exitReason: 'waiting on a person' });

    const thread = await threads.ensureThread({
      botId: intake.id,
      repoId: repo.id,
      subjectRef: subjects.intake,
    });
    await threads.addMessage({
      threadId: thread.id,
      kind: 'bot',
      author: intake.name,
      text: 'Three things are missing before this is routable: which cost the card should show, whether it updates live, and who sees it.',
      payload: mark,
    });
    const gate = await threads.createGate({
      taskId: task.id,
      threadId: thread.id,
      question: 'Should the card show the task cost so far, or the cost of every task on the issue?',
      options: ['this task only', 'every task on the issue', 'both, with the total first'],
      addressedTo: 'owner',
      githubCommentUrl: `https://github.com/${repo.fullName}/issues/41#issuecomment-demo`,
    });
    await threads.addMessage({
      threadId: thread.id,
      kind: 'gate',
      author: intake.name,
      text: gate.question,
      payload: { ...mark, options: gate.options, gateId: gate.id },
      githubUrl: gate.githubCommentUrl,
    });
    await costs.recordUsage({
      taskId: task.id,
      botId: intake.id,
      engine: intake.engine,
      ...scriptedLedgerModel(intake.model),
      promptHash: SCRIPTED_BOARD_MARK,
      tokensIn: 3_200,
      tokensOut: 900,
      costUsd: 0.04,
    });
  }

  if (reviewer) {
    const task = await tasks.createTask({
      id: ids.review,
      botId: reviewer.id,
      repoId: repo.id,
      kind: 'review',
      subjectType: 'pr',
      subjectRef: subjects.review,
      skill: 'pr-review',
      costCapUsd: 15,
    });
    await tasks.updateTaskState(task.id, 'running', { tmuxSession: `${reviewer.name}/pr-review` });
    await costs.recordUsage({
      taskId: task.id,
      botId: reviewer.id,
      engine: reviewer.engine,
      ...scriptedLedgerModel(reviewer.model),
      promptHash: SCRIPTED_BOARD_MARK,
      tokensIn: 12_000,
      tokensOut: 2_600,
      costUsd: 0.2,
    });
  }

  await costs.refreshBudget(costs.currentPeriod(), 0.9);
  console.log(`[seed] demo board in ${repo.name}: ${cards.length} cards, one open gate`);
}
