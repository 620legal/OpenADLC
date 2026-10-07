import { query, queryOne, withTransaction } from '../client.js';

/**
 * Attachments: files given to the crew with a request or a message, and images
 * read from an issue on GitHub. See migration 0029 for why they are rows.
 *
 * Every read and write goes through here, and nothing outside reads
 * `content` by column name, with one exception: the backup reads, writes and
 * deletes the table directly, `content` included (`packages/backup/src/live.ts`,
 * the history group), so a bucket behind this module later is a change to
 * this file, that one and a migration, not to every caller. ADR 0001 predates
 * the exception. The metadata reads never select `content`, so listing an
 * item's files never pulls 25 MB through the pool.
 */

export interface AttachmentMeta {
  id: string;
  subjectRef: string | null;
  repoId: string | null;
  requestId: string | null;
  messageId: string | null;
  source: 'console' | 'github';
  sourceUrl: string | null;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string;
  createdAt: string;
}

interface Row {
  id: string;
  subject_ref: string | null;
  repo_id: string | null;
  request_id: string | null;
  message_id: string | null;
  source: 'console' | 'github';
  source_url: string | null;
  name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  created_at: Date;
}

const META = `id, subject_ref, repo_id, request_id, message_id, source, source_url, name, media_type, size_bytes,
         sha256, uploaded_by, created_at`;

