import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ADR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'adr');

/**
 * Every ADR number taken by more than one file, with the files that share it.
 * #413 and #415 were built side by side and both took 0097, as #396 and #399
 * had both taken 0087; each merged green, because nothing compared numbers,
 * and a bare `docs/adr/0087` in a comment no longer said which record it
 * meant (#416). Only `NNNN-*.md` names count, so the README is skipped.
 */
function duplicateAdrNumbers(names: string[]): { number: string; files: string[] }[] {
  const byNumber = new Map<string, string[]>();
  for (const name of names) {
    const match = /^(\d{4})-.+\.md$/.exec(name);
    if (!match) continue;
    const files = byNumber.get(match[1]!) ?? [];
    files.push(name);
    byNumber.set(match[1]!, files);
  }
  return [...byNumber]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => ({ number, files: files.sort() }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

function describeDuplicates(dups: { number: string; files: string[] }[]): string {
  return dups
    .map(
      (d) =>
        `ADR ${d.number} is taken by ${d.files.join(' and ')}: renumber the later one to the next free number and follow its citations`,
    )
    .join('\n');
}

describe('the ADRs under docs/adr', () => {
  it('gives each ADR under docs/adr its own number', () => {
    const dups = duplicateAdrNumbers(readdirSync(ADR_DIR));
    expect(dups, describeDuplicates(dups)).toEqual([]);
  });

  it('refuses the duplicates main had before #416', () => {
    const dups = duplicateAdrNumbers([
      'README.md',
      '0000-template.md',
      '0087-a-project-map-is-generated-by-hostd-from-its-mirror-and-kept-under-the-work-root.md',
      '0087-security-review-findings-are-stored-from-the-seats-signed-marker.md',
      '0088-a-project-map-reaches-spec-and-implement-sessions-as-a-capped-document-from-hostd.md',
      '0097-a-host-checks-git-starts-no-background-maintenance.md',
      '0097-a-skill-that-writes-only-scratch-and-adrs-is-read-only-to-openadlcs-git-and-rg.md',
    ]);
    expect(dups).toEqual([
      {
        number: '0087',
        files: [
          '0087-a-project-map-is-generated-by-hostd-from-its-mirror-and-kept-under-the-work-root.md',
          '0087-security-review-findings-are-stored-from-the-seats-signed-marker.md',
        ],
      },
      {
        number: '0097',
        files: [
          '0097-a-host-checks-git-starts-no-background-maintenance.md',
          '0097-a-skill-that-writes-only-scratch-and-adrs-is-read-only-to-openadlcs-git-and-rg.md',
        ],
      },
    ]);
    expect(describeDuplicates(dups)).toContain(
      'ADR 0097 is taken by 0097-a-host-checks-git-starts-no-background-maintenance.md and 0097-a-skill-that-writes-only-scratch-and-adrs-is-read-only-to-openadlcs-git-and-rg.md',
    );
  });
});
