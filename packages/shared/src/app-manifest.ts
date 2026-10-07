import { WEBHOOK_EVENTS } from './onboarding.js';
import { PROJECT_NAME, PROJECT_URL } from './project.js';

/**
 * The GitHub App this install needs, as a manifest GitHub can create from.
 *
 * Registering the app by hand is a dozen separate correctnesses: the
 * permissions, the events, a payload URL, a generated key and a generated
 * secret, each copied between two browser tabs. Every one of them is a place
 * to get it subtly wrong, and two of them — the key and the webhook secret —
 * are values somebody then has to paste back into OpenADLC.
 *
 * A manifest makes it one click. GitHub renders its own create page with all of
 * this already set, and hands back the `client_id`, the private key and the
 * webhook secret, so nothing is copied anywhere.
 *
 * Two settings are not expressible here, because GitHub's manifest has no field
 * for them: **Enable Device Flow** and **Expire user authorization tokens**.
 * They stay manual, and `REQUIRED_APP_SETTINGS` is still what tells somebody to
 * tick them.
 */

/**
 * The API's permission names, which are not the ones its own UI shows.
 *
 * `REQUIRED_APP_PERMISSIONS` is written for a person reading a page — "Commit
 * statuses", "Pull requests". The manifest wants `statuses` and
 * `pull_requests`. Kept as one explicit map rather than derived from those
 * labels, because a rename in the page's wording should not silently change
 * what the app is granted.
 */
export const MANIFEST_PERMISSIONS: Record<string, 'read' | 'write'> = {
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'write',
  // What lets the app publish `review-gate` as its own check run, which a
  // ruleset can require from the app alone; see apps/bridge/src/app-gate.ts.
  checks: 'write',
  workflows: 'write',
  // What lets a bot accept its own repository invitation. See `invitations.ts`.
  administration: 'write',
  // What lets the bridge run a failed CI's jobs again, once, as the app; see
  // `Automation.rerunFailedJobs`.
  actions: 'write',
  // What the `deployment_status` event needs: GitHub delivers an event only
  // to an app that may read what it is about.
  deployments: 'read',
  metadata: 'read',
  // A user permission, "SSH signing keys" on the app's page. Without it a bot's
  // own token cannot register the key its commits are signed with — `POST
  // /user/ssh_signing_keys` answers 403 "Resource not accessible by
  // integration" and GitHub names this in `x-accepted-github-permissions` —
  // so every commit reads Unverified and a branch that requires signatures
  // refuses it.
  git_signing_ssh_public_keys: 'write',
};

/**
 * Each permission as the app's settings page names it, and the heading it is
 * under there.
 *
 * A new OpenADLC can ask for a permission the app it is running with was never
 * given: the manifest only decides what an app is *created* with, and every
 * app made by an older one keeps what it had. The health checks compare what
 * GitHub says the app holds with `MANIFEST_PERMISSIONS`, and a person told to
 * add `git_signing_ssh_public_keys` has nothing on the page to match it to —
 * so the check says "SSH signing keys", under Account permissions, which is
 * what the page shows. Every key of `MANIFEST_PERMISSIONS` needs an entry;
 * `app-manifest.test.ts` holds that.
 */
export const PERMISSION_NAMES: Record<string, { label: string; section: 'Repository' | 'Organization' | 'Account' }> = {
  contents: { label: 'Contents', section: 'Repository' },
  issues: { label: 'Issues', section: 'Repository' },
  pull_requests: { label: 'Pull requests', section: 'Repository' },
  statuses: { label: 'Commit statuses', section: 'Repository' },
  checks: { label: 'Checks', section: 'Repository' },
  workflows: { label: 'Workflows', section: 'Repository' },
  administration: { label: 'Administration', section: 'Repository' },
  actions: { label: 'Actions', section: 'Repository' },
  deployments: { label: 'Deployments', section: 'Repository' },
  metadata: { label: 'Metadata', section: 'Repository' },
  git_signing_ssh_public_keys: { label: 'SSH signing keys', section: 'Account' },
};

/** GitHub's own words for a level, as the permission's dropdown offers it. */
export function accessInWords(level: string): string {
  return level === 'write' ? 'Read and write' : level === 'admin' ? 'Admin' : 'Read-only';
}

const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * The permissions `wanted` asks for that `granted` does not hold at the level
 * asked for, in the manifest's order. Write covers read; admin covers both.
 */
