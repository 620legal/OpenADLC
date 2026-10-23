import { RELEASE_EVENT, WEBHOOK_EVENT_NAMES, shipsByRelease, type DeliveryRules } from '@openadlc/shared';
import type { CheckResult, HealthCheck } from '../types.js';

/** The check's id, which Settings → Repositories reads its rows by. */
export const SHIPS_BY_RELEASE_CHECK = 'ships-by-release';

export interface ShipsByReleaseReader {
  repos(): Promise<{ name: string; fullName: string }[]>;
  /** The repository's delivery rules, as the bridge reads them; null when they could not be read. */
  rules(repo: { name: string; fullName: string }): Promise<DeliveryRules | null>;
  /**
   * The events GitHub says the app is subscribed to, and the page where they
   * are ticked (`AppChecks.events`); null when OpenADLC does not hold the
   * app's key. Throws when GitHub could not be asked.
   */
  appEvents(): Promise<{ events: string[]; page: string } | null>;
}

/**
 * The app is subscribed to Release events wherever a repository ships by
 * release (`testing.on: release`).
 *
 * Such a repository's merged cards reach Done when a published release
 * contains their merge, and the `release` delivery is what says one was
 * published. GitHub sends it only to an app that asks, and an app made from
 * a manifest before OpenADLC asked for it never does. The deploy sweep lists
 * the repository's releases as well, so nothing is lost without it, only
 * late: a warning, and only where a repository ships that way. Read from the
 * events GitHub says the app has, as `app-permissions` reads the rest.
 */
export function shipsByReleaseCheck(reader: ShipsByReleaseReader): HealthCheck {
  const named = WEBHOOK_EVENT_NAMES[RELEASE_EVENT];
  return {
    id: SHIPS_BY_RELEASE_CHECK,
    proves: `The OpenADLC app is subscribed to “${named}” events wherever a repository ships by release`,
    how: 'reads the events GitHub says the app is subscribed to, for each repository whose delivery rules say testing.on: release',
    everyMinutes: 10,
    steps: [],
    async run() {
      const results: CheckResult[] = [];
      const shipping: { name: string; fullName: string }[] = [];
      for (const repo of await reader.repos()) {
        const rules = await reader.rules(repo).catch(() => null);
        if (!rules) {
          results.push({ subject: repo.fullName, ok: null, reason: 'its delivery rules could not be read, so whether it ships by release is not known' });
          continue;
        }
        if (shipsByRelease(rules)) shipping.push(repo);
      }
      if (shipping.length === 0) return results;

      let app: { events: string[]; page: string } | null;
      try {
        app = await reader.appEvents();
      } catch (error) {
        const why = `GitHub did not describe the app: ${error instanceof Error ? error.message : String(error)}`;
        return [...results, ...shipping.map((repo): CheckResult => ({ subject: repo.fullName, ok: null, reason: why }))];
      }
      if (!app) {
        const why = 'OpenADLC does not hold the app’s private key, so it cannot ask which events the app is subscribed to';
        return [...results, ...shipping.map((repo): CheckResult => ({ subject: repo.fullName, ok: null, reason: why }))];
      }
      const page = app.page;
      for (const repo of shipping) {
        if (app.events.includes(RELEASE_EVENT)) {
          results.push({ subject: repo.fullName, ok: true, fixed: `The OpenADLC app is subscribed to “${named}” now, which ${repo.fullName} ships by` });
          continue;
        }
        results.push({
          subject: repo.fullName,
          ok: false,
          severity: 'warning',
          title: `The OpenADLC app is not subscribed to “${named}”, and ${repo.fullName} ships by release`,
          detail:
            `${repo.fullName}’s cards reach Done when a published release contains their merge, and GitHub says when one is published ` +
            `only to an app subscribed to “${named}”. On the app’s Permissions & events page, under Subscribe to events, tick “${named}” and save. ` +
            'Until then the deploy sweep finds each release by listing the repository’s releases, so its cards reach Done at the next sweep rather than as it is published.',
          action: { label: 'Open the app’s permissions and events', url: page },
          facts: { event: RELEASE_EVENT, permissionsUrl: page },
        });
      }
      return results;
    },
  };
}

/** Whether the app is subscribed to Release events, as Settings → Repositories says it of a repository that ships by release. */
export interface ReleaseEvents {
  subscribed: boolean;
  /** Where they are ticked, when they are not. */
  url: string | null;
}

/**
 * What the check last said of a repository, for Settings: null before it has
 * answered, for a repository that does not ship by release, or when GitHub
 * could not be asked.
 */
export function releaseEventsOf(
  rows: readonly { checkId: string; subject: string | null; state: string; action?: unknown; facts?: Record<string, unknown> }[],
  fullName: string,
): ReleaseEvents | null {
  const row = rows.find((one) => one.checkId === SHIPS_BY_RELEASE_CHECK && one.subject === fullName);
  if (!row || (row.state !== 'ok' && row.state !== 'failing')) return null;
  if (row.state === 'ok') return { subscribed: true, url: null };
  const action = row.action as { url?: unknown } | null | undefined;
  const url = typeof action?.url === 'string' ? action.url : typeof row.facts?.permissionsUrl === 'string' ? row.facts.permissionsUrl : null;
  return { subscribed: false, url };
}
