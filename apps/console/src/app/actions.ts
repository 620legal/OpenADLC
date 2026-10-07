'use server';

import { revalidatePath } from 'next/cache';
import { BRIDGE_URL, type DesignMemoryEntry, type RemovalChoices, type RemovalPreview, type RemovalReport } from '@/lib/api';
import { stillFailing, type CheckState } from '@/lib/health-recheck';
import type { RepoAccess } from '@/lib/crew-access';
import { identityHeaders } from '@/lib/identity';
import { BRIDGE_NOT_ANSWERING, reach } from '@/lib/reach';
import { terminalUrlFrom } from '@/lib/terminal-url';

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await reach(
    `${BRIDGE_URL}${path}`,
    {
      method,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        // The person's credential has to be carried across this hop, not replaced
        // with a constant: an install that verifies identity refuses a request
        // that arrives without the assertion, and audits whatever does arrive.
        ...(await identityHeaders()),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    BRIDGE_NOT_ANSWERING,
  );
  const text = await response.text();
  if (!response.ok) {
    const message = (() => {
      try {
        return (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        return text;
      }
    })();
    throw new BridgeRefusal(message.slice(0, 300), response.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** The bridge answered, and refused: its words, and the status they came with. */
class BridgeRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function answerGate(gateId: string, answer: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/gates/${encodeURIComponent(gateId)}/answer`, 'POST', { answer });
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not answer' };
  }
}

/**
 * Starts the intake bot on a request whose triage failed, the "Try again" on
 * what needs you. The bridge refuses one already filed or abandoned, and says so.
 */
export async function retryTriage(requestId: string): Promise<{ ok: boolean; error?: string; bot?: string }> {
  try {
    const result = await call<{ bot?: string }>(`/v1/requests/${encodeURIComponent(requestId)}/triage`, 'POST');
    revalidatePath('/');
    return { ok: true, bot: result.bot };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not start triage again' };
  }
}

/**
 * Ends a request its person no longer wants, the "Abandon" on a failed triage:
 * its triage stops, and nothing starts it again. The bridge refuses one already
 * filed or abandoned, and says so.
 */
export async function abandonRequest(requestId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/requests/${encodeURIComponent(requestId)}/abandon`, 'POST');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not abandon the request' };
  }
}

/**
 * Runs a failed or stopped task again: the same work, by the same bot, on the
 * same subject — the "Try again" on its card. The bridge refuses when that
 * work is already going again, or the bot is busy, and says which.
 */
export async function retryTask(taskId: string): Promise<{ ok: boolean; error?: string; bot?: string }> {
  try {
    const result = await call<{ bot?: string; task?: { error?: string } }>(`/v1/tasks/${encodeURIComponent(taskId)}/retry`, 'POST');
    revalidatePath('/');
    // Started, and refused at once: the reason is the new card's, and said here too.
    if (result.task?.error) return { ok: false, error: result.task.error, bot: result.bot };
    return { ok: true, bot: result.bot };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not start it again' };
  }
}

/**
 * Stops a task that failed or was stopped under it, for good: hostd ends what
 * is left of its session, its lease is released, and its card goes. The
 * "Stop" beside "Try again", on its card and in its thread.
 */
export async function stopTask(taskId: string): Promise<{ ok: boolean; error?: string; releasedLease?: string | null }> {
  try {
    const result = await call<{ releasedLease?: string | null }>(`/v1/tasks/${encodeURIComponent(taskId)}/stop`, 'POST', {});
    revalidatePath('/');
    return { ok: true, releasedLease: result.releasedLease ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not stop it' };
  }
}

/**
 * Stops every task a folded card stands for, in turn. Stopping only the
 * newest left the older ones to come back as their own card. One the
 * bridge refuses, say because someone has just tried it again, does not keep
 * the rest running: each is asked, and the ones that did not stop are named.
 */
export async function stopTasks(taskIds: string[]): Promise<{ ok: boolean; error?: string; failed?: string[] }> {
  const refused: { taskId: string; error: string }[] = [];
  for (const taskId of taskIds) {
    const stopped = await stopTask(taskId);
    if (!stopped.ok) refused.push({ taskId, error: stopped.error ?? 'could not stop it' });
  }
  if (refused.length === 0) return { ok: true };
  const stoppedCount = taskIds.length - refused.length;
  const why = refused.map((one) => `task ${one.taskId.slice(0, 8)}: ${one.error}`).join('; ');
  return {
    ok: false,
    error: `${stoppedCount} of ${taskIds.length} stopped; ${refused.length === 1 ? 'this one did not' : 'these did not'}: ${why}`,
    failed: refused.map((one) => one.taskId),
  };
}

/**
 * "Dismiss" on a failed task's card: nothing is tried again or stopped. The
 * bridge keeps which end the person saw, and the card stays away until the
 * task ends again.
 */
export async function dismissTasks(tasks: { taskId: string; occurrence: string }[]): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const task of tasks) {
      await call(`/v1/tasks/${encodeURIComponent(task.taskId)}/dismiss`, 'POST', { occurrence: task.occurrence });
    }
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not dismiss it' };
  }
}

