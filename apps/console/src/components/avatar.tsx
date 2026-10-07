'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { AVATAR_NAMES, AVATARS, avatarOf, EngineMarkSvg, type AvatarChoice } from '@/components/engine-avatars';
import type { BotFacts } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/crew';
import { crewTint } from '@/lib/crew-colors';

/** What the dot on an avatar says. Idle says nothing. */
export type AvatarStatus = 'working' | 'waiting' | 'idle';

const SIZES = {
  xs: 'size-4 text-[7.5px]',
  sm: 'size-[18px] text-[8px]',
  md: 'size-[22px] text-[9px]',
  /** Beside a message in a thread. */
  chat: 'size-7 text-[10px]',
  lg: 'size-8 text-[11px]',
  /** At the head of a bot's thread. */
  xl: 'size-[38px] text-[13px]',
} as const;

/**
 * The sizes a mark may move at. The board draws a row of `md` avatars on every
 * column, and a row of moving marks is a wall of motion that says nothing a
 * status dot does not, so only the single large avatars move: a crew card,
 * a thread's head, a message.
 */
const MOVING_SIZES: ReadonlySet<keyof typeof SIZES> = new Set(['lg', 'xl', 'chat']);

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeToMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

/**
 * Whether the person asked their system for less motion. The server cannot
 * know, so it renders as if they had not, and `globals.css` stops the
 * animation under the same media query for the frame before this is read.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToMotion,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(REDUCED_MOTION).matches : false),
    () => false,
  );
}

/**
 * Whether the element is on screen, read only while `watch` is true: a
 * moving avatar scrolled out of view stops rather than animating for no one.
 * With no IntersectionObserver it counts as on screen.
 */
function useOnScreen(watch: boolean): [RefObject<HTMLSpanElement | null>, boolean] {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!watch || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [watch]);
  return [ref, onScreen];
}

/**
 * A bot as a circle on the color a person chose for it in Settings →
 * Appearance, or its role's tint when nobody did. On it is the mark of the
 * engine it thinks with (`engine-avatars.tsx`), whichever mark a person
 * picked, or its two letters. A dot shows when it is working (signal) or
 * waiting on the person (attention).
 *
 * The mark moves only while the bot is working, only at the sizes in
 * `MOVING_SIZES`, only while it is on screen, and never under reduced motion.
 * Otherwise it shows the resting frame. The ring is a border in the colour
 * behind it, inside the circle's size, so a row of them overlaps by exactly the
 * margin it is given; pass `border-panel` when it sits on a card.
 *
 * It stays `aria-hidden`: the bot's name is beside it wherever it appears.
 */
export function BotAvatar({
  bot,
  size = 'md',
  status = 'idle',
  working,
  ring = false,
  className,
}: {
  /** With its engine, and the color and avatar a person chose, when the caller has them. */
  bot: BotFacts & { color?: string | null; avatar?: string | null; engine?: string | null };
  size?: keyof typeof SIZES;
  status?: AvatarStatus;
  /** Whether the bot is working, where no dot says so (a crew card has a pill instead). Defaults to the status. */
  working?: boolean;
  /** A border in the colour behind it, for avatars that overlap. */
  ring?: boolean;
  className?: string;
}) {
  const shown = avatarOf(bot);
  const reduced = usePrefersReducedMotion();
  const wantsMotion = shown !== 'initials' && (working ?? status === 'working') && MOVING_SIZES.has(size) && !reduced;
  const [ref, onScreen] = useOnScreen(wantsMotion);

  return (
    <span
      ref={ref}
      aria-hidden
      data-avatar={shown}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-soft',
        crewTint(bot),
        SIZES[size],
        ring && 'border-2 border-surface',
        className,
      )}
    >
      {shown === 'initials' ? initials(bot) : <EngineMarkSvg mark={shown} animate={wantsMotion && onScreen} />}
      {status !== 'idle' && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-surface',
            status === 'working' ? 'bg-signal' : 'bg-attention',
          )}
        />
      )}
    </span>
  );
}

/**
 * Which avatar a bot shows: by engine (no choice, stored as null), any of the
 * four marks, or its initials. Each option is the avatar itself, in the bot's
 * color, still, and named for a screen reader and on hover, with the chosen
 * one said in words beside them.
 */
export function AvatarPicker({
  bot,
  value,
  onChoose,
  label,
}: {
  bot: BotFacts & { color?: string | null; engine?: string | null };
  value: string | null;
  onChoose: (avatar: AvatarChoice | null) => void;
  /** The radiogroup's name, with the bot's: "builder avatar". */
  label: string;
}) {
  const byEngine = avatarOf({ ...bot, avatar: null });
  const options: { value: AvatarChoice | null; name: string; shows: AvatarChoice }[] = [
    { value: null, name: `By engine (${AVATAR_NAMES[byEngine]})`, shows: byEngine },
    ...AVATARS.map((avatar) => ({ value: avatar, name: AVATAR_NAMES[avatar], shows: avatar })),
  ];
  const chosen = options.find((option) => option.value === (value ?? null)) ?? options[0]!;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-0.5">
        {options.map((option) => {
          const checked = option === chosen;
          return (
            <button
              key={option.value ?? 'engine'}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={option.name}
              title={option.name}
              onClick={() => onChoose(option.value)}
              className={cn(
                'inline-flex size-11 items-center justify-center rounded-full border-2 transition-colors focus-visible:outline-2 focus-visible:outline-link md:size-7',
                checked ? 'border-body' : 'border-transparent hover:border-edge-strong',
                option.value === null && 'border-dashed',
              )}
            >
              <BotAvatar bot={{ ...bot, avatar: option.shows }} size="sm" />
            </button>
          );
        })}
      </div>
      <span className="min-w-12 text-[12.5px] text-soft">{chosen.value === null ? 'By engine' : chosen.name}</span>
    </div>
  );
}
