// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseRunView } from '@/lib/api';

/**
 * Cut release in a DOM (#345): the press sends the view's id and Clean build
 * and never a commit, shows the code to approve, follows the sign-in to the
 * run, and the run to its end, where a published one links to its release.
 */

const { CutRelease, FLOW_READ_MS, RUN_READ_MS } = await import('./cut-release');

const run = (overrides: Partial<ReleaseRunView> = {}): ReleaseRunView => ({
  id: 'r-1',
  runId: 'run-1',
  repo: 'mac-app',
  sha: 'a'.repeat(40),
  state: 'running',
  clean: true,
  version: null,
  previousVersion: '1.4.0',
  reason: null,
  logTail: null,
  tag: null,
  releaseUrl: null,
  requestedBy: 'jane',
  startedAt: '2026-11-15T10:00:00.000Z',
  finishedAt: null,
  publishedAt: null,
  ...overrides,
});

let root: Root;
let container: HTMLElement;
let posted: { url: string; body: unknown }[];
let runReads: number;
/** What each read answers, changed as the test goes. */
let flowAnswer: unknown;
let runsAnswer: ReleaseRunView[];
let cutAnswer: { status: number; body: unknown };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  posted = [];
  runReads = 0;
  flowAnswer = { state: 'waiting' };
  runsAnswer = [];
  cutAnswer = { status: 200, body: { flow: { flowId: 'f-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 } } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json(cutAnswer.body, { status: cutAnswer.status });
      }
      if (url.startsWith('/api/releases/mac-app/flows/')) return Response.json(flowAnswer);
      if (url === '/api/releases/mac-app/runs') {
        runReads += 1;
        return Response.json({ runs: runsAnswer });
      }
      return Response.json({ error: 'no' }, { status: 404 });
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

async function draw(props: Partial<Parameters<typeof CutRelease>[0]> = {}): Promise<void> {
  await act(async () => root.render(<CutRelease repo="mac-app" viewId="view-1" mayCut runs={[]} {...props} />));
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const text = () => container.textContent ?? '';

describe('Cut release', () => {
  it('sends the view and Clean build, never a SHA, follows the sign-in to the run, and the run to its end', async () => {
    await draw();
    await act(async () => container.querySelector<HTMLInputElement>('input[data-clean]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-cut]')!.click());
    await tick(0);

    expect(posted).toEqual([{ url: '/api/releases/mac-app/cut', body: { viewId: 'view-1', clean: true } }]);
    expect(Object.keys(posted[0]!.body as object)).not.toContain('sha');
    expect(text()).toContain('ABCD-1234');
    expect(container.querySelector('a[href="https://github.com/login/device"]')).not.toBeNull();

    // Approved: the flow says which run started, and the page follows it.
    flowAnswer = { state: 'done', runId: 'run-1', id: 'r-1' };
    runsAnswer = [run()];
    await tick(FLOW_READ_MS);
    await tick(0);
    expect(text()).not.toContain('ABCD-1234');
    expect(text()).toContain('Building');

    runsAnswer = [run({ state: 'publishing', version: '1.5.0', tag: 'v1.5.0' })];
    await tick(RUN_READ_MS);
    expect(text()).toContain('Publishing');

    runsAnswer = [run({ state: 'published', version: '1.5.0', tag: 'v1.5.0', releaseUrl: 'https://github.com/acme/mac-app/releases/tag/v1.5.0' })];
    await tick(RUN_READ_MS);
    expect(text()).toContain('Published');
    const link = container.querySelector<HTMLAnchorElement>('a[data-release-link]');
    expect(link?.href).toBe('https://github.com/acme/mac-app/releases/tag/v1.5.0');

    // It stops reading once the run has ended.
    const reads = runReads;
    await tick(RUN_READ_MS * 3);
    expect(runReads).toBe(reads);
    // The view is used: no second cut from it.
    expect(container.querySelector<HTMLButtonElement>('button[data-cut]')!.disabled).toBe(true);
  });

  it('says a failed sign-in in the bridge’s words, and starts nothing', async () => {
    await draw();
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-cut]')!.click());
    await tick(0);
    flowAnswer = { state: 'failed', error: 'You approved the code as @mallory, which is not the GitHub account linked to you here; no release was started.' };
    await tick(FLOW_READ_MS);
    expect(text()).toContain('You approved the code as @mallory');
    expect(runReads).toBe(0);
  });

  it('says to reload when the view has expired', async () => {
    cutAnswer = { status: 409, body: { error: 'That view has expired; reload to see the default branch’s head again.' } };
    await draw();
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-cut]')!.click());
    await tick(0);
    expect(text()).toContain('That view has expired');
    expect(container.querySelector('a[href="/releases/mac-app"]')?.textContent).toBe('Reload');
  });

  it('shows the reason, and no button, when the viewer may not cut', async () => {
    await draw({ mayCut: false, why: 'Approves is off for you in People, so you cannot cut a release; an admin turns it on in Settings → People.', url: '/settings#people' });
    expect(container.querySelector('button[data-cut]')).toBeNull();
    expect(text()).toContain('Approves is off for you in People');
    expect(container.querySelector('a[href="/settings#people"]')).not.toBeNull();
  });

  it('follows a run already in flight when the page opens, and shows a failed publish’s reason', async () => {
    runsAnswer = [run({ state: 'built' })];
    await draw({ runs: runsAnswer });
    expect(text()).toContain('Built, waiting to publish');
    runsAnswer = [run({ state: 'publish_failed', reason: 'GitHub refused the tag: a ruleset blocks it' })];
    await tick(RUN_READ_MS);
    expect(text()).toContain('Publish failed');
    expect(text()).toContain('GitHub refused the tag: a ruleset blocks it');
    const reads = runReads;
    await tick(RUN_READ_MS * 2);
    expect(runReads).toBe(reads);
  });
});
