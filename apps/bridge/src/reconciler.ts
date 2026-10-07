import { audit, bots, hosts, issues, lastGithubDelivery, leases, repos, stageMoves, tasks } from '@fleetadlc/db';
import { actsForOn } from './people.js';
import { GitHubApiError, type GitHubClient } from '@fleetadlc/github';
import { actsFor, declaredPathsFrom, isBackwardMove, isStageLabel, STAGE_LABELS, stageFromLabels, hasIgnoreLabel, type StageKey } from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import { asAutomation, automationBotName } from './automation-bot.js';
import type { BridgeConfig } from './config.js';
import type { HostdClient } from './hostd-client.js';
import { leaseHoldUntil } from './task-service.js';
import { openedUnheard, recordUnheard, type UnheardFinding } from './unheard.js';
import { chooseIssueText, editNotTaken } from './vouched-text.js';
import { issueNumberFromBranch } from './work.js';

export interface Drift {
  kind:
    | 'stage_mismatch'
    | 'stale_body'
    | 'stale_labels'
    | 'issue_closed'
    | 'unknown_issue'
    | 'lease_without_issue'
    | 'paused_lease'
    | 'orphaned_task'
    | 'stale_host'
    | 'label_missing'
    | 'github_unreadable'
    | 'bot_unconnected'
    | 'repair_failed';
  subject: string;
  detail: string;
  repaired: boolean;
}

/**
 * What the webhook does with an issue, which reconcile does too when the
 * webhook never came: `Webhooks.learnIssue`.
 */
export interface IssueIntake {
  learnIssue(
    repo: { id: string; name: string },
    issue: { number: number; title: string; body: string | null; htmlUrl: string; labels: readonly string[] },
    action?: string,
  ): Promise<void>;
  /**
   * A stage label moved back on GitHub with no delivery to say so: taken as
   * a person's move (`Webhooks.movedBack`, `SendBack.fromPerson`), so the
   * work of the stage it left stops and the stage it is in starts.
   */
  movedBack?(repo: { id: string; name: string }, issueNumber: number, from: StageKey, to: StageKey): Promise<void>;
  /**
   * A merge with no delivery to say so: the issue moved to Merged or Done as
   * the delivery would have moved it (`Webhooks.mergeUnheard`). The stage it
   * reached, or null when the pull request did not merge.
   */
  mergeUnheard?(repo: { id: string; name: string }, issueNumber: number, prNumber: number): Promise<'merged' | 'done' | null>;
}

/** An issue or pull request as reconcile reads it from GitHub. */
export type LiveIssue = Awaited<ReturnType<GitHubClient['listIssues']>>[number];

/** Why an issue reconcile imported was not on the board already. */
export const WEBHOOK_NEVER_ARRIVED = 'its webhook never arrived';

/**
 * How long a task may sit queued, never handed to a host, before it is taken
 * as a start that never finished. hostd marks a task started only once its
 * session is up, after the worktree, the image and the computer, so this is
 * well past the slowest of those.
 */
export const UNSTARTED_STALE_MS = 30 * 60 * 1000;

/**
 * How long a host may go without a heartbeat before its running tasks are
 * taken as orphaned. hostd heartbeats its row every 10 seconds, so this is
 * thirty missed beats: past a keeper's restart of hostd, after which hostd
 * adopts the containers that outlived it. Reconcile used to fail every running
 * task on one unanswered health probe, and hostd, coming back, then removed
 * the containers of those tasks with their uncommitted work.
 */
export const HOST_SILENT_MS = 5 * 60 * 1000;

/** What a task whose host stopped reporting is failed with. */
export const HOST_STOPPED_REPORTING = 'the host stopped reporting';

/** What a task recorded and never handed to a host is failed with. */
export const NEVER_STARTED = 'its start never finished: the bridge recorded it and never handed it to a host';

/**
 * How long a lease on a merged issue is kept for its verification on testing.
 * GitHub closes the issue at the merge, and the lease is kept on purpose until
 * the builder has checked the change where it runs; a testing deploy that
 * failed or never came would otherwise hold its paths for good.
 */
