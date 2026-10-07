import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The suites' usage lines and errors told the reader to export
 * FLEETADLC_SCRIPTED_ENGINES and run `fleetadlc up`. Plain `fleetadlc up` starts the
 * install ~/.fleetadlc points at, the real one on a machine that runs OpenADLC:
 * restarted scripted, it passed the suites' guard and the next run deleted its
 * tasks and leases. The advice is the scratch install's, as tests/all.mjs gives
 * it. Naming the command to describe it, or to warn against it, is allowed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((name) => name.endsWith('.mjs'));

const TOLD_TO_RUN = [/FLEETADLC_SCRIPTED_ENGINES=1\s+fleetadlc up\b/, /\brun\s+`?fleetadlc up\b/i];

describe('what the integration suites tell a reader to run', () => {
  it('is a scratch install, never fleetadlc up', () => {
    expect(suites.length).toBeGreaterThan(0);
    const told = suites.flatMap((name) =>
      readFileSync(join(here, name), 'utf8')
        .split('\n')
        .map((line, index) => ({ at: `${name}:${index + 1}`, line }))
        .filter(({ line }) => TOLD_TO_RUN.some((pattern) => pattern.test(line)))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(told).toEqual([]);
  });
});
