import { bots, leases, listEventsOfTypeWith, recordEvent, repos } from '@fleetadlc/db';
import type { GitHubClient } from '@fleetadlc/github';
import { allShared, DELIVERY_RULES_PATH, resolutionPolicyStrict, type ContextDocument } from '@fleetadlc/shared';
import { mayDefineCi } from './automation.js';
import { issueNumberFromBranch } from './work.js';
import { BotBusyError, type TaskService } from './task-service.js';

/**
 * A pull request whose branch conflicts with the base at the front of the
 * merge line gets a short resolution round, not a whole one.
 *
 * It was sent back to build: the card to Build, a patch round, and every
 * reviewer again — for what was usually two lines added to the same Makefile
 * target by two changes that each passed review. Now the builder merges the
 * base into its branch and resolves only the files the two sides both
 * changed, commits the merge, runs `make ci` on it and pushes. When every one
 * of those files is one the repository calls shared (`paths.shared` in
 * `.github/fleetadlc.yml`, read by `resolutionPolicyStrict` and `allShared`),
 * the lead re-checks the resolution alone, and the other seats' approvals stand while
 * the lead's own has to be of the new head; otherwise the reviews run again in
 * full, as before. A file that can decide how CI runs, and AGENTS.md, are
 * always reviewed in full, whatever the repository calls shared. GitHub's own
 * update of a branch ignores merge drivers, so there is no resolving these
 * without a task.
 *
 * The events are what the console's velocity figures read; their names and
 * fields are kept as they are.
 */
export const CONFLICT_RESOLVING = 'conflict.resolving';
export const CONFLICT_RESOLVED = 'conflict.resolved';
export const CONFLICT_SENT_BACK = 'conflict.sent_back';

/**
 * The `why` of the `conflict.sent_back` a resolution reviewed again in full
 * records. That pull request is reviewed again where it is, not sent back to
 * Build, and Insights counted it twice, as reviewed in full and as sent back
 * (`aggregateInsights` passes over these).
 */
export const FULL_REVIEW_WHY = {
  notShared: 'a conflicted file is not a shared one',
  beyondTheConflict: 'the resolution changed files beyond the conflict',
} as const;

export type ResolutionReview = 'lead-only' | 'full';

interface ResolvingPayload {
  repo: string;
  pr: number;
  issue: number | null;
  files: string[];
  review: ResolutionReview;
  head: string;
  prFiles: string[];
  /** The branch it conflicts with; absent on a round recorded before it was kept. */
  base?: string;
  /**
   * Set while the round has not started: `busy`, its builder or every host
   * had no room, and the merge sweep starts it once there is; `blocked`, the
   * start was recorded as a failed task (a health check, a spending cap,
   * hostd's refusal), which Try again or the recovery runs again.
   */
  pending?: 'busy' | 'blocked';
  at: string;
}

interface ResolvedPayload {
  repo: string;
  pr: number;
  issue: number | null;
  files: string[];
  review: ResolutionReview;
  from: string;
  to: string;
  at: string;
}

type Client = Pick<
  GitHubClient,
  'getPullRequest' | 'listPullFilesAsNamed' | 'filesChangedOnBaseSince' | 'changedFilesBetween' | 'readFileIfPresent' | 'comment'
>;

/**
 * Files a conflict in is always reviewed in full. A file that decides how CI
 * runs lands on the security reviewer's verdict, which a lead-only round
 * carried from the head before the resolution; AGENTS.md says who reviews
 * what. The defaults call the Makefile, package.json and AGENTS.md shared,
 * because many changes add to them; for building side by side they are.
 */
export function reviewedInFull(path: string): boolean {
  return mayDefineCi(path) || /(^|\/)AGENTS\.md$/.test(path);
}

export interface ConflictRoundDeps {
  taskService: Pick<TaskService, 'open'>;
  client: () => Promise<Client | null>;
  /** The whole round, as before: what a resolution falls back to when it cannot be had. */
  backToBuild: (input: { repoName: string; prNumber: number; reason: string }) => Promise<void>;
  record?: (input: { type: string; payload: unknown }) => Promise<unknown>;
  /** The events of a type about one pull request, at any age. */
  events?: (type: string, fields: { repo: string; pr: number }) => Promise<{ at: string; payload: unknown }[]>;
  now?: () => number;
}

export class ConflictRounds {
  constructor(private readonly deps: ConflictRoundDeps) {}

