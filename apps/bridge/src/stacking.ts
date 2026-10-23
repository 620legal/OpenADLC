import { bots, issues, leases, listEventsOfType, recordEvent, repos, stacks, tasks, type Stack } from '@openadlc/db';
import { blockingOverlaps } from '@openadlc/dispatcher';
import type { GitHubClient } from '@openadlc/github';
import {
  DELIVERY_RULES_PATH,
  readDeliveryRulesFile,
  dependencyIsSatisfied,
  namesRepository,
  hasAbandonedLabel,
  hasIgnoreLabel,
  hasPausedLabel,
  hasShipped,
  leaseExpiryFrom,
  missingForRouting,
  PAUSED_LABEL,
  parseDependencyRefs,
  resolutionPolicy,
  tooManyAttempts,
  type ContextDocument,
} from '@openadlc/shared';
import type { Started } from './build-start.js';
import { sayOnCard } from './deploy-pipeline.js';
import { forgetHold, readHolds, recordHold, type ItemHold } from './item-hold.js';

/**
 * An issue that waits on one that is in review starts from that one's branch,
 * rather than waiting for it to merge.
 *
 * The dependency is usually approved as it stands, and its review is the
 * longest wait in the flow: an issue B that needs A was idle all of it. Now B
 * is leased to A's builder and its build starts from A's branch, so B's work
 * already has A's in it. B's pull request does not join the merge line until
 * A has merged; the line then merges the base into B's branch itself, and B's
 * approvals stand across that one commit, matched by the SHA GitHub answered
 * the line with. Every other push to B is reviewed as any push is: one from
 * the same head that touches the same files is still not the line's, since
 * the builder holds a token that can push anything, and a conflicted update
 * goes to a resolution round with its own re-review. If A is sent back to
 * build, what B was built on is changing, so B is held, with a note on it;
 * and so it is if A is closed without merging.
 *
 * The hold goes by itself once A is settled: approved again, its gate green
 * on the head it is at, or merged (`letGoWhatIsSettled`). It waited for a
 * person's Resume, which nothing asked for: OpenADLC#137 sat held for hours
 * after #141 was approved and merged, Needs you said nothing, and the gate
 * sweep logged its refused reviews every ten minutes. When A's change since
 * B was built touches B's own files, B's builder brings B up to date first,
 * by the patch path; only when that cannot start, or A will not land, does a
 * person decide, and Needs you says so (`heldStacks`).
 *
 * Which issue B was built on is a row of its own (`stacks`), written before
 * B's build starts, which does not start without it. It was only an event,
 * written after the build started and read from the last fourteen days: A in
 * review for longer, or an event not written or not read, and B merged with
 * A's unreviewed commits in it. A stack that cannot be read is not "no
 * stack": `waitingOn` throws, and the merge line keeps B out.
 *
 * One level only: B stacks on A only when A is not itself stacked on work
 * still unmerged. Off with `stacking: false` in `.github/openadlc.yml`.
 */
export const STACK_STARTED = 'stack.started';
export const STACK_UPDATING = 'stack.updating';
/** What the line's stacked update made: the merge commit's SHA, or `to: null` when it made none it could vouch for. */
export const STACK_MADE = 'stack.made';
export const STACK_UPDATED = 'stack.updated';
export const STACK_PAUSED = 'stack.paused';
/** A hold let go by itself, and why: what it was built on was approved again, or merged. */
export const STACK_LET_GO = 'stack.let_go';

/**
 * How a held stacked issue is started again from the base. "Redo it from the
 * base" named no way to: there is no control that rebuilds one in place, and
 * Cancel closes its pull request and deletes its branch, so a new issue is
 * built from the base.
 */
const START_OVER = 'To start over from the base instead, cancel it from its card and file the work again as a new issue.';

/** How far back the events about a stacked update are read; not the stack itself, which is a row. */
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * How long a push from a noted head waits for the line to record what it
 * made. The push's webhook can arrive before the line has GitHub's answer,
 * and deciding then dismisses the approvals, which cannot be undone. A note
 * older than `NOTE_FRESH_MS` with nothing recorded after it is not waited on:
 * that update never finished.
 */
const MADE_WAIT_TRIES = 10;
const MADE_WAIT_MS = 1000;
const NOTE_FRESH_MS = 2 * 60 * 1000;

interface StartedPayload {
  repo: string;
  issue: number;
  on: number;
  onPr: number;
  branch: string;
  at: string;
}

interface UpdatingPayload {
  repo: string;
  pr: number;
  issue: number;
  on: number;
  from: string;
  files: string[];
  at: string;
}