/**
 * "Dismiss" on a notice that has nothing to fix, such as a crew post OpenADLC
 * did not sign: the bridge keeps which occurrence the person saw, and the
 * card stays away until a newer one arrives.
 */
export async function acknowledgeNotice(checkId: string, occurrence: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/health/${encodeURIComponent(checkId)}/acknowledge`, 'POST', { occurrence });
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not dismiss it' };
  }
}

/** Stops the board saying something was fixed. */
export async function dismissNotice(checkId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/health/${encodeURIComponent(checkId)}/dismiss`, 'POST');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not dismiss it' };
  }
}

/**
 * Asks one health check again now. The board is read again either way: a
 * check that still fails keeps its card, one that passes turns it into "fixed".
 */
export async function recheckHealth(checkId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await call<{ checks?: CheckState[] }>(`/v1/health/checks/${encodeURIComponent(checkId)}/run`, 'POST');
    revalidatePath('/');
    const still = stillFailing(result.checks ?? [], checkId);
    return still ? { ok: false, error: still } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not check it again' };
  }
}

/**
 * A person's message to a bot, about `subject`: the issue, pull request or
 * console request it is sent to. The bridge posts one about GitHub there as a
 * comment and adds one about a request to that request's thread. It was sent
 * with no subject, and landed in a thread about nothing that no bot reads.
 */
export async function sendMessage(
  bot: string,
  text: string,
  subject: string | null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/threads/${encodeURIComponent(bot)}/messages`, 'POST', {
      text,
      ...(subject !== null ? { subject } : {}),
    });
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not send' };
  }
}

/**
 * A person writing on a work item: the answer to the question they picked
 * (`gateId`), or a message to the role they are looking at. The bridge
 * decides where it goes and refuses a guess between two open questions; see
 * `apps/bridge/src/items.ts`.
 */
export async function sendItemMessage(
  subject: string,
  input: { text: string; gateId?: string | null; role?: string | null; attachments?: string[] },
): Promise<{ ok: boolean; error?: string; answered?: boolean }> {
  try {
    const result = await call<{ answered?: boolean }>(`/v1/items/${encodeURIComponent(subject)}/messages`, 'POST', {
      text: input.text,
      ...(input.gateId ? { gateId: input.gateId } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    });
    revalidatePath('/');
    return { ok: true, answered: result.answered === true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not send' };
  }
}

export async function fileRequest(input: {
  text: string;
  context?: string;
  repo?: string;
  kind?: string;
  /** Ids the upload route answered with, sent with the request. */
  attachments?: string[];
}): Promise<{ ok: boolean; error?: string; bot?: string; subject?: string; queued?: boolean; position?: number | null; paused?: string }> {
  try {
    // 202 when it waits its turn: `queued`, with its place in line, and why
    // when work is paused.
    const result = await call<{ bot: string; subject?: string; queued?: boolean; position?: number | null; paused?: string }>('/v1/requests', 'POST', input);
    revalidatePath('/');
    return {
      ok: true,
      bot: result.bot,
      // The request's own work item, which "Open the conversation" opens.
      ...(result.subject ? { subject: result.subject } : {}),
      queued: result.queued === true,
      position: result.position ?? null,
      ...(result.paused ? { paused: result.paused } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not file the request' };
  }
}

export async function moveCard(repo: string, issue: number, to: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call('/v1/board/move', 'POST', { repo, issue, to, ...(reason ? { reason } : {}) });
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'that move was refused' };
  }
}

export async function killSession(bot: string, session: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/sessions/${encodeURIComponent(bot)}/${encodeURIComponent(session)}/kill`, 'POST');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not kill the session' };
  }
}

