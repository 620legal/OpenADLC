import { describe, expect, it } from 'vitest';
import type { SecurityAlert, SecurityAlertsView, SecurityFinding, SecurityFindingsView } from './api';
import {
  alertCount,
  filterAlerts,
  filterFindings,
  filtersFrom,
  findingCount,
  findingRequest,
  findingWhere,
  securityHref,
  securityRequest,
  severityPhrase,
} from './security';

describe('a severity filter in a sentence', () => {
  it('names the level as a severity, and none as no severity', () => {
    expect(severityPhrase('critical')).toBe('of critical severity');
    expect(severityPhrase('none')).toBe('with no severity');
  });
});

const high: SecurityAlert = {
  type: 'dependabot',
  repo: 'app',
  number: 3,
  title: 'Prototype pollution in lodash',
  severity: 'high',
  url: 'https://github.com/acme/app/security/dependabot/3',
  createdAt: '2026-11-01T00:00:00Z',
  where: 'lodash (npm)',
};
const quality: SecurityAlert = {
  type: 'code-scanning',
  repo: 'app',
  number: 8,
  title: 'Unused variable',
  severity: 'none',
  url: 'https://github.com/acme/app/security/code-scanning/8',
  createdAt: '2026-11-02T00:00:00Z',
  where: 'js/unused-local-variable',
  note: 'note',
};
const secret: SecurityAlert = {
  type: 'secret-scanning',
  repo: 'web',
  number: 2,
  title: 'GitHub Personal Access Token',
  severity: 'none',
  url: 'https://github.com/acme/web/security/secret-scanning/2',
  createdAt: '2026-11-03T00:00:00Z',
};

const VIEW: SecurityAlertsView = {
  readAt: '2026-11-26T00:00:00Z',
  repos: [
    {
      repo: 'app',
      fullName: 'acme/app',
      types: {
        dependabot: { state: 'read', alerts: [high], truncated: false },
        'code-scanning': { state: 'read', alerts: [quality], truncated: false },
        'secret-scanning': { state: 'off' },
      },
    },
    {
      repo: 'web',
      fullName: 'acme/web',
      types: {
        dependabot: { state: 'unreadable', permission: 'Dependabot alerts' },
        'code-scanning': { state: 'failed', reason: 'GitHub answered 502' },
        'secret-scanning': { state: 'read', alerts: [secret], truncated: false },
      },
    },
  ],
};

describe('the Security page’s filters', () => {
  it('are read from the URL, an unknown severity meaning every one', () => {
    expect(filtersFrom({ repo: 'app', severity: 'high' })).toEqual({ repo: 'app', severity: 'high' });
    expect(filtersFrom({ severity: 'HIGH' })).toEqual({ repo: null, severity: 'high' });
    expect(filtersFrom({ severity: 'severe' })).toEqual({ repo: null, severity: null });
    expect(filtersFrom({})).toEqual({ repo: null, severity: null });
  });

  it('are written back to the URL', () => {
    expect(securityHref({ repo: null, severity: null })).toBe('/security');
    expect(securityHref({ repo: 'app', severity: 'none' })).toBe('/security?repo=app&severity=none');
  });

  it('narrow to one repository and one exact severity, keeping every other state', () => {
    expect(alertCount(VIEW)).toBe(3);
    const app = filterAlerts(VIEW, { repo: 'app', severity: null });
    expect(app.repos.map((one) => one.repo)).toEqual(['app']);

    const none = filterAlerts(VIEW, { repo: null, severity: 'none' });
    expect(alertCount(none)).toBe(2);
    expect(none.repos[0]!.types.dependabot).toEqual({ state: 'read', alerts: [], truncated: false });
    expect(none.repos[1]!.types.dependabot).toEqual({ state: 'unreadable', permission: 'Dependabot alerts' });

    expect(alertCount(filterAlerts(VIEW, { repo: null, severity: 'high' }))).toBe(1);
  });
});

describe('the request File as task opens', () => {
  it('is a defect in the alert’s repository, titled from the alert, with its type, severity and link', () => {
    expect(securityRequest(high)).toEqual({
      repo: 'app',
      kind: 'defect',
      text: 'Fix the Dependabot alert “Prototype pollution in lodash” in app',
      details: 'Type: Dependabot alert #3\nSeverity: High\nWhere: lodash (npm)\nOn GitHub: https://github.com/acme/app/security/dependabot/3',
    });
    expect(securityRequest(quality).details).toContain("Severity: No severity (GitHub's rule severity: note)");
  });

  it('carries no secret, even if one were handed to it', () => {
    const leaked = { ...secret, secret: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } as SecurityAlert;
    const request = securityRequest(leaked);
    expect(JSON.stringify(request)).not.toContain('ghp_');
    expect(request.text).toBe('Fix the Secret scanning alert “GitHub Personal Access Token” in web');
  });
});

const blocker: SecurityFinding = {
  repo: 'app',
  pr: 7,
  prState: 'merged',
  reviewId: 901,
  reviewUrl: 'https://github.com/acme/app/pull/7#pullrequestreview-901',
  reviewedAt: '2026-11-20T10:00:00.000Z',
  severity: 'high',
  seatSeverity: 'blocker',
  summary: 'The webhook route skips the HMAC check',
  file: 'apps/bridge/src/webhooks.ts',
  line: 412,
};
const major: SecurityFinding = { ...blocker, severity: 'medium', seatSeverity: 'major', summary: 'Logs the token length', line: null };
const FINDINGS: SecurityFindingsView = {
  repos: [
    { repo: 'app', findings: [blocker, major] },
    { repo: 'web', findings: [{ ...major, repo: 'web' }] },
  ],
};

describe('the security seat’s findings, filtered as the alerts are', () => {
  it('keeps every finding with no filter', () => {
    expect(findingCount(filterFindings(FINDINGS, { repo: null, severity: null }))).toBe(3);
  });

  it('keeps blockers for high and drops majors, and keeps none for critical or no severity', () => {
    const high = filterFindings(FINDINGS, { repo: null, severity: 'high' });
    expect(high.repos.map((one) => one.findings.map((finding) => finding.seatSeverity))).toEqual([['blocker'], []]);
    expect(findingCount(filterFindings(FINDINGS, { repo: null, severity: 'critical' }))).toBe(0);
    expect(findingCount(filterFindings(FINDINGS, { repo: null, severity: 'none' }))).toBe(0);
  });

  it('narrows to one repository', () => {
    expect(filterFindings(FINDINGS, { repo: 'web', severity: null }).repos.map((one) => one.repo)).toEqual(['web']);
  });
});

describe('the request File as task opens for a finding', () => {
  it('is a defect in the finding’s repository, with its severity, place, pull request and review', () => {
    expect(findingRequest(blocker)).toEqual({
      repo: 'app',
      kind: 'defect',
      text: 'Fix the security review finding “The webhook route skips the HMAC check” in app',
      details:
        'Severity: high (seat: blocker)\nWhere: apps/bridge/src/webhooks.ts:412\nFrom: pull request #7 (merged)\nReview: https://github.com/acme/app/pull/7#pullrequestreview-901',
    });
    expect(findingWhere(major)).toBe('apps/bridge/src/webhooks.ts');
  });
});
