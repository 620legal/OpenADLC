import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { attachments, audit } from '@fleetadlc/db';
import { ATTACHMENT_LIMITS, checkAttachment, itemRoomFor, safeFileName, type TaskAttachment } from '@fleetadlc/shared';
import { resolveItem } from './items.js';
import { HttpFailure, readBytes, STREAMING, type Router } from './router.js';

/**
 * Files a person gives the crew, uploaded from the console one at a time and
 * then sent with a request or a message. See `@fleetadlc/shared`'s
 * `attachments.ts` for what is taken, and `@fleetadlc/db`'s for where it is
 * kept.
 *
 * An upload comes first and is sent second because a request is written in
 * one JSON body and a file is megabytes: the console's server actions stop at
 * one megabyte, so the browser streams each file to a route handler, which
 * streams it here, and the request names the ids it got back.
 */

/** How long an upload waits for the request or message it goes with. */
export function claimWindowStart(now = new Date()): Date {
  return new Date(now.getTime() - ATTACHMENT_LIMITS.unclaimedHours * 60 * 60 * 1000);
}

/** The ids a body names, each once; anything that is not a list of strings is a 400. */
export function attachmentIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) {
    throw new HttpFailure(400, '`attachments` is a list of the ids POST /v1/attachments answered with');
  }
  return [...new Set(value as string[])];
}

/**
 * The uploads a request or a message may be sent with, checked before it is
 * written: each the sender's own and unclaimed, and the item they join with
 * room for them. A request with a file nobody can claim is refused whole,
 * rather than filed without it and its question asked about a screenshot
 * nobody has.
 */
export async function claimableFor(
  ids: readonly string[],
  input: { identity: string; itemSubjects: readonly string[] },
): Promise<attachments.AttachmentMeta[]> {
  if (ids.length === 0) return [];
  const found = await attachments.claimable(ids, input.identity, claimWindowStart());
  if (found.length !== ids.length) {
    const missing = ids.length - found.length;
    throw new HttpFailure(
      409,
      `${missing === 1 ? 'one of the files' : `${missing} of the files`} you attached could not be found: an upload is kept for ${ATTACHMENT_LIMITS.unclaimedHours} hours, for the person who sent it, until it is sent with something. Attach ${missing === 1 ? 'it' : 'them'} again`,
    );
  }
  const used = await attachments.listForSubjects(input.itemSubjects);
  const full = itemRoomFor(
    { count: used.length, bytes: used.reduce((total, one) => total + one.sizeBytes, 0) },
    { count: found.length, bytes: found.reduce((total, one) => total + one.sizeBytes, 0) },
  );
  if (full) throw new HttpFailure(413, `${full}. Remove some, or put the rest in one PDF`);
  return found;
}

export function registerAttachmentRoutes(router: Router): void {
  /**
   * One file, as the raw body: its name in `x-file-name` (URI-encoded), its
   * type read from its bytes rather than taken from `content-type`. Stored
   * unclaimed until it is sent with something; swept after a day if not.
   */
  router.post('/v1/attachments', async ({ raw, identity }) => {
    const header = raw.headers['x-file-name'];
    const given = typeof header === 'string' ? safeDecode(header) : '';
    const bytes = await readBytes(raw, { limit: ATTACHMENT_LIMITS.fileBytes });
    const checked = checkAttachment({ name: given || 'the file', bytes });
    if (!checked.ok) throw new HttpFailure(415, checked.reason);
    const name = given.trim().slice(0, 200) || safeFileName('', checked.mediaType);
    const stored = await attachments.createUnclaimed({
      name,
      mediaType: checked.mediaType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content: bytes,
      uploadedBy: identity,
    });
    return { attachment: stored };
  });

  /**
   * One file, to look at. Served as the type its bytes were found to be,
   * never sniffed again by the browser, and sandboxed: an image is shown in
   * place, and nothing in a file can run as the console's page.
   */
  router.get('/v1/attachments/:id', async ({ params, res }) => {
    const found = await attachments.readAttachment(params.id ?? '');
    if (!found) throw new HttpFailure(404, 'there is no such attachment; it may have been removed, or never sent with anything and swept');
    const { meta, content } = found;
    const inline = meta.mediaType.startsWith('image/') || meta.mediaType === 'application/pdf';
    res.writeHead(200, {
      'content-type': meta.mediaType,
      'content-length': String(content.length),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeFileName(meta.name, meta.mediaType)}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, max-age=300',
    });
    res.end(content);
    return STREAMING;
  });

  /** Removes one for good, as an admin decided; audited with what it was. */
  router.add('DELETE', '/v1/attachments/:id', async ({ params, identity }) => {
    const removed = await attachments.deleteAttachment(params.id ?? '');
    if (!removed) throw new HttpFailure(404, 'there is no such attachment');
    await audit({
      actor: identity,
      action: 'attachment.deleted',
      target: removed.subjectRef ?? 'unclaimed',
      payload: { id: removed.id, name: removed.name, sizeBytes: removed.sizeBytes, sha256: removed.sha256, source: removed.source },
    });
    return { deleted: removed.id };
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The files a task about `subjectRef` is given: every attachment on any
 * subject of its work item — the request it started as, the issue, the pull
 * request — so a build sees the screenshot sent with the request it came from.
 * Read again on every start and resume, so a file sent while a task waited on
 * a question is there when it goes on. A database a release behind has none.
 */
export async function attachmentsForTask(subjectRef: string): Promise<TaskAttachment[]> {
  let files: attachments.AttachmentMeta[] = [];
  try {
    const resolved = await resolveItem(subjectRef).catch(() => null);
    files = await attachments.listForSubjects(resolved?.item.subjects ?? [subjectRef]);
  } catch (error) {
    // A task without its files still starts: what it was asked is in its
    // context, and the files are what it is shown besides.
    console.warn(`[bridge] ${subjectRef}: its files could not be read, so its task starts without them: ${error instanceof Error ? error.message : error}`);
    return [];
  }
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    mediaType: file.mediaType,
    size: file.sizeBytes,
    sha256: file.sha256,
    from: file.uploadedBy,
    source: file.source,
  }));
}

/**
 * The bytes of one file, for hostd as it starts a task: the install's secret,
 * not a person's identity, which is why it is not a `/v1` route. The hash goes
 * with them, and hostd refuses bytes that do not match it.
 */
export function registerInternalAttachmentRoutes(router: Router, guard: (raw: IncomingMessage) => void): void {
  router.get('/internal/attachments/:id', async ({ params, raw, res }) => {
    guard(raw);
    const found = await attachments.readAttachment(params.id ?? '');
    if (!found) throw new HttpFailure(404, 'there is no such attachment; it may have been removed since the task was opened');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(found.content.length),
      'x-fleetadlc-sha256': found.meta.sha256,
      'x-fleetadlc-media-type': found.meta.mediaType,
    });
    res.end(found.content);
    return STREAMING;
  });
}
