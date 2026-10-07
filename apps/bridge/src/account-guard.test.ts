import { describe, expect, it } from 'vitest';
import { elevatedOn, guardRefusal, peopleOf, personChoiceRefusal, type AccountGuardDeps } from './account-guard.js';

/**
 * Which accounts no bot may sign in as: the install's people, the people a
 * managed repository's AGENTS.md names under Human review, and an account
 * that administers a managed repository.
 */

const AGENTS = '# Agent notes\n\n## Human review\n\n- `config/` @janedoe @owner\n- `infra/` @ExampleCo-Ops\n';

function deps(input: {
  humans?: string[];
  agents?: string | null | Error;
  permission?: Record<string, { role_name?: string; permission?: string } | Error>;
  noApp?: boolean;
}): AccountGuardDeps {
  return {
    humans: async () => input.humans ?? [],
    repositories: async () => [{ fullName: 'exampleco/app', defaultBranch: 'main' }],
    asker: async () =>
      input.noApp
        ? null
        : {
            request: async <T,>(_method: string, path: string): Promise<T> => {
              if (path.startsWith('/repos/exampleco/app/contents/AGENTS.md')) {
                if (input.agents instanceof Error) throw input.agents;
                if (input.agents === null) throw new Error('404');
                return { content: Buffer.from(input.agents ?? AGENTS).toString('base64'), encoding: 'base64' } as T;
              }
              const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1] ?? '';
              const answer = input.permission?.[decodeURIComponent(login)];
              if (!answer) throw new Error('404');
              if (answer instanceof Error) throw answer;
              return answer as T;
            },
          },
  };
}

describe('the people no bot may be', () => {
  it('are the install’s people and the logins AGENTS.md names under Human review, never the template’s @owner', async () => {
    const people = await peopleOf(deps({ humans: ['alice-example'] }));

    expect(people.map((person) => person.login)).toEqual(['alice-example', 'janedoe', 'ExampleCo-Ops']);
    expect(people[0]?.why).toBe('one of this install’s people (FLEETADLC_HUMANS)');
    expect(people[1]?.why).toBe('named in exampleco/app’s AGENTS.md Human review');
  });

  it('add nobody from a file that cannot be read, or when the app cannot be asked', async () => {
    expect(await peopleOf(deps({ agents: new Error('rate limited') }))).toEqual([]);
    expect(await peopleOf(deps({ noApp: true, humans: ['janedoe'] }))).toHaveLength(1);
  });

  it('give Crew a short reason beside a person’s account, matched whatever the case', async () => {
    const people = await peopleOf(deps({ humans: ['janedoe'] }));
    expect(personChoiceRefusal('JaneDoe', people)).toBe('one of this install’s people — bots need their own account');
    expect(personChoiceRefusal('exampleco-ops', people)).toBe('a person named in exampleco/app’s AGENTS.md — bots need their own account');
    expect(personChoiceRefusal('exampleco-crew', people)).toBeNull();
  });
});

describe('an account that administers a managed repository', () => {
  it('is found when GitHub answers admin or maintain, by role or by permission', async () => {
    const guard = deps({
      permission: {
        'exampleco-admin': { permission: 'admin', role_name: 'admin' },
        'exampleco-maintain': { permission: 'write', role_name: 'maintain' },
        'exampleco-crew': { permission: 'write', role_name: 'write' },
      },
    });
    expect(await elevatedOn('exampleco-admin', guard)).toEqual({ repo: 'exampleco/app', role: 'admin' });
    expect(await elevatedOn('exampleco-maintain', guard)).toEqual({ repo: 'exampleco/app', role: 'maintain' });
    expect(await elevatedOn('exampleco-crew', guard)).toBeNull();
  });

  it('is not refused when GitHub cannot be asked: the bot-access check asks again', async () => {
    expect(await elevatedOn('exampleco-admin', deps({ permission: { 'exampleco-admin': new Error('502') } }))).toBeNull();
    expect(await elevatedOn('exampleco-admin', deps({ noApp: true }))).toBeNull();
  });
});

describe('the refusal', () => {
  it('names the account and says to sign in as the bot’s own', async () => {
    const said = await guardRefusal('janedoe', deps({}), { elevated: true, then: 'enter a new code' });
    expect(said).toBe(
      'janedoe is named in exampleco/app’s AGENTS.md Human review, so no bot can sign in as it. ' +
        'Sign in to GitHub as the bot’s own account (a private window helps) and enter a new code.',
    );
  });

  it('names the repository and says to lower the account, only when asked to look', async () => {
    const guard = deps({ permission: { 'exampleco-crew': { role_name: 'admin', permission: 'admin' } } });
    expect(await guardRefusal('exampleco-crew', guard, { elevated: false, then: 'connect it again' })).toBeNull();
    const said = await guardRefusal('exampleco-crew', guard, { elevated: true, then: 'enter a new code' });
    expect(said).toContain('exampleco-crew has admin on exampleco/app');
    expect(said).toContain('https://github.com/exampleco/app/settings/access');
  });
});
