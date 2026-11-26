import { redactSecrets, type ModelAccount } from '@openadlc/shared';

/**
 * Whether an engine's last words say its model account is at a usage or spend
 * limit, and what that limit is.
 *
 * On 2026-11-25 a shared Claude account answered every session with "You've
 * hit your org's monthly spend limit … your weekly limit resets 11am (UTC)".
 * The engine exited 1 before anything read the message, so every task on the
 * account failed, three leases parked nine issues `needs-triage`, and nothing
 * started again when the limit lifted. A limit is the account's state, not the
 * task's failure: the task ends `held` and the account's health row
 * (`model-limit:<accountId>`) holds its seats back until a check of the
 * account passes (docs/adr/0096-a-model-accounts-usage-limit-is-a-health-row-and-its-tasks-end-held.md).
 *
 * Only explicit account-limit phrases match. A bare 429 or `rate_limit_error`
 * is a per-minute rate limit, gone in seconds, and holding every seat on the
 * account for it would stop the crew for nothing.
 */

export type UsageLimitKind = 'spend' | 'weekly' | 'session' | 'credit' | 'quota';

export interface UsageLimit {
  /** The first limit the message names; one message can name two, as the incident's did. */
  kind: UsageLimitKind;
  /** The message, redacted, on one line, at most `WORDS_MAX` characters. */
  words: string;
  /** When the message says the limit resets, or null when it gives no time it could be read from. */
  resetsAt: Date | null;
  /** Where the limit is raised, as the message linked it, only on a provider's own host. */
  url: string | null;
}

const WORDS_MAX = 300;

/**
 * What a held task's exit reason starts with: the bridge's own words, so the
 * recovery can name the row it waits on exactly (`causeOfFailure`), as it does
 * for "was not started:".
 */
export const HELD_ON = 'held on model account';

/** A held task's exit reason: `held on model account <id>: <words>`. */
export function heldReason(accountId: string, words: string): string {
  return `${HELD_ON} ${accountId}: ${words}`;
}

/** The model account a held task's reason names, or null when it is not one. */
export function heldAccountOf(reason: string | null | undefined): string | null {
  return new RegExp(`^${HELD_ON} (\\S+?):`).exec(reason ?? '')?.[1] ?? null;
}

/**
 * The hosts a link from engine output is shown for. The message is the
 * engine's output, which a session's prompt can steer, so a link to anywhere
 * else is never put on a card a person is asked to press.
 */
export const LIMIT_LINK_HOSTS: readonly string[] = ['claude.ai', 'console.anthropic.com', 'platform.openai.com', 'chatgpt.com', 'console.x.ai'];

interface Phrase {
  pattern: RegExp;
  /** The kind, or a function of the match for a phrase that names it. */
  kind: UsageLimitKind | ((match: RegExpExecArray) => UsageLimitKind);
}

const APOSTROPHE = `['’]`;

const PHRASES: Record<ModelAccount['provider'], readonly Phrase[]> = {
  anthropic: [
    { pattern: new RegExp(`hit your (?:org${APOSTROPHE}s )?(?:monthly )?spend(?:ing)? limit`, 'i'), kind: 'spend' },
    {
      pattern: /\b(weekly|5-hour|daily|usage|session) limit (?:reached|resets)/i,
      kind: (match) => (match[1]?.toLowerCase() === 'weekly' ? 'weekly' : 'session'),
    },
    { pattern: /Claude AI usage limit reached/i, kind: 'session' },
    { pattern: new RegExp(`you${APOSTROPHE}ve hit your (weekly |session |usage )?limit`, 'i'), kind: (match) => (match[1]?.trim().toLowerCase() === 'weekly' ? 'weekly' : 'session') },
    { pattern: /credit balance is too low/i, kind: 'credit' },
  ],
  openai: [
    { pattern: new RegExp(`you${APOSTROPHE}ve hit your usage limit`, 'i'), kind: 'session' },
    { pattern: /exceeded your current quota|insufficient_quota/i, kind: 'quota' },
  ],
  xai: [
    { pattern: /used all available credits/i, kind: 'credit' },
    { pattern: /reached its (?:monthly )?spending limit/i, kind: 'spend' },
  ],
};

/**
 * The limit a task's end reason names, read with the phrases of the account's
 * provider, or null when it names none. `zone` is where a reset time with no
 * zone of its own is read; the host's, unless a test says otherwise.
 */
export function usageLimit(
  reason: string | null | undefined,
  provider: ModelAccount['provider'],
  now: Date,
  options: { zone?: string } = {},
): UsageLimit | null {
  const text = reason ?? '';
  if (!text) return null;
  let first: { at: number; kind: UsageLimitKind } | null = null;
  for (const phrase of PHRASES[provider] ?? []) {
    const match = phrase.pattern.exec(text);
    if (!match) continue;
    const kind = typeof phrase.kind === 'function' ? phrase.kind(match) : phrase.kind;
    if (!first || match.index < first.at) first = { at: match.index, kind };
  }
  if (!first) return null;
  return {
    kind: first.kind,
    words: wordsOf(text),
    resetsAt: resetTime(text, now, options.zone ?? hostZone()),
    url: limitLink(text),
  };
}