function toMeta(row: Row): AttachmentMeta {
  return {
    id: row.id,
    subjectRef: row.subject_ref,
    repoId: row.repo_id,
    requestId: row.request_id,
    messageId: row.message_id,
    source: row.source,
    sourceUrl: row.source_url,
    name: row.name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** A string is a uuid, so a malformed id is "no such attachment" rather than a database error. */
function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** An upload from the console, not yet sent with anything. */
export async function createUnclaimed(input: {
  name: string;
  mediaType: string;
  sha256: string;
  content: Buffer;
  uploadedBy: string;
}): Promise<AttachmentMeta> {
  const row = await queryOne<Row>(
    `insert into attachments (source, name, media_type, size_bytes, sha256, content, uploaded_by)
     values ('console', $1, $2, $3, $4, $5, $6)
     returning ${META}`,
    [input.name, input.mediaType, input.content.length, input.sha256, input.content, input.uploadedBy],
  );
  if (!row) throw new Error('failed to store the attachment');
  return toMeta(row);
}

/**
 * An image read from an issue or a comment on GitHub, kept on its subject. The
 * same file on the same subject is one row, and so is the same link: a second
 * read of the issue finds what the first stored and stores nothing.
 */
export async function storeFromGitHub(input: {
  subjectRef: string;
  repoId: string | null;
  sourceUrl: string;
  name: string;
  mediaType: string;
  sha256: string;
  content: Buffer;
  uploadedBy: string;
}): Promise<AttachmentMeta | null> {
  const row = await queryOne<Row>(
    `insert into attachments (subject_ref, repo_id, source, source_url, name, media_type, size_bytes, sha256, content, uploaded_by)
     values ($1, $2, 'github', $3, $4, $5, $6, $7, $8, $9)
     on conflict (subject_ref, sha256) do nothing
     returning ${META}`,
    [input.subjectRef, input.repoId, input.sourceUrl, input.name, input.mediaType, input.content.length, input.sha256, input.content, input.uploadedBy],
  );
  return row ? toMeta(row) : null;
}

/** The links already stored for a subject, so a link is downloaded once. */
export async function sourceUrlsOn(subjectRef: string): Promise<Set<string>> {
  const rows = await query<{ source_url: string }>(
    `select source_url from attachments where subject_ref = $1 and source_url is not null`,
    [subjectRef],
  );
  return new Set(rows.map((row) => row.source_url));
}

/** An attachment with its bytes: the one read that selects `content`. */
export async function readAttachment(id: string): Promise<{ meta: AttachmentMeta; content: Buffer } | null> {
  if (!isUuid(id)) return null;
  const row = await queryOne<Row & { content: Buffer }>(`select ${META}, content from attachments where id = $1`, [id]);
  return row ? { meta: toMeta(row), content: row.content } : null;
}

/** Every attachment on any of a work item's subjects, oldest first, without their bytes. */
export async function listForSubjects(subjectRefs: readonly string[]): Promise<AttachmentMeta[]> {
  if (subjectRefs.length === 0) return [];
  const rows = await query<Row>(
    `select ${META} from attachments where subject_ref = any($1::text[]) order by created_at, id`,
    [[...subjectRefs]],
  );
  return rows.map(toMeta);
}

/**
 * The uploads among `ids` that `uploadedBy` may still send: theirs, sent with
 * nothing yet, and newer than `since`. What a request or a message is checked
 * against before it is written, so one with a file nobody can claim is refused
 * whole rather than sent without it.
 */
export async function claimable(ids: readonly string[], uploadedBy: string, since: Date): Promise<AttachmentMeta[]> {
  const wanted = ids.filter(isUuid);
  if (wanted.length === 0) return [];
  const rows = await query<Row>(
    `select ${META} from attachments
      where id = any($1::uuid[]) and subject_ref is null and uploaded_by = $2 and created_at > $3`,
    [wanted, uploadedBy, since],
  );
  return rows.map(toMeta);
}

/**
 * Sends uploads with a request or a message: they take its subject, and the
 * request or message they went with. Only `uploadedBy`'s own, unclaimed and
 * newer than `since`. A file already on the subject (the same bytes) is not
 * claimed twice: the upload is dropped and the one there stands. Duplicates
 * within one batch (the same bytes pasted and also dropped) are collapsed to
 * one file the same way: the upload with the smallest id is claimed and the
 * rest dropped. Claiming both broke `unique (subject_ref, sha256)` after the
 * request had been written, so triage started without the file.
 */
export async function claim(
  ids: readonly string[],
  input: { uploadedBy: string; since: Date; subjectRef: string; repoId: string | null; requestId?: string | null; messageId?: string | null },
): Promise<AttachmentMeta[]> {
  const wanted = ids.filter(isUuid);
  if (wanted.length === 0) return [];
  return withTransaction(async (client) => {
    await client.query(
      `delete from attachments a
        where a.id = any($1::uuid[]) and a.subject_ref is null and a.uploaded_by = $2
          and exists (select 1 from attachments b where b.subject_ref = $3 and b.sha256 = a.sha256)`,
      [wanted, input.uploadedBy, input.subjectRef],
    );
    await client.query(
      `delete from attachments a
        where a.id = any($1::uuid[]) and a.subject_ref is null and a.uploaded_by = $2
          and exists (select 1 from attachments b
                       where b.id = any($1::uuid[]) and b.subject_ref is null and b.uploaded_by = $2
                         and b.sha256 = a.sha256 and b.id < a.id)`,
      [wanted, input.uploadedBy],
    );
    const result = await client.query<Row>(
      `update attachments set subject_ref = $3, repo_id = $4, request_id = $5, message_id = $6
        where id = any($1::uuid[]) and subject_ref is null and uploaded_by = $2 and created_at > $7
        returning ${META}`,
      [wanted, input.uploadedBy, input.subjectRef, input.repoId, input.requestId ?? null, input.messageId ?? null, input.since],
    );
    return result.rows.map(toMeta);
  });
}

/** Removes one, returning what it was, for the audit line. */
export async function deleteAttachment(id: string): Promise<AttachmentMeta | null> {
  if (!isUuid(id)) return null;
  const row = await queryOne<Row>(`delete from attachments where id = $1 returning ${META}`, [id]);
  return row ? toMeta(row) : null;
}

/** Uploads nobody sent with anything since `before`; how many went. */
export async function sweepUnclaimed(before: Date): Promise<number> {
  const rows = await query<{ id: string }>(
    'delete from attachments where subject_ref is null and created_at < $1 returning id',
    [before],
  );
  return rows.length;
}
