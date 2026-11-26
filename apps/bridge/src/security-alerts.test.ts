import { GitHubApiError } from '@openadlc/github';
import { describe, expect, it } from 'vitest';
import { SecurityAlertsReader, alertsPath, classify, probeType, severityOf, toAlert, type SecurityReads } from './security-alerts.js';

const LEAKED = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const DEPENDABOT = [
  {
    number: 3,
    state: 'open',
    html_url: 'https://github.com/acme/app/security/dependabot/3',
    created_at: '2026-11-01T00:00:00Z',
    dependency: { package: { name: 'lodash', ecosystem: 'npm' } },
    security_advisory: { summary: 'Prototype pollution in lodash', severity: 'high', ghsa_id: 'GHSA-x' },
  },
  {
    number: 4,
    html_url: 'https://github.com/acme/app/security/dependabot/4',
    created_at: '2026-11-02T00:00:00Z',
    security_advisory: { summary: 'Something odd', severity: 'unheard-of' },
  },
];

const CODE_SCANNING = [
  {
    number: 7,
    html_url: 'https://github.com/acme/app/security/code-scanning/7',
    created_at: '2026-11-03T00:00:00Z',
    rule: { id: 'js/sql-injection', description: 'Database query built from user-controlled sources', severity: 'error', security_severity_level: 'critical' },
    most_recent_instance: { location: { path: 'src/db.ts' } },
  },
  {
    number: 8,
    html_url: 'https://github.com/acme/app/security/code-scanning/8',
    created_at: '2026-11-04T00:00:00Z',
    rule: { id: 'js/unused-local-variable', description: 'Unused variable', severity: 'note' },
  },
];

const SECRET_SCANNING = [
  {
    number: 2,
    html_url: 'https://github.com/acme/app/security/secret-scanning/2',
    created_at: '2026-11-05T00:00:00Z',
    secret_type: 'github_personal_access_token',
    secret_type_display_name: 'GitHub Personal Access Token',
    secret: LEAKED,
  },
];

const refused = (status: number, message: string, accepted: string | null = null) =>
  new GitHubApiError(status, '/repos/acme/app/x', JSON.stringify({ message }), accepted);

type Answer = unknown[] | Error;

/** A GitHub whose answer per path suffix is given, recording every read. */
function fakeReads(answers: Partial<Record<'dependabot' | 'code-scanning' | 'secret-scanning', Answer>>, options: { installed?: string[] } = {}) {
  const calls: { method: 'GET'; path: string; token: string }[] = [];
  const reads: SecurityReads = {
    repositories: async () => [
      { name: 'app', fullName: 'acme/app' },
      { name: 'web', fullName: 'acme/web' },
    ],
    tokenFor: async (fullName) => ((options.installed ?? ['acme/app', 'acme/web']).includes(fullName) ? `token-${fullName}` : null),
    getPaged: async <T,>(token: string, path: string) => {
      calls.push({ method: 'GET', path, token });
      const type = (['dependabot', 'code-scanning', 'secret-scanning'] as const).find((one) => path.includes(`/${one}/`))!;
      const answer = answers[type] ?? [];
      if (answer instanceof Error) throw answer;
      return { items: answer as T[], truncated: false };
    },
  };
  return { reads, calls };
}

describe('the severity scale', () => {
  it('keeps GitHub’s four words, reads moderate as medium, and anything else as none', () => {
    expect(['critical', 'high', 'medium', 'low'].map(severityOf)).toEqual(['critical', 'high', 'medium', 'low']);
    expect(severityOf('moderate')).toBe('medium');
    expect(severityOf('HIGH')).toBe('high');
    expect(severityOf('unheard-of')).toBe('none');
    expect(severityOf(undefined)).toBe('none');
  });
});