export function missingPermissions(
  granted: Readonly<Record<string, string | undefined>>,
  wanted: Readonly<Record<string, 'read' | 'write'>> = MANIFEST_PERMISSIONS,
): { name: string; wanted: 'read' | 'write'; granted: string | null }[] {
  return Object.entries(wanted).flatMap(([name, level]) => {
    const has = granted[name] ?? null;
    return (LEVELS[has ?? ''] ?? 0) >= (LEVELS[level] ?? 0) ? [] : [{ name, wanted: level, granted: has }];
  });
}

export interface ManifestInput {
  /** Where this console is reachable, which is where GitHub sends the code back. */
  consoleUrl: string;
  /** Where GitHub should deliver webhooks. Empty until there is a public URL. */
  webhookUrl: string;
  organization: string | null;
  /** The end of the app's name. Random when absent; a test passes one for a fixed name. */
  suffix?: string;
}

export interface AppManifest {
  name: string;
  url: string;
  description: string;
  public: boolean;
  redirect_url: string;
  hook_attributes: { url: string; active: boolean };
  default_permissions: Record<string, 'read' | 'write'>;
  default_events: string[];
}

/**
 * The webhook address an app is created with when there is none yet. GitHub
 * creates that app's webhook switched off, and only its settings page can
 * switch it on, so a hook still pointed here says how the app was made.
 */
export const PLACEHOLDER_HOOK_URL = 'https://example.invalid/webhooks/github';

/** Where the manifest is POSTed: an organization's form differs from a person's. */
export function manifestPostUrl(organization: string | null, isOrganization: boolean): string {
  return organization && isOrganization
    ? `https://github.com/organizations/${organization}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

/**
 * The longest name GitHub takes for an app. Believed to be 34 characters from
 * its "Name is too long" refusal; GitHub does not document it, so it is kept
 * here, once.
 */
export const APP_NAME_LIMIT = 34;

/** Lowercase Crockford base32: no look-alikes, and 32 symbols, so `byte & 31` has no bias. */
const SUFFIX_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SUFFIX_LENGTH = 5;

/**
 * A short random end for the app's name. From `globalThis.crypto`, not
 * `node:crypto`: the console imports this package too.
 */
function nameSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SUFFIX_ALPHABET[byte & 31]).join('');
}

/**
 * The name the manifest proposes: `OpenADLC (<owner>) <suffix>`, or
 * `OpenADLC <suffix>` with no owner.
 *
 * GitHub app names are unique across all of GitHub. The same `OpenADLC
 * (<owner>)` every time was refused for a second install for that owner, for
 * "create a different app instead", and for every install with no owner after
 * the first anyone made. A long owner is cut so the suffix always fits.
 */
export function appName(organization: string | null, suffix: string = nameSuffix()): string {
  if (!organization) return `${PROJECT_NAME} ${suffix}`;
  const room = APP_NAME_LIMIT - `${PROJECT_NAME} () ${suffix}`.length;
  const owner = organization.slice(0, Math.max(0, room)).replace(/-+$/, '');
  return owner ? `${PROJECT_NAME} (${owner}) ${suffix}` : `${PROJECT_NAME} ${suffix}`;
}

export function buildAppManifest(input: ManifestInput): AppManifest {
  const name = appName(input.organization, input.suffix);

  return {
    name,
    // Required by GitHub, and not otherwise used by anything here.
    url: PROJECT_URL,
    description:
      'The OAuth client an OpenADLC install authorizes its bot accounts through, and the identity that invites them to a repository, merges an approved change and dispatches its deploy workflows.',
    // Private. This app exists for one install and should not be installable by
    // anybody who finds it.
    public: false,
    redirect_url: `${input.consoleUrl.replace(/\/$/, '')}/onboarding/app-created`,
    hook_attributes: {
      // A placeholder rather than nothing: `url` is required. OpenADLC rewrites it
      // with `PATCH /app/hook/config` once there is an address — which cannot
      // switch the webhook on. `active` is decided here, once, so the
      // walkthrough raises its tunnel before the app is made and passes it in.
      url: input.webhookUrl || PLACEHOLDER_HOOK_URL,
      active: Boolean(input.webhookUrl),
    },
    default_permissions: MANIFEST_PERMISSIONS,
    default_events: [...WEBHOOK_EVENTS],
  };
}
