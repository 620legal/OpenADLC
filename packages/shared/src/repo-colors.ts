/**
 * The colour a repository is told apart by, where the console shows more than
 * one at once.
 *
 * A colour is a name from this list, never a value: what `blue` looks like is
 * the console's to decide, once for the dark mode and once for the light, and
 * a stored hex would be the wrong colour in one of them. They are chosen so
 * that no two share a lightness either, which is what still tells them apart
 * without colour vision — and the console never shows one without the
 * repository's name beside it.
 *
 * Six rather than more. Every colour added has to fit between the others in a
 * light mode that has only so much room above the page's white, and eight left
 * pairs that deuteranopia folds into one. An install with a seventh repository
 * shares a colour, and the names still say which is which.
 *
 * The order is the order they are handed out in, so the first two a person
 * sees are the two furthest apart.
 */
export const REPO_COLORS = ['blue', 'amber', 'pink', 'teal', 'violet', 'orange'] as const;
export type RepoColor = (typeof REPO_COLORS)[number];

export function isRepoColor(value: unknown): value is RepoColor {
  return typeof value === 'string' && (REPO_COLORS as readonly string[]).includes(value);
}

/**
 * The colour a repository being added gets: the first nobody has, in the order
 * above, and once every one is taken the one fewest repositories share.
 *
 * `used` is the colours of the repositories OpenADLC works in now. One removed
 * from OpenADLC gives its colour back, and has it again when it is added back
 * unless another repository was given it meanwhile.
 */
export function nextRepoColor(used: readonly string[]): RepoColor {
  const count = (color: RepoColor): number => used.filter((one) => one === color).length;
  let best: RepoColor = REPO_COLORS[0];
  for (const color of REPO_COLORS) {
    if (count(color) < count(best)) best = color;
  }
  return best;
}
