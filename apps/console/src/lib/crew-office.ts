import type { CrewMember } from './api';
import { botLabel } from './bot-label';
import { crewState, nowLine, roleTitle, taskItem, type CrewState } from './crew';

/**
 * The crew page's office: a desk per bot, its character posed by `crewState`
 * and nothing else, so the office reads nothing the cards do not.
 *
 * `attention` covers a cap stop, a failed last task and a blocking check alike,
 * and the bridge does not say which, so the office never words it as a cap:
 * calling every stop "stopped at the cap" would be wrong for two of the three.
 */
export type OfficePose = 'rest' | 'busy' | 'hand-up' | 'stopped' | 'empty';

const POSE: Record<CrewState, OfficePose> = {
  idle: 'rest',
  'on-duty': 'rest',
  working: 'busy',
  waiting: 'hand-up',
  attention: 'stopped',
  'not-connected': 'empty',
};

export function officePose(state: CrewState): OfficePose {
  return POSE[state];
}

/** A desk's state in words, for its accessible name. */
export const OFFICE_STATE_WORDS: Record<CrewState, string> = {
  idle: 'idle',
  'on-duty': 'on duty',
  working: 'working',
  waiting: 'waiting for your answer',
  attention: 'needs attention',
  'not-connected': 'not connected',
};

/** The longest a bubble's text runs before it is cut; the full text is in the desk's name. */
export const BUBBLE_MAX = 40;

/**
 * What the desk is about, in full: the task's title while it works or waits,
 * what failed or the blocking checks while it needs attention, and nothing
 * otherwise.
 */
export function deskTask(bot: CrewMember, now: string): string | null {
  const state = crewState(bot);
  if (state === 'working' || state === 'waiting') {
    const issue = bot.task?.issue;
    return issue ? `#${issue.number} ${issue.title}` : nowLine(bot, now);
  }
  if (state === 'attention') {
    if (bot.lastTask?.state === 'failed') return nowLine(bot, now);
    const blocking = (bot.checks ?? []).filter((check) => check.severity === 'blocking').map((check) => check.title);
    return blocking.length > 0 ? blocking.join('; ') : null;
  }
  return null;
}

/** The text cut to `max` characters with an ellipsis, or as it is when it fits. */
export function bubbleText(text: string, max = BUBBLE_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** The name a desk goes by on screen: its handle, or its role before it has one. */
export function deskLabel(bot: CrewMember): string {
  return botLabel(bot).handle ?? roleTitle(bot);
}

/**
 * The desk's accessible name: "atlas, Implement: working — #16 Let the board
 * filter by label". The task is never cut here, so a screen reader hears what
 * the bubble had to shorten.
 */
export function deskName(bot: CrewMember, now: string): string {
  const head = `${deskLabel(bot)}, ${roleTitle(bot)}: ${OFFICE_STATE_WORDS[crewState(bot)]}`;
  const task = deskTask(bot, now);
  return task ? `${head} — ${task}` : head;
}

/**
 * What pressing the desk's character opens: the item a waiting bot asked
 * about, or the item whose task failed, on the bot's role; otherwise the
 * seat's own panel, as the card's "Answer" and "Open thread" do.
 */
export type DeskOpens = { item: string; role: string } | { seat: string };

export function deskOpens(bot: CrewMember): DeskOpens {
  const state = crewState(bot);
  const item =
    state === 'waiting' ? taskItem(bot.task) : state === 'attention' && bot.lastTask?.state === 'failed' ? taskItem(bot.lastTask) : null;
  return item ? { item, role: bot.role } : { seat: bot.name };
}
