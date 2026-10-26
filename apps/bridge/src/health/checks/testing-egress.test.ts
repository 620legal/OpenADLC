import { EGRESS_NAMES_PER_ASK, egressListAllows, type EgressReport } from '@openadlc/shared';
import { describe, expect, it } from 'vitest';
import { allowHostHref, EGRESS_STEPS, testingEgressCheck, TESTING_EGRESS_CHECK, type TestingEgressReader } from './testing-egress.js';

/**
 * On the first cloud install a repository's testing URL was on none of the
 * egress proxy's lists, so its QA task could reach nothing there and said
 * "not run", and nobody was told the fix. The proxy here answers as the
 * host's does: the module's list, the operator's `extra_allowed_domains`
 * and Settings' list, each name letting through itself and every name under it.
 */

const NOW = new Date('2026-10-26T12:00:00Z');
const MODULE_LIST = ['github.com', 'api.anthropic.com'];

function install(options: { lists?: string[][]; proxied?: boolean; settingsList?: boolean; urls?: Record<string, string | null | Error>; hostd?: Error }) {
  const asked: string[][] = [];
  const settings = options.lists?.[1] ?? [];
  const reader: TestingEgressReader = {
    repos: async () => [
      { name: 'web', fullName: 'acme/web' },
      { name: 'api', fullName: 'acme/api' },
    ],
    testingUrl: async (repo) => {
      const url = options.urls && repo.name in options.urls ? (options.urls[repo.name] ?? null) :repo.name === 'web' ? 'https://web-1234-uc.a.run.app' : null;
      if (url instanceof Error) throw url;
      return url;
    },
    egress: async (hosts): Promise<EgressReport> => {
      asked.push(hosts);
      if (options.hostd) throw options.hostd;
      if (options.proxied === false) return { proxied: false, hosts: [] };
      const every = [...MODULE_LIST, ...(options.lists ?? []).flat()];
      return {
        proxied: true,
        settingsList: options.settingsList ?? true,
        hosts: hosts.map((host) => (egressListAllows(every, host) ? { host, allowed: true } : { host, allowed: false, status: 403 })),
      };
    },
    allowed: async () => settings,
  };
  return { check: testingEgressCheck(reader), asked };
}

