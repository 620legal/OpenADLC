import { describe, expect, it } from 'vitest';
import { installHeld, installKnown, installRow, installUndecided, keepsAsking, type AppChecks } from './app-checks';

const done: AppChecks = {
  deviceFlow: 'enabled',
  tokenExpiry: 'enabled',
  installed: 'yes',
  repository: 'example-org/app',
  settingsUrl: null,
  installUrl: null,
  app: { slug: 'fleetadlc-example', id: 1, installations: 1 },
  detail: '',
};

describe('whether the install step is done', () => {
  it('needs a known yes, and holds the step while GitHub says it is not installed', () => {
    expect(installKnown(null)).toBe(false);
    expect(installKnown(undefined)).toBe(false);
    expect(installKnown({ ...done, installed: 'unknown', installedOnAccount: 'unknown' })).toBe(false);
    expect(installKnown({ ...done, installed: 'yes' })).toBe(true);
    expect(installKnown({ ...done, installed: 'unknown', installedOnAccount: 'yes' })).toBe(true);

    expect(installHeld(null)).toBe(false);
    expect(installHeld({ ...done, installed: 'no' })).toBe(true);
    expect(installHeld({ ...done, repository: null, installed: 'unknown', installedOnAccount: 'no' })).toBe(true);
    expect(installHeld({ ...done, installed: 'yes' })).toBe(false);
  });
});

describe('whether the panel keeps asking', () => {
  it('keeps asking while something is still to be done on GitHub', () => {
    expect(keepsAsking(null, 'settings')).toBe(true);
    expect(keepsAsking(null, 'install')).toBe(true);
    expect(keepsAsking({ ...done, deviceFlow: 'disabled' }, 'settings')).toBe(true);
    expect(keepsAsking({ ...done, installed: 'no' }, 'install')).toBe(true);
  });

  it('stops once everything is done, rather than asking GitHub forever', () => {
    expect(keepsAsking(done, 'settings')).toBe(false);
    expect(keepsAsking(done, 'install')).toBe(false);
  });

  it('asks about what its own step shows: device flow in settings, installing on the install step', () => {
    expect(keepsAsking({ ...done, installed: 'no' }, 'settings')).toBe(false);
    expect(keepsAsking({ ...done, deviceFlow: 'disabled' }, 'install')).toBe(false);
  });
});

describe('the install line before a repository is chosen', () => {
  const fresh: AppChecks = { ...done, repository: null, installed: 'unknown', installUrl: 'https://github.com/apps/fleetadlc-example/installations/new', app: { slug: 'fleetadlc-example', id: 1, installations: 0 } };

  it('offers the install instead of saying "not checked"', async () => {
    const { installRow } = await import('./app-checks');
    const row = installRow(fresh);
    expect(row.chip).toEqual({ tone: 'attention', text: 'not installed yet' });
    expect(row.button).toEqual({ label: 'Install the app', url: fresh.installUrl });
    expect(JSON.stringify(row)).not.toContain('not checked');
  });

  it('says to choose only the repositories the crew works in, never all of them', async () => {
    // An all-repositories install, with the bots members of the organization,
    // lets a crew token reach repositories OpenADLC does not manage.
    const { installRow } = await import('./app-checks');
    expect(installRow(fresh).text).toContain('choose only the repositories the crew will work in');
    expect(installRow(fresh).text).not.toContain('all of them');
  });

  it('counts an install anywhere as done for this step, and stops asking', async () => {
    const { installRow } = await import('./app-checks');
    const installed = { ...fresh, app: { slug: 'fleetadlc-example', id: 1, installations: 1 } };
    expect(installRow(installed).chip).toEqual({ tone: 'signal', text: 'installed on 1 account' });
    expect(installRow(installed).button).toBeNull();
    expect(keepsAsking(installed, 'install')).toBe(false);
    expect(keepsAsking(fresh, 'install')).toBe(true);
  });
});

