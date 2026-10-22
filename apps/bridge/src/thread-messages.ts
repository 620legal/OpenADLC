import { repos, tasks, threads, type Role } from '@openadlc/db';
import { botAtStart, botInWords, resolveAnswer, type Bot, type Message } from '@openadlc/shared';
import type { Actors } from './actors.js';
import type { Afterwards } from './api.js';
import type { GateChannel, Gates } from './gates.js';
import { HttpFailure } from './router.js';
import type { TaskService } from './task-service.js';
import { consoleMessageBody, gateToAnswer } from './thread-view.js';
import { parseRef } from './work.js';

/**
 * A person's message to a bot, about one of its subjects.
 *
 * Where it goes depends on what the subject is, and the console says which
 * before it is sent:
 *
 * - a question the bot is waiting on about that subject: the message is
 *   its answer, and the task resumes;
 * - an issue or a pull request: it is posted there as a comment, by the
 *   bot's account and naming the person, because a task on GitHub is briefed
 *   from the conversation on GitHub and from nothing else;
 * - a console request: it is added to the request's thread, which is what
 *   the request's `request.md` reads when its triage starts or resumes.
 *
 * The console sent no subject at all, so a message went to a thread about
 * nothing, where no bot reads. Without one — an older console — any question
 * the bot is waiting on is answered, as before.
 *
 * Both the bot's panel (`POST /v1/threads/:bot/messages`) and a work item's
 * composer (`POST /v1/items/:subject/messages`) send through this, so a
 * message reaches GitHub, or is refused, the same way from either.
 */
export async function sendThreadMessage(
  deps: { actors: Actors; gates: Gates; taskService: TaskService; afterwards?: Afterwards },
  input: {
    bot: Bot;
    subject: string | null;
    text: string;
    identity: string;
    /** The sender's console role: only an admin's continue goes past a spent monthly cap (`Gates.answer`). */
    role?: Role;
  },
): Promise<{ answered: true; answer: string } | { answered: false; message: Message }> {
  const { bot, subject, identity } = input;
  if (!input.text?.trim()) throw new HttpFailure(400, 'a message needs text');

  const openGates = await threads.listOpenGates();
  const withTasks = await Promise.all(
    openGates.map(async (candidate) => ({
      gate: candidate,
      task: candidate.taskId ? await tasks.getTask(candidate.taskId) : null,
    })),
  );
  const gate = gateToAnswer(withTasks, bot.id, subject);

  if (gate) {
    const answered = await answerFromConsole(deps, {
      gateId: gate.id,
      reply: input.text,
      answeredBy: identity,
      role: input.role,
      via: 'thread',
    });
    return { answered: true, answer: answered.answer };
  }

  const subjectRef = subject ?? '';
  const onGitHub = parseRef(subjectRef);
  // Posted where the panel said it would be, on GitHub, even about an issue
  // in a repository since removed from OpenADLC: nothing there was deleted.
  const repo = onGitHub ? await repos.getRepoByName(onGitHub.repo, { includeRemoved: true }) : null;

  let githubUrl: string | null = null;
  if (onGitHub && repo) {
    const client = await deps.actors.asBot(bot.name);
    if (!client) {
      // Which of the two it is, and what fixes each. The seat, not the name,
      // for the command: the CLI names bots by seat, as a bot is renamed when
      // its account connects.
      throw new HttpFailure(
        409,
        bot.githubLogin
          ? `${botAtStart(bot)} could not sign in to GitHub just now, so it was not sent. Try again in a minute; if it fails again, reconnect it from Settings → GitHub → Connected accounts`
          : `${botAtStart(bot)} has no GitHub account yet, so it was not sent. Connect it from Settings → GitHub → Connected accounts, or run: openadlc auth login --bot ${bot.slot}`,
      );
    }
    // Refused rather than kept here: the console said it would be on GitHub.
    const comment = await client
      .comment(repo.fullName, onGitHub.number, consoleMessageBody(identity, input.text))
      .catch((error: unknown) => {
        throw new HttpFailure(502, refusedWords(error, bot, `${repo.fullName}#${onGitHub.number}`));
      });
    githubUrl = comment.htmlUrl;
  }

  const thread = await threads.ensureThread({
    botId: bot.id,
    repoId: repo?.id ?? null,
    subjectRef,
  });
  const message = await threads.addMessage({
    threadId: thread.id,
    kind: 'you',
    author: identity,
    text: input.text,
    githubUrl,
  });
  return { answered: false, message };
}

