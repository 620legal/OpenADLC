// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiFailure } from '@/lib/api';
import { CiFailureSection, ciFailurePath } from './ci-failure';

/** Why an item's pull request is red (#372): the failing job, step and error, only when ci is red. */

let root: Root;
let container: HTMLElement;
let answer: { status: number; body: unknown };
const asked: { url: string; method: string }[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    asked.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(failure: CiFailure | null, status = 200): Promise<void> {
  answer = { status, body: failure };
  await act(async () => {
    root.render(<CiFailureSection subject="api#31" repo="api" refreshKey="31:4" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const RED: CiFailure = {
  state: 'red',
  headSha: 'a'.repeat(40),
  runUrl: 'https://github.com/acme/api/actions/runs/9/attempts/1',
  jobs: [
    { name: 'check', url: 'https://github.com/acme/api/actions/runs/9/job/31', step: 'make ci', excerpt: ['FAIL src/x.test.ts', 'Process completed with exit code 1.'], excerptMissing: null },
    { name: 'integration', url: 'https://github.com/acme/api/actions/runs/9/job/32', step: 'suites', excerpt: null, excerptMissing: 'expired' },
  ],
};

describe('the CI failure section', () => {
  it('shows each failing job, its step and the first lines of its error, with links to the run and the Checks page', async () => {
    await show(RED);
    expect(asked).toEqual([{ url: ciFailurePath('api#31'), method: 'GET' }]);
    const text = container.textContent ?? '';
    expect(text).toContain('Why ci is red');
    expect(container.querySelectorAll('[data-failing-job]')).toHaveLength(2);
    expect(container.querySelector('[data-failing-step]')?.textContent).toBe('make ci');
    expect(container.querySelector('[data-excerpt]')?.textContent).toBe('FAIL src/x.test.ts\nProcess completed with exit code 1.');
    expect(container.querySelector('[data-run-link]')?.getAttribute('href')).toBe(RED.runUrl);
    expect(container.querySelector('[data-checks-link]')?.getAttribute('href')).toBe('/checks/api');
  });

  it('says when a log is not available and links to the job', async () => {
    await show(RED);
    const missing = container.querySelector('[data-excerpt-missing]');
    expect(missing?.textContent).toContain('The log is not available (GitHub no longer keeps it)');
    expect(missing?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/acme/api/actions/runs/9/job/32');
  });

  it('shows nothing when ci is green, running, absent, or the bridge has no such route', async () => {
    await show({ state: 'green', headSha: 'a'.repeat(40), runUrl: 'x' });
    expect(container.innerHTML).toBe('');
    await show({ state: 'running', headSha: 'a'.repeat(40), runUrl: 'x' });
    expect(container.innerHTML).toBe('');
    await show({ state: 'none' });
    expect(container.innerHTML).toBe('');
    await show(null, 404);
    expect(container.innerHTML).toBe('');
  });
});