export const VERIFY_BACKSTOP_MS = 24 * 60 * 60 * 1000;

/** GitHub's largest page. */
const PAGE = 100;

/**
 * Where reading one list stops: fifty pages, five thousand issues and pull
 * requests. Past it the repository is reported as unread rather than
 * reconciled from part of it, because a lease on an issue missing from a
 * partial read looks exactly like a lease on an issue that is gone.
 */
const MOST_PAGES = 50;

/**
 * How far before the last read the next one asks for closed issues from:
 * `since` is GitHub's clock, and one a little behind the bridge's must not
 * lose an issue closed in between.
 */
const SINCE_SLACK_MS = 10 * 60 * 1000;

/** Every page of one listing, newest first; the first sighting of a number stands. */
async function allOf(
  client: Pick<GitHubClient, 'listIssues'>,
  repo: string,
  params: { state: 'open' | 'closed'; since?: string },
  seen: Map<number, LiveIssue>,
): Promise<void> {
  for (let page = 1; page <= MOST_PAGES; page += 1) {
    const listed = await client.listIssues(repo, { ...params, perPage: PAGE, page });
    // Newest first, so an issue filed mid-read pushes one onto the next page
    // twice. The first sighting stands.
    for (const issue of listed) if (!seen.has(issue.number)) seen.set(issue.number, issue);
    if (listed.length < PAGE) return;
  }
  // A limit, not a fault: said as one, with what follows from it, since nothing
  // a person does short of closing issues changes it.
  throw new Error(
    `it has more than ${MOST_PAGES * PAGE} ${params.state} issues and pull requests, which is more than reconcile reads, ` +
      'so reconcile skips it and its board follows GitHub’s webhooks only',
  );
}

/**
 * The issues and pull requests reconcile has to see: every open one, the
 * closed ones changed since the last read, and the closed ones the board or
 * a lease still names.
 *
 * It was one page of a hundred. On a repository with more, everything older
 * than the hundredth was invisible: an issue filed there was never imported,
 * and a lease on one was released every quarter hour as "the issue no longer
 * exists". Then it was every issue the repository ever had, which a mature
 * repository's five thousand and more never fitted, so that repository was
 * never reconciled at all. A closed issue nobody here names is nothing to
 * reconcile: one is never imported.
 *
 * `named` are looked up one at a time when no listing returned them; one
 * GitHub no longer has is simply absent, which is how a lease on it is let go.
 */
export async function everyIssue(
  client: Pick<GitHubClient, 'listIssues'> & Partial<Pick<GitHubClient, 'getIssue'>>,
  repo: string,
  options: { closedSince?: string | null; named?: readonly number[] } = {},
): Promise<LiveIssue[]> {
  const seen = new Map<number, LiveIssue>();
  await allOf(client, repo, { state: 'open' }, seen);
  if (options.closedSince) await allOf(client, repo, { state: 'closed', since: options.closedSince }, seen);

  for (const number of new Set(options.named ?? [])) {
    if (seen.has(number) || !client.getIssue) continue;
    try {
      seen.set(number, await client.getIssue(repo, number));
    } catch (error) {
      // Gone, deleted or never there: absent. Anything else is an unread
      // repository, not a missing issue.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 410)) continue;
      throw error;
    }
  }
  return [...seen.values()];
}

/**
 * GitHub is the system of record, so anything the platform believes has to be
 * checked against it. This job reads the repository's current state and repairs
 * what it safely can: a stage label the cache disagrees with, a lease on an issue
 * that is closed, a task whose host is gone, an issue whose webhook never came.
 * Whatever it cannot repair it reports, because silent drift is how a board
 * stops being trustworthy.
 */
export class Reconciler {
  constructor(
    private readonly config: BridgeConfig,
    private readonly actors: Actors,
    private readonly hostd: HostdClient,
    /** The webhook's own handling of an issue, for one it never delivered. */
    private readonly intake: IssueIntake,
  ) {}

