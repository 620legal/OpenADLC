// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseReadiness as Readiness, ReleaseReadinessItem } from '@/lib/api';

/**
 * The readiness checklist in a DOM (#371): read again every minute while the
 * page is visible, a failing item replaced once it passes, and the last items
 * kept, marked stale, when a read fails.
 */

const { ReleaseReadiness, READINESS_READ_MS } = await import('./release-readiness');

function readiness(signingKey: ReleaseReadinessItem): Readiness {
  return {
    repo: 'mac-app',
    fullName: 'acme/mac-app',
    checkedAt: '2026-11-26T08:00:00.000Z',
    items: [
      { id: 'account', title: 'Release account', status: 'pass', says: 'rel (uid 502) builds releases in /Users/rel' },
      signingKey,
      { id: 'recipe', title: 'Release recipe', status: 'pass', says: 'Runs make release' },
      { id: 'release_tag', title: 'Release tag', status: 'unknown', says: 'the tag rulesets of acme/mac-app could not be read: GitHub answered 502' },
      { id: 'version', title: 'Next version', status: 'pass', says: '1.5.0 at aaaaaaa is above 1.4.0' },
      { id: 'last_build', title: 'Last build', status: 'fail', says: 'The last build failed', fix: 'Tick Clean build when you cut.', informational: true },
    ],
  };
}

const FAILING: ReleaseReadinessItem = {
  id: 'signing_key',
  title: 'Signing key',
  status: 'fail',
  says: 'No release signing key is filed for acme/mac-app',
  fix: 'Run on the host: openadlc release-key import --repo acme/mac-app --file <path>',
  action: { label: 'Run on the host', command: 'openadlc release-key import --repo acme/mac-app --file <path>' },
};
const PASSING: ReleaseReadinessItem = { id: 'signing_key', title: 'Signing key', status: 'pass', says: 'A signing key is filed for acme/mac-app' };

let root: Root;
let container: HTMLElement;
let answer: { status: number; body: unknown };
let reads: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  reads = [];
  answer = { status: 200, body: readiness(PASSING) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      reads.push(url);
      return Response.json(answer.body, { status: answer.status });
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const item = (id: string) => container.querySelector(`[data-readiness-item="${id}"]`);

describe('the readiness checklist', () => {
  it('shows a failing item’s fix and its command, “could not check” with its reason, and the last build apart', async () => {
    await act(async () => root.render(<ReleaseReadiness repo="mac-app" initial={readiness(FAILING)} />));
    expect(item('signing_key')?.getAttribute('data-status')).toBe('fail');
    expect(item('signing_key')?.querySelector('[data-readiness-fix]')?.textContent).toBe('Run on the host: openadlc release-key import --repo acme/mac-app --file <path>');
    expect(item('signing_key')?.querySelector('[data-readiness-command]')?.textContent).toBe('openadlc release-key import --repo acme/mac-app --file <path>');
    expect(item('release_tag')?.textContent).toContain('could not check');
    expect(item('release_tag')?.textContent).toContain('GitHub answered 502');
    expect(item('account')?.querySelector('[data-readiness-fix]')).toBeNull();
    expect(container.textContent).toContain('For information');
    // The last build is informational: not counted in what needs attention.
    expect(container.textContent).toContain('2 of 5 need attention');
  });

  it('reads again after a minute while visible, and replaces a failing item with a passing one', async () => {
    await act(async () => root.render(<ReleaseReadiness repo="mac-app" initial={readiness(FAILING)} />));
    expect(reads).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READINESS_READ_MS);
    });
    expect(reads).toEqual(['/api/releases/mac-app/readiness']);
    expect(item('signing_key')?.getAttribute('data-status')).toBe('pass');
    expect(item('signing_key')?.querySelector('[data-readiness-fix]')).toBeNull();
  });

  it('keeps the last items, marked stale, when a read fails', async () => {
    answer = { status: 503, body: { error: 'the bridge is not answering' } };
    await act(async () => root.render(<ReleaseReadiness repo="mac-app" initial={readiness(FAILING)} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READINESS_READ_MS);
    });
    expect(container.querySelector('[data-readiness-stale]')?.textContent).toContain('the bridge is not answering');
    expect(item('signing_key')?.getAttribute('data-status')).toBe('fail');
  });

  it('does not read while the page is hidden, and reads at once when it is shown again', async () => {
    let state: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    await act(async () => root.render(<ReleaseReadiness repo="mac-app" initial={readiness(FAILING)} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READINESS_READ_MS * 3);
    });
    expect(reads).toEqual([]);
    state = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads).toHaveLength(1);
    expect(item('signing_key')?.getAttribute('data-status')).toBe('pass');
  });

  it('asks at once when the page had nothing to start from, and says it could not check while that fails', async () => {
    answer = { status: 503, body: { error: 'hostd is down' } };
    await act(async () => root.render(<ReleaseReadiness repo="mac-app" initial={null} />));
    expect(reads).toHaveLength(1);
    expect(container.querySelector('[data-readiness-stale]')?.textContent).toBe('Could not check: hostd is down.');
  });
});
