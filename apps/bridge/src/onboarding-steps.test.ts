import { describe, expect, it, vi } from 'vitest';
import { ONBOARDING_STEP_ALIASES, ONBOARDING_STEPS, STEP_TITLES } from '@fleetadlc/shared';
import { isOrganization, setupComplete, walkthroughSteps, type WalkthroughFacts } from './onboarding.js';

/**
 * The bridge reports the same steps the console walks, in the same order.
 * The old terminal walkthrough was a second list (`app`, `accounts`,
 * `invitations`, …) and the two drifted; this is the one that is left.
 */

const FACTS: WalkthroughFacts = {
  organization: 'acme',
  organizationIsOrg: true,
  clientIdConfigured: true,
  repositoryCount: 1,
  crewCount: 9,
  existingAccounts: 2,
  connected: 1,
  workingAccounts: 1,
  inRepository: 0,
  webhookReady: false,
  webhookStale: false,
};

describe('the walkthrough’s steps', () => {
  it('is the shared list, in the order the steps depend on each other', () => {
    const steps = walkthroughSteps(FACTS);

    expect(steps.map((step) => step.step)).toEqual([...ONBOARDING_STEPS]);
    expect(steps.map((step) => step.title)).toEqual(ONBOARDING_STEPS.map((key) => STEP_TITLES[key]));
    expect(steps.every((step) => step.detail.length > 0)).toBe(true);
  });

  it('counts the GitHub accounts that are connected, and says an invitation is accepted for them', () => {
    const steps = walkthroughSteps(FACTS);
    const accounts = steps.find((step) => step.step === 'github-accounts');
    const access = steps.find((step) => step.step === 'access');

    expect(accounts?.detail).toBe('two accounts: one that does the work and one that approves it');
    expect(accounts?.done).toBe(false);
    expect(walkthroughSteps({ ...FACTS, workingAccounts: 2 }).find((step) => step.step === 'github-accounts')?.done).toBe(true);
    expect(access?.detail).toMatch(/invitation/);
    expect(steps.find((step) => step.step === 'app')?.done).toBe(true);
    expect(steps.find((step) => step.step === 'install')?.done).toBe(false);
  });

  it('counts seats on the access step, and has GitHub invite accounts whoever owns the repository', () => {
    // Nine seats on two accounts read "0 of 9 accounts", beside a step that had just set up two.
    const access = (facts: WalkthroughFacts) => walkthroughSteps(facts).find((step) => step.step === 'access')?.detail ?? '';
    expect(access(FACTS)).toMatch(/^0 of 9 seats can work in the repository;/);
    expect(access({ ...FACTS, organizationIsOrg: false, organization: 'janedoe' })).toContain('OpenADLC invites each account to janedoe');
    expect(access({ ...FACTS, organizationIsOrg: false, organization: 'janedoe' })).not.toContain('invites each bot');
  });

  it('says which plan holds what on the protect step as the rules code does', () => {
    // It said rulesets needed Team and up, and required reviewers Pro and up;
    // `rules.ts` holds rulesets on Pro and a reviewer only on Enterprise.
    const protect = walkthroughSteps(FACTS).find((step) => step.step === 'protect');
    expect(protect?.detail).toMatch(/environment reviewer needs Enterprise/);
    expect(protect?.detail).not.toMatch(/rulesets need Team or\s+Enterprise/);
  });

  it('does not keep the old step list, including the names a link used to carry', () => {
    const keys = walkthroughSteps(FACTS).map((step) => step.step);

    for (const old of ['where', 'email', 'accounts', 'assignment', 'finish', 'invitations', 'connect', 'labels', 'rules']) {
      expect(keys).not.toContain(old);
    }
    expect(ONBOARDING_STEP_ALIASES.email).toBe('github-accounts');
    expect(ONBOARDING_STEP_ALIASES.assignment).toBe('crew');
    expect(ONBOARDING_STEP_ALIASES.finish).toBe('protect');
  });
});

describe('whether setting up is complete', () => {
  const ready = {
    ...FACTS,
    existingAccounts: 9,
    connected: 9,
    workingAccounts: 2,
    inRepository: 9,
    webhookReady: true,
    labelsWritten: true,
    missingAccounts: 0,
  };

  it('is not held back by an account GitHub could not answer for', () => {
    // GitHub's anonymous limit is sixty requests an hour; an account it would
    // not look up sent a working install's board back to the walkthrough.
    expect(setupComplete({ ...ready, existingAccounts: 7 })).toBe(true);
  });

  it('is held back by an account GitHub says nobody holds', () => {
    expect(setupComplete({ ...ready, existingAccounts: 8, missingAccounts: 1 })).toBe(false);
  });
});

describe('whether the owner is an organization', () => {
  it('asks GitHub for the login with the login encoded into the path', async () => {
    const request = vi.fn(async () => ({}));
    expect(await isOrganization('@acme/x', { request } as never)).toBe(true);
    expect(request).toHaveBeenCalledWith('GET', '/orgs/%40acme%2Fx');
  });
});
