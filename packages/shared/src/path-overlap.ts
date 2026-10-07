/**
 * Two pieces of work collide when their declared paths can touch the same file.
 * Comparison is on path prefixes with `**` and `*` treated as wildcards, which is
 * deliberately coarse: a false collision costs a five-minute wait, a missed one
 * costs a merge conflict a bot cannot resolve.
 */
export function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => singleOverlap(a, b)));
}

/**
 * Whether a path is one a policy pattern names. A pattern without a `/` is a
 * file's name at any depth (`Makefile`, `*lock*.json`), as `.gitignore` reads
 * one; with a `/` it is a path from the root, `*` and `**` as wildcards. A
 * declared folder is named by a pattern that reaches into it: `db/` is an
 * exclusive path only when a pattern names it, not because
 * a migration could be somewhere under it.
 */
export function pathMatches(path: string, pattern: string): boolean {
  const segments = normalise(path);
  if (segments.length === 0) return false;
  // A pattern ending in `/` is a folder and everything in it: `exclusive: [db/]`
  // means the migrations under db/, and read as the one path `db` it held
  // nothing. The conflict round read it as a folder; now both do.
  if (/\/$/.test(pattern)) {
    const folder = normalise(pattern);
    return folder.length > 0 && folder.length <= segments.length && folder.every((part, index) => segmentsMatch(part, segments[index] as string));
  }
  if (!pattern.replace(/\/+$/, '').includes('/')) {
    return segmentsMatch(pattern, segments[segments.length - 1] as string) || pattern === '**';
  }
  return matchFrom(segments, normalise(pattern));
}

function matchFrom(path: string[], pattern: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip += 1) if (matchFrom(path.slice(skip), rest)) return true;
    return false;
  }
  if (path.length === 0) return false;
  return segmentsMatch(head as string, path[0] as string) && matchFrom(path.slice(1), rest);
}

/** How two overlapping paths are treated; see `pathPolicySchema` in `@fleetadlc/shared`. */
export type OverlapKind = 'shared' | 'exclusive' | 'ordinary';

/**
 * Exclusive when either side is an exclusive path; shared only when both are
 * shared, so a declared `docs/` against a shared `docs/guide/index.md` is not
 * waved through; ordinary otherwise.
 */
export function overlapKind(mine: string, theirs: string, policy: { shared: readonly string[]; exclusive: readonly string[] }): OverlapKind {
  const isExclusive = (path: string) => policy.exclusive.some((pattern) => pathMatches(path, pattern));
  const isShared = (path: string) => policy.shared.some((pattern) => pathMatches(path, pattern));
  if (isExclusive(mine) || isExclusive(theirs)) return 'exclusive';
  if (isShared(mine) && isShared(theirs)) return 'shared';
  return 'ordinary';
}

function normalise(path: string): string[] {
  return path
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

function singleOverlap(a: string, b: string): boolean {
  const left = normalise(a);
  const right = normalise(b);
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const x = left[index] as string;
    const y = right[index] as string;
    if (x === '**' || y === '**') return true;
    if (x === '*' || y === '*') continue;
    if (x.includes('*') && y.includes('*') ? globsOverlap(x, y) : segmentsMatch(x, y)) continue;
    return false;
  }

  return true;
}

/**
 * Whether two segments that both hold `*` can match one name. Compared as
 * pattern against the other's text, stars and all, `scheduler*` and `*.test.ts`
 * were disjoint, though `scheduler.test.ts` is both. Every `*` can take any
 * run, so they can meet exactly when their text before the first `*` agrees
 * (one starts the other) and their text after the last `*` does too. Not in
 * segmentsMatch: policy classification reads a pattern against a path, and
 * there a declared `READ*` must not count as the shared `README*`.
 */
function globsOverlap(x: string, y: string): boolean {
  const [xHead, yHead] = [x.slice(0, x.indexOf('*')), y.slice(0, y.indexOf('*'))];
  const [xTail, yTail] = [x.slice(x.lastIndexOf('*') + 1), y.slice(y.lastIndexOf('*') + 1)];
  return (xHead.startsWith(yHead) || yHead.startsWith(xHead)) && (xTail.endsWith(yTail) || yTail.endsWith(xTail));
}

function segmentsMatch(x: string, y: string): boolean {
  if (x === y) return true;
  if (x.includes('*')) return globMatch(x, y);
  if (y.includes('*')) return globMatch(y, x);
  return false;
}

/**
 * Whether `value` is a name `pattern` matches: `*` is any run of characters,
 * and every other character, `.`, `?` and `[` included, is itself.
 *
 * Two pointers, going back only to the last `*`, so the time is at worst the
 * two lengths multiplied, whatever the pattern holds. It was a RegExp of `.*`
 * for each star, which backtracks exponentially on a segment that fails to
 * match: `apps/bridge/src/************Q` took eight seconds against one file
 * name, and the dispatcher runs this inside the bridge on every pass, so one
 * issue body carrying that path froze webhooks, the console and the merge line.
 * The plan-change gate holds a request to this same rule (`declaredPathsOverlap`).
 */
export function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      resume = v;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p += 1;
      v += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      v = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}
