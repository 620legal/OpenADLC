'use client';

import { useEffect, useRef, useState } from 'react';
import { setCrewAvatar, setCrewColor, updateRepoSettings } from '@/app/actions';
import { AvatarPicker, BotAvatar } from '@/components/avatar';
import { RepoDot } from '@/components/repo-badge';
import type { CrewMember } from '@/lib/api';
import { botLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { inPipelineOrder, roleTitle } from '@/lib/crew';
import { CREW_COLORS, crewColorName, crewFill, roleTint } from '@/lib/crew-colors';
import { REPO_COLORS, repoColorName, repoFill } from '@/lib/repo-colors';
import { safeAction } from '@/lib/safe-action';

/** One color on offer: what is stored, what it is called, and what its swatch is filled with. */
export interface Swatch {
  value: string | null;
  name: string;
  fill: string;
}

/**
 * A palette, one swatch per color, each named for a screen reader and on
 * hover, and the one chosen said in words beside them. The repository page's
 * color and both of Appearance's lists are this one control, so a swatch
 * looks and answers the same wherever a color is chosen.
 */
export function ColorChoice({
  label,
  swatches,
  value,
  onChoose,
}: {
  /** The radiogroup's name: "Color" alone on a repository's page, "api color" in a list of them. */
  label: string;
  swatches: readonly Swatch[];
  value: string | null;
  onChoose: (value: string | null) => void;
}) {
  const chosen = swatches.find((swatch) => swatch.value === value);
  // A crew palette names "By role" on its empty swatch. Falling through to the
  // repository names said "No color" beside a crew member whose stored name
  // this console does not know. A repository has no empty swatch, so an
  // unknown value there still says "No color".
  const named = chosen?.name ?? swatches.find((swatch) => swatch.value === null)?.name ?? repoColorName(value);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-0.5">
        {swatches.map((swatch) => {
          const checked = swatch.value === value;
          return (
            <button
              key={swatch.value ?? 'none'}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={swatch.name}
              title={swatch.name}
              onClick={() => onChoose(swatch.value)}
              className={cn(
                'inline-flex size-11 items-center justify-center rounded-full border-2 transition-colors focus-visible:outline-2 focus-visible:outline-link md:size-7',
                checked ? 'border-body' : 'border-transparent hover:border-edge-strong',
              )}
            >
              <span aria-hidden className={cn('size-5 rounded-full md:size-4', swatch.fill)} />
            </button>
          );
        })}
      </div>
      <span className="min-w-12 text-[12.5px] text-soft">{named}</span>
    </div>
  );
}

/** A repository's palette: the six colors the board tells repositories apart by. */
export const REPO_SWATCHES: readonly Swatch[] = REPO_COLORS.map((color) => ({ value: color, name: repoColorName(color), fill: repoFill(color) }));

/**
 * A crew member's palette: its role's tint first, which is what it has until a
 * person chooses, then the eight tints by name. The tints sit close to the
 * panel on purpose, so each swatch has an outline in `dim`, which keeps well
 * over the 3:1 a control's boundary needs against the panel in both modes
 * (`contrast.test.ts` measures `dim` on the panel at 4.5:1); the role's is
 * dashed, as the choice that is not a color of its own.
 */
export function crewSwatches(role: string | null | undefined): Swatch[] {
  return [
    { value: null, name: crewColorName(null), fill: cn(roleTint(role), 'border border-dashed border-dim') },
    ...CREW_COLORS.map((color) => ({ value: color, name: crewColorName(color), fill: cn(crewFill(color), 'border border-dim') })),
  ];
}

type Saving = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'failed'; reason: string };

/**
 * Each row's color, saved as it is chosen. A generation per row: one counter
 * for the list let a slow success on Teal be thrown away, so a later refusal
 * of Pink painted the color from before either click. A success is remembered
 * when it is the newest success for that row, and a refusal of the latest
 * choice paints that color, including when the success arrives afterwards. An
 * older success does not replace a newer one. The line follows the newest
 * choice still waiting, so one row's refusal does not cover another's save.
 */
