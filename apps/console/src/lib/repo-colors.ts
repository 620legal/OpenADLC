/**
 * A repository's colour, as the console draws it.
 *
 * The bridge stores a name from this list; what each looks like is the
 * `--color-repo-*` tokens in `globals.css`, one value for the dark mode and one
 * for the light. It is the same list, in the same order, as
 * `packages/shared/src/repo-colors.ts`, which the console does not depend on;
 * a test holds the two together.
 *
 * The classes are written out whole because Tailwind finds a class by reading
 * the source for it: one assembled from a name at run time is never generated.
 */
export const REPO_COLORS = ['blue', 'amber', 'pink', 'teal', 'violet', 'orange'] as const;
export type RepoColor = (typeof REPO_COLORS)[number];

export function isRepoColor(value: unknown): value is RepoColor {
  return typeof value === 'string' && (REPO_COLORS as readonly string[]).includes(value);
}

const FILL: Record<RepoColor, string> = {
  blue: 'bg-repo-blue',
  amber: 'bg-repo-amber',
  pink: 'bg-repo-pink',
  teal: 'bg-repo-teal',
  violet: 'bg-repo-violet',
  orange: 'bg-repo-orange',
};

const EDGE: Record<RepoColor, string> = {
  blue: 'border-l-repo-blue',
  amber: 'border-l-repo-amber',
  pink: 'border-l-repo-pink',
  teal: 'border-l-repo-teal',
  violet: 'border-l-repo-violet',
  orange: 'border-l-repo-orange',
};

const NAMES: Record<RepoColor, string> = {
  blue: 'Blue',
  amber: 'Amber',
  pink: 'Pink',
  teal: 'Teal',
  violet: 'Violet',
  orange: 'Orange',
};

/**
 * The fill for a dot or a swatch. A colour the console does not know — an
 * older bridge, or a repository it has no colour for — is the quietest text
 * colour: still a dot beside the name, just not a coloured one.
 */
export function repoFill(color: string | null | undefined): string {
  return isRepoColor(color) ? FILL[color] : 'bg-dim';
}

/** The left edge of a card in the repository's colour, with `border-l-[3px]`. */
export function repoEdge(color: string | null | undefined): string {
  return isRepoColor(color) ? EDGE[color] : 'border-l-edge-strong';
}

/** "Teal", for a control that offers the colour by name. */
export function repoColorName(color: string | null | undefined): string {
  return isRepoColor(color) ? NAMES[color] : 'No color';
}

/** A repository as the console tells it apart: by name, and by colour. */
export interface RepoLook {
  name: string;
  fullName?: string | null;
  color?: string | null;
}

/** Each repository's colour by its name, for a badge that only has the name. */
export type RepoColorMap = Readonly<Record<string, string>>;

export function colorMapOf(repositories: readonly RepoLook[]): RepoColorMap {
  return Object.fromEntries(repositories.filter((repo) => repo.color).map((repo) => [repo.name, repo.color!]));
}

/**
 * The repository a subject is in, from its address: `api#12` and `api@3f2c1a9`
 * are in `api`; a console request, `request:a4b02784`, is in none it can say.
 */
export function repoOfRef(ref: string | null | undefined): string | null {
  const match = /^([^#@:\s]+)[#@]/.exec(ref ?? '');
  return match ? match[1]! : null;
}
