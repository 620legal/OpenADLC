import { NEXT_LABEL, PAUSED_LABEL, hasNextLabel, inertMarkup } from '@fleetadlc/shared';
import { forgetHold, type ItemHold, recordHold } from './item-hold.js';
import { HttpFailure, type Router } from './router.js';
import { publicNameOf } from './thread-view.js';
import { issueNumberFromBranch } from './work.js';

/**
 * A person's controls on one piece of work, from its card: hold it, let it go
 * on, build it next, or cancel it.
 *
 * - **Pause** puts `fleetadlc:paused` on the issue and its pull request: the
 *   step running finishes, and nothing new starts — the dispatcher passes it
 *   over, the task service opens nothing on it, the merge line holds it.
 * - **Resume** takes it off and starts what the hold kept back.
 * - **Next** puts `fleetadlc:next` on it, and the dispatcher builds it ahead of
 *   priority order once nothing it overlaps is in flight. One per repository:
 *   putting it on one takes it off any other.
 * - **Cancel** takes the issue off the board, stops its tasks, closes its
 *   questions, closes the pull request unmerged and deletes its branch when
 *   it is the crew's own for this issue, closes the issue as not planned with
 *   the reason, lets its lease go and takes it out of the merge line. Each step is
 *   its own, as removing a repository's are: one GitHub refuses does not stop
 *   the rest, and the answer says what was done and what was not. Work that
 *   has merged is not cancelled: its change is already in. A request that has
 *   not become an issue is abandoned, so the request queue never starts it
 *   again.
 *
 * All four are an admin's (`roles.ts`), and all four are audited.
 */

/** A work item as these routes need it; see `main.ts`, which reads it from `items.ts`. */
export interface ControlledItem {
  key: string;
  repoName: string;
  repoFullName: string;
  repoId: string;
  /** The repository's default branch, which Cancel never deletes; null when not known. */
  defaultBranch: string | null;
  /** `stage` is the board's, null when the board has none for it. */
  issue: { number: number; title: string; url: string; labels: string[]; stage: string | null } | null;
  /**
   * As GitHub has it; the head's repository, `merged` and `state` are null when
   * GitHub could not be asked, and its branch is then never deleted.
   */
  pr: {
    number: number;
    url: string;
    branch: string | null;
    headRepoFullName: string | null;
    merged: boolean | null;
    state: 'open' | 'closed' | null;
  } | null;
  /** The request it started as, while it has not become an issue; null otherwise. */
  request?: { id: string; state: string } | null;
  /** Every subject its work is filed under. */
  subjects: string[];
}