  /** When each repository was last read in full, by repository id: the next read asks only for closed issues changed since. */
  private readonly readAt = new Map<string, number>();

  async run(options: { repair?: boolean } = {}): Promise<Drift[]> {
    const repair = options.repair ?? true;
    const drift: Drift[] = [];
    const client = await asAutomation(this.actors, this.config);
    const now = new Date();
    // What GitHub told OpenADLC about and what it did not, for the webhook's own
    // report: see `unheard.ts`. When the bridge last took a delivery is read
    // once, for every repository.
    const unheard: UnheardFinding[] = [];
    const heardAt = (await lastGithubDelivery().catch(() => null))?.at ?? null;
    const crew = await bots.listBots().catch(() => []);

    const repoList = await repos.listRepos();
    // Named, with the command that connects it: "the automation account is
    // not connected" said neither which account nor how.
    const automation = client ? null : await automationBotName(this.config);
    const repoNames = new Map(repoList.map((repo) => [repo.id, repo.name]));
    for (const repo of repoList) {
      const cached = await issues.listIssues(repo.name);

      if (!client) {
        drift.push({
          kind: 'github_unreadable',
          subject: repo.name,
          detail:
            `${automation} is not connected to GitHub, so GitHub could not be read. ` +
            `Connect it in Settings → GitHub → Connected accounts, or run: fleetadlc auth login --bot ${automation}`,
          repaired: false,
        });
        continue;
      }

      let live: LiveIssue[];
      const readStarted = Date.now();
      try {
        const since = this.readAt.get(repo.id);
        // A row the board still works on, or a lease, whose issue closed
        // before the last read (or before this bridge started) is looked up
        // by itself. A merged or finished row stays on the board closed, and
        // is not asked about every quarter hour.
        const named = [
          ...cached.filter((entry) => entry.stage !== 'merged' && entry.stage !== 'done').map((entry) => entry.number),
          ...(await leases.listActiveLeases(repo.id)).map((lease) => lease.issueNumber),
        ];
        live = await everyIssue(client, repo.fullName, {
          closedSince: since === undefined ? null : new Date(since - SINCE_SLACK_MS).toISOString(),
          named,
        });
        this.readAt.set(repo.id, readStarted);
      } catch (error) {
        drift.push({
          kind: 'github_unreadable',
          subject: repo.fullName,
          detail: `the repository could not be read: ${reasonOf(error)}`,
          repaired: false,
        });
        continue;
      }

      // Open ones only. This read every issue GitHub listed, closed as well —
      // it asks for them all — so a closed issue always looked open, and no
      // lease on one was ever let go.
      const openNumbers = new Set(
        live.filter((issue) => !issue.pullRequest && issue.state === 'open').map((issue) => issue.number),
      );

      for (const issue of live) {
        if (issue.pullRequest) continue;
        const known = cached.find((entry) => entry.number === issue.number);

        // One issue that cannot be written — a row the store refuses, a stage
        // nobody can be started on — is reported, and the rest still reconcile.
        // It used to end the run there, leaving everything after it unread.
        try {
          await this.reconcileIssue(repo, issue, known, repair, drift, unheard, crew, client);
        } catch (error) {
          drift.push({
            kind: known ? 'repair_failed' : 'unknown_issue',
            subject: `${repo.name}#${issue.number}`,
            detail: `${known ? 'could not be repaired' : 'could not be imported from GitHub'}: ${reasonOf(error)}`,
            repaired: false,
          });
        }
      }

      // Opened lately — issues and pull requests both — and followed by no
      // delivery at all.
      unheard.push(...openedUnheard(repo.name, live, heardAt, now));

      // A lease on an issue that has closed or vanished holds work for nothing.
      for (const lease of await leases.listActiveLeases(repo.id)) {
        const stillOpen = openNumbers.has(lease.issueNumber);
        const liveIssue = live.find((issue) => issue.number === lease.issueNumber);
        const closed = liveIssue ? !stillOpen : true;

        // Merged in a repository that deploys: closed by the merge, and kept
        // until the builder verifies the change on testing, whose end lets it
        // go. Released here, a reconcile between the merge and the deploy
        // meant the verification never started. Not past the backstop.
        const merged = Boolean(liveIssue) && Boolean(lease.prNumber) && cached.find((entry) => entry.number === lease.issueNumber)?.stage === 'merged';
        const changedAt = lease.updatedAt ? Date.parse(lease.updatedAt) : Number.NaN;
        const verifying = merged && Number.isFinite(changedAt) && now.getTime() - changedAt < VERIFY_BACKSTOP_MS;
        if (closed && verifying) continue;

        if (closed) {
          if (repair) {
            await leases.setLeaseState(lease.id, 'released');
            await audit({
              actor: 'reconciler',
              action: 'lease.released',
              target: `${repo.name}#${lease.issueNumber}`,
              payload: {
                reason: merged
                  ? `merged, and its verification on testing never started within a day: a testing deploy of #${lease.prNumber} failed or never came`
                  : 'the issue is closed or gone',
              },
            });
          }
          drift.push({
            kind: liveIssue ? 'issue_closed' : 'lease_without_issue',
            subject: `${repo.name}#${lease.issueNumber}`,
            detail: merged
              ? 'the issue merged a day ago, and its verification on testing never started'
              : liveIssue
                ? 'the issue is closed but the lease was still held'
                : 'the issue no longer exists',
            repaired: repair,
          });
        }
      }
    }

    // Never a reason for reconcile to fail: it is evidence for a report, and
    // the repairs above have already been made.
    if (repair) await recordUnheard(unheard, now).catch(() => 0);

    // A task cannot be running if the host that was running it has stopped
    // reporting. Judged by the host's heartbeat, not by one health probe: a
    // keeper restarting hostd fails the probe while the task's container
    // runs on, and hostd adopts it when it is back.
    const running = await tasks.listTasks({ states: ['running'], limit: 200 });
    if (running.length > 0) {
      const silentBefore = now.getTime() - HOST_SILENT_MS;
      const registered = await hosts.listHosts();
      const reporting = new Set(
        registered.filter((host) => host.lastSeenAt !== null && Date.parse(host.lastSeenAt) >= silentBefore).map((host) => host.id),
      );
      for (const task of running) {
        // A task no host has claimed yet is judged by whether any host still reports.
        const alive = task.hostId === null ? reporting.size > 0 : reporting.has(task.hostId);
        if (alive) continue;
        let failed = false;
        if (repair) {
          // Only while it still runs: a task that reported its verdict since
          // the read keeps it, and its lease is its own ending's to settle.
          failed = (await tasks.failIfRunning(task.id, HOST_STOPPED_REPORTING)) !== null;
          if (failed && task.leaseId) {
            // A lease with a pull request is kept, as hostd's observer keeps it:
            // the pull request still needs its paths.
            const lease = await leases.getLease(task.leaseId);
            if (lease && lease.prNumber == null) await leases.setLeaseState(task.leaseId, 'released');
          }
        }
        drift.push({
          kind: 'orphaned_task',
          subject: task.subjectRef,
          detail: 'the task was marked running but its host has stopped reporting',
          repaired: failed,
        });
      }
    }

    // Reported, and nothing more: the tasks are judged by heartbeat above.
    const health = await this.hostd.health();
    if (!health.ok) {
      drift.push({
        kind: 'stale_host',
        subject: 'hostd',
        detail: 'the host is not answering its health check',
        repaired: false,
      });
    }

    // A task recorded and never handed to a host — the bridge threw or exited
    // between writing the row and asking hostd — fills its seat, a host's
    // room and its subject, and keeps its issue counted as building. Nothing
    // else ends it: Stop refuses a queued task.
    for (const task of await tasks.staleUnstarted(new Date(now.getTime() - UNSTARTED_STALE_MS))) {
      let failed = false;
      if (repair) {
        failed = (await tasks.failUnstarted(task.id, NEVER_STARTED)) !== null;
        // Only a lease nothing else is working under: a retry may have started beside it.
        if (failed && task.leaseId) await leases.releaseIfIdle(task.leaseId);
      }
      drift.push({
        kind: 'orphaned_task',
        subject: task.subjectRef,
        detail: 'the task was recorded but never handed to a host',
        repaired: failed,
      });
    }

    // A paused lease whose work has ended holds its paths for nothing, and no
    // other rule reaches one (`leases.settlePausedLeases`). The end of a task
    // lets its own go; this is for the ones left from before that, or from an
    // end the bridge never heard about. Only when repairing: finding them is
    // the same statement that lets them go.
    if (repair) {
      const settled = await leases.settlePausedLeases({
        actor: 'reconciler',
        reason: 'its work had ended',
        holdUntil: leaseHoldUntil(),
      });
      for (const lease of [...settled.released, ...settled.held]) {
        const released = lease.state === 'released';
        drift.push({
          kind: 'paused_lease',
          subject: `${repoNames.get(lease.repoId) ?? 'issue'}#${lease.issueNumber}`,
          detail: released
            ? 'the lease was paused after its task had ended'
            : 'the lease was paused after its task had ended; it waits for its pull request again',
          repaired: true,
        });
      }
    }

    // A bot whose account is missing from configuration cannot act at all.
    for (const bot of await bots.listBots()) {
      if (!bot.githubLogin) {
        drift.push({
          kind: 'bot_unconnected',
          subject: bot.name,
          detail: `no GitHub account is connected for this bot. Run: fleetadlc auth login --bot ${bot.name}`,
          repaired: false,
        });
      }
    }

    return drift;
  }

