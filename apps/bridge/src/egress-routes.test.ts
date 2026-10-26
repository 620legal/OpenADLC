import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EgressReport } from '@openadlc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { APPLY_ONCE, registerEgressRoutes } from './egress-routes.js';
import { Router } from './router.js';
import { roleFor } from './roles.js';

/**
 * Settings → Egress: the names a cloud host's tasks may reach beyond the
 * proxy's own list. Widening it was a tfvars edit and an apply that resets the
 * host; now an admin saves it here, it is audited with who did, and hostd puts
 * it on the proxy at once.
 */

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function serve(options: { report?: EgressReport | Error; apply?: Error } = {}) {
  let stored = '';
  const audited: { actor: string; action: string; target: string; payload?: Record<string, unknown> }[] = [];
  const applied: string[][] = [];
  let changed = 0;
  const router = new Router(undefined, undefined, undefined, async () => 'admin');
  registerEgressRoutes(router, {
    stored: async () => stored.split(',').filter(Boolean),
    store: async (hosts) => {
      stored = hosts.join(',');
    },
    audit: async (entry) => void audited.push(entry),
    hostd: {
      egress: async () => {
        const report = options.report ?? { proxied: true, settingsList: true, hosts: [] };
        if (report instanceof Error) throw report;
        return report;
      },
      applyEgressHosts: async (hosts) => {
        if (options.apply) throw options.apply;
        applied.push([...hosts]);
        return { hosts: [...hosts] };
      },
    },
    changed: () => void (changed += 1),
  });
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/egress/hosts`;
  const headers = { 'x-openadlc-identity': 'janedoe@example.com', 'content-type': 'application/json' };
  return {
    read: async () => (await fetch(url, { headers })).json(),
    save: async (hosts: unknown) => {
      const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ hosts }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    stored: () => stored,
    audited,
    applied,
    changed: () => changed,
  };
}

describe('the names a cloud host’s tasks may reach, in Settings', () => {
  it('round-trips, is audited with who added and removed what, and is put on the proxy', async () => {
    const egress = await serve();
    expect(await egress.save(['https://Web-1234-UC.a.run.app/login', 'testing.acme.example'])).toEqual({
      status: 200,
      body: { hosts: ['web-1234-uc.a.run.app', 'testing.acme.example'], applied: ['web-1234-uc.a.run.app', 'testing.acme.example'] },
    });
    expect(await egress.read()).toEqual({ hosts: ['web-1234-uc.a.run.app', 'testing.acme.example'], proxied: true, settingsList: true, reason: null });

    await egress.save(['testing.acme.example']);
    expect(egress.audited).toEqual([
      { actor: 'janedoe@example.com', action: 'egress.hosts_changed', target: 'install', payload: { added: ['web-1234-uc.a.run.app', 'testing.acme.example'], removed: [], hosts: ['web-1234-uc.a.run.app', 'testing.acme.example'] } },
      { actor: 'janedoe@example.com', action: 'egress.hosts_changed', target: 'install', payload: { added: [], removed: ['web-1234-uc.a.run.app'], hosts: ['testing.acme.example'] } },
    ]);
    expect(egress.applied).toEqual([['web-1234-uc.a.run.app', 'testing.acme.example'], ['testing.acme.example']]);
    expect(egress.changed()).toBe(2);
  });

  it('is an admin’s to read and to change', () => {
    expect(roleFor('GET', '/v1/egress/hosts')).toBe('admin');
    expect(roleFor('PUT', '/v1/egress/hosts')).toBe('admin');
  });

  it('refuses a name it would not put on the proxy, and keeps nothing of the save', async () => {
    const egress = await serve();
    for (const hosts of [['10.0.0.5'], ['app'], ['acme.example\nhttp_access allow all'], 'acme.example']) {
      expect((await egress.save(hosts)).status).toBe(400);
    }
    expect(egress.stored()).toBe('');
    expect(egress.audited).toEqual([]);
    expect(egress.applied).toEqual([]);
  });

  it('is no list on a laptop, whose tasks leave through no proxy, and cannot be saved there', async () => {
    const egress = await serve({ report: { proxied: false, hosts: [] } });
    expect(await egress.read()).toMatchObject({ proxied: false, settingsList: false });
    expect((await egress.save(['testing.acme.example'])).status).toBe(409);
    expect(egress.stored()).toBe('');
  });

  it('says the apply comes first on a cloud host whose proxy reads no list yet', async () => {
    const egress = await serve({ report: { proxied: true, settingsList: false, hosts: [] } });
    expect(await egress.read()).toMatchObject({ proxied: true, settingsList: false, reason: APPLY_ONCE });
    expect(await egress.save(['testing.acme.example'])).toMatchObject({ status: 409, body: { error: APPLY_ONCE } });
  });

  it('keeps a save hostd could not put on the proxy, and says hostd puts it there when it starts', async () => {
    const egress = await serve({ apply: Object.assign(new Error('the egress proxy did not read it again: No such container.'), { status: 502 }) });
    const { status, body } = await egress.save(['testing.acme.example']);
    expect(status).toBe(502);
    expect(body.error).toContain('hostd puts the saved list on the proxy when it starts');
    expect(egress.stored()).toBe('testing.acme.example');
    expect(egress.audited).toHaveLength(1);
  });
});
