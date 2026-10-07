import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskAttachment } from '@fleetadlc/shared';
import { AttachmentClient, prepareAttachments, writeAttachments } from './task-attachments.js';

/**
 * A task's files, laid out for its session: text given as a document every
 * engine reads, every file beside its context for the engine to open, and an
 * image never read into the prompt as text, where it would be a page of
 * replacement characters.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const NOTES = Buffer.from('# Notes\n\nThe header is blue.\n');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function file(id: string, name: string, mediaType: string, bytes: Buffer, extra: Partial<TaskAttachment> = {}): TaskAttachment {
  return { id, name, mediaType, size: bytes.length, sha256: sha(bytes), from: 'jane@acme.test', source: 'console', ...extra };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleetadlc-attachments-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a task’s files', () => {
  it('gives text as a document, lists every file with where it is, and names only images and PDFs for the command line', async () => {
    const bytes: Record<string, Buffer> = { a: PNG, b: NOTES };
    const prepared = await prepareAttachments({
      attachments: [file('a', 'Screen Shot 1.png', 'image/png', PNG), file('b', 'notes.md', 'text/markdown', NOTES)],
      contextDir: dir,
      bytes: async (id) => bytes[id]!,
    });

    expect(prepared.binaries).toEqual([join(dir, 'attachments', 'Screen-Shot-1.png')]);
    expect(prepared.documents.map((one) => one.name)).toEqual(['attachment-notes.md', 'attachments.md']);
    expect(prepared.documents[0]?.content).toContain('The header is blue.');
    const listing = prepared.documents[1]!.content;
    expect(listing).toContain(`\`${join(dir, 'attachments', 'Screen-Shot-1.png')}\` — Screen Shot 1.png, image/png`);
    expect(listing).toContain('never on GitHub');
    // The image is no context document: the skill runner reads those as text.
    expect(prepared.documents.some((one) => one.content.includes('\u0089PNG'))).toBe(false);

    writeAttachments(prepared);
    expect(readFileSync(join(dir, 'attachments', 'Screen-Shot-1.png')).equals(PNG)).toBe(true);
  });

  it('leaves out a file that arrives different from the one sent, and says it is missing', async () => {
    const prepared = await prepareAttachments({
      attachments: [file('a', 'mockup.png', 'image/png', PNG)],
      contextDir: dir,
      bytes: async () => Buffer.from('not the same bytes'),
    });
    expect(prepared.writes).toEqual([]);
    expect(prepared.binaries).toEqual([]);
    expect(prepared.documents[0]?.content).toMatch(/mockup\.png: arrived different from the file that was sent/);
  });

  it('keeps two files of one name apart, and says where an image from the issue came from', async () => {
    const prepared = await prepareAttachments({
      attachments: [
        file('a', 'image.png', 'image/png', PNG),
        file('b', 'image.png', 'image/png', PNG, { source: 'github', from: 'janedoe' }),
      ],
      contextDir: dir,
      bytes: async () => PNG,
    });
    expect(prepared.binaries.map((path) => path.slice(dir.length))).toEqual(['/attachments/image.png', '/attachments/2-image.png']);
    expect(prepared.documents.at(-1)?.content).toContain('from the issue on GitHub, posted by janedoe');
  });

  it('keeps apart two files whose names differ only in case, which a Mac’s disk holds as one', async () => {
    const other = Buffer.from('other notes\n');
    const bytes: Record<string, Buffer> = { a: NOTES, b: other };
    const prepared = await prepareAttachments({
      attachments: [file('a', 'Notes.txt', 'text/plain', NOTES), file('b', 'notes.txt', 'text/plain', other)],
      contextDir: dir,
      bytes: async (id) => bytes[id]!,
    });
    expect(prepared.writes.map((write) => write.path.slice(dir.length))).toEqual(['/attachments/Notes.txt', '/attachments/2-notes.txt']);
    expect(prepared.documents.map((one) => one.name)).toEqual(['attachment-Notes.txt', 'attachment-2-notes.txt', 'attachments.md']);
  });

  it('gives a task with no files nothing at all', async () => {
    expect(await prepareAttachments({ attachments: [], contextDir: dir, bytes: async () => PNG })).toEqual({ documents: [], writes: [], binaries: [] });
  });
});

describe('fetching a file before the bridge has written the install’s secret', () => {
  it('says to start the bridge, not only that the secret is missing', async () => {
    const empty = { get: async () => null, set: async () => undefined, delete: async () => undefined, list: async () => [] };
    await expect(new AttachmentClient('http://127.0.0.1:9', empty).bytes('att-1')).rejects.toThrow(
      /no internal secret yet.*Start the bridge, which generates it, then retry: fleetadlc up/,
    );
  });
});
