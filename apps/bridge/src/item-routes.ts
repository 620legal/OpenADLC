import { attachments, bots, threads } from '@fleetadlc/db';
import { hasIgnoreLabel } from '@fleetadlc/shared';
import { attachmentIds, claimableFor, claimWindowStart } from './attachment-routes.js';
import type { ApiDeps } from './api.js';
import { readItem, resolveItem, routeItemMessage } from './items.js';
import { HttpFailure, STREAMING, type Router } from './router.js';
import { sendThreadMessage } from './thread-messages.js';

/**
 * A work item, as the console reads it, watches it and writes to it. See
 * `items.ts` for what an item is.
 */

/**
 * How many probes an item's stream makes before it reads the item's members
 * again. A pull request opened while a person has the item open is a new
 * subject the watermark has to cover; reading the members every second would
 * be most of the probe's cost for something that happens once per item.
 */
const MEMBERS_EVERY = 15;

function noItem(subject: string): HttpFailure {
  return new HttpFailure(
    404,
    `${subject || 'that'} is not a work item this install knows: a request (request:<id>), an issue or a pull request (repo#number), or the subject a task ran on`,
  );
}

/**
 * The item a subject names, if the console shows it. Not one whose issue is
 * labelled `fleetadlc:ignore`: the console is for the work the crew does, and
 * that issue and its pull request are a person's (`ignoredSubjects`).
 */
function shown<T extends { item: { issue: object | null } }>(subject: string, read: T | null): T {
  if (!read) throw noItem(subject);
  const labels = (read.item.issue as { labels?: string[] } | null)?.labels;
  if (hasIgnoreLabel(labels)) {
    throw new HttpFailure(404, `${subject} is labelled fleetadlc:ignore, which the console leaves out; take the label off on GitHub to bring it back`);
  }
  return read;
}

export function registerItemRoutes(router: Router, deps: Pick<ApiDeps, 'actors' | 'gates' | 'taskService' | 'threadStream'>): void {
  /**
   * One work item: the request, its issue and pull request, the whole
   * conversation about any of them labelled by role, the questions open on
   * it and every task that worked on it. Any member's subject resolves to
   * the same item.
   */
  router.get('/v1/items/:subject', async ({ params }) => {
    const subject = params.subject ?? '';
    return shown(subject, await readItem(subject)).view;
  });

  /**
   * Tells an open item view when to re-read: the same framing as a bot's
   * thread stream, watching the item's subjects rather than one bot's threads.
   */
  router.get('/v1/items/:subject/stream', async ({ params, res }) => {
    const subject = params.subject ?? '';
    const resolved = shown(subject, await resolveItem(subject));
    const key = resolved.item.key;

    let subjects = resolved.item.subjects;
    let probes = 0;
    const probe = async (): Promise<string> => {
      probes += 1;
      if (probes % MEMBERS_EVERY === 0) {
        const again = await resolveItem(key).catch(() => null);
        if (again) subjects = again.item.subjects;
      }
      return `${subjects.join(',')}|${await threads.subjectsWatermark(subjects)}`;
    };
    const stop = deps.threadStream.subscribe(`item:${key}`, probe, (watermark) => {
      res.write(`event: changed\ndata: ${JSON.stringify({ watermark })}\n\n`);
    });

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    keepAlive.unref?.();
    const close = (): void => {
      clearInterval(keepAlive);
      stop();
    };
    res.on('close', close);
    res.on('error', close);

    // The 200 is what the view re-reads on, so the baseline is taken first.
    await deps.threadStream.ready(`item:${key}`);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    return STREAMING;
  });

  /**
   * A person writing on a work item: an answer to one of its questions, or a
   * message to the seat working on it. `routeItemMessage` decides which; the
   * message itself goes the way a bot panel's does (`sendThreadMessage`).
   */
  router.post('/v1/items/:subject/messages', async ({ params, body, identity, role: access }) => {
    const subject = params.subject ?? '';
    const input = await body<{ text?: unknown; gateId?: unknown; role?: unknown; attachments?: unknown }>();
    const files = attachmentIds(input.attachments);
    const read = shown(subject, await readItem(subject));
    // Checked before anything is sent: a message whose files cannot go with
    // it is refused whole.
    const claimed = await claimableFor(files, { identity, itemSubjects: read.item.subjects });
    const given = typeof input.text === 'string' ? input.text : '';
    // Files alone are a message too; it says what was attached.
    const text = given.trim() || (claimed.length > 0 ? `Attached ${claimed.map((one) => one.name).join(', ')}` : '');
    if (!text.trim()) throw new HttpFailure(400, 'a message needs text');
    const keep = async (subjectRef: string | null, messageId: string | null): Promise<void> => {
      if (files.length === 0 || !subjectRef) return;
      await attachments.claim(files, {
        uploadedBy: identity,
        since: claimWindowStart(),
        subjectRef,
        repoId: read.repo?.id ?? null,
        requestId: subjectRef.startsWith('request:') ? (read.item.request?.id ?? null) : null,
        messageId,
      });
    };
    const gateId = typeof input.gateId === 'string' && input.gateId.trim() ? input.gateId.trim() : null;
    const role = typeof input.role === 'string' && input.role.trim() ? input.role.trim() : null;

    const crew = await bots.listBots();
    const route = routeItemMessage(read.view, read.item, crew, { gateId, role });
    if (route.kind === 'refused') throw new HttpFailure(route.status, route.error);

    if (route.kind === 'gate') {
      // On the question's subject before the task resumes, so the resumed
      // session is briefed with them (`context.ts`).
      await keep(route.gate.subjectRef, null);
      const answered = await deps.gates.answer({ gateId: route.gate.id, reply: text, answeredBy: identity, role: access, via: 'item' });
      if (answered.taskId) {
        await deps.taskService.resume(answered.taskId).catch((error: Error) => {
          console.warn(`[bridge] resume after answer failed: ${error.message}`);
        });
      }
      return { answered: true, answer: answered.answer, gateId: route.gate.id, item: read.item.key };
    }

    const bot = crew.find((one) => one.id === route.botId);
    if (!bot) throw new HttpFailure(409, `${route.bot} is no longer in the crew; pick another role to write to`);
    const sent = await sendThreadMessage(deps, { bot, subject: route.subject, text, identity, role: access });
    await keep(route.subject, sent.answered ? null : sent.message.id);
    return { ...sent, bot: bot.name, subject: route.subject, item: read.item.key };
  });
}
