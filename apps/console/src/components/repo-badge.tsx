'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { repoFill, type RepoColorMap } from '@/lib/repo-colors';

/**
 * Each repository's colour by its name, for everything under the page's shell.
 *
 * A card, a "needs you" item and a bot's task only carry the repository's
 * name; the colour is the install's, and threading it through every component
 * that might show a name is how a badge ends up grey in the one place nobody
 * passed it to.
 */
const RepoColors = createContext<RepoColorMap>({});

export function RepoColorsProvider({ colors, children }: { colors: RepoColorMap; children: ReactNode }) {
  return <RepoColors.Provider value={colors}>{children}</RepoColors.Provider>;
}

export function useRepoColors(): RepoColorMap {
  return useContext(RepoColors);
}

/**
 * The repositories a person paused on their own, by name, so that
 * every badge under the page says so without each caller being told.
 */
const PausedRepos = createContext<ReadonlySet<string>>(new Set());

export function PausedReposProvider({ names, children }: { names: readonly string[]; children: ReactNode }) {
  return <PausedRepos.Provider value={new Set(names)}>{children}</PausedRepos.Provider>;
}

export function usePausedRepos(): ReadonlySet<string> {
  return useContext(PausedRepos);
}

/** "paused", beside a repository's name while a person has paused it. */
export function PausedMark({ className }: { className?: string }) {
  return <span className={cn('shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-attention', className)}>paused</span>;
}

/** A repository's colour as a dot. Never on its own: the name is beside it. */
export function RepoDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', repoFill(color), className)} />;
}

/**
 * Which repository something is in: its colour and its name, together.
 *
 * The name is what is read, and what a screen reader hears; the colour is what
 * finds it at a glance, and is never the only way to tell. A long name is cut
 * short, with the whole of it on hover.
 */
export function RepoBadge({
  name,
  color,
  title,
  className,
}: {
  name: string;
  /** Its colour, when the caller has it; otherwise the page's, by name. */
  color?: string | null;
  /** The whole name, `owner/name`, where there is more to it than the badge says. */
  title?: string;
  className?: string;
}) {
  const colors = useRepoColors();
  const paused = usePausedRepos().has(name);
  return (
    <span
      title={`${title ?? name}${paused ? ' (paused)' : ''}`}
      className={cn(
        'inline-flex h-[18px] min-w-0 max-w-[11rem] shrink-0 items-center gap-1 rounded-full bg-well pl-1.5 pr-2 text-[11px] font-medium text-soft',
        className,
      )}
    >
      <RepoDot color={color ?? colors[name]} className="size-1.5" />
      <span className="truncate">{name}</span>
      {paused && <PausedMark />}
    </span>
  );
}