/** Just enough of GitHub, as the automation account and as the app. */
export interface ControlGitHub {
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  removeLabel(repo: string, number: number, label: string): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<unknown>;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface ItemControlDeps {
  resolve(subject: string): Promise<ControlledItem | null>;
  /** The automation account's client for a repository; null when it cannot act. */
  github(repoFullName: string): Promise<ControlGitHub | null>;
  /** The app's, which may delete a branch the automation account cannot; null when there is none. */
  app?(repoFullName: string): Promise<Pick<ControlGitHub, 'request'> | null>;
  /** The issues of a repository the board has, with their labels, to move `next` off another. */
  issuesOf(repoName: string): Promise<{ number: number; labels: string[] }[]>;
  /**
   * Creates one of OpenADLC's labels on the repository, as the app, when it is
   * not there yet (`RepoSetup.ensureLabel`); whether it is there now.
   */
  ensureLabel?(repoFullName: string, label: string): Promise<boolean>;
  /** Writes an issue's labels to the board at once, rather than when GitHub's delivery arrives. */
  setLabels(repoId: string, number: number, labels: string[]): Promise<void>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
  /** Its tasks, every subject. */
  tasks(subjects: readonly string[]): Promise<{ id: string; bot: string; kind: string; state: string }[]>;
  /** How many questions are open on it. */
  openQuestions(subjects: readonly string[]): Promise<number>;
  /** A card's Stop; how many of the task's questions stopping it closed. */
  stop(taskId: string, actor: string, note: string): Promise<{ questionsClosed: number }>;
  /** Closes a task's open questions; how many. */
  closeQuestions(taskId: string, actor: string, reason: string): Promise<number>;
  leaveMergeLine(repoName: string, prNumber: number): Promise<void>;
  /** Lets go of the issue's lease; whether there was one. */
  releaseLease(repoId: string, issueNumber: number, reason: string): Promise<boolean>;
  /** Ends a request for good (`abandonRequest`): what was done, or why it was not. */
  abandonRequest?(requestId: string, actor: string, note: string): Promise<string>;
  /** Drops the issue from the board's read model (`issues.forget`), which is what the dispatcher leases from. */
  forget?(repoId: string, issueNumber: number): Promise<void>;
  /** What the hold kept back, started: a dispatch, the stage sweep, the reviews, the merge line. */
  resumed?(item: ControlledItem): Promise<void>;
  /** Holds a paused item's pull request now: auto-merge off, `review-gate` pending (`Automation.pausePull`). */
  pausePull?(repoFullName: string, prNumber: number): Promise<unknown>;
  /** A dispatch soon, after a change of order. */
  dispatchSoon?(reason: string): void;
  now?(): Date;
}

const UNFINISHED = ['queued', 'running', 'paused'];

/** One step of a cancel, as the console lists it. */
export interface CancelStep {
  step: 'board' | 'tasks' | 'questions' | 'request' | 'pull request' | 'branch' | 'issue' | 'lease' | 'merge line';
  done: boolean;
  what: string;
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Whether GitHub refused because the label is not on the repository. Adding a
 * label that is not there creates it, so a triage account is told 403 "You do
 * not have permission to create labels on this repository" — not 404 or 422.
 */
function labelMissing(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 422) return true;
  return status === 403 && /create labels/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * What GitHub's refusal means, as a sentence the card shows. Its own text — the
 * path, the JSON, a header — was what the card showed, and said nothing a
 * person could act on.
 */
export function gitHubFailure(error: unknown, item: { key: string; repoFullName: string }, number: number, label: string): HttpFailure {
  const status = statusOf(error);
  const where = `${item.repoFullName}#${number}`;
  const sentence = labelMissing(error)
    ? `GitHub would not put ${label} on ${where}: ${item.repoFullName} has no such label, and OpenADLC could not make it. Set the repository up again from Settings → Repositories.`
    : status === 401
      ? 'GitHub no longer accepts the automation account’s sign-in: reconnect it from Settings → GitHub → Connected accounts.'
      : status === 404
        ? `GitHub cannot find ${where}, or the automation account cannot see it.`
        : status === 403
          ? `The automation account may not change labels in ${item.repoFullName}: give it triage access or more on GitHub.`
          : status === null
            ? 'GitHub did not answer. Try again in a minute.'
            : `GitHub refused to change ${where} (${status}). Try again.`;
  console.warn(`[bridge] ${item.key}: putting ${label} on ${where} failed: ${error instanceof Error ? error.message : error}`);
  return new HttpFailure(status === 401 || status === null ? 503 : 409, sentence);
}

/**
 * The branch Cancel deletes, or null when it deletes none. Only the crew's own
 * branch for this issue (`agent/<bot>/<issue>-…`) in the issue's repository:
 * the branch was named by the pull request's head alone and deleted in the
 * base repository, so a fork's pull request, or a release pull request from
 * `develop` that closed a tracked issue, cost the repository its own branch
 * of that name.
 */
function branchToDelete(item: ControlledItem): string | null {
  const pr = item.pr;
  if (!item.issue || !pr?.branch || !pr.headRepoFullName) return null;
  if (pr.headRepoFullName.toLowerCase() !== item.repoFullName.toLowerCase()) return null;
  if (pr.branch === item.defaultBranch) return null;
  return issueNumberFromBranch(pr.branch) === item.issue.number ? pr.branch : null;
}

export function registerItemControlRoutes(router: Router, deps: ItemControlDeps): void {
  const itemOf = async (subject: string | undefined): Promise<ControlledItem> => {
    const item = await deps.resolve(subject ?? '');
    if (!item) throw new HttpFailure(404, `${subject || 'that'} is not a piece of work on the board`);
    return item;
  };
  // Holding and putting next are about an issue: a request with none yet is
  // intake's, and has its own line.
  const issueOf = (item: ControlledItem) => {
    if (!item.issue) throw new HttpFailure(409, `${item.key} has no issue yet; only an issue can be held or put next`);
    return item.issue;
  };
  const githubFor = async (item: ControlledItem) => {
    const client = await deps.github(item.repoFullName);
    if (!client) throw new HttpFailure(503, 'the automation account is not connected, so GitHub cannot be changed: reconnect it from Settings → GitHub → Connected accounts');
    return client;
  };
  // Puts one of our labels on an issue. One the repository lacks, the app makes
  // first: adding it would make it, which triage may not do (GitHub's 403).
  const putLabel = async (client: ControlGitHub, item: ControlledItem, number: number, label: string): Promise<void> => {
    try {
      await client.addLabels(item.repoFullName, number, [label]);
      return;
    } catch (error) {
      if (!labelMissing(error)) throw gitHubFailure(error, item, number, label);
      const made = await deps.ensureLabel?.(item.repoFullName, label).catch(() => false);
      if (!made) throw gitHubFailure(error, item, number, label);
    }
    await client.addLabels(item.repoFullName, number, [label]).catch((error: unknown) => {
      throw gitHubFailure(error, item, number, label);
    });
  };
  // Takes one of our labels off. A label already gone is what was wanted
  // (`GitHubClient.removeLabel` says 404 is done); anything else fails the
  // route. Swallowed, Resume answered done and cleared the board while GitHub
  // still carried the label, and the merge line still held the pull request.
  const takeLabel = async (client: ControlGitHub, item: ControlledItem, number: number, label: string): Promise<void> => {
    await client.removeLabel(item.repoFullName, number, label).catch((error: unknown) => {
      if (statusOf(error) === 404) return;
      throw gitHubFailure(error, item, number, label);
    });
  };
  const reasonOf = (input: { reason?: unknown } | null | undefined): string | null =>
    typeof input?.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 300) : null;

