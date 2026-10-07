import { describe, expect, it } from 'vitest';
import { APP_NAME_LIMIT, accessInWords, buildAppManifest, manifestPostUrl, missingPermissions, MANIFEST_PERMISSIONS, PERMISSION_NAMES } from './app-manifest.js';
import { REQUIRED_APP_PERMISSIONS, WEBHOOK_EVENTS, appPermissionsUrl, installationSettingsUrl } from './onboarding.js';
import { PROJECT_NAME, PROJECT_URL } from './project.js';

const INPUT = { consoleUrl: 'http://127.0.0.1:47300', webhookUrl: '', organization: 'janedoe' };

describe('the app OpenADLC asks GitHub to create', () => {
  it('asks for every permission the page tells an operator to grant', () => {
    // The two lists are written for different audiences — one for a person
    // reading a table, one for GitHub's API — and their drifting apart would mean
    // the app created here is not the app the page described.
    expect(Object.keys(MANIFEST_PERMISSIONS)).toHaveLength(REQUIRED_APP_PERMISSIONS.length);
  });

  it('asks for administration, without which no bot can accept its invitation', () => {
    expect(MANIFEST_PERMISSIONS.administration).toBe('write');
  });

  it('says in its description that the app merges and dispatches deploys', () => {
    // The app is more than the bots' OAuth client: the merge line acts as it.
    expect(buildAppManifest(INPUT).description).toMatch(/merges/);
    expect(buildAppManifest(INPUT).description).toMatch(/deploy/);
  });

  it('is named from PROJECT_NAME, so a fork renames its app in one place', () => {
    expect(buildAppManifest({ ...INPUT, suffix: 'k3x9p' }).name).toBe(`${PROJECT_NAME} (janedoe) k3x9p`);
    expect(buildAppManifest({ ...INPUT, organization: null, suffix: 'k3x9p' }).name).toBe(`${PROJECT_NAME} k3x9p`);
    expect(buildAppManifest(INPUT).url).toBe(PROJECT_URL);
  });

  it('ends its name with a random lowercase suffix, since GitHub app names are unique across GitHub', () => {
    expect(buildAppManifest(INPUT).name).toMatch(new RegExp(`^${PROJECT_NAME} \\(janedoe\\) [0-9a-hjkmnp-tv-z]{4,}$`));
    expect(buildAppManifest({ ...INPUT, organization: null }).name).toMatch(new RegExp(`^${PROJECT_NAME} [0-9a-hjkmnp-tv-z]{4,}$`));
  });

  it('proposes a different name each time, so a second app for the same owner is not refused', () => {
    expect(buildAppManifest(INPUT).name).not.toBe(buildAppManifest(INPUT).name);
  });

  it('cuts a long owner, never the suffix, to stay within GitHub’s length', () => {
    const owner = 'a'.repeat(39);
    const name = buildAppManifest({ ...INPUT, organization: owner, suffix: 'k3x9p' }).name;
    expect(APP_NAME_LIMIT).toBe(34);
    expect(name.length).toBeLessThanOrEqual(APP_NAME_LIMIT);
    expect(name).toMatch(new RegExp(`^${PROJECT_NAME} \\(a+\\) k3x9p$`));
    for (let index = 0; index < 50; index++) {
      expect(buildAppManifest({ ...INPUT, organization: owner }).name.length).toBeLessThanOrEqual(APP_NAME_LIMIT);
    }
  });

  it('subscribes to exactly the events the bridge acts on', () => {
    expect(buildAppManifest(INPUT).default_events).toEqual([...WEBHOOK_EVENTS]);
  });

  it('comes back to this console, which is where the code is exchanged', () => {
    expect(buildAppManifest(INPUT).redirect_url).toBe('http://127.0.0.1:47300/onboarding/app-created');
  });

  it('does not double the slash when the console url has a trailing one', () => {
    const manifest = buildAppManifest({ ...INPUT, consoleUrl: 'https://fleetadlc.example.com/' });
    expect(manifest.redirect_url).toBe('https://fleetadlc.example.com/onboarding/app-created');
  });

  it('is private, because it exists for one install', () => {
    expect(buildAppManifest(INPUT).public).toBe(false);
  });

  it('links to the project’s home, whoever the install belongs to', () => {
    expect(buildAppManifest(INPUT).url).toBe('https://github.com/620legal/OpenADLC');
    expect(buildAppManifest({ ...INPUT, organization: 'acme' }).url).toBe('https://github.com/620legal/OpenADLC');
  });

  it('leaves the webhook inactive until there is somewhere to deliver to', () => {
    // `hook_attributes.url` is required, and a fresh install has no public
    // address. A placeholder that is switched off is honest; a real-looking URL
    // that swallows deliveries is not.
    const manifest = buildAppManifest(INPUT);
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.hook_attributes.url).toContain('invalid');
  });

  it('turns the webhook on once a public url is known', () => {
    const manifest = buildAppManifest({ ...INPUT, webhookUrl: 'https://x.trycloudflare.com/webhooks/github' });
    expect(manifest.hook_attributes).toEqual({
      url: 'https://x.trycloudflare.com/webhooks/github',
      active: true,
    });
  });
});

