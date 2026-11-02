import type { AttentionItem, Brand } from './api';

/**
 * What tells a person with the console in a background tab that something
 * waits on them: the count in the tab's title, a dot for its icon, a short
 * sound and a desktop notification. All of it is raised by the open page from
 * what its live refresh already reads; nothing here touches the DOM, so each
 * part is checked on its own (`components/needs-you-alerts.tsx` applies them).
 */

/** The console's name wherever it is said: the header, the tab's title. */
export function consoleName(brand: Pick<Brand, 'name'>): string {
  return brand.name ?? 'OpenADLC';
}

/** "(2) OpenADLC" while anything waits and the switch is on; the plain name otherwise, and for a count that could not be read. */
export function titleFor(count: number | null, name: string, on: boolean): string {
  return on && count !== null && count > 0 ? `(${count}) ${name}` : name;
}

/**
 * What a notification about one item says: who wants what, and about which
 * piece of work — "The builder has a question about #42". A headline that
 * already names its number ("Pull request #12 waits for you to merge it") is
 * said as it is. The repository is named only when the install has more than
 * one, since "#42" alone is ambiguous then.
 */
export function notificationText(item: Pick<AttentionItem, 'headline' | 'subject'>, repos: readonly string[]): string {
  const { headline, subject } = item;
  if (/#\d+/.test(headline)) return headline;
  if (subject.number !== null) {
    const ref = repos.length > 1 ? (subject.ref ?? (subject.repo ? `${subject.repo}#${subject.number}` : `#${subject.number}`)) : `#${subject.number}`;
    return `${headline} about ${ref}`;
  }
  if (subject.title) return `${headline} about “${subject.title}”`;
  return headline;
}

/** One notification for several that arrived at once. */
export function batchText(n: number): string {
  return `${n} new items need you`;
}

/**
 * Which of the items the page just read are new to this document.
 *
 * The first read sets the baseline and is new about nothing: a reload of a
 * page with five things waiting would otherwise chime and notify five times
 * for what the person had already seen. `seen` only grows, so an item that
 * leaves the list and comes back (a question answered, then asked again with
 * the same gate) is not new a second time. A read with no items (`null`, the
 * bridge did not answer) changes nothing, the baseline included.
 */
export function newItems<T extends { id: string }>(
  seen: ReadonlySet<string> | null,
  items: readonly T[] | null,
): { fresh: T[]; seen: ReadonlySet<string> | null } {
  if (items === null) return { fresh: [], seen };
  const next = new Set(seen ?? []);
  for (const item of items) next.add(item.id);
  if (seen === null) return { fresh: [], seen: next };
  return { fresh: items.filter((item) => !seen.has(item.id)), seen: next };
}

export const CLAIMED_KEY = 'openadlc.alerts.claimed';
/** How long a tab's claim on an item holds; past it the entry is dropped. */
export const CLAIM_FOR_MS = 10 * 60_000;

/**
 * The ids this tab may alert about: those no other tab of this browser has.
 *
 * Every open console tab reads the same items on its own timer, so two tabs
 * open would each chime and each notify. The first to see an item writes it
 * down in storage that every tab shares; the next finds it there. Storage
 * that throws (site data blocked) claims nothing, and every id is this tab's:
 * two alerts are better than none.
 */
export function claimAcrossTabs(
  ids: readonly string[],
  store: Pick<Storage, 'getItem' | 'setItem'>,
  now: number,
): string[] {
  try {
    let claimed: Record<string, number> = {};
    try {
      const parsed: unknown = JSON.parse(store.getItem(CLAIMED_KEY) ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) claimed = parsed as Record<string, number>;
    } catch {
      // Not ours, or cut short: start again.
    }
    const kept: Record<string, number> = {};
    for (const [id, at] of Object.entries(claimed)) if (typeof at === 'number' && now - at < CLAIM_FOR_MS) kept[id] = at;
    const mine = ids.filter((id) => !(id in kept));
    for (const id of mine) kept[id] = now;
    store.setItem(CLAIMED_KEY, JSON.stringify(kept));
    return mine;
  } catch {
    return [...ids];
  }
}

/**
 * The tab's icon while anything waits: an amber dot in a darker ring.
 *
 * Its colours are written out, because an icon given as a data URL is drawn
 * apart from the page and cannot read its CSS variables. The ring is dark
 * enough to stand out on a light tab strip and light enough on a dark one,
 * which `needs-you-alerts.test.ts` measures.
 */
export const FAVICON_FILL = '#f5a524';
export const FAVICON_RING = '#b8600b';

export function faviconSvg(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="${FAVICON_FILL}" stroke="${FAVICON_RING}" stroke-width="4"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The part of `AudioContext` the chime uses, so a test can hand it a stand-in. */
export type AudioContextLike = new () => {
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { value: number };
    connect(node: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
    onended: (() => void) | null;
  };
  createGain(): {
    gain: { setValueAtTime(value: number, at: number): unknown; exponentialRampToValueAtTime(value: number, at: number): unknown };
    connect(node: unknown): unknown;
  };
};

/**
 * One soft note, about a fifth of a second, fading out. Drawn by WebAudio
 * rather than played from a file, so there is nothing to fetch. A browser
 * that blocks sound until the page is clicked refuses `resume()` or the
 * context itself; either is swallowed, and the tab's title still says it.
 */
export function chime(Context: AudioContextLike | undefined): void {
  if (!Context) return;
  try {
    const context = new Context();
    const start = context.currentTime;
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.type = 'sine';
    tone.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    tone.connect(gain);
    gain.connect(context.destination);
    tone.onended = () => void context.close().catch(() => undefined);
    tone.start(start);
    tone.stop(start + 0.18);
    void context.resume().catch(() => undefined);
  } catch {
    // No sound in this browser, or not yet: the title and the dot still say it.
  }
}
