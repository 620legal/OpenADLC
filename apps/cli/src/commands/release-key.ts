import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  getSecretStore,
  parseReleaseKeyRecord,
  rawPublicKey,
  releaseSigningKeyRef,
  serializeReleaseKeyRecord,
  type ReleaseKeyRecord,
  type SecretStore,
} from '@openadlc/github';
import { DEFAULT_RELEASE_TAG, releaseTagProblem } from '@openadlc/shared';
import { ui } from '../ui.js';

/**
 * `openadlc release-key import | show`: a repository's release signing key,
 * put in the secret store from a file on the host (ADR 0069).
 *
 * A file, on the host, by a person: there is no route in the bridge, hostd
 * or the console that takes a key, so nothing that reaches the install over
 * the network can set the key every client trusts. OpenADLC never makes,
 * rotates or deletes one. Clients pin the public half and the tag, so a
 * different key or tag over the one filed is refused without `--replace`.
 *
 * Nothing the file holds is ever printed: a refusal says what kind of thing
 * was found and what to do, and crypto's own errors are dropped, not passed
 * on, since they can quote what they failed to read.
 */

/** Bigger than any ed25519 key file; a path to the wrong file is said so before it is read. */
const MAX_KEY_FILE_BYTES = 16 * 1024;

/** PKCS#8's wrapping of a raw 32-byte ed25519 seed (RFC 8410): this prefix, then the seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const GENERATE = 'openssl genpkey -algorithm ed25519 -out release-key.pem';

/**
 * The flags each subcommand reads. Checked here rather than in `flags.ts`'s
 * table, and as strictly: a typo of `--tag` taken as no tag would import the
 * key under the default one, which every client pinning another would refuse.
 */
const SUBCOMMANDS: Readonly<Record<string, { values: readonly string[]; switches: readonly string[] }>> = {
  import: { values: ['repo', 'file', 'tag'], switches: ['replace'] },
  show: { values: ['repo'], switches: [] },
};

export interface ReleaseKeyArgs {
  subcommand: 'import' | 'show';
  repo: string;
  file?: string;
  tag?: string;
  replace: boolean;
}

const USAGE_LINE =
  'usage: openadlc release-key import --repo OWNER/NAME --file PATH [--tag TAG] [--replace] | openadlc release-key show --repo OWNER/NAME';

/** The arguments after `release-key`, or what is wrong with them. */
export function releaseKeyArgs(argv: readonly string[]): ReleaseKeyArgs | { refusal: string } {
  const [subcommand, ...rest] = argv;
  const known = subcommand !== undefined ? SUBCOMMANDS[subcommand] : undefined;
  if (!known || (subcommand !== 'import' && subcommand !== 'show')) {
    return { refusal: `unknown release-key command: ${subcommand ?? '(none)'}; ${USAGE_LINE}` };
  }
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (!argument.startsWith('--')) {
      return { refusal: `openadlc release-key ${subcommand} takes no argument ${argument}; ${USAGE_LINE}` };
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (known.switches.includes(name)) {
      if (inline !== undefined) return { refusal: `--${name} takes no value` };
      switches.add(name);
      continue;
    }
    if (!known.values.includes(name)) {
      const takes = [...known.values, ...known.switches].map((flag) => `--${flag}`).join(', ');
      return { refusal: `openadlc release-key ${subcommand} does not take ${argument}; it takes ${takes}` };
    }
    if (values[name] !== undefined) return { refusal: `--${name} was given twice; give it once` };
    const value = inline ?? rest[index + 1];
    if (inline === undefined) index += 1;
    if (value === undefined || value === '' || value.startsWith('--')) return { refusal: `--${name} needs a value` };
    values[name] = value;
  }
  const repo = values.repo;
  if (!repo) return { refusal: `--repo is required; ${USAGE_LINE}` };
  if (!REPO.test(repo)) return { refusal: `--repo ${JSON.stringify(repo)} is not OWNER/NAME, as GitHub spells a repository` };
  if (subcommand === 'show') return { subcommand, repo, replace: false };
  if (!values.file) return { refusal: `--file is required: the path of the key file; ${USAGE_LINE}` };
  return {
    subcommand,
    repo,
    file: values.file,
    ...(values.tag !== undefined ? { tag: values.tag } : {}),
    replace: switches.has('replace'),
  };
}

/** The public facts of a key, which are what a client pins. */
function publicFacts(key: KeyObject): { raw: string; pem: string } {
  return {
    raw: rawPublicKey(key).toString('base64'),
    pem: String(createPublicKey(key).export({ type: 'spki', format: 'pem' })).trim(),
  };
}

