import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/** `/settings/hosts`: the machines that run tasks, as `GET /v1/hosts` says them. */

type Me = { known: true; email: string; role: 'admin' | 'user'; identityMode: 'local' | 'iap' };
const ADMIN: Me = { known: true, email: 'janedoe@example.com', role: 'admin', identityMode: 'iap' };
const who = vi.hoisted(() => ({ me: null as unknown as Me, asked: 0 }));
who.me = ADMIN;

vi.mock('@/lib/api', () => ({
  readMe: async () => who.me,
  api: {
    repos: async () => ({
      repos: [{ name: 'api', fullName: 'exampleco/api', concurrency: 1, owner: null, stageModes: {}, specRequiredLabels: [], color: 'blue' }],
      maxReviewRounds: 3,
    }),
    crew: async () => ({ bots: [] }),
    costs: async () => null,
    hosts: async () => {
      who.asked += 1;
      return {
        now: '2026-11-02T12:00:00.000Z',
        unclaimed: 0,
        silentAfterMs: 300_000,
        hosts: [
          {
            id: 'host-1',
            name: 'mac',
            driver: 'docker',
            capacityTasks: 4,
            used: 2,
            cpus: 8,
            memoryBytes: 17179869184,
            lastSeenAt: '2026-11-02T11:59:52.000Z',
            state: 'live',
            failedSilent: 0,
          },
        ],
      };
    },
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['api'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));

describe('the hosts page', () => {
  it('lists the hosts the bridge reads, and links back to Settings', async () => {
    who.asked = 0;
    const { default: HostsSettingsPage } = await import('./page');
    const html = renderToStaticMarkup(await HostsSettingsPage()).replace(/<!-- -->/g, '');
    expect(who.asked).toBe(1);
    expect(html).toMatch(/<a [^>]*href="\/settings#hosts"[^>]*>/);
    expect(html).toContain('mac');
    expect(html).toContain('seen 8 s ago');
    expect(html).toContain('2 of 4 tasks');
    expect(html).toContain('8 CPUs · 16 GB');
  });

  it('is an admin’s: a user is told so, and shown no hosts', async () => {
    who.me = { known: true, email: 'bob@example.com', role: 'user', identityMode: 'iap' };
    who.asked = 0;
    try {
      const { default: HostsSettingsPage } = await import('./page');
      const html = renderToStaticMarkup(await HostsSettingsPage()).replace(/<!-- -->/g, '');
      expect(html).toContain('Hosts need an admin');
      expect(html).toContain('bob@example.com');
      expect(html).not.toContain('seen 8 s ago');
      expect(who.asked).toBe(0);
    } finally {
      who.me = ADMIN;
    }
  });
});
