// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckRow } from '@/lib/api';

/** A flaky job's File as task (#372): opens the New request form filled in, and sends nothing. */

const filing = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
vi.mock('@/app/actions', () => ({
  fileRequest: vi.fn(async (input: Record<string, unknown>) => {
    filing.sent.push(input);
    return { ok: true, bot: 'intake', queued: false, position: null };
  }),
}));

const ROWS: CheckRow[] = [
  {
    key: 'integration',
    name: 'integration',
    runsOn: 'github',
    covered: false,
    last: { result: 'pass', url: null, at: null, detail: null },
    flaky: {
      count: 2,
      heads: [
        { sha: 'c'.repeat(40), runUrl: 'https://github.com/acme/api/actions/runs/105', passedAt: null },
        { sha: 'a'.repeat(40), runUrl: 'https://github.com/acme/api/actions/runs/101', passedAt: null },
      ],
    },
  },
  { key: 'check', name: 'check', runsOn: 'github', covered: true, last: { result: 'pass', url: null, at: null, detail: null }, flaky: null },
];

let root: Root;
let container: HTMLElement;
const fetched: string[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  filing.sent.length = 0;
  fetched.length = 0;
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(String(url));
    return new Response('{}', { status: 200 });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the Checks table', () => {
  it('offers File as task only on a flaky row', async () => {
    const { ChecksTable } = await import('./checks-table');
    await act(async () => root.render(<ChecksTable repo="api" rows={ROWS} repos={['api', 'web']} />));
    expect(container.querySelector('[data-check="integration"] [data-file-task]')).not.toBeNull();
    expect(container.querySelector('[data-check="check"] [data-file-task]')).toBeNull();
  });

  it('opens the New request form with the job, its count and heads, kind defect and the repository, and sends nothing', async () => {
    const { ChecksTable } = await import('./checks-table');
    await act(async () => root.render(<ChecksTable repo="api" rows={ROWS} repos={['api', 'web']} />));
    await act(async () => (container.querySelector('[data-file-task]') as HTMLButtonElement).click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    const [text, details] = [...dialog.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    const [repo, kind] = [...dialog.querySelectorAll('select')] as HTMLSelectElement[];
    expect(text!.value).toBe('Flaky CI job: integration');
    expect(details!.value).toBe(
      [
        'integration in ci failed and then passed on the same head 2 times in the last 30 runs:',
        '- ccccccc: https://github.com/acme/api/actions/runs/105',
        '- aaaaaaa: https://github.com/acme/api/actions/runs/101',
      ].join('\n'),
    );
    expect(kind!.value).toBe('defect');
    expect(repo!.value).toBe('api');
    expect(filing.sent).toEqual([]);
    expect(fetched).toEqual([]);
  });
});
