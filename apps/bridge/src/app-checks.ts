import { appJwt, requestDeviceCode, DeviceAuthError } from '@fleetadlc/github';
import { appInstallUrl, appSettingsUrl, installationSettingsUrl } from '@fleetadlc/shared';

/**
 * Whether the app is actually set up the way the walkthrough asked.
 *
 * Two settings have no field in GitHub's app manifest, so they are the only
 * things somebody still ticks by hand — and both fail late and quietly. A
 * missing device flow shows up as a connect button that errors on the ninth
 * account as readily as the first; a missing token expiry shows up as
 * credentials that never rotate, months later, with nothing to notice it.
 *
 * So they are checked rather than asked about: device flow at once, token
 * expiry once a bot has connected (see below).
 */
export interface AppChecks {
  deviceFlow: 'enabled' | 'disabled' | 'unknown';
  /** Only knowable once a real authorization has happened; see below. */
  tokenExpiry: 'enabled' | 'disabled' | 'unverified';
  /** Whether the app is installed on the repository this install works in. */
  installed: 'yes' | 'no' | 'unknown';
  /**
   * The account the walkthrough's first step named — the organization, or the
   * person — and whether the app is installed there. Asked before any
   * repository is chosen, which is when the app step is done and the next step
   * needs the app to be somewhere.
   */
  account: string | null;
  installedOnAccount: 'yes' | 'no' | 'unknown';
  /** The repository that was checked, so the page can name it. */
  repository: string | null;
  /** Where to go and fix each of these, so nobody has to be told the URL. */
  settingsUrl: string | null;
  installUrl: string | null;
  /**
   * Which app these credentials actually belong to.
   *
   * The reason this is reported rather than assumed: reusing an app you already
   * have means pasting a client id and a private key, and pasting is how you end
   * up authenticated as something other than what you meant — an app from an
   * older install, or one belonging to a different account. Named here, the page
   * can say "this is fleetadlc-janedoe, installed on one repository" instead of
   * accepting two opaque strings and hoping.
   */
  app: { slug: string; id: number; installations: number } | null;
  /**
   * Whether OpenADLC holds the app's private key. Without it `app` is null and
   * nothing about an installation can be asked; with it, a null `app` is
   * GitHub not answering. The page said "not installed yet" for both.
   */
  privateKeyHeld: boolean;
  detail: string;
}


/**
 * Which app a client id and key actually belong to.
 *
 * The slug is also what the settings and install pages are addressed by — it is
 * not derivable from the client id, so this one call answers both "who is this"
 * and "where do I send somebody to change it".
 */
async function appIdentity(
  clientId: string,
  privateKey: string,
): Promise<{ app: NonNullable<AppChecks['app']>; organization: string | null } | null> {
  try {
    const response = await fetch('https://api.github.com/app', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt({ clientId, privateKey })}`,
      },
    });
    if (!response.ok) return null;
    const app = (await response.json()) as {
      slug?: string;
      id?: number;
      installations_count?: number;
      owner?: { login?: string; type?: string } | null;
    };
    if (!app.slug || !app.id) return null;
    return {
      app: { slug: app.slug, id: app.id, installations: app.installations_count ?? 0 },
      // Which settings the app is under: an organization's app is not on the
      // person's page, and a link there is a 404.
      organization: app.owner?.type === 'Organization' ? (app.owner.login ?? null) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the app is installed on an account, organization or person, and
 * where, when it is, that installation's own page is. GitHub answers each
 * form only for its own kind, so both are asked.
 */
async function installedOnAccountOf(
  clientId: string,
  privateKey: string,
  login: string,
): Promise<{ installed: 'yes' | 'no' | 'unknown'; settingsUrl: string | null }> {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${appJwt({ clientId, privateKey })}` };
  try {
    for (const kind of ['orgs', 'users']) {
      const response = await fetch(`https://api.github.com/${kind}/${encodeURIComponent(login)}/installation`, { headers });
      if (response.ok) {
        const found = (await response.json().catch(() => ({}))) as { id?: number; html_url?: string };
        const settingsUrl = found.html_url ?? (found.id ? installationSettingsUrl(found.id, kind === 'orgs' ? login : null) : null);
        return { installed: 'yes', settingsUrl };
      }
      if (response.status !== 404) return { installed: 'unknown', settingsUrl: null };
    }
    return { installed: 'no', settingsUrl: null };
  } catch {
    return { installed: 'unknown', settingsUrl: null };
  }
}

/**
 * The install page for one account, past GitHub's account picker. The plain
 * page first asks which signed-in GitHub user to act as — on a browser signed
 * in as the crew too, a list of bots under "Select user to authorize" — and
 * only then where to install, which read as a sign-in and not an install.
 */
async function installUrlFor(slug: string, login: string): Promise<string> {
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return appInstallUrl(slug);
    const { id } = (await response.json()) as { id?: number };
    return appInstallUrl(slug, id);
  } catch {
    return appInstallUrl(slug);
  }
}

