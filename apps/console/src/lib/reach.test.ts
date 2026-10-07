import { afterEach, describe, expect, it, vi } from 'vitest';
import { poll, reach } from './reach';

afterEach(() => {
  vi.unstubAllGlobals();
});

function noAnswer(words = 'Failed to fetch'): void {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError(words))));
}

function answers(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe('a poll’s read', () => {
  it('resolves to nothing when there is no answer, rather than rejecting', async () => {
    // A rejection here is an `Uncaught (in promise)` from a timer every few
    // seconds while the bridge restarts.
    noAnswer();
    await expect(poll('/api/pane/builder/shell')).resolves.toBeNull();
  });

  it('resolves to nothing on a refusal, and to the body on an answer', async () => {
    answers(502, { error: 'bridge is down' });
    await expect(poll('/api/pane/builder/shell')).resolves.toBeNull();
    answers(200, { pane: ['$ ls'] });
    await expect(poll('/api/pane/builder/shell')).resolves.toEqual({ pane: ['$ ls'] });
  });
});

describe('a request that must be answered', () => {
  it('says what did not answer, not the runtime’s words for it', async () => {
    noAnswer('fetch failed');
    await expect(reach('http://127.0.0.1:1/v1/x', {}, 'the bridge is not answering.')).rejects.toThrow(
      /^the bridge is not answering\.$/,
    );
  });
});
