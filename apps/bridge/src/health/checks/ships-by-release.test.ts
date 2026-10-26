import { DEFAULT_DELIVERY_RULES, WEBHOOK_EVENTS, deliveryRulesSchema, type DeliveryRules } from '@openadlc/shared';
import { describe, expect, it } from 'vitest';
import { releaseEventsOf, shipsByReleaseCheck, SHIPS_BY_RELEASE_CHECK } from './ships-by-release.js';

/**
 * A repository that ships by release has its cards moved to Done by the
 * `release` delivery, which GitHub sends only to an app subscribed to it: an
 * app made from a manifest before OpenADLC asked for it never is. The deploy
 * sweep lists the releases besides, so this is a warning, and only where a
 * repository ships that way.
 */

const NOW = new Date('2026-10-23T12:00:00Z');
const BY_RELEASE = deliveryRulesSchema.parse({ version: 1, testing: { on: 'release' } });
const PAGE = 'https://github.com/organizations/acme/settings/apps/openadlc-acme/permissions';
const EVERY_OTHER = WEBHOOK_EVENTS.filter((event) => event !== 'release');

function check(options: { rules?: Record<string, DeliveryRules | null>; events?: string[] | Error | null }) {
  return shipsByReleaseCheck({
    repos: async () => [
      { name: 'openadlc', fullName: '620legal/OpenADLC' },
      { name: 'app', fullName: 'acme/app' },
    ],
    rules: async (repo) => (options.rules && repo.name in options.rules ? (options.rules[repo.name] ?? null) : DEFAULT_DELIVERY_RULES),
    appEvents: async () => {
      if (options.events instanceof Error) throw options.events;
      return options.events === null ? null : { events: options.events ?? [...WEBHOOK_EVENTS], page: PAGE };
    },
  });
}

describe('the app hearing a release, where a repository ships by release', () => {
  it('warns, for each repository that ships by release, when the app is not subscribed, with where to tick it', async () => {
    const results = await check({ rules: { openadlc: BY_RELEASE }, events: EVERY_OTHER }).run(NOW);
    expect(results).toEqual([
      {
        subject: '620legal/OpenADLC',
        ok: false,
        severity: 'warning',
        title: 'The OpenADLC app is not subscribed to “Release”, and 620legal/OpenADLC ships by release',
        detail: expect.stringContaining('under Subscribe to events, tick “Release” and save'),
        action: { label: 'Open the app’s permissions and events', url: PAGE },
        facts: { event: 'release', permissionsUrl: PAGE },
      },
    ]);
    const detail = results[0] && 'detail' in results[0] ? results[0].detail : '';
    expect(detail).toContain('the deploy sweep finds each release by listing the repository’s releases');
  });

  it('passes once the app is subscribed', async () => {
    expect(await check({ rules: { openadlc: BY_RELEASE } }).run(NOW)).toEqual([
      { subject: '620legal/OpenADLC', ok: true, fixed: 'The OpenADLC app is subscribed to “Release” now, which 620legal/OpenADLC ships by' },
    ]);
  });

  it('says nothing where no repository ships by release, whatever the app is subscribed to', async () => {
    expect(await check({ events: EVERY_OTHER }).run(NOW)).toEqual([]);
  });

  it('is no answer when GitHub could not be asked, or OpenADLC holds no key to ask with', async () => {
    expect(await check({ rules: { openadlc: BY_RELEASE }, events: new Error('502') }).run(NOW)).toEqual([
      { subject: '620legal/OpenADLC', ok: null, reason: 'GitHub did not describe the app: 502' },
    ]);
    expect((await check({ rules: { openadlc: BY_RELEASE }, events: null }).run(NOW))[0]).toMatchObject({ ok: null });
  });

  it('is no answer for a repository whose rules could not be read', async () => {
    expect(await check({ rules: { app: null } }).run(NOW)).toEqual([
      { subject: 'acme/app', ok: null, reason: 'its delivery rules could not be read, so whether it ships by release is not known' },
    ]);
  });
});

describe('what Settings says of it', () => {
  const row = (state: string, extra: Record<string, unknown> = {}) => ({ checkId: SHIPS_BY_RELEASE_CHECK, subject: '620legal/OpenADLC', state, ...extra });

  it('is the check’s last answer for the repository, with where to tick it while it fails', () => {
    expect(releaseEventsOf([row('failing', { action: { label: 'Open', url: PAGE } })], '620legal/OpenADLC')).toEqual({ subscribed: false, url: PAGE });
    expect(releaseEventsOf([row('ok')], '620legal/OpenADLC')).toEqual({ subscribed: true, url: null });
  });

  it('is nothing before the check has answered, when it could not, or for another repository', () => {
    expect(releaseEventsOf([], '620legal/OpenADLC')).toBeNull();
    expect(releaseEventsOf([row('unknown')], '620legal/OpenADLC')).toBeNull();
    expect(releaseEventsOf([row('failing')], 'acme/app')).toBeNull();
    expect(releaseEventsOf([{ ...row('failing'), checkId: 'app-permissions' }], '620legal/OpenADLC')).toBeNull();
  });
});
