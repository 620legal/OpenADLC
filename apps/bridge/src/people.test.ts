import { beforeEach, describe, expect, it, vi } from 'vitest';

// The install's people as pinned to their accounts (`human-ids.ts`): janedoe is account 101.
vi.mock('@fleetadlc/db', () => ({
  settings: {
    getSetting: vi.fn(async (key: string) => (key === 'humanIds' ? JSON.stringify({ janedoe: 101 }) : null)),
    mergeSettingJson: vi.fn(async () => undefined),
  },
}));

import { actsForOn, askAsTheApp, forgetRepoAccess, permissionOn, repoAccess } from './people.js';

function asker(permissions: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    async request<T>(_method: string, path: string): Promise<T> {
      asked.push(path);
      const login = decodeURIComponent(/collaborators\/([^/]+)\/permission/.exec(path)?.[1] ?? '');
      if (!(login in permissions)) throw new Error('404');
      return { permission: permissions[login], role_name: permissions[login] } as T;
    },
  };
}

const crew = [{ githubLogin: 'irisexampleco' }];

describe('who OpenADLC acts for when the delivery’s label says otherwise', () => {
  beforeEach(() => forgetRepoAccess());

  it('acts for an owner GitHub labels a contributor, once GitHub says they can write', async () => {
    const client = asker({ janedoe: 'admin' });
    const author = { login: 'janedoe', association: 'CONTRIBUTOR' };
    expect(await actsForOn({ client, repoFullName: 'exampleco/api', author, crew })).toBe(true);
    // Kept: the second issue does not ask again.
    expect(await actsForOn({ client, repoFullName: 'exampleco/api', author, crew })).toBe(true);
    expect(client.asked).toHaveLength(1);
  });

  it('does not act for somebody who can only read, or whom GitHub will not say', async () => {
    expect(await actsForOn({ client: asker({ reader: 'read' }), repoFullName: 'exampleco/api', author: { login: 'reader', association: 'NONE' }, crew })).toBe(false);
    expect(await actsForOn({ client: asker({}), repoFullName: 'exampleco/api', author: { login: 'stranger', association: 'NONE' }, crew })).toBe(false);
  });

  it('takes a custom role on write, by the permission it is based on, and triage by its role', async () => {
    const answering = (answer: { permission: string; role_name: string }) => ({
      async request<T>(): Promise<T> {
        return answer as T;
      },
    });
    expect(await repoAccess(answering({ permission: 'write', role_name: 'release-manager' }), 'exampleco/api', 'janedoe')).toBe(true);
    expect(await repoAccess(answering({ permission: 'read', role_name: 'triage' }), 'exampleco/api', 'triager')).toBe(true);
    expect(await repoAccess(answering({ permission: 'read', role_name: 'docs-reader' }), 'exampleco/api', 'reader')).toBe(false);
  });

  it('says it could not ask, rather than no, when GitHub gives no answer', async () => {
    expect(await repoAccess(asker({}), 'exampleco/api', 'janedoe')).toBeNull();
  });

  it('acts for the install’s own people and the crew without asking', async () => {
    const client = asker({});
    expect(await actsForOn({ client, repoFullName: 'exampleco/api', author: { login: 'JaneDoe', association: 'NONE', id: 101 }, crew, humans: ['janedoe'] })).toBe(true);
    expect(await actsForOn({ client, repoFullName: 'exampleco/api', author: { login: 'irisexampleco', association: 'NONE' }, crew })).toBe(true);
    expect(client.asked).toEqual([]);
  });

  it('takes one of the install’s people only from the account the login was pinned to', async () => {
    // A login freed by a rename or a deletion, registered by somebody else:
    // the name matches, the account does not, and GitHub decides as for anyone.
    const client = asker({});
    expect(await actsForOn({ client, repoFullName: 'exampleco/api', author: { login: 'janedoe', association: 'NONE', id: 999 }, crew, humans: ['janedoe'] })).toBe(false);
    expect(await actsForOn({ client, repoFullName: 'exampleco/api', author: { login: 'janedoe', association: 'NONE' }, crew, humans: ['janedoe'] })).toBe(false);
    // Asked of GitHub both times, as anyone not on the list would be.
    expect(client.asked).toHaveLength(2);
  });
});

describe('asking as the app when the automation account cannot', () => {
  beforeEach(() => forgetRepoAccess());

  it('asks the app when GitHub will not answer the automation account', async () => {
    const { askAsTheApp } = await import('./people.js');
    const refusing = { request: async () => Promise.reject(new Error('403 Must have push access')) };
    askAsTheApp(async () => asker({ janedoe: 'admin' }));
    expect(await actsForOn({ client: refusing, repoFullName: 'exampleco/api', author: { login: 'janedoe', association: 'CONTRIBUTOR' }, crew })).toBe(true);
  });
});

describe('the role a login has, for the merge check', () => {
  beforeEach(() => forgetRepoAccess());
  const refusing = { permissionOf: vi.fn(async () => Promise.reject(new Error('403 Must have push access'))) };

  it('asks the app first, and takes its role name', async () => {
    const client = { permissionOf: vi.fn(async () => 'admin') };
    askAsTheApp(async () => asker({ triager: 'triage' }));
    expect(await permissionOn(client, 'exampleco/api', 'triager')).toBe('triage');
    expect(client.permissionOf).not.toHaveBeenCalled();
  });

  it('asks the automation account when the app cannot answer, and says unknown when neither does', async () => {
    askAsTheApp(async () => asker({}));
    expect(await permissionOn({ permissionOf: vi.fn(async () => 'write') }, 'exampleco/api', 'janedoe')).toBe('write');
    expect(await permissionOn(refusing, 'exampleco/api', 'janedoe')).toBe('unknown');
    expect(await permissionOn(null, 'exampleco/api', 'janedoe')).toBe('unknown');
  });
});
