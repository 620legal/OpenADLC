import { audit, settings } from '@openadlc/db';
import { egressHostProblem, MAX_EGRESS_HOSTS, normalEgressHost, parseEgressHosts, type EgressReport } from '@openadlc/shared';
import { HttpFailure, type Router } from './router.js';

/** The store, the audit trail and hostd, injected so the routes can be tested without them. */
export interface EgressRouteDeps {
  stored(): Promise<string[]>;
  store(hosts: readonly string[], by: string): Promise<void>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<unknown>;
  hostd: {
    egress(hosts: readonly string[]): Promise<EgressReport>;
    applyEgressHosts(hosts: readonly string[]): Promise<{ hosts: string[] }>;
  };
  /** Told after a save, so the testing-egress check asks the proxy again now rather than in minutes. */
  changed?: () => void;
}

export function liveEgressDeps(hostd: EgressRouteDeps['hostd'], changed?: () => void): EgressRouteDeps {
  return {
    stored: async () => parseEgressHosts(await settings.getSetting('egressExtraHosts')),
    store: (hosts, by) => settings.setSetting('egressExtraHosts', hosts.join(','), by),
    audit,
    hostd,
    ...(changed ? { changed } : {}),
  };
}

/** What Settings shows: the list, and whether this install's proxy reads it. */
export interface EgressHostsView {
  hosts: string[];
  /** Whether tasks leave through an egress proxy here; null when hostd could not be asked. Settings shows the list only when true. */
  proxied: boolean | null;
  /** Whether the proxy reads this list; false on a cloud host whose cloud-init is from before it. */
  settingsList: boolean | null;
  /** Why the list cannot be saved now, when it cannot. */
  reason: string | null;
}

/** What a cloud host needs once, before its proxy reads the list. */
export const APPLY_ONCE =
  'the host’s egress proxy reads this list once the module is applied with this release: pause work, wait for the running tasks to finish, then run openadlc cloud apply, which resets the host once';

/**
 * Settings → Egress: the names a cloud host's tasks may reach beyond the
 * proxy's own list, kept where the other settings are and put on the proxy at
 * once by hostd.
 *
 * Widening egress was `extra_allowed_domains` and `openadlc cloud apply`,
 * which resets the host and ends every task on it, so on the first cloud
 * install a repository's testing URL stayed off the list and its QA could
 * never reach it. Only an admin changes this one (`roles.ts`), each change is
 * in the audit trail with who made it, and nothing a repository's files say
 * reaches it: a merged `.github/openadlc.yml` could otherwise open the host's
 * egress to a name of its choosing.
 */
export function registerEgressRoutes(router: Router, deps: EgressRouteDeps): void {
  router.get('/v1/egress/hosts', async (): Promise<EgressHostsView> => {
    const [hosts, report] = await Promise.all([deps.stored(), deps.hostd.egress([]).catch((error: unknown) => error as Error)]);
    if (report instanceof Error) return { hosts, proxied: null, settingsList: null, reason: report.message };
    return {
      hosts,
      proxied: report.proxied,
      settingsList: report.proxied ? report.settingsList === true : false,
      reason: !report.proxied ? 'tasks here leave through no egress proxy, so there is nothing to allow' : report.settingsList ? null : APPLY_ONCE,
    };
  });

  router.add('PUT', '/v1/egress/hosts', async ({ body, identity }) => {
    const input = await body<{ hosts?: unknown } | null>();
    if (!Array.isArray(input?.hosts) || !input.hosts.every((one): one is string => typeof one === 'string')) {
      throw new HttpFailure(400, 'hosts is a list of host names, such as ["testing.example.com"]');
    }
    const hosts = [...new Set(input.hosts.map(normalEgressHost).filter(Boolean))];
    for (const host of hosts) {
      const problem = egressHostProblem(host);
      if (problem) throw new HttpFailure(400, problem);
    }
    if (hosts.length > MAX_EGRESS_HOSTS) throw new HttpFailure(400, `at most ${MAX_EGRESS_HOSTS} names may be allowed`);

    // Asked first, so a laptop, or a host whose proxy reads no list yet, is
    // told so rather than given a list nothing would ever read.
    const report = await deps.hostd.egress([]);
    if (!report.proxied) throw new HttpFailure(409, 'tasks here leave through no egress proxy, so there is nothing to allow');
    if (!report.settingsList) throw new HttpFailure(409, APPLY_ONCE);

    const before = await deps.stored();
    await deps.store(hosts, identity);
    const added = hosts.filter((host) => !before.includes(host));
    const removed = before.filter((host) => !hosts.includes(host));
    if (added.length > 0 || removed.length > 0) {
      await deps.audit({ actor: identity, action: 'egress.hosts_changed', target: 'install', payload: { added, removed, hosts } });
    }
    try {
      return { hosts, applied: (await deps.hostd.applyEgressHosts(hosts)).hosts };
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      throw new HttpFailure(502, `Saved, and not on the egress proxy yet: ${said} hostd puts the saved list on the proxy when it starts; save again to try now.`, { saved: hosts });
    } finally {
      deps.changed?.();
    }
  });
}
