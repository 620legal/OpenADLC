// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAccountsView } from '@/lib/api';
import { GitHubAccountsCard, GitHubAccountsPanel, accountGroupText } from './github-accounts-card';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

/**
 * Settings' connected accounts: each GitHub account OpenADLC holds and managing
 * the connection to it — connecting one for no bot, reconnecting, and
 * disconnecting one no bot uses. Which bot uses which is the crew's.
 */

const seat = (name: string, slot: string, role: string, roleLabel: string) => ({ name, slot, role, roleLabel });

const VIEW: GitHubAccountsView = {
  accounts: [
    {
      login: 'exampleco-crew',
      url: 'https://github.com/exampleco-crew',
      group: 'crew',
      signIn: 'signed-in',
      seats: [seat('builder', 'builder', 'implement', 'builder'), seat('qa', 'qa', 'qa', 'QA')],
    },
    {
      login: 'exampleco-old',
      url: 'https://github.com/exampleco-old',
      group: 'crew',
      signIn: 'needs-reconnecting',
      seats: [seat('automation', 'automation', 'automation', 'automation')],
    },
    {
      login: 'janedoe-review',
      url: 'https://github.com/janedoe-review',
      group: 'reviewers',
      signIn: 'signed-in',
      seats: [seat('janedoe-review', 'lead-reviewer', 'review_lead', 'lead reviewer')],
    },
  ],
  bots: [
    {
      ...seat('builder', 'builder', 'implement', 'builder'),
      group: 'crew',
      login: 'exampleco-crew',
      choices: [
        { login: 'exampleco-crew', refusal: null },
        { login: 'exampleco-old', refusal: 'its sign-in stopped working — reconnect it first' },
        { login: 'janedoe-review', refusal: 'the reviewers’ account (the lead reviewer uses it) — the crew needs a different one' },
      ],
    },
    {
      ...seat('janedoe-review', 'lead-reviewer', 'review_lead', 'lead reviewer'),
      group: 'reviewers',
      login: 'janedoe-review',
      choices: [
        { login: 'exampleco-crew', refusal: 'used by the builder — reviewers need their own account' },
        { login: 'exampleco-old', refusal: 'used by the automation — reviewers need their own account' },
        { login: 'janedoe-review', refusal: null },
      ],
    },
    {
      ...seat('second-reviewer', 'second-reviewer', 'review_second', 'second reviewer'),
      group: 'reviewers',
      login: null,
      choices: [
        { login: 'exampleco-crew', refusal: 'used by the builder — reviewers need their own account' },
        { login: 'exampleco-old', refusal: 'used by the automation — reviewers need their own account' },
        { login: 'janedoe-review', refusal: null },
      ],
    },
  ],
};

const html = () => renderToStaticMarkup(<GitHubAccountsPanel view={VIEW} />).replace(/<!-- -->/g, '');
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');


/** An account connected in settings that no bot uses yet. */
const SPARE = { login: 'exampleco-spare', url: 'https://github.com/exampleco-spare', group: null, signIn: 'signed-in' as const, seats: [] };
const withSpare = () =>
  renderToStaticMarkup(<GitHubAccountsPanel view={{ ...VIEW, accounts: [...VIEW.accounts, SPARE] }} />).replace(/<!-- -->/g, '');

describe('the connected accounts', () => {
  it('lists each account with a link to it, its sign-in, the group it serves, its bots and a way to reconnect it', () => {
    const accounts = /<ul aria-label="GitHub accounts OpenADLC holds"[\s\S]*?<\/ul>/.exec(html())?.[0] ?? '';
    expect(accounts).toContain('href="https://github.com/exampleco-crew"');
    const said = text(accounts);
    expect(said).toContain('exampleco-crew Signed in Crew account Used by Builder, QA Reconnect');
    expect(said).toContain('exampleco-old Needs reconnecting Crew account Used by Automation Reconnect');
    expect(said).toContain('janedoe-review Signed in Reviewer account Used by Lead reviewer Reconnect');
  });

  it('manages only the connection: no bot is put on an account here', () => {
    expect(html()).not.toContain('<select');
    expect(text(html())).not.toContain('Which bot');
  });

  it('offers to disconnect an account no bot uses, and says what an account in use needs first', () => {
    const said = text(withSpare());
    expect(said).toContain('exampleco-spare Signed in Not used by any bot Reconnect Disconnect');
    expect(said).toContain('exampleco-crew Signed in Crew account Used by Builder, QA Reconnect To disconnect it, move these bots to another account under Crew first.');
    expect(said).toContain('Used by Automation Reconnect To disconnect it, move this bot to another account under Crew first.');
    expect((withSpare().match(/>Disconnect</g) ?? []).length).toBe(1);
  });

  it('connects a new account for no bot', () => {
    const connect = text(/Connect a GitHub account[\s\S]*$/.exec(html())?.[0] ?? '');
    expect(connect).toContain('Connect a GitHub account Connect');
    expect(connect).toContain('It is connected for no bot; put bots on it under Crew.');
  });

  it('shows the code while GitHub waits for it', () => {
    const waiting = renderToStaticMarkup(
      <GitHubAccountsPanel view={VIEW} connecting={{ key: 'new', who: 'the account you want OpenADLC to hold', state: 'waiting', flowId: 'f1', userCode: 'ABCD-1234' }} />,
    );
    expect(text(waiting)).toContain('Sign in to GitHub as the account you want OpenADLC to hold');
    expect(waiting).toContain('ABCD-1234');
  });

  it('says so when OpenADLC holds no account yet, and when the bridge did not answer', () => {
    expect(text(renderToStaticMarkup(<GitHubAccountsPanel view={{ accounts: [], bots: VIEW.bots }} />))).toContain(
      'OpenADLC holds no GitHub account yet. Connect one below.',
    );
    const card = renderToStaticMarkup(<GitHubAccountsCard view={null} />);
    expect(card).toContain('id="github-accounts"');
    expect(text(card)).toContain('The bridge did not say which accounts OpenADLC holds just now. Reload to try again.');
  });

  it('names what an account serves', () => {
    expect(accountGroupText('crew')).toBe('Crew account');
    expect(accountGroupText('reviewers')).toBe('Reviewer account');
    expect(accountGroupText(null)).toBe('Not used by any bot');
  });
});

