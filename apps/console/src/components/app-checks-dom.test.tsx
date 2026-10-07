// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppChecksPanel, type AppChecks } from './app-checks';

/**
 * The walkthrough's install panel in a DOM: when GitHub's answer moves, the
 * walkthrough is told to read itself again; GitHub's steps are shown whenever
 * it sent some; and an ask that got no answer is said.
 */

const BASE: AppChecks = {
  deviceFlow: 'enabled',
  tokenExpiry: 'enabled',
  installed: 'no',
  repository: 'exampleco/api',
  settingsUrl: null,
  installUrl: 'https://github.com/apps/fleetadlc-exampleco/installations/new',
  app: { slug: 'fleetadlc-exampleco', id: 1, installations: 0 },
  privateKeyHeld: true,
  detail: '',
};

let answers: (AppChecks | 'fail')[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next === 'fail') throw new TypeError('Failed to fetch');
      return Response.json(next);
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
});

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function checkAgain(): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((one) => one.textContent === 'check again')!;
  await act(async () => button.click());
  await settle();
}

describe('the install panel', () => {
  it('tells the walkthrough to read itself again when the answer moves, and not otherwise', async () => {
    answers = [BASE, BASE, { ...BASE, installed: 'yes', app: { ...BASE.app!, installations: 1 } }];
    const moved = vi.fn();
    await act(async () => root.render(<AppChecksPanel variant="install" onMoved={moved} />));
    await settle();
    await checkAgain();
    expect(moved).not.toHaveBeenCalled();
    await checkAgain();
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('shows GitHub’s steps for a suspended installation, which still answers installed', async () => {
    answers = [
      {
        ...BASE,
        installed: 'yes',
        fix: {
          need: 'unsuspend',
          title: 'The OpenADLC app is suspended on exampleco',
          detail: '',
          action: { label: 'Open the installation', url: 'https://github.com/organizations/exampleco/settings/installations/88' },
          steps: [{ text: 'Press Unsuspend on the installation’s page', action: { label: 'Open the installation', url: 'https://github.com/organizations/exampleco/settings/installations/88' } }],
        },
      },
    ];
    await act(async () => root.render(<AppChecksPanel variant="install" />));
    await settle();
    expect(container.textContent).toContain('suspended');
    expect(container.textContent).toContain('Press Unsuspend on the installation’s page');
  });

  it('says an ask that got no answer, rather than “Checking with GitHub…” for good', async () => {
    answers = ['fail'];
    await act(async () => root.render(<AppChecksPanel variant="install" />));
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Could not ask GitHub: the bridge is not answering');
  });
});
