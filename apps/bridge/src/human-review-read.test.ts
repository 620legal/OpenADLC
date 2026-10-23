import { GitHubApiError } from '@openadlc/github';
import { describe, expect, it, vi } from 'vitest';
import { readHumanReviewRules } from './human-review-read.js';

/**
 * Why a repository's Human-review rules could not be read. The plan-change
 * message said to add a section and that the repository's card in Needs you
 * named the line, whatever went wrong; on a scratch install no account could
 * read AGENTS.md, and there was no such card.
 */

const AGENTS = ['# Agent notes', '', '## Human review', '', '- `config/` @orzelig', ''].join('\n');

function reading(file: string | null | Error, repository: true | Error = true) {
  return {
    readFileIfPresent: vi.fn(async () => {
      if (file instanceof Error) throw file;
      return file;
    }),
    request: vi.fn(async () => {
      if (repository instanceof Error) throw repository;
      return { full_name: 'acme/api' };
    }),
  };
}

const read = (client: ReturnType<typeof reading> | null) => readHumanReviewRules(client as never, 'openadlc-flow', 'acme/api', 'main');

describe('reading the Human-review rules for a plan change', () => {
  it('reads them from AGENTS.md on the base branch', async () => {
    const client = reading(AGENTS);
    await expect(read(client)).resolves.toEqual({ rules: [{ path: 'config/', logins: ['orzelig'] }], unread: null });
    expect(client.readFileIfPresent).toHaveBeenCalledWith('acme/api', 'AGENTS.md', 'main');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('says no account could read them when the automation account is not connected', async () => {
    await expect(read(null)).resolves.toEqual({ rules: null, unread: { cause: 'no-account', account: 'openadlc-flow' } });
  });

  it('says GitHub refused the account, for a sign-in it no longer takes or a repository it cannot see', async () => {
    await expect(read(reading(new GitHubApiError(401, '/repos/acme/api/contents/AGENTS.md', 'Bad credentials')))).resolves.toEqual({
      rules: null,
      unread: { cause: 'no-access', account: 'openadlc-flow', status: 401 },
    });
    // GitHub answers 404 for a file in a repository the account cannot see.
    await expect(read(reading(null, new GitHubApiError(404, '/repos/acme/api', 'Not Found')))).resolves.toEqual({
      rules: null,
      unread: { cause: 'no-access', account: 'openadlc-flow', status: 404 },
    });
    // Its rate limit is a 403 too, and is no refusal.
    await expect(read(reading(new GitHubApiError(403, '/repos/acme/api/contents/AGENTS.md', 'API rate limit exceeded')))).resolves.toEqual({
      rules: null,
      unread: { cause: 'read-failed', status: 403 },
    });
  });

  it('tells a missing file, a missing section and a line it cannot read apart', async () => {
    await expect(read(reading(null))).resolves.toEqual({ rules: null, unread: { cause: 'no-file' } });
    await expect(read(reading('# Agent notes\n\nNo rules here.\n'))).resolves.toEqual({ rules: null, unread: { cause: 'no-section' } });
    await expect(read(reading(`${AGENTS}- \`a/\` \`b/\` @orzelig\n`))).resolves.toEqual({
      rules: null,
      unread: { cause: 'unreadable-line', line: 6, reason: 'it names two paths; give each its own line' },
    });
  });

  it('says GitHub failed, and with what, for anything else', async () => {
    await expect(read(reading(new GitHubApiError(502, '/repos/acme/api/contents/AGENTS.md', 'Bad Gateway')))).resolves.toEqual({
      rules: null,
      unread: { cause: 'read-failed', status: 502 },
    });
    await expect(read(reading(new Error('fetch failed')))).resolves.toEqual({ rules: null, unread: { cause: 'read-failed', status: null } });
    await expect(read(reading(null, new GitHubApiError(500, '/repos/acme/api', 'oops')))).resolves.toEqual({ rules: null, unread: { cause: 'read-failed', status: 500 } });
  });
});