describe('a reconnect, once GitHub has approved the code', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  /** A person's account the bridge now holds for no bot, as the refreshed view lists it. */
  const PERSON = { login: 'janedoe', url: 'https://github.com/janedoe', group: null, signIn: 'signed-in' as const, seats: [] };

  /**
   * The card with the bridge answering: a code for the connect, then `answer`
   * for its poll. Returns what was sent and the card's text.
   */
  async function approved(
    start: (container: HTMLElement) => HTMLButtonElement,
    answer: Record<string, unknown>,
    view: GitHubAccountsView = VIEW,
  ): Promise<{ container: HTMLElement; sent: { url: string; body: unknown }[]; unmount: () => void }> {
    vi.useFakeTimers();
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url === '/api/github/accounts/connect') return json({ flowId: 'f1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
        if (url === '/api/github/accounts/connect/f1') return json(answer);
        return json({});
      }),
    );
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<GitHubAccountsCard view={view} />));
    await act(async () => start(container).click());
    await act(async () => vi.advanceTimersByTimeAsync(2_600));
    return { container, sent, unmount: () => act(() => root.unmount()) };
  }

  /** A row's Reconnect, by the row's login. */
  const reconnect = (login: string) => (container: HTMLElement) => {
    const row = [...container.querySelectorAll('li')].find((one) => one.querySelector('a')?.textContent === login);
    const found = [...(row?.querySelectorAll('button') ?? [])].find((one) => one.textContent === 'Reconnect');
    if (!found) throw new Error(`no Reconnect for ${login}`);
    return found;
  };
  const connectNew = (container: HTMLElement) => {
    const found = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Connect');
    if (!found) throw new Error('no Connect');
    return found;
  };
  const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((one) => one.textContent === label);

  it('says Reconnected when the row’s own account approved it, whatever its case', async () => {
    const { container, unmount } = await approved(reconnect('exampleco-old'), { state: 'connected', login: 'ExampleCo-Old' });
    expect(container.textContent).toContain('Reconnected as ExampleCo-Old.');
    expect(container.textContent).not.toContain('Put a bot on it under Crew.');
    unmount();
  });

  it('names both accounts when another one approved it, and leaves the row needing reconnecting', async () => {
    const { container, sent, unmount } = await approved(
      reconnect('exampleco-old'),
      { state: 'connected', login: 'janedoe' },
      { ...VIEW, accounts: [...VIEW.accounts, PERSON] },
    );
    const said = container.textContent ?? '';
    expect(said).toContain(
      'GitHub approved the code as janedoe, not exampleco-old. exampleco-old still needs reconnecting: sign in to GitHub as exampleco-old and try again.',
    );
    expect(said).not.toContain('Connected as');
    expect(said).not.toContain('Reconnected');
    // The row's sign-in is the bridge's, not the card's.
    const row = [...container.querySelectorAll('li')].find((one) => one.querySelector('a')?.textContent === 'exampleco-old');
    expect(row?.textContent).toContain('Needs reconnecting');
    expect(button(container, 'Try again')).toBeDefined();

    await act(async () => button(container, 'Disconnect janedoe')?.click());
    expect(sent.at(-1)).toEqual({ url: '/api/github/accounts/disconnect', body: { login: 'janedoe' } });
    unmount();
  });

  it('offers no Disconnect for the account that approved it when a bot uses that account', async () => {
    const { container, unmount } = await approved(reconnect('exampleco-old'), { state: 'connected', login: 'exampleco-crew' });
    expect(container.textContent).toContain('GitHub approved the code as exampleco-crew, not exampleco-old.');
    expect(button(container, 'Try again')).toBeDefined();
    expect(button(container, 'Disconnect exampleco-crew')).toBeUndefined();
    unmount();
  });

  it('reports any account for Connect a GitHub account, as before', async () => {
    const { container, unmount } = await approved(connectNew, { state: 'connected', login: 'janedoe' });
    expect(container.textContent).toContain('Connected as janedoe. Put a bot on it under Crew.');
    expect(container.textContent).not.toContain('GitHub approved the code as');
    unmount();
  });

  it('shows the bridge’s refusal under the row it was started from', async () => {
    const refusal = 'janedoe is one of this install’s people — sign in to GitHub as the bot’s own account and enter a new code.';
    const { container, unmount } = await approved(reconnect('exampleco-old'), { state: 'failed', error: refusal });
    const row = [...container.querySelectorAll('li')].find((one) => one.querySelector('a')?.textContent === 'exampleco-old');
    expect(row?.textContent).toContain(refusal);
    unmount();
  });
});
