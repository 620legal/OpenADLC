import { GITHUB_EMAIL_SETTINGS_URL, type Bot } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import { commitEmailCheck } from './commit-email.js';
import type { RepoRef } from './crew.js';

/**
 * Whether GitHub publishes a crew account's own email on the commits it
 * writes for it: the squash merges and update-branch merges of every crew
 * pull request.
 */

const LEAKED = 'janedoe+fleetadlc-builder@example.com';
const PRIVATE = '12345+exampleco-crew@users.noreply.github.com';

const bot = (id: string, githubLogin: string | null): Bot => ({ id, name: id, githubLogin }) as Bot;
const repo = (name: string): RepoRef => ({ name, fullName: `exampleco/${name}`, defaultBranch: 'main' });

/** A commit as GitHub lists it: written by GitHub (`web-flow`) or pushed by the bot. */
function commit(sha: string, email: string, date: string, by: 'github' | 'bot' = 'github') {
  return {
    sha,
    commit: {
      author: { email },
      committer: { email: by === 'github' ? 'noreply@github.com' : 'exampleco-crew@users.noreply.github.com', date },
    },
    committer: { login: by === 'github' ? 'web-flow' : 'exampleco-crew' },
  };
}

function check(input: {
  crew: Bot[];
  repositories?: RepoRef[];
  commits?: Record<string, unknown[] | Error>;
  token?: (bot: Bot) => Promise<string>;
}) {
  const asked: string[] = [];
  const subject = commitEmailCheck({
    crew: async () => input.crew,
    repositories: async () => input.repositories ?? [repo('api')],
    token: input.token ?? (async () => 'ghu_test'),
    github: () => ({
      request: async <T,>(_method: string, path: string): Promise<T> => {
        asked.push(path);
        const found = input.commits?.[path.split('?')[0]!];
        if (found instanceof Error) throw found;
        return (found ?? []) as T;
      },
    }),
  });
  return { subject, asked };
}

describe('the commit-email check', () => {
  it('is a warning that claims the GitHub accounts step and offers Dismiss', () => {
    const { subject } = check({ crew: [] });
    expect(subject.id).toBe('commit-email');
    expect(subject.steps).toEqual(['github-accounts']);
    expect(subject.history).toBe(true);
  });

  it('passes when the newest commit GitHub wrote carries a noreply address', async () => {
    const { subject } = check({
      crew: [bot('b-builder', 'exampleco-crew')],
      commits: {
        '/repos/exampleco/api/commits': [
          commit('aaa1111', PRIVATE, '2026-09-30T10:00:00Z'),
          commit('bbb2222', LEAKED, '2026-09-01T10:00:00Z'),
        ],
      },
    });

    expect(await subject.run(new Date())).toEqual([expect.objectContaining({ subject: 'exampleco-crew', ok: true })]);
  });

  it('warns when it carries the account’s own address, naming the commit but never the address', async () => {
    const { subject, asked } = check({
      crew: [bot('b-builder', 'exampleco-crew')],
      repositories: [repo('api'), repo('web')],
      commits: {
        '/repos/exampleco/api/commits': [commit('aaa1111', PRIVATE, '2026-09-01T10:00:00Z')],
        '/repos/exampleco/web/commits': [commit('ccc3333', LEAKED, '2026-09-30T10:00:00Z')],
      },
    });

    const [result] = await subject.run(new Date());

    expect(asked).toEqual([
      '/repos/exampleco/api/commits?author=exampleco-crew&per_page=20',
      '/repos/exampleco/web/commits?author=exampleco-crew&per_page=20',
    ]);
    expect(result).toMatchObject({
      subject: 'exampleco-crew',
      ok: false,
      severity: 'warning',
      action: { url: GITHUB_EMAIL_SETTINGS_URL },
      facts: { login: 'exampleco-crew', repo: 'web', sha: 'ccc3333', occurrence: 'ccc3333' },
    });
    expect(JSON.stringify(result)).not.toContain('example.com');
    expect(JSON.stringify(result)).toContain('exampleco/web');
  });

  it('judges only commits GitHub wrote, not the bot’s own pushes', async () => {
    const { subject } = check({
      crew: [bot('b-builder', 'exampleco-crew')],
      commits: {
        '/repos/exampleco/api/commits': [
          commit('ddd4444', PRIVATE, '2026-09-30T10:00:00Z', 'bot'),
          commit('eee5555', LEAKED, '2026-09-01T10:00:00Z'),
        ],
      },
    });

    expect(await subject.run(new Date())).toEqual([expect.objectContaining({ ok: false, facts: expect.objectContaining({ sha: 'eee5555' }) })]);
  });

  it('asks once per account, whatever number of seats share it, and skips a seat on none', async () => {
    const { subject, asked } = check({
      crew: [bot('b-builder', 'exampleco-crew'), bot('b-qa', 'Exampleco-Crew'), bot('b-spare', null)],
    });

    const results = await subject.run(new Date());

    expect(results).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it('says nothing until GitHub has written a commit, or when it cannot be asked', async () => {
    const none = check({ crew: [bot('b-builder', 'exampleco-crew')], commits: { '/repos/exampleco/api/commits': [commit('fff6666', LEAKED, '2026-09-30T10:00:00Z', 'bot')] } });
    expect(await none.subject.run(new Date())).toEqual([expect.objectContaining({ ok: null, reason: expect.stringContaining('no commit') })]);

    const failing = check({ crew: [bot('b-builder', 'exampleco-crew')], commits: { '/repos/exampleco/api/commits': new Error('rate limited') } });
    expect(await failing.subject.run(new Date())).toEqual([expect.objectContaining({ ok: null })]);

    const signedOut = check({
      crew: [bot('b-builder', 'exampleco-crew')],
      token: async () => {
        throw new Error('not connected');
      },
    });
    expect(await signedOut.subject.run(new Date())).toEqual([expect.objectContaining({ ok: null })]);
  });
});