describe('a repository’s testing URL, through the cloud host’s egress proxy', () => {
  it('fails while the proxy refuses the host, naming the repository, the host and both ways to allow it, and offers it in Settings', async () => {
    const [result] = await install({}).check.run(NOW);
    expect(result).toMatchObject({
      subject: 'acme/web',
      ok: false,
      severity: 'warning',
      title: 'QA cannot reach acme/web’s testing environment: the egress proxy refuses web-1234-uc.a.run.app',
      action: { label: 'Allow web-1234-uc.a.run.app in Settings', href: '/settings?allow-host=web-1234-uc.a.run.app#egress' },
    });
    const detail = result && 'detail' in result ? result.detail : '';
    for (const step of EGRESS_STEPS) expect(detail).toContain(step);
    expect(detail).toContain('reports “not run”');
    expect(detail).toContain('not a domain above it');
  });

  it('passes once Settings lists the host, or a name above it, or the operator’s extra_allowed_domains does', async () => {
    for (const lists of [[[], ['web-1234-uc.a.run.app']], [[], ['a.run.app']], [['web-1234-uc.a.run.app'], []]]) {
      expect(await install({ lists }).check.run(NOW)).toEqual([
        { subject: 'acme/web', ok: true, fixed: 'QA can reach acme/web’s testing environment at web-1234-uc.a.run.app now' },
      ]);
    }
  });

  it('asks about every testing host, in batches hostd takes, and raises the card for one past the first batch', async () => {
    // hostd asked about the first 20 names and dropped the rest without a
    // word, so a 21st repository's refused host got no answer and no card.
    const many = Array.from({ length: EGRESS_NAMES_PER_ASK + 1 }, (_, index) => ({ name: `web${index}`, fullName: `acme/web${index}` }));
    const asked: number[] = [];
    const check = testingEgressCheck({
      repos: async () => many,
      testingUrl: async (repo) => `https://${repo.name}.testing.acme.example`,
      egress: async (hosts) => {
        if (hosts.length > EGRESS_NAMES_PER_ASK) throw new Error(`ask about at most ${EGRESS_NAMES_PER_ASK} names at once, not ${hosts.length}`);
        asked.push(hosts.length);
        const refused = `web${EGRESS_NAMES_PER_ASK}.testing.acme.example`;
        return { proxied: true, settingsList: true, hosts: hosts.map((host) => (host === refused ? { host, allowed: false, status: 403 } : { host, allowed: true })) };
      },
      allowed: async () => [],
    });
    const results = await check.run(NOW);
    expect(asked).toEqual([EGRESS_NAMES_PER_ASK, 1]);
    expect(results.filter((one) => one.ok === true)).toHaveLength(EGRESS_NAMES_PER_ASK);
    expect(results.at(-1)).toMatchObject({
      subject: `acme/web${EGRESS_NAMES_PER_ASK}`,
      ok: false,
      title: `QA cannot reach acme/web${EGRESS_NAMES_PER_ASK}’s testing environment: the egress proxy refuses web${EGRESS_NAMES_PER_ASK}.testing.acme.example`,
    });
  });

  it('says nothing on a laptop, whose tasks leave through no proxy', async () => {
    expect(await install({ proxied: false }).check.run(NOW)).toEqual([]);
  });

  it('asks nothing where no repository names a testing URL', async () => {
    const { check, asked } = install({ urls: { web: null } });
    expect(await check.run(NOW)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('says a host Settings lists that the proxy still refuses was not put on it, rather than to list it', async () => {
    const listedButRefused = testingEgressCheck({
      repos: async () => [{ name: 'web', fullName: 'acme/web' }],
      testingUrl: async () => 'https://testing.acme.example/login',
      egress: async (hosts) => ({ proxied: true, settingsList: true, hosts: hosts.map((host) => ({ host, allowed: false, status: 403 })) }),
      allowed: async () => ['acme.example'],
    });
    const [result] = await listedButRefused.run(NOW);
    expect(result && 'detail' in result ? result.detail : '').toContain('Settings → Egress lists acme.example, and the proxy still refuses it');
  });

  it('says the apply comes first on a host whose proxy reads no Settings list yet', async () => {
    const [result] = await install({ settingsList: false }).check.run(NOW);
    expect(result && 'detail' in result ? result.detail : '').toContain('pause work, let the running tasks finish, then run openadlc cloud apply, which resets the host once');
  });

  it('gives no answer when hostd could not ask, or the rules could not be read', async () => {
    expect(await install({ hostd: new Error('hostd is not answering') }).check.run(NOW)).toEqual([
      { subject: 'acme/web', ok: null, reason: 'the egress proxy could not be asked: hostd is not answering' },
    ]);
    const [unread] = await install({ urls: { web: new Error('.github/openadlc.yml could not be read: 502') } }).check.run(NOW);
    expect(unread).toMatchObject({ subject: 'acme/web', ok: null });
  });

  it('only reads: a testing URL a repository names is never put on any list', async () => {
    // The reader has no way to write, and the check is given nothing else;
    // run against a refusing proxy twice, the lists are what they were.
    const lists = [[], [] as string[]];
    const { check } = install({ lists });
    await check.run(NOW);
    await check.run(NOW);
    expect(lists).toEqual([[], []]);
    expect((await check.run(NOW))[0]).toMatchObject({ ok: false });
  });

  it('is the check a save in Settings asks again, and its button offers the host rather than allowing it', () => {
    expect(install({}).check.id).toBe(TESTING_EGRESS_CHECK);
    expect(allowHostHref('a b')).toBe('/settings?allow-host=a%20b#egress');
  });
});
