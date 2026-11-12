import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; it is run directly as well.
import { brokenLinksIn, linkTargets } from './check-links.mjs';

/**
 * The README is the repository's front page: the first screen says what
 * OpenADLC is, in the owner's words, and shows the board, and the detail lives
 * in the docs (#314). It carries no price: the $41.86 of model use once shown
 * there, at API list prices, read to a subscription user as the cost of one
 * change (#317).
 * Its pictures are HTML, which the link checker once skipped, so a renamed
 * screenshot would have left a broken image there with every test green.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const firstScreen = readme.slice(0, readme.indexOf('\n## '));

type Target = { line: number; target: string; image: boolean };

describe('the README', () => {
  it('has no broken link, image or anchor, Markdown or HTML', () => {
    expect(brokenLinksIn(ROOT, 'README.md')).toEqual([]);
  });

  it('keeps its sections, in order', () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(['How it works', 'One change, from request to release', 'Quick start', 'The crew', 'Safe by design', 'More']);
  });

  it('says on its first screen that a subscription or an API key will do, and links to the start and the proof', () => {
    expect(firstScreen).toContain('Use your subscription or an API key');
    const targets = (linkTargets(firstScreen) as Target[]).map((link) => link.target);
    expect(targets).toContain('#quick-start');
    expect(targets).toContain('#one-change-from-request-to-release');
  });

  it('puts no price on its first screen', () => {
    // A `$` followed by a digit, so badge URLs and other markup cannot trip it.
    expect(firstScreen, "a price on the README's first screen reads as the cost of a change (#317)").not.toMatch(/\$\s?\d/);
  });

  it('shows the board, light and dark, on its first screen, from files that exist', () => {
    const pictures = (linkTargets(firstScreen) as Target[]).filter((link) => link.image && !/^[a-z][a-z0-9+.-]*:/i.test(link.target)).map((link) => link.target);
    expect(pictures.length).toBeGreaterThanOrEqual(2);
    expect(pictures).toEqual(expect.arrayContaining(['docs/images/board-light.png', 'docs/images/board-dark.png']));
    for (const picture of pictures) expect(existsSync(join(ROOT, picture)), `${picture} is on the README's first screen and is not in the repository`).toBe(true);
  });
});
