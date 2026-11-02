import { describe, expect, it } from 'vitest';
import type { JumpItem } from './api';
import { EMPTY_ROWS, JUMP_ROWS, filterCommands, paletteCommands, rankJump } from './command-palette';

function item(number: number, partial: Partial<JumpItem> = {}): JumpItem {
  return { key: `acme-${number}`, number, title: `Item ${number}`, refs: [], open: true, closedAt: null, ...partial };
}

const numbers = (list: readonly JumpItem[]) => list.map((one) => one.number);

describe('finding an item by number', () => {
  const items = [item(2130), item(17, { refs: ['api#213'] }), item(213, { open: false, closedAt: '2026-10-20T00:00:00.000Z' }), item(21)];

  it('puts the item of that number first, then one holding an issue of it, then numbers that start with it', () => {
    expect(numbers(rankJump(items, '213'))).toEqual([213, 17, 2130]);
  });

  it('reads a number after #', () => {
    expect(numbers(rankJump(items, '#213'))).toEqual([213, 17, 2130]);
  });

  it('lists open before closed, then the newest first, within a tier', () => {
    expect(numbers(rankJump([item(21, { open: false }), item(210), item(2100, { open: false }), item(211)], '21'))).toEqual([21, 211, 210, 2100]);
  });
});

describe('finding an item by key or by a ref', () => {
  const items = [item(12, { refs: ['api#40', 'api#41'] }), item(213, { refs: ['web#5'] })];

  it('reads a key in any case', () => {
    expect(numbers(rankJump(items, 'ACME-213'))).toEqual([213]);
    expect(numbers(rankJump(items, 'acme-12'))).toEqual([12]);
  });

  it('reads repo#n, and owner/repo#n, ignoring case', () => {
    expect(numbers(rankJump(items, 'api#41'))).toEqual([12]);
    expect(numbers(rankJump(items, 'Acme/WEB#5'))).toEqual([213]);
    expect(numbers(rankJump(items, 'api#5'))).toEqual([]);
  });
});

describe('finding an item by words', () => {
  const items = [
    item(1, { title: 'Add a command palette' }),
    item(2, { title: 'Palette colours for the board', open: false }),
    item(3, { title: 'Record the model per review' }),
  ];

  it('needs every word in the title or the key, in any case', () => {
    expect(numbers(rankJump(items, 'palette'))).toEqual([1, 2]);
    expect(numbers(rankJump(items, 'COMMAND palette'))).toEqual([1]);
    expect(numbers(rankJump(items, 'acme-3 model'))).toEqual([3]);
    expect(numbers(rankJump(items, 'palette review'))).toEqual([]);
  });
});

describe('an empty query', () => {
  it('lists the newest open items', () => {
    const many = Array.from({ length: 12 }, (_, index) => item(index + 1, { open: index !== 11 }));
    expect(numbers(rankJump(many, '  '))).toEqual([11, 10, 9, 8, 7, 6, 5, 4]);
    expect(rankJump(many, '')).toHaveLength(EMPTY_ROWS);
  });
});

it('lists at most fifty rows', () => {
  const many = Array.from({ length: 80 }, (_, index) => item(index + 1, { title: 'Same words' }));
  expect(rankJump(many, 'same')).toHaveLength(JUMP_ROWS);
});

describe('the commands', () => {
  const ids = (role: 'admin' | 'user', paused: boolean | null) => paletteCommands({ role, paused }).map((command) => command.id);

  it('go to every page an admin has, Needs you among them', () => {
    expect(ids('admin', false)).toEqual(['go:board', 'go:needs-you', 'go:crew', 'go:costs', 'go:insights', 'go:settings', 'new-request', 'pause']);
  });

  it('leave Settings, Pause work and Resume out for a user', () => {
    expect(ids('user', true)).toEqual(['go:board', 'go:needs-you', 'go:crew', 'go:costs', 'go:insights', 'new-request']);
  });

  it('offer Resume only while something is paused', () => {
    expect(ids('admin', true)).toContain('resume');
    expect(ids('admin', false)).not.toContain('resume');
    expect(ids('admin', null)).not.toContain('resume');
  });

  it('go to the board of the repository on screen', () => {
    const board = paletteCommands({ role: 'user', paused: false, repo: 'api' }).find((command) => command.id === 'go:board');
    expect(board).toMatchObject({ href: expect.stringContaining('api') });
  });

  it('are filtered by their label', () => {
    const all = paletteCommands({ role: 'admin', paused: true });
    expect(filterCommands(all, 'pa').map((command) => command.id)).toEqual(['pause']);
    expect(filterCommands(all, 'RES').map((command) => command.id)).toEqual(['resume']);
    expect(filterCommands(all, '')).toHaveLength(all.length);
  });
});
