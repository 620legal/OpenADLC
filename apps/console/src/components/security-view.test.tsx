// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecurityAlertsView } from '@/lib/api';
import { SecurityBody } from './security-view';

vi.mock('@/app/actions', () => ({ fileRequest: vi.fn(async () => ({ ok: true, bot: 'intake', queued: false, position: null })) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }));

const VIEW: SecurityAlertsView = {
  readAt: '2026-11-26T00:00:00Z',
  repos: [
    {
      repo: 'app',
      fullName: 'acme/app',
      types: {
        dependabot: {
          state: 'read',
          truncated: true,
          alerts: [
            {
              type: 'dependabot',
              repo: 'app',
              number: 3,
              title: '<b>Prototype pollution</b> in lodash',
              severity: 'high',
              url: 'https://github.com/acme/app/security/dependabot/3',
              createdAt: '2026-11-01T00:00:00Z',
              where: 'lodash (npm)',
            },
          ],
        },
        'code-scanning': { state: 'read', alerts: [], truncated: false },
        'secret-scanning': { state: 'admins-only' },
      },
    },
    {
      repo: 'web',
      fullName: 'acme/web',
      types: {
        dependabot: { state: 'off' },
        'code-scanning': { state: 'unreadable', permission: 'Code scanning alerts' },
        'secret-scanning': { state: 'failed', reason: 'GitHub answered 502' },
      },
    },
    {
      repo: 'docs',
      fullName: 'acme/docs',
      types: { dependabot: { state: 'not-installed' }, 'code-scanning': { state: 'not-installed' }, 'secret-scanning': { state: 'not-installed' } },
    },
  ],
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(filters: { repo: string | null; severity: 'high' | 'low' | null } = { repo: null, severity: null }): Promise<void> {
  await act(async () => root.render(<SecurityBody view={VIEW} repos={['app', 'web', 'docs']} filters={filters} />));
}

const block = (repo: string, type: string) => container.querySelector(`section[aria-label="${repo}"] [data-alert-type="${type}"]`)!;

describe('the Security page', () => {
  it('groups by repository, then type, and draws GitHub’s text as text', async () => {
    await render();
    expect([...container.querySelectorAll('section')].map((one) => one.getAttribute('aria-label'))).toEqual(['app', 'web', 'docs']);
    const row = container.querySelector('[data-alert="dependabot:3"]')!;
    expect(row.textContent).toContain('<b>Prototype pollution</b> in lodash');
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('[data-severity]')?.textContent).toBe('High');
    const link = row.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/security/dependabot/3');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(block('app', 'dependabot').textContent).toContain('Only the first 1,000 are shown');
  });

  it('says why a type lists nothing, without failing the page', async () => {
    await render();
    expect(block('app', 'code-scanning').textContent).toContain('No open alerts');
    expect(block('app', 'secret-scanning').textContent).toContain('Shown to admins');
    expect(block('web', 'dependabot').textContent).toContain('Not switched on for this repository');
    expect(block('web', 'code-scanning').textContent).toContain('Not readable: the app needs “Code scanning alerts” (Read-only).');
    expect(block('web', 'code-scanning').querySelector('a')?.getAttribute('href')).toBe('/needs-you');
    expect(block('web', 'secret-scanning').textContent).toContain('GitHub answered 502');
    expect(block('docs', 'dependabot').textContent).toContain('The app is not installed here');
  });

  it('filters by repository and severity through the URL', async () => {
    await render({ repo: 'app', severity: 'low' });
    expect([...container.querySelectorAll('section')].map((one) => one.getAttribute('aria-label'))).toEqual(['app']);
    expect(container.querySelector('[data-alert="dependabot:3"]')).toBeNull();
    expect(block('app', 'dependabot').textContent).toContain('No open alerts of low');
    const severity = container.querySelector('[role="group"][aria-label="Severity"]')!;
    expect(severity.querySelector('[aria-current="true"]')?.textContent).toBe('Low');
    expect([...severity.querySelectorAll('a')].find((one) => one.textContent === 'High')?.getAttribute('href')).toBe('/security?repo=app&severity=high');
  });

  it('opens the new-request dialog prefilled from the alert on File as task', async () => {
    await render();
    const file = [...container.querySelectorAll('button')].find((one) => one.textContent === 'File as task')!;
    await act(async () => file.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    const [text, details] = [...dialog.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    expect(text!.value).toBe('Fix the Dependabot alert “<b>Prototype pollution</b> in lodash” in app');
    expect(details!.value).toContain('On GitHub: https://github.com/acme/app/security/dependabot/3');
    expect((dialog.querySelector('select') as HTMLSelectElement).value).toBe('app');
  });
});
