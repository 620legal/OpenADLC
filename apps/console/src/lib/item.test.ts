import { describe, expect, it } from 'vitest';
import type { ItemMessage, ItemView } from './api';
import { itemEntries } from './item';

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
    expect(bubbleText('The change is ready.\n<!-- fleetadlc:{"event":"done"} -->')).toBe('The change is ready.');
  });

  it('reads a message of forty thousand unclosed comments at once, and keeps it', () => {
    const text = '<!--'.repeat(40_000);
    const started = performance.now();
    expect(bubbleText(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
