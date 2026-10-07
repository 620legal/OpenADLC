import { signInKind } from './sign-in.js';
import { bots, costs, credentials, hosts, issues, lastJobRuns, leases, listEvents, sessions, tasks, threads } from '@fleetadlc/db';
import { STAGE_COLUMN_TITLES, STAGE_KEYS, type StageKey } from '@fleetadlc/shared';
import type { BridgeConfig } from './config.js';
import type { HostdClient } from './hostd-client.js';
import { describeIdentity } from './identity.js';
import type { Drift } from './reconciler.js';
import { SCHEDULED_JOBS } from './scheduler.js';
import { shownIssues } from './work.js';

/**
 * Report what a bot can actually do. A device-flow install has a row recording
 * the authorization; an install holding a non-expiring user token has only the
 * secret, and saying "unauthorized" about a bot that is working is a lie.
 */
export async function authorizationOf(
  bot: { id: string; name: string },
  recorded: string | undefined,
): Promise<'active' | 'expired' | 'revoked' | 'unauthorized'> {
  if (recorded && recorded !== 'unauthorized') return recorded as 'active' | 'expired' | 'revoked';
  // Wherever its sign-in is filed: a seat on a shared account has none of its own name.
  return (await signInKind(bot)) ? 'active' : 'unauthorized';
}

export interface StatusReport {
  generatedAt: string;
  hosts: { name: string; driver: string; status: string; lastSeenAt: string | null }[];
  hostd: { ok: boolean; driver?: string };
  crew: {
    name: string;
    displayName: string;
    role: string;
    engine: string;
    status: string;
    now: string;
    /**
     * The running or paused task's subject (`<repo name>#N`), and whether it
     * waits on a person; null when nothing is running. The status issue builds
     * its own `now` from these, since it shows only its repository's subjects.
     */
    subjectRef: string | null;
    paused: boolean;
    githubLogin: string | null;
    authorization: string;
    sessions: number;
  }[];
  board: Record<StageKey, number>;
  budget: { period: string; capUsd: number; spentUsd: number; state: string };
  openGates: number;
  activeLeases: number;
  recentEvents: { source: string; type: string; at: string }[];
  /**
   * How this install decides who a request is. Worth showing rather than
   * assuming: the difference between a verified assertion and a header anyone
   * can set is the difference between knowing who answered a gate and not.
   */
  identity: { mode: string; detail: string };
  /** Every scheduled job, and when it last ran; `null` means never. */
  jobs: { job: string; lastRunAt: string | null }[];
}

/**
 * The report the status job writes into the issue named by
 * FLEETADLC_STATUS_ISSUE, when one is set, and that `GET /v1/status` returns
 * and `fleetadlc status` prints. Everything here is derived, never authored: what hostd sees, what GitHub said,
 * what the ledger recorded.
 */