/** The message as a card and a reason may carry it: no secret, one line, bounded. */
export function wordsOf(text: string): string {
  const folded = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return folded.length > WORDS_MAX ? `${folded.slice(0, WORDS_MAX - 1)}…` : folded;
}

/** The first `https://` link in the message, when its host is one of `LIMIT_LINK_HOSTS`. */
export function limitLink(text: string): string | null {
  const found = /https:\/\/[^\s<>"'`)]+/i.exec(text)?.[0];
  if (!found) return null;
  const trimmed = found.replace(/[.,;:!?·]+$/, '');
  try {
    const url = new URL(trimmed);
    return LIMIT_LINK_HOSTS.includes(url.hostname.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/**
 * When the message says the limit resets. The forms seen from the three
 * providers' CLIs: `resets 11am (UTC)`, `resets Nov 27, 5am (America/New_York)`,
 * `|<epoch>`, `try again in 2 hours 13 minutes`, `try again at 3:04 PM`. A time
 * with no date is its next occurrence after `now`. Anything else is null: a
 * hold with no reset time is cleared by the account's check alone.
 */
export function resetTime(text: string, now: Date, zone: string): Date | null {
  const epoch = /\|(\d{10}|\d{13})\b/.exec(text)?.[1];
  if (epoch) {
    const value = Number(epoch);
    return new Date(epoch.length === 10 ? value * 1000 : value);
  }

  const within = /try again in ((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])\b[\s,]*(?:and\s+)?)+)/i.exec(text)?.[1];
  if (within) {
    let total = 0;
    for (const part of within.matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const unit = (part[2] ?? '').toLowerCase();
      const ms = unit.startsWith('d') ? UNIT_MS.d : unit.startsWith('h') ? UNIT_MS.h : unit.startsWith('m') ? UNIT_MS.m : UNIT_MS.s;
      total += Number(part[1]) * (ms ?? 0);
    }
    return total > 0 ? new Date(now.getTime() + total) : null;
  }

  const resets =
    /resets?\s+(?:on\s+|at\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?(m)?\.?(?=[\s(),.;·]|$)\s*(?:\(([^)]+)\))?/i.exec(
      text,
    );
  if (resets) {
    const [, month, day, hour, minute, half, , named] = resets;
    const at = wallClock({ month, day, hour, minute, half, zone: named?.trim() || zone }, now);
    if (at) return at;
  }

  const at = /try again at (\d{1,2})(?::(\d{2}))?\s*([ap])?\.?(?:m\.?)?(?=[\s(),.;·]|$)\s*(?:\(([^)]+)\))?/i.exec(text);
  if (at) {
    const [, hour, minute, half, named] = at;
    return wallClock({ hour, minute, half, zone: named?.trim() || zone }, now);
  }
  return null;
}

/**
 * The instant a wall-clock time names in a zone: on the date given, or the
 * next time it occurs after `now`. Null for a zone `Intl` does not know, or a
 * time that is not one ("resets 27" has neither minutes nor am/pm).
 */
function wallClock(
  input: { month?: string; day?: string; hour?: string; minute?: string; half?: string; zone: string },
  now: Date,
): Date | null {
  if (input.minute === undefined && input.half === undefined) return null;
  let hour = Number(input.hour);
  const minute = input.minute === undefined ? 0 : Number(input.minute);
  if (input.half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (input.half.toLowerCase() === 'p' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const zone = input.zone.toUpperCase() === 'UTC' || input.zone.toUpperCase() === 'GMT' ? 'UTC' : input.zone;
  const today = partsIn(now, zone);
  if (!today) return null;

  if (input.month && input.day) {
    const month = MONTHS.indexOf(input.month.slice(0, 3).toLowerCase());
    const day = Number(input.day);
    if (month < 0 || day < 1 || day > 31) return null;
    let at = instantOf(today.year, month, day, hour, minute, zone);
    // A date with no year that has passed by more than a day is next year's.
    if (at.getTime() < now.getTime() - UNIT_MS.d!) at = instantOf(today.year + 1, month, day, hour, minute, zone);
    return at;
  }

  const at = instantOf(today.year, today.month, today.day, hour, minute, zone);
  return at.getTime() > now.getTime() ? at : instantOf(today.year, today.month, today.day + 1, hour, minute, zone);
}

/** The calendar date and time an instant reads as in a zone, or null for a zone `Intl` does not know. */
function partsIn(instant: Date, zone: string): { year: number; month: number; day: number; hour: number; minute: number } | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return null;
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The instant a wall-clock time is in a zone; `day` may run past the month, as `Date.UTC` allows. */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const guess = Date.UTC(year, month, day, hour, minute);
  const offset = (at: number): number => {
    const parts = partsIn(new Date(at), zone);
    return parts ? Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute) - Math.floor(at / 60_000) * 60_000 : 0;
  };
  const first = guess - offset(guess);
  const second = guess - offset(first);
  return new Date(second);
}
