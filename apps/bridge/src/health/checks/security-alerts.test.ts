import { GitHubApiError } from '@openadlc/github';
import { describe, expect, it } from 'vitest';
import type { SecurityReads } from '../../security-alerts.js';
import { defaultChecks } from '../index.js';
import { securityAlertsCheck } from './security-alerts.js';

/** A GitHub whose answer for each type can be changed between runs, recording every read. */
function github() {
  const answers: Record<string, Error | null> = { dependabot: null, 'code-scanning': null, 'secret-scanning': null };
  const calls: { method: 'GET'; path: string }[] = [];
  const reads: SecurityReads = {
    repositories: async () => [{ name: 'app', fullName: 'acme/app' }],
    tokenFor: async () => 'token',
    getPaged: async (_token, path) => {
      calls.push({ method: 'GET', path });
      const type = Object.keys(answers).find((one) => path.includes(`/${one}/`))!;
      const answer = answers[type];
      if (answer) throw answer;
      return { items: [], truncated: false };
    },
  };
  const check = securityAlertsCheck({
    reads,
    app: async () => ({ slug: 'openadlc-acme', organization: 'acme' }),
    installationUrl: async () => 'https://github.com/organizations/acme/settings/installations/42',
  });
  return { answers, calls, check };
}

const NOT_ACCESSIBLE = new GitHubApiError(403, '/repos/acme/app/code-scanning/alerts', '{"message":"Resource not accessible by integration"}', 'security_events=read');

describe('the security-alerts check', () => {
  it('warns while a type is unreadable, naming the permission, and clears once a read succeeds', async () => {
    const { answers, calls, check } = github();
    answers['code-scanning'] = NOT_ACCESSIBLE;

    const failing = await check.run(new Date());
    const row = failing.find((one) => one.subject === 'code-scanning')!;
    expect(row).toMatchObject({ ok: false, severity: 'warning', title: 'The OpenADLC app cannot read “Code scanning alerts”' });
    if (row.ok !== false) throw new Error('expected a failing row');
    expect(row.detail).toContain('Repository permissions');
    expect(row.detail).toContain('Read-only');
    expect(row.detail).toContain('acme/app');
    expect(row.detail).toContain('https://github.com/organizations/acme/settings/installations/42');
    expect(row.action).toEqual({ label: 'Open the app’s permissions', url: 'https://github.com/organizations/acme/settings/apps/openadlc-acme/permissions' });
    expect(failing.find((one) => one.subject === 'dependabot')).toMatchObject({ ok: true });
    expect(calls.every((call) => call.method === 'GET' && call.path.includes('per_page=1'))).toBe(true);

    // Feature switched off: GitHub checked the permission before saying so.
    answers['code-scanning'] = new GitHubApiError(403, '/x', '{"message":"Code scanning is not enabled for this repository."}', 'security_events=read');
    expect((await check.run(new Date())).find((one) => one.subject === 'code-scanning')).toEqual({
      subject: 'code-scanning',
      ok: true,
      fixed: 'The OpenADLC app can read “Code scanning alerts” now',
    });

    answers['code-scanning'] = null;
    expect((await check.run(new Date())).find((one) => one.subject === 'code-scanning')).toMatchObject({ ok: true });
  });

  it('throws when GitHub does not answer, so the rows stand as they were', async () => {
    const { answers, check } = github();
    answers.dependabot = new GitHubApiError(502, '/x', 'Bad gateway');
    await expect(check.run(new Date())).rejects.toThrow(/Dependabot alerts/);
  });

  it('probes repositories a few at a time rather than one read after another', async () => {
    let inFlight = 0;
    let most = 0;
    const repositories = Array.from({ length: 10 }, (_, index) => ({ name: `r${index}`, fullName: `acme/r${index}` }));
    const check = securityAlertsCheck({
      reads: {
        repositories: async () => repositories,
        tokenFor: async () => 'token',
        getPaged: async () => {
          most = Math.max(most, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight--;
          return { items: [], truncated: false };
        },
      },
      app: async () => ({ slug: 'openadlc-acme', organization: 'acme' }),
    });
    const results = await check.run(new Date());
    expect(results.map((one) => one.ok)).toEqual([true, true, true]);
    // Four repositories at once, each with its three types together.
    expect(most).toBe(12);
  });

  it('says nothing while there is no app to act as', async () => {
    const check = securityAlertsCheck({
      reads: { repositories: async () => [{ name: 'app', fullName: 'acme/app' }], tokenFor: async () => 'token', getPaged: async () => ({ items: [], truncated: false }) },
      app: async () => null,
    });
    expect(await check.run(new Date())).toEqual([]);
  });

  it('answers the app step, and is registered with the bridge’s checks', () => {
    const { check } = github();
    expect(check.steps).toEqual(['app']);
    const checks = defaultChecks({
      config: { automationBot: null } as never,
      actors: {} as never,
      hostd: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    expect(checks.some((one) => one.id === 'security-alerts')).toBe(true);
  });
});