export async function restartBot(bot: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/bots/${encodeURIComponent(bot)}/restart`, 'POST');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not restart the container' };
  }
}

/**
 * One task started again on a fresh computer: stopped, which keeps its branch
 * with any commit it had not pushed, then tried again from that branch.
 */
export async function restartTaskFresh(taskId: string): Promise<{ ok: boolean; error?: string }> {
  const stopped = await stopTask(taskId);
  if (!stopped.ok) return { ok: false, error: stopped.error ?? 'it could not be stopped' };
  const again = await retryTask(taskId);
  // Said whatever the refusal: the task is stopped by now, and a stopped
  // task has no card and no Try again to point at.
  return again.ok
    ? { ok: true }
    : { ok: false, error: `it was stopped, with its branch kept, but could not be started again: ${again.error || 'the bridge gave no reason'}` };
}

/**
 * A token for one session's terminal, and the gateway's address as the
 * console runs with it, read at run time (`terminalUrlFrom`): a cloud console
 * is built without it.
 */
export async function requestAttachToken(
  bot: string,
  session: string,
): Promise<{ ok: boolean; token?: string; expiresInSeconds?: number; url?: string; error?: string }> {
  try {
    const result = await call<{ token: string; expiresInSeconds: number }>(
      `/v1/terminal/${encodeURIComponent(bot)}/${encodeURIComponent(session)}/token`,
      'POST',
    );
    const url = terminalUrlFrom(process.env);
    return { ok: true, ...result, ...(url ? { url } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not mint an attach token' };
  }
}

export async function updateRepoSettings(
  repo: string,
  patch: { concurrency?: number; stageModes?: Record<string, string>; color?: string; testingDeploy?: 'automatic' | 'has' | 'none' },
): Promise<{ ok: boolean; error?: string; shipsByMerging?: boolean | null }> {
  try {
    // Automatic's line is this answer. The page's first load is the choice it
    // opened on, so a switch back to Automatic kept the old sentence until reload.
    const saved = await call<{ shipsByMerging?: boolean | null }>(`/v1/repos/${encodeURIComponent(repo)}`, 'PATCH', patch);
    revalidatePath('/settings');
    // A color is what the board draws its cards in.
    if (patch.color) revalidatePath('/');
    return { ok: true, ...(saved.shipsByMerging !== undefined ? { shipsByMerging: saved.shipsByMerging } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not save' };
  }
}

/**
 * A crew member's color, from Settings → Appearance: a name from the palette,
 * or null for its role's tint. The bridge refuses any other name and audits the
 * change. Every page that draws the bot's avatar is read again: the board, its
 * threads, the crew page and settings.
 */
export async function setCrewColor(bot: string, color: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/crew/${encodeURIComponent(bot)}`, 'PATCH', { color });
    revalidatePath('/');
    revalidatePath('/crew');
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not save' };
  }
}

/**
 * How many tasks a seat runs at once, from /crew: 1 to 16, each in a computer
 * of its own, all as the seat's one GitHub account. The bridge refuses any
 * other number and audits the change.
 */
export async function setCrewTasksAtOnce(bot: string, maxTasks: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/crew/${encodeURIComponent(bot)}/tasks-at-once`, 'PATCH', { maxTasks });
    revalidatePath('/crew');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not save' };
  }
}

/**
 * Stops a seat taking new work, from /crew: what it is doing finishes, and
 * nothing new is given to it until it is resumed — while its model changes,
 * say. The reason, if one is given, is what the card says beside "Paused".
 */
export async function pauseSeat(bot: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/crew/${encodeURIComponent(bot)}/pause`, 'POST', reason.trim() ? { reason: reason.trim().slice(0, 300) } : {});
    revalidatePath('/');
    revalidatePath('/crew');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not pause it' };
  }
}

