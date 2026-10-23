import type { GitHubClient } from '@openadlc/github';
import { parseHumanReviewPaths, unreadableHumanReviewLines, type HumanReviewRule, type RulesUnreadCause } from '@openadlc/shared';
import type { Actors } from './actors.js';
import { automationBotName } from './automation-bot.js';
import type { BridgeConfig } from './config.js';

/**
 * A repository's Human-review rules on a branch, or why they could not be
 * read: what a plan change's card, the issue and the designer's brief say
 * (`keptForPerson`). `unread` null is a cause the bridge cannot tell.
 *
 * The merge gate reads the same file the same way (`Automation.humanReviewRules`)
 * and needs only whether it was read. The plan-change message said "add a
 * `## Human review` section … the repository’s card in Needs you names it"
 * whatever went wrong, and on a scratch install, where no account could read
 * AGENTS.md, neither was true and no such card existed.
 */
export type HumanReviewRead = { rules: HumanReviewRule[]; unread: null } | { rules: null; unread: RulesUnreadCause | null };

/** GitHub's status for a failed call, or null when it gave none. */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Whether GitHub refused the account, rather than failing: a 401 or a 404, or
 * a 403 that is not its rate limit, which GitHub answers with a 403 too.
 */
function refused(error: unknown, status: number | null): status is number {
  if (status === 401 || status === 404) return true;
  return status === 403 && !/rate limit/i.test(error instanceof Error ? error.message : String(error));
}

function unread(cause: RulesUnreadCause): HumanReviewRead {
  return { rules: null, unread: cause };
}

/**
 * Reads `AGENTS.md` on `baseRef` as `account`, through `client` (null when it
 * is not connected), and says which of these kept the rules from being read:
 * no account, an account GitHub refused, no file, no section, a line the
 * parser cannot read, or another answer from GitHub. GitHub answers 404 for a
 * file in a repository the account cannot see as for one that is not there,
 * so on a 404 the repository is asked for too: only one it can read is said
 * to have no AGENTS.md.
 */
export async function readHumanReviewRules(
  client: Pick<GitHubClient, 'readFileIfPresent' | 'request'> | null,
  account: string,
  repoFullName: string,
  baseRef: string,
): Promise<HumanReviewRead> {
  if (!client) return unread({ cause: 'no-account', account });
  let agents: string | null;
  try {
    agents = await client.readFileIfPresent(repoFullName, 'AGENTS.md', baseRef);
  } catch (error) {
    const status = statusOf(error);
    return unread(refused(error, status) ? { cause: 'no-access', account, status } : { cause: 'read-failed', status });
  }
  if (agents === null) {
    try {
      await client.request('GET', `/repos/${repoFullName}`);
    } catch (error) {
      const status = statusOf(error);
      return unread(refused(error, status) ? { cause: 'no-access', account, status } : { cause: 'read-failed', status });
    }
    return unread({ cause: 'no-file' });
  }
  const rules = parseHumanReviewPaths(agents);
  if (rules) return { rules, unread: null };
  const line = unreadableHumanReviewLines(agents)[0];
  return unread(line ? { cause: 'unreadable-line', line: line.line, reason: line.reason } : { cause: 'no-section' });
}

/** The rules as the automation account reads them, which is the account the merge gate reads them as. */
export function humanReviewReader(actors: Pick<Actors, 'asBot'>, config: Pick<BridgeConfig, 'automationBot'>): (repoFullName: string, baseRef: string) => Promise<HumanReviewRead> {
  return async (repoFullName, baseRef) => {
    const account = await automationBotName(config);
    const client = await actors.asBot(account).catch(() => null);
    return readHumanReviewRules(client, account, repoFullName, baseRef);
  };
}
