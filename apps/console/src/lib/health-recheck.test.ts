import { describe, expect, it } from 'vitest';
import { stillFailing } from './health-recheck';

describe('what "Check again" says afterwards', () => {
  it('says the check still fails, so the unchanged card is not read as a press that did nothing', () => {
    expect(
      stillFailing(
        [
          { check: 'app-permissions', state: 'failing' },
          { check: 'webhook', state: 'ok' },
        ],
        'app-permissions',
      ),
    ).toBe('Still failing: checked just now.');
  });

  it('says nothing when the check passed, since its card is gone', () => {
    expect(stillFailing([{ check: 'app-permissions', state: 'ok' }], 'app-permissions')).toBeNull();
  });
});
