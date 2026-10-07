import { describe, expect, it } from 'vitest';
import { headerData, spendLevel } from './header';

const header = (budget: { spentUsd: number; capUsd: number; state: string }) =>
  headerData({ repos: [], crew: [], budget, needsYou: 0 });

describe('the header’s spend colour', () => {
  it('follows the bridge’s state, whatever warningAt is set to', () => {
    // warningAt 0.75: the bridge already warns at 80 percent.
    expect(spendLevel(header({ spentUsd: 800, capUsd: 1000, state: 'warning' }).spend!).tone).toBe('attention');
    // warningAt 0.95: at 92 percent the bridge still says ok.
    expect(spendLevel(header({ spentUsd: 920, capUsd: 1000, state: 'ok' }).spend!).tone).toBe('signal');
    expect(spendLevel(header({ spentUsd: 1000, capUsd: 1000, state: 'stopped' }).spend!).tone).toBe('alarm');
  });

  it('says an overrun as it is, and holds only the bar to the cap', () => {
    expect(spendLevel({ spentUsd: 2000, capUsd: 1500, state: 'stopped' })).toMatchObject({ width: 100 });
    expect(spendLevel({ spentUsd: 2000, capUsd: 1500, state: 'stopped' }).percent.toFixed(1)).toBe('133.3');
  });

  it('goes by the percentage for a figure that came without a state', () => {
    expect(spendLevel({ spentUsd: 950, capUsd: 1000 }).tone).toBe('attention');
    expect(spendLevel({ spentUsd: 100, capUsd: 1000 }).tone).toBe('signal');
  });
});
