/**
 * The release version rule, one copy for hostd's authoritative check before a
 * build (`apps/hostd/src/release-run.ts`) and the bridge's reading of the
 * last release and of hostd's report (`apps/bridge/src/release-service.ts`)
 * (docs/adr/0070-a-release-recipe-is-an-admins-and-its-artifact-stays-with-hostd.md).
 *
 * A version is 1 to 4 numbers, optionally `-<label>.<n>`. It is not semver: a
 * suffix ranks *above* the bare version of the same numbers, because the
 * shipped clients of the repository that asked for releases update on a higher
 * number, or an equal number with a higher `n`; under semver every release of
 * theirs would rank below the last.
 */

/** A release version. `n` is 0 with no suffix. `text` is the exact string read, so the tag is `v${text}`. */
export interface RepoVersion {
  text: string;
  parts: number[];
  label: string | null;
  n: number;
}

export type RepoVersionRead = { ok: true; version: RepoVersion } | { ok: false; reason: string };

/** The longest version: the signed manifest refuses a version over 64 characters (`releaseMessage`). */
export const REPO_VERSION_MAX_CHARS = 64;

const NUMBER = '(?:0|[1-9][0-9]*)';
const VERSION_GRAMMAR = new RegExp(`^(${NUMBER}(?:\\.${NUMBER}){0,3})(?:-([a-z][a-z0-9]{0,31})\\.(${NUMBER}))?$`);

/** The forms a reason names when it refuses a version. */
export const REPO_VERSION_FORMS = '`<1 to 4 numbers>` or `<1 to 4 numbers>-<lowercase label>.<number>`';

/** The version a string is, or why it is none. `where` names the file the reason tells to change. */
export function repoVersionFrom(text: string, where?: string): RepoVersionRead {
  const refuse = (why = '') => ({
    ok: false as const,
    reason: `\`${text.length > 80 ? `${text.slice(0, 80)}…` : text}\` is not a release version${why}: write ${REPO_VERSION_FORMS}${where ? ` in ${where}` : ''}`,
  });
  if (text.length > REPO_VERSION_MAX_CHARS) return refuse(` (it is longer than ${REPO_VERSION_MAX_CHARS} characters)`);
  const match = VERSION_GRAMMAR.exec(text);
  if (!match) return refuse();
  const parts = (match[1] ?? '').split('.').map(Number);
  const n = match[3] === undefined ? 0 : Number(match[3]);
  if ([...parts, n].some((value) => !Number.isSafeInteger(value))) return refuse(' (a number in it is too large)');
  return { ok: true, version: { text, parts, label: match[2] ?? null, n } };
}

/** A release's tag as a version: one leading `v` taken off. Null when it is not one, so a differently named older tag is skipped. */
export function repoVersionFromTag(tag: string): RepoVersion | null {
  const read = repoVersionFrom(tag.startsWith('v') ? tag.slice(1) : tag);
  return read.ok ? read.version : null;
}

/**
 * Reads the version from a version file's text, by the repository's file and
 * key: with no key, the whole file, trimmed; for a `.json` file, `key` is a
 * dotted path, `version` by default; for any other file with a key, the value
 * of the first `KEY = value` or `KEY: value` line, quotes taken off — which
 * reads `.xcconfig`'s `MARKETING_VERSION = 1.4.0`. No regular expression an
 * admin writes is run.
 */
export function parseRepoVersion(text: string, file: string, key: string | null): RepoVersionRead {
  if (file.toLowerCase().endsWith('.json')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, reason: `${file} is not JSON, so its version cannot be read: fix it, or set the repository's version file` };
    }
    const path = key ?? 'version';
    for (const step of path.split('.')) {
      value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[step] : undefined;
    }
    if (typeof value !== 'string') return { ok: false, reason: `${file} has no string at ${path}: add the version there, or set the repository's version key` };
    return repoVersionFrom(value, file);
  }
  if (!key) return repoVersionFrom(text.trim(), file);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) continue;
    const rest = trimmed.slice(key.length).trimStart();
    if (!rest.startsWith('=') && !rest.startsWith(':')) continue;
    let value = rest.slice(1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return repoVersionFrom(value, file);
  }
  return { ok: false, reason: `${file} has no line \`${key} = <version>\`: add it, or set the repository's version key` };
}

/**
 * How two versions order: by their numbers, a missing trailing part being 0,
 * then by `n`, a bare version being `n = 0`. Null when both carry a label and
 * the labels differ: two labels are never ordered against each other.
 */
export function compareRepoVersions(a: RepoVersion, b: RepoVersion): -1 | 0 | 1 | null {
  if (a.label !== null && b.label !== null && a.label !== b.label) return null;
  return compareRepoVersionsIgnoringLabel(a, b);
}

/** The order by numbers then `n` alone; for choosing the highest release, whose label the gate then holds the next one to. */
export function compareRepoVersionsIgnoringLabel(a: RepoVersion, b: RepoVersion): -1 | 0 | 1 {
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.parts[index] ?? 0;
    const y = b.parts[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return 0;
}

/** Why `version` may not follow `after`, or null when it may. `file` is where the reason says to change it. */
export function repoVersionGate(version: RepoVersion, after: RepoVersion | null, file: string): string | null {
  if (!after) return null;
  const order = compareRepoVersions(version, after);
  if (order === null) {
    return `${version.text} has the label ${version.label}, and the last release, ${after.text}, has ${after.label}: use ${after.label} in ${file}`;
  }
  if (order <= 0) return `${version.text} is not above the last release, ${after.text}: raise it in ${file}`;
  return null;
}

/**
 * Whether `repoVersionGate` refuses `version` only because it is at or below
 * `after`: the one refusal the release page answers with Prepare next version
 * (#363, docs/adr/0078). A label mismatch is not it — a person chooses which
 * label to release under, and a raised number would not settle that.
 */
export function repoVersionNotAbove(version: RepoVersion, after: RepoVersion | null): boolean {
  if (!after) return false;
  const order = compareRepoVersions(version, after);
  return order === -1 || order === 0;
}

/**
 * The version suggested to follow `last`: its `n` plus one when it carries a
 * label (`156.0.8078.79-abc.29` → `-abc.30`), otherwise its last number plus
 * one (`1.4.0` → `1.4.1`). Null when that would not be a version, a number
 * past the safe integers being the only way. The person may edit it; what is
 * sent is held to `repoVersionGate` all the same.
 */
export function suggestNextRepoVersion(last: RepoVersion): string | null {
  let text: string;
  if (last.label !== null) {
    const n = last.n + 1;
    if (!Number.isSafeInteger(n)) return null;
    text = `${last.parts.join('.')}-${last.label}.${n}`;
  } else {
    const parts = [...last.parts];
    const end = (parts[parts.length - 1] ?? 0) + 1;
    if (!Number.isSafeInteger(end)) return null;
    parts[parts.length - 1] = end;
    text = parts.join('.');
  }
  const read = repoVersionFrom(text);
  return read.ok ? read.version.text : null;
}
