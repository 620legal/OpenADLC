import type { AlertSeverity, AlertType, AlertTypeState, SecurityAlert, SecurityAlertsView } from './api';

/**
 * The Security page's pure parts: its filters, kept in the URL as Insights
 * keeps its own, and the request File as task opens (#377, docs/adr/0086).
 */

export const SEVERITIES: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'none'];
export const ALERT_TYPES: readonly AlertType[] = ['dependabot', 'code-scanning', 'secret-scanning'];

export const TYPE_LABELS: Record<AlertType, string> = {
  dependabot: 'Dependabot',
  'code-scanning': 'Code scanning',
  'secret-scanning': 'Secret scanning',
};

export const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No severity',
};

export interface SecurityFilters {
  repo: string | null;
  severity: AlertSeverity | null;
}

/** The filters as the URL says them: an unknown severity, or none, is every severity. */
export function filtersFrom(params: { repo?: string; severity?: string }): SecurityFilters {
  const severity = params.severity?.trim().toLowerCase() ?? '';
  return {
    repo: params.repo?.trim() || null,
    severity: (SEVERITIES as readonly string[]).includes(severity) ? (severity as AlertSeverity) : null,
  };
}

/** The page's address with these filters. */
export function securityHref(filters: SecurityFilters): string {
  const params = new URLSearchParams();
  if (filters.repo) params.set('repo', filters.repo);
  if (filters.severity) params.set('severity', filters.severity);
  const query = params.toString();
  return query ? `/security?${query}` : '/security';
}

/**
 * The view narrowed to one repository and one severity. A type that was read
 * keeps its state with only the alerts of that severity; every other state
 * stays as it was, since it says something about the repository, not an alert.
 */
export function filterAlerts(view: SecurityAlertsView, filters: SecurityFilters): SecurityAlertsView {
  const repos = view.repos
    .filter((one) => !filters.repo || one.repo === filters.repo || one.fullName === filters.repo)
    .map((one) => {
      const types = {} as Record<AlertType, AlertTypeState>;
      for (const type of ALERT_TYPES) {
        const state = one.types[type];
        types[type] =
          state && state.state === 'read' && filters.severity
            ? { ...state, alerts: state.alerts.filter((alert) => alert.severity === filters.severity) }
            : state;
      }
      return { ...one, types };
    });
  return { ...view, repos };
}

/** How many alerts the view holds, across every repository and type. */
export function alertCount(view: SecurityAlertsView): number {
  return view.repos.reduce(
    (sum, one) => sum + ALERT_TYPES.reduce((inner, type) => inner + (one.types[type]?.state === 'read' ? (one.types[type] as { alerts: SecurityAlert[] }).alerts.length : 0), 0),
    0,
  );
}

/**
 * What File as task fills the new-request dialog with. Read from the alert's
 * own fields alone, which the bridge built without the secret, so no secret
 * can be in it.
 */
export function securityRequest(alert: SecurityAlert): { repo: string; kind: 'defect'; text: string; details: string } {
  const label = TYPE_LABELS[alert.type];
  const lines = [
    `Type: ${label} alert #${alert.number}`,
    `Severity: ${SEVERITY_LABELS[alert.severity]}${alert.note ? ` (GitHub's rule severity: ${alert.note})` : ''}`,
    ...(alert.where ? [`Where: ${alert.where}`] : []),
    `On GitHub: ${alert.url}`,
  ];
  return {
    repo: alert.repo,
    kind: 'defect',
    text: `Fix the ${label} alert “${alert.title}” in ${alert.repo}`,
    details: lines.join('\n'),
  };
}
