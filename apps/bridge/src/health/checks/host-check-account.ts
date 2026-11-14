import type { HostCheckAccountProbe } from '../../hostd-client.js';
import { HOST_CHECK_DOCS, accountFix } from '../../host-check-service.js';
import type { HealthCheck } from '../types.js';

export const HOST_CHECK_ACCOUNT_CHECK = 'host-check-account';

/** Where the steps are, for the card's button. */
export const HOST_CHECK_DOCS_URL = 'https://github.com/620legal/OpenADLC/blob/main/docs/self-hosting.md#host-checks';

export interface HostCheckAccountReader {
  /** Whether any repository OpenADLC works in has a host check; with none, nothing is asked of the machine. */
  wanted(): Promise<boolean>;
  /** What hostd found when it tried the account (`HostChecks.probe`). */
  probe(): Promise<HostCheckAccountProbe>;
}

/**
 * Whether the OS account a repository's host check runs as is there and fit
 * (#327, docs/adr/0064): a step only a person can do, on the machine itself.
 *
 * Proved by its effect, never by a setting that says so: hostd looks the
 * account up, runs a command as it through `sudo -n`, and has that command try
 * to read `OPENADLC_HOME`, `install.json`, the work root and hostd's own home,
 * to enter those folders, to connect to a Docker socket and to run `sudo -n
 * -l`; and asks whether it is in the `docker` group (#335). Root, or hostd's
 * own user, is no account of its own. While this fails no host check
 * runs, and the held approval's card says it was not run, with the same fix.
 */
export function hostCheckAccountCheck(reader: HostCheckAccountReader): HealthCheck {
  return {
    id: HOST_CHECK_ACCOUNT_CHECK,
    proves: 'The account host checks run as exists, hostd can run a command as it, and it reaches nothing the install guards: not its files, not Docker, not sudo',
    how:
      'asks hostd to look the account up, run /usr/bin/true as it with sudo -n, and, as it, try to read or enter OPENADLC_HOME, the work root and hostd’s home, ' +
      'read install.json, connect to each Docker socket and run sudo -n -l; and whether it is in the docker group',
    everyMinutes: 10,
    steps: [],
    async run() {
      if (!(await reader.wanted())) return [];
      let probe: HostCheckAccountProbe;
      try {
        probe = await reader.probe();
      } catch (error) {
        return [{ ok: null, reason: `hostd could not be asked about the host check account: ${error instanceof Error ? error.message : error}` }];
      }
      if (probe.ok) return [{ ok: true, says: `${probe.account} (uid ${probe.uid}) runs host checks in ${probe.home}`, fixed: 'Host checks can run again' }];
      const action = { label: 'Open the steps', url: HOST_CHECK_DOCS_URL };
      switch (probe.problem) {
        case 'no_account':
          return [{ ok: false, severity: 'warning', title: 'The account host checks run as is not on this machine', detail: `${accountFix(probe)}. Until then no host check runs.`, action }];
        case 'not_dedicated':
          return [{ ok: false, severity: 'warning', title: 'Host checks would run as an account that can read the install', detail: `${accountFix(probe)}. Until then no host check runs.`, action }];
        case 'no_sudo':
          return [{ ok: false, severity: 'warning', title: 'hostd cannot run a command as the host check account', detail: `${accountFix(probe)}. Until then no host check runs.`, action }];
        case 'can_read':
          return [
            {
              ok: false,
              severity: 'warning',
              title: `The host check account can read ${probe.path ?? 'the install'}`,
              detail: `${accountFix(probe)}, then run openadlc doctor. Until then no host check runs. See ${HOST_CHECK_DOCS}.`,
              action: { label: 'Run in a terminal', command: `chmod 700 ${probe.path ?? '~'}` },
            },
          ];
        case 'can_enter':
          return [
            {
              ok: false,
              severity: 'warning',
              title: `The host check account can enter ${probe.path ?? 'the install'}`,
              detail: `${accountFix(probe)}, then run openadlc doctor. Until then no host check runs. See ${HOST_CHECK_DOCS}.`,
              action: { label: 'Run in a terminal', command: `chmod 700 ${probe.path ?? '~'}` },
            },
          ];
        case 'docker':
          return [{ ok: false, severity: 'warning', title: 'The host check account can reach Docker', detail: `${accountFix(probe)}. Until then no host check runs.`, action }];
        case 'can_sudo':
          return [{ ok: false, severity: 'warning', title: 'The host check account can run sudo without a password', detail: `${accountFix(probe)}. Until then no host check runs.`, action }];
      }
    },
  };
}