describe('an alert as the page shows it', () => {
  it('takes Dependabot’s advisory, package and severity', () => {
    expect(toAlert('dependabot', 'app', DEPENDABOT[0])).toEqual({
      type: 'dependabot',
      repo: 'app',
      number: 3,
      title: 'Prototype pollution in lodash',
      severity: 'high',
      url: 'https://github.com/acme/app/security/dependabot/3',
      createdAt: '2026-11-01T00:00:00Z',
      where: 'lodash (npm)',
    });
    expect(toAlert('dependabot', 'app', DEPENDABOT[1])?.severity).toBe('none');
  });

  it('uses code scanning’s security severity, and keeps its own severity as a note when there is none', () => {
    expect(toAlert('code-scanning', 'app', CODE_SCANNING[0])).toMatchObject({ severity: 'critical', where: 'js/sql-injection · src/db.ts' });
    expect(toAlert('code-scanning', 'app', CODE_SCANNING[0])?.note).toBeUndefined();
    expect(toAlert('code-scanning', 'app', CODE_SCANNING[1])).toMatchObject({ severity: 'none', note: 'note', title: 'Unused variable' });
  });

  it('gives a secret only its type’s name and link, with no severity', () => {
    const alert = toAlert('secret-scanning', 'app', SECRET_SCANNING[0]);
    expect(alert).toEqual({
      type: 'secret-scanning',
      repo: 'app',
      number: 2,
      title: 'GitHub Personal Access Token',
      severity: 'none',
      url: 'https://github.com/acme/app/security/secret-scanning/2',
      createdAt: '2026-11-05T00:00:00Z',
    });
  });

  it('drops an entry whose link is not GitHub’s', () => {
    expect(toAlert('dependabot', 'app', { ...DEPENDABOT[0], html_url: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('what a refusal means', () => {
  it('reads only GitHub’s “not accessible by integration” as a missing permission', () => {
    expect(classify('code-scanning', refused(403, 'Resource not accessible by integration', 'security_events=read'))).toEqual({
      state: 'unreadable',
      permission: 'Code scanning alerts',
    });
  });

  it('reads a switched-off feature as off, even with the accepted-permissions header', () => {
    expect(classify('dependabot', refused(403, 'Dependabot alerts are disabled for this repository.', 'vulnerability_alerts=read'))).toEqual({ state: 'off' });
    expect(classify('secret-scanning', refused(404, 'Secret scanning is disabled on this repository.'))).toEqual({ state: 'off' });
  });

  it('reads anything else as a failure of that one type', () => {
    expect(classify('dependabot', refused(502, 'Bad gateway'))).toEqual({ state: 'failed', reason: 'GitHub answered 502' });
    expect(classify('dependabot', new Error('socket hang up'))).toMatchObject({ state: 'failed' });
  });
});

describe('the Security page’s reader', () => {
  it('reads all three types for an admin, with GETs only, and never lets the secret out', async () => {
    const { reads, calls } = fakeReads({ dependabot: DEPENDABOT, 'code-scanning': CODE_SCANNING, 'secret-scanning': SECRET_SCANNING });
    const view = await new SecurityAlertsReader(reads).view({ role: 'admin' });

    expect(view.repos.map((one) => one.repo)).toEqual(['app', 'web']);
    const app = view.repos[0]!.types;
    expect(app.dependabot).toMatchObject({ state: 'read', truncated: false });
    expect(app['secret-scanning']).toMatchObject({ state: 'read', alerts: [{ title: 'GitHub Personal Access Token' }] });

    const answer = JSON.stringify(view);
    expect(answer).not.toContain(LEAKED);
    expect(answer).not.toContain('"secret"');
    expect(answer).not.toContain('secret_type');
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.filter((call) => call.path.includes('/secret-scanning/')).every((call) => call.path.includes('hide_secret=true'))).toBe(true);
    // Each repository with its own token.
    expect(calls.find((call) => call.path.startsWith('/repos/acme/web/'))?.token).toBe('token-acme/web');
  });

  it('never asks for secret scanning for a user, and says it is for admins', async () => {
    const { reads, calls } = fakeReads({ dependabot: DEPENDABOT, 'secret-scanning': SECRET_SCANNING });
    const view = await new SecurityAlertsReader(reads).view({ role: 'user' });

    for (const repo of view.repos) expect(repo.types['secret-scanning']).toEqual({ state: 'admins-only' });
    expect(view.repos[0]!.types.dependabot).toMatchObject({ state: 'read' });
    expect(calls.some((call) => call.path.includes('secret-scanning'))).toBe(false);
  });

  it('keeps an admin’s secret answer out of a user’s view that follows it', async () => {
    const { reads } = fakeReads({ 'secret-scanning': SECRET_SCANNING });
    const reader = new SecurityAlertsReader(reads);
    await reader.view({ role: 'admin' });
    const user = await reader.view({ role: 'user' });
    expect(user.repos[0]!.types['secret-scanning']).toEqual({ state: 'admins-only' });
    expect(JSON.stringify(user)).not.toContain('Personal Access Token');
  });

  it('marks one type unreadable, off or failed without failing the rest of the page', async () => {
    const { reads } = fakeReads({
      dependabot: refused(403, 'Dependabot alerts are disabled for this repository.', 'vulnerability_alerts=read'),
      'code-scanning': refused(403, 'Resource not accessible by integration'),
      'secret-scanning': refused(502, 'Bad gateway'),
    });
    const view = await new SecurityAlertsReader(reads).view({ role: 'admin' });
    expect(view.repos[0]!.types).toEqual({
      dependabot: { state: 'off' },
      'code-scanning': { state: 'unreadable', permission: 'Code scanning alerts' },
      'secret-scanning': { state: 'failed', reason: 'GitHub answered 502' },
    });
  });

  it('says where the app is not installed, and reads only the repository asked for', async () => {
    const { reads, calls } = fakeReads({ dependabot: DEPENDABOT }, { installed: ['acme/app'] });
    const reader = new SecurityAlertsReader(reads);
    const web = await reader.view({ role: 'admin', repo: 'web' });
    expect(web.repos).toHaveLength(1);
    expect(web.repos[0]!.types).toEqual({
      dependabot: { state: 'not-installed' },
      'code-scanning': { state: 'not-installed' },
      'secret-scanning': { state: 'not-installed' },
    });
    expect(calls).toHaveLength(0);
  });

  it('answers from memory for a minute, then reads again', async () => {
    let at = 1_000_000;
    const { reads, calls } = fakeReads({ dependabot: DEPENDABOT });
    const reader = new SecurityAlertsReader(reads, { now: () => at });
    await reader.view({ role: 'user', repo: 'app' });
    await reader.view({ role: 'user', repo: 'app' });
    expect(calls).toHaveLength(2);
    at += 61_000;
    await reader.view({ role: 'user', repo: 'app' });
    expect(calls).toHaveLength(4);
  });

  it('does not keep a failed read', async () => {
    const { reads, calls } = fakeReads({ dependabot: refused(500, 'boom') });
    const reader = new SecurityAlertsReader(reads);
    await reader.view({ role: 'user', repo: 'app' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reader.view({ role: 'user', repo: 'app' });
    expect(calls.filter((call) => call.path.includes('dependabot'))).toHaveLength(2);
  });
});

describe('a probe of one type', () => {
  it('reads one alert of the same endpoint and classifies it as the page does', async () => {
    const { reads, calls } = fakeReads({ 'code-scanning': refused(403, 'Resource not accessible by integration') });
    expect(await probeType(reads, { name: 'app', fullName: 'acme/app' }, 'code-scanning')).toEqual({ state: 'unreadable', permission: 'Code scanning alerts' });
    expect(calls).toEqual([{ method: 'GET', path: alertsPath('code-scanning', 'acme/app', 1), token: 'token-acme/app' }]);
    expect(await probeType(reads, { name: 'app', fullName: 'acme/app' }, 'dependabot')).toMatchObject({ state: 'read' });
  });
});
