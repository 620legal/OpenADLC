import { audit, bots, leases, repos, tasks, threads } from '@fleetadlc/db';
import {
  GitHubApiError,
  GitHubClient,
  appPrivateKeyRef,
  getSecretStore,
  installationTokenFor,
  type PendingInvitation,
} from '@fleetadlc/github';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_STAGE_LABEL_PREFIX, PERMISSION_NAMES, RENAMED_LABELS, accessInWords, sameLogin, type TaskState } from '@fleetadlc/shared';
import type { AppReach } from './app-reach.js';
import type { BridgeConfig } from './config.js';
import type { CrewAccessKeeper } from './crew-access.js';
import { effectiveConfig } from './effective-config.js';
import { APP_API } from './invitation-service.js';

/**
 * Taking a repository out of OpenADLC, in one flow that leaves nothing of OpenADLC
 * still acting on it.
 *
 * "Remove from OpenADLC" used to mark the repository removed and stop there. On
 * an install that removed two repositories, four tasks stayed paused on them
 * and were cancelled through hostd's internal API by hand; three questions on
 * them stayed in Needs you, about a repository that was gone; three leases
 * stayed `in_task` on its issues; and the crew's accounts were still
 * collaborators with write access, taken off with the GitHub API by hand.
 *
 * So the flow is two calls. `preview` reads what the repository has now and
 * changes nothing: the console shows it before anything is pressed. `remove`
 * marks it removed first, so nothing new starts while the rest runs, then
 * stops its work through the same path as a card's Stop, closes its
 * questions, releases its leases and, when asked, takes the crew off it and
 * deletes OpenADLC's labels. A step that fails does not stop the others: what
 * was not done comes back, and goes in the audit, with the thing that
 * finishes it. Running it again on a removed repository does what is left.
 *
 * Its workflows, environments and Actions variables are never touched: they
 * are the repository's own, and it may still deploy with them.
 */

/**
 * Names in `config/labels.json` a repository may well have had before OpenADLC:
 * setting up takes over a label of the same name rather than making its own,
 * so deleting one may delete the repository's. They are offered on their own,
 * unticked.
 */
export const GENERIC_LABELS: readonly string[] = ['blocked', 'deps', 'safety', 'revert', 'breaking', 'incident', 'needs-triage', 'needs-human'];

/** The names in `config/labels.json`, which are the labels setting up a repository makes. */
export function configuredLabelNames(repoRoot: string): string[] {
  const specs = JSON.parse(readFileSync(join(repoRoot, 'config', 'labels.json'), 'utf8')) as { name: string }[];
  return specs.map((spec) => spec.name);
}

/** What the flow leaves alone, as the review step says it. */
export const LEFT_ALONE =
  'CI, deploy workflows, environments and Actions variables are the repository’s own. OpenADLC does not touch them, and they stay as they are.';

const UNFINISHED: TaskState[] = ['queued', 'running', 'paused'];

/** What a person chose in the review step. */
export interface RemovalOptions {
  /** Take the crew's accounts off the repository's collaborators and cancel their invitations. On by default. */
  crewAccess: boolean;
  /** Delete OpenADLC's labels, which takes them off every issue and pull request. Off by default. */
  labels: boolean;
  /** Delete, too, the labels that may be the repository's own (`LabelSort.maybeTheirs`). Off by default. */
  maybeTheirs?: boolean;
}

export const DEFAULT_REMOVAL: RemovalOptions = { crewAccess: true, labels: false, maybeTheirs: false };

/** What finishes a step the flow could not: removing again, or a page on GitHub. */
export type LeftoverAction = { label: string; retry: true } | { label: string; url: string };

/** One thing the flow did not do, why, and what finishes it. */
export interface Leftover {
  step: 'task' | 'question' | 'lease' | 'collaborator' | 'invitation' | 'label' | 'app';
  what: string;
  why: string;
  action: LeftoverAction;
}

/** Where the app stands with the repository after it leaves OpenADLC. */
export interface AppStanding {
  /** Installed on all of the account's repositories, so it still reaches this one; null when that could not be read. */
  allRepositories: boolean | null;
  /** The installation's page, where "Only select repositories" is chosen. */
  settingsUrl: string | null;
  reason: string | null;
}

