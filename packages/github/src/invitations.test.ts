import { describe, expect, it } from 'vitest';
import { GitHubApiError } from './client.js';
import {
  acceptInvitation,
  acceptPendingInvitations,
  accessSuffices,
  inviteCollaborator,
  listInvitations,
  repositoryAccess,
  type InvitationApi,
} from './invitations.js';

/**
 * Driven by a fake. Accepting an invitation puts an account into somebody's real
 * repository and cannot be undone from here, so it is not rehearsed against the
 * live one — the real path is proven once, by hand, and recorded in the PR.
 */
function fake(options: {
  pending?: { id: number; full_name: string; inviter?: string }[];
  failList?: Error;
  failAccept?: Error;
}) {
  const accepted: number[] = [];
  const api: InvitationApi = {
    async request<T>(method: string, path: string): Promise<T> {
      if (method === 'GET') {
        if (options.failList) throw options.failList;
        return (options.pending ?? []).map((entry) => ({
          id: entry.id,
          repository: { full_name: entry.full_name },
          inviter: { login: entry.inviter ?? 'janedoe' },
        })) as T;
      }
      if (method === 'PATCH') {
        if (options.failAccept) throw options.failAccept;
        accepted.push(Number(path.split('/').pop()));
        return {} as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { api, accepted };
}

describe('accepting one invitation by id', () => {
  // The id is the interface that works: a GitHub App token cannot list its own
  // invitations, so nothing can be found by searching.
  it('accepts exactly the id it was given', async () => {
    const { api, accepted } = fake({});
    const outcome = await acceptInvitation(api, 1000001, 'janedoe/FleetADLC');

    expect(outcome).toEqual({ action: 'accepted', repository: 'janedoe/FleetADLC', id: 1000001 });
    expect(accepted).toEqual([1000001]);
  });

  it('names the setting that fixes the refusal an operator will meet', async () => {
    // "Resource not accessible by integration" reads as a limit of app tokens.
    // It is not: GitHub's own x-accepted-github-permissions header says
    // administration=write, and granting it makes the identical call return 204.
    // A message that just said "could not accept" would send somebody hunting.
    const { api } = fake({
      failAccept: new Error('PATCH …: 403: {"message":"Resource not accessible by integration"}'),
    });
    const outcome = await acceptInvitation(api, 1, 'janedoe/FleetADLC');

    expect(outcome.action).toBe('refused');
    expect(outcome).toMatchObject({ detail: expect.stringContaining('Administration: read and write') });
  });
});

describe('sweeping whatever is pending for a repository', () => {
  it('accepts the one for the repository it was asked about', async () => {
    const { api, accepted } = fake({ pending: [{ id: 7, full_name: 'janedoe/FleetADLC' }] });
    const outcome = await acceptPendingInvitations(api, 'janedoe/FleetADLC');

    expect(outcome).toEqual({ action: 'accepted', repository: 'janedoe/FleetADLC', id: 7 });
    expect(accepted).toEqual([7]);
  });

  it('leaves every other invitation alone', async () => {
    // The account may have been invited somewhere unrelated to this install. A
    // platform that accepted everything it found would join those too, silently,
    // with a credential the operator gave it for one job.
    const { api, accepted } = fake({
      pending: [
        { id: 1, full_name: 'someone-else/private-thing', inviter: 'a-stranger' },
        { id: 2, full_name: 'janedoe/FleetADLC' },
        { id: 3, full_name: 'another/repo' },
      ],
    });
    await acceptPendingInvitations(api, 'janedoe/FleetADLC');

    expect(accepted).toEqual([2]);
  });

  it('matches the repository without caring about case', async () => {
    // GitHub is case-insensitive about owner and repository names, and an
    // operator's configuration is written by hand.
    const { api, accepted } = fake({ pending: [{ id: 9, full_name: 'Janedoe/FleetADLC' }] });
    await acceptPendingInvitations(api, 'janedoe/fleetadlc');
    expect(accepted).toEqual([9]);
  });

  it('says an empty listing means it could not see, not that there is nothing', async () => {
    // The measured behaviour: an app token gets 200 [] however many invitations
    // are actually waiting. Reporting that as "nothing pending" is how a bot
    // ends up connected, tokenful and unable to push with no stated reason.
    const { api } = fake({ pending: [] });
    const outcome = await acceptPendingInvitations(api, 'janedoe/FleetADLC');

    expect(outcome.action).toBe('none');
    expect(outcome).toMatchObject({ detail: expect.stringContaining('app token never sees one') });
  });

  it('reports a failure to even look, rather than calling it nothing-to-do', async () => {
    const { api } = fake({ failList: new Error('connect ECONNREFUSED') });
    const outcome = await acceptPendingInvitations(api, 'janedoe/FleetADLC');

    expect(outcome.action).toBe('refused');
    expect(outcome).toMatchObject({ detail: expect.stringContaining('ECONNREFUSED') });
  });

  it('reads what is waiting, for a page that wants to show it', async () => {
    const { api } = fake({
      pending: [{ id: 5, full_name: 'janedoe/FleetADLC', inviter: 'janedoe' }],
    });
    expect(await listInvitations(api)).toEqual([
      { id: 5, repository: 'janedoe/FleetADLC', inviter: 'janedoe' },
    ]);
  });
});

describe('inviting an account to a repository', () => {
  const refusing = (error: Error): InvitationApi => ({
    async request<T>(): Promise<T> {
      throw error;
    },
  });

  it('says why by GitHub’s status, not by digits that happen to be in the path', async () => {
    // A rate limit for `builder-404` read as "not a GitHub account", and one on
    // `acme/app-422` as a refused triage role.
    const limited = (repo: string, login: string) =>
      new GitHubApiError(403, `/repos/${repo}/collaborators/${login}`, '{"message":"API rate limit exceeded"}');

    expect(await inviteCollaborator(refusing(limited('acme/api', 'builder-404')), 'acme/api', 'builder-404', 'push')).toMatchObject({
      action: 'refused',
      detail: expect.stringContaining('API rate limit exceeded'),
    });
    expect(await inviteCollaborator(refusing(limited('acme/app-422', 'ottoexampleco')), 'acme/app-422', 'ottoexampleco', 'triage')).toMatchObject({
      action: 'refused',
      detail: expect.stringContaining('API rate limit exceeded'),
    });
  });

  it('names a missing account, a missing permission and a refused role', async () => {
    const at = '/repos/acme/api/collaborators/ottoexampleco';
    expect(await inviteCollaborator(refusing(new GitHubApiError(404, at, 'Not Found')), 'acme/api', 'ottoexampleco', 'push')).toMatchObject({
      detail: 'ottoexampleco is not a GitHub account',
    });
    expect(
      await inviteCollaborator(refusing(new GitHubApiError(403, at, '{"message":"Resource not accessible by integration"}')), 'acme/api', 'ottoexampleco', 'push'),
    ).toMatchObject({ detail: 'the OpenADLC app needs `Administration: read and write` to invite anybody' });
    expect(await inviteCollaborator(refusing(new GitHubApiError(422, at, 'Validation Failed')), 'acme/api', 'ottoexampleco', 'triage')).toMatchObject({
      detail: expect.stringContaining('a repository owned by a person has no triage role'),
    });
    // Only triage is the role a person's repository lacks.
    const push = await inviteCollaborator(refusing(new GitHubApiError(422, at, 'Validation Failed')), 'acme/api', 'ottoexampleco', 'push');
    expect(push).toMatchObject({ detail: expect.stringContaining('GitHub refused the role `push`') });
    expect(push).not.toMatchObject({ detail: expect.stringContaining('triage') });
  });
});

describe('an account’s access to a repository', () => {
  const asking = (answer: unknown) => {
    const asked: string[] = [];
    const api: InvitationApi = {
      async request<T>(method: string, path: string): Promise<T> {
        asked.push(`${method} ${path}`);
        if (answer instanceof Error) throw answer;
        return answer as T;
      },
    };
    return { api, asked };
  };

  it('is asked of the repository, which counts a team and an organization as well as an invitation', async () => {
    const { api, asked } = asking({ permission: 'write', role_name: 'write' });
    expect(await repositoryAccess(api, 'acme/api', 'fleetadlc-atlas-janedoe')).toBe('write');
    expect(asked).toEqual(['GET /repos/acme/api/collaborators/fleetadlc-atlas-janedoe/permission']);
  });

  it('reads the role before the permission, which folds triage into read', async () => {
    expect(await repositoryAccess(asking({ permission: 'read', role_name: 'triage' }).api, 'acme/api', 'ottoexampleco')).toBe('triage');
    expect(await repositoryAccess(asking({ permission: 'read' }).api, 'acme/api', 'ottoexampleco')).toBe('read');
  });

  it('is unknown when GitHub cannot say, rather than none', async () => {
    expect(await repositoryAccess(asking(new Error('/repos/acme/api/collaborators/nobody/permission → 404')).api, 'acme/api', 'nobody')).toBeNull();
    expect(await repositoryAccess(asking({ permission: 'something new' }).api, 'acme/api', 'x')).toBeNull();
  });

  it('suffices at the role OpenADLC gives the account, or above, and never when unknown', () => {
    expect(accessSuffices('write', 'write')).toBe(true);
    expect(accessSuffices('admin', 'write')).toBe(true);
    expect(accessSuffices('triage', 'write')).toBe(false);
    expect(accessSuffices('triage', 'triage')).toBe(true);
    expect(accessSuffices('read', 'triage')).toBe(false);
    expect(accessSuffices('none', 'triage')).toBe(false);
    expect(accessSuffices(null, 'triage')).toBe(false);
  });
});
