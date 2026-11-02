/**
 * The console's keyboard rules, in one place so every shortcut yields the
 * same way: a single key does nothing while a person types in a field, while
 * any dialog is open, or with Ctrl, ⌘ or Alt held. Only the palette's ⌘K
 * (Ctrl+K off a Mac) passes while typing, which is what it is for.
 */

/** A keyboard event as these rules read it; a DOM `KeyboardEvent` is one. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** Whether this browser is on a Mac, where the palette is ⌘K. */
export function isMac(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

/**
 * ⌘K on a Mac, Ctrl+K elsewhere, and only that: Ctrl+K in a Mac's text field
 * deletes to the end of the line, and stays so.
 */
export function isPaletteShortcut(event: Pick<KeyLike, 'key' | 'metaKey' | 'ctrlKey'>, mac: boolean): boolean {
  if (event.key.toLowerCase() !== 'k') return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color']);

/** Whether a key pressed here is a person typing: a text field, a list to pick from, or anything editable. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { type?: string }) | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input') return !NOT_TYPED.has((element.type ?? 'text').toLowerCase());
  if (tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
}

/** Whether any dialog is open: the palette, the keys list, New request, an item's sheet, a card's Show more. */
export function dialogOpen(doc: Pick<Document, 'querySelector'> | undefined): boolean {
  return Boolean(doc?.querySelector('[role="dialog"], [role="alertdialog"]'));
}

/** Enter on one of these presses it, not the selected card. */
function isPressable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'button' || tag === 'a' || tag === 'summary' || element.getAttribute?.('role') === 'button';
}

export type NeedsYouKey = { kind: 'next' } | { kind: 'prev' } | { kind: 'choose'; n: number } | { kind: 'open' };

/** What a key does on Needs you: j and k move, 1–9 answer, Enter opens. Null for anything else, or when it should yield. */
export function needsYouKey(event: KeyLike, doc: Pick<Document, 'querySelector'> | undefined = globalThis.document): NeedsYouKey | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTyping(event.target) || dialogOpen(doc)) return null;
  // Caps Lock sends J and K; they move all the same.
  const key = event.key.toLowerCase();
  if (key === 'j') return { kind: 'next' };
  if (key === 'k') return { kind: 'prev' };
  if (/^[1-9]$/.test(event.key)) return { kind: 'choose', n: Number(event.key) };
  if (event.key === 'Enter') return isPressable(event.target) ? null : { kind: 'open' };
  return null;
}

/** `?`, which lists the keys, anywhere but in a field. */
export function isHelpKey(event: KeyLike): boolean {
  return event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target);
}