interface MadePayload {
  repo: string;
  pr: number;
  from: string;
  to: string | null;
  at: string;
}

interface UpdatedPayload {
  repo: string;
  pr: number;
  issue: number;
  on: number;
  from: string;
  to: string;
  at: string;
}

type Client = Pick<GitHubClient, 'getPullRequest' | 'readFileIfPresent' | 'comment' | 'addLabels' | 'removeLabel' | 'changedFilesBetween'>;

/** Whether a hold is one `holdWhatWasSentBack` put on and still waits on what it was built on, not on a person. */
function waitsOnBase(hold: ItemHold | undefined): boolean {
  return hold?.by === 'openadlc' && !hold.needsPerson;
}

export interface StackingDeps {
  client: () => Promise<Client | null>;
  /** `build-start.ts`'s `startBuild`, which assigns, comments and marks the lease. */
  startBuild: (input: {
    leaseId: string;
    repo: { name: string; fullName: string };
    issue: number;
    bot: { id: string; name: string };
    declaredPaths: string[];
    expiresAt: string | null;
    stackOn: { issue: number; pr: number; branch: string };
  }) => Promise<Started>;
  /**
   * Why new work may not start, install-wide or in one repository, or null:
   * the dispatcher's own gate. A stacked build is new work, and a pause from
   * Settings, a paused repository and a restore's hold used to stop every
   * build but this one.
   */
  paused: (repo?: string) => string | null;
  /** Whether anything dispatches on this install. Where nothing leases, nothing stacks either. */
  dispatching: () => boolean;
  /**
   * The review gate OpenADLC published on a commit
   * (`Automation.publishedGate`), or null when none is known: how a
   * dependency approved again is told. Absent, only its merge lets a hold go.
   */
  gate?: (repoFullName: string, sha: string) => Promise<'pending' | 'success' | 'failure' | null>;
  /**
   * Hands a held change whose dependency changed its files under it to its
   * builder, to bring it up to date (`SendBack.backToBuild`): null once the
   * round is with the builder, else why not. Absent, a person is asked.
   */
  rebuild?: (input: { repoName: string; prNumber: number; reason: string }) => Promise<string | null>;
  /** Says a line in a card's timeline (`sayOnCard`). */
  say?: (subjects: readonly string[], text: string, payload: Record<string, unknown>) => Promise<boolean>;
  record?: (input: { type: string; payload: unknown }) => Promise<unknown>;
  events?: (type: string, since: Date) => Promise<{ at: string; payload: unknown }[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The builder a branch is named for: `agent/<bot>/<n>-…`. */
export function builderOfBranch(ref: string): string | null {
  return /^agent\/([^/]+)\//.exec(ref)?.[1] ?? null;
}

/** The labels that keep an issue from the dispatcher, as `listRoutableIssues` reads them. */
const HELD_FOR_SOMEONE: readonly string[] = ['needs-human', 'needs-triage', 'do:human'];

/** Where a dependency in review is when it was sent back: any stage before review. */
const SENT_BACK_TO: readonly string[] = ['intake', 'spec', 'build'];

export class Stacking {
  constructor(private readonly deps: StackingDeps) {}

  /** Stacked updates a push is being matched to now: two deliveries of one push keep the approvals once. */
  private readonly claiming = new Set<string>();

  private record(type: string, payload: object): Promise<unknown> {
    const write = this.deps.record ?? ((input: { type: string; payload: unknown }) => recordEvent({ source: 'platform', ...input }));
    return write({ type, payload }).catch(() => undefined);
  }

  private async events<P>(type: string, repoName: string): Promise<{ at: string; payload: P }[]> {
    const read = this.deps.events ?? listEventsOfType;
    const now = this.deps.now?.() ?? Date.now();
    const rows = await read(type, new Date(now - LOOKBACK_MS)).catch(() => []);
    return rows
      .map((row) => ({ at: row.at, payload: row.payload as P & { repo?: string } }))
      .filter((row) => row.payload?.repo === repoName)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  private at(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  /** The issue an issue was stacked on, if it was. Throws when that cannot be read. */
  async stackedOn(repoName: string, issue: number): Promise<number | null> {
    const repo = await repos.getRepoByName(repoName);
    return repo ? ((await stacks.stackOf(repo.id, issue))?.onIssue ?? null) : null;
  }

  /**
   * The issue a pull request must wait for before it may join the merge line:
   * the one its issue was stacked on, until that one has merged, however long
   * that takes. Null when it waits on nothing. A dependency that cannot be
   * read, is gone from the board, or is in Done because it was closed without
   * merging (`hasShipped`), is still waited on; a stack that cannot be read
   * throws, and the caller keeps the pull request out of the line.
   */
  async waitingOn(repoName: string, issue: number | null): Promise<number | null> {
    if (!issue) return null;
    const on = await this.stackedOn(repoName, issue);
    if (!on) return null;
    const repo = await repos.getRepoByName(repoName).catch(() => null);
    const dependency = repo ? await issues.getIssue(repo.id, on).catch(() => null) : null;
    return dependency && hasShipped(dependency) ? null : on;
  }

  /**
   * Starts every issue that may be stacked, and holds every stacked one whose
   * dependency was sent back. What it did, a line each.
   */
  async sweep(): Promise<string[]> {
    const done: string[] = [];
    const client = await this.deps.client().catch(() => null);
    if (!client) return done;
    // Holding what was sent back is not new work, so it goes on while paused.
    const starting = this.deps.dispatching() && !this.deps.paused();
    for (const repo of await repos.listRepos().catch(() => [])) {
      // A file that could not be read is not a file that is not there: taken
      // for one, a 502 turned stacking on for a repository that had it off.
      // Null only for a 404; the repository is skipped this pass otherwise.
      const file = await readDeliveryRulesFile((path) => client.readFileIfPresent(repo.fullName, path, repo.defaultBranch)).then(
        (text) => ({ text }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      if ('error' in file) {
        if (starting) done.push(`${repo.name}: no stacked work started, since ${DELIVERY_RULES_PATH} could not be read: ${file.error}`);
      } else {
        const policy = resolutionPolicy(file.text);
        if (starting && policy.stacking && !this.deps.paused(repo.name)) done.push(...(await this.startStacked(client, repo, policy.paths)));
      }
      done.push(...(await this.holdWhatWasSentBack(client, repo)));
      // Before the gate sweep of the same job (`Scheduler`), so a change let
      // go here has its reviews started in that pass.
      done.push(...(await this.letGoWhatIsSettled(client, repo)));
    }
    return done;
  }

  private async startStacked(
    client: Client,
    repo: { id: string; name: string; fullName: string; concurrency: number },
    paths: { shared: string[]; exclusive: string[] },
  ): Promise<string[]> {
    const done: string[] = [];
    for (const issue of await issues.listBlockedIssues(repo.id).catch(() => [])) {
      if (hasIgnoreLabel(issue.labels) || hasPausedLabel(issue.labels) || issue.prNumber || issue.declaredPaths.length === 0) continue;
      if (await leases.getActiveLease(repo.id, issue.number).catch(() => null)) continue;
      // Only what the dispatcher itself would lease. Anything labelled
      // `blocked` used to qualify, and triage and the spec skill label issues
      // that way routinely: issues still in design, or marked for a person,
      // were handed to a builder. `start:now` is not asked for; depending on
      // work in review is this path's own trigger.
      if (issue.stage !== 'build' || HELD_FOR_SOMEONE.some((label) => issue.labels.includes(label))) continue;
      if (missingForRouting(issue).length > 0) continue;
      if (tooManyAttempts(await leases.attemptsWithoutPullRequest(repo.id, issue.number).catch(() => Infinity))) continue;

      const outstanding: { number: number; stage: string; prNumber: number | null }[] = [];
      for (const ref of parseDependencyRefs(issue.body)) {
        // A branch cannot sit on another repository's branch: one there is
        // outstanding, and never the one this stacks on.
        if (!namesRepository(ref, repo.fullName)) {
          outstanding.push({ number: ref.number, stage: 'other-repository', prNumber: null });
          continue;
        }
        const dependency = await issues.getIssue(repo.id, ref.number).catch(() => null);
        if (!dependencyIsSatisfied(dependency)) outstanding.push(dependency ?? { number: ref.number, stage: 'unknown', prNumber: null });
      }
      // Only one thing outstanding, and that in review with its pull request.
      const [on] = outstanding;
      if (outstanding.length !== 1 || !on || on.stage !== 'review' || !on.prNumber) continue;
      // Not one level more: A is not itself stacked on work unmerged, or cannot be told not to be.
      if (await this.waitingOn(repo.name, on.number).catch(() => on.number)) continue;

      // The dispatcher's other two rules: no file another change holds, the
      // one it stacks on aside, since it starts from that one's branch; and
      // no more builds at once than the repository allows.
      const inFlight = await issues.workInFlight(repo.id).catch(() => null);
      if (!inFlight) continue;
      const others = inFlight.filter((work) => work.number !== on.number && work.number !== issue.number);
      if (blockingOverlaps(issue.declaredPaths, others, paths).length > 0) continue;
      const unfinished = await tasks.countUnfinishedImplementTasks(repo.id).catch(() => Infinity);
      if (unfinished >= repo.concurrency) continue;

      const pull = await client.getPullRequest(repo.fullName, on.prNumber).catch(() => null);
      if (!pull || pull.state !== 'open' || pull.merged || pull.headRepoFullName?.toLowerCase() !== repo.fullName.toLowerCase()) continue;
      const builderName = builderOfBranch(pull.headRef);
      const builder = builderName ? (await bots.listBots().catch(() => [])).find((bot) => bot.name === builderName) : null;
      if (!builder) continue;

      const lease = await leases.createLease({
        repoId: repo.id,
        issueNumber: issue.number,
        botId: builder.id,
        declaredPaths: issue.declaredPaths,
        expiresAt: leaseExpiryFrom(new Date(this.deps.now?.() ?? Date.now())),
      });
      // The stack is written before the build starts, and the build does not
      // start without it: a stacked build nothing records is a pull request
      // that joins the merge line with A's commits in it.
      const recorded = await stacks
        .recordStack({
          repoId: repo.id,
          issue: issue.number,
          onIssue: on.number,
          onPr: on.prNumber,
          onBranch: pull.headRef,
          onHeadSha: pull.headSha ?? null,
        })
        .then(
          () => true,
          () => false,
        );
      if (!recorded) {
        await leases.setLeaseState(lease.id, 'released').catch(() => undefined);
        continue;
      }
      const started = await this.deps
        .startBuild({
          leaseId: lease.id,
          repo,
          issue: issue.number,
          bot: { id: builder.id, name: builder.name },
          declaredPaths: lease.declaredPaths,
          expiresAt: lease.expiresAt,
          stackOn: { issue: on.number, pr: on.prNumber, branch: pull.headRef },
        })
        .catch((error: unknown) => ({ taskId: '', session: null, error: error instanceof Error ? error.message : String(error) }));
      if (started.error) {
        // A lease taken for a build that did not start holds nothing, nor
        // does its stack; the next sweep tries again.
        await leases.setLeaseState(lease.id, 'released').catch(() => undefined);
        await stacks.removeStack(repo.id, issue.number).catch(() => undefined);
        continue;
      }
      await this.record(STACK_STARTED, {
        repo: repo.name,
        issue: issue.number,
        on: on.number,
        onPr: on.prNumber,
        branch: pull.headRef,
        at: this.at(),
      } satisfies StartedPayload);
      done.push(`${repo.name}#${issue.number}: stacked on #${on.number}, from ${pull.headRef}`);
    }
    return done;
  }

  /**
   * Holds each stacked issue whose dependency was sent back before review, or
   * closed without merging: what it was built on is changing, or will not
   * land. Once per stacking, however long ago it started (`paused_at`).
   */
  private async holdWhatWasSentBack(client: Client, repo: { id: string; name: string; fullName: string }): Promise<string[]> {
    const done: string[] = [];
    for (const stack of await stacks.listStacks(repo.id).catch((): Stack[] => [])) {
      // Held once per stacking: a person who resumes it has decided.
      if (stack.pausedAt) continue;
      const issue = await issues.getIssue(repo.id, stack.issue).catch(() => null);
      if (!issue || hasPausedLabel(issue.labels) || issue.stage === 'merged' || issue.stage === 'done') continue;
      // Undefined when it could not be read, which says nothing; null when it is gone.
      const dependency = await issues.getIssue(repo.id, stack.onIssue).catch(() => undefined);
      if (dependency === undefined) continue;
      // Closed without merging: in Done, labelled `openadlc:abandoned`.
      const abandoned = Boolean(dependency && hasAbandonedLabel(dependency.labels));
      // Any stage before review, not only build: a person who moves it back to
      // spec or intake for a redesign changes what this was built on as much,
      // and its approvals were carried across the merge of the redone code.
      if (dependency && !abandoned && !SENT_BACK_TO.includes(dependency.stage)) continue;
      // Gone from the board is a dependency closed without merging too, from
      // before the reconciler kept such an issue in Done, or cancelled from
      // the board. Its pull request says for certain; one GitHub could not be
      // asked about waits.
      if (!dependency) {
        const pull = await client.getPullRequest(repo.fullName, stack.onPr).catch(() => undefined);
        if (!pull || pull.merged) continue;
      }

      const on = stack.onIssue;
      const sentBack = dependency && !abandoned ? dependency : null;
      const why = sentBack
        ? `#${on}, which this was built on, was sent back to ${sentBack.stage}: what it was built on is changing`
        : `#${on}, which this was built on, was closed without merging`;
      const note = sentBack
        ? `**Held.** This was started from #${on}'s branch while #${on} was in review, and #${on} has been sent back to ${sentBack.stage}. ` +
          `It goes on by itself once #${on} is approved again or merges: its reviews start then, and if #${on} changed files this changes too, ` +
          `its builder first brings it up to date. To let it go sooner, resume it from its card in OpenADLC (or take the \`${PAUSED_LABEL}\` label ` +
          `off this issue and its pull request); its pull request is then brought up to date with the base before it merges. ${START_OVER}`
        : `**Held.** This was started from #${on}'s branch while #${on} was in review, and #${on} was closed without merging, so its work is in this ` +
          `branch but will not land. Decide whether this still stands: resume it from its card in OpenADLC once that work lands another way ` +
          `(or take the \`${PAUSED_LABEL}\` label off this issue and its pull request). It goes on by itself if #${on} is reopened and approved. ${START_OVER}`;
      await client.addLabels(repo.fullName, issue.number, [PAUSED_LABEL]).catch(() => undefined);
      if (issue.prNumber) await client.addLabels(repo.fullName, issue.prNumber, [PAUSED_LABEL]).catch(() => undefined);
      await issues.setIssueLabels(repo.id, issue.number, [...new Set([...issue.labels, PAUSED_LABEL])]).catch(() => undefined);
      await recordHold(`${repo.name}#${issue.number}`, { by: 'openadlc', at: this.at(), why }, 'openadlc').catch(() => undefined);
      await client.comment(repo.fullName, issue.number, note).catch(() => undefined);
      await stacks.markPaused(repo.id, issue.number).catch(() => undefined);
      await this.record(STACK_PAUSED, { repo: repo.name, issue: issue.number, on, at: this.at() });
      done.push(`${repo.name}#${issue.number}: held, #${on} ${sentBack ? 'was sent back' : 'was closed without merging'}`);
    }
    return done;
  }

  /**
   * Lets go of each hold `holdWhatWasSentBack` put on once what it was built
   * on is settled: the dependency back in Review with its gate green on the
   * head it is at, or merged. Why goes on the issue, in the change's
   * timeline, and in the stack's record, which is held again by a later
   * send-back. A change whose dependency changed its files since it was
   * built goes to its builder to be brought up to date first; one whose
   * builder cannot take it is held again for a person, with why, and stays
   * held until a person resumes it. A hold a person put on is theirs.
   */
  private async letGoWhatIsSettled(client: Client, repo: { id: string; name: string; fullName: string }): Promise<string[]> {
    const done: string[] = [];
    const held = (await stacks.listStacks(repo.id).catch((): Stack[] => [])).filter((stack) => stack.pausedAt);
    if (held.length === 0) return done;
    const holds = await readHolds();
    for (const stack of held) {
      const key = `${repo.name}#${stack.issue}`;
      if (!waitsOnBase(holds[key])) continue;
      const issue = await issues.getIssue(repo.id, stack.issue).catch(() => null);
      if (!issue || !hasPausedLabel(issue.labels) || issue.stage === 'merged' || issue.stage === 'done') continue;
      // Undefined when it could not be read, which says nothing; null when it is gone.
      const dependency = await issues.getIssue(repo.id, stack.onIssue).catch(() => undefined);
      if (dependency === undefined) continue;
      // The dependency's pull request now: a new one if it was opened again.
      const base = await client.getPullRequest(repo.fullName, dependency?.prNumber ?? stack.onPr).catch(() => null);
      if (!base) continue;
      const approved =
        !base.merged &&
        base.state === 'open' &&
        dependency?.stage === 'review' &&
        !hasAbandonedLabel(dependency.labels) &&
        (await this.deps.gate?.(repo.fullName, base.headSha).catch(() => null)) === 'success';
      if (!base.merged && !approved) continue;

      const on = stack.onIssue;
      const short = base.headSha.slice(0, 7);
      const settled = base.merged ? `#${on}, which this was built on, merged` : `#${on}, which this was built on, was approved again at ${short}`;
      // Its own pull request, read now: undefined when GitHub did not answer.
      const own = issue.prNumber ? await client.getPullRequest(repo.fullName, issue.prNumber).catch(() => undefined) : null;
      if (own === undefined) continue;
      const open = own && own.state === 'open' ? own : null;
      const redo = open ? await this.changedUnder(client, repo.fullName, stack.onHeadSha, base.headSha, open.headSha) : null;
      if (redo === undefined) continue;

      // Its pull request first: an issue let go with its pull request still
      // labelled would be passed by on every sweep after, and the merge line
      // would hold the pull request for good.
      try {
        if (issue.prNumber) await client.removeLabel(repo.fullName, issue.prNumber, PAUSED_LABEL);
        await client.removeLabel(repo.fullName, issue.number, PAUSED_LABEL);
      } catch (error) {
        const why = error instanceof Error ? error.message.slice(0, 120) : String(error);
        done.push(`${key}: not let go, though ${settled}: GitHub kept the ${PAUSED_LABEL} label (${why})`);
        continue;
      }
      await issues.setIssueLabels(repo.id, issue.number, issue.labels.filter((label) => label !== PAUSED_LABEL)).catch(() => undefined);
      await forgetHold(key, 'openadlc').catch(() => undefined);
      await stacks.markLetGo(repo.id, issue.number, base.headSha).catch(() => undefined);
      await this.record(STACK_LET_GO, {
        repo: repo.name,
        issue: issue.number,
        on,
        onHead: base.headSha,
        merged: base.merged,
        redo: redo?.files ?? null,
        at: this.at(),
      });
      const subjects = [key, ...(issue.prNumber ? [`${repo.name}#${issue.prNumber}`] : [])];
      const say = this.deps.say ?? sayOnCard;

      if (!open || !redo) {
        const next = open ? 'its reviews start now' : 'it goes on where it was';
        await client.comment(repo.fullName, issue.number, `**Let go.** ${settled}, so this goes on: ${next}.`).catch(() => undefined);
        await say(subjects, `Let go by itself: ${settled}. ${open ? 'Its reviews start now.' : 'It goes on where it was.'}`, {
          stack: { on, onHead: base.headSha },
        }).catch(() => false);
        done.push(`${key}: let go, ${settled}; ${next}`);
        continue;
      }

      // What it was built on changed under it: its builder brings it up to
      // date, by the round a send-back opens, with this as its reason.
      const onto = base.merged ? `\`${open.baseRef}\`, which #${on} merged into` : `#${on}'s branch \`${base.headRef}\` at ${short}`;
      const changed =
        redo.files.length > 0
          ? `files this changes too since this was built on it: ${redo.files.map((file) => `\`${file}\``).join(', ')}`
          : `since this was built on it (${redo.why})`;
      const reason =
        `${settled}, and changed ${changed}. Bring this branch up to date with ${onto}: merge it in, resolve what conflicts, ` +
        `and make this change work on what #${on} became. Then push; it is reviewed again.`;
      const refused = this.deps.rebuild
        ? await this.deps
            .rebuild({ repoName: repo.name, prNumber: open.number, reason })
            .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
        : 'nothing here hands work to a builder';
      if (!refused) {
        await client
          .comment(repo.fullName, issue.number, `**Let go.** ${settled}, and changed what this was built on, so its builder brings this up to date with it first; then it is reviewed.`)
          .catch(() => undefined);
        await say(subjects, `Let go by itself: ${settled}. It changed what this was built on, so the builder brings it up to date first.`, {
          stack: { on, onHead: base.headSha },
        }).catch(() => false);
        done.push(`${key}: let go, ${settled}; its builder brings it up to date first`);
        continue;
      }

      // The builder cannot take it: held again, for a person this time.
      const why = `${settled}, and changed what this was built on; its builder could not bring it up to date: ${refused}`;
      await client.addLabels(repo.fullName, issue.number, [PAUSED_LABEL]).catch(() => undefined);
      await client.addLabels(repo.fullName, open.number, [PAUSED_LABEL]).catch(() => undefined);
      await issues.setIssueLabels(repo.id, issue.number, [...new Set([...issue.labels, PAUSED_LABEL])]).catch(() => undefined);
      await recordHold(key, { by: 'openadlc', at: this.at(), why, needsPerson: refused }, 'openadlc').catch(() => undefined);
      await stacks.markPaused(repo.id, issue.number).catch(() => undefined);
      await this.record(STACK_PAUSED, { repo: repo.name, issue: issue.number, on, at: this.at(), needsPerson: refused });
      await client
        .comment(
          repo.fullName,
          issue.number,
          `**Held for a person.** ${why}. Bring this branch up to date with ${onto}, then resume it from its card in OpenADLC (or take the \`${PAUSED_LABEL}\` label off this issue and its pull request). ${START_OVER}`,
        )
        .catch(() => undefined);
      await say(subjects, `Held for a person: ${why}.`, { stack: { on, onHead: base.headSha } }).catch(() => false);
      done.push(`${key}: held for a person, ${settled} and its builder could not bring it up to date: ${refused}`);
    }
    return done;
  }

  /**
   * Whether what a stacked change was built on changed its files since:
   * the files the dependency changed from the head the change started on to
   * where it is now, against the files the change made on top of it. Null
   * when they share none, or the dependency did not move; the shared files,
   * or why it cannot be told, when it must be brought up to date; undefined
   * when GitHub did not answer, to be asked on the next sweep.
   */
  private async changedUnder(
    client: Client,
    repoFullName: string,
    builtOn: string | null,
    baseHead: string,
    head: string,
  ): Promise<{ files: string[]; why?: string } | null | undefined> {
    if (builtOn === baseHead) return null;
    if (!builtOn) return { files: [], why: 'the head it was built on was not recorded' };
    try {
      const theirs = await client.changedFilesBetween(repoFullName, builtOn, baseHead);
      const mine = await client.changedFilesBetween(repoFullName, builtOn, head);
      if (!theirs || !mine) return { files: [], why: 'too many files changed to compare' };
      const own = new Set(mine);
      const shared = theirs.filter((file) => own.has(file));
      return shared.length > 0 ? { files: shared } : null;
    } catch {
      return undefined;
    }
  }

  /**
   * The merge line is about to bring a pull request's branch up to date.
   * True when it is a stacked one whose dependency has merged: this update
   * takes out what the dependency landed, and the line makes it with
   * `mergeIntoBranch` so it knows the commit it made (`made`). Noted first,
   * so a push that arrives before the line has GitHub's answer waits for it.
   */
  async updating(input: { repoName: string; prNumber: number; issue: number | null; repoFullName: string; baseRef: string; headSha: string }): Promise<boolean> {
    if (!input.issue) return false;
    const on = await this.stackedOn(input.repoName, input.issue);
    if (!on || (await this.waitingOn(input.repoName, input.issue))) return false;
    const client = await this.deps.client().catch(() => null);
    const files = client ? await client.changedFilesBetween(input.repoFullName, input.baseRef, input.headSha).catch(() => null) : null;
    if (!files) return false;
    await this.record(STACK_UPDATING, {
      repo: input.repoName,
      pr: input.prNumber,
      issue: input.issue,
      on,
      from: input.headSha,
      files,
      at: this.at(),
    } satisfies UpdatingPayload);
    return true;
  }

  /**
   * What the line's stacked update made: the merge commit GitHub answered
   * with, whose first parent is the head the line read, or null when it
   * conflicted, failed, or landed on a head that had moved. Only a push to
   * that exact commit keeps the approvals.
   */
  async made(input: { repoName: string; prNumber: number; from: string; to: string | null }): Promise<void> {
    await this.record(STACK_MADE, { repo: input.repoName, pr: input.prNumber, from: input.from, to: input.to, at: this.at() } satisfies MadePayload);
  }

  /**
   * A push to a pull request: whether it is the commit the line's stacked
   * update made (`made`), from the head it noted and to the SHA GitHub
   * answered with, and not already matched once. Then the approvals stand.
   * Who pushed, and which files changed, decide nothing: the line pushes with
   * the builder's own token, and a merge commit made through the API can
   * carry any tree.
   */
  async pushed(input: { repoName: string; prNumber: number; before: string; after: string; prFiles: readonly string[] }): Promise<boolean> {
    const key = `${input.repoName}#${input.prNumber}:${input.before}..${input.after}`;
    if (!input.before || !input.after || this.claiming.has(key)) return false;
    this.claiming.add(key);
    try {
      const made = await this.madeFor(input);
      if (!made) return false;
      const [noted] = (await this.events<UpdatingPayload>(STACK_UPDATING, input.repoName)).filter(
        (row) => row.payload.pr === input.prNumber && row.payload.from === input.before,
      );
      if (!noted) return false;
      // Never more files than before: a merge of the base can only take some out.
      const before = new Set(noted.payload.files);
      if (!input.prFiles.every((file) => before.has(file))) return false;
      const used = (await this.events<UpdatedPayload>(STACK_UPDATED, input.repoName)).some(
        (row) => row.payload.pr === input.prNumber && row.payload.from === input.before && row.payload.to === input.after,
      );
      if (used) return false;
      await this.record(STACK_UPDATED, {
        repo: input.repoName,
        pr: input.prNumber,
        issue: noted.payload.issue,
        on: noted.payload.on,
        from: input.before,
        to: input.after,
        at: this.at(),
      } satisfies UpdatedPayload);
      return true;
    } finally {
      this.claiming.delete(key);
    }
  }

  /**
   * Whether the line recorded making exactly `before`..`after`. While its
   * latest note from `before` is fresh and has nothing recorded after it, the
   * line may still be waiting on GitHub, so this reads again a few times.
   */
  private async madeFor(input: { repoName: string; prNumber: number; before: string; after: string }): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let tries = 0; ; tries++) {
      const made = (await this.events<MadePayload>(STACK_MADE, input.repoName)).filter(
        (row) => row.payload.pr === input.prNumber && row.payload.from === input.before,
      );
      if (made.some((row) => row.payload.to === input.after)) return true;
      const [noted] = (await this.events<UpdatingPayload>(STACK_UPDATING, input.repoName)).filter(
        (row) => row.payload.pr === input.prNumber && row.payload.from === input.before,
      );
      const now = this.deps.now?.() ?? Date.now();
      const waiting = noted && now - Date.parse(noted.at) < NOTE_FRESH_MS && !made.some((row) => Date.parse(row.at) >= Date.parse(noted.at));
      if (!waiting || tries >= MADE_WAIT_TRIES) return false;
      await sleep(MADE_WAIT_MS);
    }
  }

  /** The earlier heads whose reviews a stacked update carried to `head`, followed back. */
  async carriedTo(repoName: string, prNumber: number, head: string): Promise<Set<string>> {
    const links = (await this.events<UpdatedPayload>(STACK_UPDATED, repoName)).filter((row) => row.payload.pr === prNumber).map((row) => row.payload);
    const carried = new Set<string>();
    let frontier = [head];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const sha of frontier) {
        for (const link of links) {
          if (link.to === sha && !carried.has(link.from)) {
            carried.add(link.from);
            next.push(link.from);
          }
        }
      }
      frontier = next;
    }
    return carried;
  }
}