export async function buildStatus(config: BridgeConfig, hostd: HostdClient): Promise<StatusReport> {
  const runs = await lastJobRuns().catch(() => []);
  const [hostList, crew, health, allIssues, activeLeases, events] = await Promise.all([
    hosts.listHosts(),
    bots.listBots(),
    hostd.health(),
    issues.listIssues(),
    leases.listActiveLeases(),
    listEvents(10),
  ]);

  const period = costs.currentPeriod();
  const budget =
    (await costs.getBudget(period)) ??
    (await costs.ensureBudget(period, config.costs.monthlyCapUsd, config.costs.warningAt));

  const board = Object.fromEntries(STAGE_KEYS.map((stage) => [stage, 0])) as Record<StageKey, number>;
  // As the board counts them: not an issue labelled `fleetadlc:ignore`.
  for (const issue of shownIssues(allIssues)) board[issue.stage] += 1;

  const openGates = (await threads.listOpenGates()).length;

  const crewStatus = await Promise.all(
    crew.map(async (bot) => {
      const botSessions = await sessions.listSessions(bot.id);
      const running = await tasks.listTasks({ botId: bot.id, states: ['running', 'paused'], limit: 1 });
      const credential = await credentials.getCredential(bot.id);
      const current = running[0];

      return {
        name: bot.name,
        displayName: bot.displayName,
        role: bot.role,
        engine: bot.engine,
        status: bot.status,
        now: current
          ? `${current.skill ?? current.kind} on ${current.subjectRef}${current.state === 'paused' ? ' (waiting on a person)' : ''}`
          : botSessions.length > 0
            ? 'idle in a shell'
            : 'nothing running',
        subjectRef: current?.subjectRef ?? null,
        paused: current?.state === 'paused',
        githubLogin: bot.githubLogin,
        authorization: await authorizationOf(bot, credential?.status),
        sessions: botSessions.length,
      };
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    hosts: hostList.map((host) => ({
      name: host.name,
      driver: host.driver,
      status: host.status,
      lastSeenAt: host.lastSeenAt,
    })),
    hostd: { ok: health.ok, driver: health.driver },
    crew: crewStatus,
    board,
    budget,
    openGates,
    activeLeases: activeLeases.length,
    recentEvents: events.map((event) => ({ source: event.source, type: event.type, at: event.at })),
    jobs: SCHEDULED_JOBS.map((job) => ({
      job,
      lastRunAt: runs.find((run: { job: string; at: string }) => run.job === job)?.at ?? null,
    })),
    identity: {
      mode: config.identityMode,
      detail: describeIdentity(config.identityMode, config.iapAudience),
    },
  };
}

/**
 * The status issue's body. The issue is in one repository, which may be public
 * while the install's others are private, so it carries only that repository's
 * subjects: a bot working elsewhere is "working in another repository", and no
 * host is named. It used to publish every repository's issue numbers and every
 * host's machine name wherever the issue lived. `/v1/status` keeps them all for
 * the console.
 */
export function renderStatusMarkdown(status: StatusReport, target: { repo: string }): string {
  const columns = STAGE_KEYS.map((stage) => `${STAGE_COLUMN_TITLES[stage]} ${status.board[stage]}`).join(' · ');
  const crew = status.crew
    .map((bot) => `| ${bot.displayName} | ${bot.role} | ${bot.engine} | ${publicNow(bot, target.repo)} | ${bot.authorization} |`)
    .join('\n');

  return [
    `_Regenerated ${status.generatedAt}. GitHub is the system of record; this is a view._`,
    '',
    `**Board:** ${columns}`,
    `**Spend:** $${status.budget.spentUsd.toFixed(2)} of $${status.budget.capUsd.toFixed(2)} (${status.budget.state}) · **gates open:** ${status.openGates} · **active leases:** ${status.activeLeases}`,
    '',
    '| bot | role | engine | now | github |',
    '|---|---|---|---|---|',
    crew,
  ].join('\n');
}

function publicNow(bot: StatusReport['crew'][number], repo: string): string {
  if (!bot.subjectRef || subjectIn(bot.subjectRef, repo)) return bot.now;
  return `working in another repository${bot.paused ? ' (waiting on a person)' : ''}`;
}

/**
 * Whether a subject is the repository's: `<name>#N`, as tasks and drift name
 * an issue, or the repository itself by name or full name. Anything else, a
 * host or a bot included, is not.
 */
function subjectIn(subject: string, fullName: string): boolean {
  const name = fullName.split('/').pop() ?? fullName;
  const lower = subject.toLowerCase();
  return lower.startsWith(`${name.toLowerCase()}#`) || lower === name.toLowerCase() || lower === fullName.toLowerCase();
}

/**
 * What reconcile may post on the status issue: the target repository's drift,
 * and how many other entries need a person, without their subjects. The
 * comment used to list every repository's drift there.
 */
export function statusDrift(drift: readonly Drift[], target: { repo: string }): { entries: Drift[]; others: number } {
  const entries = drift.filter((entry) => subjectIn(entry.subject, target.repo));
  const others = drift.filter((entry) => !entry.repaired && !subjectIn(entry.subject, target.repo)).length;
  return { entries, others };
}

/**
 * Which issue `FLEETADLC_STATUS_ISSUE` names: `owner/name#N`, in one of the
 * install's repositories. A bare number used to go to whichever repository
 * sorted first by name, so adding one moved it, and the status job then
 * rewrote an unrelated issue or pull request with the install's spend and
 * crew. A bare number is refused even on an install with one repository: its
 * meaning would change the day a second is added. `null` when unset; a refusal
 * says what to set, and nothing is written.
 */
export function statusIssueTarget(
  value: string | undefined,
  managedRepos: readonly { fullName: string }[],
): { repo: string; number: number } | { refusal: string } | null {
  const raw = value?.trim();
  if (!raw) return null;
  const must = "it must be <owner>/<name>#<number>, naming one of this install's repositories; nothing was written";
  const named = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(value!);
  if (!named) return { refusal: `FLEETADLC_STATUS_ISSUE is ${JSON.stringify(value)}; ${must}` };
  const repo = managedRepos.find((one) => one.fullName.toLowerCase() === named[1]!.toLowerCase());
  if (!repo) return { refusal: `FLEETADLC_STATUS_ISSUE names ${named[1]}, which this install does not manage; ${must}` };
  return { repo: repo.fullName, number: Number(named[2]) };
}
