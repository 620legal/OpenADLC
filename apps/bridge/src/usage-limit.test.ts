import { describe, expect, it } from 'vitest';
import { limitLink, usageLimit } from './usage-limit.js';

/** The message every session on the shared Claude account ended with on 2026-11-25. */
export const INCIDENT =
  "engine exited 1: You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your weekly limit resets 11am (UTC)";

const NOW = new Date('2026-11-25T14:00:00.000Z');

describe('usageLimit', () => {
  it('reads the incident: the spend limit first, the weekly reset as the next 11:00 UTC, and the admin link', () => {
    const limit = usageLimit(INCIDENT, 'anthropic', NOW);
    expect(limit).toEqual({
      kind: 'spend',
      words: INCIDENT,
      resetsAt: new Date('2026-11-26T11:00:00.000Z'),
      url: 'https://claude.ai/admin-settings/usage',
    });
  });

  it('keeps a reset later today on today', () => {
    expect(usageLimit(INCIDENT, 'anthropic', new Date('2026-11-25T09:00:00.000Z'))?.resetsAt).toEqual(new Date('2026-11-25T11:00:00.000Z'));
  });

  it('reads Claude’s epoch form', () => {
    const limit = usageLimit('Claude AI usage limit reached|1764158400', 'anthropic', NOW);
    expect(limit?.kind).toBe('session');
    expect(limit?.resetsAt).toEqual(new Date(1764158400 * 1000));
    expect(limit?.url).toBeNull();
  });

  it('reads a weekly limit that names it', () => {
    const limit = usageLimit('Weekly limit reached ∙ resets Nov 27, 5am (America/New_York)', 'anthropic', NOW);
    expect(limit?.kind).toBe('weekly');
    // 05:00 in New York in November is 10:00 UTC.
    expect(limit?.resetsAt).toEqual(new Date('2026-11-27T10:00:00.000Z'));
  });

  it('reads a time with no zone in the zone it is given', () => {
    const limit = usageLimit('5-hour limit reached ∙ resets 3pm', 'anthropic', NOW, { zone: 'Europe/Berlin' });
    expect(limit?.kind).toBe('session');
    // 15:00 in Berlin is 14:00 UTC, which is now: so tomorrow's.
    expect(limit?.resetsAt).toEqual(new Date('2026-11-26T14:00:00.000Z'));
  });

  it('reads a credit balance that ran out', () => {
    expect(usageLimit('Credit balance is too low', 'anthropic', NOW)).toMatchObject({ kind: 'credit', resetsAt: null, url: null });
  });

  it('reads Codex’s usage limit and its try-again-in', () => {
    const limit = usageLimit("You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again in 2 hours 13 minutes.", 'openai', NOW);
    expect(limit?.kind).toBe('session');
    expect(limit?.resetsAt).toEqual(new Date(NOW.getTime() + (2 * 60 + 13) * 60_000));
    expect(limit?.url).toBe('https://chatgpt.com/explore/pro');
  });

  it('reads an OpenAI quota and a try-again-at', () => {
    const limit = usageLimit('You exceeded your current quota (insufficient_quota); try again at 3:04 PM (UTC)', 'openai', NOW);
    expect(limit?.kind).toBe('quota');
    expect(limit?.resetsAt).toEqual(new Date('2026-11-25T15:04:00.000Z'));
  });

  it('reads xAI’s spending limit and its credits', () => {
    expect(usageLimit('Your team has reached its monthly spending limit', 'xai', NOW)).toMatchObject({ kind: 'spend', resetsAt: null });
    expect(usageLimit('You have used all available credits', 'xai', NOW)?.kind).toBe('credit');
  });

  it('reads only the phrases of the account’s own provider', () => {
    expect(usageLimit(INCIDENT, 'xai', NOW)).toBeNull();
  });

  it('is not a per-minute rate limit, a failed build or a sign-in', () => {
    for (const reason of [
      'engine exited 1: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      'engine exited 1: 429 Too Many Requests',
      'vitest exited with code 1',
      'engine exited 1: Invalid API key · Please run /login',
      null,
      '',
    ]) {
      expect(usageLimit(reason, 'anthropic', NOW)).toBeNull();
      expect(usageLimit(reason, 'openai', NOW)).toBeNull();
    }
  });

  it('gives no link to an unknown host, and none at all for no link', () => {
    expect(limitLink("hit your org's monthly spend limit at https://claude.ai.evil.example/usage")).toBeNull();
    expect(limitLink('raise it at https://example.com/x')).toBeNull();
    expect(usageLimit("You've hit your org's monthly spend limit at https://example.com/usage", 'anthropic', NOW)?.url).toBeNull();
    expect(limitLink('nothing here')).toBeNull();
  });

  it('keeps a reset time it cannot read as none', () => {
    expect(usageLimit('Weekly limit reached ∙ resets soon', 'anthropic', NOW)?.resetsAt).toBeNull();
    expect(usageLimit('Weekly limit reached ∙ resets 11am (Not/AZone)', 'anthropic', NOW)?.resetsAt).toBeNull();
  });

  it('carries the words on one line, redacted and bounded', () => {
    const limit = usageLimit(`You've hit your org's monthly spend limit\n\n${'x'.repeat(400)} sk-ant-api03-${'a'.repeat(60)}`, 'anthropic', NOW);
    expect(limit?.words).not.toMatch(/\n/);
    expect(limit?.words.length).toBeLessThanOrEqual(300);
    const short = usageLimit(`You've hit your org's monthly spend limit sk-ant-api03-${'a'.repeat(60)}`, 'anthropic', NOW);
    expect(short?.words).not.toContain('a'.repeat(60));
  });
});
