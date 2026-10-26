import { audit, recordEvent, repos, requests, tasks, threads } from '@openadlc/db';
import type { GitHubClient } from '@openadlc/github';
import type { Task } from '@openadlc/shared';
import type { Actors } from './actors.js';
import { asAutomation } from './automation-bot.js';
import type { BridgeConfig } from './config.js';
import { requestFor, requestLineFor, requestPrefixOf } from './request-context.js';
import { linkFiled } from './work-items.js';

/**
 * A console request moves with its triage.
 *
 * `queued` while it waits for the intake bot to be free (`request-queue.ts`
 * starts it, and it is `draft` from then on), `draft` while triage works on it, `questions` while it waits on the person
 * who asked, and `filed` once it is an issue — one in each repository it
 * concerns, recorded in `request_issues` (`requests.fileIssue`), which is the
 * only link between the two. Nothing moved a request before: it was a
 * draft for good, and the issue triage filed from it was an issue nobody could
 * trace back to what was asked.
 */

type Moving = 'questions' | 'draft' | 'abandoned';

/**
 * Where each move may start. A request that is filed or abandoned is finished,
 * so a gate opened late by a task still on it does not reopen it.
 */
const FROM: Record<Moving, requests.RequestRecord['state'][]> = {
  questions: ['draft'],
  draft: ['questions'],
  // A person stopped its triage at the cost cap, or no longer wants it
  // (`abandonRequest`). A queued one too: it leaves the queue by starting or
  // by being abandoned, and the queue claims only a request still `queued`.
  abandoned: ['queued', 'draft', 'questions'],
};

/**
 * A question on a request's task makes the request wait on its person, and the
 * answer hands it back to triage, which resumes on it. Any other subject is
 * left alone: an issue says it is waiting with `needs-human`.
 */
export async function moveRequest(
  task: Pick<Task, 'subjectRef'>,
  to: Moving,
): Promise<requests.RequestRecord | null> {
  if (!requestPrefixOf(task.subjectRef)) return null;
  const request = await requestFor(task.subjectRef);
  if (!request || !FROM[to].includes(request.state)) return null;
  return requests.updateRequest(request.id, { state: to });
}

/** What abandoning a request did: nothing for one unknown or finished, else what it stopped. */
export type Abandoned =
  | { outcome: 'unknown' }
  | { outcome: 'finished'; state: requests.RequestRecord['state'] }
  | { outcome: 'abandoned'; request: requests.RequestRecord; stopped: number; questionsClosed: number };

/**
 * Ends a request a person no longer wants, from its card or by cancelling it.
 *
 * Its triage is stopped and its questions closed first, so nothing goes on
 * filing it; then it is `abandoned`, which nothing starts again: the request
 * queue claims only a `queued` one. Before this the only way to abandon one
 * was the cost cap's answer, and Cancel stopped the tasks but left the request
 * queued, so the queue started it again later. A task hostd would not stop
 * fails the whole thing, with the request left as it was, to be tried again.
 */
export async function abandonRequest(input: {
  requestId: string;
  actor: string;
  note: string;
  /** A card's Stop for unfinished work (`stopTask` with `unfinished`). */
  stop: (taskId: string, actor: string, note: string) => Promise<{ questionsClosed: number }>;
}): Promise<Abandoned> {
  const request = await requests.getRequest(input.requestId);
  if (!request) return { outcome: 'unknown' };
  if (!FROM.abandoned.includes(request.state)) return { outcome: 'finished', state: request.state };
  const subject = `request:${request.id.slice(0, 8).toLowerCase()}`;
  const going = (await tasks.listTasksOnSubjects([subject])).filter(
    (task) => task.kind === 'intake' && ['queued', 'running', 'paused'].includes(task.state),
  );
  let questionsClosed = 0;
  for (const task of going) questionsClosed += (await input.stop(task.id, input.actor, input.note)).questionsClosed;
  // Read again: a triage can file it, or a person answer it, while that ran.
  const now = await requests.getRequest(request.id);
  if (!now || !FROM.abandoned.includes(now.state)) return { outcome: 'finished', state: now?.state ?? request.state };
  const abandoned = await requests.updateRequest(request.id, { state: 'abandoned' });
  await audit({
    actor: input.actor,
    action: 'request.abandoned',
    target: subject,
    payload: { requestId: request.id, from: now.state, stopped: going.length, questionsClosed, note: input.note },
  }).catch(() => undefined);
  return { outcome: 'abandoned', request: abandoned ?? { ...now, state: 'abandoned' }, stopped: going.length, questionsClosed };
}

/**
 * Whether an issue's body carries the line naming the request it was filed
 * for. A model writes it, so emphasis, code marks and a list bullet around it
 * are forgiven; another request's id is not.
 */
