import { describe, expect, it } from 'vitest';
import { mapLimited } from './limited.js';

describe('calls a few at a time', () => {
  it('never has more than the limit in flight, and answers in the order asked', async () => {
    let running = 0;
    let most = 0;
    const answers = await mapLimited([30, 5, 20, 1, 10, 2, 15], 3, async (ms, index) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return index;
    });
    expect(answers).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(most).toBe(3);
  });

  it('answers nothing for nothing', async () => {
    expect(await mapLimited([], 6, async () => 1)).toEqual([]);
  });
});