export interface RemovalPreview {
  repository: string;
  removedAt: string | null;
  /** Queued, running and paused tasks, each with the question a paused one waits on. */
  tasks: { id: string; subject: string; kind: string; state: string; bot: string | null; question: string | null }[];
  /** Every question still open there, whichever task or thread asked it. */
  questions: { id: string; subject: string | null; question: string }[];
  leases: { id: string; issue: number; bot: string | null; state: string }[];
  /** The crew's accounts that are direct collaborators, or invited to be. */
  crew: {
    known: boolean;
    reason: string | null;
    accounts: { bots: string[]; login: string; state: 'collaborator' | 'invited' }[];
  };
  /** OpenADLC's labels on the repository, and apart from them those that may be the repository's own. */
  labels: { known: boolean; reason: string | null; names: string[]; maybeTheirs: string[] };
  app: AppStanding;
  leftAlone: string;
}

export interface RemovalReport {
  repo: repos.RepoRecord;
  options: RemovalOptions;
  stopped: { task: string; subject: string; was: string }[];
  questionsClosed: number;
  leasesReleased: number[];
  collaboratorsRemoved: string[];
  invitationsCancelled: string[];
  labelsRemoved: string[];
  app: AppStanding;
  notDone: Leftover[];
}

/** GitHub, as the app, for the calls the flow makes on one repository. */
export interface RemovalGitHub {
  /** The logins of the repository's direct collaborators: not a team, not an organization's base permission. */
  collaborators(): Promise<string[]>;
  removeCollaborator(login: string): Promise<void>;
  cancelInvitation(id: number): Promise<void>;
  labels(): Promise<string[]>;
  deleteLabel(name: string): Promise<void>;
}

export interface RepoRemovalDeps {
  /** Stops one unfinished task through the card's Stop (`stopTask` with `unfinished`). */
  stop(taskId: string, actor: string, note: string): Promise<{ state: string; questionsClosed: number }>;
  /** GitHub as the app on one repository; throws, in words, when OpenADLC cannot act as the app. */
  github(repository: string): Promise<RemovalGitHub>;
  /**
   * The repository's pending invitations, which only a person with admin on
   * it can list (`InvitationService.discover`): an app token cannot.
   */
  invitations?(repository: string): Promise<{ pending: PendingInvitation[]; reason: string | null }>;
  crewAccess?: Pick<CrewAccessKeeper, 'view' | 'forget'>;
  /** Whether the app's installation covers all the account's repositories. */
  app?(repository: string): Promise<AppStanding>;
  /** The labels setting up a repository makes: the names in `config/labels.json` (`configuredLabelNames`). */
  labelNames(): readonly string[];
}

const accessUrl = (repository: string): string => `https://github.com/${repository}/settings/access`;
const labelsUrl = (repository: string): string => `https://github.com/${repository}/labels`;
const RETRY: LeftoverAction = { label: 'Remove from OpenADLC again', retry: true };

/** A repository's labels, as removing it sorts them. */
export interface LabelSort {
  /** Made by OpenADLC: a name in `config/labels.json`, or one it was called before a rename. */
  ours: string[];
  /** A generic name OpenADLC also uses, or one that only starts like OpenADLC's (`priority:high`): maybe the repository's own. */
  maybeTheirs: string[];
}

/**
 * Sorts by name, in any letter case. It went by prefix, which deleted a
 * repository's own `priority:high` and `area:frontend` — and with them their
 * place on every issue — and left OpenADLC's `fleetadlc:paused` and
 * `deployed:prod` behind.
 */
export function sortLabels(names: readonly string[], configured: readonly string[]): LabelSort {
  const generic = new Set(GENERIC_LABELS);
  const ours = new Set(
    [...configured, ...Object.keys(RENAMED_LABELS)].map((name) => name.toLowerCase()).filter((name) => !generic.has(name)),
  );
  const prefixes = new Set(
    configured.filter((name) => name.includes(':')).map((name) => `${name.split(':')[0]!.toLowerCase()}:`),
  );
  const sorted: LabelSort = { ours: [], maybeTheirs: [] };
  for (const name of names) {
    const lower = name.toLowerCase();
    if (ours.has(lower) || lower.startsWith(LEGACY_STAGE_LABEL_PREFIX)) sorted.ours.push(name);
    else if (generic.has(lower) || [...prefixes].some((prefix) => lower.startsWith(prefix))) sorted.maybeTheirs.push(name);
  }
  return sorted;
}

/** What the collaborator and invitation steps need of the app. */
const ADMINISTRATION = '`Administration: read and write`';
/** What the label steps need of it. */
const ISSUES = '`Issues: read and write`';

