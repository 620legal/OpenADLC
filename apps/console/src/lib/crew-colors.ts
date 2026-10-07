/**
 * A crew member's color, as the console draws it: the tint behind its
 * avatar's initials.
 *
 * The bridge stores a name from this list, or null for the role's tint; what
 * each looks like is the `--color-tint-*` tokens in `globals.css`, one value
 * for the dark mode and one for the light, each keeping the initials at AA.
 * It is the same list, in the same order, as
 * `packages/shared/src/crew-colors.ts`, which the console does not depend on;
 * a test holds the two together.
 *
 * The classes are written out whole because Tailwind finds a class by reading
 * the source for it: one assembled from a name at run time is never generated.
 */
export const CREW_COLORS = ['sand', 'blue', 'mint', 'violet', 'rose', 'sky', 'olive', 'green'] as const;
export type CrewColor = (typeof CREW_COLORS)[number];

export function isCrewColor(value: unknown): value is CrewColor {
  return typeof value === 'string' && (CREW_COLORS as readonly string[]).includes(value);
}

const FILL: Record<CrewColor, string> = {
  sand: 'bg-tint-sand',
  blue: 'bg-tint-blue',
  mint: 'bg-tint-mint',
  violet: 'bg-tint-violet',
  rose: 'bg-tint-rose',
  sky: 'bg-tint-sky',
  olive: 'bg-tint-olive',
  green: 'bg-tint-green',
};

const NAMES: Record<CrewColor, string> = {
  sand: 'Sand',
  blue: 'Blue',
  mint: 'Mint',
  violet: 'Violet',
  rose: 'Rose',
  sky: 'Sky',
  olive: 'Olive',
  green: 'Green',
};

/**
 * Each role's tint, in pipeline order, so a crew of nine can be told apart
 * with nobody having chosen anything. By role rather than by name, so a bot
 * keeps its color when it connects and takes its handle; automation has none
 * of its own.
 */
const BY_ROLE: Readonly<Record<string, CrewColor>> = {
  intake: 'sand',
  spec: 'blue',
  implement: 'mint',
  review_lead: 'violet',
  review_second: 'rose',
  review_security: 'sky',
  deploy: 'olive',
  qa: 'green',
};

/** The fill for a color, or the well for one the console does not know. */
export function crewFill(color: string | null | undefined): string {
  return isCrewColor(color) ? FILL[color] : 'bg-well';
}

/** The tint a role has when nobody chose one. */
export function roleTint(role: string | null | undefined): string {
  return crewFill(role ? BY_ROLE[role] : null);
}

/**
 * What an avatar is drawn in: the color a person chose for the bot, and its
 * role's tint when they chose none, or chose one this console does not know.
 */
export function crewTint(bot: { role?: string | null; color?: string | null }): string {
  return isCrewColor(bot.color) ? FILL[bot.color] : roleTint(bot.role);
}

/** "Rose", for a control that offers the color by name; "By role" for none. */
export function crewColorName(color: string | null | undefined): string {
  return isCrewColor(color) ? NAMES[color] : 'By role';
}
