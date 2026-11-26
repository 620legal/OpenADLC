import type { AlertSeverity, AlertType, AlertTypeState, SecurityAlert, SecurityAlertsView, SecurityFinding, SecurityFindingsView } from './api';

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

/** A severity filter as the end of a sentence about alerts: "of critical severity", or "with no severity". */
export function severityPhrase(severity: AlertSeverity): string {
  return severity === 'none' ? 'with no severity' : `of ${SEVERITY_LABELS[severity].toLowerCase()} severity`;
}

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

/**
 * The security seat's findings narrowed as the alerts are, by the same exact
 * match: a finding is only ever high, medium or low, so `critical` and `none`
 * keep none of them (#378, docs/adr/0087).
 */
export function filterFindings(view: SecurityFindingsView, filters: SecurityFilters): SecurityFindingsView {
  return {
    repos: view.repos
      .filter((one) => !filters.repo || one.repo === filters.repo)
      .map((one) => ({ ...one, findings: filters.severity ? one.findings.filter((finding) => finding.severity === filters.severity) : one.findings })),
  };
}

/** How many findings the view holds, across every repository. */
export function findingCount(view: SecurityFindingsView): number {
  return view.repos.reduce((sum, one) => sum + one.findings.length, 0);
}

/** Where a finding is: its file, and its line when the seat gave one. */
export function findingWhere(finding: SecurityFinding): string {
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

/** What File as task fills the new-request dialog with for a finding. */
export function findingRequest(finding: SecurityFinding): { repo: string; kind: 'defect'; text: string; details: string } {
  return {
    repo: finding.repo,
    kind: 'defect',
    text: `Fix the security review finding “${finding.summary}” in ${finding.repo}`,
    details: [
      `Severity: ${finding.severity} (seat: ${finding.seatSeverity})`,
      `Where: ${findingWhere(finding)}`,
      `From: pull request #${finding.pr} (${finding.prState})`,
      `Review: ${finding.reviewUrl}`,
    ].join('\n'),
  };
}
