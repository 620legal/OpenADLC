import {
  ACCOUNT_NAME,
  ENTERABLE,
  READABLE,
  accountEnv,
  asAccount,
  homeOf,
  nodeProcesses,
  probeAccount,
  type AccountPlaces,
  type AccountProblem,
  type HostProcesses,
} from './account-probe.js';

/**
 * The OS account a release is built in (`OPENADLC_RELEASE_ACCOUNT`), and the
 * proof that it is fit to be (#341,
 * docs/adr/0068-a-release-is-built-in-its-own-account-and-signed-from-fields-hostd-computes.md).
 *
 * A release builds only a merged commit on the default branch, and its
 * account keeps its build tree between releases so a build can be
 * incremental. That is why it is a second account and never the host
 * check's: the host check runs pull request code, which, in the same account
 * or one that can write the release's home, could leave a step in that tree
 * for the next release build to run and sign.
 *
 * No release runs yet; the run (`release-run.ts`) calls `probe` before every
 * one and refuses it on a failure, as `HostChecks.execute` does.
 */

/** What the release account's probe found: the host check's problems, and two of its own. */
export type ReleaseAccountProbe =
  | { ok: true; account: string; uid: number; home: string }
  | { ok: false; account: string; problem: AccountProblem | 'host_check_account' | 'host_check_reaches'; path?: string; detail: string };

export interface ReleaseAccountDeps {
  /** The account releases are built in. */
  account: string;
  /** The account host checks run as (`OPENADLC_HOST_CHECK_ACCOUNT`), which the release account must be apart from; null for none. */
  hostCheckAccount: string | null;
  /** What it must not reach, the same the host check's account is held to. */
  places: AccountPlaces;
  processes?: HostProcesses;
}

/** The variable a person sets to name the release account. */
export const RELEASE_ACCOUNT_SETTING = 'OPENADLC_RELEASE_ACCOUNT';

export class ReleaseAccount {
  private readonly processes: HostProcesses;

  constructor(private readonly deps: ReleaseAccountDeps) {
    this.processes = deps.processes ?? nodeProcesses();
  }

  get account(): string {
    return this.deps.account;
  }

  /**
   * Whether the account is fit to build a release, proved by its effect: it
   * passes everything the host check's account must (`probeAccount`), is not
   * the host check's account by name or by uid, and the host check's account
   * can neither read nor enter its home. Answered to the bridge's health check
   * (`GET /release/account`).
   */
  async probe(): Promise<ReleaseAccountProbe> {
    const { account, hostCheckAccount } = this.deps;
    const fail = (problem: Exclude<ReleaseAccountProbe, { ok: true }>['problem'], detail: string, path?: string): ReleaseAccountProbe => ({
      ok: false,
      account,
      problem,
      detail,
      ...(path ? { path } : {}),
    });
    const other = hostCheckAccount && ACCOUNT_NAME.test(hostCheckAccount) ? hostCheckAccount : null;
    if (other && ACCOUNT_NAME.test(account) && account.toLowerCase() === other.toLowerCase()) {
      return fail('host_check_account', `${account} is the account host checks run as, which runs pull request code; make an account only for releases`);
    }
    const fit = await probeAccount(account, RELEASE_ACCOUNT_SETTING, this.deps.places, this.processes, (home) => accountEnv(account, home));
    if (!fit.ok) return fit;
    if (!other) return fit;

    // A second name can share a uid (two passwd entries, one id), and the
    // system sees one account where the names say two.
    const id = await this.processes.run(['id', '-u', other]);
    const otherUid = Number.parseInt(id.stdout.trim(), 10);
    if (id.code !== 0 || !Number.isInteger(otherUid)) return fit;
    if (otherUid === fit.uid) return fail('host_check_account', `${account} has uid ${fit.uid}, the same as ${other}, which host checks run as; make an account only for releases`);

    // The one reach the host check's probe has no counterpart for, and the
    // reason for a second account: pull request code, running as the host
    // check's account, must not write a step into the release's kept tree.
    // Skipped when hostd cannot run anything as that account: then no pull
    // request code runs there either, since a host check refuses its run on
    // the same failed sudo. A skipped check passes, so this is said here.
    const otherHome = (await homeOf(other, this.processes)) ?? '/';
    const as = (argv: string[]) => asAccount(other, accountEnv(other, otherHome), argv);
    const can = await this.processes.run(as(['/usr/bin/true']), { timeoutMs: 30_000 });
    if (can.code !== 0) return fit;
    const asIt = (script: string) => this.processes.run(as(['/bin/sh', '-c', script, 'sh', fit.home]), { timeoutMs: 30_000 });
    if ((await asIt(READABLE)).code === 0) {
      return fail('host_check_reaches', `${other}, which host checks run as, can read ${fit.home}, so pull request code could change what the next release builds`, fit.home);
    }
    if ((await asIt(ENTERABLE)).code === 0) {
      return fail('host_check_reaches', `${other}, which host checks run as, can enter ${fit.home}, so pull request code could change what the next release builds`, fit.home);
    }
    return fit;
  }
}