  /**
   * Whether the issue's last recorded move was the bridge's own, to the stage
   * the board has. A move that cannot be read is not one: GitHub wins, as before.
   */
  private async ownMoveUnlabelled(repoId: string, issueNumber: number, stage: StageKey): Promise<boolean> {
    const moves = await (async () => stageMoves.listForIssue(repoId, issueNumber))().catch(() => []);
    const last = moves.at(-1);
    return last?.actor === 'bridge' && last.to === stage;
  }

  /** One issue: what GitHub says against what the board has. */
  private async reconcileIssue(
    repo: repos.RepoRecord,
    issue: LiveIssue,
    known: issues.IssueRecord | undefined,
    repair: boolean,
    drift: Drift[],
    unheard: UnheardFinding[],
    crew: readonly { githubLogin: string | null }[] = [],
    client?: GitHubClient,
  ): Promise<void> {
    const liveStage = stageFromLabels(issue.labels);

    // An issue labelled `fleetadlc:ignore` is a person's, and off the board:
    // nothing here moves it, settles its merge or forgets it. Only its labels
    // are kept as GitHub has them, so the label coming off is seen even when
    // that delivery never came, and the next pass takes it up as any issue.
    if (known && hasIgnoreLabel(issue.labels)) {
      if (repair && !sameLabels(issue.labels, known.labels)) await issues.setIssueLabels(repo.id, issue.number, issue.labels);
      return;
    }

    // A closed issue whose change never merged is finished business —
    // abandoned, or closed by hand: it leaves the board rather than sitting in
    // a column nobody is working. One whose change merged is not. GitHub
    // closes an issue at the merge that says it closes it, with the card in
    // Ship; dropping it there lost fleetadlc-testbed#1, and #3, which waits on it,
    // could never be unblocked.
    const merged = (stage: string | null | undefined): boolean => stage === 'merged' || stage === 'done';
    if (issue.state === 'closed' && !merged(liveStage) && !merged(known?.stage)) {
      if (known) {
        // GitHub closes the issue at the merge either way; only the merge's
        // own delivery moved the card on. With that delivery missed, the issue
        // was forgotten here as closed unmerged, and an issue waiting on it
        // waited on one OpenADLC had never seen, for good.
        const pull = client ? await mergedPullOf(client, repo.fullName, known) : undefined;
        if (pull === undefined) {
          drift.push({
            kind: 'issue_closed',
            subject: `${repo.name}#${issue.number}`,
            detail: `closed while the board had it in ${known.stage}, and whether its pull request merged could not be read; kept until GitHub answers`,
            repaired: false,
          });
          return;
        }
        if (pull !== null) {
          const to = repair && this.intake.mergeUnheard ? await this.intake.mergeUnheard(repo, issue.number, pull) : null;
          drift.push({
            kind: 'issue_closed',
            subject: `${repo.name}#${issue.number}`,
            detail: to
              ? `#${pull} merged and its webhook never arrived; moved from ${known.stage} to ${to}`
              : `#${pull} merged and its webhook never arrived; still in ${known.stage}`,
            repaired: to !== null,
          });
          return;
        }
        if (repair) await issues.forget(repo.id, issue.number);
        drift.push({
          kind: 'issue_closed',
          subject: `${repo.name}#${issue.number}`,
          detail: `closed while the board had it in ${known.stage}`,
          repaired: repair,
        });
      }
      return;
    }

    if (!known) {
      // An open issue in a stage is one the webhook would have put on the board
      // when it was filed or labelled, so its not being here means that
      // delivery never came: a hook GitHub is not sending from, a tunnel that
      // was down, a laptop asleep. It is taken exactly as the webhook would
      // have taken it — stored, and the bot that staffs its stage started.
      //
      // Nothing else is imported. An issue with no stage label is not OpenADLC's
      // until somebody gives it one, and reading every such issue in the
      // repository onto the board, and into triage, is not what anybody filed
      // them for. A closed one is finished business. `fleetadlc:ignore` is the
      // same refusal with a stage label present: importing would store that
      // stage and start whoever staffs it, which replaces the label with work.
      // Taking it off is what lets the next pass import the issue.
      if (issue.state !== 'open' || !liveStage || hasIgnoreLabel(issue.labels)) return;

      // Nor a stranger's, stage label and all: an issue form labels anybody's
      // issue, and one nobody with access has acted on is not OpenADLC's to start.
      // A person with access who labels it is a delivery of their own; see
      // `actsFor`.
      const asker = await asAutomation(this.actors, this.config).catch(() => null);
      if (!(await actsForOn({ client: asker, repoFullName: repo.fullName, author: { login: issue.author, association: issue.association }, crew }))) return;

      if (repair) {
        await this.intake.learnIssue(repo, issue);
        unheard.push({
          subject: `${repo.name}#${issue.number}`,
          what: 'imported',
          title: issue.title,
          url: issue.htmlUrl,
          happenedAt: issue.updatedAt,
        });
      }
      drift.push({
        kind: 'unknown_issue',
        subject: `${repo.name}#${issue.number}`,
        detail: WEBHOOK_NEVER_ARRIVED,
        repaired: repair,
      });
      return;
    }

    // A stranger's issue a person vouched for is stored as it was vouched for:
    // the author's later edit is not drift to repair (`learnIssue`). An edit
    // GitHub puts to someone with access is, and moves the kept text on.
    let text: { title: string; body: string | null } = { title: issue.title, body: issue.body };
    if (known.vouched) {
      const asked = { client: client ?? null, repoFullName: repo.fullName, crew };
      const choice = await chooseIssueText({
        stored: { title: known.vouched.title, body: known.vouched.body },
        live: { title: issue.title, body: issue.body ?? '' },
        authorHeard: () => actsForOn({ ...asked, author: { login: issue.author, association: issue.association } }),
        heard: (login) => actsForOn({ ...asked, author: { login, association: null } }),
        edits: async () => {
          if (!client) throw new Error('no account to ask GitHub with');
          return client.issueEdits(repo.fullName, issue.number);
        },
      });
      text = { title: choice.title, body: choice.body };
      if (choice.refused) await editNotTaken(repo.name, issue.number, choice.editedAt, 'reconcile');
      if (choice.changed && repair) await issues.setVouched(repo.id, issue.number, { title: choice.title, body: choice.body, by: choice.by ?? 'github' });
    }

    if (liveStage && liveStage !== known.stage && client && isBackwardMove(known.stage, liveStage) && (await this.ownMoveUnlabelled(repo.id, issue.number, known.stage))) {
      // The board is ahead because the bridge moved it and then failed to
      // write the label: the stage is written before the label. Taken as a
      // person's move back, a merge whose label write failed was moved back
      // out of Merged, and the next pass forgot the issue.
      if (repair) {
        const labels = issue.labels.filter((label) => !isStageLabel(label));
        await client.setLabels(repo.fullName, issue.number, [...labels, STAGE_LABELS[known.stage]]);
      }
      drift.push({
        kind: 'stage_mismatch',
        subject: `${repo.name}#${issue.number}`,
        detail: `the board said ${known.stage}, GitHub says ${liveStage}; the bridge's own move to ${known.stage} never reached the label, so the label was written again`,
        repaired: repair,
      });
    } else if (liveStage && liveStage !== known.stage) {
      // GitHub wins: a label changed by hand is still the record.
      if (repair) {
        await issues.upsertIssue({
          repoId: repo.id,
          number: issue.number,
          title: text.title,
          stage: liveStage,
          labels: issue.labels,
          // GitHub's copy is the live one, so prefer what it says and fall
          // back to what was stored — a repair must never blank a body or a
          // set of paths the row already had.
          declaredPaths: text.body ? declaredPathsFrom(text.body) : known.declaredPaths,
          body: text.body ?? null,
          url: issue.htmlUrl,
          prNumber: known.prNumber,
        });
      }
      if (repair && isBackwardMove(known.stage, liveStage)) await this.intake.movedBack?.(repo, issue.number, known.stage, liveStage);
      drift.push({
        kind: 'stage_mismatch',
        subject: `${repo.name}#${issue.number}`,
        detail: `the board said ${known.stage}, GitHub says ${liveStage}`,
        repaired: repair,
      });
    } else if (!sameLabels(issue.labels, known.labels)) {
      // Labels are what the dispatcher routes on — `start:now` places an
      // issue, `blocked` and `needs-human` hold it — and it reads them from
      // this row, not from GitHub. Reconcile checked the stage and the body
      // and never the labels, so a label changed while no webhook arrived
      // simply did not exist here.
      //
      // Both directions are wrong and one is dangerous: a `blocked` removed
      // on GitHub left an issue held forever, and a `blocked` added on
      // GitHub left it leasable.
      if (repair) {
        await issues.upsertIssue({
          repoId: repo.id,
          number: issue.number,
          title: text.title,
          // Unchanged, and it cannot be otherwise: any stage difference is
          // caught by the branch above, so reaching here means GitHub and
          // the board already agree about the stage.
          stage: known.stage,
          labels: issue.labels,
          declaredPaths: text.body ? declaredPathsFrom(text.body) : known.declaredPaths,
          body: text.body ?? null,
          url: issue.htmlUrl,
          prNumber: known.prNumber,
        });
      }
      drift.push({
        kind: 'stale_labels',
        subject: `${repo.name}#${issue.number}`,
        detail: `the board said ${known.labels.join(', ') || '(none)'}; GitHub says ${issue.labels.join(', ') || '(none)'}`,
        repaired: repair,
      });
    } else if (text.body && text.body !== known.body) {
      // The body is what the dispatcher reads to decide whether an issue
      // says enough to be worked on, and nothing else would ever repair it.
      // Reconcile only rewrites a row that drifts, and a body that was
      // never stored does not look like drift — the stage matches, so the
      // row is left alone and the issue stays unleasable for good.
      //
      // That is not only an upgrade concern. An issue edited while the
      // bridge is down has the same problem: the board keeps the old text
      // and routes on it.
      if (repair) {
        await issues.upsertIssue({
          repoId: repo.id,
          number: issue.number,
          title: text.title,
          stage: known.stage,
          labels: issue.labels,
          declaredPaths: declaredPathsFrom(text.body),
          body: text.body,
          url: issue.htmlUrl,
          prNumber: known.prNumber,
        });
      }
      drift.push({
        kind: 'stale_body',
        subject: `${repo.name}#${issue.number}`,
        detail: known.body
          ? 'the stored text is not what GitHub says'
          : 'no body stored, so the dispatcher reads it as missing every section',
        repaired: repair,
      });
    }

    // No stage label is normally drift: the card sits on no column, and the
    // report asks for one. `fleetadlc:ignore` is why there is no stage, and
    // asking would be a stage label replacing it.
    if (!liveStage && issue.state === 'open' && !hasIgnoreLabel(issue.labels)) {
      drift.push({
        kind: 'label_missing',
        subject: `${repo.name}#${issue.number}`,
        detail: 'no adlc:* label, so it appears on no column',
        repaired: false,
      });
    }
  }
}