/**
 * GitHub's refusal, in words a person acts on. The permission is the one
 * GitHub names, as the app's settings page names it; `fallback` only when it
 * names none. Every refusal named Administration, a label's too, which the
 * app may already hold.
 */
function said(error: unknown, fallback = ADMINISTRATION): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not accessible by integration')) {
    const accepted = error instanceof GitHubApiError ? error.acceptedPermissions : null;
    return `the OpenADLC GitHub App needs ${(accepted && permissionsInWords(accepted)) || fallback} on this repository`;
  }
  return message.split('\n')[0]!.slice(0, 200);
}

/**
 * `x-accepted-github-permissions` as the app's page says it: `issues=write`
 * is "`Issues: read and write`". Sets that would each do are apart by `;`,
 * and what one set needs together by `,`.
 */
function permissionsInWords(accepted: string): string | null {
  const sets = accepted
    .split(';')
    .map((set) =>
      set
        .split(',')
        .map((one) => one.trim().split('='))
        .filter((pair): pair is [string, string] => pair.length === 2 && pair[0]!.length > 0)
        .map(([name, level]) => `\`${PERMISSION_NAMES[name]?.label ?? name}: ${accessInWords(level).toLowerCase()}\``)
        .join(' and '),
    )
    .filter((set) => set.length > 0);
  return sets.length > 0 ? sets.join(' or ') : null;
}

export class RepoRemoval {
  constructor(private readonly deps: RepoRemovalDeps) {}

  /** What removing the repository would do, as it is now. Changes nothing; null for a repository OpenADLC never had. */
  async preview(name: string): Promise<RemovalPreview | null> {
    const repo = await repos.getRepoByName(name, { includeRemoved: true });
    if (!repo) return null;
    const [crew, going, open, held] = await Promise.all([
      bots.listBots(),
      this.unfinished(repo.id),
      threads.listOpenGatesInRepo(repo.id),
      leases.listActiveLeases(repo.id),
    ]);
    const botName = (id: string): string | null => crew.find((bot) => bot.id === id)?.name ?? null;
    // One installation token for the crew and the labels. Each used to ask
    // for its own, and a preview is read every time the dialog opens.
    let shared: RemovalGitHub | null = null;
    let unreachable: string | null = null;
    try {
      shared = await this.deps.github(repo.fullName);
    } catch (error) {
      unreachable = said(error);
    }
    const [access, labels, app] = await Promise.all([
      unreachable
        ? { known: false as const, reason: unreachable, github: null, accounts: [] }
        : this.crewOn(repo.fullName, crew, shared!),
      unreachable ? { known: false as const, reason: unreachable } : this.labelsOn(repo.fullName, shared!),
      this.appOn(repo.fullName),
    ]);
    return {
      repository: repo.fullName,
      removedAt: repo.removedAt,
      tasks: going.map((task) => ({
        id: task.id,
        subject: task.subjectRef,
        kind: task.kind,
        state: task.state,
        bot: botName(task.botId),
        question: open.find((gate) => gate.taskId === task.id)?.question ?? null,
      })),
      questions: open.map((gate) => ({ id: gate.id, subject: gate.subjectRef, question: gate.question })),
      leases: held.map((lease) => ({ id: lease.id, issue: lease.issueNumber, bot: botName(lease.botId), state: lease.state })),
      crew: {
        known: access.known,
        reason: access.reason,
        accounts: access.accounts.map(({ bots: names, login, state }) => ({ bots: names, login, state })),
      },
      labels: labels.known
        ? { known: true, reason: null, names: labels.names, maybeTheirs: labels.maybeTheirs }
        : { known: false, reason: labels.reason, names: [], maybeTheirs: [] },
      app,
      leftAlone: LEFT_ALONE,
    };
  }