  router.post('/v1/items/:subject/pause', async ({ params, body, identity }) => {
    const item = await itemOf(params.subject);
    const issue = issueOf(item);
    const client = await githubFor(item);
    const why = reasonOf(await body<{ reason?: unknown }>().catch(() => null));
    await putLabel(client, item, issue.number, PAUSED_LABEL);
    if (item.pr) {
      // The merge line holds a pull request by its own label: one GitHub did
      // not take is not held, and an approved one could merge after the pause.
      // The issue's label goes again, so a pause that failed changes nothing.
      await putLabel(client, item, item.pr.number, PAUSED_LABEL).catch(async (error: unknown) => {
        if (!issue.labels.includes(PAUSED_LABEL)) await client.removeLabel(item.repoFullName, issue.number, PAUSED_LABEL).catch(() => undefined);
        throw error;
      });
      await deps.pausePull?.(item.repoFullName, item.pr.number).catch((error: unknown) =>
        console.warn(`[bridge] ${item.key} paused, but its pull request's gate was not held now: ${error instanceof Error ? error.message : error}`),
      );
    }
    await deps.setLabels(item.repoId, issue.number, [...new Set([...issue.labels, PAUSED_LABEL])]);
    const held: ItemHold = { by: identity, at: (deps.now?.() ?? new Date()).toISOString(), why };
    await recordHold(`${item.repoName}#${issue.number}`, held, identity);
    await deps.audit({ actor: identity, action: 'item.paused', target: item.key, payload: { why } });
    return { subject: item.key, held };
  });

  router.post('/v1/items/:subject/resume', async ({ params, identity }) => {
    const item = await itemOf(params.subject);
    const issue = issueOf(item);
    const client = await githubFor(item);
    await takeLabel(client, item, issue.number, PAUSED_LABEL);
    if (item.pr) await takeLabel(client, item, item.pr.number, PAUSED_LABEL);
    await deps.setLabels(item.repoId, issue.number, issue.labels.filter((label) => label !== PAUSED_LABEL));
    await recordHold(`${item.repoName}#${issue.number}`, null, identity);
    await deps.audit({ actor: identity, action: 'item.resumed', target: item.key });
    await deps.resumed?.(item).catch((error: unknown) =>
      console.warn(`[bridge] ${item.key} resumed, but what it held did not all start: ${error instanceof Error ? error.message : error}`),
    );
    return { subject: item.key, held: null };
  });

