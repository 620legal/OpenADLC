import { describe, expect, it } from 'vitest';
import { dialogOpen, isHelpKey, isMac, isPaletteShortcut, isTyping, needsYouKey, type KeyLike } from './keys';

/** An element as the rules read it, without a DOM. */
function el(tagName: string, extra: { type?: string; isContentEditable?: boolean; role?: string } = {}): EventTarget {
  return { tagName: tagName.toUpperCase(), type: extra.type, isContentEditable: extra.isContentEditable ?? false, getAttribute: (name: string) => (name === 'role' ? (extra.role ?? null) : null) } as unknown as EventTarget;
}

function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return { metaKey: false, ctrlKey: false, altKey: false, target: el('body'), ...partial };
}

const NO_DIALOG = { querySelector: () => null };
const A_DIALOG = { querySelector: () => ({}) as Element };

describe('the platform', () => {
  it('reads a Mac from either platform field', () => {
    expect(isMac({ platform: 'MacIntel' })).toBe(true);
    expect(isMac({ userAgentData: { platform: 'macOS' } })).toBe(true);
    expect(isMac({ platform: 'iPad' })).toBe(true);
    expect(isMac({ platform: 'Win32' })).toBe(false);
    expect(isMac({ userAgentData: { platform: 'Linux' }, platform: 'MacIntel' })).toBe(false);
    expect(isMac(undefined)).toBe(false);
  });
});

describe('the palette shortcut', () => {
  it('is ⌘K on a Mac, and Ctrl+K there stays the field’s own', () => {
    expect(isPaletteShortcut(key({ key: 'k', metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ key: 'K', metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true, metaKey: true }), true)).toBe(false);
  });

  it('is Ctrl+K elsewhere', () => {
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key({ key: 'k', metaKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ key: 'j', ctrlKey: true }), false)).toBe(false);
  });
});

describe('typing', () => {
  it('is a text field, a text area, a select or anything editable', () => {
    expect(isTyping(el('input'))).toBe(true);
    expect(isTyping(el('input', { type: 'search' }))).toBe(true);
    expect(isTyping(el('textarea'))).toBe(true);
    expect(isTyping(el('select'))).toBe(true);
    expect(isTyping(el('div', { isContentEditable: true }))).toBe(true);
  });

  it('is not a checkbox, a radio, a button or the page', () => {
    expect(isTyping(el('input', { type: 'checkbox' }))).toBe(false);
    expect(isTyping(el('input', { type: 'radio' }))).toBe(false);
    expect(isTyping(el('input', { type: 'button' }))).toBe(false);
    expect(isTyping(el('button'))).toBe(false);
    expect(isTyping(el('body'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('a dialog', () => {
  it('is any element a dialog role names', () => {
    expect(dialogOpen(A_DIALOG)).toBe(true);
    expect(dialogOpen(NO_DIALOG)).toBe(false);
  });
});

describe('the Needs you keys', () => {
  it('reads j, k, 1–9 and Enter', () => {
    expect(needsYouKey(key({ key: 'j' }), NO_DIALOG)).toEqual({ kind: 'next' });
    expect(needsYouKey(key({ key: 'k' }), NO_DIALOG)).toEqual({ kind: 'prev' });
    expect(needsYouKey(key({ key: '1' }), NO_DIALOG)).toEqual({ kind: 'choose', n: 1 });
    expect(needsYouKey(key({ key: '9' }), NO_DIALOG)).toEqual({ kind: 'choose', n: 9 });
    expect(needsYouKey(key({ key: 'Enter' }), NO_DIALOG)).toEqual({ kind: 'open' });
    expect(needsYouKey(key({ key: '0' }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'x' }), NO_DIALOG)).toBeNull();
  });

  it('yields with Ctrl, ⌘ or Alt held', () => {
    expect(needsYouKey(key({ key: 'j', ctrlKey: true }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: '1', metaKey: true }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'k', altKey: true }), NO_DIALOG)).toBeNull();
  });

  it('yields inside a field and while a dialog is open', () => {
    expect(needsYouKey(key({ key: 'j', target: el('input') }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: '1', target: el('textarea') }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'Enter', target: el('input') }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'j' }), A_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'Enter' }), A_DIALOG)).toBeNull();
  });

  it('leaves Enter to a focused button, link or summary, and keeps j and 1 there', () => {
    expect(needsYouKey(key({ key: 'Enter', target: el('button') }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'Enter', target: el('a') }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'Enter', target: el('summary') }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'Enter', target: el('div', { role: 'button' }) }), NO_DIALOG)).toBeNull();
    expect(needsYouKey(key({ key: 'j', target: el('button') }), NO_DIALOG)).toEqual({ kind: 'next' });
    expect(needsYouKey(key({ key: '1', target: el('button') }), NO_DIALOG)).toEqual({ kind: 'choose', n: 1 });
  });
});

describe('the keys list', () => {
  it('opens on ? anywhere but in a field', () => {
    expect(isHelpKey(key({ key: '?' }))).toBe(true);
    expect(isHelpKey(key({ key: '?', target: el('button') }))).toBe(true);
    expect(isHelpKey(key({ key: '?', target: el('input') }))).toBe(false);
    expect(isHelpKey(key({ key: '?', ctrlKey: true }))).toBe(false);
    expect(isHelpKey(key({ key: '/' }))).toBe(false);
  });
});