  /**
   * Removes the repository and ends what OpenADLC had going there. Null for a
   * repository OpenADLC never had. Never throws for a step that fails: that is
   * in `notDone`, with what finishes it, and the repository is removed all
   * the same.
   */
  async remove(name: string, actor: string, options: RemovalOptions = DEFAULT_REMOVAL): Promise<RemovalReport | null> {
    // First, so nothing new starts there while the rest runs: the dispatcher
    // leases nothing in a removed repository and its webhooks are not acted on.
    const repo = await repos.removeRepo(name);
    if (!repo) return null;
    const why = `repository removed from OpenADLC by ${actor}`;
    const notDone: Leftover[] = [];
    const report: RemovalReport = {
      repo,
      options,
      stopped: [],
      questionsClosed: 0,
      leasesReleased: [],
      collaboratorsRemoved: [],
      invitationsCancelled: [],
      labelsRemoved: [],
      app: { allRepositories: null, settingsUrl: null, reason: null },
      notDone,
    };

    // Work in flight, through the same path as Stop. One at a time: each is a
    // request to hostd, and a repository has a handful at most.
    let going: Awaited<ReturnType<RepoRemoval['unfinished']>> = [];
    try {
      going = await this.unfinished(repo.id);
    } catch (error) {
      notDone.push({ step: 'task', what: 'its tasks were not read, so none was stopped', why: said(error), action: RETRY });
    }
    for (const task of going) {
      try {
        const stopped = await this.deps.stop(task.id, actor, why);
        report.questionsClosed += stopped.questionsClosed;
        if (stopped.state === 'stopped') report.stopped.push({ task: task.id, subject: task.subjectRef, was: task.state });
      } catch (error) {
        notDone.push({
          step: 'task',
          what: `the ${task.kind} task on ${task.subjectRef} is still ${task.state}`,
          why: said(error),
          action: RETRY,
        });
      }
    }

    // Questions whose task is over, or that no task asked. One whose task
    // could not be stopped stays with it, and goes when that task does.
    try {
      report.questionsClosed += (await threads.expireEndedGatesInRepo(repo.id, actor, why)).length;
    } catch (error) {
      notDone.push({ step: 'question', what: 'its open questions are still open', why: said(error), action: RETRY });
    }

    try {
      report.leasesReleased = (await leases.releaseForRepo({ repoId: repo.id, actor, reason: why })).map((lease) => lease.issueNumber);
    } catch (error) {
      notDone.push({ step: 'lease', what: 'its leases are still held', why: said(error), action: RETRY });
    }

    if (options.crewAccess) await this.takeCrewOff(repo.fullName, actor, report);
    if (options.labels || options.maybeTheirs) await this.deleteLabels(repo.fullName, actor, options, report);

    // What OpenADLC cannot change: an installation on all repositories still
    // reaches this one, and only a person can narrow it.
    report.app = await this.appOn(repo.fullName);
    if (report.app.allRepositories && report.app.settingsUrl) {
      notDone.push({
        step: 'app',
        what: `the GitHub App is installed on all of ${repo.fullName.split('/')[0]}’s repositories, so it still reaches this one`,
        why: 'OpenADLC cannot change which repositories its app is installed on; choose “Only select repositories” there',
        action: { label: 'Installation settings', url: report.app.settingsUrl },
      });
    }

    // As before: the keeper stops looking at a repository OpenADLC left.
    this.deps.crewAccess?.forget(repo.fullName);

    await audit({
      actor,
      action: 'repo.removed',
      target: repo.fullName,
      payload: {
        options,
        stopped: report.stopped.map((one) => one.subject),
        questionsClosed: report.questionsClosed,
        leasesReleased: report.leasesReleased,
        collaboratorsRemoved: report.collaboratorsRemoved,
        invitationsCancelled: report.invitationsCancelled,
        labelsRemoved: report.labelsRemoved.length,
        notDone: notDone.map(({ step, what, why: because, action }) => ({ step, what, why: because, action: action.label })),
      },
    });
    return report;
  }

  private async unfinished(repoId: string) {
    return (await tasks.listTasks({ states: UNFINISHED, limit: 500 })).filter((task) => task.repoId === repoId);
  }