describe('where the manifest is posted', () => {
  it('uses the organization form when the owner is one', () => {
    expect(manifestPostUrl('acme', true)).toBe('https://github.com/organizations/acme/settings/apps/new');
  });

  it('uses the personal form otherwise, including when the owner is unknown', () => {
    // Posting an organization manifest for a person 404s, so the ambiguous case
    // has to fall the safe way.
    expect(manifestPostUrl('janedoe', false)).toBe('https://github.com/settings/apps/new');
    expect(manifestPostUrl(null, false)).toBe('https://github.com/settings/apps/new');
  });
});

/**
 * A permission a new OpenADLC adds to the manifest is one every older app lacks,
 * and the health check that says so names it as the app's settings page does.
 */
describe('each permission, as a person finds it on the app’s page', () => {
  it('has a name and a heading for every permission the manifest asks for, and the page’s table has each', () => {
    for (const name of Object.keys(MANIFEST_PERMISSIONS)) {
      const named = PERMISSION_NAMES[name];
      expect(named, name).toBeDefined();
      expect(REQUIRED_APP_PERMISSIONS.some((row) => row.permission === named?.label), name).toBe(true);
    }
    expect(PERMISSION_NAMES.git_signing_ssh_public_keys).toEqual({ label: 'SSH signing keys', section: 'Account' });
    expect(accessInWords('write')).toBe('Read and write');
    expect(accessInWords('read')).toBe('Read-only');
  });

  it('is missing when the app does not hold it at the level asked for; write covers read', () => {
    const { git_signing_ssh_public_keys: _left, ...older } = MANIFEST_PERMISSIONS;
    expect(missingPermissions(older)).toEqual([{ name: 'git_signing_ssh_public_keys', wanted: 'write', granted: null }]);
    expect(missingPermissions({ ...MANIFEST_PERMISSIONS, actions: 'write' })).toEqual([]);
    expect(missingPermissions({ ...MANIFEST_PERMISSIONS, contents: 'read' })).toEqual([{ name: 'contents', wanted: 'write', granted: 'read' }]);
  });

  it('is added on the app’s permissions page, and accepted on its installation’s', () => {
    expect(appPermissionsUrl('fleetadlc-janedoe', null)).toBe('https://github.com/settings/apps/fleetadlc-janedoe/permissions');
    expect(appPermissionsUrl('fleetadlc-acme', 'acme')).toBe('https://github.com/organizations/acme/settings/apps/fleetadlc-acme/permissions');
    expect(installationSettingsUrl(42, null)).toBe('https://github.com/settings/installations/42');
    expect(installationSettingsUrl(42, 'acme')).toBe('https://github.com/organizations/acme/settings/installations/42');
  });
});

describe('the table a person grants the permissions from', () => {
  it('asks for each at the access the manifest does, so an app made by hand is the same app', () => {
    // The Actions row said read-only after the manifest asked for write: an app
    // made from the table then failed its permissions card at once.
    for (const [name, wanted] of Object.entries(MANIFEST_PERMISSIONS)) {
      const row = REQUIRED_APP_PERMISSIONS.find((one) => one.permission === PERMISSION_NAMES[name]?.label);
      expect(row?.access, name).toBe(wanted === 'write' ? 'Read and write' : 'Read-only');
    }
  });
});
