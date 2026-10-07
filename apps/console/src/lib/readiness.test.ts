import { describe, expect, it } from 'vitest';
import { crewCheck, reviewGateCheck, webhookCheck } from './readiness';

const PLAN = (rules: { name: string; state: string }[], canApply = true) => [
  { repository: 'janedoe/fleetadlc-testbed', rules, canApply },
];

describe('what the first run can say is ready', () => {
  it('says the repository merges only what passed review when OpenADLC’s ruleset is there as declared', () => {
    expect(reviewGateCheck(PLAN([{ name: 'fleetadlc: main', state: 'present' }]), 'janedoe/fleetadlc-testbed')).toEqual({
      ok: true,
      text: 'fleetadlc-testbed merges only what passed review',
    });
  });

  it('says it does not yet, with where to fix it, when the ruleset is missing or has drifted', () => {
    for (const state of ['missing', 'drifted']) {
      expect(reviewGateCheck(PLAN([{ name: 'fleetadlc: main', state }]), 'janedoe/fleetadlc-testbed')).toMatchObject({
        ok: false,
        fix: { href: '/onboarding?step=protect' },
      });
    }
  });

  it('says it does not yet when the checks cannot be published, though the ruleset is there', () => {
    // As the bridge reports it: missing, so the ruleset alone does not hold the gate.
    expect(
      reviewGateCheck(
        PLAN([
          { name: 'required status checks', state: 'missing' },
          { name: 'fleetadlc: main', state: 'present' },
        ]),
        'janedoe/fleetadlc-testbed',
      ),
    ).toMatchObject({ ok: false, fix: { href: '/onboarding?step=protect' } });
  });

  it('says nothing it could not check, rather than a tick', () => {
    // No app key: OpenADLC can only report, and reported nothing.
    expect(reviewGateCheck(PLAN([], false), 'janedoe/fleetadlc-testbed')).toBeNull();
    expect(reviewGateCheck(PLAN([{ name: 'fleetadlc: main', state: 'present' }]), 'janedoe/other')).toBeNull();
    expect(reviewGateCheck(null, 'janedoe/fleetadlc-testbed')).toBeNull();
    expect(webhookCheck(null)).toBeNull();
    expect(webhookCheck({})).toBeNull();
  });

  it('says whether GitHub reaches OpenADLC as the webhook step found it', () => {
    expect(webhookCheck({ ready: true })).toEqual({ ok: true, text: 'GitHub reaches OpenADLC' });
    expect(webhookCheck({ ready: false })).toMatchObject({ ok: false, fix: { href: '/onboarding?step=webhook' } });
  });

  it('counts the bots that can act as their own account', () => {
    expect(crewCheck({ total: 9, connected: 9 })?.text).toBe('9 bots connected to GitHub');
    expect(crewCheck({ total: 9, connected: 7 })).toMatchObject({
      ok: false,
      text: '7 of 9 bots connected',
      fix: { href: '/onboarding?step=github-accounts' },
    });
    expect(crewCheck({ total: 0, connected: 0 })).toBeNull();
  });

  it('does not count a bot whose sign-in was revoked or expired as ready', () => {
    expect(crewCheck({ total: 2, connected: 2, needsReconnecting: 2 })).toEqual({
      ok: false,
      text: '2 bots need reconnecting',
      fix: { href: '/onboarding?step=github-accounts', label: 'Reconnect' },
    });
  });
});
