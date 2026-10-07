import { describe, expect, it } from 'vitest';
import {
  accessReasonFor,
  accountGroupOf,
  appAdvancedUrl,
  ONBOARDING_STEP_ALIASES,
  ONBOARDING_STEPS,
  onboardingStepKey,
  otherGroupHolder,
  otherGroupRefusal,
  appInstallUrl,
  appSettingsUrl,
  newAppUrl,
  repositoryRoleFor,
  repositoryRoleOffered,
  STEP_SHORT,
  STEP_TITLES,
  STEP_WHY,
  suggestBotEmail,
  suggestedLogin,
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_NAMES,
  yourAppsUrl,
} from './onboarding.js';

describe('the walkthrough’s steps', () => {
  it('asks for each thing after the thing it depends on', () => {
    expect([...ONBOARDING_STEPS]).toEqual([
      'start',
      'owner',
      'app',
      'install',
      'webhook',
      'repository',
      'github-accounts',
      'models',
      'crew',
      'access',
      'protect',
      'done',
    ]);
    expect(STEP_TITLES.webhook).toBe('Webhook');
    expect(STEP_TITLES.app).toBe('Create the app');
    expect(STEP_TITLES.install).toBe('Install the app');
    expect(STEP_TITLES['github-accounts']).toBe('GitHub accounts');
    expect(STEP_TITLES.models).toBe('Foundation model accounts / API keys');
    expect(STEP_TITLES.crew).toBe('Crew');
    expect(STEP_TITLES.protect).toBe('Protect the repositories');
    expect(STEP_TITLES.done).toBe('Ready');
    expect(ONBOARDING_STEPS.map((step) => STEP_SHORT[step])).toEqual([
      'Start',
      'Owner',
      'App',
      'Install',
      'Webhook',
      'Repositories',
      'GitHub accounts',
      'Model accounts',
      'Crew',
      'Access',
      'Protection',
      'Ready',
    ]);
    for (const step of ONBOARDING_STEPS) {
      expect(STEP_TITLES[step].endsWith('.')).toBe(false);
      expect(STEP_TITLES[step].includes('?')).toBe(false);
    }
  });

  it('sends an old link to the step that does the same thing', () => {
    expect(onboardingStepKey('where')).toBe('owner');
    expect(onboardingStepKey('email')).toBe('github-accounts');
    expect(onboardingStepKey('accounts')).toBe('models');
    expect(onboardingStepKey('assignment')).toBe('crew');
    expect(onboardingStepKey('finish')).toBe('protect');
    expect(onboardingStepKey('app')).toBe('app');
    expect(onboardingStepKey('nonsense')).toBeNull();
    expect(Object.keys(ONBOARDING_STEP_ALIASES).every((key) => !(ONBOARDING_STEPS as readonly string[]).includes(key))).toBe(true);
  });
});

describe('why the app step matters', () => {
  it('says the app merges, rather than that nothing ever acts as it', () => {
    // The step once said OpenADLC never acts as the app. The merge line does,
    // and an operator who believed it could leave the key unset and never see
    // anything merge.
    expect(STEP_WHY.app).toMatch(/merge/);
    expect(STEP_WHY.app).not.toMatch(/never acts as it/);
  });
});

describe('suggesting an email per bot', () => {
  it('tags the operator’s own gmail so every bot lands in one inbox', () => {
    // The one address here that is not under example.test: only a provider
    // known to deliver plus-addressed mail takes this branch. No such mailbox
    // can exist — Gmail allows no hyphen in a username.
    const suggestion = suggestBotEmail('example-owner@gmail.com', 'mira');

    expect(suggestion.email).toBe('example-owner+fleetadlc-mira@gmail.com');
    expect(suggestion.plusAddressed).toBe(true);
    expect(suggestion.note).toMatch(/one place/);
  });

  it('strips a tag the operator already had, rather than stacking another', () => {
    expect(suggestBotEmail('owner+github@example.test', 'atlas').email).toBe('owner+fleetadlc-atlas@example.test');
  });

  it('warns when the domain may not deliver plus-addressed mail', () => {
    const suggestion = suggestBotEmail('owner@example.test', 'sydney');

    expect(suggestion.email).toBe('owner+fleetadlc-sydney@example.test');
    expect(suggestion.plusAddressed).toBe(false);
    expect(suggestion.note).toMatch(/check that example\.test/);
  });

  it('asks for an address rather than inventing one', () => {
    expect(suggestBotEmail('', 'mira').email).toBeNull();
    expect(suggestBotEmail('not-an-address', 'mira').email).toBeNull();
    expect(suggestBotEmail(null, 'mira').note).toMatch(/give your own email/);
  });

  it('is case-insensitive about what it is given', () => {
    expect(suggestBotEmail('  Owner@EXAMPLE.test ', 'nova').email).toBe('owner+fleetadlc-nova@example.test');
  });
});

