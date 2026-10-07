import { repos, tasks, threads, type Role } from '@fleetadlc/db';
import { botAtStart, botInWords, type Bot, type Message } from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import type { Gates } from './gates.js';
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
  deps: { actors: Actors; gates: Gates; taskService: TaskService },
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
    const answered = await deps.gates.answer({
      gateId: gate.id,
      reply: input.text,
      answeredBy: identity,
      role: input.role,
      via: 'thread',
    });
    if (answered.taskId) {
      await deps.taskService.resume(answered.taskId).catch((error) => {
        console.warn(`[bridge] resume after answer failed: ${error.message}`);
      });
    }
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
          : `${botAtStart(bot)} has no GitHub account yet, so it was not sent. Connect it from Settings → GitHub → Connected accounts, or run: fleetadlc auth login --bot ${bot.slot}`,
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
