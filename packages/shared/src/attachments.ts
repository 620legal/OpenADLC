import { secretKind } from './redact.js';

/**
 * What a person may give the crew with a request or a message: a screenshot of
 * what the page should look like, a PDF of the requirements, a CSV of the data.
 *
 * Kept in OpenADLC's own database and given to the crew's models; never posted
 * to GitHub, where a private repository's screenshot would be one link away
 * from anyone it was forwarded to. The limits keep one item from growing the
 * database without bound, and the types are what the engines can read: an
 * image or a PDF the model opens itself, text it is given as a document. An
 * SVG or an HTML page is refused: either can carry script, and the console
 * serves an attachment back for a preview.
 */

export const ATTACHMENT_LIMITS = {
  /** One file. */
  fileBytes: 10 * 1024 * 1024,
  /** Files on one work item: its request, its issue and its pull request together. */
  itemFiles: 20,
  /** Bytes on one work item, together. */
  itemBytes: 25 * 1024 * 1024,
  /** How long an upload waits to be sent with a request or a message before it is swept. */
  unclaimedHours: 24,
  /** The largest text attachment also given to a task as a document of its own. */
  textInContextBytes: 200 * 1024,
} as const;

/** Each type taken, by media type, with the extension a file of it is saved under. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
};

/** The types in words, for a refusal that says what is taken. */
export const ATTACHMENT_TYPES_IN_WORDS = 'PNG, JPEG, GIF or WebP images, PDFs, and text (.txt, .md, .csv, .json)';

/** Whether a media type is text, given to a task as a document as well as a file. */
export function isTextType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'application/json';
}

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((byte, index) => bytes[at + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** What the bytes are, read from their first bytes: a declared type is the sender's word, not the file's. */
export function sniffBinary(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  return null;
}

/** The text the bytes are, or null when they are not UTF-8 text. */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Text a browser would run as a page or a drawing: refused even under a .txt name. */
function isMarkup(text: string): boolean {
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 512).toLowerCase();
  return /^<(?:\?xml|svg|!doctype\s+html|html|script)\b/.test(head) || /<svg[\s>]/.test(head);
}

function extensionOf(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? '';
}

/**
 * A file's name made safe to write under a task's context directory and to
 * put in a header: no folders, nothing but letters, digits, dots, dashes and
 * underscores, and never empty or hidden.
 */
export function safeFileName(name: string, mediaType?: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(-100);
  const fallback = `attachment.${(mediaType && ATTACHMENT_TYPES[mediaType]) || 'bin'}`;
  return cleaned && cleaned !== '.' ? cleaned : fallback;
}

export type AttachmentCheck = { ok: true; mediaType: string; text: string | null } | { ok: false; reason: string };

/**
 * Whether a file may be attached, and what it is.
 *
 * The type is the bytes', never the name's or the header's: an HTML page named
 * `notes.txt` is an HTML page. Text is held to `SECRET_SHAPES`, the shapes
 * every log and thread line is masked by: a file with a key or a token in it
 * is refused, with what was found, rather than stored and handed to a model.
 */
export function checkAttachment(input: { name: string; bytes: Uint8Array }): AttachmentCheck {
  const { name, bytes } = input;
  const said = name.trim() || 'the file';
  if (bytes.length === 0) return { ok: false, reason: `${said} is empty` };
  if (bytes.length > ATTACHMENT_LIMITS.fileBytes) {
    return { ok: false, reason: `${said} is ${sizeOver(bytes.length)}; a file can be ${megabytes(ATTACHMENT_LIMITS.fileBytes)} at most` };
  }
  const extension = extensionOf(name);
  // A picture of source code is no use to anybody: code is pasted, or sent
  // as text under a name a browser does not run.
  if (['js', 'mjs'].includes(extension)) {
    return { ok: false, reason: `${said} is JavaScript, which a browser could run; paste the code or attach it as a .txt file instead` };
  }
  if (['svg', 'svgz', 'html', 'htm', 'xhtml', 'xml'].includes(extension)) {
    return { ok: false, reason: `${said} is ${extension.toUpperCase()}, which can carry script; attach a PNG or a PDF of it instead` };
  }

  const binary = sniffBinary(bytes);
  if (binary) return { ok: true, mediaType: binary, text: null };

  const text = asText(bytes);
  if (text === null) return { ok: false, reason: `${said} is not a type OpenADLC takes. It takes ${ATTACHMENT_TYPES_IN_WORDS}` };
  if (isMarkup(text)) {
    return { ok: false, reason: `${said} is an HTML or SVG document, which can carry script; attach a PNG or a PDF of it instead` };
  }
  const secret = secretKind(text);
  if (secret) {
    return {
      ok: false,
      reason: `${said} contains what looks like a credential (${secret}). Take it out and attach the file again: attachments are given to the crew's models`,
    };
  }
  const mediaType =
    extension === 'md' || extension === 'markdown'
      ? 'text/markdown'
      : extension === 'csv'
        ? 'text/csv'
        : extension === 'json'
          ? 'application/json'
          : 'text/plain';
  if (mediaType === 'application/json') {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, reason: `${said} is named .json but is not JSON; rename it .txt to attach it as text` };
    }
  }
  return { ok: true, mediaType, text };
}

/** "2.4 MB", for a refusal. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * A refused file's size, rounded up to a tenth: `megabytes` rounds a file just
 * over the limit down to the limit, and "is 10 MB; a file can be 10 MB at most"
 * reads as a contradiction.
 */
function sizeOver(bytes: number): string {
  return `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Whether more attachments fit on an item that already has `used`, said as the
 * refusal when they do not.
 */
export function itemRoomFor(used: { count: number; bytes: number }, adding: { count: number; bytes: number }): string | null {
  if (used.count + adding.count > ATTACHMENT_LIMITS.itemFiles) {
    return `a work item can carry ${ATTACHMENT_LIMITS.itemFiles} files; this one has ${used.count}, and ${adding.count} more would be too many`;
  }
  if (used.bytes + adding.bytes > ATTACHMENT_LIMITS.itemBytes) {
    return `a work item can carry ${megabytes(ATTACHMENT_LIMITS.itemBytes)} of files; this one has ${megabytes(used.bytes)}, and these would take it past that`;
  }
  return null;
}

/**
 * A file a task is given, as the bridge names it to hostd: hostd fetches the
 * bytes by id and checks them against the hash before writing them, so a file
 * changed or cut short on the way never reaches a model as the one sent.
 */
export interface TaskAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  /** Who gave it: a person's identity, or the GitHub login whose issue it was in. */
  from?: string;
  /** Where it came from: the console, or an image in the issue. */
  source?: 'console' | 'github';
}

/** The variable a task's session lists its attachments' paths in, comma-separated. */
export const ATTACHMENTS_ENV = 'FLEETADLC_ATTACHMENTS';
