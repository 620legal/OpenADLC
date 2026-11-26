import { describe, expect, it, vi } from 'vitest';
import type { RuleApi } from '@openadlc/github';
import { RELEASE_TAG_RULES_CHECK, judgeReleaseTag, likelyNextTag, releaseTagRulesCheck, type ReleaseTagRulesReader } from './release-tag-rules.js';

const RULESET = {
  id: 7,
  name: 'release tags',
  target: 'tag',
  enforcement: 'active',
  source_type: 'Repository',
  source: 'acme/app',
  conditions: { ref_name: { include: ['refs/tags/v1.2.*'], exclude: [] as string[] } },
  rules: [{ type: 'creation' }],
  current_user_can_bypass: 'never' as string | undefined,
};

/** GitHub as the app reads a repository's rulesets: the list without the bypass, each by id with it. */
function rulesetsApi(rulesets: Record<string, unknown>[]): RuleApi {
  return {
    async request<T>(_method: string, path: string): Promise<T> {
      if (path.includes('/rulesets?')) return rulesets.map(({ current_user_can_bypass: _b, ...entry }) => entry) as T;
      return rulesets.find((one) => path.endsWith(`/rulesets/${String(one.id)}`)) as T;
    },
  };
}

function check(options: { releasing?: { fullName: string; releaseRepo: string | null }[]; rulesets?: Record<string, Record<string, unknown>[]>; installed?: string[]; last?: string | null }) {
  const reader: ReleaseTagRulesReader = {
    releasing: vi.fn(async () => options.releasing ?? [{ fullName: 'acme/app', releaseRepo: null }]),
    app: vi.fn(async (repo: string) => ((options.installed ?? ['acme/app', 'acme/app-releases']).includes(repo) ? rulesetsApi(options.rulesets?.[repo] ?? []) : null)),
    lastVersion: vi.fn(async () => (options.last === undefined ? '1.2.3' : options.last)),
  };
  return { results: releaseTagRulesCheck(reader).run(new Date('2026-11-15T10:00:00Z')), reader };
}

describe('whether the app may create release tags (#344)', () => {
  it('is its own check, every half hour, which no walkthrough step waits on', () => {
    const made = releaseTagRulesCheck({ releasing: async () => [], app: async () => null, lastVersion: async () => null });
    expect(made).toMatchObject({ id: RELEASE_TAG_RULES_CHECK, steps: [], everyMinutes: 30 });
  });

  it('judges the tag the next release would most likely take', () => {
    expect(likelyNextTag('1.2.3')).toBe('v1.2.4');
    expect(likelyNextTag('156.0.8078.79-abc.30')).toBe('v156.0.8078.79-abc.31');
    expect(likelyNextTag(null)).toBe('v0.0.1');
  });

  it('says nothing while nothing releases', async () => {
    await expect(check({ releasing: [] }).results).resolves.toEqual([]);
  });

  it('warns, with the ruleset’s page, when an active creation rule covers v1.2.4 and the app may never bypass it', async () => {
    const [result] = await check({ rulesets: { 'acme/app': [RULESET] } }).results;
    expect(result).toMatchObject({
      subject: 'acme/app',
      ok: false,
      severity: 'warning',
      title: "OpenADLC's app cannot create release tags on acme/app",
      detail:
        "The tag ruleset “release tags” lets only its bypass list create v1.2.4, and OpenADLC's app is not on it. Add the app as a bypass actor, set to Always. " +
        'Until then a release of acme/app is built and signed, then stops at its tag and publishes nothing.',
      action: { label: 'Open the ruleset', url: 'https://github.com/acme/app/settings/rules/7' },
    });
  });

  it('points at an organization’s ruleset on the organization’s page', async () => {
    const [result] = await check({ rulesets: { 'acme/app': [{ ...RULESET, id: 9, source_type: 'Organization', source: 'acme' }] } }).results;
    expect(result).toMatchObject({ ok: false, action: { url: 'https://github.com/organizations/acme/settings/rules/9' } });
  });

  it('clears when the app may always bypass it', async () => {
    const [result] = await check({ rulesets: { 'acme/app': [{ ...RULESET, current_user_can_bypass: 'always' }] } }).results;
    expect(result).toMatchObject({ subject: 'acme/app', ok: true, fixed: "OpenADLC's app may create release tags on acme/app again" });
  });

  it.each([
    ['an evaluate ruleset', { enforcement: 'evaluate' }],
    ['an excluded pattern', { conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/tags/v1.2.4'] } } }],
    ['a branch ruleset', { target: 'branch' }],
  ])('passes for %s', async (_name, extra) => {
    const [result] = await check({ rulesets: { 'acme/app': [{ ...RULESET, ...extra }] } }).results;
    expect(result?.ok).toBe(true);
  });

  it('has no answer when GitHub does not say whether the app may bypass', async () => {
    const [result] = await check({ rulesets: { 'acme/app': [{ ...RULESET, current_user_can_bypass: undefined }] } }).results;
    expect(result).toMatchObject({ subject: 'acme/app', ok: null, reason: expect.stringContaining('did not say') });
  });

  it('judges a separate release repository too, and warns when the app is not installed there', async () => {
    const { results } = check({ releasing: [{ fullName: 'acme/app', releaseRepo: 'acme/app-releases' }], installed: ['acme/app'] });
    const [source, target] = await results;
    expect(source).toMatchObject({ subject: 'acme/app', ok: true });
    expect(target).toMatchObject({
      subject: 'acme/app-releases',
      ok: false,
      title: "OpenADLC's app is not installed on acme/app-releases; releases of acme/app cannot publish there",
    });
  });

  it('reads the last release from where releases are published', async () => {
    const { results, reader } = check({ releasing: [{ fullName: 'acme/app', releaseRepo: 'acme/app-releases' }] });
    await results;
    expect(reader.lastVersion).toHaveBeenCalledWith('acme/app-releases');
  });
});

describe('judging one repository’s tag, as the release page’s readiness does (#371)', () => {
  it('judges the exact tag it is given, with only the app’s client', async () => {
    const app = { app: vi.fn(async () => rulesetsApi([{ ...RULESET, conditions: { ref_name: { include: ['refs/tags/v2.0.0'], exclude: [] } } }])) };
    await expect(judgeReleaseTag(app, 'acme/app', 'acme/app', 'v2.0.0', false)).resolves.toMatchObject({ ok: false, facts: { tag: 'v2.0.0' } });
    await expect(judgeReleaseTag(app, 'acme/app', 'acme/app', 'v2.0.1', false)).resolves.toMatchObject({ ok: true });
    expect(app.app).toHaveBeenCalledWith('acme/app');
  });

  it('has no answer for the source repository when the app cannot be asked', async () => {
    await expect(judgeReleaseTag({ app: async () => null }, 'acme/app', 'acme/app', 'v1.0.0', false)).resolves.toMatchObject({ ok: null });
  });
});