/** Lets a paused seat take new work again. */
export async function resumeSeat(bot: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/crew/${encodeURIComponent(bot)}/resume`, 'POST', {});
    revalidatePath('/');
    revalidatePath('/crew');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not resume it' };
  }
}

/**
 * Which avatar a crew member shows, from /crew or Settings → Appearance: one
 * of the four marks, `initials`, or null for its engine's mark. The bridge
 * refuses any other name and audits the change, and every page that draws the
 * avatar is read again.
 */
export async function setCrewAvatar(bot: string, avatar: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/crew/${encodeURIComponent(bot)}`, 'PATCH', { avatar });
    revalidatePath('/');
    revalidatePath('/crew');
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not save' };
  }
}

/**
 * Adds a seat of a role that can have more than one — settings' "Add a
 * builder" — and answers with the new seat. It has no account until one is
 * chosen on its row.
 */
export async function addSeat(role: string): Promise<{ ok: boolean; error?: string; seat?: string }> {
  try {
    const result = await call<{ bot: { slot: string } }>('/v1/crew/seats', 'POST', { role });
    revalidatePath('/settings');
    return { ok: true, seat: result.bot.slot };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not add the seat' };
  }
}

/**
 * Removes a seat added beside another builder. The bridge refuses one with
 * work still going, or that has spent, and says why; its account stays.
 */
