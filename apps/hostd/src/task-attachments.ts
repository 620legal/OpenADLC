import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSecretStore, internalSecretRef, type SecretStore } from '@fleetadlc/github';
import { ATTACHMENT_LIMITS, isTextType, safeFileName, type ContextDocument, type TaskAttachment } from '@fleetadlc/shared';

/**
 * The files a task is given — a screenshot sent with the request, a PDF of the
 * requirements, an image from the issue — fetched from the bridge, checked
 * against their hash, and laid out beside the task's context.
 *
 * Not through the context documents: the skill runner reads every context file
 * as text into the prompt (`buildPrompt`), and a PNG read as UTF-8 is a
 * prompt of replacement characters. So a text file is also given as a document
 * of its own, which every engine reads, and every file is written under
 * `<context dir>/attachments/`, listed in `attachments.md` with what it is, for
 * the engine to open with its file tool; the images and PDFs are in
 * `FLEETADLC_ATTACHMENTS` too, for an engine that takes them on its command line.
 */

/** Fetches one file's bytes from the bridge, as hostd asks it for a task's token. See `token-client.ts`. */
export class AttachmentClient {
  private secret: string | null = null;

  constructor(
    private readonly bridgeUrl: string,
    private readonly store: SecretStore = getSecretStore(),
  ) {}

  private async sharedSecret(reread = false): Promise<string | null> {
    if (this.secret && !reread) return this.secret;
    this.secret = await this.store.get(internalSecretRef());
    return this.secret;
  }

  async bytes(id: string): Promise<Buffer> {
    let secret = await this.sharedSecret();
    if (!secret) {
      throw new Error('hostd has no internal secret yet, so it cannot fetch the file. Start the bridge, which generates it, then retry: fleetadlc up');
    }
    const ask = (with_: string) =>
      fetch(`${this.bridgeUrl}/internal/attachments/${encodeURIComponent(id)}`, { headers: { 'x-fleetadlc-internal-secret': with_ } });
    let response = await ask(secret);
    // The bridge writes the secret on its first start, which may come after
    // hostd found none, so one refusal is worth a second look.
    if (response.status === 401) {
      secret = (await this.sharedSecret(true)) ?? secret;
      response = await ask(secret);
    }
    if (!response.ok) throw new Error(`the bridge answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

export interface PreparedAttachments {
  /** Context documents: each text file's content, and `attachments.md` listing every file. */
  documents: ContextDocument[];
  /** What to write once the context directory exists, which writing the documents empties first. */
  writes: { path: string; bytes: Buffer }[];
  /** The images and PDFs, by path, for `FLEETADLC_ATTACHMENTS`. */
  binaries: string[];
}

function kilobytes(size: number): string {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} kB`;
}

/**
 * Fetches each file, keeps the ones whose bytes match their hash, and says
 * what each is. A file that cannot be fetched intact is named in
 * `attachments.md` as missing, so the task knows it was sent and asks for it
 * rather than working as if it never existed. The task starts either way.
 */
export async function prepareAttachments(input: {
  attachments: readonly TaskAttachment[];
  contextDir: string;
  bytes: (id: string) => Promise<Buffer>;
}): Promise<PreparedAttachments> {
  const folder = join(input.contextDir, 'attachments');
  const documents: ContextDocument[] = [];
  const writes: PreparedAttachments['writes'] = [];
  const binaries: string[] = [];
  const lines: string[] = [];
  const missing: string[] = [];
  const taken = new Set<string>();

  for (const file of input.attachments) {
    let bytes: Buffer;
    try {
      bytes = await input.bytes(file.id);
    } catch (error) {
      missing.push(`- ${file.name}: could not be fetched (${error instanceof Error ? error.message : error})`);
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      missing.push(`- ${file.name}: arrived different from the file that was sent, so it was left out`);
      continue;
    }

    // Two files of one name are two files: the second is numbered. Names
    // that differ only in case are one name, as they are one file on the
    // case-insensitive disk of a Mac, where the second overwrote the first.
    let name = safeFileName(file.name, file.mediaType);
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${n}-${safeFileName(file.name, file.mediaType)}`;
    taken.add(name.toLowerCase());
    const path = join(folder, name);
    writes.push({ path, bytes });

    const from = file.source === 'github' ? `the issue on GitHub${file.from ? `, posted by ${file.from}` : ''}` : (file.from ?? 'the person who asked');
    if (isTextType(file.mediaType) && bytes.length <= ATTACHMENT_LIMITS.textInContextBytes) {
      documents.push({
        name: `attachment-${name}`,
        title: `${file.name}, a file given with this work by ${from}`,
        content: bytes.toString('utf8'),
      });
      lines.push(`- \`${path}\` — ${file.name}, ${file.mediaType}, ${kilobytes(bytes.length)}, from ${from}. Its text is also in your context, as attachment-${name}.`);
    } else {
      if (!isTextType(file.mediaType)) binaries.push(path);
      lines.push(`- \`${path}\` — ${file.name}, ${file.mediaType}, ${kilobytes(bytes.length)}, from ${from}.`);
    }
  }

  if (lines.length > 0 || missing.length > 0) {
    documents.push({
      name: 'attachments.md',
      title: 'Files given with this work',
      content: [
        '# Files given with this work',
        '',
        'People gave these with the request or in the conversation since, or they are images in the issue. They are',
        'kept in OpenADLC and are never on GitHub: do not link to them from GitHub, and name them in what you write',
        'instead. Read each with your file tool (an image or a PDF opens with it) before you rely on what you were told',
        'it shows.',
        '',
        ...lines,
        ...(missing.length > 0 ? ['', 'Sent, but not here:', '', ...missing, '', 'Ask for them again if the work needs them.'] : []),
      ].join('\n'),
    });
  }
  return { documents, writes, binaries };
}

/** Writes what `prepareAttachments` fetched, once the context directory is there. */
export function writeAttachments(prepared: Pick<PreparedAttachments, 'writes'>): void {
  for (const write of prepared.writes) {
    // Written as the context documents are, inside the directory they made
    // private to this bot: the session reads them under the same user.
    mkdirSync(join(write.path, '..'), { recursive: true });
    writeFileSync(write.path, write.bytes);
  }
}
