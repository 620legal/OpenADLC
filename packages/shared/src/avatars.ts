/**
 * What a crew member's avatar shows, when a person chose.
 *
 * Four small animated marks drawn for OpenADLC, one for each engine family, and
 * the two letters every avatar used to be. They are original designs that
 * hint at how each engine feels, not any vendor's logo, wordmark or colors,
 * and they are named for what they are rather than for a vendor: `petals`,
 * `dots`, `orbit`, `gear`. A bot on claude shows petals unless a person picks
 * something else.
 *
 * No choice, a null `bots.avatar`, is by engine, so a bot moved to another
 * engine changes its mark with it. `initials` is always the two letters.
 */
export const AVATARS = ['petals', 'dots', 'orbit', 'gear', 'initials'] as const;
export type Avatar = (typeof AVATARS)[number];

export function isAvatar(value: unknown): value is Avatar {
  return typeof value === 'string' && (AVATARS as readonly string[]).includes(value);
}