describe('suggesting a login', () => {
  it('prefixes the bot name', () => {
    expect(suggestedLogin('mira')).toBe('fleetadlc-mira');
  });

  it('keeps a login GitHub will accept', () => {
    expect(suggestedLogin('atlas_core')).toBe('fleetadlc-atlas-core');
  });
});

describe('access follows the role', () => {
  it('gives intake and automation triage on an organization, so neither can push', () => {
    expect(repositoryRoleFor('intake', true)).toBe('triage');
    expect(repositoryRoleFor('automation', true)).toBe('triage');
  });

  it('offers triage only where the owner is known to be an organization', () => {
    // An owner GitHub could not be asked about was taken for an organization,
    // and a person was told to grant triage on a page that has no such role.
    expect(repositoryRoleOffered('intake', true)).toBe('triage');
    expect(repositoryRoleOffered('automation', false)).toBe('write');
    expect(repositoryRoleOffered('automation', null)).toBe('write');
    expect(repositoryRoleOffered('intake', undefined)).toBe('write');
    expect(repositoryRoleOffered('review_lead', true)).toBe('write');
  });

  it('gives reviewers write, because an approval only counts with it', () => {
    expect(repositoryRoleFor('review_lead', true)).toBe('write');
    expect(repositoryRoleFor('review_second', true)).toBe('write');
  });

  it('tells the person granting the system engineer write what it commits: ADRs, nothing else', () => {
    // It said the system engineer implements, in repositories named by a term
    // defined nowhere, while the role and the skill said it never writes code.
    const reason = accessReasonFor('spec');
    expect(reason).toContain('docs/adr/');
    expect(reason).not.toContain('implements');
  });
});

describe('where to create the app', () => {
  it('points at the organization when there is one', () => {
    expect(newAppUrl('fleetadlc-example')).toBe('https://github.com/organizations/fleetadlc-example/settings/apps/new');
  });

  it('falls back to a personal account', () => {
    expect(newAppUrl(null)).toBe('https://github.com/settings/apps/new');
  });
});

describe('the webhook subscribes to what the bridge acts on', () => {
  it('names the six events and nothing else', () => {
    expect([...WEBHOOK_EVENTS]).toEqual([
      'issues',
      'issue_comment',
      'pull_request',
      'pull_request_review',
      'workflow_run',
      // What labels a change deployed; the bridge handled it before the app asked for it.
      'deployment_status',
    ]);
  });

  it('names each event as the app’s page does, so a person told to tick one can find it', () => {
    for (const event of WEBHOOK_EVENTS) expect(WEBHOOK_EVENT_NAMES[event]).toBeTruthy();
    expect(WEBHOOK_EVENT_NAMES.deployment_status).toBe('Deployment status');
  });
});