/** Whether the app can reach the repository at all. */
async function installedOn(
  clientId: string,
  privateKey: string,
  repoFullName: string,
): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repoFullName}/installation`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt({ clientId, privateKey })}`,
      },
    });
    if (response.status === 404) return 'no';
    if (!response.ok) return 'unknown';
    // A suspended installation answers 200 and reaches nothing: "installed"
    // hid the steps to unsuspend it, under a health card saying it was.
    const found = (await response.json().catch(() => ({}))) as { suspended_at?: string | null };
    return found.suspended_at ? 'no' : 'yes';
  } catch {
    return 'unknown';
  }
}

export async function checkApp(input: {
  clientId: string;
  /** Absent on an install that registered its app by hand. */
  privateKey: string | null;
  repoFullName: string | null;
  /** The organization or person the install serves, from the walkthrough's first step. */
  account?: string | null;
  /** Whether any bot has connected, and whether that produced a refresh token. */
  anyRefreshToken: boolean;
  anyConnected: boolean;
}): Promise<AppChecks> {
  const empty = {
    tokenExpiry: 'unverified' as const,
    installed: 'unknown' as const,
    account: input.account ?? null,
    installedOnAccount: 'unknown' as const,
    repository: input.repoFullName,
    settingsUrl: null,
    installUrl: null,
    app: null,
    privateKeyHeld: Boolean(input.privateKey),
  };

  if (!input.clientId) {
    return { ...empty, deviceFlow: 'unknown', detail: 'no client id yet' };
  }

  // The only way to ask. GitHub either issues a code or refuses with
  // `device_flow_disabled`; the code is never presented to anybody and expires
  // on its own in fifteen minutes.
  let deviceFlow: AppChecks['deviceFlow'] = 'unknown';
  let detail = '';
  try {
    await requestDeviceCode({ clientId: input.clientId });
    deviceFlow = 'enabled';
  } catch (error) {
    if (error instanceof DeviceAuthError && error.code === 'device_flow_disabled') {
      deviceFlow = 'disabled';
      detail = 'Device Flow is off, so no bot can authorize';
    } else if (error instanceof DeviceAuthError && error.code === 'incorrect_client_credentials') {
      deviceFlow = 'disabled';
      detail = 'GitHub does not recognise that client id';
    } else if (error instanceof DeviceAuthError && /not.?found/i.test(error.code)) {
      // GitHub's answer for an app that no longer exists is a bare "Not Found",
      // which the page showed as it was, under a step marked done.
      deviceFlow = 'disabled';
      detail =
        'GitHub has no app with this client id any more — it was deleted. Create the app again above; ' +
        'every bot then connects again, because their sign-ins belonged to the app that was deleted.';
    } else {
      // A network failure is not a failed check. Reporting it as "disabled"
      // would send somebody to change a setting that is already right.
      detail = error instanceof Error ? error.message : 'could not ask GitHub';
    }
  }

  /**
   * Not checkable in advance. Nothing in the app's own API says whether user
   * tokens expire — it shows up only in what an authorization returns, where a
   * missing `refresh_token` means expiry is off. So this stays `unverified`
   * until a bot has connected, and is then answered by what actually came back.
   */
  const tokenExpiry: AppChecks['tokenExpiry'] = !input.anyConnected
    ? 'unverified'
    : input.anyRefreshToken
      ? 'enabled'
      : 'disabled';

  // Without the key nothing here can be addressed: the slug is not derivable
  // from the client id, and the installation cannot be asked about.
  // One call, used for both: the identity the page reports and the slug the
  // settings and install URLs are built from.
  const identity = input.privateKey ? await appIdentity(input.clientId, input.privateKey) : null;
  const app = identity?.app ?? null;
  const slug = app?.slug ?? null;
  const installed =
    input.privateKey && input.repoFullName
      ? await installedOn(input.clientId, input.privateKey, input.repoFullName)
      : 'unknown';

  const account = input.account || null;
  const onAccount =
    input.privateKey && account
      ? await installedOnAccountOf(input.clientId, input.privateKey, account)
      : { installed: 'unknown' as const, settingsUrl: null };

  return {
    deviceFlow,
    tokenExpiry,
    installed,
    account,
    installedOnAccount: onAccount.installed,
    repository: input.repoFullName,
    settingsUrl: slug ? appSettingsUrl(slug, identity?.organization ?? null) : null,
    // The install page with its repository picker — for the install's own
    // account when there is one, straight past GitHub's "which user" page; once
    // it is installed there, that installation's page, where more are chosen.
    installUrl: !slug
      ? null
      : onAccount.settingsUrl
        ? onAccount.settingsUrl
        : account
          ? await installUrlFor(slug, account)
          : appInstallUrl(slug),
    app,
    privateKeyHeld: Boolean(input.privateKey),
    detail,
  };
}