export function carriesRequestLine(body: string | null, subjectRef: string): boolean {
  const prefix = requestPrefixOf(subjectRef);
  if (!body || !prefix) return false;
  const plain = body.replace(/[`*]/g, '');
  return new RegExp(`^[ \\t>-]*OpenADLC request:\\s*request:${prefix}(?![0-9a-f])`, 'im').test(plain);
}

/**
 * The request an issue's body names, by the line the triage skill writes; see
 * `carriesRequestLine`, which it agrees with.
 */
export function requestPrefixIn(body: string | null): string | null {
  if (!body) return null;
  const plain = body.replace(/[`*]/g, '');
  return /^[ \t>-]*OpenADLC request:\s*request:([0-9a-f]{8})(?![0-9a-f])/im.exec(plain)?.[1] ?? null;
}

/** How far back a finished triage is looked for: one page, newest first. */
const RECENT = 100;

/**
 * How far past its triage's end an issue's GitHub `created_at` may be and
 * still be one the triage filed: GitHub's clock and the bridge's differ.
 */
const CLOCK_SKEW_MS = 30_000;

/** An issue a request was filed as, as the filing reads it. */
interface FiledIssue {
  repo: string;
  repoId: string;
  number: number;
  title: string;
  htmlUrl: string;
}

/**
 * Every issue in these repositories that carries the request's line: intake
 * files a request that spans repositories as one issue in each.
 */
async function filedIn(
  client: Pick<GitHubClient, 'listIssues'>,
  candidates: readonly { id: string; fullName: string }[],
  subjectRef: string,
): Promise<FiledIssue[]> {
  const found: FiledIssue[] = [];
  for (const repo of candidates) {
    // By when each last changed: a request resolved by an existing issue —
    // "use #5 instead" — writes its line into that issue, which can be far
    // older than the newest hundred opened.
    const recent = await client.listIssues(repo.fullName, { state: 'all', perPage: RECENT, sort: 'updated' }).catch((error: unknown) => {
      console.warn(`[bridge] could not read ${repo.fullName}'s issues: ${error instanceof Error ? error.message : error}`);
      return [];
    });
    // The issues endpoint lists pull requests too, and a pull request that
    // quotes the line is not the issue that was filed. Oldest first, the
    // order intake filed them in.
    for (const issue of recent.filter((entry) => !entry.pullRequest && carriesRequestLine(entry.body, subjectRef)).reverse()) {
      found.push({ repo: repo.fullName, repoId: repo.id, number: issue.number, title: issue.title, htmlUrl: issue.htmlUrl });
    }
  }
  return found;
}

/** Whether the request already has this issue. */
const hasIssue = (request: requests.RequestRecord, repoId: string, number: number): boolean =>
  request.issues.some((issue) => issue.repoId === repoId && issue.number === number);

export class RequestFiling {
  constructor(
    /** GitHub is read as the automation account, whichever bot that is now. */
    private readonly actors: Pick<Actors, 'asBot'>,
    private readonly config: Pick<BridgeConfig, 'automationBot'>,
    private readonly options: {
      /** How long a finished triage waits before looking for its issue a second time. */
      lookAgainAfterMs?: number;
    } = {},
  ) {}

  /**
   * An issue that names the request it was filed for files that request, as
   * soon as GitHub delivers it.
   *
   * A triage's own ending looks for its issue among the repository's recent
   * ones, and GitHub's list can lag an issue created a moment before: intake
   * filed openadlc-testbed#7 four seconds before its task ended, the list did not
   * have it yet, and the request was left a draft, its thread saying triage
   * had filed nothing. The delivery carries the body, and arrives first.
   *
   * In any managed repository while the request's triage runs, since intake
   * files a request that spans repositories as one issue in each, and after
   * it ends for an issue GitHub says was opened while it ran. Otherwise only
   * as its first issue and in the repository it named: an issue somebody
   * opens later quoting the line is not one triage filed. True when the issue
   * is the request's.
   */
  async issueOpened(
    repo: { id: string; fullName: string },
    issue: { number: number; title: string; body: string | null; htmlUrl: string },
  ): Promise<boolean> {
    const prefix = requestPrefixIn(issue.body);
    if (!prefix) return false;
    const subjectRef = `request:${prefix}`;
    const request = await requestFor(subjectRef);
    if (!request || request.state === 'abandoned') return false;

    const onSubject = (await tasks.listTasksOnSubjects([subjectRef])).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const triaging = onSubject.some((task) => task.kind === 'intake' && ['queued', 'running', 'paused'].includes(task.state));
    const first = request.issues.length === 0 && (!request.repoId || request.repoId === repo.id);
    if (!triaging && !first && !hasIssue(request, repo.id, issue.number) && !(await this.openedDuringTriage(repo, issue.number, onSubject))) {
      return false;
    }

    await this.file(request, { repo: repo.fullName, repoId: repo.id, number: issue.number, title: issue.title, htmlUrl: issue.htmlUrl }, onSubject[0] ?? null);
    return true;
  }