  router.post('/v1/items/:subject/next', async ({ params, body, identity }) => {
    const item = await itemOf(params.subject);
    const issue = issueOf(item);
    const client = await githubFor(item);
    const input = await body<{ on?: unknown }>().catch(() => ({}) as { on?: unknown });
    const on = input?.on !== false;
    const moved: number[] = [];
    if (on) {
      // One per repository: next means first, and two firsts is none.
      for (const other of await deps.issuesOf(item.repoName)) {
        if (other.number === issue.number || !hasNextLabel(other.labels)) continue;
        await takeLabel(client, item, other.number, NEXT_LABEL);
        await deps.setLabels(item.repoId, other.number, other.labels.filter((label) => label !== NEXT_LABEL));
        moved.push(other.number);
      }
      await putLabel(client, item, issue.number, NEXT_LABEL);
      await deps.setLabels(item.repoId, issue.number, [...new Set([...issue.labels, NEXT_LABEL])]);
    } else {
      await takeLabel(client, item, issue.number, NEXT_LABEL);
      await deps.setLabels(item.repoId, issue.number, issue.labels.filter((label) => label !== NEXT_LABEL));
    }
    await deps.audit({ actor: identity, action: on ? 'item.next' : 'item.not_next', target: item.key, payload: { tookFrom: moved } });
    deps.dispatchSoon?.(`${item.key} ${on ? 'was put next' : 'is no longer next'}`);
    return { subject: item.key, next: on, tookFrom: moved };
  });

  router.get('/v1/items/:subject/cancel', async ({ params }) => {
    const item = await itemOf(params.subject);
    const tasks = (await deps.tasks(item.subjects)).filter((task) => UNFINISHED.includes(task.state));
    return {
      issue: item.issue ? { number: item.issue.number, title: item.issue.title, url: item.issue.url } : null,
      // Its branch only when Cancel will delete it, so the warning is true.
      pr: item.pr ? { number: item.pr.number, url: item.pr.url, branch: branchToDelete(item) } : null,
      tasks,
      questions: await deps.openQuestions(item.subjects),
    };
  });

