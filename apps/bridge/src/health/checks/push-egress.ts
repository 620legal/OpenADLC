import { PUSH_SERVICE_SUFFIX, PUSH_SERVICES } from '../../web-push.js';
import type { CheckResult, HealthCheck } from '../types.js';

export const PUSH_EGRESS_CHECK = 'push-egress';

export interface PushEgressReader {
  /** Each push service a device uses: the only way to know which of Windows' many hosts to try. */
  services(): Promise<string[]>;
  /** Asks the host anything; resolves with any HTTP answer, rejects when nothing came back. */
  reach(host: string): Promise<number>;
}

/** Reaches a host the way a push would leave: one HEAD, five seconds, no redirect followed. */
export async function reachHost(host: string, fetcher: typeof fetch = fetch): Promise<number> {
  const response = await fetcher(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
  return response.status;
}

/**
 * The bridge can reach each push service a device's notifications go through.
 *
 * Every push leaves from the bridge to Google's, Mozilla's, Apple's or
 * Microsoft's push service, so a network that refuses one of them — a cloud
 * install's egress rules, an office firewall in front of a laptop — leaves
 * that browser's devices getting nothing, while Settings says each send
 * failed. Judged by effect: any HTTP answer at all means the way out is open,
 * since the service is only being reached, not used. Windows' hosts have no
 * fixed name, so only those a device uses are tried.
 */
export function pushEgressCheck(reader: PushEgressReader): HealthCheck {
  return {
    id: PUSH_EGRESS_CHECK,
    proves: 'The bridge can reach each push service its devices’ notifications go through',
    how: 'makes one HEAD request to each push service’s host, and counts any HTTP answer as reached',
    everyMinutes: 60,
    steps: [],
    timeoutMs: 20_000,
    async run() {
      const used = await reader.services().catch(() => [] as string[]);
      const windows = used.filter((host) => host.endsWith(PUSH_SERVICE_SUFFIX));
      const hosts = [...new Set([...PUSH_SERVICES, ...windows])];
      return Promise.all(
        hosts.map(async (host): Promise<CheckResult> => {
          try {
            await reader.reach(host);
            return { subject: host, ok: true, fixed: `The bridge can reach ${host} again: notifications through it get out` };
          } catch (error) {
            const why = messageOf(error);
            return {
              subject: host,
              ok: false,
              severity: 'warning',
              title: `The bridge cannot reach ${host}: push notifications through it are not delivered`,
              detail:
                `The bridge cannot reach ${host}: allow it on the network the bridge leaves through. ` +
                `Every push to a ${browserOf(host)} device leaves through it, so until then those devices get nothing. (${why})`,
              action: { label: 'Open Settings → Notifications', href: '/settings/notifications' },
              facts: { host },
            };
          }
        }),
      );
    },
  };
}

function browserOf(host: string): string {
  if (host === 'fcm.googleapis.com') return 'Chrome, Edge or Android';
  if (host === 'updates.push.services.mozilla.com') return 'Firefox';
  if (host === 'web.push.apple.com') return 'Safari, iPhone or iPad';
  return 'Windows';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}