/**
 * GitHub's refusal of a person's message, as what to do about it. Its raw
 * text — a path, the JSON, a status — was what the console showed.
 */
function refusedWords(error: unknown, bot: Bot, where: string): string {
  const status = (error as { status?: unknown } | null)?.status;
  const said = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
  if (status === 401) {
    return `GitHub no longer accepts the sign-in of ${botInWords(bot)}, so it was not sent. Reconnect it from Settings → GitHub → Connected accounts, then send it again`;
  }
  if (status === 404) return `GitHub cannot find ${where}, or ${botInWords(bot)} cannot see it, so it was not sent`;
  if (status === 403) {
    return `GitHub refused it (${said}), so it was not sent. Check that ${botInWords(bot)} may comment on ${where}: that it has access, and the conversation is not locked`;
  }
  if (typeof status !== 'number') return `GitHub did not answer (${said}), so it was not sent. Try again in a minute`;
  return `GitHub did not take it (${said}). Try again`;
}

/**
 * A person's answer to a question from the console — a card, a work item, a
 * bot's panel — answered once the question is claimed.
 *
 * With `afterwards`, what is left is done after the answer, in this order: the
 * answer's GitHub writes (`deferGitHub` on `Gates.answer`), then the resume,
 * since a resumed session reads the answer from the issue. A resume hostd
 * refuses fails the task with why, on its card and in its thread
 * (`TaskService.resume`); one that never ran is owed by the answer, which the
 * sweep of answered tasks reads (`resumeAnswered`). Without it, as before,
 * all of it is done first.
 *
 * The same answer from the same person to a question it already answered is
 * that answer again — a second press, a second tab — and changes nothing.
 * Anybody else's, or other words, is refused as a question already answered.
 *
 * `ended` is an answer that stopped its task — a refused plan change, a hand
 * off or an abandon at the cost cap, work that had already landed — so the
 * console does not say it goes on.
 */
export async function answerFromConsole(
  deps: { gates: Gates; taskService: Pick<TaskService, 'resume'>; afterwards?: Afterwards },
  input: { gateId: string; reply: string; answeredBy: string; role?: Role; via: GateChannel },
): Promise<{ answer: string; taskId: string | null; held?: boolean; again?: true; ended?: true }> {
  const { afterwards } = deps;
  const result = await deps.gates.answer({ ...input, ...(afterwards ? { deferGitHub: true } : {}) }).catch(async (error: unknown) => {
    // Only a question that was not open to this answer, as `Gates.answer`
    // says it. One its own answer closed and could not carry out is that
    // answer's failure, and is said as it is.
    if (!(error instanceof Error) || error.message !== 'gate is no longer open') throw error;
    const gate = await threads.getGate(input.gateId).catch(() => null);
    if (!gate || gate.state === 'open') throw error;
    if (gate.state === 'answered' && gate.answeredBy === input.answeredBy && gate.answer === resolveAnswer(input.reply, gate.options)) {
      return { answer: gate.answer, taskId: null, again: true as const };
    }
    throw new HttpFailure(
      409,
      gate.state === 'answered'
        ? `that question was answered already${gate.answeredBy ? ` by ${gate.answeredBy}` : ''}: ${gate.answer ?? ''}`
        : 'that question is closed: the work that asked it has ended',
    );
  });
  const { github, ...answered } = result as typeof result & { github?: () => Promise<void> };
  const after = async (): Promise<void> => {
    await github?.();
    if (answered.taskId) {
      await deps.taskService.resume(answered.taskId).catch((error: Error) => {
        console.warn(`[bridge] resume after answer failed: ${error.message}`);
      });
    }
  };
  // Read before the resume, which cleans a stopped task up; `Gates` wrote it.
  const taskId = answered.taskId;
  const ended = taskId ? (await Promise.resolve().then(() => tasks.getTask(taskId)).catch(() => null))?.state === 'stopped' : false;
  if (!afterwards) await after();
  else if (github || answered.taskId) afterwards.run({ taskId: answered.taskId }, 'Going on after the answer', after);
  return ended ? { ...answered, ended: true } : answered;
}
