import { DeviceAuthError, GitHubApiError, appJwt, type AppApi, type AppCredentials, type ScopedOutcome } from '@fleetadlc/github';
import {
  MANIFEST_PERMISSIONS,
  PERMISSION_NAMES,
  REQUIRED_APP_PERMISSIONS,
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_NAMES,
  accessInWords,
  appPermissionsUrl,
  appSettingsUrl,
  installationSettingsUrl,
  missingPermissions,
  yourAppsUrl,
  type HealthAction,
} from '@fleetadlc/shared';
import type { InstallationsView, Reach } from '../../app-reach.js';
import type { CheckResult, HealthCheck } from '../types.js';
import { RECONNECT, stepHref, stepNamed } from '../words.js';

/**
 * The app, asked as the app.
 *
 * Everything here is GitHub's answer about the app itself — what it holds,
 * where it is installed, whether it issues device codes — rather than what
 * the walkthrough told somebody to tick. Two of its settings have no field in
 * the manifest and no API, and a new OpenADLC can ask for a permission an app
 * made by an older one was never given; each fails late and quietly unless it
 * is asked.
 */

/**
 * Permissions whose absence disables one optional thing rather than OpenADLC:
 * without "Actions: write" a failed CI is not run again by itself.
 */
const ADVISORY_PERMISSIONS = new Set(['actions']);

export interface AppReader {
  /** The app's client id, or empty before there is one. */
  clientId(): Promise<string>;
  /** What acting as the app needs, or null when OpenADLC does not hold its key. */
  credentials(): Promise<AppCredentials | null>;
  api: AppApi;
  /** The repositories this install manages. */
  repositories(): Promise<{ name: string; fullName: string }[]>;
  /** Asks GitHub for a device code, which it refuses when Device Flow is off. */
  requestDeviceCode(clientId: string): Promise<unknown>;
  /**
   * How each sign-in OpenADLC holds was issued, by who holds it — every seat,
   * and every account no seat is on: `refresh` only when the app's user
   * tokens expire.
   */
  tokenKinds(): Promise<{ who: string; kind: 'refresh' | 'static' }[]>;
  /**
   * Whether the app can reach a repository and, when it cannot, what a person
   * does about it; see `app-reach.ts`. Without it, all this can say is
   * "install the app" — which for a private app on another account is
   * something GitHub does not allow.
   */
  reach?(fullName: string): Promise<Reach>;
  /** Each account's installation of the app and the repositories OpenADLC works in there; see `app-reach.ts`. */
  installations?(): Promise<InstallationsView>;
  /**
   * Whether GitHub enforces rules on at least one of the install's
   * repositories: false when every one is on a plan that refuses rulesets,
   * null when that is not known. Read from the repository plans OpenADLC already
   * made (`RepoSetup.enforcesRules`), never asked of GitHub here.
   */
  enforcesRules?(): Promise<boolean | null>;
  /** The app's client secret, or null when OpenADLC holds none. Without it the client secret check is not registered. */
  clientSecret?(): Promise<string | null>;
  /** How the token broker's last try at a token scoped to a repository went; null before the first. */
  lastScoped?(): ScopedOutcome | null;
  /**
   * Whether GitHub accepts the app's client id and secret, asked with a bot's
   * token (`clientSecretAccepted`); null when no bot has a token to ask with.
   * Throws when GitHub could not be asked.
   */
  secretAccepted?(clientId: string, clientSecret: string): Promise<boolean | null>;
}

interface AppFacts {
  slug: string;
  id: number;
  /** The organization the app belongs to, whose settings it lives under; null for a person's. */
  organization: string | null;
  permissions: Record<string, string>;
  /** The events the app is subscribed to. */
  events: string[];
}

interface Installation {
  id: number;
  account: { login: string; type: string } | null;
  permissions: Record<string, string>;
}

/** Asked once for every check that needs it within half a minute. */
const MEMO_MS = 30_000;

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let held: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (held && Date.now() - held.at < MEMO_MS) return held.value;
    const value = load();
    held = { at: Date.now(), value };
    value.catch(() => {
      held = null;
    });
    return value;
  };
}

