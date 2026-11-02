import { describe, expect, it } from 'vitest';
import { REQUEST_STARTERS, showsStarters } from './request-starters';

const byLabel = (label: string) => REQUEST_STARTERS.find((one) => one.label === label)!;

describe('REQUEST_STARTERS', () => {
  it('offers a bug, a feature, a docs fix and tests, with their kinds', () => {
    expect(REQUEST_STARTERS.map((one) => [one.label, one.kind])).toEqual([
      ['A bug, with steps', 'defect'],
      ['A small feature', 'feature'],
      ['A docs fix', 'chore'],
      ['Tests for a module', 'chore'],
    ]);
  });

  it('leaves a bracketed blank in each request and its details', () => {
    for (const starter of REQUEST_STARTERS) {
      expect(starter.text, starter.label).toMatch(/\[[^\]]+\]/);
      expect(starter.details, starter.label).toMatch(/\[[^\]]+\]/);
    }
  });

  it('has the parts intake drafts an issue from', () => {
    const parts: Record<string, string[]> = {
      'A bug, with steps': ['Steps:', 'What happened:', 'What should have happened:'],
      'A small feature': ['For:', 'Done when:'],
      'A docs fix': ['Page:', 'Wrong text:'],
      'Tests for a module': ['Module:', 'Behaviours to cover:'],
    };
    for (const [label, wanted] of Object.entries(parts)) {
      for (const part of wanted) expect(byLabel(label).details, label).toContain(part);
    }
  });

  it('names no path or file in anyone’s repository', () => {
    for (const starter of REQUEST_STARTERS) {
      for (const field of [starter.text, starter.details]) {
        expect(field, starter.label).not.toMatch(/[\w.-]+\/[\w.-]+/);
        expect(field, starter.label).not.toMatch(/\.(tsx?|jsx?|mjs|md|json|ya?ml|sql|py|go|rs)\b/);
      }
    }
  });

  it('keeps each request to one line the title takes whole', () => {
    for (const starter of REQUEST_STARTERS) {
      expect(starter.text, starter.label).not.toContain('\n');
      expect(starter.text.length, starter.label).toBeLessThanOrEqual(80);
    }
  });
});

describe('showsStarters', () => {
  it('is true while both boxes are blank, whitespace included', () => {
    expect(showsStarters('', '')).toBe(true);
    expect(showsStarters('  ', '\n')).toBe(true);
  });

  it('is false once either box has text', () => {
    expect(showsStarters('a', '')).toBe(false);
    expect(showsStarters('', 'a')).toBe(false);
    expect(showsStarters(' x ', '\n')).toBe(false);
  });
});
