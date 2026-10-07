/**
 * The address a *task* uses for one of the host's services.
 *
 * hostd and the bridge usually talk to each other over the host's loopback, and
 * that is what `FLEETADLC_BRIDGE_URL` and hostd's own port mean (compose uses
 * service names instead; see `HostdConfig.taskBridgeUrl`). A task under the
 * docker driver does not run on the host: it runs in a container on the
 * install's task network (`fleetadlc-tasks`), so `127.0.0.1:47311` in its
 * environment is the container's own loopback and every call to it is refused.
 *
 * `host.docker.internal` is the address the driver already hands containers for
 * hostd (`HOSTD_URL`), so it is what the rest of the session environment should
 * say too.
 *
 * Only loopback is rewritten. An operator who set `FLEETADLC_BRIDGE_URL` to a real
 * hostname meant it, and a container can reach it already.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

export const CONTAINER_HOST_ALIAS = 'host.docker.internal';

export function reachableFromTask(url: string, driver: 'docker' | 'local'): string {
  if (driver !== 'docker') return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can reason about; changing it would be a guess.
    return url;
  }

  if (!LOOPBACK.has(parsed.hostname) && !LOOPBACK.has(`[${parsed.hostname}]`)) return url;
  parsed.hostname = CONTAINER_HOST_ALIAS;
  // `new URL` keeps a trailing slash the caller did not write, and these values
  // are concatenated with paths that start with one.
  return parsed.toString().replace(/\/$/, '');
}
