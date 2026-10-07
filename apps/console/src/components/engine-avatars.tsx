'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The marks a crew member's avatar can show instead of its initials: one for
 * each engine family, drawn for OpenADLC.
 *
 * These are original designs. Each is meant to evoke how its engine feels to
 * work with, and none reproduces, traces or derives from any vendor's logo,
 * wordmark, logo shape or brand colors. That is why they are named for what
 * they are, not for a vendor:
 *
 *   petals  a soft ring of six rounded petals that slowly breathes (claude)
 *   dots    a three-by-three grid of dots that ripples like a loader (codex)
 *   orbit   a dotted ring, an inner arc that follows it round a center
 *           dot, and a spark that circles it (grok). Nothing crosses the
 *           ring, so it cannot read as a slashed circle at a small size.
 *   gear    an eight-toothed wheel that ticks round once every few seconds
 *           (the automation bot, which thinks with nothing)
 *
 * They are drawn in `currentColor`, the avatar's text color, on the bot's
 * color or its role's tint, so two seats on one engine are still told apart
 * and every one keeps the contrast the initials had. They move only while the
 * bot is working, at the sizes `avatar.tsx` allows, and never under reduced
 * motion. `animate` is what turns the animation classes on. Without it the
 * SVG is the resting frame and carries no animation class at all.
 *
 * The list is `AVATARS` in `packages/shared/src/avatars.ts`, which the console
 * does not depend on. `avatar.test.tsx` holds the two together.
 */
export const AVATARS = ['petals', 'dots', 'orbit', 'gear', 'initials'] as const;
export type AvatarChoice = (typeof AVATARS)[number];
export type EngineMark = Exclude<AvatarChoice, 'initials'>;

export function isAvatar(value: unknown): value is AvatarChoice {
  return typeof value === 'string' && (AVATARS as readonly string[]).includes(value);
}

/** Each engine's mark when nobody chose one. */
const BY_ENGINE: Readonly<Record<string, EngineMark>> = {
  claude: 'petals',
  codex: 'dots',
  grok: 'orbit',
  none: 'gear',
};

/**
 * What an avatar shows: the choice a person made, else its engine's mark, and
 * the initials for an engine this console does not know.
 */
export function avatarOf(bot: { avatar?: string | null; engine?: string | null; role?: string | null }): AvatarChoice {
  if (isAvatar(bot.avatar)) return bot.avatar;
  // The automation bot thinks with nothing even where the view does not carry its engine.
  const engine = bot.engine ?? (bot.role === 'automation' ? 'none' : null);
  return (engine && BY_ENGINE[engine]) || 'initials';
}

/**
 * The faintest any part of a mark is drawn, at rest or in its animation: `soft`
 * at this opacity over the palest tint still measures 3:1, which is what a
 * graphic needs to be seen (WCAG 1.4.11). `contrast.test.ts` measures it.
 */
export const MARK_FLOOR = 0.6;

export const AVATAR_NAMES: Readonly<Record<AvatarChoice, string>> = {
  petals: 'Petals',
  dots: 'Dot grid',
  orbit: 'Orbit',
  gear: 'Gear',
  initials: 'Initials',
};

function Mark({ animate, children }: { animate: boolean; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      className={cn('size-[78%] overflow-visible', animate && 'avatar-moving')}
      fill="currentColor"
    >
      {children}
    </svg>
  );
}

/** Six rounded petals round a center, breathing in scale and opacity. */
function Petals({ animate }: { animate: boolean }) {
  return (
    <Mark animate={animate}>
      <g className={animate ? 'avatar-breathe' : undefined}>
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <ellipse key={angle} cx="12" cy="6.6" rx="2.7" ry="3.6" opacity="0.72" transform={`rotate(${angle} 12 12)`} />
        ))}
        <circle cx="12" cy="12" r="2.4" />
      </g>
    </Mark>
  );
}

/**
 * Nine dots whose opacity ripples from one corner to the other. The faintest a
 * dot gets, resting or moving, is `MARK_FLOOR`: `soft` at that opacity keeps
 * 3:1 on every tint in both modes (`contrast.test.ts`), so no dot disappears
 * at a small size.
 */
function Dots({ animate }: { animate: boolean }) {
  return (
    <Mark animate={animate}>
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((column) => (
          <circle
            key={`${row}-${column}`}
            cx={6 + column * 6}
            cy={6 + row * 6}
            r="2.1"
            opacity={animate ? undefined : [MARK_FLOOR, 0.8, 1][(row + column) % 3]}
            className={animate ? 'avatar-ripple' : undefined}
            style={animate ? { animationDelay: `${(row + column) * 0.18}s` } : undefined}
          />
        )),
      )}
    </Mark>
  );
}

/**
 * A dotted ring, an inner quarter arc round a center dot, like a nearer orbit,
 * and a spark that circles the ring. The arc follows the ring, from nine
 * o'clock to twelve, on purpose: a straight stroke across a ring is too close
 * to another company's mark at 18 pixels, where the dots run together into a
 * solid circle.
 */
function Orbit({ animate }: { animate: boolean }) {
  return (
    <Mark animate={animate}>
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1.4 2.6" strokeLinecap="round" opacity="0.8" />
      <path d="M7 12 A5 5 0 0 1 12 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.5" />
      <g className={animate ? 'avatar-orbit' : undefined}>
        <circle cx="12" cy="4" r="1.9" />
      </g>
    </Mark>
  );
}

/** An eight-toothed wheel around a hole, turning one tooth at a time. */
function Gear({ animate }: { animate: boolean }) {
  // Eight teeth, each a step out and back on a 16-sided outline.
  const points = Array.from({ length: 32 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2 - Math.PI / 2;
    const radius = index % 4 < 2 ? 9 : 6.8;
    return `${(12 + radius * Math.cos(angle)).toFixed(2)},${(12 + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(' ');
  return (
    <Mark animate={animate}>
      <g className={animate ? 'avatar-tick' : undefined}>
        <path fillRule="evenodd" d={`M${points.replace(/ /g, ' L')} Z M12 9.2 A2.8 2.8 0 1 0 12 14.8 A2.8 2.8 0 1 0 12 9.2 Z`} />
      </g>
    </Mark>
  );
}

const MARKS: Record<EngineMark, (props: { animate: boolean }) => ReactNode> = {
  petals: Petals,
  dots: Dots,
  orbit: Orbit,
  gear: Gear,
};

/** An engine's mark as an SVG, still unless `animate`. */
export function EngineMarkSvg({ mark, animate = false }: { mark: EngineMark; animate?: boolean }) {
  const Drawn = MARKS[mark];
  return <Drawn animate={animate} />;
}
