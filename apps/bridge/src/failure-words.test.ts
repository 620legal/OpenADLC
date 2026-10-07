import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '@fleetadlc/github';
import { explainFailure, withoutTransport } from './failure-words.js';

/**
 * Why a task stopped, said so the person who has to act on it knows what to
 * do — the two cards the owner found on the board, word for word, first.
 */

const CODEX_401 =
  'Engine exited 1: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: 9851c2d86e1f2a7b-EWR';

const GROK_SIGNED_OUT =
  'hostd refused: POST http://127.0.0.1:47312/tasks → 500: { "error": "You are not authenticated — sign this subscription in again from the accounts step" }';

describe('the cards the board showed', () => {
  it('says an OpenAI refusal is OpenAI refusing, names the account, and points at it — the raw text kept for Details', () => {
    const words = explainFailure(CODEX_401, {
      bot: 'noraexampleco',
      account: { label: 'OpenAI — team key', provider: 'openai', kind: 'key' },
    });

    expect(words.sentence).toBe(
      'OpenAI refused a request from noraexampleco: no key came with it (401). Check the key of the OpenAI API account “OpenAI — team key” on the “Foundation model accounts / API keys” step, then try again.',
    );
    expect(words.action).toEqual({ kind: 'open_page', label: 'Check the key', href: '/onboarding?step=models' });
    expect(words.raw).toBe(CODEX_401);
    expect(words.sentence).not.toMatch(/cf-ray|https?:|Engine exited/);
  });

  it('says a signed-out subscription is signed out, which one, and to sign it in again', () => {
    const words = explainFailure(GROK_SIGNED_OUT, {
      bot: 'irisexampleco',
      account: { label: 'Grok — SuperGrok', provider: 'xai', kind: 'subscription' },
    });

    expect(words.sentence).toBe(
      'The xAI subscription “Grok — SuperGrok” irisexampleco thinks with is signed out. Sign it in again on the “Foundation model accounts / API keys” step, then try again.',
    );
    expect(words.action).toEqual({ kind: 'open_page', label: 'Sign in again', href: '/onboarding?step=models' });
    expect(words.raw).toBe(GROK_SIGNED_OUT);
  });

  it('tells a key account a provider calls not authenticated to check the key, not to sign in', () => {
    const words = explainFailure('OpenAI answered: You are not authenticated', {
      bot: 'noraexampleco',
      account: { label: 'OpenAI — team key', provider: 'openai', kind: 'key' },
    });

    expect(words.sentence).toBe(
      'OpenAI did not accept the key of the OpenAI API account “OpenAI — team key” noraexampleco thinks with. Check the key on the “Foundation model accounts / API keys” step, then try again.',
    );
    expect(words.action).toEqual({ kind: 'open_page', label: 'Check the key', href: '/onboarding?step=models' });
  });

  it('leaves out a name the walkthrough made, which only repeats the provider and kind', () => {
    // On the board: "xAI — subscription, the xAI subscription irisexampleco thinks with, is signed out".
    expect(
      explainFailure(GROK_SIGNED_OUT, { bot: 'irisexampleco', account: { label: 'xAI — subscription', provider: 'xai', kind: 'subscription' } }).sentence,
    ).toBe('The xAI subscription irisexampleco thinks with is signed out. Sign it in again on the “Foundation model accounts / API keys” step, then try again.');
    expect(
      explainFailure(CODEX_401, { bot: 'noraexampleco', account: { label: 'OpenAI — API key', provider: 'openai', kind: 'key' } }).sentence,
    ).toBe(
      'OpenAI refused a request from noraexampleco: no key came with it (401). Check the key of the OpenAI API account on the “Foundation model accounts / API keys” step, then try again.',
    );
  });
});

describe('a review that never came', () => {
  it('leads with what the reviewer said, even when its words name a 401', () => {
    const words = explainFailure(
      'ended without posting its review. It said: “I could not post it: gh answered 401 Unauthorized. Please re-run this task.”',
      { bot: 'the lead reviewer (noraexampleco)', account: { label: 'OpenAI — team key', provider: 'openai', kind: 'key' } },
    );

    expect(words.sentence).toBe('The lead reviewer (noraexampleco) ended without posting its review. It said: “I could not post it: gh answered 401 Unauthorized.”');
    expect(words.action).toBeNull();
    expect(words.raw).toContain('Please re-run this task.');
  });

  it('says a review written and never posted does not count', () => {
    const words = explainFailure(
      'ended without posting its review: it wrote one in its answer and did not post it. It said: “**Verdict: approve** No blocking findings.”',
      { bot: 'the lead reviewer (noraexampleco)' },
    );
    expect(words.sentence).toBe(
      'The lead reviewer (noraexampleco) wrote its review but never posted it on the pull request, so the review does not count. Try again.',
    );
    expect(words.raw).toContain('Verdict: approve');
  });

  it('says it did not say why when it said nothing', () => {
    expect(explainFailure('ended without posting its review', { bot: 'the second reviewer (irisexampleco)' }).sentence).toBe(
      'The second reviewer (irisexampleco) ended without posting its review, and did not say why. Open its thread, then try again.',
    );
  });
});