  /**
   * The crew's accounts GitHub lists as the repository's direct collaborators,
   * and the ones invited. An account on a team or under an organization's base
   * permission is not a collaborator, and is not OpenADLC's to take off.
   *
   * An invitation is found by id from the admin listing, which only a person
   * can read; without it, the keeper's last run says who it left invited,
   * with no id to cancel.
   */
  private async crewOn(
    repository: string,
    crew: readonly { name: string; githubLogin: string | null }[],
    github?: RemovalGitHub,
  ): Promise<{
    known: boolean;
    reason: string | null;
    github: RemovalGitHub | null;
    accounts: { bots: string[]; login: string; state: 'collaborator' | 'invited'; invitation: number | null }[];
  }> {
    const logins = new Map<string, { login: string; bots: string[] }>();
    for (const bot of crew) {
      if (!bot.githubLogin) continue;
      const known = logins.get(bot.githubLogin.toLowerCase());
      if (known) known.bots.push(bot.name);
      else logins.set(bot.githubLogin.toLowerCase(), { login: bot.githubLogin, bots: [bot.name] });
    }

    let client = github;
    let collaborators: string[];
    try {
      client ??= await this.deps.github(repository);
      collaborators = await client.collaborators();
    } catch (error) {
      return { known: false, reason: said(error), github: null, accounts: [] };
    }
    if (!client) return { known: false, reason: 'GitHub could not be asked', github: null, accounts: [] };

    const accounts: { bots: string[]; login: string; state: 'collaborator' | 'invited'; invitation: number | null }[] = [];
    for (const { login, bots: names } of logins.values()) {
      if (collaborators.some((one) => sameLogin(one, login))) accounts.push({ bots: names, login, state: 'collaborator', invitation: null });
    }

    const listed = this.deps.invitations ? await this.deps.invitations(repository).catch(() => ({ pending: [], reason: 'the invitations could not be read' })) : null;
    const lastRun = this.deps.crewAccess?.view(repository)?.bots ?? [];
    for (const { login, bots: names } of logins.values()) {
      if (accounts.some((one) => one.login === login)) continue;
      // An invitation listed for another repository is not this one's. One
      // with no repository named is the listing this call asked for.
      const pending = listed?.pending.find(
        (one) =>
          sameLogin(one.invitee, login) &&
          !one.expired &&
          (!one.repository || one.repository.toLowerCase() === repository.toLowerCase()),
      );
      if (pending) accounts.push({ bots: names, login, state: 'invited', invitation: pending.id });
      else if (lastRun.some((bot) => bot.state === 'invited' && sameLogin(bot.login, login))) {
        accounts.push({ bots: names, login, state: 'invited', invitation: null });
      }
    }
    return { known: true, reason: listed?.reason ?? null, github: client, accounts };
  }

  private async takeCrewOff(repository: string, actor: string, report: RemovalReport): Promise<void> {
    const crew = await bots.listBots().catch(() => []);
    const found = await this.crewOn(repository, crew);
    if (!found.github) {
      report.notDone.push({
        step: 'collaborator',
        what: 'the crew’s accounts may still be collaborators',
        why: found.reason ?? 'GitHub could not be asked',
        action: { label: 'Collaborators on GitHub', url: accessUrl(repository) },
      });
      return;
    }
    const failed: { login: string; why: string }[] = [];
    for (const account of found.accounts) {
      if (account.state === 'collaborator') {
        try {
          await found.github.removeCollaborator(account.login);
          report.collaboratorsRemoved.push(account.login);
        } catch (error) {
          failed.push({ login: account.login, why: said(error) });
          report.notDone.push({
            step: 'collaborator',
            what: `${account.login} is still a collaborator`,
            why: said(error),
            action: { label: 'Collaborators on GitHub', url: accessUrl(repository) },
          });
        }
        continue;
      }
      if (account.invitation === null) {
        const why = `OpenADLC cannot see the invitation to cancel it${found.reason ? `: ${found.reason}` : ''}`;
        failed.push({ login: account.login, why });
        report.notDone.push({
          step: 'invitation',
          what: `${account.login}’s invitation is still pending`,
          why,
          action: { label: 'Invitations on GitHub', url: accessUrl(repository) },
        });
        continue;
      }
      try {
        await found.github.cancelInvitation(account.invitation);
        report.invitationsCancelled.push(account.login);
      } catch (error) {
        failed.push({ login: account.login, why: said(error) });
        report.notDone.push({
          step: 'invitation',
          what: `${account.login}’s invitation is still pending`,
          why: said(error),
          action: { label: 'Invitations on GitHub', url: accessUrl(repository) },
        });
      }
    }
    if (report.collaboratorsRemoved.length + report.invitationsCancelled.length + failed.length > 0) {
      await audit({
        actor,
        action: 'repo.crew_removed',
        target: repository,
        payload: { collaborators: report.collaboratorsRemoved, invitations: report.invitationsCancelled, failed },
      });
    }
  }

  private async labelsOn(
    repository: string,
    github?: RemovalGitHub,
  ): Promise<{ known: true; names: string[]; maybeTheirs: string[]; github: RemovalGitHub } | { known: false; reason: string }> {
    try {
      const client = github ?? (await this.deps.github(repository));
      const sorted = sortLabels(await client.labels(), this.deps.labelNames());
      return { known: true, names: sorted.ours, maybeTheirs: sorted.maybeTheirs, github: client };
    } catch (error) {
      return { known: false, reason: said(error, ISSUES) };
    }
  }