/** Whether an entry is an issue reconcile brought onto the board itself. */
function imported(entry: Drift): boolean {
  return entry.kind === 'unknown_issue' && entry.repaired;
}

/**
 * One entry as the reconcile job's log says it.
 *
 * An import says what it did in so many words — "imported fleetadlc-testbed#1 from
 * GitHub: its webhook never arrived" — because it is the one repair that means
 * something upstream is wrong: GitHub knew about the issue and OpenADLC did not.
 */
export function driftLine(entry: Drift): string {
  if (imported(entry)) return `imported ${entry.subject} from GitHub: ${entry.detail}`;
  return `${entry.repaired ? 'repaired' : 'needs a person'}: ${entry.subject} — ${entry.detail}`;
}

export function renderDrift(drift: readonly Drift[]): string {
  if (drift.length === 0) return 'Nothing has drifted: the board matches GitHub.';

  const repaired = drift.filter((entry) => entry.repaired);
  const reported = drift.filter((entry) => !entry.repaired);
  const lines: string[] = [];

  if (repaired.length > 0) {
    lines.push(`**Repaired ${repaired.length}:**`);
    for (const entry of repaired) {
      lines.push(`- ${entry.subject}: ${imported(entry) ? `imported from GitHub, ${entry.detail}` : entry.detail}`);
    }
  }
  if (reported.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`**Needs a person (${reported.length}):**`);
    for (const entry of reported) lines.push(`- ${entry.subject}: ${entry.detail}`);
  }

  return lines.join('\n');
}

