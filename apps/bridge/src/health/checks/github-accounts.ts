import type { CheckResult, HealthCheck } from '../types.js';
import { stepHref } from '../words.js';

/** How many connected accounts the walkthrough asks for before Crew can assign seats. */
export const GITHUB_ACCOUNTS_NEEDED = 2;

export interface HeldGitHubAccount {
  login: string;
  /**
   * `signed-in` is a sign-in GitHub still accepts; `unknown` is one GitHub
   * could not be asked about — unreachable, or answering with an outage.
   */
  signIn: 'signed-in' | 'needs-reconnecting' | 'not-signed-in' | 'unknown';
}

export interface GitHubAccountReader {
  accounts(): Promise<HeldGitHubAccount[]>;
}

/** Whether the install holds enough working GitHub accounts for the step to be done. */
export function githubAccountsReady(accounts: readonly Pick<HeldGitHubAccount, 'signIn'>[]): boolean {
  return accounts.filter((account) => account.signIn === 'signed-in').length >= GITHUB_ACCOUNTS_NEEDED;
}

/**
 * The GitHub accounts step is two accounts that can still sign in, not a seat
 * on each. Seats are the Crew step (`bot-sign-in`, `signing-key`). This check
 * used to be those two, so the step stayed open until every seat was connected
 * and a person connecting two accounts never saw it tick.
 */
export function githubAccountsCheck(reader: GitHubAccountReader): HealthCheck {
  return {
    id: 'github-accounts',
    proves: 'Two GitHub accounts are connected, one to do the work and one to approve it',
    how: 'reads the accounts OpenADLC holds and whether each sign-in still works',
    everyMinutes: 10,
    steps: ['github-accounts'],
    async run(): Promise<CheckResult[]> {
      const accounts = await reader.accounts();
      const working = accounts.filter((account) => account.signIn === 'signed-in');
      if (githubAccountsReady(accounts)) {
        return [{ ok: true, fixed: 'Two GitHub accounts are connected' }];
      }
      // Two only if one GitHub could not be asked about works: no answer,
      // rather than a reconnect a GitHub outage does not need.
      const unknown = accounts.filter((account) => account.signIn === 'unknown');
      if (unknown.length > 0 && working.length + unknown.length >= GITHUB_ACCOUNTS_NEEDED) {
        return [{ ok: null, reason: `GitHub could not be asked whether ${unknown.map((account) => account.login).join(', ')} can still sign in` }];
      }
      // One working sign-in beside a stored account GitHub has refused is not
      // "only one connected": that title sent people to add an account they
      // already hold. Any held account that is not signed in is a reconnect,
      // including when another sign-in still works. Several dead accounts are
      // one card, which names each: "Reconnect it" left a person holding four
      // accounts to guess which.
      const dead = accounts.filter((account) => account.signIn !== 'signed-in' && account.signIn !== 'unknown').map((account) => account.login);
      const stopped = dead.length > 0;
      const onlyOne = working.length + unknown.length === 1 && !stopped;
      return [
        {
          ok: false,
          severity: 'blocking',
          title: stopped
            ? dead.length === 1
              ? `The GitHub sign-in for ${dead[0]} stopped working`
              : `GitHub sign-ins stopped working: ${dead.join(', ')}`
            : onlyOne
              ? 'Only one GitHub account is connected'
              : 'No GitHub account is connected',
          detail: stopped
            ? `Reconnect ${dead.join(' and ')}. A sign-in GitHub no longer accepts does not count, and this step needs two that do.`
            : 'Connect two accounts: one that does the work and one that approves it. ' +
              'GitHub will not let the account that opened a pull request approve it.',
          action: {
            label: stopped ? 'Reconnect a GitHub account' : 'Connect a GitHub account',
            href: stepHref('github-accounts'),
          },
        },
      ];
    },
  };
}
