// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoSetupView, type RepoPlan } from './repo-setup-step';

const PLAN: RepoPlan = {
  repository: 'acme/one',
  labels: [],
  rules: [],
  templates: [],
  labelChanges: 0,
  ruleChanges: 0,
  canApply: true,
  detail: '',
  approvers: [],
  needsApprovers: true,
};

const ACCOUNTS: Record<string, unknown> = {
  janedoe: { exact: { login: 'janedoe', type: 'User', avatarUrl: '', htmlUrl: 'https://github.com/janedoe' }, suggestions: [], rateLimited: false },
  johndoe: { exact: { login: 'johndoe', type: 'User', avatarUrl: '', htmlUrl: 'https://github.com/johndoe' }, suggestions: [], rateLimited: false },
  acme: { exact: { login: 'acme', type: 'Organization', avatarUrl: '', htmlUrl: 'https://github.com/acme' }, suggestions: [], rateLimited: false },
  janedo: {
    exact: null,
    suggestions: [{ login: 'janedoe', type: 'User', avatarUrl: '', htmlUrl: '' }],
    rateLimited: false,
  },
};

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams.get('q') ?? '';
      if (q === 'unreached') return new Response('bridge unavailable', { status: 502 });
      return new Response(JSON.stringify(ACCOUNTS[q] ?? { exact: null, suggestions: [], rateLimited: false }));
    }),
  );
  const saved: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <RepoSetupView
        plans={[PLAN]}
        runs={{}}
        running={false}
        busy={null}
        done={{}}
        error={null}
        onSetUpAll={() => undefined}
        onApply={() => undefined}
        onApprovers={async (logins) => {
          saved.push(logins);
        }}
      />,
    );
  });
  const input = host.querySelector<HTMLInputElement>('#approvers')!;
  const type = async (text: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Past the lookup's debounce, and its answer.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
  };
  const save = () => [...host.querySelectorAll('button')].find((one) => one.textContent === 'Save')!;
  return { host, type, save, saved };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('who approves, checked on GitHub as it is typed', () => {
  it('finds the person, and saves them', async () => {
    const { host, type, save, saved } = await mount();
    await type('janedoe');
    expect(host.textContent).toContain('✓ on GitHub');
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    expect(saved).toEqual(['janedoe']);
  });

  it('refuses an organization: only a person can approve', async () => {
    const { host, type, save } = await mount();
    await type('acme');
    expect(host.textContent).toContain('only a person can approve a pull request');
    expect(save().disabled).toBe(true);
  });

  it('offers who was probably meant, and says when nobody is called that', async () => {
    const { host, type } = await mount();
    await type('janedo');
    expect(host.textContent).toContain('did you mean');
    expect(host.textContent).toContain('janedoe');
    await type('zzqq');
    expect(host.textContent).toContain('nobody on GitHub is called “zzqq”');
  });

  it('offers to add a name unchecked while GitHub rate-limits the check only when it is a login', async () => {
    ACCOUNTS['jane doe'] = { exact: null, suggestions: [], rateLimited: true };
    ACCOUNTS['janedoe2'] = { exact: null, suggestions: [], rateLimited: true };
    const { host, type } = await mount();
    await type('jane doe');
    expect(host.textContent).not.toContain('unchecked');
    expect(host.textContent).toContain('“jane doe” is not a GitHub username');
    await type('janedoe2');
    expect(host.textContent).toContain('add “janedoe2” unchecked');
  });

  it('offers to add a name unchecked when GitHub could not be asked, rather than saying nobody is called it', async () => {
    ACCOUNTS['janedoe3'] = { exact: null, suggestions: [], rateLimited: false, unavailable: true };
    const { host, type } = await mount();
    await type('janedoe3');
    expect(host.textContent).not.toContain('nobody on GitHub');
    expect(host.textContent).toContain('GitHub did not answer the check.');
    expect(host.textContent).toContain('add “janedoe3” unchecked');
    // The console's own route failing is the same: nothing is known about the name.
    await type('unreached');
    expect(host.textContent).not.toContain('nobody on GitHub');
    expect(host.textContent).toContain('add “unreached” unchecked');
  });

  it('takes several people, as chips', async () => {
    const { host, type, save, saved } = await mount();
    const more = () => [...host.querySelectorAll('button')].find((one) => one.textContent === 'add another person')!;
    await type('janedoe');
    await act(async () => more().click());
    await type('johndoe');
    await act(async () => more().click());
    expect(host.querySelector('[aria-label="Remove janedoe"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Remove johndoe"]')).not.toBeNull();
    await act(async () => save().click());
    expect(saved).toEqual(['janedoe,johndoe']);
  });
});