/**
 * An ed25519 private key from what a key file holds, or why not. Two forms: a
 * PKCS#8 PEM, as `openssl genpkey -algorithm ed25519` writes it, or the
 * 32-byte seed in standard base64. The refusal never quotes the file.
 */
export function readReleaseKey(contents: Buffer): { key: KeyObject } | { refusal: string } {
  const text = contents.toString('utf8');
  if (text.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')) {
    return { refusal: 'the key file is encrypted; decrypt it first: openssl pkey -in <file> -out <plain.pem>, import that, then delete it' };
  }
  if (text.includes('-----BEGIN')) {
    let key: KeyObject | null = null;
    try {
      key = createPrivateKey({ key: text, format: 'pem' });
    } catch {
      key = null;
    }
    if (!key) {
      let isPublic = false;
      try {
        createPublicKey({ key: text, format: 'pem' });
        isPublic = true;
      } catch {
        isPublic = false;
      }
      if (isPublic) return { refusal: 'this is a public key; import the private half, which signs' };
      return { refusal: `the key file is not a PKCS#8 PEM or a base64 32-byte ed25519 seed; make one with: ${GENERATE}` };
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      return { refusal: `this is an ${key.asymmetricKeyType ?? 'unknown'} key; release signing takes ed25519 (${GENERATE})` };
    }
    return { key };
  }

  const trimmed = text.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    const seed = Buffer.from(trimmed, 'base64');
    if (seed.toString('base64') === trimmed) {
      if (seed.length !== 32) {
        return { refusal: `the base64 in the key file is ${seed.length} bytes; an ed25519 seed is exactly 32` };
      }
      try {
        return { key: createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' }) };
      } catch {
        return { refusal: 'the seed in the key file could not be read as an ed25519 key' };
      }
    }
  }
  return { refusal: `the key file is not a PKCS#8 PEM or a base64 32-byte ed25519 seed; make one with: ${GENERATE}` };
}

