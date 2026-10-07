import { issues, settings, withAdvisoryLock } from '@fleetadlc/db';
import { hasPausedLabel } from '@fleetadlc/shared';
import { issueForSubject, parseRef } from './work.js';

/**
 * One piece of work a person held from the board: the step running finishes,
 * and nothing new starts on it — no task, no review, no merge — until it is
 * resumed.
 *
 * What holds it is the `fleetadlc:paused` label, on the issue and on its pull
 * request, so the hold is on GitHub where a person sees it and survives the
 * install. Who held it and why are kept beside it (`heldItems`), keyed by the
 * issue's subject, for the card to say.
 */
export interface ItemHold {
  by: string;
  at: string;
  why: string | null;
}

/** Every hold recorded, by issue subject (`repo#n`). Unreadable is none. */
export async function readHolds(): Promise<Record<string, ItemHold>> {
  try {
    const raw = await settings.getSetting('heldItems');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ItemHold>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Records who held a subject, or forgets it. One key, in one statement: read,
 * changed and written whole, two pauses at once (two admins, two tabs) each
 * wrote the map they had read, and the second lost the first one's record.
 */
export async function recordHold(subject: string, hold: ItemHold | null, by: string): Promise<void> {
  if (hold) await settings.mergeSettingJson('heldItems', { [subject]: hold }, by);
  else await forgetHold(subject, by);
}

/**
 * Forgets who held a subject once the hold is over some other way: the label
 * taken off on GitHub, the item cancelled or its issue closed. Left behind, the
 * record named the old person and reason for a later hold somebody else put on.
 */
export async function forgetHold(subject: string, by = 'bridge'): Promise<void> {
  await settings.removeSettingJsonKey('heldItems', subject, by);
}

/**
 * Whether new work may not start on a subject — the issue, or the issue whose
 * pull request it is — because a person holds it, and the words that say so.
 * Null when it is not held, or when nothing about it can be read: a read that
 * fails holds nothing, as a pause that cannot be read never did.
 */
export async function heldWords(subjectRef: string): Promise<string | null> {
  const parsed = parseRef(subjectRef);
  if (!parsed) return null;
  const inRepo = await (async () => issues.listIssues(parsed.repo))().catch(() => []);
  const issue = issueForSubject(subjectRef, inRepo);
  if (!issue || !hasPausedLabel(issue.labels)) return null;
  const key = `${issue.repoName}#${issue.number}`;
  const hold = (await readHolds())[key];
  return `${key} is held${hold ? ` by ${hold.by}${hold.why ? `: ${hold.why}` : ''}` : ' (fleetadlc:paused)'}; resume it on its card`;
}