  router.post('/v1/items/:subject/cancel', async ({ params, body, identity }) => {
    const item = await itemOf(params.subject);
    const reason = reasonOf(await body<{ reason?: unknown }>().catch(() => null));
    if (!reason) throw new HttpFailure(400, 'say why it is cancelled: the reason goes on the issue');
    // Merged work is live, or on its way: cancelling it stopped its deploy and
    // QA, let its lease go and closed the issue as not planned.
    if (item.pr?.merged || item.issue?.stage === 'merged' || item.issue?.stage === 'done') {
      throw new HttpFailure(409, `${item.key} has already merged, so it cannot be cancelled. To take the change back, revert its pull request on GitHub`);
    }
    const steps: CancelStep[] = [];
    const step = async (name: CancelStep['step'], run: () => Promise<string>): Promise<void> => {
      try {
        steps.push({ step: name, done: true, what: await run() });
      } catch (error) {
        steps.push({ step: name, done: false, what: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
    };
    const said = `Cancelled by ${identity}: ${reason}`;
    // What goes on GitHub goes as a crew account: a marker in the reason
    // would read as the crew's own (`inertMarkup`). And it names the person,
    // never their address (`publicNameOf`); the audit keeps who it was.
    const posted = `Cancelled by ${publicNameOf(identity)}: ${inertMarkup(reason)}`;

    // Off the board before anything stops. Stopping a task lets its lease go
    // and asks for a dispatch at once, which found the issue still routable
    // with `start:now`, leased it again and built it again; and the lease step
    // below then let go of that new build's lease, not this one's.
    const forget = deps.forget;
    if (item.issue && forget) {
      const issue = item.issue;
      await step('board', async () => {
        await forget(item.repoId, issue.number);
        return `took #${issue.number} off the board`;
      });
    }

    // Its work first, so nothing is still writing to the branch that goes.
    // Each task on its own, as removing a repository does: one hostd refuses
    // stopped the loop, and the tasks after it were never asked.
    const going = (await deps.tasks(item.subjects)).filter((task) => UNFINISHED.includes(task.state));
    const stillRunning: typeof going = [];
    // Stopping a task closes its questions itself, so what it closed counts
    // here: closeQuestions afterwards finds none, and the step said none were open.
    let closed = 0;
    for (const task of going) {
      try {
        closed += (await deps.stop(task.id, identity, said)).questionsClosed;
      } catch (error) {
        stillRunning.push(task);
        const why = error instanceof Error ? error.message.slice(0, 200) : String(error);
        steps.push({ step: 'tasks', done: false, what: `the ${task.kind} task ${task.id} is still ${task.state}: ${why}` });
      }
    }
    const stopped = going.length - stillRunning.length;
    if (stopped > 0 || going.length === 0) {
      steps.push({ step: 'tasks', done: true, what: going.length === 0 ? 'none were running' : `stopped ${stopped}` });
    }
    await step('questions', async () => {
      for (const task of going) closed += await deps.closeQuestions(task.id, identity, said);
      return closed === 0 ? 'none were open' : `closed ${closed}`;
    });

    // A request that is not an issue yet: its tasks stopped above left it
    // queued or a draft, and the request queue started a queued one again.
    // Abandoned, it is never started again, and only then is it cancelled.
    const request = item.issue ? null : (item.request ?? null);
    if (request) {
      await step('request', async () => {
        if (!deps.abandonRequest) throw new Error('nothing here can abandon a request');
        return deps.abandonRequest(request.id, identity, said);
      });
    }

    const client = await deps.github(item.repoFullName);
    if (item.pr) {
      const pr = item.pr;
      await step('pull request', async () => {
        if (!client) throw new Error('the automation account is not connected');
        await client.comment(item.repoFullName, pr.number, `${posted}\n\nClosed unmerged from the board.`).catch(() => undefined);
        await client.request('PATCH', `/repos/${item.repoFullName}/pulls/${pr.number}`, { state: 'closed' });
        return `closed #${pr.number} unmerged`;
      });
      await step('merge line', async () => {
        await deps.leaveMergeLine(item.repoName, pr.number);
        return 'out of the merge line';
      });
      const branch = branchToDelete(item);
      if (branch) {
        await step('branch', async () => {
          // A session that did not stop could push it back, or open a new
          // pull request from it: the branch stays until its task is stopped.
          if (stillRunning.length > 0) {
            const tasks = stillRunning.length === 1 ? 'a task on it' : `${stillRunning.length} tasks on it`;
            throw new Error(`kept ${branch}, because ${tasks} could not be stopped. Stop it from its card, then delete the branch on GitHub`);
          }
          // The app can delete what a triage account cannot.
          const deleter = (await deps.app?.(item.repoFullName)) ?? client;
          if (!deleter) throw new Error('nothing here can delete it');
          await deleter.request('DELETE', `/repos/${item.repoFullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
          return `deleted ${branch}`;
        });
      }
    }
    if (item.issue) {
      const issue = item.issue;
      await step('issue', async () => {
        if (!client) throw new Error('the automation account is not connected');
        await client.comment(item.repoFullName, issue.number, posted).catch(() => undefined);
        await client.request('PATCH', `/repos/${item.repoFullName}/issues/${issue.number}`, { state: 'closed', state_reason: 'not_planned' });
        return `closed #${issue.number} as not planned`;
      });
      await step('lease', async () => ((await deps.releaseLease(item.repoId, issue.number, said)) ? 'let go' : 'it held none'));
      // A hold on it is over with it: kept, its record would name this person
      // and reason for a later hold somebody else put on.
      await forgetHold(`${item.repoName}#${issue.number}`, identity).catch(() => undefined);
    }

    await deps.audit({ actor: identity, action: 'item.cancelled', target: item.key, payload: { reason, steps } });
    return {
      subject: item.key,
      cancelled: steps.every((one) => one.done),
      steps,
      // As the console lists them: what was done, and what was not with why.
      done: steps.filter((one) => one.done).map((one) => one.what),
      notDone: steps.filter((one) => !one.done).map((one) => ({ step: one.step, what: `the ${one.step} step did not finish`, why: one.what })),
    };
  });
}