describe('the install line for the account named in the first step', () => {
  const base: AppChecks = { ...done, repository: null, installed: 'unknown', account: 'example-org', installUrl: 'https://github.com/apps/fleetadlc-example/installations/new/permissions?target_id=42', app: { slug: 'fleetadlc-example', id: 1, installations: 1 } };

  it('asks about that account, not about installs anywhere', async () => {
    const { installRow } = await import('./app-checks');
    // Installed somewhere else, not on example-org: not done.
    const row = installRow({ ...base, installedOnAccount: 'no' });
    expect(row.label).toBe('Install it on example-org');
    expect(row.chip).toEqual({ tone: 'attention', text: 'not installed yet' });
    expect(row.button).toEqual({ label: 'Install on example-org', url: base.installUrl });
    expect(row.text).toContain('choose only the repositories the crew will work in');
    expect(row.text).not.toContain('all of them');
    expect(keepsAsking({ ...base, installedOnAccount: 'no' }, 'install')).toBe(true);
  });

  it('is done once the app is on that account', async () => {
    const { installRow } = await import('./app-checks');
    expect(installRow({ ...base, installedOnAccount: 'yes' }).chip).toEqual({ tone: 'signal', text: 'installed' });
    expect(keepsAsking({ ...base, installedOnAccount: 'yes' }, 'install')).toBe(false);
  });
});

describe('an install step GitHub was not asked about, or did not answer', () => {
  const unknown: AppChecks = { ...done, repository: null, installed: 'unknown', installedOnAccount: 'unknown', account: 'exampleco', app: null, privateKeyHeld: false };

  it('says OpenADLC holds no key to ask with, not "not installed yet", and stops asking', () => {
    const row = installRow(unknown);
    expect(row.chip).toBeNull();
    expect(row.text).toContain('does not hold the app’s private key');
    expect(row.button).toBeNull();
    // Each ask is a device-code request to GitHub, and nothing can answer it.
    expect(installUndecided(unknown)).toBe(false);
  });

  it('says GitHub did not answer while the key is held, and keeps asking', () => {
    const silent = { ...unknown, privateKeyHeld: true };
    expect(installRow(silent).chip).toBeNull();
    expect(installRow(silent).text).toContain('GitHub did not answer');
    expect(installRow({ ...silent, detail: 'fetch failed' }).text).toBe('fetch failed');
    expect(installUndecided(silent)).toBe(true);
  });

  it('does not count an install on some other account while the install’s own is unknown', () => {
    const elsewhere = { ...unknown, privateKeyHeld: true, app: { slug: 'fleetadlc-example', id: 1, installations: 1 } };
    expect(installRow(elsewhere).chip).toBeNull();
    expect(installUndecided(elsewhere)).toBe(true);
  });
});

describe('a suspended installation', () => {
  const suspended: AppChecks = {
    ...done,
    installed: 'yes',
    fix: {
      need: 'unsuspend',
      title: 'The OpenADLC app is suspended on exampleco',
      detail: '',
      action: { label: 'Open the installation', url: 'https://github.com/organizations/exampleco/settings/installations/88' },
      steps: [{ text: 'Unsuspend it', action: { label: 'Open the installation', url: 'https://github.com/organizations/exampleco/settings/installations/88' } }],
    },
  };

  it('says suspended and what to do, not installed, and holds the step', () => {
    // "installed" in green, under a health card saying it was suspended.
    expect(installRow(suspended)).toEqual({
      label: 'Install it on example-org/app',
      chip: { tone: 'attention', text: 'suspended' },
      text: 'The OpenADLC app is suspended on exampleco',
      button: null,
    });
    expect(installHeld(suspended)).toBe(true);
    expect(keepsAsking(suspended, 'install')).toBe(true);
  });

  it('says a repository the app was not given as not installed', () => {
    expect(installRow({ ...suspended, installed: 'no', fix: { ...suspended.fix!, need: 'add-repository', title: 'Add api to the app' } }).chip).toEqual({ tone: 'attention', text: 'not installed' });
  });
});
