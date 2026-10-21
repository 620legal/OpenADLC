import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { archivePathAllowed, parseReleaseManifest, RELEASE_MANIFEST, type ReleaseManifest } from '@openadlc/shared';

/**
 * A release's archive (docs/self-hosting.md#what-a-release-holds), read and
 * unpacked by this code rather than by `tar`.
 *
 * The system's tar differs between macOS and Linux in what it does with a
 * link, an absolute path or `..`, and with what each lets through by
 * default. An archive is opened only after its checksum and attestation have
 * passed, so these are the bytes release.yml made; still, what comes out of
 * one is decided here, entry by entry, against the contract: the manifest and
 * the built output's directories and regular files, nothing else, each written
 * once, under the tree it is unpacked into, and never through a link already
 * there. Anything else refuses the whole archive before a byte is written.
 */

/** What a release's archive may grow to unpacked. Its build output is about 30 MB. */
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;

export class ArchiveRefused extends Error {
  constructor(reason: string) {
    super(`the release's archive was refused: ${reason}`);
    this.name = 'ArchiveRefused';
  }
}

export interface ArchiveEntry {
  path: string;
  type: 'file' | 'directory';
  /** For a file: whether any execute bit is set. */
  executable: boolean;
  data: Buffer | null;
}

const BLOCK = 512;

function text(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function octal(header: Buffer, offset: number, length: number, what: string): number {
  // The base-256 form, high bit set, is for sizes past 8 GB; none of ours is.
  if ((header[offset] ?? 0) & 0x80) throw new ArchiveRefused(`a ${what} in base-256`);
  const value = text(header, offset, length).trim();
  if (value === '') return 0;
  if (!/^[0-7]+$/.test(value)) throw new ArchiveRefused(`a ${what} that is not a number (${JSON.stringify(value)})`);
  return Number.parseInt(value, 8);
}

/** The checksum a header carries, against the one its bytes make with the field read as spaces. */
function checksumHolds(header: Buffer): boolean {
  const stated = octal(header, 148, 8, 'header checksum');
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  return sum === stated;
}

/** The records of a pax extended header: `<length> <key>=<value>\n`, each. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new ArchiveRefused('a pax header that does not parse');
    const length = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > data.length) {
      throw new ArchiveRefused('a pax header that does not parse');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 0) throw new ArchiveRefused('a pax header that does not parse');
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/**
 * Every entry of a gzip-compressed tar, checked against the contract, in
 * order. Throws `ArchiveRefused` at the first that is not allowed, so a caller
 * that writes nothing until this returns writes nothing for a bad archive.
 */
export function readArchive(file: string): { entries: ArchiveEntry[]; manifest: ReleaseManifest } {
  let bytes: Buffer;
  try {
    bytes = gunzipSync(readFileSync(file), { maxOutputLength: ARCHIVE_MAX_BYTES });
  } catch (error) {
    throw new ArchiveRefused(`it is not a gzip file of at most ${ARCHIVE_MAX_BYTES / 1024 / 1024} MB (${error instanceof Error ? error.message : error})`);
  }
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let manifest: ReleaseManifest | null = null;
  let pax: Map<string, string> | null = null;
  let longName: string | null = null;
  let offset = 0;
  let ended = false;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    if (!checksumHolds(header)) throw new ArchiveRefused(`an entry whose header checksum does not hold, ${offset - BLOCK} bytes in`);
    const type = String.fromCharCode(header[156] ?? 0);
    const size = octal(header, 124, 12, 'size');
    if (offset + size > bytes.length) throw new ArchiveRefused('an entry that runs past the end of the archive');
    const data = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    // What describes the next entry rather than being one.
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = text(data, 0, data.length);
      continue;
    }

    const ustar = text(header, 257, 6).startsWith('ustar');
    const prefix = ustar ? text(header, 345, 155) : '';
    const named = pax?.get('path') ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    pax = null;
    longName = null;
    const path = named.replace(/^\.\//, '').replace(/\/+$/, '');

    let kind: ArchiveEntry['type'];
    if (type === '0' || type === '\0' || type === '7') kind = 'file';
    else if (type === '5') kind = 'directory';
    else throw new ArchiveRefused(`${JSON.stringify(path)} is a ${type === '1' ? 'hard link' : type === '2' ? 'symbolic link' : `tar entry of type ${JSON.stringify(type)}`}, and a release holds only directories and files`);
    if (path === '' && kind === 'directory') continue;
    if (!archivePathAllowed(path, kind)) throw new ArchiveRefused(`${JSON.stringify(path)} is not part of the built output`);
    if (seen.has(path)) throw new ArchiveRefused(`${JSON.stringify(path)} is in it twice`);
    seen.add(path);

    const mode = octal(header, 100, 8, 'mode');
    if (path === RELEASE_MANIFEST) {
      if (kind !== 'file' || size > 4096) throw new ArchiveRefused(`${RELEASE_MANIFEST} is not a small file`);
      manifest = parseReleaseManifest(data.toString('utf8'));
      if (!manifest) throw new ArchiveRefused(`${RELEASE_MANIFEST} is not the manifest release.yml writes`);
      continue;
    }
    entries.push({ path, type: kind, executable: kind === 'file' && (mode & 0o111) !== 0, data: kind === 'file' ? Buffer.from(data) : null });
  }

  if (!ended) throw new ArchiveRefused('it ends before its end marker');
  if (!manifest) throw new ArchiveRefused(`it has no ${RELEASE_MANIFEST}`);
  if (!entries.some((entry) => entry.type === 'file')) throw new ArchiveRefused('it holds no built output');
  return { entries, manifest };
}

/**
 * Writes the entries under `into`. Each directory on the way is made, or must
 * already be a directory and not a link; each file is created new, never
 * written over or through what is there. The tree is a fresh worktree of the
 * release's commit, where none of these paths are tracked, so anything in the
 * way is a reason to stop.
 */
export function unpackArchive(entries: readonly ArchiveEntry[], into: string): number {
  const checked = new Set<string>();
  const directory = (relative: string): void => {
    if (relative === '' || relative === '.' || checked.has(relative)) return;
    directory(dirname(relative));
    const absolute = join(into, relative);
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(absolute);
    } catch {
      mkdirSync(absolute, { mode: 0o755 });
    }
    if (stat && !stat.isDirectory()) throw new ArchiveRefused(`${relative} is in the way, and is not a directory`);
    checked.add(relative);
  };
  let files = 0;
  for (const entry of entries) {
    if (entry.type === 'directory') {
      directory(entry.path);
      continue;
    }
    directory(dirname(entry.path));
    let fd: number;
    try {
      fd = openSync(join(into, entry.path), 'wx', entry.executable ? 0o755 : 0o644);
    } catch (error) {
      throw new ArchiveRefused(`${entry.path} could not be written new (${(error as NodeJS.ErrnoException).code ?? error})`);
    }
    try {
      writeSync(fd, entry.data ?? Buffer.alloc(0));
    } finally {
      closeSync(fd);
    }
    files += 1;
  }
  return files;
}
