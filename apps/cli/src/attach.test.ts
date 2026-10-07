import { describe, expect, it } from 'vitest';
import { answerOf, attachFailure } from './attach.js';

describe('what fleetadlc attach says when it cannot attach', () => {
  // It said `fetch failed`, `bridge returned 401` or `the attach token was
  // refused`, and nothing about what to do.
  it('says the stack is down when nothing answers', () => {
    expect(attachFailure('bridge', 'unreachable', 47311)).toEqual({
      reason: 'the bridge is not answering on port 47311',
      hint: 'start the stack: fleetadlc up',
    });
    expect(attachFailure('hostd', 'unreachable', 47312).reason).toBe('hostd is not answering on port 47312');
  });

  it('gives the bridge’s words, and that taking over is an admin’s, for a refusal', () => {
    const said = attachFailure('bridge', { status: 401, error: 'sign in first' }, 47311);
    expect(said.reason).toBe('the bridge refused to mint an attach token (401: sign in first)');
    expect(said.hint).toContain('admin');
  });

  it('says a refused token ran out, so trying again is the remedy', () => {
    const said = attachFailure('hostd', { status: 401, error: 'attach token is expired or unknown' }, 47312);
    expect(said.reason).toBe('hostd refused the attach token: attach token is expired or unknown');
    expect(said.hint).toContain('run fleetadlc attach again');
  });

  it('reads the error a JSON refusal carries, and does without one', async () => {
    expect(await answerOf(Response.json({ error: 'nope' }, { status: 403 }))).toEqual({ status: 403, error: 'nope' });
    expect(await answerOf(new Response('not json', { status: 500 }))).toEqual({ status: 500 });
  });
});
