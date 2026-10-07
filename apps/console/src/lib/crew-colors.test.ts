import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREW_COLORS, crewColorName, crewFill, crewTint, isCrewColor, roleTint } from './crew-colors';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the colors a crew member can have', () => {
  it('are the ones the bridge stores, in the same order', () => {
    // Two copies of one list: the console does not depend on @fleetadlc/shared, so
    // this is where the two are held together.
    const shared = /CREW_COLORS = \[([^\]]+)\]/.exec(read('../../../../packages/shared/src/crew-colors.ts'))?.[1];
    expect(shared?.split(',').map((entry) => entry.trim().replace(/'/g, ''))).toEqual([...CREW_COLORS]);
  });

  it('are the eight tints, by name, each written out whole so Tailwind generates it', () => {
    const source = read('./crew-colors.ts');
    const css = read('../app/globals.css');
    expect(CREW_COLORS).toHaveLength(8);
    for (const color of CREW_COLORS) {
      expect(crewFill(color)).toBe(`bg-tint-${color}`);
      expect(source).toContain(`'bg-tint-${color}'`);
      expect(css).toContain(`--color-tint-${color}:`);
      expect(crewColorName(color)).toMatch(/^[A-Z][a-z]+$/);
    }
    // Numbered tints are gone: a stored name is what a person chose.
    expect(css).not.toMatch(/--color-tint-\d/);
  });

  it('are by role when none is chosen, and for a name this console does not know', () => {
    expect(crewColorName(null)).toBe('By role');
    expect(isCrewColor('chartreuse')).toBe(false);
    expect(crewTint({ role: 'implement', color: null })).toBe(roleTint('implement'));
    expect(crewTint({ role: 'implement', color: 'chartreuse' })).toBe(roleTint('implement'));
    expect(crewTint({ role: 'implement' })).toBe('bg-tint-mint');
  });

  it('put a chosen color over the role’s tint', () => {
    expect(crewTint({ role: 'implement', color: 'rose' })).toBe('bg-tint-rose');
    // Automation has no tint of its own, and can still be given one.
    expect(crewTint({ role: 'automation', color: null })).toBe('bg-well');
    expect(crewTint({ role: 'automation', color: 'sky' })).toBe('bg-tint-sky');
  });

  it('give every role in the pipeline a tint of its own', () => {
    const roles = ['intake', 'spec', 'implement', 'review_lead', 'review_second', 'review_security', 'deploy', 'qa'];
    expect(new Set(roles.map(roleTint)).size).toBe(roles.length);
  });
});
