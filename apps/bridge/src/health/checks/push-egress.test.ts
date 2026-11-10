import { describe, expect, it, vi } from 'vitest';
import { pushEgressCheck, PUSH_EGRESS_CHECK, reachHost, type PushEgressReader } from './push-egress.js';

const NOW = new Date('2026-11-10T12:00:00Z');

function reader(options: { refuse?: string[]; services?: string[] } = {}): PushEgressReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    services: async () => options.services ?? [],
    reach: async (host) => {
      asked.push(host);
      if (options.refuse?.includes(host)) throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') });
      return 405;
    },
  };
}

describe('the bridge reaching each push service', () => {
  it('fails the one the network refuses, naming its host and what to do', async () => {
    const results = await pushEgressCheck(reader({ refuse: ['web.push.apple.com'] })).run(NOW);
    const apple = results.find((result) => result.subject === 'web.push.apple.com');
    expect(apple).toMatchObject({ ok: false, severity: 'warning', facts: { host: 'web.push.apple.com' } });
    const detail = apple && 'detail' in apple ? apple.detail : '';
    expect(detail).toContain('The bridge cannot reach web.push.apple.com: allow it on the network the bridge leaves through');
    expect(detail).toContain('ETIMEDOUT');
    expect(results.filter((result) => result.ok === true).map((result) => result.subject).sort()).toEqual(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
  });

  it('counts any HTTP answer as reached', async () => {
    const results = await pushEgressCheck(reader()).run(NOW);
    expect(results.every((result) => result.ok === true)).toBe(true);
  });

  it('tries a Windows host only when a device uses one', async () => {
    const without = reader({ services: ['fcm.googleapis.com'] });
    await pushEgressCheck(without).run(NOW);
    expect(without.asked.some((host) => host.endsWith('.notify.windows.com'))).toBe(false);
    const withWindows = reader({ services: ['wns2-by3p.notify.windows.com'] });
    await pushEgressCheck(withWindows).run(NOW);
    expect(withWindows.asked).toContain('wns2-by3p.notify.windows.com');
  });

  it('asks with a HEAD that follows no redirect and gives up after five seconds', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await reachHost('fcm.googleapis.com', fetcher as unknown as typeof fetch)).toBe(404);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fcm.googleapis.com/');
    expect(init).toMatchObject({ method: 'HEAD', redirect: 'manual' });
    expect(init.signal).toBeDefined();
    expect(pushEgressCheck(reader()).id).toBe(PUSH_EGRESS_CHECK);
  });
});
