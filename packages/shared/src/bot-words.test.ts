import { describe, expect, it } from 'vitest';
import { botAtStart, botInWords, botLogin, botRoleWords } from './bot-words.js';

describe('a bot, in words a person reads', () => {
  it('is its role and the account it acts as', () => {
    expect(botInWords({ role: 'review_second', name: 'janedoe-reviews', slot: 'second-reviewer', githubLogin: 'janedoe-reviews' })).toBe(
      'the second reviewer (janedoe-reviews)',
    );
  });

  it('is its role alone before it has an account, never its seat', () => {
    const said = botInWords({ role: 'review_second', name: 'second-reviewer', slot: 'second-reviewer', githubLogin: null });
    expect(said).toBe('the second reviewer');
    expect(botInWords({ role: 'qa', name: 'qa', slot: 'qa' })).toBe('the QA bot');
    expect(botInWords({ role: 'intake', name: 'intake', slot: 'intake' })).toBe('the intake bot');
    expect(botInWords({ role: 'deploy', name: 'sre', slot: 'sre' })).toBe('the SRE');
  });

  it('knows the account by a name that has left its seat, before the login is recorded', () => {
    expect(botLogin({ role: 'implement', name: 'janedoe-builds', slot: 'builder' })).toBe('janedoe-builds');
    expect(botLogin({ role: 'implement', name: 'builder', slot: 'builder' })).toBeNull();
  });

  it('numbers the second of a kind, which reads as a name', () => {
    expect(botRoleWords({ role: 'implement', slot: 'builder-2' })).toBe('builder 2');
    expect(botInWords({ role: 'implement', name: 'builder-2', slot: 'builder-2' })).toBe('builder 2');
    expect(botInWords({ role: 'implement', name: 'exampleco-b2', slot: 'builder-2', githubLogin: 'exampleco-b2' })).toBe(
      'builder 2 (exampleco-b2)',
    );
  });

  it('starts a sentence', () => {
    expect(botAtStart({ role: 'review_lead', name: 'lead-reviewer', slot: 'lead-reviewer' })).toBe('The lead reviewer');
    expect(botAtStart(null)).toBe('A bot');
  });
});
