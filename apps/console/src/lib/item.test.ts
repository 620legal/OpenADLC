import { describe, expect, it } from 'vitest';
import type { ItemMessage, ItemView } from './api';
import { cardMatches, exactKey, itemAddress, itemEntries, itemNumberOf } from './item';

describe('finding a card by its work item key', () => {
  const card = { title: 'Record which model reviewed', ref: 'api#12', item: { number: 128, key: '620legal-128' } };
  const plain = { title: 'Something else', ref: 'api#15', item: null };

  it('reads a key in any case and with any prefix, or its number alone', () => {
    for (const key of ['620legal-128', '620LEGAL-128', 'W-128', 'w-128', '128', 'old-name-128']) expect(itemNumberOf(key), key).toBe(128);
    for (const other of ['api#12', 'request:a4b0', 'W-', '', 'dark mode']) expect(itemNumberOf(other), other).toBeNull();
  });

  it('keeps a card by its key in any case and with any prefix, or by words of its title', () => {
    for (const query of ['W-128', 'w-128', '620legal-128', '128', 'model', '620LEGAL', '']) expect(cardMatches(card, query), query).toBe(true);
    for (const query of ['W-129', 'dark mode']) expect(cardMatches(card, query), query).toBe(false);
    expect(cardMatches(plain, '128')).toBe(false);
  });

  it('sends an old address, a member’s subject or another prefix to the item’s key, and stays on the key', () => {
    const view = { workItem: { number: 128, key: '620legal-128', mergedFrom: null } };
    expect(itemAddress('api#12', view, null)).toBe('/items/620legal-128');
    expect(itemAddress('request:a4b02784', view, 'review_lead')).toBe('/items/620legal-128?role=review_lead');
    expect(itemAddress('W-128', view, null)).toBe('/items/620legal-128');
    expect(itemAddress('620legal-128', view, null)).toBeNull();
    // Not numbered yet, or not found: the page shows what it was given.
    expect(itemAddress('api#12', { workItem: null }, null)).toBeNull();
    expect(itemAddress('api#12', null, null)).toBeNull();
  });

  it('names the key Enter opens only when the box holds one a card has', () => {
    expect(exactKey([plain, card], 'w-128')).toBe('620legal-128');
    expect(exactKey([plain, card], 'W-7')).toBeNull();
    expect(exactKey([plain, card], 'model')).toBeNull();
  });
});

const NOW = '2026-09-30T12:00:00.000Z';

function view(text: string): Pick<ItemView, 'roles' | 'timeline' | 'openGates'> {
  const message: ItemMessage = {
    id: 'm-1',
    kind: 'bot',
    author: 'builder',
    text,
    note: null,
    payload: null,
    githubUrl: null,
    at: '2026-09-30T10:00:00.000Z',
    subjectRef: 'api#12',
    role: 'build',
    seat: 'builder',
    bot: 'builder',
  };
  return { roles: [], timeline: [message], openGates: [] };
}

function bubbleText(text: string): string | undefined {
  const entry = itemEntries(view(text), { now: NOW, timeZone: 'UTC' }).find((one) => one.kind === 'bubble');
  return entry?.kind === 'bubble' ? entry.text : undefined;
}

describe('what a seat said on an item, as a person reads it', () => {
  it('leaves out the marker the bridge reads', () => {
    expect(bubbleText('The change is ready.\n<!-- openadlc:{"event":"done"} -->')).toBe('The change is ready.');
  });

  it('reads a message of forty thousand unclosed comments at once, and keeps it', () => {
    const text = '<!--'.repeat(40_000);
    const started = performance.now();
    expect(bubbleText(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
