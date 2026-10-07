import { parse as parseYaml } from 'yaml';
import { DEFAULT_EXCLUSIVE_PATHS, DEFAULT_SHARED_PATHS } from './delivery-rules.js';
import { pathMatches } from './path-overlap.js';

/**
 * What a conflict resolution and a stacked build read of a repository's
 * `.github/fleetadlc.yml`:
 *
 * ```yaml
 * paths:
 *   shared: [Makefile, README.md]      # a clash here is resolved and re-checked by the lead alone
 *   exclusive: [db/migrations/**]
 * stacking: true                         # work that depends on work in review starts from its branch
 * ```
 *
 * `paths` is the same section the delivery rules' path policy reads, with the
 * same defaults; this reads it tolerantly, on its own, so a resolution never
 * waits on rules that do not parse. A file that is absent or does not parse
 * gets the defaults.
 */
export interface ResolutionPolicy {
  paths: { shared: string[]; exclusive: string[] };
  stacking: boolean;
}

// The delivery rules' defaults, not a copy of them: the dispatcher and a
// conflict round have to agree on which files are shared.
const SHARED_BY_DEFAULT = DEFAULT_SHARED_PATHS;
const EXCLUSIVE_BY_DEFAULT = DEFAULT_EXCLUSIVE_PATHS;

export function resolutionPolicy(text: string | null | undefined): ResolutionPolicy {
  const fallback: ResolutionPolicy = { paths: { shared: [...SHARED_BY_DEFAULT], exclusive: [...EXCLUSIVE_BY_DEFAULT] }, stacking: true };
  if (!text) return fallback;
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return fallback;
  }
  const doc = (raw && typeof raw === 'object' ? raw : {}) as { paths?: { shared?: unknown; exclusive?: unknown }; stacking?: unknown };
  const list = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : null;
  return {
    paths: {
      shared: list(doc.paths?.shared) ?? fallback.paths.shared,
      exclusive: list(doc.paths?.exclusive) ?? fallback.paths.exclusive,
    },
    stacking: typeof doc.stacking === 'boolean' ? doc.stacking : true,
  };
}

/**
 * The policy a conflict resolution goes by: as `resolutionPolicy`, except
 * that a file which is there and does not parse gives null rather than the
 * defaults. The defaults let the lead alone re-check a resolution in files
 * the repository may never have called shared, so a resolution under a
 * broken file is reviewed in full. Stacking keeps reading the tolerant one.
 */
export function resolutionPolicyStrict(text: string | null | undefined): ResolutionPolicy | null {
  if (!text) return resolutionPolicy(text);
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return null;
  }
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) return null;
  return resolutionPolicy(text);
}

/**
 * Whether a path is one a policy pattern names, as the dispatcher reads them:
 * a pattern without a `/` names a file by its name at any depth; one with a
 * `/` is a path from the root, `*` within a name and `**` across folders.
 */
export function policyMatches(path: string, pattern: string): boolean {
  // The dispatcher's own matcher (`path-overlap.ts`): one reading of a pattern.
  return pathMatches(path, pattern);
}

/** Whether every path is a shared one. An empty list is not: nothing is known to be safe. */
export function allShared(paths: readonly string[], policy: ResolutionPolicy): boolean {
  return paths.length > 0 && paths.every((path) => policy.paths.shared.some((pattern) => policyMatches(path, pattern)));
}
