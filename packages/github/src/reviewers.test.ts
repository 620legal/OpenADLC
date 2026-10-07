import { describe, expect, it } from 'vitest';
import { GitHubApiError } from './client.js';
import { ReviewerStandings, accountExists, accountOf, reviewRequestRefusal, reviewerStandingOf, type ReviewerStanding } from './reviewers.js';

/**
 * A GitHub that answers each path with a status: 200 or 204 is yes, anything
 * else throws as the client does. An object is a 200 with that body.
 */
function github(answers: Record<string, number | object>) {
  const asked: string[] = [];
  return {
    asked,
    async request<T>(_method: string, path: string): Promise<T> {
      asked.push(path);
      const answer = answers[path] ?? 500;
      if (typeof answer === 'object') return answer as T;
      if (answer >= 400) throw new GitHubApiError(answer, path, JSON.stringify({ message: 'nope' }));
      return {} as T;
    },
  };
}

describe('the account behind a login', () => {
  it('gives its numeric id with its type, which an environment reviewer is named by', async () => {
    expect(await accountOf(github({ '/users/janedoe': { login: 'janedoe', id: 1001, type: 'User' } }), 'janedoe')).toEqual({
      type: 'User',
      id: 1001,
    });
  });

  it('gives no id where GitHub gave none, or one that is not a number', async () => {
    expect(await accountOf(github({ '/users/janedoe': 200 }), 'janedoe')).toEqual({ type: 'User' });
    expect(await accountOf(github({ '/users/janedoe': { login: 'janedoe', id: '1001', type: 'User' } }), 'janedoe')).toEqual({
      type: 'User',
    });
  });

  it('still tells no account from no answer', async () => {
    expect(await accountOf(github({ '/users/janedoe': 404 }), 'janedoe')).toBe(false);
    expect(await accountOf(github({ '/users/janedoe': 502 }), 'janedoe')).toBeNull();
    expect(await accountExists(github({ '/users/janedoe': { login: 'janedoe', id: 1001, type: 'User' } }), 'janedoe')).toBe(true);
  });
});

describe('whether a named reviewer can review', () => {
  it('says there is no such account when GitHub has no user by that login', async () => {
    const api = github({ '/users/janedoe-reviewer': 404 });
    expect(await reviewerStandingOf(api, 'exampleco/api', 'janedoe-reviewer')).toEqual({
      state: 'no-account',
      reason: 'there is no such GitHub account',
    });
    // Not asked whether a login nobody holds is a collaborator.
    expect(api.asked).toEqual(['/users/janedoe-reviewer']);
  });

  it('says an account that exists but is not a collaborator cannot review', async () => {
    const api = github({ '/users/janedoe': 200, '/repos/exampleco/api/collaborators/janedoe/permission': 404 });
    expect(await reviewerStandingOf(api, 'exampleco/api', 'janedoe')).toEqual({
      state: 'cannot-review',
      reason: 'janedoe is not a collaborator on exampleco/api',
    });
  });

  // `@owner`, the template's placeholder, is an organization on GitHub: it was
  // called "not a collaborator", and the card offered to invite it.
  it('says an organization is not a person, and never asks whether it is a collaborator', async () => {
    const api = github({ '/users/owner': { login: 'owner', type: 'Organization' } });
    expect(await reviewerStandingOf(api, 'exampleco/api', 'owner')).toEqual({
      state: 'not-a-person',
      reason: 'owner is an organization, not a person',
    });
    expect(api.asked).toEqual(['/users/owner']);
  });

  it('says a collaborator with write or more can review, however they reach the repository', async () => {
    // An organization's owner reaches it through the organization: the old
    // `/collaborators/<login>` answered 404 for them as the app.
    for (const permission of ['admin', 'write']) {
      const api = github({
        '/users/janedoe': { login: 'janedoe', type: 'User' },
        '/repos/exampleco/api/collaborators/janedoe/permission': { permission, role_name: permission },
      });
      expect(await reviewerStandingOf(api, 'exampleco/api', 'janedoe')).toEqual({ state: 'can-review' });
    }
  });

  it('says triage or read cannot approve, and why', async () => {
    const api = github({
      '/users/janedoe': { login: 'janedoe', type: 'User' },
      '/repos/exampleco/api/collaborators/janedoe/permission': { permission: 'read', role_name: 'triage' },
    });
    expect(await reviewerStandingOf(api, 'exampleco/api', 'janedoe')).toEqual({
      state: 'cannot-review',
      reason: 'janedoe has triage on exampleco/api, and an approval counts only from write or more',
    });
  });

  it('calls nobody missing when GitHub cannot be asked', async () => {
    expect((await reviewerStandingOf(github({ '/users/janedoe': 403 }), 'exampleco/api', 'janedoe')).state).toBe('unknown');
    expect(
      (await reviewerStandingOf(github({ '/users/janedoe': 200, '/repos/exampleco/api/collaborators/janedoe/permission': 502 }), 'exampleco/api', 'janedoe'))
        .state,
    ).toBe('unknown');
  });
});

