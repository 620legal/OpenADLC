import { appPermissionsUrl } from '@openadlc/shared';
import { ALERT_PERMISSIONS, ALERT_TYPES, CONCURRENCY, inBatches, probeType, type AlertType, type SecurityReads } from '../../security-alerts.js';
import type { CheckResult, HealthCheck } from '../types.js';

/**
 * Whether the app can read each type of security alert the Security page
 * lists, proved by a real read (docs/adr/0086).
 *
 * The three permissions are outside `MANIFEST_PERMISSIONS`, so
 * `app-permissions` never raises a blocking card for an optional page. An app
 * made before them lacks them, and an installation keeps answering "Resource
 * not accessible by integration" until its owner accepts them even after
 * they are added; a read is the one thing that says both are done, so the
 * card clears on the first read that succeeds, whichever was missing.
 */

export interface SecurityAlertsCheckDeps {
  reads: SecurityReads;
  /** The app's slug and owning organization, or null while there is no app OpenADLC can act as. */
  app(): Promise<{ slug: string; organization: string | null } | null>;
  /** The settings page of the installation covering a repository, where its owner accepts a new permission; null when unknown. */
  installationUrl?(fullName: string): Promise<string | null>;
}

export function securityAlertsCheck(deps: SecurityAlertsCheckDeps): HealthCheck {
  return {
    id: 'security-alerts',
    proves: 'The OpenADLC app can read each repository’s Dependabot, code-scanning and secret-scanning alerts for the Security page',
    how: 'reads one open alert of each type on each managed repository the app is installed on, as the app',
    everyMinutes: 15,
    // A warning does not hold the app's step undone; it answers it as well.
    steps: ['app'],
    async run() {
      const app = await deps.app();
      if (!app) return [];
      const repositories = await deps.reads.repositories();
      if (repositories.length === 0) return [];
      const page = appPermissionsUrl(app.slug, app.organization);

      // Repositories a few at a time and a repository's types together, as
      // the page reads them: one at a time, a run took repositories × 3 round
      // trips, which grows past a check's interval on a large install.
      const probed = await inBatches(repositories, CONCURRENCY, (repo) =>
        Promise.all(ALERT_TYPES.map(async (type) => ({ repo, type, state: await probeType(deps.reads, repo, type) }))),
      );

      const results: CheckResult[] = [];
      for (const type of ALERT_TYPES) {
        const { label } = ALERT_PERMISSIONS[type];
        const unreadable: string[] = [];
        for (const { repo, state } of probed.flat().filter((one) => one.type === type)) {
          // GitHub not answering is a run that could not complete: thrown, so
          // the rows stand as they were rather than clearing a card unproved.
          if (state.state === 'failed') throw new Error(`GitHub did not answer for ${label} on ${repo.fullName}: ${state.reason}`);
          if (state.state === 'unreadable') unreadable.push(repo.fullName);
          // `off` counts as readable: GitHub checked the permission before it
          // said the feature is switched off.
        }
        results.push(unreadable.length === 0 ? passing(type, label) : await failing(deps, type, label, unreadable, page));
      }
      return results;
    },
  };
}

function passing(type: AlertType, label: string): CheckResult {
  return { subject: type, ok: true, fixed: `The OpenADLC app can read “${label}” now` };
}

async function failing(deps: SecurityAlertsCheckDeps, type: AlertType, label: string, repos: string[], page: string): Promise<CheckResult> {
  const accept = await deps.installationUrl?.(repos[0]!).catch(() => null);
  return {
    subject: type,
    ok: false,
    severity: 'warning',
    title: `The OpenADLC app cannot read “${label}”`,
    detail:
      `Add “${label}” on the app’s permissions page, under Repository permissions, as Read-only, so the Security page can list them. ` +
      `If the app already has it, whoever installed the app accepts it on the installation’s page${accept ? ` (${accept})` : ''}. ` +
      `GitHub refused the read on ${repos.join(', ')}.`,
    action: { label: 'Open the app’s permissions', url: page },
    facts: { permission: ALERT_PERMISSIONS[type].key, permissionsUrl: page, repositories: repos, ...(accept ? { installationUrl: accept } : {}) },
  };
}
