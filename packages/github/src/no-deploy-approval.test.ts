import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A bot never approves a deploy; the repository's GitHub rules do.
 *
 * GitHub approves a deployment waiting on an environment's required reviewers
 * through REST, `POST /repos/{repo}/actions/runs/{id}/pending_deployments`, and
 * through GraphQL's `approveDeployments` mutation. OpenADLC holds the app's
 * token and every crew account's, and the app can approve for a reviewer that
 * is a team it belongs to. So the promise is kept by nothing in this
 * repository ever calling either — not the bridge, not a skill, not a
 * workflow, not a suite. This fails when any file it scans names one: every
 * directory of code and configuration, `.github/` and `tests/` included, and
 * the files at the root. It catches a name, not a call put together from
 * pieces; that is still for review.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = ['apps', 'packages', 'crew', 'infra', 'config', 'tests', '.github'];
const APPROVES = /pending_deployments|approveDeployments/;
const SKIPPED = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo']);
const THIS_FILE = relative(ROOT, fileURLToPath(import.meta.url));

function* files(directory: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED.has(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* files(path);
    else if (stat.size < 2_000_000) yield path;
  }
}

/** The files at the repository's root, such as the Makefile: not its directories. */
function rootFiles(): string[] {
  return readdirSync(ROOT)
    .map((entry) => join(ROOT, entry))
    .filter((path) => statSync(path).isFile() && statSync(path).size < 2_000_000);
}

describe('nothing OpenADLC runs approves a deployment', () => {
  it('scans directories that are there', () => {
    // `scripts` and `bin` were scanned and never existed, so they passed for ever.
    expect(SCANNED.filter((top) => !existsSync(join(ROOT, top)))).toEqual([]);
  });

  it('never names the endpoint or the mutation that approves one', () => {
    const offenders: string[] = [];
    let read = 0;
    for (const path of [...SCANNED.flatMap((top) => [...files(join(ROOT, top))]), ...rootFiles()]) {
      const name = relative(ROOT, path);
      if (name === THIS_FILE) continue;
      read += 1;
      if (APPROVES.test(readFileSync(path, 'utf8'))) offenders.push(name);
    }
    // A scan of nothing passes for ever; the bridge alone is hundreds of files.
    expect(read).toBeGreaterThan(200);
    expect(offenders, 'approving a deployment is the environment reviewers’ to do, never a bot’s').toEqual([]);
  });
});