/** A stacked change OpenADLC holds, as Needs you reads it (`heldStacks`). */
export interface HeldStack {
  repo: string;
  issue: number;
  /** The issue it was built on, and that one's pull request when it was stacked. */
  on: number;
  onPr: number;
  /** When it was held, and why, as the hold was recorded. */
  since: string;
  why: string | null;
  /** Why it waits on a person rather than on what it was built on (`ItemHold.needsPerson`); null while it waits on that. */
  needsPerson: string | null;
}

/**
 * The stacked changes OpenADLC holds among `held`, the issues labelled
 * `openadlc:paused`: one read of the holds, and one of the stacks of each
 * repository they are in. A hold a person put on, or took over, is not one.
 */
export async function heldStacks(held: readonly { repoId: string; repoName: string; number: number }[]): Promise<HeldStack[]> {
  if (held.length === 0) return [];
  const holds = await readHolds();
  const found: HeldStack[] = [];
  for (const repoId of new Set(held.map((one) => one.repoId))) {
    const inRepo = held.filter((one) => one.repoId === repoId);
    for (const stack of await stacks.listStacks(repoId)) {
      const issue = inRepo.find((one) => one.number === stack.issue);
      const hold = issue ? holds[`${issue.repoName}#${issue.number}`] : undefined;
      if (!issue || !stack.pausedAt || hold?.by !== 'openadlc') continue;
      found.push({
        repo: issue.repoName,
        issue: issue.number,
        on: stack.onIssue,
        onPr: stack.onPr,
        since: hold.at || stack.pausedAt,
        why: hold.why,
        needsPerson: hold.needsPerson ?? null,
      });
    }
  }
  return found;
}

/** What a stacked build is told about where it starts. */
export function stackBrief(on: { issue: number; pr: number; branch: string }): ContextDocument {
  return {
    name: 'stacked-on.md',
    title: `Built on #${on.issue}, still in review`,
    content: [
      `This issue depends on #${on.issue}, whose pull request #${on.pr} is in review. Your branch starts from its branch, \`${on.branch}\`, so its work is already here: build on it, and do not change its files beyond what this issue needs.`,
      '',
      `Open your pull request against the default branch as usual, and say in its description: "Stacked on #${on.pr}: until it merges, this diff includes its commits." It does not join the merge line until #${on.pr} has merged; the line then brings it up to date.`,
    ].join('\n'),
  };
}
