import type { CheckResult, HealthCheck } from '../types.js';

export interface RepoOwnerReader {
  repos(): Promise<{ fullName: string; ownerBotId: string | null }[]>;
}

/**
 * Each repository has a bot that owns its building.
 *
 * The dispatcher staffs a repository from its owner and every other bot with
 * the owner's role, and skips one with no owner without recording why. A
 * `config/repos.yaml` entry whose `owner` named no seat — `buidler` — was
 * stored with none, so nothing ever built there and the board said nothing.
 */
export function repoOwnerCheck(reader: RepoOwnerReader): HealthCheck {
  return {
    id: 'repo-owner',
    proves: 'Each repository has a bot that owns its building, so the dispatcher leases its issues',
    how: 'reads each repository’s owner from the platform database',
    everyMinutes: 15,
    steps: [],
    async run() {
      const results: CheckResult[] = [];
      for (const repo of await reader.repos()) {
        const subject = repo.fullName;
        if (repo.ownerBotId) {
          results.push({ subject, ok: true, fixed: `${repo.fullName} has an owner again: its issues are leased` });
          continue;
        }
        results.push({
          subject,
          ok: false,
          severity: 'blocking',
          title: `Nothing builds in ${repo.fullName}: no bot owns it`,
          detail:
            'The dispatcher leases a repository’s issues to its owner and the bots that share the owner’s role, and skips one ' +
            'with no owner. Set its `owner` in config/repos.yaml to a seat from config/bots.yaml, such as `builder`, and run ' +
            '`fleetadlc seed`: a repository listed there takes the file’s settings at every `fleetadlc up`. One that is not ' +
            'listed there is given the builder when it is added again in Settings → Repositories.',
          action: { label: 'Seed the repositories again', command: 'fleetadlc seed' },
          facts: { repository: repo.fullName },
        });
      }
      return results;
    },
  };
}