export function useColors(initial: Record<string, string | null>, save: (key: string, value: string | null) => Promise<{ ok: boolean; error?: string }>) {
  const [colors, setColors] = useState(initial);
  const [saving, setSaving] = useState<Saving>({ state: 'idle' });
  const stored = useRef(initial);
  /** Saves not yet answered, per row: the page's own reads wait for them. */
  const pending = useRef<Record<string, number>>({});
  /** What the page last said each row is. */
  const read = useRef(initial);
  const generation = useRef<Record<string, number>>({});
  const confirmedAt = useRef<Record<string, number>>({});
  const refusedAt = useRef<Record<string, number>>({});
  const latest = useRef(0);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (fade.current && clearTimeout(fade.current)), []);

  // The page is read again every fifteen seconds, and what it read is taken
  // for each row with no save waiting. Copied once, a seat's tasks at once
  // stayed at what it was first drawn with after the panel or another admin
  // changed it, and the card and the panel each said their own.
  const signature = JSON.stringify(initial);
  useEffect(() => {
    const was = read.current;
    read.current = initial;
    const moved = Object.keys(initial).filter((key) => (initial[key] ?? null) !== (was[key] ?? null) && !pending.current[key]);
    if (moved.length === 0) return;
    stored.current = { ...stored.current, ...Object.fromEntries(moved.map((key) => [key, initial[key] ?? null])) };
    setColors((now) => ({ ...now, ...Object.fromEntries(moved.map((key) => [key, initial[key] ?? null])) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const choose = async (key: string, value: string | null): Promise<void> => {
    if ((colors[key] ?? null) === value) return;
    const mine = (generation.current[key] ?? 0) + 1;
    generation.current[key] = mine;
    const wave = ++latest.current;
    if (fade.current) clearTimeout(fade.current);
    setColors((now) => ({ ...now, [key]: value }));
    setSaving({ state: 'saving' });
    pending.current[key] = (pending.current[key] ?? 0) + 1;
    // A call that fails outright is a refusal: the stored colour is painted
    // back. It was left on "Saving…" for good.
    const result = await safeAction(() => save(key, value));
    pending.current[key] = (pending.current[key] ?? 1) - 1;
    if (result.ok && (confirmedAt.current[key] ?? 0) < mine) {
      confirmedAt.current[key] = mine;
      stored.current = { ...stored.current, [key]: value };
    }
    const latestForRow = generation.current[key] ?? mine;
    if (mine === latestForRow && !result.ok) {
      refusedAt.current[key] = mine;
      setColors((now) => ({ ...now, [key]: stored.current[key] ?? null }));
    } else if (result.ok && refusedAt.current[key] === latestForRow && confirmedAt.current[key] === mine) {
      setColors((now) => ({ ...now, [key]: stored.current[key] ?? null }));
    }
    if (wave !== latest.current) return;
    if (result.ok) {
      setSaving({ state: 'saved' });
      fade.current = setTimeout(() => setSaving({ state: 'idle' }), 2500);
    } else {
      setSaving({ state: 'failed', reason: result.error ?? 'the bridge refused it' });
    }
  };

  return { colors, saving, choose };
}

export function SaveLine({ saving }: { saving: Saving }) {
  return (
    <p aria-live="polite" className={cn('min-h-[18px] text-[12px]', saving.state === 'failed' ? 'text-alarm' : 'text-muted')}>
      {saving.state === 'saving' && 'Saving…'}
      {saving.state === 'saved' && 'Saved'}
      {saving.state === 'failed' && `Not saved: ${saving.reason}`}
    </p>
  );
}

/**
 * Settings → Appearance's repository colors: each repository, with its dot and
 * its name, and the palette its own page offers. A choice goes through the same
 * audited `PATCH` as that page's.
 */
export function RepositoryColors({ repositories }: { repositories: readonly { name: string; color?: string | null }[] }) {
  const { colors, saving, choose } = useColors(
    Object.fromEntries(repositories.map((repo) => [repo.name, repo.color ?? null])),
    async (name, color) => (color ? updateRepoSettings(name, { color }) : { ok: false, error: 'a repository always has a color' }),
  );

  if (repositories.length === 0) return <p className="text-[12.5px] text-muted">No repository yet.</p>;
  return (
    <div className="flex flex-col">
      <SaveLine saving={saving} />
      {repositories.map((repo) => (
        <div key={repo.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-well py-2.5 first-of-type:border-t-0">
          <span className="flex min-w-[10rem] flex-1 items-center gap-2 text-[13px] font-medium text-body">
            <RepoDot color={colors[repo.name] ?? null} className="size-2.5" />
            {repo.name}
          </span>
          <ColorChoice
            label={`${repo.name} color`}
            swatches={REPO_SWATCHES}
            value={colors[repo.name] ?? null}
            onChoose={(color) => void choose(repo.name, color)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Settings → Appearance's crew: each crew member, with its avatar, its name
 * and its role, the eight tints or its role's, and which avatar it shows. Two
 * seats of one role look alike until one of them is given a color of its own;
 * the avatar here changes as a choice is made, and every other avatar of the
 * bot once it is saved. Both choices save through one audited route, and are
 * kept apart here by the field each key names.
 */
export function CrewColors({ crew }: { crew: readonly CrewMember[] }) {
  const ordered = inPipelineOrder(crew);
  const { colors: chosen, saving, choose } = useColors(
    Object.fromEntries(ordered.flatMap((bot) => [[`color:${bot.name}`, bot.color ?? null], [`avatar:${bot.name}`, bot.avatar ?? null]])),
    (key, value) => {
      const [field, ...rest] = key.split(':');
      const name = rest.join(':');
      return field === 'avatar' ? setCrewAvatar(name, value) : setCrewColor(name, value);
    },
  );

  if (ordered.length === 0) return <p className="text-[12.5px] text-muted">No crew yet.</p>;
  return (
    <div className="flex flex-col">
      <SaveLine saving={saving} />
      {ordered.map((bot) => {
        const label = botLabel(bot);
        const name = label.handle ?? roleTitle(bot);
        const color = chosen[`color:${bot.name}`] ?? null;
        const avatar = chosen[`avatar:${bot.name}`] ?? null;
        return (
          <div key={bot.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-well py-2.5 first-of-type:border-t-0">
            <span className="flex min-w-[10rem] flex-1 items-center gap-2.5 text-[13px]">
              <BotAvatar bot={{ ...bot, color, avatar }} size="md" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-body">{name}</span>
                <span className="truncate text-[12px] text-muted">{label.handle ? roleTitle(bot) : 'Not connected yet'}</span>
              </span>
            </span>
            <div className="flex flex-col items-start gap-1.5">
              <ColorChoice
                label={`${name} color`}
                swatches={crewSwatches(bot.role)}
                value={color}
                onChoose={(next) => void choose(`color:${bot.name}`, next)}
              />
              <AvatarPicker
                label={`${name} avatar`}
                bot={{ ...bot, color }}
                value={avatar}
                onChoose={(next) => void choose(`avatar:${bot.name}`, next)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