export async function removeSeat(seat: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/crew/seats/${encodeURIComponent(seat)}/remove`, 'POST');
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not remove the seat' };
  }
}

/**
 * Lets the crew into one repository now: settings' "Try again". The bridge
 * leaves each bot that can already work there as it is, and says how it went.
 */
export async function letCrewIn(repo: string): Promise<{ ok: boolean; error?: string; access?: RepoAccess }> {
  try {
    const result = await call<{ access: RepoAccess }>(`/v1/repos/${encodeURIComponent(repo)}/access`, 'POST');
    revalidatePath('/settings');
    return { ok: true, access: result.access };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not let the crew in' };
  }
}

/**
 * What removing a repository from OpenADLC would do, as it is now: the review
 * step's list, read when it opens. Changes nothing.
 */
export async function repositoryRemoval(
  repo: string,
): Promise<{ ok: boolean; error?: string; removal?: RemovalPreview; refused?: boolean }> {
  try {
    const result = await call<{ removal: RemovalPreview }>(`/v1/repos/${encodeURIComponent(repo)}/removal`, 'GET');
    return { ok: true, removal: result.removal };
  } catch (error) {
    // Refused for who is asking: removing it would be refused the same way, so
    // the dialog must not say it can still be removed.
    const refused = error instanceof BridgeRefusal && (error.status === 401 || error.status === 403);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'could not read what removing it would do',
      ...(refused ? { refused: true } : {}),
    };
  }
}

/** A person's correction to a repository's design memory, from Settings. An admin's, audited by the bridge. */
export async function updateDesignMemory(
  repo: string,
  patch: { id: string; title?: string; body?: string; kind?: DesignMemoryEntry['kind']; state?: DesignMemoryEntry['state']; supersedes?: string | null },
): Promise<{ ok: boolean; error?: string; entry?: DesignMemoryEntry }> {
  try {
    const saved = await call<{ entry: DesignMemoryEntry }>(`/v1/repos/${encodeURIComponent(repo)}/design-memory`, 'PATCH', patch);
    return { ok: true, entry: saved.entry };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not save' };
  }
}

/**
 * Undoes a supersede a design made: the entry it replaced is in effect again,
 * and this one is retired. An admin's, audited by the bridge.
 */
export async function revertDesignMemory(
  repo: string,
  id: string,
): Promise<{ ok: boolean; error?: string; restored?: DesignMemoryEntry; retired?: DesignMemoryEntry }> {
  try {
    const done = await call<{ restored: DesignMemoryEntry; retired: DesignMemoryEntry }>(
      `/v1/repos/${encodeURIComponent(repo)}/design-memory/${encodeURIComponent(id)}/revert`,
      'POST',
    );
    return { ok: true, restored: done.restored, retired: done.retired };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not revert it' };
  }
}

/**
 * Takes a repository out of OpenADLC and ends its work there, with what the
 * review step chose. The report says what was done and, in `notDone`, what
 * could not be; running it again finishes that. Nothing else is deleted, and
 * adding the repository again brings it back.
 */
export async function removeRepository(
  repo: string,
  choices?: RemovalChoices,
): Promise<{ ok: boolean; error?: string; report?: RemovalReport }> {
  try {
    const report = await call<RemovalReport>(`/v1/repos/${encodeURIComponent(repo)}/remove`, 'POST', choices);
    // Not revalidated here: an action that revalidates re-renders the page it
    // was called from, and the repository's page has no repository any more,
    // so the report of what could not be done would go with it. The dialog
    // goes back to settings, fresh, when the person is done with it.
    return { ok: true, report };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not remove it' };
  }
}

/**
 * "Hold this PR", from an unsigned post's steps: the bridge labels it
 * `needs-human`, turns auto-merge off and holds `review-gate` pending. The
 * repository is its full name, `owner/name`, which names one repository where
 * a short name might name two.
 */
export async function holdPull(repo: string, number: number): Promise<{ ok: boolean; autoMergeOff?: boolean; error?: string }> {
  try {
    const held = await call<{ autoMergeOff?: boolean }>(`/v1/repos/${encodeURIComponent(repo)}/pulls/${number}/hold`, 'POST', {});
    revalidatePath('/');
    return { ok: true, autoMergeOff: held?.autoMergeOff !== false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not hold it' };
  }
}

/** Counts only what OpenADLC signed from now on: Settings → GitHub → Signed posts, from an unsigned post's steps. */
export async function countOnlySignedPosts(): Promise<{ ok: boolean; error?: string }> {
  try {
    await call('/v1/install', 'PATCH', { attributionMode: 'enforce' });
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not switch it' };
  }
}

/**
 * Pauses new work from Settings: across the install when no repository is
 * named, or in the named ones alone. The bridge refuses their leases, holds
 * their requests in the queue and their Try again until someone resumes.
 * Audited, and shown on the board.
 */
export async function pauseWork(reason: string, repos?: string[]): Promise<{ ok: boolean; error?: string; pauses?: import('@/lib/api').WorkPauses }> {
  try {
    const result = await call<{ paused: import('@/lib/api').WorkPause | null; repos?: Record<string, import('@/lib/api').WorkPause> }>(
      '/v1/work/pause',
      'POST',
      repos ? { reason, repos } : { reason },
    );
    revalidatePath('/');
    revalidatePath('/settings');
    revalidatePath('/settings/repositories/[name]', 'page');
    return { ok: true, pauses: { paused: result.paused ?? null, repos: result.repos ?? {} } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not pause work' };
  }
}

/**
 * Lets new work start again: everywhere, or in the named repositories, which
 * starts what they held. `keepRepos` lifts the install's pause alone, and
 * each repository paused on its own stays paused.
 */
export async function resumeWork(
  repos?: string[],
  options: { keepRepos?: boolean } = {},
): Promise<{ ok: boolean; error?: string; pauses?: import('@/lib/api').WorkPauses }> {
  try {
    const result = await call<{ paused?: import('@/lib/api').WorkPause | null; repos?: Record<string, import('@/lib/api').WorkPause> }>(
      '/v1/work/resume',
      'POST',
      repos ? { repos } : options.keepRepos ? { keepRepos: true } : {},
    );
    revalidatePath('/');
    revalidatePath('/settings');
    revalidatePath('/settings/repositories/[name]', 'page');
    return { ok: true, pauses: { paused: result.paused ?? null, repos: result.repos ?? {} } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not resume work' };
  }
}

type UserChange = { ok: boolean; error?: string; user?: import('@/lib/api').ConsoleUser };

/** Settings → Users: lets a person in, as an admin or a user. Audited by the bridge. */
export async function addUser(email: string, role: import('@/lib/api').Role): Promise<UserChange> {
  try {
    const result = await call<{ user: import('@/lib/api').ConsoleUser }>('/v1/users', 'POST', { email, role });
    revalidatePath('/settings');
    return { ok: true, user: result.user };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not add them' };
  }
}

/** Gives someone another role. The bridge refuses to demote the last admin, and says so. */
export async function setUserRole(email: string, role: import('@/lib/api').Role): Promise<UserChange> {
  try {
    const result = await call<{ user: import('@/lib/api').ConsoleUser }>(`/v1/users/${encodeURIComponent(email)}`, 'PATCH', { role });
    revalidatePath('/settings');
    return { ok: true, user: result.user };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not change their role' };
  }
}

/** Takes someone out of the console. The last admin cannot be. */
export async function removeUser(email: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/users/${encodeURIComponent(email)}/remove`, 'POST');
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not remove them' };
  }
}