describe('a refused review request', () => {
  const refused = (body: unknown) => new GitHubApiError(422, '/repos/exampleco/api/pulls/4/requested_reviewers', JSON.stringify(body));

  it('names the login GitHub could not resolve, in GitHub’s words', () => {
    expect(reviewRequestRefusal(refused({ message: "Could not resolve user with login 'janedoe-reviewer'" }))).toEqual({
      login: 'janedoe-reviewer',
      standing: { state: 'no-account', reason: 'there is no such GitHub account' },
      words: "Could not resolve user with login 'janedoe-reviewer'",
    });
  });

  it('reads "not a collaborator" as cannot review, naming nobody since GitHub does not', () => {
    const refusal = reviewRequestRefusal(
      refused({
        message:
          'Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of the exampleco/api repository.',
      }),
    );
    expect(refusal?.login).toBeNull();
    expect(refusal?.standing.state).toBe('cannot-review');
  });

  it('is not about the reviewer when GitHub refused for another reason', () => {
    expect(reviewRequestRefusal(refused({ message: 'Review cannot be requested from pull request author.' }))).toBeNull();
    expect(reviewRequestRefusal(new GitHubApiError(403, '/x', '{"message":"Resource not accessible by integration"}'))).toBeNull();
    expect(reviewRequestRefusal(new Error('socket hang up'))).toBeNull();
  });
});

describe('the kept answers', () => {
  const missing: ReviewerStanding = { state: 'no-account', reason: 'there is no such GitHub account' };

  it('asks GitHub once and keeps the answer until it is old', async () => {
    let now = 0;
    const standings = new ReviewerStandings({ maxAgeMs: 1_000, now: () => now });
    let asked = 0;
    const ask = async () => {
      asked += 1;
      return missing;
    };
    await standings.of('exampleco/api', 'janedoe-reviewer', ask);
    await standings.of('ExampleCo/API', 'JaneDoe-Reviewer', ask);
    expect(asked).toBe(1);
    now = 2_000;
    expect(standings.known('exampleco/api', 'janedoe-reviewer')).toBeNull();
    await standings.of('exampleco/api', 'janedoe-reviewer', ask);
    expect(asked).toBe(2);
  });

  it('asks again when told to, so a fix is seen at the next check', async () => {
    const standings = new ReviewerStandings();
    await standings.of('exampleco/api', 'janedoe', async () => missing);
    expect(await standings.of('exampleco/api', 'janedoe', async () => ({ state: 'can-review' }), { fresh: true })).toEqual({ state: 'can-review' });
    expect(standings.known('exampleco/api', 'janedoe')).toEqual({ state: 'can-review' });
  });

  it('never keeps an unknown, and an outage does not erase what was known', async () => {
    const standings = new ReviewerStandings();
    standings.record('exampleco/api', 'janedoe', missing);
    const answer = await standings.of('exampleco/api', 'janedoe', async () => ({ state: 'unknown', reason: 'rate limited' }), { fresh: true });
    expect(answer.state).toBe('unknown');
    expect(standings.known('exampleco/api', 'janedoe')).toEqual(missing);
    expect(standings.known('exampleco/api', 'someone-else')).toBeNull();
    await standings.of('exampleco/api', 'someone-else', async () => {
      throw new Error('socket hang up');
    });
    expect(standings.known('exampleco/api', 'someone-else')).toBeNull();
  });

  it('does not ask again for a few minutes after GitHub gave no answer, and never takes that as one', async () => {
    let now = 0;
    const standings = new ReviewerStandings({ retryMs: 1_000, now: () => now });
    let asked = 0;
    const ask = async (): Promise<ReviewerStanding> => {
      asked += 1;
      return { state: 'unknown', reason: 'rate limited' };
    };
    expect((await standings.of('exampleco/api', 'janedoe', ask)).state).toBe('unknown');
    expect((await standings.of('exampleco/api', 'janedoe', ask)).state).toBe('unknown');
    expect(asked).toBe(1);
    expect(standings.known('exampleco/api', 'janedoe')).toBeNull();
    // The configuration check asks regardless.
    await standings.of('exampleco/api', 'janedoe', ask, { fresh: true });
    expect(asked).toBe(2);
    now = 5_000;
    expect(await standings.of('exampleco/api', 'janedoe', async () => ({ state: 'can-review' }))).toEqual({ state: 'can-review' });
  });

  it('forgets a login in every repository, or everything', async () => {
    const standings = new ReviewerStandings();
    standings.record('exampleco/api', 'fleetadlc-builder-janedoe', missing);
    standings.record('exampleco/web', 'FleetADLC-Builder-JaneDoe', missing);
    standings.record('exampleco/api', 'janedoe', missing);
    standings.forget('FLEETADLC-BUILDER-JANEDOE');
    expect(standings.known('exampleco/api', 'fleetadlc-builder-janedoe')).toBeNull();
    expect(standings.known('exampleco/web', 'fleetadlc-builder-janedoe')).toBeNull();
    expect(standings.known('exampleco/api', 'janedoe')).toEqual(missing);
    standings.clear();
    expect(standings.known('exampleco/api', 'janedoe')).toBeNull();
  });
});
