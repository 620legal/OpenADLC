import { attachments, audit, bots, repos, requests, threads, workItems } from '@openadlc/db';
import type { GitHubClient } from '@openadlc/github';
import { hasIgnoreLabel } from '@openadlc/shared';
import { attachmentIds, claimableFor, claimWindowStart } from './attachment-routes.js';
import type { ApiDeps } from './api.js';
import { readItem, resolveItem, routeItemMessage, type Item } from './items.js';
import { requestPrefixOf } from './request-context.js';
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
 * labelled `openadlc:ignore`: the console is for the work the crew does, and
 * that issue and its pull request are a person's (`ignoredSubjects`).
 */
function shown<T extends { item: { issue: object | null } }>(subject: string, read: T | null): T {
  if (!read) throw noItem(subject);
  const labels = (read.item.issue as { labels?: string[] } | null)?.labels;
  if (hasIgnoreLabel(labels)) {
    throw new HttpFailure(404, `${subject} is labelled openadlc:ignore, which the console leaves out; take the label off on GitHub to bring it back`);
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

/** A managed repository, as linking by hand reads it. */
interface LinkRepo {
  id: string;
  name: string;
  fullName: string;
}

/** What linking, unlinking and merging by hand read and write; real ones in `defaultItemLinkDeps`. */
export interface ItemLinkDeps {
  resolve(subject: string): Promise<{ item: Item } | null>;
  /** The repositories the install manages now. */
  repos(): Promise<LinkRepo[]>;
  /** A client that reads GitHub; null when no account can. Only read: nothing about work items is written on GitHub. */
  github(): Promise<Pick<GitHubClient, 'getIssue' | 'getPullRequest'> | null>;
  linkByHand: typeof workItems.linkByHand;
  unlinkByHand: typeof workItems.unlinkByHand;
  mergeByHand: typeof workItems.mergeByHand;
  findRequest(prefix: string): Promise<{ id: string } | null>;
  audit: typeof audit;
}

export function defaultItemLinkDeps(github: ItemLinkDeps['github']): ItemLinkDeps {
  return {
    resolve: resolveItem,
    repos: () => repos.listRepos(),
    github,
    // Read when called, not when the routes are registered.
    linkByHand: (...args) => workItems.linkByHand(...args),
    unlinkByHand: (...args) => workItems.unlinkByHand(...args),
    mergeByHand: (...args) => workItems.mergeByHand(...args),
    findRequest: (prefix) => requests.findRequestByPrefix(prefix),
    audit: (input) => audit(input),
  };
}

/** `owner/repo#12`, or `repo#12` by the name the install gives it. */
function parseLinkRef(ref: string): { repo: string; number: number } | null {
  const match = /^([^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: match[1]!, number } : null;
}

function managedRepo(list: readonly LinkRepo[], named: string): LinkRepo | null {
  const lower = named.toLowerCase();
  return list.find((repo) => repo.fullName.toLowerCase() === lower || repo.name.toLowerCase() === lower) ?? null;
}

/** The key of another number, shown the way this item's is. */
function keyLike(item: Item, number: number): string {
  return (item.workItem?.key ?? `W-${number}`).replace(/\d+$/, String(number));
}

/**
 * Linking, unlinking and merging work items by hand (docs/adr/0009-work-items.md):
 * admin-only (`roles.ts`), each audited, and none of them writes to GitHub.
 * A person's link is theirs: no automatic pass moves it afterwards.
 */
export function registerItemLinkRoutes(router: Router, deps: ItemLinkDeps): void {
  const numbered = async (subject: string): Promise<Item & { workItem: NonNullable<Item['workItem']> }> => {
    const resolved = shown(subject, await deps.resolve(subject));
    const { item } = resolved;
    if (!item.workItem) {
      throw new HttpFailure(409, `${subject} has no work item yet: the first start after the upgrade is still reading every repository's history; try again once the board shows keys`);
    }
    return item as Item & { workItem: NonNullable<Item['workItem']> };
  };

  router.post('/v1/items/:subject/links', async ({ params, body, identity }) => {
    const item = await numbered(params.subject ?? '');
    const input = await body<{ ref?: unknown }>();
    const parsed = typeof input.ref === 'string' ? parseLinkRef(input.ref) : null;
    if (!parsed) throw new HttpFailure(400, 'name what to link as owner/repo#number, the issue or pull request on GitHub');
    const repo = managedRepo(await deps.repos(), parsed.repo);
    if (!repo) throw new HttpFailure(400, `${parsed.repo} is not a repository this install manages; add it in Settings → Repositories first`);
    const client = await deps.github();
    if (!client) throw new HttpFailure(503, 'no GitHub account can read the issue: reconnect the automation account from Settings → GitHub → Connected accounts');
    const found = await client.getIssue(repo.fullName, parsed.number).catch((error: unknown) => {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    });
    if (!found) throw new HttpFailure(404, `GitHub has no issue or pull request ${repo.fullName}#${parsed.number}; check the number`);
    const merged = found.pullRequest ? (await client.getPullRequest(repo.fullName, parsed.number)).merged : false;
    const ref = `${repo.fullName}#${parsed.number}`;
    const moved = await deps.linkByHand(
      item.workItem.id,
      { repoId: repo.id, number: parsed.number, kind: found.pullRequest ? 'pull' : 'issue' },
      { title: found.title, state: merged ? 'merged' : found.state, url: found.htmlUrl, openedAt: found.createdAt },
      identity,
    );
    const from = moved.from && moved.from.id !== item.workItem.id ? keyLike(item, moved.from.number) : null;
    await deps.audit({ actor: identity, action: 'item.linked', target: item.workItem.key, payload: { ref, from } });
    return { item: item.workItem.key, ref, kind: found.pullRequest ? 'pull' : 'issue', from };
  });

  // The ref travels encoded (`acme%2Fapi%2312`); the router decodes each segment.
  router.add('DELETE', '/v1/items/:subject/links/:ref', async ({ params, identity }) => {
    const item = await numbered(params.subject ?? '');
    const raw = (params.ref ?? '').trim();
    let thing: workItems.ThingRef;
    const prefix = requestPrefixOf(raw);
    if (prefix) {
      const request = await deps.findRequest(prefix).catch(() => null);
      if (!request) throw new HttpFailure(404, `${raw} is not a request this install knows`);
      thing = { requestId: request.id };
    } else {
      const parsed = parseLinkRef(raw);
      const repo = parsed ? managedRepo(await deps.repos(), parsed.repo) : null;
      if (!parsed || !repo) throw new HttpFailure(400, `${raw || 'that'} is not an issue or pull request of a repository this install manages: name it as owner/repo#number`);
      thing = { repoId: repo.id, number: parsed.number };
    }
    const result = await deps.unlinkByHand(item.workItem.id, thing, identity);
    if (result === 'only') throw new HttpFailure(409, `${raw} is the only thing on ${item.workItem.key}: merge it into another item instead`);
    if (!result) throw new HttpFailure(404, `${raw} is not linked to ${item.workItem.key}`);
    const key = keyLike(item, result.number);
    await deps.audit({ actor: identity, action: 'item.unlinked', target: item.workItem.key, payload: { ref: raw, to: key } });
    return { item: item.workItem.key, ref: raw, key };
  });

  router.post('/v1/items/:subject/merge', async ({ params, body, identity }) => {
    const item = await numbered(params.subject ?? '');
    const input = await body<{ into?: unknown }>();
    const into = typeof input.into === 'string' ? input.into.trim() : '';
    if (!into) throw new HttpFailure(400, 'say which item to merge it into, by its key');
    const target = await numbered(into);
    if (target.workItem.id === item.workItem.id) throw new HttpFailure(409, `${item.workItem.key} and ${into} are one item already`);
    const merged = await deps.mergeByHand(item.workItem.id, target.workItem.id);
    if (!merged) throw new HttpFailure(409, `${item.workItem.key} could not be merged into ${target.workItem.key}: one of them was merged elsewhere meanwhile; reload and try again`);
    await deps.audit({ actor: identity, action: 'item.merged', target: item.workItem.key, payload: { into: target.workItem.key } });
    return { item: item.workItem.key, into: target.workItem.key };
  });
}
