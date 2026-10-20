import { describe, expect, it } from 'vitest';
import { actsFor } from './access.js';
import { isFleetLogin, postedBySeat, seatsAskingForChanges, seatsThatPosted, whoWrote } from './authorship.js';

const alone = [
  { name: 'builder-bot', slot: 'builder', githubLogin: 'Builder-Bot' },
  { name: 'reviewer-bot', slot: 'lead-reviewer', githubLogin: 'reviewer-bot' },
];
// Three seats on one account, as a crew on a single account has them.
const shared = [
  { name: 'intake', slot: 'intake', githubLogin: 'openadlc-example' },
  { name: 'builder', slot: 'builder', githubLogin: 'openadlc-example' },
  { name: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: 'openadlc-example' },
];

describe('who wrote it', () => {
  it('is a person when the login is none of the crew’s', () => {
    expect(whoWrote('ada', alone)).toEqual({ kind: 'person', login: 'ada' });
    expect(whoWrote(null, alone)).toEqual({ kind: 'person', login: null });
  });

  it('is the one seat on an account of its own, by login, whatever the casing', () => {
    expect(whoWrote('builder-bot', alone)).toMatchObject({ kind: 'openadlc', bot: { slot: 'builder' }, shared: false });
  });

  it('on a shared account is the seat its marker names, not whichever seat sorts first', () => {
    expect(whoWrote('openadlc-example', shared, { bot: 'lead-reviewer' })).toMatchObject({
      kind: 'openadlc',
      bot: { slot: 'lead-reviewer' },
      shared: true,
    });
  });

  it('on a shared account with no marker is OpenADLC, but no seat in particular', () => {
    expect(whoWrote('openadlc-example', shared)).toMatchObject({ kind: 'openadlc', bot: null, shared: true });
  });
});

describe('whether a login is OpenADLC’s', () => {
  it('counts every seat’s account, shared or not', () => {
    expect(isFleetLogin(shared, 'OPENADLC-EXAMPLE')).toBe(true);
    expect(isFleetLogin(alone, 'someone')).toBe(false);
  });

  it('still lets the crew act, through actsFor, with no repository association', () => {
    expect(actsFor({ login: 'openadlc-example', association: 'NONE' }, shared)).toBe(true);
    expect(actsFor({ login: 'stranger', association: 'NONE' }, shared)).toBe(false);
  });
});

describe('which reviewers posted, on a reviewer account the three share', () => {
  const crew = [
    { name: 'builder', githubLogin: 'openadlc-crew' },
    { name: 'lead-reviewer', githubLogin: 'openadlc-review' },
    { name: 'second-reviewer', githubLogin: 'openadlc-review' },
    { name: 'security-reviewer', githubLogin: 'openadlc-review' },
  ];
  const reviewers = ['lead-reviewer', 'second-reviewer', 'security-reviewer'];

  it('counts one review for the seat it names, not for all three', () => {
    const posts = [{ user: 'openadlc-review', body: 'Fine.\n\n<!-- openadlc-seat:lead-reviewer -->' }];
    expect(seatsThatPosted(posts, crew, reviewers)).toEqual(['lead-reviewer']);
  });

  it('counts nobody for a review on the shared account that names no seat', () => {
    expect(seatsThatPosted([{ user: 'openadlc-review', body: 'Fine.' }], crew, reviewers)).toEqual([]);
  });

  it('knows a seat by its account alone when it has an account of its own', () => {
    const own = [...crew.slice(0, 1), { name: 'lead-reviewer', githubLogin: 'openadlc-lead' }];
    expect(seatsThatPosted([{ user: 'OpenADLC-Lead', body: 'Fine.' }], own, ['lead-reviewer'])).toEqual(['lead-reviewer']);
  });

  it('tells a seat’s own review from another reviewer’s on the same account', () => {
    const second = { user: 'openadlc-review', body: 'Fine.\n\n<!-- openadlc-seat:second-reviewer -->' };
    expect(postedBySeat(second, 'openadlc-review', 'second-reviewer')).toBe(true);
    expect(postedBySeat(second, 'openadlc-review', 'lead-reviewer')).toBe(false);
    expect(postedBySeat({ user: 'openadlc-review', body: 'Fine.' }, 'openadlc-review', 'lead-reviewer')).toBe(true);
    expect(postedBySeat(second, 'openadlc-crew', 'second-reviewer')).toBe(false);
  });

  it('counts a review for its own seat though it quotes another seat’s tag', () => {
    // Found live: the lead reviewer's review quoted `<!-- openadlc-seat:intake -->`
    // in a finding, and was taken for the intake seat's — its gate waited on
    // it, and its task was failed as having posted nothing.
    const finding = '`withSeat` keeps the existing `<!-- openadlc-seat:intake -->` tag.\n\n<!-- openadlc:{"event":"review_posted"} -->';
    const posted = { user: 'openadlc-review', body: finding };
    expect(postedBySeat(posted, 'openadlc-review', 'lead-reviewer')).toBe(true);
    const tagged = { user: 'openadlc-review', body: `${finding}\n\n<!-- openadlc-seat:lead-reviewer -->` };
    expect(postedBySeat(tagged, 'openadlc-review', 'lead-reviewer')).toBe(true);
    expect(postedBySeat(tagged, 'openadlc-review', 'second-reviewer')).toBe(false);
    expect(seatsThatPosted([tagged], crew, reviewers)).toEqual(['lead-reviewer']);
  });

  it('counts that review, posted with no tag of its own, for the seat its signature names', () => {
    const signature = `<!-- openadlc-sig:v1.26aae12a.${Buffer.from(JSON.stringify({ seat: 'lead-reviewer', h: 'x' })).toString('base64url')}.mac -->`;
    const posted = {
      user: 'openadlc-review',
      state: 'CHANGES_REQUESTED',
      body: '`withSeat` keeps the existing `<!-- openadlc-seat:intake -->` tag.\n\n<!-- openadlc:{"event":"review_posted"} -->\n\n' + signature,
    };
    expect(seatsThatPosted([posted], crew, reviewers)).toEqual(['lead-reviewer']);
    expect(seatsAskingForChanges([posted], crew, reviewers)).toEqual(['lead-reviewer']);
    expect(postedBySeat(posted, 'openadlc-review', 'second-reviewer')).toBe(false);
  });
});

describe('which reviewers still ask for changes', () => {
  const crew = [
    { name: 'lead-reviewer', githubLogin: 'openadlc-review' },
    { name: 'second-reviewer', githubLogin: 'openadlc-review' },
  ];
  const tag = (seat: string) => `Body\n\n<!-- openadlc-seat:${seat} -->`;

  it('is each seat whose latest verdict is changes requested', () => {
    const posts = [
      { user: 'openadlc-review', body: tag('lead-reviewer'), state: 'CHANGES_REQUESTED' },
      { user: 'openadlc-review', body: tag('second-reviewer'), state: 'CHANGES_REQUESTED' },
      { user: 'openadlc-review', body: tag('second-reviewer'), state: 'APPROVED' },
      { user: 'openadlc-review', body: tag('lead-reviewer'), state: 'COMMENTED' },
    ];
    expect(seatsAskingForChanges(posts, crew, ['lead-reviewer', 'second-reviewer'])).toEqual(['lead-reviewer']);
  });

  it('lets a dismissed review go', () => {
    const posts = [{ user: 'openadlc-review', body: tag('lead-reviewer'), state: 'DISMISSED' }];
    expect(seatsAskingForChanges(posts, crew, ['lead-reviewer'])).toEqual([]);
  });
});
