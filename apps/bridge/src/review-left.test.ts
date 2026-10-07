import { describe, expect, it } from 'vitest';
import { missingReview, NO_REVIEW, NOT_POSTED, type PostedReview, type ReviewLeftInput } from './review-left.js';

/**
 * A review task is done when its review is on the pull request. The lead
 * reviewer's Codex session could not run a command in its container, said so,
 * and stopped; its task read "done", and the pull request waited on it.
 */

const STARTED = '2026-09-25T07:31:12.000Z';
const BLOCKED =
  'I’m blocked from running any repo commands in this environment because the shell sandbox cannot start (`bwrap` fails). Without shell access, I can’t run the review.';

function input(reviews: PostedReview[] | Error, overrides: Partial<ReviewLeftInput> = {}): ReviewLeftInput {
  return {
    task: { kind: 'review', subjectRef: 'fleetadlc-testbed#2', startedAt: STARTED },
    login: 'noraexampleco',
    reviews: async () => {
      if (reviews instanceof Error) throw reviews;
      return reviews;
    },
    lastSaid: async () => BLOCKED,
    ...overrides,
  };
}

describe('a finished review task', () => {
  it('failed when its bot left no review, and says what the bot last said', async () => {
    expect(await missingReview(input([]))).toBe(`${NO_REVIEW}. It said: “${BLOCKED}”`);
  });

  it('is done when its bot reviewed while it ran, whatever case GitHub gives the login in', async () => {
    expect(await missingReview(input([{ user: 'Noraexampleco', submittedAt: '2026-09-25T07:40:00Z' }]))).toBeNull();
  });

  it('is done when an advisory seat left its review as a comment, which is the only review it may post', async () => {
    const comment = {
      user: 'irisexampleco',
      state: 'COMMENTED',
      body: 'Findings.\n\n<!-- fleetadlc:{"event":"review_posted","verdict":"request_changes","lens":"second"} -->',
      submittedAt: '2026-09-25T07:40:00Z',
    };
    expect(await missingReview(input([comment], { login: 'irisexampleco', seat: 'irisexampleco' }))).toBeNull();
  });

  it('does not count a review from an earlier round, or another reviewer’s', async () => {
    const reviews = [
      { user: 'noraexampleco', submittedAt: '2026-09-24T10:00:00Z' },
      { user: 'irisexampleco', submittedAt: '2026-09-25T07:45:00Z' },
      { user: 'noraexampleco', submittedAt: null },
    ];
    expect(await missingReview(input(reviews))).toMatch(new RegExp(`^${NO_REVIEW}`));
  });

  it('names a review the bot wrote in its answer and never posted, quoting it without its marker', async () => {
    // A Codex reviewer ran the checks, wrote "Verdict: approve" with the marker
    // saying it had posted it, and stopped. GitHub had no review from it.
    const written = '**Verdict: approve**\n\nNo blocking findings.\n<!-- fleetadlc:{"event":"review_posted"} -->';
    const reason = await missingReview(input([], { lastSaid: async () => written }));
    expect(reason).toBe(`${NOT_POSTED}. It said: “**Verdict: approve**\n\nNo blocking findings.”`);
  });

  it('is done when its review quotes another seat’s tag', async () => {
    // Found live: the lead reviewer's task posted its review at 00:11:30 and ended
    // at 00:11:41, and was failed as having posted nothing: a finding quoted
    // `<!-- fleetadlc-seat:intake -->`, which was read as the review's own tag, so
    // on the account the reviewers share it looked like the intake seat's.
    const body =
      '**OpenADLC_exampleco · lead review agent**<!-- fleetadlc-header -->\n\n' +
      '- `withSeat` keeps the existing `<!-- fleetadlc-seat:intake -->` tag, because a seat tag is already there.\n\n' +
      '<!-- fleetadlc:{"event":"review_posted"} -->\n\n' +
      '<!-- fleetadlc-sig:v1.26aae12a.eyJzZWF0IjoibGVhZC1yZXZpZXdlciJ9.mac -->';
    const lead = { task: { kind: 'review' as const, subjectRef: 'fleetadlc#80', startedAt: '2026-09-29T00:04:02.000Z' }, seat: 'lead-reviewer' };

    expect(await missingReview(input([{ user: 'noraexampleco', body, submittedAt: '2026-09-29T00:11:30Z' }], lead))).toBeNull();
    // Posted as it is now, with its own tag after the one it quotes.
    const tagged = body.replace('\n\n<!-- fleetadlc-sig', '\n\n<!-- fleetadlc-seat:lead-reviewer -->\n\n<!-- fleetadlc-sig');
    expect(await missingReview(input([{ user: 'noraexampleco', body: tagged, submittedAt: '2026-09-29T00:11:30Z' }], lead))).toBeNull();
    // The second reviewer's review, on the same account, is still not the lead's.
    const second = `${body.split('\n\n<!-- fleetadlc-sig')[0]}\n\n<!-- fleetadlc-seat:second-reviewer -->`;
    expect(await missingReview(input([{ user: 'noraexampleco', body: second, submittedAt: '2026-09-29T00:11:59Z' }], lead))).toMatch(
      new RegExp(`^${NO_REVIEW}`),
    );
  });

  it('says so plainly when the bot said nothing', async () => {
    expect(await missingReview(input([], { lastSaid: async () => null }))).toBe(NO_REVIEW);
  });

  it('keeps a long last word to a length a reason can carry', async () => {
    const reason = await missingReview(input([], { lastSaid: async () => 'x'.repeat(5_000) }));
    expect(reason?.length).toBeLessThan(700);
    expect(reason).toMatch(/…”$/);
  });

  it('is never failed on a guess: not when GitHub cannot be asked, nor for a bot with no account', async () => {
    expect(await missingReview(input(new Error('GitHub answered 502')))).toBeNull();
    expect(await missingReview(input([], { login: null }))).toBeNull();
  });

  it('asks only about review tasks on a pull request', async () => {
    expect(await missingReview(input([], { task: { kind: 'implement', subjectRef: 'fleetadlc-testbed#2', startedAt: STARTED } }))).toBeNull();
    expect(await missingReview(input([], { task: { kind: 'review', subjectRef: 'request:a4b02784', startedAt: STARTED } }))).toBeNull();
  });
});