  /**
   * Whether GitHub says the issue was opened while one of the request's
   * triages ran. The task is written `done` before its ending looks for the
   * issues, and the `opened` delivery of the last one intake files can arrive
   * after both: the ending's list did not have it yet, and the delivery found
   * no triage running, so a request's second issue was dropped. Read only on
   * that refusal; an issue opened after the triage ended still joins nothing.
   */
  private async openedDuringTriage(repo: { fullName: string }, number: number, onSubject: readonly Task[]): Promise<boolean> {
    const ran = onSubject.filter((task) => task.kind === 'intake' && task.startedAt && task.endedAt);
    if (ran.length === 0) return false;
    const client = await asAutomation(this.actors, this.config);
    const opened = client ? await client.getIssue(repo.fullName, number).catch(() => null) : null;
    if (!opened) return false;
    const at = Date.parse(opened.createdAt);
    return ran.some((task) => Date.parse(task.startedAt!) <= at && at <= Date.parse(task.endedAt!) + CLOCK_SKEW_MS);
  }

  /**
   * A request's triage ended `done`: find every issue it filed and file the
   * request as each, or say in the thread that nothing was filed.
   *
   * The issues are found by the line the triage skill writes in their bodies,
   * among each managed repository's recent issues: intake decides which
   * repositories a request concerns, the one the person named among them or
   * not, and files one issue in each.
   */
  async triageEnded(task: Task): Promise<{ repo: string; issue: number }[]> {
    const request = await requestFor(task.subjectRef);
    if (!request || request.state === 'abandoned') return [];

    const candidates = await repos.listRepos();
    const client = await asAutomation(this.actors, this.config);
    let found = client ? await filedIn(client, candidates, task.subjectRef) : [];
    // Once more, a moment later: the list can lag an issue filed just now,
    // and the issue's own delivery may file the request in the meantime.
    // With several repositories, also when some were found or recorded: the
    // last issue intake files, in another repository, is the one most likely
    // missing, and the others say nothing about it.
    if (client && ((found.length === 0 && request.issues.length === 0) || candidates.length > 1)) {
      await new Promise((resolve) => setTimeout(resolve, this.options.lookAgainAfterMs ?? 3000));
      const again = await filedIn(client, candidates, task.subjectRef);
      found = [...found, ...again.filter((one) => !found.some((seen) => seen.repoId === one.repoId && seen.number === one.number))];
    }

    // Read again: a delivery may have recorded some of them meanwhile.
    const now = (await requestFor(task.subjectRef)) ?? request;
    if (found.length === 0 && now.issues.length === 0) {
      const thread = await threads.ensureThread({
        botId: task.botId,
        repoId: task.repoId,
        subjectRef: task.subjectRef,
      });
      const where = candidates.map((repo) => repo.fullName).join(', ') || 'no repository';
      await threads.addMessage({
        threadId: thread.id,
        kind: 'sys',
        author: 'openadlc',
        text: `Triage of ${task.subjectRef} ended without filing anything`,
        note: client
          ? `no recent issue in ${where} carries “${requestLineFor(task.subjectRef)}”`
          : 'the automation account is not connected, so GitHub could not be read for the issue',
        payload: { taskId: task.id, requestId: request.id },
      });
      return [];
    }

    const filed: { repo: string; issue: number }[] = [];
    for (const issue of found) {
      if (hasIssue(now, issue.repoId, issue.number)) continue;
      if (await this.file(now, issue, task)) filed.push({ repo: issue.repo, issue: issue.number });
    }
    return filed;
  }

  /**
   * The request, filed as the issue; its triage's thread says which. False
   * when the issue was recorded already, which says nothing twice, or the
   * request was abandoned meanwhile.
   */
  private async file(
    request: requests.RequestRecord,
    found: FiledIssue,
    task: Pick<Task, 'id' | 'botId' | 'repoId' | 'subjectRef'> | null,
  ): Promise<boolean> {
    // A request that named no repository was filed where intake chose: kept,
    // so its card in Intake can link the issue.
    const recorded = await requests.fileIssue(request.id, found.repoId, found.number).catch((error: unknown) => {
      if (error instanceof requests.RequestAbandoned) return null;
      throw error;
    });
    if (!recorded?.added) return false;
    // The issue joins the request's work item, so it carries the number the
    // request had before intake started, and a request's second issue, in
    // another repository, joins the first. Never in the way of the filing.
    await linkFiled(request, { id: found.repoId }, found).catch((error: unknown) =>
      console.warn(`[bridge] ${found.repo}#${found.number} was filed for request ${request.id.slice(0, 8)}, and did not join its work item: ${error instanceof Error ? error.message : error}`),
    );
    if (task) {
      const thread = await threads.ensureThread({ botId: task.botId, repoId: task.repoId, subjectRef: task.subjectRef });
      await threads.addMessage({
        threadId: thread.id,
        kind: 'sys',
        author: 'openadlc',
        text: `Filed as ${found.repo}#${found.number}`,
        note: found.title,
        payload: { taskId: task.id, requestId: request.id, issue: found.number },
        githubUrl: found.htmlUrl,
      });
    }
    await recordEvent({
      source: 'platform',
      type: 'request.filed',
      payload: { requestId: request.id, repo: found.repo, issue: found.number },
    }).catch(() => undefined);
    return true;
  }
}
