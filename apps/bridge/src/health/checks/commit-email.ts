import { GITHUB_EMAIL_SETTINGS_URL, type Bot } from '@fleetadlc/shared';
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
 * merge, which carry the account's default commit email. The bots' own
 * pushes use `<login>@users.noreply.github.com` (hostd's session-env), so
 * they say nothing about the account's setting.
 */
function writtenByGitHub(commit: ListedCommit): boolean {
  return commit.committer?.login === 'web-flow' || commit.commit?.committer?.email === 'noreply@github.com';
}

/**
 * Each crew account keeps its email address private, proved by the newest
 * commit GitHub wrote for it.
 *
 * The walkthrough suggests a plus-tag of the operator's own mailbox for each
 * account. GitHub writes the crew's squash merges and update-branch merges
 * with the account's default commit email, so unless the account keeps it
 * private every merged crew pull request in a public repository publishes the
 * operator's address. The setting itself cannot be read without the "Email
 * addresses" permission, which OpenADLC does not ask for, so this reads its
 * effect: the address on the last commit GitHub wrote for the account.
 *
 * A warning, never blocking: the crew's work does not depend on it. The card
 * never repeats the address, since cards are sent through the notifier. It is
 * about a commit already written, which turning the setting on does not
 * change, so it offers Dismiss (`history`) rather than a Check again that
 * cannot pass until the next merge.
 */
export function commitEmailCheck(reader: CommitEmailReader): HealthCheck {
  return {
    id: 'commit-email',
    proves: 'The commits GitHub writes for each crew account carry its private noreply address, not the account’s own email',
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
        const facts = { login, repo: newest.repo.name, sha, occurrence: sha };
        const email = (newest.commit.commit?.author?.email ?? '').toLowerCase();
        if (email.endsWith('users.noreply.github.com')) {
          return { subject, ok: true, fixed: `GitHub writes ${login}’s commits with its private address`, facts };
        }
        return {
          subject,
          ok: false,
          severity: 'warning',
          title: `${login}’s email address is public on its commits in ${newest.repo.fullName}`,
          detail:
            `GitHub wrote commit ${sha.slice(0, 7)} for ${login} with the account’s own email address rather than its private ` +
            'noreply one, so every crew pull request merged there publishes it. Sign in to GitHub as ' +
            `${login}, open its email settings, and tick “Keep my email addresses private” and “Block command line ` +
            'pushes that expose my email”. Commits already written keep the address they have.',
          action: { label: 'Open GitHub’s email settings', url: GITHUB_EMAIL_SETTINGS_URL },
          facts,
        };
      });
    },
  };
}
