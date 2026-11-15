import type { ReleaseAccountProbe } from '../../hostd-client.js';
import type { CheckResult, HealthCheck } from '../types.js';

export const RELEASE_ACCOUNT_CHECK = 'release-account';

/** Where the steps are, in the detail and on the card's button. */
export const RELEASE_ACCOUNT_DOCS = 'docs/self-hosting.md#the-release-account';
export const RELEASE_ACCOUNT_DOCS_URL = `https://github.com/620legal/OpenADLC/blob/main/${RELEASE_ACCOUNT_DOCS}`;

export interface ReleaseAccountReader {
  /** What hostd found when it tried the release account (`ReleaseAccount.probe`); `null` when hostd names none. */
  probe(): Promise<ReleaseAccountProbe | null>;
  /** The full name of a repository set to release (`repos.anyRelease`'s), or null for none; absent is none. */
  wanted?(): Promise<string | null>;
}

type Failing = Exclude<ReleaseAccountProbe, { ok: true }>;

/** What the card says for a failing probe: its title, the fix, and the one thing to press. */
export function releaseAccountFix(probe: Failing): { title: string; detail: string; action: Extract<CheckResult, { ok: false }>['action'] } {
  const steps = { label: 'Open the steps', url: RELEASE_ACCOUNT_DOCS_URL };
  const chmod = (path: string | undefined, sudo: boolean) => ({ label: 'Run in a terminal', command: `${sudo ? 'sudo ' : ''}chmod 700 ${path ?? '~'}` });
  const end = `Until then no release can be cut. See ${RELEASE_ACCOUNT_DOCS}.`;
  switch (probe.problem) {
    case 'no_account':
      return {
        title: 'The account releases are built in is not on this machine',
        detail: `${probe.detail}. Make the account, or set OPENADLC_RELEASE_ACCOUNT to the one you made. ${end}`,
        action: steps,
      };
    case 'not_dedicated':
      return {
        title: 'Releases would be built in an account that can read the install',
        detail: `${probe.detail}. Make the account, or set OPENADLC_RELEASE_ACCOUNT to the one you made. ${end}`,
        action: steps,
      };
    case 'no_sudo':
      return {
        title: 'hostd cannot run a command as the release account',
        detail: `${probe.detail}. Add the sudo rule, then run openadlc doctor. ${end}`,
        action: steps,
      };
    case 'can_read':
      return {
        title: `The release account can read ${probe.path ?? 'the install'}`,
        detail: `${probe.detail}, so it could read the install's secrets. Run: chmod 700 ${probe.path ?? 'that folder'}, then run openadlc doctor. ${end}`,
        action: chmod(probe.path, false),
      };
    case 'can_enter':
      return {
        title: `The release account can enter ${probe.path ?? 'the install'}`,
        detail: `${probe.detail}, so it could open a file there whose name it knows. Run: chmod 700 ${probe.path ?? 'that folder'}, then run openadlc doctor. ${end}`,
        action: chmod(probe.path, false),
      };
    case 'docker':
      return {
        title: 'The release account can reach Docker',
        detail: probe.path
          ? `${probe.detail}. Take the account out of the group that owns ${probe.path}, or make the socket unreachable to it. ${end}`
          : `${probe.detail}. Run: sudo gpasswd -d ${probe.account} docker. ${end}`,
        action: steps,
      };
    case 'can_sudo':
      return {
        title: 'The release account can run sudo without a password',
        detail: `${probe.detail}. Remove the account's NOPASSWD rule from /etc/sudoers.d, and take it out of any group that has one. ${end}`,
        action: steps,
      };
    case 'host_check_account':
      return {
        title: 'Releases would be built in the host check’s account',
        detail: `${probe.detail}. Set OPENADLC_RELEASE_ACCOUNT to an account made only for releases, never the host check's. ${end}`,
        action: steps,
      };
    case 'host_check_reaches':
      return {
        title: 'The host check account can reach the release account’s home',
        detail: `${probe.detail}. Run: sudo chmod 700 ${probe.path ?? 'that folder'}, then run openadlc doctor. ${end}`,
        action: chmod(probe.path, true),
      };
  }
}

/**
 * Whether the OS account releases are built in is there and fit (#341,
 * docs/adr/0068): a step only a person can do, on the machine itself.
 *
 * Quiet unless hostd names a release account (`OPENADLC_RELEASE_ACCOUNT`): an
 * install that never releases has nothing to do, so it is not in
 * `MANUAL_STEPS` either. Quiet too when hostd cannot be asked, which the
 * `host` check already says; a card here would show on every install.
 *
 * Proved by its effect: everything the host check's account is held to, and
 * that it is not that account, by name or uid, and that account can neither
 * read nor enter its home. A repository set to release (#343) with no account
 * named raises the card too, as `anyHostCheck()` does for host checks: its
 * releases would otherwise be refused one by one.
 */
export function releaseAccountCheck(reader: ReleaseAccountReader): HealthCheck {
  return {
    id: RELEASE_ACCOUNT_CHECK,
    proves: 'The account releases are built in exists, hostd can run a command as it, it reaches nothing the install guards, and the host check’s account cannot reach it',
    how:
      'asks hostd to look the account up, run /usr/bin/true as it with sudo -n, and, as it, try to read or enter OPENADLC_HOME, the work root and hostd’s home, ' +
      'read install.json, connect to each Docker socket and run sudo -n -l; whether it is in the docker group; that it is not the host check account by name or uid; ' +
      'and, as the host check account, try to read or enter its home',
    everyMinutes: 10,
    steps: [],
    async run() {
      let probe: ReleaseAccountProbe | null;
      try {
        probe = await reader.probe();
      } catch {
        return [];
      }
      if (!probe) {
        const wanted = await reader.wanted?.().catch(() => null);
        if (!wanted) return [];
        return [
          {
            ok: false,
            severity: 'warning',
            title: `${wanted} is set to release, but no release account is named`,
            detail: `${wanted} is set to release, but hostd names no release account. Set OPENADLC_RELEASE_ACCOUNT to the account you made for releases (${RELEASE_ACCOUNT_DOCS})`,
            action: { label: 'Open the steps', url: RELEASE_ACCOUNT_DOCS_URL },
          },
        ];
      }
      if (probe.ok) return [{ ok: true, says: `${probe.account} (uid ${probe.uid}) builds releases in ${probe.home}`, fixed: 'The release account is fit to build releases again' }];
      return [{ ok: false, severity: 'warning', ...releaseAccountFix(probe) }];
    },
  };
}