describe('the other causes a person can fix', () => {
  it('names the permission GitHub asked for, as the app’s page names it, with the permissions page when known', () => {
    const words = explainFailure(
      '/user/ssh_signing_keys → 403: {"message":"Resource not accessible by integration"} x-accepted-github-permissions: git_signing_ssh_public_keys=write',
      { bot: 'fleetadlc-atlas-janedoe', permissionsUrl: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
    );
    expect(words.sentence).toContain('the OpenADLC app lacks “SSH signing keys”');
    expect(words.action).toEqual({
      kind: 'open_url',
      label: 'Open the app’s permissions',
      url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions',
    });
  });

  it('names the permission from a 403 as the client throws it, header and all', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
        headers: { 'x-accepted-github-permissions': 'pull_requests=write' },
      })) as typeof fetch;
    const client = new GitHubClient({ token: 'token', actingAs: 'fleetadlc-atlas-janedoe', fetchImpl });
    const thrown = await client.requestReviewers('janedoe/fleetadlc-testbed', 4, ['janedoe']).catch((error: Error) => error);

    expect(explainFailure((thrown as Error).message, { bot: 'fleetadlc-atlas-janedoe' }).sentence).toContain(
      'the OpenADLC app lacks “Pull requests”',
    );
  });

  it('does not call a 404 carrying the header a missing permission', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'x-accepted-github-permissions': 'contents=read' },
      })) as typeof fetch;
    const client = new GitHubClient({ token: 'token', actingAs: 'fleetadlc-atlas-janedoe', fetchImpl });
    const thrown = await client.viewer().catch((error: Error) => error);

    expect(explainFailure((thrown as Error).message, { bot: 'fleetadlc-atlas-janedoe' }).sentence).not.toContain('lacks');
  });

  it('names the permission from a 403 the app itself was refused', async () => {
    const { APP_API } = await import('./invitation-service.js');
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
        headers: { 'x-accepted-github-permissions': 'administration=write' },
      }),
    );
    try {
      const thrown = await APP_API.request('PUT', '/repos/janedoe/fleetadlc-testbed/collaborators/janedoe', 'token').catch(
        (error: Error) => error,
      );
      expect(explainFailure((thrown as Error).message, { bot: 'fleetadlc-atlas-janedoe' }).sentence).toContain(
        'the OpenADLC app lacks “Administration”',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says a commit GitHub refused for its signature is a signing key to register, by reconnecting the bot', () => {
    const words = explainFailure('remote: error: GH006: Protected branch update failed for refs/heads/main. Commits must have verified signatures.', {
      bot: 'fleetadlc-atlas-janedoe',
    });
    expect(words.sentence).toBe(
      'GitHub refused a commit by fleetadlc-atlas-janedoe: it was not signed with a key its account has. Reconnect fleetadlc-atlas-janedoe so GitHub learns its signing key, then try again.',
    );
    expect(words.action).toEqual({ kind: 'open_page', label: 'Reconnect fleetadlc-atlas-janedoe', href: '/settings#github-accounts' });
  });

  it('says hostd not answering, with the command that starts OpenADLC again', () => {
    const words = explainFailure('hostd refused: fetch failed: connect ECONNREFUSED 127.0.0.1:47312', { bot: 'The builder' });
    expect(words.sentence).toContain('OpenADLC’s host service did not answer');
    expect(words.action).toEqual({ kind: 'run_command', label: 'Run fleetadlc up', command: 'fleetadlc up' });
  });

  it('says a task OpenADLC stopped under a bot was stopped by OpenADLC, and that trying again picks it up', () => {
    expect(explainFailure('hostd shutting down', { bot: 'irisexampleco' }).sentence).toBe(
      'OpenADLC stopped while irisexampleco was working, and nothing started the work again. Try again to pick it up.',
    );
    expect(explainFailure('container restarted', { bot: 'irisexampleco' }).action).toBeNull();
    expect(explainFailure('container restarted', { bot: 'irisexampleco' }).sentence).toBe(
      'The computer irisexampleco was working on restarted. Try again to start the work over.',
    );
  });

  it('says a sign-in GitHub no longer accepts, with reconnecting as the fix', () => {
    const words = explainFailure(
      "fleetadlc-atlas-janedoe's GitHub authorization is no longer valid (The refresh token passed is incorrect or expired.)",
      { bot: 'fleetadlc-atlas-janedoe' },
    );
    expect(words.sentence).toBe('GitHub no longer accepts the sign-in of fleetadlc-atlas-janedoe. Reconnect it, then try again.');
  });
});

describe('anything else', () => {
  it('is its first sentence, without the route it came through, with the whole of it behind Details', () => {
    const raw = 'hostd refused: POST http://127.0.0.1:47312/tasks → 409: {"error":"the model claude-opus-4 is not offered by this account. Pick another."}';
    const words = explainFailure(raw, { bot: 'The builder' });
    expect(words.sentence).toBe('The model claude-opus-4 is not offered by this account.');
    expect(words.action).toBeNull();
    expect(words.raw).toBe(raw);
  });

  it('keeps no Details when the sentence is all there was', () => {
    expect(explainFailure('The per-task cap of $15 was reached.', { bot: 'The builder' })).toEqual({
      sentence: 'The per-task cap of $15 was reached.',
      action: null,
      raw: null,
    });
    expect(explainFailure(null, { bot: 'The builder' }).sentence).toBe('It stopped without saying why.');
  });

  it('strips request ids, addresses and the engine’s exit from a provider’s refusal', () => {
    expect(withoutTransport('Engine exited 2: unexpected status 500 Internal Server Error: overloaded, url: https://api.x.ai/v1/x, request-id: req_12')).toBe(
      '500: overloaded',
    );
  });
});