  /** Deleting a label takes it off every issue and pull request: GitHub does that, and the review step says so. */
  private async deleteLabels(repository: string, actor: string, options: RemovalOptions, report: RemovalReport): Promise<void> {
    const found = await this.labelsOn(repository);
    if (!found.known) {
      report.notDone.push({
        step: 'label',
        what: 'OpenADLC’s labels are still there',
        why: found.reason,
        action: { label: 'Labels on GitHub', url: labelsUrl(repository) },
      });
      return;
    }
    const failed: { label: string; why: string }[] = [];
    const chosen = [...(options.labels ? found.names : []), ...(options.maybeTheirs ? found.maybeTheirs : [])];
    for (const label of chosen) {
      try {
        await found.github.deleteLabel(label);
        report.labelsRemoved.push(label);
      } catch (error) {
        failed.push({ label, why: said(error, ISSUES) });
      }
    }
    if (failed.length > 0) {
      report.notDone.push({
        step: 'label',
        what: `${failed.length} of OpenADLC’s labels ${failed.length === 1 ? 'is' : 'are'} still there: ${failed.map((one) => one.label).join(', ')}`,
        why: failed[0]!.why,
        action: { label: 'Labels on GitHub', url: labelsUrl(repository) },
      });
    }
    if (report.labelsRemoved.length + failed.length > 0) {
      await audit({ actor, action: 'repo.labels_removed', target: repository, payload: { removed: report.labelsRemoved, failed } });
    }
  }

  private async appOn(repository: string): Promise<AppStanding> {
    if (!this.deps.app) return { allRepositories: null, settingsUrl: null, reason: 'this bridge does not ask GitHub about the app' };
    return this.deps.app(repository).catch((error: unknown) => ({ allRepositories: null, settingsUrl: null, reason: said(error) }));
  }
}

/** GitHub as the app on one repository: what the flow reads and deletes there. */
export async function appOnRepository(config: BridgeConfig, repository: string): Promise<RemovalGitHub> {
  const privateKey = await getSecretStore().get(appPrivateKeyRef());
  if (!privateKey) throw new Error('OpenADLC does not hold the GitHub App’s private key, so it cannot act on the repository');
  const live = await effectiveConfig(config);
  if (!live.gitHubClientId) throw new Error('OpenADLC has no GitHub App yet');
  const { token } = await installationTokenFor(APP_API, { clientId: live.gitHubClientId, privateKey }, repository);
  return removalGitHub(new GitHubClient({ token, actingAs: 'fleetadlc-app' }), repository);
}

/** Every page of a listing, up to ten of a hundred. */
export async function allPages<T>(client: Pick<GitHubClient, 'request'>, path: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await client.request<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

/** Gone already is what was asked for, so a 404 on a delete is not a failure. */
async function deleting(client: Pick<GitHubClient, 'request'>, path: string): Promise<void> {
  try {
    await client.request('DELETE', path);
  } catch (error) {
    if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
  }
}

export function removalGitHub(client: Pick<GitHubClient, 'request'>, repository: string): RemovalGitHub {
  return {
    collaborators: async () =>
      (await allPages<{ login?: string }>(client, `/repos/${repository}/collaborators?affiliation=direct`))
        .map((row) => row.login ?? '')
        .filter(Boolean),
    removeCollaborator: (login) => deleting(client, `/repos/${repository}/collaborators/${encodeURIComponent(login)}`),
    cancelInvitation: (id) => deleting(client, `/repos/${repository}/invitations/${id}`),
    labels: async () => (await allPages<{ name?: string }>(client, `/repos/${repository}/labels`)).map((row) => row.name ?? '').filter(Boolean),
    deleteLabel: (name) => deleting(client, `/repos/${repository}/labels/${encodeURIComponent(name)}`),
  };
}

/** Where the app's installation on the repository's account stands, from what settings shows of it. */
export async function appStanding(reach: Pick<AppReach, 'installationsView'>, repository: string): Promise<AppStanding> {
  const view = await reach.installationsView();
  if (!view.app) return { allRepositories: null, settingsUrl: null, reason: view.reason || 'OpenADLC could not ask GitHub about the app' };
  const owner = repository.split('/')[0] ?? '';
  const account = view.accounts.find((one) => sameLogin(one.login, owner));
  if (!account?.installation) return { allRepositories: false, settingsUrl: null, reason: null };
  return { allRepositories: account.installation.selection === 'all', settingsUrl: account.installUrl, reason: null };
}