/** What a cancel would do to one work item, read before anything is done. */
export interface CancelPreview {
  issue: { number: number; title: string; url: string } | null;
  pr: { number: number; url: string; branch: string | null } | null;
  tasks: { id: string; bot: string; kind: string; state: string }[];
  questions: number;
}

/** What a cancel did, and what it could not. */
export interface CancelOutcome {
  done?: string[];
  notDone?: { step: string; what: string; why: string }[];
}

/** A work item's address on the bridge: `testbed#7`, one path segment. */
const itemPath = (subject: string) => `/v1/items/${encodeURIComponent(subject)}`;

/** One issue held: the step it is on finishes, and nothing new starts on it until it is resumed. */
export async function pauseItem(subject: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`${itemPath(subject)}/pause`, 'POST', reason ? { reason } : {});
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not pause it' };
  }
}

/** The month's cap on GitHub Actions minutes; null for none. An admin's. */
export async function setCiCap(minutes: number | null): Promise<{ ok: boolean; error?: string }> {
  try {
    await call('/v1/costs/ci-cap', 'PUT', { minutes });
    revalidatePath('/costs');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'the cap was not saved' };
  }
}

export async function resumeItem(subject: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`${itemPath(subject)}/resume`, 'POST', {});
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not resume it' };
  }
}

/** One issue to the front of its repository's queue, or back to its place by priority. */
export async function playItemNext(subject: string, on: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`${itemPath(subject)}/next`, 'POST', { on });
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not move it in the queue' };
  }
}

export async function previewCancelItem(subject: string): Promise<{ ok: boolean; preview?: CancelPreview; error?: string }> {
  try {
    return { ok: true, preview: await call<CancelPreview>(`${itemPath(subject)}/cancel`, 'GET') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not read what cancelling would do' };
  }
}

export async function cancelItem(subject: string, reason: string): Promise<{ ok: boolean; outcome?: CancelOutcome; error?: string }> {
  try {
    const outcome = await call<CancelOutcome>(`${itemPath(subject)}/cancel`, 'POST', { reason });
    revalidatePath('/');
    return { ok: true, outcome };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not cancel it' };
  }
}

/**
 * Releases a production promote OpenADLC holds for a person, where GitHub's
 * plan cannot hold a reviewer on the environment: the bridge dispatches it
 * as the app, and records who released it.
 */
export async function releasePromote(repo: string, sha: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/repos/${encodeURIComponent(repo)}/deploys/${encodeURIComponent(sha)}/release`, 'POST');
    revalidatePath('/');
    revalidatePath('/needs-you');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'the promote was not released' };
  }
}

/**
 * Switches a repository to automatic delivery: no person approves production,
 * and each promote soaks on testing first. What was held becomes a soak.
 */
export async function switchToAutomatic(repo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await call(`/v1/repos/${encodeURIComponent(repo)}/delivery/automatic`, 'POST');
    revalidatePath('/');
    revalidatePath('/needs-you');
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'the repository was not switched' };
  }
}

/**
 * A person's decision about open issues OpenADLC will not take on its own
 * (their author has no access): sent to intake, marked to ignore, or closed.
 * Each issue is its own step; what was not done comes back with why.
 */
export async function decideUnowned(
  repo: string,
  decision: 'intake' | 'ignore' | 'close',
  numbers: number[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const answer = await call<{ notDone?: { step: string; why: string }[] }>(
      `/v1/repos/${encodeURIComponent(repo)}/unowned/${decision}`,
      'POST',
      { numbers },
    );
    revalidatePath('/');
    revalidatePath('/needs-you');
    const missed = answer.notDone ?? [];
    return missed.length === 0 ? { ok: true } : { ok: false, error: missed.map((one) => `${one.step}: ${one.why}`).join('; ') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'that did not go through' };
  }
}