/** The first line of what went wrong, short enough for a log line. */
/**
 * The pull request that merged a closed issue's change: the one recorded on
 * it, or else one whose branch was cut for it, among the latest closed ones.
 * Null when none did; undefined when GitHub could not be asked, which is no
 * reason to forget an issue.
 */
async function mergedPullOf(
  client: GitHubClient,
  repoFullName: string,
  known: { number: number; prNumber: number | null },
): Promise<number | null | undefined> {
  try {
    if (known.prNumber) {
      const pull = await client.getPullRequest(repoFullName, known.prNumber).catch((error: unknown) => {
        if (error instanceof GitHubApiError && error.status === 404) return null;
        throw error;
      });
      if (pull?.merged) return pull.number;
    }
    const closed = await client.request<{ number: number; merged_at?: string | null; head?: { ref?: string } }[]>(
      'GET',
      `/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    );
    const found = closed.find((pull) => pull.merged_at && pull.head?.ref && issueNumberFromBranch(pull.head.ref) === known.number);
    return found ? found.number : null;
  } catch {
    return undefined;
  }
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || 'no reason given';
}

/**
 * Whether two label sets are the same set.
 *
 * Order is GitHub's to choose and carries no meaning, so comparing sequences
 * would report drift on every pass for rows that agree — and a reconcile that
 * rewrites every issue every time is a drift report nobody reads.
 */
function sameLabels(live: readonly string[], known: readonly string[]): boolean {
  if (live.length !== known.length) return false;
  const stored = new Set(known);
  return live.every((label) => stored.has(label));
}
