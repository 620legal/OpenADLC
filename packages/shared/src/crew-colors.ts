/**
 * The color a crew member's avatar is drawn in, when a person chose one.
 *
 * The eight quiet tints the console already draws each role's avatar in,
 * named for their hue rather than numbered, so a stored choice says what it
 * is. As with a repository's color, a name and never a value: what `sand`
 * looks like is the console's to decide, once for the dark mode and once for
 * the light, and the initials on it have to stay readable in both.
 *
 * No choice, a null `bots.color`, is the role's tint, which is how every
 * avatar looked before a person could choose. Two seats of one role, such as
 * two builders, look the same until one of them is given a color of its own.
 *
 * The order is the tints' order, which is the pipeline's: intake's first.
 */
export const CREW_COLORS = ['sand', 'blue', 'mint', 'violet', 'rose', 'sky', 'olive', 'green'] as const;
export type CrewColor = (typeof CREW_COLORS)[number];

export function isCrewColor(value: unknown): value is CrewColor {
  return typeof value === 'string' && (CREW_COLORS as readonly string[]).includes(value);
}
