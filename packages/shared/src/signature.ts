import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { seatOf } from './stamp.js';

/**
 * A signature on what a seat posts to GitHub, so a post's seat is the bridge's
 * word and not the post's.
 *
 * The header and the seat tag say which stage wrote a post, and on an account
 * several seats share they are the only thing that does — but anything that can
 * post as the account can write them. So each post also carries
 * `<!-- fleetadlc-sig:v1.<kid>.<payload>.<mac> -->`: an HMAC, under a key only the
 * bridge holds, of the seat, the task, the repository, what kind of post it is
 * and a hash of the body. The bridge signs its own posts, and a session's `gh`
 * asks the bridge to sign its (`/internal/tasks/:id/stamp`), which signs only
 * for that task's seat. A post whose body was changed after signing, copied
 * from another, or written around `gh` has no signature that checks.
 */

export const SIGNATURE_VERSION = 'v1';

// No leading `\n*`: unanchored, it was tried from every newline of a long run
// of them, and a crafted post took seconds to verify on every webhook.
const SIG_TAG = /<!-- fleet(?:adlc)?-sig:(v1)\.([a-z0-9]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->\s*$/;
const ANY_SIG_TAG = /<!-- fleet(?:adlc)?-sig:[^>]*-->/g;

/** What a signature says: who, for what, and a hash of the body it was made for. */
export interface SignedFields {
  /** The seat, as the bot's name. */
  seat: string;
  /** The task it was posted for; null for the bridge's own posts, which no task makes. */
  task: string | null;
  /** owner/name, when there is one. */
  repo: string | null;
  /** What it is: `comment`, `review`, `issue`, `pr`, `edit`. */
  kind: string;
  /** The issue or pull request number it was posted to, when that was known when signing. */
  n?: number | null;
}

export interface SignaturePayload extends SignedFields {
  /** SHA-256 of the body without its signature, normalised; see `normalizeBody`. */
  h: string;
  /** When it was signed, in seconds. */
  iat: number;
  /** Once only: a signature seen on a second post is a copy. */
  nonce: string;
}

/**
 * The longest body signed or verified: GitHub's own limit for a comment or a
 * description. Anything longer is no post GitHub would hold, so it is refused
 * for signing and read as unsigned without being searched.
 */
export const SIGNED_BODY_MAX = 65_536;

export interface SigningKey {
  kid: string;
  secret: string;
}

/**
 * The body as GitHub gives it back, give or take: line endings and trailing
 * whitespace are GitHub's to change, and the signature itself is not part of
 * what it signs.
 */
export function normalizeBody(body: string): string {
  return body
    .replace(ANY_SIG_TAG, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(trimSpacesAndTabs)
    .join('\n')
    .trim();
}

/**
 * A line without its trailing spaces and tabs. A loop, not `/[ \t]+$/`: the
 * regex tried every space of a long run as a start, and one 60,000-space line
 * took seconds.
 */
function trimSpacesAndTabs(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return end === line.length ? line : line.slice(0, end);
}

export function bodyHash(body: string): string {
  return createHash('sha256').update(normalizeBody(body)).digest('base64url');
}

function mac(key: SigningKey, payload: string): string {
  return createHmac('sha256', key.secret).update(`${SIGNATURE_VERSION}.${key.kid}.${payload}`).digest('base64url');
}

/** A new key, and its id: the first bytes of its hash, so a key names itself. */
export function newSigningKey(): SigningKey {
  const secret = randomBytes(32).toString('base64url');
  const kid = createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return { kid, secret };
}

/** The body with its signature at the end, replacing any it had. */
export function signBody(
  body: string,
  fields: SignedFields,
  key: SigningKey,
  now: Date = new Date(),
  nonce: string = randomBytes(12).toString('base64url'),
): string {
  const bare = body.replace(ANY_SIG_TAG, '').trimEnd();
  const payload: SignaturePayload = {
    seat: fields.seat.toLowerCase(),
    task: fields.task,
    repo: fields.repo,
    kind: fields.kind,
    ...(fields.n ? { n: fields.n } : {}),
    h: bodyHash(bare),
    iat: Math.floor(now.getTime() / 1000),
    nonce,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${bare}\n\n<!-- fleetadlc-sig:${SIGNATURE_VERSION}.${key.kid}.${encoded}.${mac(key, encoded)} -->`;
}

export type Verdict =
  | { ok: true; payload: SignaturePayload; kid: string }
  | { ok: false; reason: 'unsigned' | 'malformed' | 'unknown-key' | 'bad-mac' | 'body-changed' | 'seat-mismatch'; payload?: SignaturePayload };

/**
 * Whether a body's signature is one of `keys`', for this body. The seat tag in
 * the body has to name the seat the signature does, so a signed post cannot
 * have its tag rewritten to another seat.
 */
export function verifyBody(body: string | null | undefined, keys: readonly SigningKey[]): Verdict {
  const found = body && body.length <= SIGNED_BODY_MAX ? SIG_TAG.exec(body) : null;
  if (!body || !found) return { ok: false, reason: 'unsigned' };
  const [, , kid, encoded, presented] = found;
  const key = keys.find((one) => one.kid === kid);
  let payload: SignaturePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as SignaturePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload.seat !== 'string' || typeof payload.h !== 'string') return { ok: false, reason: 'malformed' };
  if (!key) return { ok: false, reason: 'unknown-key', payload };

  const expected = Buffer.from(mac(key, encoded!));
  const given = Buffer.from(presented!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad-mac', payload };
  if (payload.h !== bodyHash(body)) return { ok: false, reason: 'body-changed', payload };
  const tagged = seatOf(body);
  if (tagged && tagged !== payload.seat) return { ok: false, reason: 'seat-mismatch', payload };
  return { ok: true, payload, kid: kid! };
}

/** What each reason means, for a card and the audit log. */
export const UNVERIFIED_REASON: Record<Exclude<Verdict, { ok: true }>['reason'] | 'replayed' | 'wrong-target', string> = {
  unsigned: 'it carries no signature — it was posted around OpenADLC’s gh, or by something else signed in as the account',
  malformed: 'its signature cannot be read',
  'unknown-key': 'it is signed with a key this install does not have',
  'bad-mac': 'its signature does not check',
  'body-changed': 'it was changed after it was signed',
  'seat-mismatch': 'its seat tag names a different seat than its signature',
  replayed: 'its signature was already used on another post',
  'wrong-target': 'it was signed for a different issue or pull request',
};
