import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '@fleetadlc/github';

vi.mock('@fleetadlc/db', () => ({
  repos: { getRepoByName: vi.fn(async (name: string) => ({ id: 'repo-1', name, fullName: `exampleco/${name}` })) },
  tasks: { getTask: vi.fn(async () => null) },
  threads: {
    listOpenGates: vi.fn(async () => []),
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async (input: Record<string, unknown>) => ({ id: 'message-1', ...input })),
  },
}));

import { sendThreadMessage } from './thread-messages.js';

const BUILDER = { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe' };

/** A message to the builder about an issue, sent with `client` as the bot's GitHub. */
async function refusal(bot: Record<string, unknown>, client: unknown): Promise<{ status: number; message: string }> {
  try {
    await sendThreadMessage(
      { actors: { asBot: async () => client } as never, gates: {} as never, taskService: {} as never },
      { bot: bot as never, subject: 'shop#12', text: 'Use the new endpoint.', identity: 'janedoe' },
    );
  } catch (error) {
    return { status: (error as { status: number }).status, message: (error as Error).message };
  }
  throw new Error('it was sent, and should not have been');
}

describe('a message a person sends to GitHub that is not sent', () => {
  it('says to connect a bot with no account, by the seat the command takes', async () => {
    const { status, message } = await refusal({ ...BUILDER, githubLogin: null }, null);
    expect(status).toBe(409);
    expect(message).toContain('has no GitHub account yet, so it was not sent');
    expect(message).toContain('run: fleetadlc auth login --bot builder');
  });

  it('tells a sign-in that failed apart from no account, and says to try again or reconnect', async () => {
    const { message } = await refusal(BUILDER, null);
    expect(message).toContain('could not sign in to GitHub just now, so it was not sent');
    expect(message).toContain('reconnect it from Settings → GitHub → Connected accounts');
    expect(message).not.toContain('has no GitHub account');
  });

  it('says what GitHub’s refusal means rather than passing its text along', async () => {
    const refusing = (error: Error) => ({ comment: async () => Promise.reject(error) });

    const gone = await refusal(BUILDER, refusing(new GitHubApiError(401, '/repos/exampleco/shop/issues/12/comments', 'Bad credentials')));
    expect(gone).toMatchObject({ status: 502, message: expect.stringContaining('Reconnect it from Settings → GitHub → Connected accounts, then send it again') });

    const hidden = await refusal(BUILDER, refusing(new GitHubApiError(404, '/repos/exampleco/shop/issues/12/comments', 'Not Found')));
    expect(hidden.message).toContain('GitHub cannot find exampleco/shop#12, or');

    const offline = await refusal(BUILDER, refusing(new Error('fetch failed')));
    expect(offline.message).toBe('GitHub did not answer (fetch failed), so it was not sent. Try again in a minute');
  });
});
