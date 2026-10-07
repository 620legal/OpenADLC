// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { accountHeading, GitHubAccountsStep, githubAccountsReady, nextSeatToCreate, prefillGitHubAccounts } from './github-accounts-step';
import type { GitHubAccountsView } from '@/lib/api';

// The bridge derives an account's group from the seats on it, so a grouped
// account always has one: here the QA and the second reviewer, which leave
// the builder and the lead reviewer to fill.
const VIEW: GitHubAccountsView = {
  accounts: [
    {
      login: 'fleetadlc-crew',
      url: 'https://github.com/fleetadlc-crew',
      group: 'crew',
      signIn: 'signed-in',
      seats: [{ name: 'qa', slot: 'qa', role: 'qa', roleLabel: 'QA' }],
    },
    {
      login: 'fleetadlc-review',
      url: 'https://github.com/fleetadlc-review',
      group: 'reviewers',
      signIn: 'signed-in',
      seats: [{ name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', roleLabel: 'second reviewer' }],
    },
  ],
  bots: [
    {
      name: 'builder',
      slot: 'builder',
      role: 'implement',
      roleLabel: 'builder',
      group: 'crew',
      login: null,
      choices: [
        { login: 'fleetadlc-crew', refusal: null },
        { login: 'fleetadlc-review', refusal: 'the reviewers’ account (the lead reviewer uses it) — the crew needs a different one' },
      ],
    },
    {
      name: 'lead-reviewer',
      slot: 'lead-reviewer',
      role: 'review_lead',
      roleLabel: 'lead reviewer',
      group: 'reviewers',
      login: null,
      choices: [
        { login: 'fleetadlc-crew', refusal: 'used by the builder — reviewers need their own account' },
        { login: 'fleetadlc-review', refusal: null },
      ],
    },
  ],
};

/** The first run: two accounts just connected, no seat on either, so the bridge gives neither a group. */
const FRESH: GitHubAccountsView = {
  accounts: [
    { login: 'fleetadlc-one', url: 'https://github.com/fleetadlc-one', group: null, signIn: 'signed-in', seats: [] },
    { login: 'fleetadlc-two', url: 'https://github.com/fleetadlc-two', group: null, signIn: 'signed-in', seats: [] },
  ],
  bots: VIEW.bots.map((bot) => ({
    ...bot,
    choices: [
      { login: 'fleetadlc-one', refusal: null },
      { login: 'fleetadlc-two', refusal: null },
    ],
  })),
};

function chosen(container: HTMLElement, label: string): string | undefined {
  return container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)?.value;
}

describe('prefilled GitHub accounts', () => {
  it('uses each group’s one account', () => {
    const filled = prefillGitHubAccounts(VIEW.bots, VIEW.accounts);
    expect(filled.byBot).toEqual({ builder: 'fleetadlc-crew', 'lead-reviewer': 'fleetadlc-review' });
  });

  it('is not done on one working sign-in', () => {
    expect(githubAccountsReady([{ signIn: 'signed-in' }, { signIn: 'needs-reconnecting' }])).toBe(false);
  });
});

describe('disconnecting an account from the walkthrough', () => {
  it('confirms, and offers it only for an account no seat uses', () => {
    const html = renderToStaticMarkup(
      <GitHubAccountsStep
        email="op@example.com"
        signupUrl="https://github.com/signup"
        emailSettingsUrl="https://github.com/settings/emails"
        accounts={[
          { login: 'fleetadlc-crew', signIn: 'signed-in', group: 'crew', seats: [{ name: 'builder' }] },
          { login: 'fleetadlc-spare', signIn: 'signed-in', group: null, seats: [] },
        ]}
        settings={null}
        save={async () => undefined}
        onEmail={() => undefined}
        onChanged={() => undefined}
      />,
    );
    expect(html).toContain('move this bot to another account under Crew first');
    expect(html.match(/Disconnect/g)).toEqual(['Disconnect']);
  });

  it('does not disconnect when the confirm is cancelled', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // Stubbed rather than spied on: happy-dom's window leaves `confirm` undefined
    // under vitest 4, and spyOn refuses what is not a function.
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await act(async () => {
      root.render(
        <GitHubAccountsStep
          email="op@example.com"
          signupUrl="https://github.com/signup"
          emailSettingsUrl="https://github.com/settings/emails"
          accounts={[{ login: 'fleetadlc-spare', signIn: 'signed-in', group: null, seats: [] }]}
          settings={null}
          save={async () => undefined}
          onEmail={() => undefined}
          onChanged={() => undefined}
        />,
      );
    });
    const button = [...container.querySelectorAll('button')].find((el) => el.textContent === 'Disconnect');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(confirm).toHaveBeenCalledWith(
      'Disconnect fleetadlc-spare? OpenADLC forgets its sign-in; using it again means connecting it again.',
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/github/accounts/disconnect'),
      expect.anything(),
    );
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});

describe('one account at a time', () => {
  const seats = [
    { seat: 'intake', label: 'intake', suggestedLogin: 'fleetadlc-intake-acme', suggestedEmail: 'op+fleetadlc-intake@example.com', connectedLogin: null },
    { seat: 'builder', label: 'builder', suggestedLogin: 'fleetadlc-builder-acme', suggestedEmail: 'op+fleetadlc-builder@example.com', connectedLogin: null },
    { seat: 'lead-reviewer', label: 'lead reviewer', suggestedLogin: 'fleetadlc-lead-reviewer-acme', suggestedEmail: 'op+fleetadlc-lead-reviewer@example.com', connectedLogin: null },
  ];

  it('makes the builder first and the lead reviewer second, the two that are required, then the rest in order', () => {
    expect(nextSeatToCreate(seats, [])?.seat).toBe('builder');
    expect(nextSeatToCreate(seats, ['fleetadlc-builder-acme'])?.seat).toBe('lead-reviewer');
    expect(nextSeatToCreate(seats, ['fleetadlc-builder-acme', 'FleetADLC-Lead-Reviewer-Acme'])?.seat).toBe('intake');
    expect(nextSeatToCreate(seats, ['fleetadlc-builder-acme', 'fleetadlc-lead-reviewer-acme', 'fleetadlc-intake-acme'])).toBeNull();
  });

  it('passes over a seat whose account was made under another name the page suggests', () => {
    expect(nextSeatToCreate(seats, ['acme-fleetadlc-builder'])?.seat).toBe('lead-reviewer');
  });

  it('forgets the password made for a seat once an account connects, and when the step goes', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const step = (accounts: { login: string; signIn: 'signed-in'; group: null }[]) => (
      <GitHubAccountsStep
        email="op@example.com"
        signupUrl="https://github.com/signup"
        emailSettingsUrl="https://github.com/settings/emails"
        accounts={accounts}
        seats={seats}
        settings={null}
        save={async () => undefined}
        onEmail={() => undefined}
        onChanged={() => undefined}
      />
    );
    sessionStorage.setItem('fleetadlc.signup-password.builder', 'generated-for-the-builder');
    sessionStorage.setItem('fleetadlc.signup-password.lead-reviewer', 'generated-for-the-lead');
    await act(async () => root.render(step([])));
    // The builder's form is open; its account connects under the name it was given.
    await act(async () => root.render(step([{ login: 'fleetadlc-builder-acme', signIn: 'signed-in', group: null }])));
    expect(sessionStorage.getItem('fleetadlc.signup-password.builder')).toBeNull();
    expect(sessionStorage.getItem('fleetadlc.signup-password.lead-reviewer')).toBe('generated-for-the-lead');

    act(() => root.unmount());
    expect(sessionStorage.getItem('fleetadlc.signup-password.lead-reviewer')).toBeNull();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('says which account it is asking about, and whether it is needed', () => {
    expect(accountHeading(0, 9)).toEqual({ title: 'Account 1 of 2', note: 'Required: the account that does the work.' });
    expect(accountHeading(1, 9)).toEqual({ title: 'Account 2 of 2', note: 'Required: the account that approves the work.' });
    expect(accountHeading(2, 9)).toEqual({ title: 'Account 3', note: 'Optional. 9 are recommended, one per seat.' });
  });

  async function render(accounts: { login: string; signIn: 'signed-in'; group: null; seats: [] }[], onContinue = vi.fn()) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <GitHubAccountsStep
          email="op@example.com"
          signupUrl="https://github.com/signup"
          emailSettingsUrl="https://github.com/settings/emails"
          accounts={accounts}
          seats={seats}
          settings={null}
          save={async () => undefined}
          onEmail={() => undefined}
          onChanged={() => undefined}
          onContinue={onContinue}
        />,
      );
    });
    const click = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.startsWith(label));
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    };
    const done = () => {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    };
    return { container, click, done, onContinue };
  }

  it('shows what to sign up with for the next seat only, once a new account is chosen', async () => {
    const { container, click, done } = await render([]);
    await click('Create a new account');
    expect(container.textContent).toContain('fleetadlc-builder-acme');
    expect(container.textContent).not.toContain('fleetadlc-lead-reviewer-acme');
    expect(container.textContent).toContain('Connect it');
    done();
  });

  it('shows only the connect button for an account you have', async () => {
    const { container, click, done } = await render([]);
    await click('Use an account I have');
    expect(container.textContent).not.toContain('fleetadlc-builder-acme');
    expect(container.textContent).toContain('Connect it');
    done();
  });

  it('goes on to the next step as its third answer, once two accounts are in', async () => {
    const two = [
      { login: 'one', signIn: 'signed-in' as const, group: null, seats: [] as [] },
      { login: 'two', signIn: 'signed-in' as const, group: null, seats: [] as [] },
    ];
    const { click, done, onContinue } = await render(two);
    await click('Continue to the next step');
    expect(onContinue).toHaveBeenCalledOnce();
    done();
  });
});