  private record(type: string, payload: object): Promise<unknown> {
    const write = this.deps.record ?? ((input: { type: string; payload: unknown }) => recordEvent({ source: 'platform', ...input }));
    return write({ type, payload }).catch(() => undefined);
  }

  /**
   * Every event of a type about one pull request. Not the last few days of
   * them: a pull request that waited longer than that to land (on a person,
   * a red run, a weekend) lost its carried approvals and stalled in review,
   * and a resolution pushed late was taken for an ordinary push.
   */
  private events(type: string, repoName: string, prNumber: number): Promise<{ at: string; payload: unknown }[]> {
    const read = this.deps.events ?? listEventsOfTypeWith;
    return read(type, { repo: repoName, pr: prNumber }).catch(() => []);
  }

  private at(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  /**
   * The branch conflicts with the base: open the resolution round, or fall
   * back to the whole round when there is no builder to give it to or the
   * files cannot be told.
   */
  async start(input: { repoName: string; prNumber: number; baseRef: string }): Promise<'resolving' | 'pending' | 'sent_back'> {
    const repo = await repos.getRepoByName(input.repoName);
    const client = repo ? await this.deps.client().catch(() => null) : null;
    const pull = repo && client ? await client.getPullRequest(repo.fullName, input.prNumber).catch(() => null) : null;
    const issue = pull ? issueNumberFromBranch(pull.headRef) : null;
    const fallBack = async (why: string): Promise<'sent_back'> => {
      await this.record(CONFLICT_SENT_BACK, { repo: input.repoName, pr: input.prNumber, issue, files: [], why, at: this.at() });
      await this.deps.backToBuild({
        repoName: input.repoName,
        prNumber: input.prNumber,
        reason: `The branch left the merge line: it conflicts with ${input.baseRef}. Bring it up to date and resolve it, run fleetadlc-ci, and push.`,
      });
      return 'sent_back';
    };
    if (!repo || !client || !pull) return fallBack('the pull request could not be read');

    const prFiles = await client.listPullFilesAsNamed(repo.fullName, input.prNumber).catch(() => null);
    const onBase = await client.filesChangedOnBaseSince(repo.fullName, pull.headSha, input.baseRef).catch(() => undefined);
    // Null is a comparison GitHub capped: a conflicted file can be missing from
    // it, so a round on what it does name could pass for a lead-only one.
    if (onBase === null) return fallBack('the base changed too many files to tell which conflict');
    const files = prFiles && onBase ? prFiles.filter((file) => onBase.includes(file)) : [];
    if (files.length === 0) return fallBack('which files conflict could not be told');

    const lease = issue ? await leases.getActiveLease(repo.id, issue).catch(() => null) : null;
    if (!lease) return fallBack('its issue has no builder holding it');

    // Read strictly: a file that could not be read (anything but a 404) or
    // does not parse gives a full review, not the broad defaults. A 502 used
    // to read as "no file", and the defaults call the Makefile shared.
    const rules = await client
      .readFileIfPresent(repo.fullName, DELIVERY_RULES_PATH, repo.defaultBranch)
      .then((text) => ({ text }))
      .catch(() => null);
    const policy = rules ? resolutionPolicyStrict(rules.text) : null;
    const review: ResolutionReview = policy && !files.some(reviewedInFull) && allShared(files, policy) ? 'lead-only' : 'full';

    const builder = await bots.getBotById(lease.botId).catch(() => null);
    if (!builder) return fallBack('the builder holding its issue is no longer in the crew');

    const opened: { started: true } | { pending: 'busy' | 'blocked' } | null = await this.deps.taskService
      .open({
        botId: builder.id,
        bot: builder.name,
        repo: repo.name,
        kind: 'patch',
        subjectType: 'pr',
        subjectRef: `${repo.name}#${input.prNumber}`,
        skill: 'resolve-conflict',
        branch: pull.headRef,
        issueNumber: issue,
        checkoutExistingBranch: true,
        leaseId: lease.id,
        // Only the conflicted files: the round resolves, it does not rework.
        declaredPaths: files,
        whenBlocked: 'record',
        extraContext: [resolutionBrief({ base: input.baseRef, files, review })],
      })
      // A start that answered with an error recorded a failed task that says
      // why: it was taken for a started round, which said "resolving" while
      // nothing ran, and every sweep conflicted again and added another.
      .then((result) => (result.error ? { pending: 'blocked' as const } : { started: true as const }))
      .catch((error: unknown) => {
        // A busy builder (one task at a time, by default) or a full host is a
        // wait, not a reason to send the whole change back to build.
        if (error instanceof BotBusyError) return { pending: 'busy' as const };
        console.warn(`[bridge] ${repo.name}#${input.prNumber}: resolution round not started: ${error instanceof Error ? error.message : error}`);
        return null;
      });
    if (!opened) return fallBack('the resolution round could not be started');

    const round: ResolvingPayload = {
      repo: repo.name,
      pr: input.prNumber,
      issue,
      files,
      review,
      head: pull.headSha,
      prFiles: prFiles ?? [],
      base: input.baseRef,
      at: this.at(),
    };
    if ('pending' in opened) {
      // Kept out of the merge line until it can start (`MergeLine.enter`), and
      // said once: the merge sweep asks again every few minutes.
      const already = await this.unstarted(repo.name, input.prNumber);
      if (already?.pending !== opened.pending) await this.record(CONFLICT_RESOLVING, { ...round, pending: opened.pending });
      if (!already) console.log(`[bridge] ${repo.name}#${input.prNumber}: conflicts with ${input.baseRef}; its resolution round waits to start (${opened.pending})`);
      return 'pending';
    }

    await this.record(CONFLICT_RESOLVING, round);
    console.log(`[bridge] ${repo.name}#${input.prNumber}: conflicts with ${input.baseRef} in ${files.join(', ')}; resolution round opened (${review} review after)`);
    await client
      .comment(
        repo.fullName,
        input.prNumber,
        `This conflicts with ${input.baseRef} in ${files.map((file) => `\`${file}\``).join(', ')}. The builder is resolving just those files; ` +
          (review === 'lead-only'
            ? 'they are files many changes add to, so the lead re-checks the resolution and has to approve it before this merges; the other approvals stand.'
            : 'the reviews run again once it is resolved.'),
      )
      .catch(() => undefined);
    return 'resolving';
  }

  /**
   * A push to a pull request a resolution round was opened on: whether the
   * lead re-checks only the resolution, or the reviews run in full. Null when
   * no resolution is waiting on it — an ordinary push.
   *
   * Lead-only holds only if the push changed nothing but the conflicted files
   * and what the base brought, unchanged: every other file it touched is one
   * the base changed, with the base's content. Names alone were checked, and
   * a resolution could rewrite any file the pull request already changed —
   * the Makefile's `ci` target — under the lead's glance at two lines. A
   * comparison GitHub cannot make is a full review too: not knowing is not
   * unchanged. `at` is when it was recorded: a lead review task opened before
   * it is not a review of the resolution.
   */
  async pushed(input: {
    repoName: string;
    repoFullName: string;
    prNumber: number;
    before: string;
    after: string;
    baseRef: string;
    prFiles: readonly string[];
  }): Promise<{ review: ResolutionReview; files: string[]; at: string } | null> {
    const resolving = await this.pending(input.repoName, input.prNumber);
    if (!resolving) return null;
    const allowed = new Set([...resolving.prFiles, ...resolving.files]);
    const within =
      resolving.review === 'lead-only' &&
      input.prFiles.every((file) => allowed.has(file)) &&
      (await this.onlyTheConflict(resolving, input).catch(() => false));
    const review: ResolutionReview = resolving.review === 'lead-only' && within ? 'lead-only' : 'full';
    const at = this.at();
    await this.record(CONFLICT_RESOLVED, {
      repo: input.repoName,
      pr: input.prNumber,
      issue: resolving.issue,
      files: resolving.files,
      review,
      from: input.before,
      to: input.after,
      at,
    } satisfies ResolvedPayload);
    if (review === 'full') {
      await this.record(CONFLICT_SENT_BACK, {
        repo: input.repoName,
        pr: input.prNumber,
        issue: resolving.issue,
        files: resolving.files,
        why: resolving.review === 'full' ? FULL_REVIEW_WHY.notShared : FULL_REVIEW_WHY.beyondTheConflict,
        at: this.at(),
      });
    }
    return { review, files: resolving.files, at };
  }

  /** Whether a push changed only the conflicted files and what the base brought, as the base has it. */
  private async onlyTheConflict(
    resolving: ResolvingPayload,
    input: { repoFullName: string; before: string; after: string; baseRef: string },
  ): Promise<boolean> {
    const client = await this.deps.client();
    if (!client) return false;
    const touched = await client.changedFilesBetween(input.repoFullName, input.before, input.after);
    // Null is a comparison GitHub capped, which may have left some files out.
    if (!touched) return false;
    const conflicted = new Set(resolving.files);
    const rest = touched.filter((file) => !conflicted.has(file));
    if (rest.length === 0) return true;
    const onBase = await client.filesChangedOnBaseSince(input.repoFullName, resolving.head, input.baseRef);
    if (!onBase) return false;
    for (const file of rest) {
      if (!onBase.includes(file)) return false;
      const [mine, base] = await Promise.all([
        client.readFileIfPresent(input.repoFullName, file, input.after),
        client.readFileIfPresent(input.repoFullName, file, input.baseRef),
      ]);
      if (mine !== base) return false;
    }
    return true;
  }

  /**
   * Whether a resolution round is open on a pull request and not yet pushed.
   * While one is, every push is the round's to classify, even one whose diff
   * against the base fingerprints the same: a resolution that kept the pull
   * request's side of a conflicted file is still one the lead re-checks.
   */
  async resolving(repoName: string, prNumber: number): Promise<boolean> {
    return (await this.pending(repoName, prNumber)) !== null;
  }

  /**
   * The resolution round on a pull request that could not start yet, if there
   * is one: the pull request stays out of the merge line while it waits, and
   * one waiting for room is started again by the merge sweep.
   */
  async unstarted(repoName: string, prNumber: number): Promise<{ base: string | null; pending: 'busy' | 'blocked' } | null> {
    const round = await this.pending(repoName, prNumber);
    return round?.pending ? { base: round.base ?? null, pending: round.pending } : null;
  }

  /**
   * The resolution round opened on a pull request and not yet pushed, if there
   * is one, started or not. One that never started and fell back to the whole
   * round since is over.
   */
  private async pending(repoName: string, prNumber: number): Promise<ResolvingPayload | null> {
    const mine = <P extends { repo: string; pr: number }>(rows: { at: string; payload: unknown }[]) =>
      rows
        .map((row) => ({ at: row.at, payload: row.payload as P }))
        .filter((row) => row.payload?.repo === repoName && row.payload?.pr === prNumber)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const [resolving] = mine<ResolvingPayload>(await this.events(CONFLICT_RESOLVING, repoName, prNumber));
    if (!resolving) return null;
    const [resolved] = mine<ResolvedPayload>(await this.events(CONFLICT_RESOLVED, repoName, prNumber));
    if (resolved && Date.parse(resolved.at) >= Date.parse(resolving.at)) return null;
    if (resolving.payload.pending) {
      const [sentBack] = mine<{ repo: string; pr: number }>(await this.events(CONFLICT_SENT_BACK, repoName, prNumber));
      if (sentBack && Date.parse(sentBack.at) >= Date.parse(resolving.at)) return null;
    }
    return resolving.payload;
  }

  /**
   * The earlier heads whose approvals still count for `head`: each one a
   * lead-only resolution led from, followed back. They stand for the other
   * seats' reviews only, so those are not asked for again over two added
   * lines. The lead's approval has to be of `head` itself, or of a head with
   * its diff (`resolvedAt`): the lead's re-check is the only review the
   * resolution gets.
   */
  async carriedTo(repoName: string, prNumber: number, head: string): Promise<Set<string>> {
    const resolved = (await this.events(CONFLICT_RESOLVED, repoName, prNumber))
      .map((row) => row.payload as ResolvedPayload)
      .filter((payload) => payload?.repo === repoName && payload.pr === prNumber && payload.review === 'lead-only');
    const carried = new Set<string>();
    let frontier = [head];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const sha of frontier) {
        for (const payload of resolved) {
          if (payload.to === sha && !carried.has(payload.from)) {
            carried.add(payload.from);
            next.push(payload.from);
          }
        }
      }
      frontier = next;
    }
    return carried;
  }

  /**
   * When the lead-only resolution that led to `head` was pushed, or null when
   * none did. From then the lead re-checks it, and an approval the lead gave
   * before is of a head nobody saw resolved. Unlike `carriedTo`, a read that
   * fails throws: not knowing must not let the lead's earlier approval stand.
   */
  async resolvedAt(repoName: string, prNumber: number, head: string): Promise<string | null> {
    const read = this.deps.events ?? listEventsOfTypeWith;
    const times = (await read(CONFLICT_RESOLVED, { repo: repoName, pr: prNumber }))
      .map((row) => ({ at: row.at, payload: row.payload as ResolvedPayload }))
      .filter(({ payload }) => payload?.repo === repoName && payload.pr === prNumber && payload.review === 'lead-only' && payload.to === head)
      .map(({ at, payload }) => payload.at ?? at)
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    return times[0] ?? null;
  }
}

/**
 * The lead-only resolution that was pushed as `head`, if there is one: what
 * the lead re-checks there, and when it was pushed.
 *
 * Read by the gate sweep, so a lead that was busy at the push is asked again
 * with the same brief, and only once for that resolution.
 */
export async function leadOnlyResolutionTo(
  repoName: string,
  prNumber: number,
  head: string,
  read: (type: string, fields: Record<string, string | number>) => Promise<{ at: string; payload: unknown }[]> = listEventsOfTypeWith,
): Promise<{ from: string; to: string; files: string[]; at: string } | null> {
  const rows = await read(CONFLICT_RESOLVED, { repo: repoName, pr: prNumber, to: head, review: 'lead-only' }).catch(() => []);
  const [newest] = rows
    .map((row) => ({ at: row.at, payload: row.payload as ResolvedPayload }))
    .filter(({ payload }) => payload?.repo === repoName && payload.pr === prNumber && payload.to === head && payload.review === 'lead-only')
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return newest ? { from: newest.payload.from, to: newest.payload.to, files: newest.payload.files, at: newest.payload.at ?? newest.at } : null;
}

/**
 * What a resolution round run again (Try again, or the recovery) is given:
 * the brief and the conflicted files of its pull request's newest round. Run
 * again as an ordinary patch round, it had no brief and could write every
 * file in the pull request. Null when no round was recorded on it.
 */
export async function resolutionRetry(
  repoName: string,
  prNumber: number,
  defaultBase: string,
  read: (type: string, fields: Record<string, string | number>) => Promise<{ at: string; payload: unknown }[]> = listEventsOfTypeWith,
): Promise<{ files: string[]; brief: ContextDocument } | null> {
  const rows = await read(CONFLICT_RESOLVING, { repo: repoName, pr: prNumber }).catch(() => []);
  const [newest] = rows
    .map((row) => ({ at: row.at, payload: row.payload as ResolvingPayload }))
    .filter(({ payload }) => payload?.repo === repoName && payload.pr === prNumber && Array.isArray(payload.files) && payload.files.length > 0)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!newest) return null;
  const { files, review, base } = newest.payload;
  return { files, brief: resolutionBrief({ base: base ?? defaultBase, files, review }) };
}

/** What the builder is told the round is for. */
function resolutionBrief(input: { base: string; files: string[]; review: ResolutionReview }): ContextDocument {
  return {
    name: 'resolve-conflict.md',
    title: 'Resolve the conflict with the base',
    content: [
      `Your branch conflicts with \`${input.base}\` in:`,
      '',
      ...input.files.map((file) => `- \`${file}\``),
      '',
      `Merge \`${input.base}\` into your branch and resolve only these files, keeping what both sides meant: usually both sides' additions, in a sensible order. Change nothing else. Commit the merge, then run \`fleetadlc-ci\` on it and push.`,
      '',
      input.review === 'lead-only'
        ? 'These are files many changes add to: the lead re-checks your resolution, and the other approvals stand if you change nothing but these files and what the base brought. Anything else you change makes it a full review again.'
        : 'Once you push, the reviews run again in full.',
    ].join('\n'),
  };
}

/** What the lead is told when it re-checks only a resolution. */
export function resolutionCheckBrief(input: { before: string; after: string; files: readonly string[] }): ContextDocument {
  return {
    name: 'resolution-check.md',
    title: 'Re-check only the conflict resolution',
    content: [
      'The change you and the other reviewers already reviewed conflicted with the base when it reached the front of the merge line. The builder merged the base in and resolved:',
      '',
      ...input.files.map((file) => `- \`${file}\``),
      '',
      `Review only the resolution: \`git show --cc ${input.after} -- ${input.files.join(' ')}\` shows it, and \`git diff --stat ${input.before} ${input.after}\` must name nothing beyond these files and what the base brought. Approve this head if both sides' intent is kept and nothing else changed: nothing merges until you do, and the other reviewers' approvals of the change stand. Request changes otherwise, and the reviews run again in full.`,
    ].join('\n'),
  };
}
