import type { JumpItem, Role } from '@/lib/api';
import { NAV } from '@/lib/header';

/** How many items the palette lists for a query; past that, typing more is quicker than scrolling. */
export const JUMP_ROWS = 50;
/** How many items an empty query lists: the newest open ones. */
export const EMPTY_ROWS = 8;

/** Open before closed, then the newest first. */
function byOpenThenNewest(a: JumpItem, b: JumpItem): number {
  if (a.open !== b.open) return a.open ? -1 : 1;
  return b.number - a.number;
}

/**
 * The items a query finds, best first. A number (`213`, `#213`) is that item,
 * then an item with an issue or pull request of that number, then items whose
 * number starts with it. A key (`acme-213`, any case) is that item, and
 * `repo#12` the item that holds it. Anything else is words, each of which must
 * be in the title or the key. Within each, open before closed and the newest
 * first. An empty query is the newest open items.
 */
export function rankJump(items: readonly JumpItem[], query: string): JumpItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.filter((item) => item.open).sort(byOpenThenNewest).slice(0, EMPTY_ROWS);

  const tiers: ((item: JumpItem) => boolean)[] = [];
  const digits = /^#?(\d+)$/.exec(q)?.[1];
  const key = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-(\d+)$/.exec(q);
  const ref = /^(\S+)#(\d+)$/.exec(q);
  if (digits) {
    const n = Number(digits);
    tiers.push(
      (item) => item.number === n,
      (item) => item.refs.some((one) => one.endsWith(`#${digits}`)),
      (item) => String(item.number).startsWith(digits),
    );
  } else if (ref) {
    // `owner/repo#12` names the same thing as `repo#12`, which is how refs are listed.
    tiers.push((item) => item.refs.some((one) => one.toLowerCase() === q || q.endsWith(`/${one.toLowerCase()}`)));
  } else if (key) {
    const n = Number(key[1]);
    tiers.push((item) => item.number === n);
  }
  const words = q.split(/\s+/);
  tiers.push((item) => {
    const text = `${item.title} ${item.key}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });

  const seen = new Set<number>();
  const found: JumpItem[] = [];
  for (const matches of tiers) {
    const tier = items.filter((item) => !seen.has(item.number) && matches(item)).sort(byOpenThenNewest);
    for (const item of tier) seen.add(item.number);
    found.push(...tier);
    if (found.length >= JUMP_ROWS) break;
  }
  return found.slice(0, JUMP_ROWS);
}

/** Something the palette does that is not opening an item. */
export type PaletteCommand =
  | { id: string; group: 'go'; label: string; href: string }
  | { id: 'new-request' | 'pause' | 'resume'; group: 'act'; label: string };

/**
 * Where the palette can go and what it can do, for this person: only what the
 * bridge lets their role do. Settings, Pause work and Resume are an admin's,
 * as their routes are; Resume shows only while something is paused, and goes
 * to Settings' Pause work card rather than resuming anything itself.
 */
export function paletteCommands({ role, paused, repo = 'all' }: { role: Role; paused: boolean | null; repo?: string }): PaletteCommand[] {
  const admin = role === 'admin';
  const nav = NAV.filter((item) => admin || item.page !== 'settings').map(
    (item): PaletteCommand => ({ id: `go:${item.page}`, group: 'go', label: item.label, href: item.href(repo) }),
  );
  // Needs you is reached from the header's badge, not the navigation, and is a place to go all the same.
  const go: PaletteCommand[] = [nav[0]!, { id: 'go:needs-you', group: 'go', label: 'Needs you', href: '/needs-you' }, ...nav.slice(1)];
  const act: PaletteCommand[] = [{ id: 'new-request', group: 'act', label: 'New request' }];
  if (admin) act.push({ id: 'pause', group: 'act', label: 'Pause work' });
  if (admin && paused === true) act.push({ id: 'resume', group: 'act', label: 'Resume' });
  return [...go, ...act];
}

/** The commands whose label holds the query; every one for an empty query. */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  return q ? commands.filter((command) => command.label.toLowerCase().includes(q)) : [...commands];
}
