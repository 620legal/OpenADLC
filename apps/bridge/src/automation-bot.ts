import { bots } from '@fleetadlc/db';
import type { GitHubClient } from '@fleetadlc/github';
import { automationBotOf, carriesDedupeMarker, type Bot } from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';

/**
 * The one place the bridge decides which bot is the automation account: the
 * account that writes labels, assignments, reviewer requests and the
 * review-gate status, and that the bridge reads GitHub with.
 *
 * It is the bot whose role is `automation`, whatever it is called this
 * minute — its name is its account's handle once one connects. An install can
 * name another, as a seat or a name, in the console's settings or with
 * `FLEETADLC_AUTOMATION_BOT`, and that wins when it names a bot this install has.
 * An `install.json` from an older `fleetadlc init` may still say `flow`, which
 * is read as the seat that persona was; an override that names nobody is
 * ignored.
 *
 * Asked per call rather than at start-up, because the name moves when an
 * account connects, and a name held from before would act as nobody.
 */

/** The seat the automation account is seeded in, for when nothing else can be said. */
export const AUTOMATION_SEAT = 'automation';

type Configured = Pick<BridgeConfig, 'automationBot'>;

/** The override, as the console's settings or the environment give it. */
async function override(config: Configured): Promise<string | null> {
  try {
    return (await effectiveConfig(config as BridgeConfig)).automationBot;
  } catch {
    return config.automationBot ?? null;
  }
}

/** The automation bot's row, or null when this install has none it can read. */
export async function automationBot(config: Configured): Promise<Bot | null> {
  const wanted = await override(config);
  try {
    return automationBotOf(await bots.listBots(), wanted);
  } catch {
    return null;
  }
}

/**
 * Its name, for acting as it and for saying who acted. A crew that cannot be
 * read still gets an answer — the override, or the seat — so a message that
 * names the account to connect is never empty.
 */
export async function automationBotName(config: Configured): Promise<string> {
  const bot = await automationBot(config);
  return bot?.name ?? (await override(config)) ?? AUTOMATION_SEAT;
}

/** A GitHub client acting as the automation account, or null when it is not connected. */
export async function asAutomation(actors: Pick<Actors, 'asBot'>, config: Configured): Promise<GitHubClient | null> {
  return actors.asBot(await automationBotName(config));
}

/** The automation account's GitHub login, or null when none is connected or the crew cannot be read. */
export async function automationLogin(config: Configured): Promise<string | null> {
  return (await automationBot(config))?.githubLogin ?? null;
}

/** How many pages of an account's open issues `findOwnOpenIssue` reads: five thousand. */
const OWN_ISSUE_PAGES = 50;

/**
 * The open issue OpenADLC's own account filed that carries a dedupe marker,
 * or null: what an alert, a scheduled job's report and a failed deploy's
 * issue are checked against before they are filed again.
 *
 * Only `author`'s issues count, and every page of them. The markers are fixed
 * strings in the public source, or built from public commit SHAs, and they do
 * not render: any issue or pull request carrying one, a stranger's included,
 * kept OpenADLC from ever filing that notice. And one page of everyone's
 * issues lost OpenADLC's own past the first hundred, so it filed them again.
 * With no author known nothing counts, and the notice is filed: a duplicate
 * is better than an alert nobody sees.
 */
export async function findOwnOpenIssue(
  client: { request<T>(method: string, path: string): Promise<T> },
  repoFullName: string,
  author: string | null,
  kind: string,
  key: string,
  options: { label?: string } = {},
): Promise<number | null> {
  if (!author) return null;
  const label = options.label ? `&labels=${encodeURIComponent(options.label)}` : '';
  for (let page = 1; page <= OWN_ISSUE_PAGES; page += 1) {
    const listed = await client.request<{ number: number; body: string | null; user?: { login?: string } | null }[]>(
      'GET',
      `/repos/${repoFullName}/issues?state=open&creator=${encodeURIComponent(author)}${label}&per_page=100&page=${page}`,
    );
    // Checked here as well, so the answer does not rest on the filter alone.
    const found = listed.find(
      (issue) => issue.user?.login?.toLowerCase() === author.toLowerCase() && carriesDedupeMarker(issue.body, kind, key),
    );
    if (found) return found.number;
    if (listed.length < 100) return null;
  }
  return null;
}
