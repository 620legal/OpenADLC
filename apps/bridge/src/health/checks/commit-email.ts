import { GITHUB_EMAIL_SETTINGS_URL, type Bot } from '@openadlc/shared';
import type { CheckResult, HealthCheck } from '../types.js';
import { GITHUB_CALLS_AT_ONCE, SLOW_CHECK_MS, mapLimited } from '../limited.js';
import type { GitHubLike, RepoRef } from './crew.js';

export interface CommitEmailReader {
  crew(): Promise<Bot[]>;
  repositories(): Promise<RepoRef[]>;
  /** A token that acts as the bot. Throws when it has no working sign-in. */
  token(bot: Bot): Promise<string>;
  github(token: string, login: string): GitHubLike;
}

/** Just the parts of GitHub's commit listing this reads. */
interface ListedCommit {
  sha: string;
  html_url?: string;
  commit?: {
    author?: { email?: string | null } | null;
    committer?: { email?: string | null; date?: string | null } | null;
  };
  committer?: { login?: string | null } | null;
}

/**
 * Whether GitHub wrote the commit itself: a squash merge or an update-branch
 * merge. The bots' own pushes use `<login>@users.noreply.github.com`
 * (hostd's session-env), so they say nothing about the account's setting.
 */
function writtenByGitHub(commit: ListedCommit): boolean {
  return commit.committer?.login === 'web-flow' || commit.commit?.committer?.email === 'noreply@github.com';
}

/** A moment as a card says it: `2026-10-20 09:41 UTC`. */
function utc(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The newest commit GitHub wrote for each crew account carries its noreply
 * address, not the account's own email.
 *
 * The walkthrough suggests a plus-tag of the operator's own mailbox for each
 * account. GitHub writes the crew's squash merges (authored by the pull
 * request's author, whoever merges it) and the merge line's update-branch
 * merges (authored by the account that asked) with that account's primary
 * email, unless the account ticked "Keep my email addresses private": then
 * with its noreply address, and no other can be chosen
 * (https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address,
 * https://docs.github.com/en/account-and-profile/concepts/email-addresses).
 * GitHub's merge and update-branch endpoints take no author. A commit keeps
 * the address it was written with, so one written before the box was ticked
 * carries the account's own address for good.
 *
 * The setting itself cannot be read without the "Email addresses" permission,
 * which OpenADLC does not ask for, so this reads its effect, and the card says
 * only what that proves: this commit, written then, carries the address. It
 * said the setting was off, and sent a person who had already ticked it back
 * to tick it again (#128). It offers the way out for both cases, and the one
 * that works whatever GitHub does: a primary email that is fine to publish.
 *
 * A warning, never blocking: the crew's work does not depend on it. The card
 * never repeats the address, since cards are sent through the notifier. It is
 * about a commit already written, which turning the setting on does not
 * change, so it offers Dismiss (`history`) rather than a Check again that
 * cannot pass until the next merge; it clears by itself once the newest
 * commit GitHub wrote for the account carries the noreply address.
 */
export function commitEmailCheck(reader: CommitEmailReader): HealthCheck {
  return {
    id: 'commit-email',
    proves: 'The newest commit GitHub wrote for each crew account carries its noreply address, not the account’s own email',
    how: 'lists each crew account’s commits in each repository and reads the author email on the newest one GitHub wrote',
    everyMinutes: 60,
    steps: ['github-accounts'],
    history: true,
    timeoutMs: SLOW_CHECK_MS,
    async run() {
      const [crew, repositories] = await Promise.all([reader.crew(), reader.repositories()]);
      if (repositories.length === 0) return [];
      // Several seats can share one account; it is asked about once.
      const byLogin = new Map<string, Bot>();
      for (const bot of crew) {
        if (bot.githubLogin && !byLogin.has(bot.githubLogin.toLowerCase())) byLogin.set(bot.githubLogin.toLowerCase(), bot);
      }

      return mapLimited([...byLogin.values()], GITHUB_CALLS_AT_ONCE, async (bot): Promise<CheckResult> => {
        const login = bot.githubLogin!;
        const subject = login.toLowerCase();
        let github: GitHubLike;
        try {
          github = reader.github(await reader.token(bot), login);
        } catch {
          return { subject, ok: null, reason: `${login} has no working sign-in to ask GitHub with` };
        }

        let newest: { repo: RepoRef; commit: ListedCommit; at: number } | null = null;
        let asked = 0;
        for (const repo of repositories) {
          const listed = await github
            .request<ListedCommit[]>('GET', `/repos/${repo.fullName}/commits?author=${encodeURIComponent(login)}&per_page=20`)
            .catch(() => null);
          if (!listed) continue;
          asked += 1;
          for (const commit of listed) {
            if (!writtenByGitHub(commit)) continue;
            const at = Date.parse(commit.commit?.committer?.date ?? '');
            if (!Number.isFinite(at)) continue;
            if (!newest || at > newest.at) newest = { repo, commit, at };
          }
        }
        if (asked === 0) return { subject, ok: null, reason: `GitHub could not be asked for ${login}’s commits` };
        if (!newest) return { subject, ok: null, reason: `GitHub has written no commit for ${login} yet` };

        const sha = newest.commit.sha;
        const short = sha.slice(0, 7);
        const facts = { login, repo: newest.repo.name, sha, occurrence: sha };
        const email = (newest.commit.commit?.author?.email ?? '').toLowerCase();
        if (email.endsWith('users.noreply.github.com')) {
          return { subject, ok: true, fixed: `The newest commit GitHub wrote for ${login} carries its noreply address`, facts };
        }
        return {
          subject,
          ok: false,
          severity: 'warning',
          title: `${login}’s own email address is on commit ${short} in ${newest.repo.fullName}`,
          detail:
            `GitHub wrote commit ${short} for ${login} on ${utc(newest.at)} with the account’s own email address, not its ` +
            'noreply one. GitHub writes the noreply address on the commits it makes for an account — the squash merges of ' +
            'its pull requests, and the branch updates made as it — only while “Keep my email addresses private” is ' +
            'ticked in that account’s email settings, and a commit keeps the address it was written with. ' +
            `Signed in to GitHub as ${login}, open its email settings. If the box is not ticked, tick it, and “Block ` +
            'command line pushes that expose my email”. If it is already ticked, Dismiss this card: it clears by itself ' +
            `once GitHub writes ${login}’s next commit with the noreply address. If a commit GitHub writes after the box ` +
            'was ticked still carries the address, make the account’s primary email one that is fine to publish, since ' +
            'that is the address GitHub writes when it does not write the noreply one.',
          action: { label: 'Open GitHub’s email settings', url: GITHUB_EMAIL_SETTINGS_URL },
          facts,
        };
      });
    },
  };
}
