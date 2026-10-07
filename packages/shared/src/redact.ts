/**
 * Credentials taken out of text meant for a person or a log.
 *
 * A failed git command's message carries its remote, and hostd authenticates
 * the remote by putting the bot's token in it — so `fatal: … https://x-access-
 * token:ghu_…@github.com/…` was stored as a task's reason and shown under
 * Details on the board. Anything that records or shows such text goes through
 * this.
 */
export interface SecretShape {
  /** What it is, in words, for a refusal: "an Anthropic key". */
  kind: string;
  pattern: RegExp;
  /** What `redactSecrets` puts in its place; `$1` is the part left visible. */
  masked: string;
}

/**
 * The one list of credential shapes. hostd's scrubber reads it too: when each
 * kept its own, the two drifted, and a model provider's key or a private key
 * was stored as a task's reason and accepted in an attachment.
 *
 * Every pattern has the `g` flag and is used only through `replace` and
 * `search`, which ignore `lastIndex`; `.test()` on one would carry it over
 * from the last call. The Anthropic shape comes before the generic `sk-` one
 * so the narrower kind is the one named.
 */

/** A JWT body character. `-` is one, which is why a hyphen may precede `eyJ`. */
function isJwtBody(c: string): boolean {
  return c === '-' || c === '_' || (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

/**
 * `eyJ` at `at` starts a token when it is at the start, or the character
 * before it is not a body character other than `-`. A letter or `_` is the
 * middle of a word (`\b` agrees). `-` is a boundary `\b` accepted, and a
 * lookbehind that rejects it leaves `token-eyJ…` in the clear.
 */
function jwtCanStart(text: string, at: number): boolean {
  if (at === 0) return true;
  const prev = text[at - 1];
  return prev === '-' || (prev !== undefined && !isJwtBody(prev));
}

/**
 * Read one JWT at `at` (which points at `eyJ`). On failure `scanned` is the
 * first character the next search may read: a rejected candidate's segments
 * share its dots, so a later `eyJ` inside them fails the same way, and
 * rereading them is the hang.
 */
function scanJwt(text: string, at: number): { end: number | null; scanned: number } {
  let p = at + 3;
  const segment = (): number => {
    const start = p;
    while (p < text.length) {
      const c = text[p];
      if (c === undefined || !isJwtBody(c)) break;
      p++;
    }
    return p - start;
  };
  if (segment() < 8 || text[p] !== '.') return { end: null, scanned: p };
  p++;
  if (segment() < 8 || text[p] !== '.') return { end: null, scanned: p };
  p++;
  if (segment() < 8) return { end: null, scanned: p };
  return { end: p, scanned: p };
}

function nextJwt(text: string, from: number): { start: number; end: number } | null {
  let i = from;
  while (i < text.length) {
    const at = text.indexOf('eyJ', i);
    if (at < 0) return null;
    if (!jwtCanStart(text, at)) {
      i = at + 3;
      continue;
    }
    const scan = scanJwt(text, at);
    if (scan.end !== null) return { start: at, end: scan.end };
    i = Math.max(at + 3, scan.scanned);
  }
  return null;
}

/**
 * `\b` matches between `-` and `e`, so a run of `-eyJ` started a scan at every
 * copy and each scan read the rest of the line (minutes on 1 MB). The
 * expression allows that hyphen; `exec` walks forward only, because the
 * engine's own search restarts at every copy. A length cap dropped a payload
 * over 4096 characters, and a trailing lookahead dropped a token that ended
 * on `-`.
 */
class JwtPattern extends RegExp {
  constructor() {
    super('(?<![A-Za-z0-9_])(eyJ)[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', 'g');
  }

  override exec(text: string): RegExpExecArray | null {
    const found = nextJwt(text, this.lastIndex);
    if (!found) {
      this.lastIndex = 0;
      return null;
    }
    this.lastIndex = found.end;
    const match = [text.slice(found.start, found.end), 'eyJ'] as unknown as RegExpExecArray;
    match.index = found.start;
    match.input = text;
    return match;
  }
}

/** A URL scheme character after the first letter: `https`, `postgres`, `a+b`. */
function isSchemeChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 46 || code === 45;
}

/** What `\s` stops a URL user or password on. A password may contain `//`. */
function isUrlSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

/**
 * `scheme://user:password@` at or after `from`, or null.
 *
 * `[^@\s]+` before `@` made each `a://x:` read the rest of the line, and a
 * group per character overflowed the stack on `a://x:` plus a long run of
 * `a:` with no `@`. A cap on the user left `https://` plus 300 letters plus
 * `:pw@` in the log, and stopping at `//` left `ab//cd` there. The scan walks
 * forward with `indexOf`, the same way a JWT does: a missing `@` continues
 * after the whitespace that ended the password, once.
 */
function nextUrlPassword(text: string, from: number): { start: number; prefixEnd: number; end: number } | null {
  let i = from;
  while (i < text.length) {
    const mark = text.indexOf('://', i);
    if (mark < 0) return null;
    let start = mark;
    while (start > 0 && isSchemeChar(text.charCodeAt(start - 1))) start--;
    // A scheme is at most 32 characters and starts with a letter. A longer
    // run, or a digit or mark in front (`1https`, `-https`), still has that
    // scheme at the end. Stopping at 32 and rejecting a scheme character
    // before the window left the password in the log.
    const earliest = mark - 32;
    if (start < earliest) start = earliest;
    while (start < mark && (text.charCodeAt(start) < 97 || text.charCodeAt(start) > 122)) start++;
    if (start >= mark) {
      i = mark + 3;
      continue;
    }
    let user = mark + 3;
    while (user < text.length) {
      const code = text.charCodeAt(user);
      if (code === 58 || code === 47 || code === 64 || isUrlSpace(code)) break;
      user++;
    }
    if (user === mark + 3 || text.charCodeAt(user) !== 58) {
      i = mark + 3;
      continue;
    }
    const prefixEnd = user + 1;
    let password = prefixEnd;
    while (password < text.length) {
      const code = text.charCodeAt(password);
      if (code === 64 || isUrlSpace(code)) break;
      password++;
    }
    if (password === prefixEnd || text.charCodeAt(password) !== 64) {
      i = password === prefixEnd ? prefixEnd : password;
      continue;
    }
    return { start, prefixEnd, end: password + 1 };
  }
  return null;
}

/**
 * The expression allows `//` inside a password and a user of any length.
 * `exec` walks with `indexOf`: the same expression overflowed the stack on
 * `a://x:` followed by megabytes of `a:`.
 */
class UrlPasswordPattern extends RegExp {
  constructor() {
    super('([a-z][a-z0-9+.-]{0,31}://[^:/\\s@]+:)[^@\\s]+@', 'g');
  }

  override exec(text: string): RegExpExecArray | null {
    const found = nextUrlPassword(text, this.lastIndex);
    if (!found) {
      this.lastIndex = 0;
      return null;
    }
    this.lastIndex = found.end;
    const match = [text.slice(found.start, found.end), text.slice(found.start, found.prefixEnd)] as unknown as RegExpExecArray;
    match.index = found.start;
    match.input = text;
    return match;
  }
}

/** Where a PEM label ends, when `[A-Z ]{0,32}PRIVATE KEY-----` follows `at`. */
function pemLabelEnd(text: string, at: number): number | null {
  const tail = 'PRIVATE KEY-----';
  const room = Math.min(text.length, at + 32 + tail.length);
  const rel = text.slice(at, room).indexOf(tail);
  if (rel < 0 || rel > 32) return null;
  for (let i = 0; i < rel; i++) {
    const code = text.charCodeAt(at + i);
    if (code !== 32 && (code < 65 || code > 90)) return null;
  }
  return at + rel + tail.length;
}

/**
 * A private key block at or after `from`.
 *
 * A lazy `[\\s\\S]*?` tried every length at every BEGIN when END was absent.
 * Stopping the body at `----` then missed an embedded certificate, an END
 * line with six dashes, and a second BEGIN before the END: the block runs
 * from the first BEGIN to the next END line. A group per character also
 * overflowed the stack at about 9 MB, inside the 10 MiB upload limit. END is
 * found with `indexOf`.
 */
function nextPrivateKey(text: string, from: number): { start: number; prefixEnd: number; end: number } | null {
  let i = from;
  while (i < text.length) {
    const at = text.indexOf('-----BEGIN ', i);
    if (at < 0) return null;
    const beginEnd = pemLabelEnd(text, at + '-----BEGIN '.length);
    if (beginEnd === null) {
      i = at + '-----BEGIN '.length;
      continue;
    }
    let search = beginEnd;
    while (search < text.length) {
      const endAt = text.indexOf('-----END ', search);
      // No END line after this BEGIN, so none after a later BEGIN either.
      // Searching again from each header is what made a run of them quadratic.
      if (endAt < 0) return null;
      const end = pemLabelEnd(text, endAt + '-----END '.length);
      if (end !== null) return { start: at, prefixEnd: beginEnd, end };
      search = endAt + '-----END '.length;
    }
    // The text ended on this header, or on `-----END ` with no label after
    // it. Leaving the search where it started finds the same header again,
    // and `redactSecrets` never returns — hostd redacts each pane line, so
    // a header on its own would hang it.
    return null;
  }
  return null;
}

/**
 * The expression is what `exec` finds, including a body that contains
 * `-----`. `exec` walks with `indexOf`: the unrolled body overflowed on
 * 9 MB of `-a`.
 */
class PrivateKeyPattern extends RegExp {
  constructor() {
    super('(-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----)[\\s\\S]*?-----END [A-Z ]{0,32}PRIVATE KEY-----', 'g');
  }

  override exec(text: string): RegExpExecArray | null {
    const found = nextPrivateKey(text, this.lastIndex);
    if (!found) {
      this.lastIndex = 0;
      return null;
    }
    this.lastIndex = found.end;
    const match = [text.slice(found.start, found.end), text.slice(found.start, found.prefixEnd)] as unknown as RegExpExecArray;
    match.index = found.start;
    match.input = text;
    return match;
  }
}

export const SECRET_SHAPES: readonly SecretShape[] = [
  // A credential in a URL of any scheme: https://user:secret@host, postgres://user:secret@host.
  { kind: 'a password in a URL', pattern: new UrlPasswordPattern(), masked: '$1***@' },
  // GitHub's token shapes, wherever they appear on their own.
  { kind: 'a GitHub token', pattern: /\b(gh[pousr]_)[A-Za-z0-9]{20,}\b/g, masked: '$1***' },
  { kind: 'a GitHub token', pattern: /\b(github_pat_)[A-Za-z0-9_]{20,}\b/g, masked: '$1***' },
  { kind: 'an Anthropic key', pattern: /(sk-ant-)[A-Za-z0-9_-]{8,}/g, masked: '$1***' },
  { kind: 'an OpenAI key', pattern: /\b(sk-(?:proj-)?)[A-Za-z0-9_-]{16,}/g, masked: '$1***' },
  { kind: 'an xAI key', pattern: /\b(xai-)[A-Za-z0-9_-]{16,}/g, masked: '$1***' },
  { kind: 'a JWT', pattern: new JwtPattern(), masked: '$1***' },
  { kind: 'a bearer token', pattern: /\b([Bb]earer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, masked: '$1***' },
  {
    kind: 'a private key',
    // PEM bodies are base64, but a key also arrives as one line of JSON with
    // `\n` escaped, as an OpenSSL encrypted block whose Proc-Type and DEK-Info
    // lines are headers, or indented in a YAML block. The match is anything
    // up to the next END line, found by walking (`PrivateKeyPattern`).
    pattern: new PrivateKeyPattern(),
    masked: '$1***',
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape.pattern, shape.masked);
  return out;
}

/** What kind of credential the text holds, or null when it holds none. */
export function secretKind(text: string): string | null {
  return SECRET_SHAPES.find((shape) => text.search(shape.pattern) !== -1)?.kind ?? null;
}