/** The app's own description of itself. Null without its key. */
function appFacts(reader: AppReader): () => Promise<AppFacts | null> {
  return memo(async () => {
    const credentials = await reader.credentials();
    if (!credentials) return null;
    const app = await reader.api.request<{
      slug?: string;
      id?: number;
      owner?: { login?: string; type?: string } | null;
      permissions?: Record<string, string> | null;
      events?: string[] | null;
    }>('GET', '/app', appJwt(credentials));
    if (!app.slug || !app.id) throw new Error('GitHub described the app without its slug or id');
    return {
      slug: app.slug,
      id: app.id,
      organization: app.owner?.type === 'Organization' ? (app.owner.login ?? null) : null,
      permissions: app.permissions ?? {},
      events: app.events ?? [],
    };
  });
}

/** The installation covering a repository, or null when the app is not installed on it. */
async function installationOn(reader: AppReader, credentials: AppCredentials, fullName: string): Promise<Installation | null> {
  try {
    const found = await reader.api.request<{
      id?: number;
      account?: { login?: string; type?: string } | null;
      permissions?: Record<string, string> | null;
    }>('GET', `/repos/${fullName}/installation`, appJwt(credentials));
    if (!found.id) return null;
    return {
      id: found.id,
      account: found.account?.login ? { login: found.account.login, type: found.account.type ?? 'User' } : null,
      permissions: found.permissions ?? {},
    };
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

/**
 * GitHub's status for a refusal, whichever client made the call. Both of
 * OpenADLC's throw `GitHubApiError`; the message is read for an error that only
 * says it there.
 */
export function statusOf(error: unknown): number | null {
  if (error instanceof GitHubApiError) return error.status;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status;
  const said = /→ (\d{3}):/.exec(error instanceof Error ? error.message : '');
  return said ? Number(said[1]) : null;
}

/**
 * Why GitHub answered 403, when its words say a cause other than the account
 * lacking access: a rate limit, an organization's SAML single sign-on, or its
 * IP allow list. Read as "not in the repository", a builder that spent its
 * account's rate limit blocked every seat on it and sent a person to redo the
 * invitations. Null for any other answer, a 403 that names none of these too.
 */
export function forbiddenBecause(error: unknown): 'rate-limit' | 'sso' | 'ip-allow-list' | null {
  if (statusOf(error) !== 403) return null;
  const said = error instanceof GitHubApiError ? error.body : error instanceof Error ? error.message : String(error);
  // "API rate limit exceeded for user ID …" and "You have exceeded a secondary rate limit".
  if (/rate limit/i.test(said)) return 'rate-limit';
  // "Resource protected by organization SAML enforcement. You must grant your … access to this organization."
  if (/SAML enforcement/i.test(said)) return 'sso';
  // "Although you appear to have the correct authorization credentials, the `org` organization has an IP allow list enabled …"
  if (/IP allow list/i.test(said)) return 'ip-allow-list';
  return null;
}

function settingsAction(app: AppFacts | null, organization: string | null): HealthAction {
  return app
    ? { label: 'Open the app’s settings', url: appSettingsUrl(app.slug, app.organization) }
    : { label: 'Open your apps', url: yourAppsUrl(organization) };
}

export interface AppChecks {
  installed: HealthCheck;
  permissions: HealthCheck;
  deviceFlow: HealthCheck;
  tokenExpiry: HealthCheck;
  clientSecret: HealthCheck;
  selection: HealthCheck;
  /** Whether GitHub says the app lacks a permission, by its API name. False when it cannot be asked. */
  lacks(permission: string): Promise<boolean>;
}

export function appChecks(reader: AppReader): AppChecks {
  const app = appFacts(reader);

  const installed: HealthCheck = {
    id: 'app-installed',
    proves: 'The OpenADLC app is installed on every repository this install manages',
    how: 'asks GitHub, as the app, for its installation on each repository',
    everyMinutes: 15,
    steps: ['install'],
    async run() {
      if (!(await reader.clientId())) return [];
      const credentials = await reader.credentials();
      const repositories = await reader.repositories();
      if (repositories.length === 0) return [];
      if (!credentials) {
        return repositories.map((repo) => ({
          subject: repo.name,
          ok: null,
          reason: 'OpenADLC does not hold the app’s private key, so it cannot ask where the app is installed',
        }));
      }
      const facts = await app().catch(() => null);
      return Promise.all(
        repositories.map(async (repo): Promise<CheckResult> => {
          try {
            if (reader.reach) return fromReach(repo, await reader.reach(repo.fullName));
            const installation = await installationOn(reader, credentials, repo.fullName);
            if (installation) {
              return { subject: repo.name, ok: true, fixed: `The OpenADLC app is installed on ${repo.fullName}`, facts: { installationId: installation.id } };
            }
            return {
              subject: repo.name,
              ok: false,
              severity: 'blocking',
              title: `The OpenADLC app is not installed on ${repo.fullName}`,
              detail:
                'OpenADLC cannot invite the crew, protect the branch or read the repository as the app until it is. ' +
                `Install it and choose ${repo.fullName}.`,
              action: facts
                ? { label: 'Install the app', url: `https://github.com/apps/${facts.slug}/installations/new` }
                : // Installing is its own step now; the app step only creates it.
                  { label: `Open ${stepNamed('install')}`, href: stepHref('install') },
            };
          } catch (error) {
            return { subject: repo.name, ok: null, reason: `GitHub did not say where the app is installed: ${messageOf(error)}` };
          }
        }),
      );
    },
  };

  const permissions: HealthCheck = {
    id: 'app-permissions',
    proves: 'The OpenADLC app holds every permission this version of OpenADLC asks for, and each installation has accepted them',
    how: 'reads the permissions GitHub says the app holds, and each installation’s, and compares them with the manifest',
    everyMinutes: 10,
    steps: ['app'],
    async run() {
      if (!(await reader.clientId())) return [];
      const credentials = await reader.credentials();
      if (!credentials) return [];
      // A GitHub that does not answer, here or for an installation below, is a
      // run that could not complete: thrown, so every row stands as it was.
      // Answered with unknowns for the permissions alone, the rows it did not
      // name were forgotten, an `accept:` card among them, which came back as
      // new and notified again within minutes.
      let facts: AppFacts | null;
      try {
        facts = await app();
      } catch (error) {
        throw new Error(`GitHub did not describe the app: ${messageOf(error)}`);
      }
      if (!facts) return [];

      const page = appPermissionsUrl(facts.slug, facts.organization);
      const missing = new Map(missingPermissions(facts.permissions).map((one) => [one.name, one]));

      // What the app holds is not yet what it can use: an installation keeps
      // the permissions it accepted until its owner accepts the new ones.
      const installations: { installation: Installation; organization: string | null; where: string }[] = [];
      for (const repo of await reader.repositories()) {
        const installation = await installationOn(reader, credentials, repo.fullName);
        if (!installation || installations.some((one) => one.installation.id === installation.id)) continue;
        const organization = installation.account?.type === 'Organization' ? installation.account.login : null;
        installations.push({ installation, organization, where: installation.account?.login ?? repo.fullName });
      }

      // Checks is what makes `review-gate` a check run only the app can set,
      // which matters only where GitHub holds a required check. On a private
      // repository whose plan refuses rulesets it holds none, so the red box
      // this raised on every free organization asked for something that
      // changed nothing. Asked only when Checks is what is missing.
      let enforcing: boolean | null | undefined;
      const checksChangeNothing = async (): Promise<boolean> => {
        if (enforcing === undefined) enforcing = (await reader.enforcesRules?.().catch(() => null)) ?? null;
        return enforcing === false;
      };

      const results: CheckResult[] = [];
      for (const name of Object.keys(MANIFEST_PERMISSIONS)) {
        const named = PERMISSION_NAMES[name] ?? { label: name, section: 'Repository' as const };
        const gap = missing.get(name);
        if (!gap) {
          results.push({ subject: name, ok: true, fixed: `The OpenADLC app has “${named.label}” now`, facts: { permissionsUrl: page } });
          continue;
        }
        if (name === OPTIONAL_PERMISSION) {
          // No row at all rather than a passing one: nothing was fixed, and a
          // row the check no longer returns is forgotten, card and all.
          if (await checksChangeNothing()) continue;
          results.push({
            subject: name,
            ok: false,
            severity: 'warning',
            title: `Optional: give the OpenADLC app “${named.label}”`,
            detail: checksNotice(
              page,
              installations.map(({ installation, organization, where }) => ({
                where,
                url: installationSettingsUrl(installation.id, organization),
              })),
              installations[0]?.organization ?? facts.organization,
            ),
            action: { label: 'Open the app’s permissions', url: page },
            facts: { permission: name, permissionsUrl: page },
          });
          continue;
        }
        const why = REQUIRED_APP_PERMISSIONS.find((one) => one.permission === named.label)?.why;
        results.push({
          subject: name,
          ok: false,
          // Without one of these one feature stops, and nothing else: said,
          // but not holding the app's step as undone.
          severity: ADVISORY_PERMISSIONS.has(name) ? 'warning' : 'blocking',
          title: `The OpenADLC app does not have “${named.label}”`,
          detail:
            `Add “${named.label}” on the app’s permissions page, under ${named.section} permissions, as ${accessInWords(gap.wanted)}` +
            `${why ? `: ${why}` : ''}. ` +
            (named.section === 'Account'
              ? 'Then reconnect each bot that commits, so its sign-in carries it.'
              : 'GitHub then asks whoever installed the app to accept it.'),
          action: { label: 'Open the app’s permissions', url: page },
          facts: { permission: name, permissionsUrl: page },
        });
      }

      // The events are on the same page, and the manifest decides them only
      // for an app it creates: one made before the bridge asked for
      // `deployment_status` was never sent one, so nothing was ever labelled
      // deployed and no promote moved a card to Done. Unlike a permission, a
      // subscription needs no installation to accept it.
      for (const event of WEBHOOK_EVENTS) {
        const named = WEBHOOK_EVENT_NAMES[event];
        if (facts.events.includes(event)) {
          results.push({ subject: `event:${event}`, ok: true, fixed: `The OpenADLC app is subscribed to “${named}” now` });
          continue;
        }
        results.push({
          subject: `event:${event}`,
          ok: false,
          severity: 'blocking',
          title: `The OpenADLC app is not subscribed to “${named}”`,
          detail:
            `On the app’s Permissions & events page, under Subscribe to events, tick “${named}” and save` +
            (event === 'deployment_status'
              ? '. It is offered once the app has “Deployments” as Read-only, under Repository permissions on the same page. Until it is ticked, no change is labelled deployed:testing or deployed:prod, and no promoted candidate’s card moves to Done.'
              : `. The bridge acts on it, and GitHub sends it only to an app that asks.`),
          action: { label: 'Open the app’s permissions and events', url: page },
          facts: { event, permissionsUrl: page },
        });
      }

      for (const { installation, organization, where } of installations) {
        const repositoryLevel = Object.fromEntries(
          Object.entries(MANIFEST_PERMISSIONS).filter(([name]) => {
            const section = PERMISSION_NAMES[name]?.section;
            // Account permissions are granted by each account that signs in,
            // not by an installation, and organization ones only exist on one.
            return section === 'Repository' || (section === 'Organization' && organization !== null);
          }),
        ) as Record<string, 'read' | 'write'>;
        const unaccepted: ReturnType<typeof missingPermissions> = [];
        let passedOver = false;
        for (const one of missingPermissions(installation.permissions, repositoryLevel)) {
          if (missing.has(one.name)) continue;
          if (one.name === OPTIONAL_PERMISSION && (await checksChangeNothing())) {
            passedOver = true;
            continue;
          }
          unaccepted.push(one);
        }
        // Waiting only on Checks, where it changes nothing: no row, as for the
        // permission itself. A passing one would say the installation accepted
        // something it has not.
        if (unaccepted.length === 0 && passedOver) continue;
        if (unaccepted.length === 0) {
          results.push({ subject: `accept:${installation.id}`, ok: true, fixed: `The installation on ${where} has accepted the app’s permissions` });
          continue;
        }
        const labels = unaccepted.map((one) => `“${PERMISSION_NAMES[one.name]?.label ?? one.name}”`).join(', ');
        const optional = unaccepted.every((one) => one.name === OPTIONAL_PERMISSION);
        results.push({
          subject: `accept:${installation.id}`,
          ok: false,
          severity: optional ? 'warning' : 'blocking',
          title: `The OpenADLC app’s new permissions are waiting to be accepted on ${where}`,
          detail:
            `The app asks for ${labels} now, and its installation on ${where} still works without them. ` +
            'Review the request on the installation’s page and accept it.' +
            (optional ? ' It is optional: `review-gate` then becomes a check run only the app can set.' : ''),
          action: { label: 'Review the request', url: installationSettingsUrl(installation.id, organization) },
          facts: { installationId: installation.id },
        });
      }
      return results;
    },
  };

  const deviceFlow: HealthCheck = {
    id: 'device-flow',
    proves: 'The OpenADLC app lets a bot sign in with a device code',
    how: 'asks GitHub for a device code, which it refuses when Device Flow is off; the code is never shown and expires on its own',
    everyMinutes: 60,
    steps: ['app'],
    async run() {
      const clientId = await reader.clientId();
      if (!clientId) return [];
      try {
        await reader.requestDeviceCode(clientId);
        return [{ ok: true, fixed: 'Device Flow is on in the OpenADLC app' }];
      } catch (error) {
        if (!(error instanceof DeviceAuthError)) {
          return [{ ok: null, reason: `GitHub could not be asked for a device code: ${messageOf(error)}` }];
        }
        const facts = await app().catch(() => null);
        if (error.code === 'device_flow_disabled') {
          return [
            {
              ok: false,
              severity: 'blocking',
              title: 'Device Flow is off in the OpenADLC app',
              detail:
                'No bot can sign in to GitHub until it is on. Tick Enable Device Flow on the app’s settings page and save.',
              action: settingsAction(facts, null),
            },
          ];
        }
        if (error.code === 'incorrect_client_credentials') {
          return [
            {
              ok: false,
              severity: 'blocking',
              title: 'GitHub does not recognise the OpenADLC app’s client id',
              detail: `The client id this install has is not an app GitHub knows, so no bot can sign in. Give it the right one on ${stepNamed('app')}.`,
              action: { label: `Open ${stepNamed('app')}`, href: stepHref('app') },
            },
          ];
        }
        return [{ ok: null, reason: `GitHub refused a device code: ${error.message}` }];
      }
    },
  };

  const tokenExpiry: HealthCheck = {
    id: 'token-expiry',
    proves: 'The OpenADLC app issues user tokens that expire, and no sign-in OpenADLC holds is one that never does',
    how: 'reads what GitHub issued when each seat and account signed in: an app whose tokens expire issues a refresh token with them',
    everyMinutes: 30,
    steps: ['app'],
    async run() {
      if (!(await reader.clientId())) return [];
      const held = await reader.tokenKinds();
      // Nothing has signed in yet, so nothing has been issued to judge by.
      if (held.length === 0) return [];
      if (!held.some((one) => one.kind === 'refresh')) {
        const facts = await app().catch(() => null);
        return [
          {
            ok: false,
            severity: 'warning',
            title: 'The OpenADLC app’s user tokens never expire',
            detail:
              'Each bot’s sign-in is a token that lasts until somebody revokes it. Tick Expire user authorization tokens ' +
              'on the app’s settings page, then reconnect each bot so it signs in with one that rotates.',
            action: settingsAction(facts, null),
          },
        ];
      }
      // One sign-in with a refresh token proves the app's setting, and only
      // that: GitHub does not convert a token it issued before, so every other
      // seat kept one that never expires while this said they all did.
      const lasting = [...new Set(held.filter((one) => one.kind === 'static').map((one) => one.who))];
      return [
        { ok: true, fixed: 'The OpenADLC app issues user tokens that expire now' },
        lasting.length === 0
          ? { subject: 'held', ok: true, fixed: 'Every sign-in OpenADLC holds is one that expires now' }
          : {
              subject: 'held',
              ok: false,
              severity: 'warning',
              title: `${lasting.length === 1 ? 'A sign-in' : `${lasting.length} sign-ins`} OpenADLC holds never ${lasting.length === 1 ? 'expires' : 'expire'}`,
              detail:
                `${lasting.join(', ')} still ${lasting.length === 1 ? 'holds a token' : 'hold tokens'} from before the app’s user tokens expired, ` +
                'which last until somebody revokes them. Reconnect each, so it signs in with one that rotates.',
              action: { label: 'Reconnect them', href: RECONNECT },
              facts: { lasting },
            },
      ];
    },
  };

  /**
   * Whether each task's token can be narrowed to its repository. Without the
   * app's client secret a task runs with its account's own token, and every
   * crew account is in every repository OpenADLC manages: a task in one can
   * read the others. Tasks still start, so it warns rather than blocks.
   *
   * Proved by its effect: a scoped token the broker made with the secret, or
   * GitHub accepting the secret when asked to check a bot's token.
   */
  const clientSecret: HealthCheck = {
    id: 'app-client-secret',
    proves: 'Each task’s GitHub token reaches only the task’s repository',
    how: 'reads whether the app’s client secret is stored, then whether GitHub made a scoped token with it or, before one is asked for, accepts it when checking a bot’s token',
    everyMinutes: 60,
    steps: ['app'],
    async run() {
      const clientId = await reader.clientId();
      if (!clientId || !reader.clientSecret) return [];
      const secret = await reader.clientSecret();
      const paste =
        'Generate a new client secret on the app’s settings page, under Client secrets, and paste it into Settings → GitHub → App client secret.';
      if (!secret) {
        const facts = await app().catch(() => null);
        return [
          {
            ok: false,
            severity: 'warning',
            title: 'Each task’s GitHub token reaches every repository its bot can',
            detail:
              'This install has no client secret for the OpenADLC app, so a task runs with its bot account’s own token, which reaches ' +
              `every repository OpenADLC manages, not only the task’s. ${paste}`,
            action: settingsAction(facts, null),
          },
        ];
      }
      const refusedCard = async (): Promise<CheckResult> => ({
        ok: false,
        severity: 'warning',
        title: 'GitHub refuses the OpenADLC app’s client secret',
        detail:
          'The client secret this install holds is not one GitHub accepts for the app, so each task runs with its bot account’s own token, ' +
          `which reaches every repository OpenADLC manages. ${paste}`,
        action: settingsAction(await app().catch(() => null), null),
      });
      const passed: CheckResult = { ok: true, fixed: 'Each task’s GitHub token reaches only the task’s repository' };
      const last = reader.lastScoped?.() ?? null;
      if (last?.ok) return [passed];
      if (last && !last.ok && last.secretRefused) return [await refusedCard()];
      try {
        const accepted = (await reader.secretAccepted?.(clientId, secret)) ?? null;
        if (accepted === true) return [passed];
        if (accepted === false) return [await refusedCard()];
        return [{ ok: null, reason: 'no bot has a GitHub token to check the client secret with yet' }];
      } catch (error) {
        return [{ ok: null, reason: `GitHub could not be asked to check the client secret: ${messageOf(error)}` }];
      }
    },
  };

  const lacks = async (permission: string): Promise<boolean> => {
    const facts = await app().catch(() => null);
    return facts ? missingPermissions(facts.permissions).some((one) => one.name === permission) : false;
  };

  // A crew bot's user token reaches what the installation covers that the
  // bot's account can see. On an organization whose bots are members, an
  // installation given all of its repositories turns that from the
  // repositories OpenADLC manages into every one the bots see through the
  // base permission or a team. Whether they do is not something OpenADLC can
  // read without organization permissions it does not ask for, so this warns
  // rather than blocks.
  const selection: HealthCheck = {
    id: 'app-selection',
    proves: 'No organization OpenADLC works in has given the app all of its repositories',
    how: 'asks GitHub, as the app, for each installation and whether it covers all of the account’s repositories or only those chosen',
    everyMinutes: 60,
    steps: ['install'],
    async run() {
      if (!reader.installations || !(await reader.clientId())) return [];
      const view = await reader.installations();
      if (!view.app) return [{ ok: null, reason: view.reason || 'GitHub did not say how the app is installed' }];
      return view.accounts
        .filter((account) => account.type === 'Organization' && account.installation && account.repositories.length > 0)
        .map((account): CheckResult => {
          const installation = account.installation!;
          if (installation.selection !== 'all') {
            return { subject: account.login, ok: true, fixed: `The OpenADLC app is given only chosen repositories on ${account.login}` };
          }
          return {
            subject: account.login,
            ok: false,
            severity: 'warning',
            title: `The OpenADLC app is given all of ${account.login}’s repositories`,
            detail:
              `A crew bot’s token reaches every repository the app is installed on that its account can see. Where the bots are members of ${account.login}, ` +
              'that is every repository they see through its base permission or a team, not only the ones OpenADLC manages. ' +
              'Choose Only select repositories on the installation’s page and pick the ones the crew works in. OpenADLC cannot see ' +
              `${account.login}’s membership settings, so this is a warning; set its base permission to No permission and keep the bots out of teams as well.`,
            action: { label: `Choose repositories on ${account.login}`, url: installation.settingsUrl ?? account.installUrl },
          };
        });
    },
  };

  return { installed, permissions, deviceFlow, tokenExpiry, clientSecret, selection, lacks };
}

/** A repository's row from what the app's reach says about it: the card names the step and links to where it is done. */
function fromReach(repo: { name: string; fullName: string }, reached: Reach): CheckResult {
  if (reached.state === 'reachable') {
    return { subject: repo.name, ok: true, fixed: `The OpenADLC app is installed on ${repo.fullName}`, facts: { installationId: reached.installationId } };
  }
  if (reached.state === 'unknown') return { subject: repo.name, ok: null, reason: reached.reason };
  return {
    subject: repo.name,
    ok: false,
    severity: 'blocking',
    title: cardTitle(repo.fullName, reached),
    detail:
      `${reached.title}. ${reached.detail} ` +
      `Until it can reach ${repo.fullName}, OpenADLC cannot invite the crew, protect the branch or read the repository as the app.`,
    action: reached.action,
    facts: { need: reached.need, subject: { repo: repo.name } },
  };
}

/** The card's first line names the repository: the board has one per repository, and `fleetadlc doctor` prints no more. */
function cardTitle(fullName: string, reached: Extract<Reach, { state: 'blocked' }>): string {
  switch (reached.need) {
    case 'install':
      return `The OpenADLC app is not installed on ${fullName}`;
    case 'transfer':
      return `The OpenADLC app belongs to another account, so it cannot be installed on ${fullName}`;
    case 'make-public':
      return `The OpenADLC app is private, so it cannot be installed on ${fullName}`;
    case 'add-repository':
      return `The OpenADLC app is installed on ${reached.account}, but not given ${fullName}`;
    case 'unsuspend':
      return `The OpenADLC app is suspended on ${reached.account}, where ${fullName} is`;
    case 'no-such-repository':
      return `GitHub has no repository ${fullName} that the OpenADLC app can see`;
    case 'allow-account':
      return `${fullName} is on ${reached.account}, an account this install does not work in`;
  }
}

/**
 * The one permission OpenADLC works without: with it, `review-gate` is a check
 * run only the app can set; without it, the same gate is a commit status.
 */
const OPTIONAL_PERMISSION = 'checks';

/**
 * What to do about a missing Checks permission, in the two places GitHub puts
 * it: the app's own permissions page, then each installation that has to
 * accept it, which GitHub asks separately. None before the app is installed
 * anywhere.
 */
export function checksNotice(
  permissionsUrl: string,
  installations: readonly { where: string; url: string }[],
  organization: string | null,
): string {
  const where = organization ? 'Organization settings → GitHub Apps' : 'Settings → Applications → Installed GitHub Apps';
  const review =
    installations.length === 0
      ? 'Review request'
      : installations.length === 1
        ? `[Review request](${installations[0]!.url})`
        : `Review request, on each installation: ${installations.map((one) => `[${one.where}](${one.url})`).join(', ')}`;
  return (
    'OpenADLC works without it. With it, `review-gate` becomes a check run only the app can set, so no bot’s token can ' +
    'mark a pull request as reviewed.\n\n' +
    `1. On the app’s settings, open [Permissions & events](${permissionsUrl}) → Repository permissions → Checks, ` +
    'choose **Read and write**, and **Save**.\n' +
    `2. GitHub then asks the installation to accept it: ${where} → the OpenADLC app → ${review}, and accept.`
  );
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