/** An open key file: what it is, then its bytes, both from the one descriptor. */
export interface KeyFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  /** At most `max` bytes from the start of the file. */
  read(max: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ReleaseKeyDeps {
  store: SecretStore;
  /** Opens the path itself, never a link at it: a link is refused with `ELOOP`. */
  open: (path: string) => Promise<KeyFileHandle>;
}

/**
 * The path is opened once, without following a link (`O_NOFOLLOW`), and what
 * it is and what it holds are both read from that descriptor. Checking the
 * path with `lstat` and then reading it by name let a swap between the two
 * calls put a link, or another file, behind a check that had already passed
 * (review of #349). `O_NONBLOCK` keeps a FIFO at the path from holding the
 * open until something writes to it; it changes nothing for a regular file.
 */
export async function openKeyFile(path: string): Promise<KeyFileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  return {
    stat: () => handle.stat(),
    read: async (max) => {
      const buffer = Buffer.alloc(max);
      let filled = 0;
      while (filled < max) {
        const { bytesRead } = await handle.read(buffer, filled, max - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    },
    close: () => handle.close(),
  };
}

function liveDeps(): ReleaseKeyDeps {
  return { store: getSecretStore(), open: openKeyFile };
}

function tooBig(path: string, size: number): { refusal: string } {
  return { refusal: `${path} is ${size} bytes, too big to be an ed25519 key (at most ${MAX_KEY_FILE_BYTES}); check the path` };
}

/** The key file's bytes, or why it is not read. */
async function keyFile(path: string, deps: ReleaseKeyDeps): Promise<{ bytes: Buffer } | { refusal: string }> {
  let handle: KeyFileHandle;
  try {
    handle = await deps.open(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ELOOP') return { refusal: `${path} is a link; give the key file itself` };
    if (code === 'ENOENT' || code === 'ENOTDIR') return { refusal: `there is no file at ${path}; give the path of the key file` };
    return { refusal: `${path} could not be opened; check that this account may read it` };
  }
  try {
    let stat: { isFile(): boolean; size: number };
    try {
      stat = await handle.stat();
    } catch {
      return { refusal: `${path} could not be read; check that this account may read it` };
    }
    if (!stat.isFile()) return { refusal: `${path} is not a regular file (a directory, a link or a device); give the key file itself` };
    if (stat.size > MAX_KEY_FILE_BYTES) return tooBig(path, stat.size);
    let bytes: Buffer;
    try {
      // One byte past the cap, so a file that grew after the stat is still caught.
      bytes = await handle.read(MAX_KEY_FILE_BYTES + 1);
    } catch {
      return { refusal: `${path} could not be read; check that this account may read it` };
    }
    if (bytes.length > MAX_KEY_FILE_BYTES) return tooBig(path, bytes.length);
    return { bytes };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The stored key's public facts, or null for a record whose key no longer reads. */
function storedPublic(record: ReleaseKeyRecord): { raw: string; pem: string } | null {
  try {
    const key = createPrivateKey({ key: record.key, format: 'pem' });
    return key.asymmetricKeyType === 'ed25519' ? publicFacts(key) : null;
  } catch {
    return null;
  }
}

function printPublic(repo: string, tag: string, facts: { raw: string; pem: string }): void {
  ui.note(`repository: ${repo}`);
  ui.note(`tag: ${tag}`);
  ui.note(`public key (raw, base64): ${facts.raw}`);
  for (const line of facts.pem.split('\n')) ui.code(line);
}

async function importKey(args: ReleaseKeyArgs & { file: string }, deps: ReleaseKeyDeps): Promise<number> {
  const tag = args.tag ?? DEFAULT_RELEASE_TAG;
  const tagProblem = releaseTagProblem(tag);
  if (tagProblem) {
    ui.fail(tagProblem);
    return 1;
  }

  const file = await keyFile(args.file, deps);
  if ('refusal' in file) {
    ui.fail(file.refusal);
    return 1;
  }
  const read = readReleaseKey(file.bytes);
  if ('refusal' in read) {
    ui.fail(read.refusal);
    return 1;
  }
  const facts = publicFacts(read.key);
  const record: ReleaseKeyRecord = {
    v: 1,
    repo: args.repo,
    tag,
    key: String(read.key.export({ type: 'pkcs8', format: 'pem' })),
  };

  const ref = releaseSigningKeyRef(args.repo);
  // Read, compare, then write: not atomic, so two imports at once for one
  // repository could each pass the check. It is a command a person runs on
  // the host, one at a time, and the store has no compare-and-set to hold it to.
  const existing = await deps.store.get(ref);
  if (existing !== null) {
    const stored = parseReleaseKeyRecord(existing);
    const storedFacts = stored ? storedPublic(stored) : null;
    const same = stored !== null && storedFacts !== null && storedFacts.raw === facts.raw && stored.tag === tag;
    if (same) {
      ui.ok(`this key and tag are already imported for ${args.repo}; nothing changed`);
      printPublic(args.repo, tag, facts);
      return 0;
    }
    if (!args.replace) {
      ui.fail(`${args.repo} already has a different release signing key or tag; nothing was changed`);
      ui.note(`stored: tag ${stored?.tag ?? '(unreadable)'}, public key ${storedFacts?.raw ?? '(unreadable)'}`);
      ui.note(`new:    tag ${tag}, public key ${facts.raw}`);
      ui.note('Every client that pins the stored public key or tag stops accepting releases signed with the new one.');
      ui.note('If that is what you mean, run this again with --replace.');
      return 1;
    }
    ui.warn(`replacing ${args.repo}'s release signing key: clients that pin the old public key or tag stop accepting new releases`);
  }

  await deps.store.set(ref, serializeReleaseKeyRecord(record));
  ui.ok(`imported the release signing key for ${args.repo}`);
  printPublic(args.repo, tag, facts);
  ui.note('Pin this public key and the tag in the clients. OpenADLC never rotates the key.');
  ui.note('Delete the key file once you have it safe elsewhere; an encrypted backup (openadlc backup) carries the key.');
  return 0;
}

async function showKey(args: ReleaseKeyArgs, deps: ReleaseKeyDeps): Promise<number> {
  const stored = await deps.store.get(releaseSigningKeyRef(args.repo));
  if (stored === null) {
    ui.fail(`no release signing key for ${args.repo}; run: openadlc release-key import --repo ${args.repo} --file <path>`);
    return 1;
  }
  const record = parseReleaseKeyRecord(stored);
  const facts = record ? storedPublic(record) : null;
  if (!record || !facts) {
    ui.fail(
      `the release signing key filed for ${args.repo} cannot be read; import it again: openadlc release-key import --repo ${args.repo} --file <path> --replace`,
    );
    return 1;
  }
  ui.ok(`the release signing key for ${record.repo}`);
  printPublic(record.repo, record.tag, facts);
  return 0;
}

/** Runs `openadlc release-key …` with the arguments after `release-key`; the exit code. */
export async function releaseKey(argv: readonly string[], deps: ReleaseKeyDeps = liveDeps()): Promise<number> {
  const args = releaseKeyArgs(argv);
  if ('refusal' in args) {
    ui.fail(args.refusal);
    return 2;
  }
  if (args.subcommand === 'show') return showKey(args, deps);
  return importKey({ ...args, file: args.file as string }, deps);
}
