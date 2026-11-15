/**
 * The bytes a release's signature covers, and the asset that carries it
 * (ADR 0069).
 *
 * A managed repository's clients pin a public key and a tag, and check an
 * ed25519 signature over exactly these bytes:
 *
 *     <tag> LF <version> LF <sha256> LF <url> LF
 *
 * UTF-8, no BOM, every line ended by one 0x0A, the last included, and nothing
 * else. Shipped clients verify this layout, so it can never change in place: a
 * new layout is a new tag and a new client release. Every value is checked
 * here before a byte is built, so a value that would make two messages read
 * alike, such as one with an LF in it, never reaches the key.
 *
 * Pure, with no `node:` import: `@openadlc/shared` is bundled into the console.
 */

/** The tag a repository gets when its key was imported without one. */
export const DEFAULT_RELEASE_TAG = 'openadlc-release-manifest-1';

/** The three values a release's signature covers, always all three, in this order. */
export interface ReleaseFields {
  version: string;
  sha256: string;
  url: string;
}

/** A value refused before signing. Its message names the field and the rule. */
export class ReleaseManifestError extends Error {
  constructor(
    readonly field: 'tag' | keyof ReleaseFields,
    message: string,
  ) {
    super(message);
    this.name = 'ReleaseManifestError';
  }
}

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// C0, DEL and C1: an LF or CR would make a line of its own.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const WHITESPACE = /\s/;
const MAX_TAG_BYTES = 256;
const MAX_URL_LENGTH = 2048;

/** None of these values is secret, so an error may repeat the start of one. */
function shown(value: string): string {
  const head = value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return JSON.stringify(head);
}

/** Why a tag cannot be a release tag, or null when it can. */
export function releaseTagProblem(tag: string): string | null {
  if (typeof tag !== 'string' || tag.length === 0) return 'the release tag is empty; give one, or leave it out for the default';
  const encoded = new TextEncoder().encode(tag);
  // A lone surrogate encodes as U+FFFD, so the bytes signed would not be the
  // tag a person typed and a client pins: refuse it rather than sign those.
  if (new TextDecoder().decode(encoded) !== tag) {
    return 'the release tag is not valid Unicode text (it holds a lone surrogate); type it again';
  }
  const bytes = encoded.length;
  if (bytes > MAX_TAG_BYTES) return `the release tag is ${bytes} bytes; it may be at most ${MAX_TAG_BYTES}`;
  if (CONTROL.test(tag)) return 'the release tag holds a control character (a line break, a tab or the like); it must be one line of printable text';
  if (tag !== tag.trim()) return 'the release tag starts or ends with a space; take the space out';
  return null;
}

function check(tag: string, fields: ReleaseFields): void {
  const tagProblem = releaseTagProblem(tag);
  if (tagProblem) throw new ReleaseManifestError('tag', tagProblem);

  const { version, sha256, url } = fields;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new ReleaseManifestError(
      'version',
      `the version ${shown(String(version))} is not 1 to 64 characters of letters, digits, '.', '+' and '-'`,
    );
  }
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new ReleaseManifestError(
      'sha256',
      `the sha256 ${shown(String(sha256))} is not exactly 64 lowercase hex characters; uppercase is refused, not lowercased`,
    );
  }
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
    throw new ReleaseManifestError('url', `the url must be 1 to ${MAX_URL_LENGTH} characters`);
  }
  if (WHITESPACE.test(url) || CONTROL.test(url)) {
    throw new ReleaseManifestError('url', `the url ${shown(url)} holds whitespace or a control character`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReleaseManifestError('url', `the url ${shown(url)} is not an absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ReleaseManifestError('url', `the url ${shown(url)} is not https`);
  }
  // A published download URL has no reason to carry a login, and one signed
  // into the manifest would be public in every release asset. Not echoed.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ReleaseManifestError('url', 'the url holds a user name or password; give the download URL without them');
  }
  // A URL the parser would rewrite (a capital in the host, a default port, a
  // `..` segment) is refused rather than normalised: the bytes signed have to
  // be the bytes a client reads from the asset and fetches.
  if (parsed.href !== url) {
    throw new ReleaseManifestError('url', `the url ${shown(url)} is not in its normal form; give ${shown(parsed.href)}`);
  }
}

/**
 * The exact bytes a release's signature covers. Throws `ReleaseManifestError`
 * on any value that breaks its rule, before any bytes are built.
 */
export function releaseMessage(tag: string, fields: ReleaseFields): Uint8Array {
  check(tag, fields);
  return new TextEncoder().encode(`${tag}\n${fields.version}\n${fields.sha256}\n${fields.url}\n`);
}

/**
 * The published manifest asset: one JSON object with exactly `version`, `url`,
 * `sha256` and `sig`, in that order, and one LF. Its formatting is not signed:
 * a client reads the three values, rebuilds the message with its own pinned
 * tag, and checks `sig` over that.
 */
export function releaseManifestAsset(fields: ReleaseFields, sig: string): string {
  return `${JSON.stringify({ version: fields.version, url: fields.url, sha256: fields.sha256, sig })}\n`;
}
