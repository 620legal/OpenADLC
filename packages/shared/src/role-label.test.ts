import { describe, expect, it } from 'vitest';
import { roleLabel } from './onboarding.js';
import { BOT_ROLES } from './types.js';

describe('what a bot does, in words', () => {
  it('has a label for every role, so none falls back to its key', () => {
    // `review_lead` reaching a screen is the failure this prevents. The switch
    // is exhaustive with no default, so a role added later fails to compile
    // rather than quietly printing its key.
    for (const role of BOT_ROLES) {
      expect(roleLabel(role)).toBeTruthy();
      expect(roleLabel(role)).not.toContain('_');
    }
  });

  it('says the roles the way the crew configuration already does', () => {
    // `config/bots.yaml` calls the lead reviewer's seat "Lead reviewer". Two
    // spellings of one role is how a person ends up wondering whether they are
    // the same bot.
    expect(roleLabel('review_lead')).toBe('lead reviewer');
    expect(roleLabel('implement')).toBe('builder');
    expect(roleLabel('spec')).toBe('system engineer');
  });
});