describe('finding an app you already have', () => {
  /**
   * GitHub has no API that lists the apps an account owns, so OpenADLC cannot look
   * one up. It does have a page, and that page carries both values OpenADLC needs
   * — the client id is on it and a private key is generated from it — so the
   * answer to "I think I already have one" is a link rather than a search.
   */
  it('points a personal account at its own apps', () => {
    expect(yourAppsUrl(null)).toBe('https://github.com/settings/apps');
  });

  it('points an organization at the organization’s apps, not the operator’s', () => {
    // An app owned by the organization is invisible on a personal settings page,
    // which is exactly the case where somebody would conclude it is not there.
    expect(yourAppsUrl('janedoe')).toBe('https://github.com/organizations/janedoe/settings/apps');
  });

  it('is the listing, not the create form', () => {
    // `newAppUrl` is the other one. Sending somebody to `/new` when they came
    // looking for an app they already have is how a second app gets created.
    expect(yourAppsUrl('janedoe')).not.toContain('/new');
    expect(newAppUrl('janedoe')).toContain('/new');
  });
});

describe('one app’s settings page', () => {
  /**
   * Where the webhook's Active switch is, which no API can turn on — so the
   * link to it is the whole of the fix for a webhook GitHub is not sending
   * from, and it has to be the page that exists for this owner.
   */
  it('is under the person’s settings for an app they own', () => {
    expect(appSettingsUrl('fleetadlc-janedoe', null)).toBe('https://github.com/settings/apps/fleetadlc-janedoe');
  });

  it('is under the organization’s for an app it owns, where the personal address 404s', () => {
    expect(appSettingsUrl('fleetadlc-acme', 'acme')).toBe('https://github.com/organizations/acme/settings/apps/fleetadlc-acme');
  });

  it('has an Advanced page, where Make public is, under whichever settings own the app', () => {
    expect(appAdvancedUrl('fleetadlc-janedoe', null)).toBe('https://github.com/settings/apps/fleetadlc-janedoe/advanced');
    expect(appAdvancedUrl('fleetadlc-acme', 'acme')).toBe('https://github.com/organizations/acme/settings/apps/fleetadlc-acme/advanced');
  });
});

describe('installing the app', () => {
  it('is GitHub’s own page for the app, which asks which account and which repositories', () => {
    expect(appInstallUrl('fleetadlc-janedoe')).toBe('https://github.com/apps/fleetadlc-janedoe/installations/new');
  });

  it('goes past GitHub’s account picker when the account is known, by its numeric id', () => {
    expect(appInstallUrl('fleetadlc-exampleco', 12345)).toBe('https://github.com/apps/fleetadlc-exampleco/installations/new/permissions?target_id=12345');
    expect(appInstallUrl('fleetadlc-exampleco', null)).toBe('https://github.com/apps/fleetadlc-exampleco/installations/new');
  });
});

describe('the crew account and the reviewer account', () => {
  const crew = [
    { id: 'b-builder', role: 'implement' as const, githubLogin: 'fleetadlc-crew', connected: true },
    { id: 'b-lead', role: 'review_lead' as const, githubLogin: 'fleetadlc-review', connected: true },
  ];

  it('puts the three reviewers on one account and everyone else on the other', () => {
    expect(accountGroupOf('review_security')).toBe('reviewers');
    expect(accountGroupOf('automation')).toBe('crew');
    expect(accountGroupOf('deploy')).toBe('crew');
  });

  it('refuses a reviewer on the account the builder opens pull requests as, and the other way round', () => {
    expect(otherGroupHolder('FleetADLC-Crew', { id: 'b-second', role: 'review_second' }, crew)?.id).toBe('b-builder');
    expect(otherGroupHolder('fleetadlc-review', { id: 'b-qa', role: 'qa' }, crew)?.id).toBe('b-lead');
  });

  it('lets a seat join its own group’s account', () => {
    expect(otherGroupHolder('fleetadlc-crew', { id: 'b-qa', role: 'qa' }, crew)).toBeNull();
    expect(otherGroupHolder('fleetadlc-review', { id: 'b-second', role: 'review_second' }, crew)).toBeNull();
  });

  it('says why, in GitHub’s terms', () => {
    const said = otherGroupRefusal('fleetadlc-crew', { role: 'review_second' }, { role: 'implement' });
    expect(said).toMatch(/^fleetadlc-crew is the crew account \(the builder signs in as it\)\./);
    expect(said).toContain('won’t let the account that opened a pull request approve it');
    expect(said).toContain('with the reviewer account');
  });
});
