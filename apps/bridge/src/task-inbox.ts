import { bots, taskInbox, tasks, threads, type InboxRow } from '@openadlc/db';
import { messageBrief, type MessageStarts, type ReadItem } from './message-starts.js';

/**
 * A person's message to a role whose task is live waits in that task's
 * inbox (`task_inbox`) until one of two things happens to it, and only one:
 *
 * - its session takes it: the task's own runner asks at the end of each turn,
 *   with its task token (`POST /internal/tasks/:id/inbox/take`), and the
 *   session reads it as its next turn;
 * - the task stops being live first — it paused, finished, failed, or was
 *   stopped — and it is returned: `MessageStarts.start` runs for it again,
 *   which is what the message would have done had it arrived then. It starts
 *   the role's work with it as `message.md`, or says on the thread why not.
 *
 * Nothing is pushed into a session: hostd and the task's computer have no
 * way in, and need none, since the runner already speaks to the bridge. A
 * task's end is reported by its runner (`/state`), which settles its rows at
 * once; a cancel, or reconcile failing a silent host, ends a task with no
 * runner to report it, and the sweep finds those rows. See
 * docs/adr/0028-a-message-to-a-running-task-waits-in-its-inbox.md.
 */

/** How often the sweep looks for messages left by tasks that ended unreported. */
export const INBOX_SWEEP_MS = 30_000;

export interface TaskInboxDeps {
  store?: Pick<typeof taskInbox, 'take' | 'settle'>;
  starts: Pick<MessageStarts, 'start'>;
  /** The item a message was sent on, read now (`readItem`); null when it is gone. */
  read(subject: string): Promise<ReadItem | null>;
  bot?(id: string): Promise<{ name: string } | null>;
  /** A line in the seat's thread about the message; `threads`, unless a test says. */
  say?(row: InboxRow, text: string): Promise<void>;
}

export class TaskInbox {
  constructor(private readonly deps: TaskInboxDeps) {}

  private get store(): Pick<typeof taskInbox, 'take' | 'settle'> {
    return this.deps.store ?? taskInbox;
  }

  /**
   * What the task's session reads at its next turn, oldest first, each in the
   * words of `message.md`; the thread says each was read. Only this task's:
   * the route checks the token is this task's own.
   */
  async take(taskId: string): Promise<{ id: string; text: string }[]> {
    const rows = await this.store.take(taskId);
    for (const row of rows) {
      await this.say(row, 'read by its session').catch((error: unknown) =>
        console.warn(`[bridge] ${row.subjectRef}: could not say a message was read: ${error instanceof Error ? error.message : error}`),
      );
    }
    return rows.map((row) => ({
      id: row.id,
      text: messageBrief({ identity: row.sender, text: row.text, role: row.role, where: row.githubUrl, whileWorking: true }).content,
    }));
  }

  /**
   * Returns what no session took, from a task no longer live — the one named,
   * or every one for the sweep — and runs each message as it would run now.
   * How many it returned. One that fails to start is said where it was sent,
   * by `start` itself; one whose item is gone is still on its thread.
   */
  async settle(taskId?: string): Promise<number> {
    const rows = await this.store.settle(taskId);
    for (const row of rows) {
      try {
        const [bot, read] = await Promise.all([(this.deps.bot ?? bots.getBotById)(row.botId), this.deps.read(row.subjectRef)]);
        if (!bot || !read) {
          console.warn(`[bridge] ${row.subjectRef}: a message its task did not read starts nothing: its ${bot ? 'item' : 'seat'} is gone`);
          continue;
        }
        await this.deps.starts.start({
          route: { bot: bot.name, botId: row.botId, role: row.role, subject: row.subjectRef },
          read,
          text: row.text,
          identity: row.sender,
          access: row.senderAccess,
          message: { id: row.messageId, githubUrl: row.githubUrl },
        });
      } catch (error) {
        console.warn(`[bridge] ${row.subjectRef}: a message its task did not read could not start its work: ${error instanceof Error ? error.message : error}`);
      }
    }
    return rows.length;
  }

  /** Settles now, for what waited through a restart, and every `everyMs` after. */
  sweep(everyMs = INBOX_SWEEP_MS): () => void {
    const run = () =>
      void this.settle().catch((error: unknown) => console.warn(`[bridge] task inbox sweep: ${error instanceof Error ? error.message : error}`));
    run();
    const timer = setInterval(run, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async say(row: InboxRow, text: string): Promise<void> {
    if (this.deps.say) return this.deps.say(row, text);
    const task = await tasks.getTask(row.taskId);
    const thread = await threads.ensureThread({ botId: row.botId, repoId: task?.repoId ?? null, subjectRef: row.subjectRef });
    await threads.addMessage({ threadId: thread.id, kind: 'sys', author: 'openadlc', text, payload: { messageId: row.messageId } });
  }
}
