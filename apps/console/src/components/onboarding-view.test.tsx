import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { suggestionPath } from './create-account';
import {
  OnboardingView,
  StepTrouble,
  githubAccountsCheckKey,
  reloadUntilGitHubAccountsCheckMoves,
  readySummary,
  startingStep,
  type OnboardingData,
  type StepCheck,
} from './onboarding-view';
import type { AppChecks } from './app-checks';
import type { AccountRef, CrewBot } from '@/lib/model-onboarding';

/**
 * The walkthrough's header as the server renders it, which is also what is on
 * screen until the page's script has run: the progress bar and the "already
 * done" row, and where each of their links goes.
 */

const DATA: OnboardingData = {
  organization: 'acme',
  organizationIsOrg: false,
  repositories: ['acme/widgets'],
  clientIdConfigured: true,
  webhookSecretConfigured: true,
  webhookReady: false,
  operatorEmail: 'op@example.com',
  steps: [],
  bots: [
    {
      // A seat nobody has connected an account to: its name is the seat, and
      // its login is only what the bridge would suggest.
      bot: 'second-reviewer',
      slot: 'second-reviewer',
      // What an older configuration called it. Nothing on the page may say it.
      displayName: 'Grok (second reviewer)',
      role: 'review_second',
      roleLabel: 'second reviewer',
      login: 'fleetadlc-second-reviewer-acme',
      suggestedLogin: 'fleetadlc-second-reviewer-acme',
      suggestedEmail: 'op+fleetadlc-second-reviewer@example.com',
      emailNote: 'plus-addressed to your inbox',
      repositoryRole: 'write',
      accessReason: 'pushes branches',
      accountExists: false,
      connected: false,
      authorizationWorks: null,
      credentialKind: null,
      hasSigningKey: false,
      inRepository: false,
      profile: null,
    },
  ],
  links: {
    signup: 'https://github.com/signup',
    emailSettings: 'https://github.com/settings/emails',
    device: 'https://github.com/login/device',
    newApp: 'https://github.com/settings/apps/new',
    yourApps: 'https://github.com/settings/apps',
    invite: null,
  },
  appSettings: [],
  appPermissions: [],
  webhookEvents: [],
  webhookUrl: 'https://example.test/webhooks/github',
  complete: false,
};

const CHECKS: AppChecks = {
  deviceFlow: 'enabled',
  tokenExpiry: 'enabled',
  installed: 'yes',
  repository: 'acme/widgets',
  settingsUrl: null,
  installUrl: null,
  app: null,
  detail: '',
};

const VERIFIED: AccountRef = {
  id: 'acct-claude',
  provider: 'anthropic',
  kind: 'subscription',
  label: 'Anthropic — Max',
  verifiedAt: '2026-09-24T08:05:00.000Z',
  verifyError: null,
};

/** A thinking bot on no account yet, so the assignment step is still to do. */
const CREW: CrewBot[] = [
  {
    bot: 'second-reviewer',
    slot: 'second-reviewer',
    roleLabel: 'second reviewer',
    engine: 'claude',
    model: 'claude-opus-5',
    modelAccountId: null,
    readiness: null,
  },
];

function page(initialStep?: string | null, data: OnboardingData = DATA): string {
  return renderToStaticMarkup(
    <OnboardingView
      initialEmail="op@example.com"
      initialData={data}
      initialChecks={CHECKS}
      initialAccounts={[VERIFIED]}
      initialCrew={CREW}
      initialStep={initialStep}
    />,
  ).replace(/<!-- -->/g, '');
}

function alreadyDone(html: string): [string, string][] {
  const row = html.slice(html.indexOf('already done:'), html.indexOf('</p>', html.indexOf('already done:')));
  return [...row.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(([, href, text]) => [href!, text!]);
}

describe('the already-done row at the top of the walkthrough', () => {
  it('links each item to its own step, as the progress bar does', () => {
    // Opens on the webhook, the first thing undone.
    const html = page();
    expect(html).toContain('step 4 of 11');

    // Repository and the model accounts are also true, and they come after
    // Webhook, the step on screen. A later step is not listed as done.
    expect(alreadyDone(html)).toEqual([
      ['?step=owner', 'Owner,'],
      ['?step=app', 'App,'],
      ['?step=install', 'Install'],
    ]);
  });

  it('shares its links with the progress bar, one per step, in the order they depend on each other', () => {
    const segments = [...page().matchAll(/<a href="(\?step=[^"]+)" title="([^"]+)"/g)].map(([, href, title]) => [href, title]);

    expect(segments).toEqual([
      ['?step=owner', 'GitHub owner'],
      ['?step=app', 'Create the app'],
      ['?step=install', 'Install the app'],
      ['?step=webhook', 'Webhook'],
      ['?step=repository', 'Repositories'],
      ['?step=github-accounts', 'GitHub accounts'],
      ['?step=models', 'Foundation model accounts / API keys'],
      ['?step=crew', 'Crew'],
      ['?step=access', 'Repository access'],
      ['?step=protect', 'Protect the repositories'],
      ['?step=done', 'Ready'],
    ]);
    expect(page()).toMatch(/<a href="\?step=webhook" title="Webhook" aria-label="[^"]+" aria-current="step"/);
  });

  it('opens on the step a link named, which is where one followed before the script ran arrives', () => {
    const html = page('models');

    expect(html).toContain('step 7 of 11');
    expect(html).toContain('>Foundation model accounts / API keys</h2>');
  });

  it('sends a link from before the reorder to the step that does the same thing', () => {
    expect(page('where')).toContain('>GitHub owner</h2>');
    expect(page('email')).toContain('>GitHub accounts</h2>');
    expect(page('accounts')).toContain('>Foundation model accounts / API keys</h2>');
    expect(page('assignment')).toContain('>Crew</h2>');
    expect(page('finish')).toContain('>Protect the repositories</h2>');
  });

  it('does not count Install as done before the app exists, or before GitHub has said it is installed', () => {
    const noApp = page(null, { ...DATA, clientIdConfigured: false });
    expect(alreadyDone(noApp).map(([href]) => href)).not.toContain('?step=install');

    const unknown = renderToStaticMarkup(
      <OnboardingView
        initialEmail="op@example.com"
        initialData={DATA}
        initialChecks={null}
        initialAccounts={[VERIFIED]}
        initialCrew={CREW}
        initialStep="owner"
      />,
    ).replace(/<!-- -->/g, '');
    expect(alreadyDone(unknown).map(([href]) => href)).not.toContain('?step=install');
  });

  it('does not count Access as done for an organization before its accounts are in the repository', () => {
    // An organization's install ticked Access before any account was connected.
    const nobodyIn = page(null, { ...DATA, organizationIsOrg: true, bots: DATA.bots.map((bot) => ({ ...bot, inRepository: false })) });
    expect(alreadyDone(nobodyIn).map(([href]) => href)).not.toContain('?step=access');

    // Open on the last step, so Access is behind the one on screen. On the
    // first undone step it is still ahead, and a later step is not listed.
    const everyoneIn = page('protect', { ...DATA, organizationIsOrg: true, bots: DATA.bots.map((bot) => ({ ...bot, inRepository: true })) });
    expect(alreadyDone(everyoneIn).map(([href]) => href)).toContain('?step=access');
  });

  it('does not slide the header while the width changes between steps', () => {
    // An eased width moved every link in the header for as long as it ran.
    expect(page()).not.toContain('transition-[max-width]');
  });
});

describe('a step ahead of the one on screen', () => {
  function at(step: string | null, data: OnboardingData, restore: { clean: boolean; setUp: string[] } | null = null): string {
    return renderToStaticMarkup(
      <OnboardingView
        initialEmail="op@example.com"
        initialData={data}
        initialChecks={CHECKS}
        initialAccounts={[VERIFIED]}
        initialCrew={CREW}
        initialStep={step}
        initialRestore={restore}
      />,
    ).replace(/<!-- -->/g, '');
  }

  const segment = (html: string, step: string): string => html.match(new RegExp(`<a href="\\?step=${step}"[^>]*>`))?.[0] ?? '';

  it('leaves the bar unmarked on Start when nothing is set up', () => {
    const html = at(
      'start',
      { ...DATA, organization: null, repositories: [], clientIdConfigured: false, webhookReady: false },
      { clean: true, setUp: [] },
    );

    expect(html).toContain('step 1 of 12');
    expect(html).not.toContain('already done:');
    expect(html).not.toContain('bg-signal/60');
  });

  it('does not mark Owner done while Start is the step on screen', () => {
    const html = at('start', { ...DATA, webhookReady: false }, { clean: true, setUp: [] });

    expect(html).toContain('>Start fresh or restore a backup</h2>');
    expect(html).not.toContain('already done:');
    expect(segment(html, 'owner')).not.toContain('bg-signal/60');
  });

  it('shows Owner once the step on screen is past it, and not Webhook', () => {
    const html = at('app', { ...DATA, webhookReady: true, webhookSecretConfigured: true });

    expect(alreadyDone(html).map(([href]) => href)).toContain('?step=owner');
    expect(alreadyDone(html).map(([href]) => href)).not.toContain('?step=webhook');
    expect(segment(html, 'owner')).toContain('bg-signal/60');
    expect(segment(html, 'webhook')).not.toContain('bg-signal/60');
  });

  it('does not treat a stored address and secret as the webhook being done', () => {
    const html = at('webhook', { ...DATA, webhookReady: true, webhookSecretConfigured: true });

    expect(alreadyDone(html).map(([href]) => href)).not.toContain('?step=webhook');
    expect(html).toContain('skip for now');
    expect(html).not.toContain('>continue<');
  });

  it('shows Webhook as done once a delivery is proved and the step on screen has reached it', () => {
    const proved = {
      ...DATA,
      webhookReady: true,
      checks: { webhook: { done: true, failing: [] } },
    };
    const onIt = at('webhook', proved);
    expect(alreadyDone(onIt).map(([href]) => href)).toContain('?step=webhook');
    expect(onIt).toContain('>continue<');

    const later = at('repository', proved);
    expect(segment(later, 'webhook')).toContain('bg-signal/60');
    expect(alreadyDone(later).map(([href]) => href)).toContain('?step=webhook');
  });
});

describe('where the walkthrough opens', () => {
  const steps = [
    { key: 'where', short: 'organization', title: 'Where does this live?', done: true },
    { key: 'crew', short: 'the crew', title: 'Create and connect the crew', done: false },
    { key: 'accounts', short: 'the accounts', title: 'Add the accounts', done: true },
  ];

  it('is the first thing undone, unless the address names a step', () => {
    expect(startingStep(steps)).toBe(1);
    expect(startingStep(steps, 'accounts')).toBe(2);
    expect(startingStep(steps, 'where')).toBe(0);
  });

  it('ignores a step that does not exist', () => {
    expect(startingStep(steps, 'nonsense')).toBe(1);
    expect(startingStep(steps, '')).toBe(1);
    expect(startingStep(steps, null)).toBe(1);
  });

  it('is told the step by the page, from the address', () => {
    const source = readFileSync(new URL('../app/onboarding/page.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(/initialStep=\{typeof step === 'string' \? step : null\}/);
  });
});

describe('the repository step', () => {
  it('asks for every repository the crew works in, not the one, and says where more are added later', () => {
    const html = page('repository', { ...DATA, repositories: ['acme/widgets', 'acme/api'] });
    expect(html).toMatch(/<h2[^>]*>Repositories<\/h2>/);
    expect(html).toContain('one repository or several');
    expect(html).toContain('More can be added later, and any removed, in Settings under Repositories.');
    // Nothing on it is about a single repository being "the one".
    expect(html).not.toContain('the one OpenADLC works in');
  });
});

describe('the GitHub accounts step', () => {
  it('asks about the first account: make a new one or use one you have', () => {
    const html = page('github-accounts', { ...DATA, githubAccounts: [] });

    expect(html).toContain('>GitHub accounts</h2>');
    expect(html).toContain('<strong>9 accounts recommended</strong>, one per seat');
    expect(html).toContain('<strong>You can start with 2</strong>, which are required');
    expect(html).toContain('Not your personal account');
    expect(html).toContain('Account 1 of 2');
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*Create a new account/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*Use an account I have/);
    // Nothing of either answer until one is given, and no way on before two.
    expect(html).not.toContain('fleetadlc-second-reviewer-acme');
    expect(html).not.toContain('Continue to the next step');
    expect(html).toContain('None yet. Each one you add is listed here.');
    // Going on is one of this step's answers, so the footer offers none.
    expect(html).not.toContain('continue anyway');
    expect(html).not.toContain('you can come back to this');
    expect(html).not.toContain('signing key');
  });

  it('offers to go on once the two required accounts are in, beside adding more', () => {
    const html = page('github-accounts', {
      ...DATA,
      githubAccounts: [
        { login: 'fleetadlc-crew', signIn: 'signed-in', group: null, seats: [] },
        { login: 'fleetadlc-review', signIn: 'signed-in', group: null, seats: [] },
      ],
    });
    expect(html).toContain('Add another account, or go on');
    expect(html).toContain('Continue to the next step');
    // The next step is the model accounts, not the seats.
    expect(html).toContain('An API key or a subscription, checked before a bot can think with it.');
    expect(html).not.toContain('Which seat uses which account.');
    expect(html).toContain('Create a new account');
    expect(html).toContain('Use an account I have');
    expect(html).toContain('Accounts · 2 of 9');
    expect(html).toContain('fleetadlc-review');
  });

  it('does not open on a failure before anything has been asked for', () => {
    const html = page('github-accounts', {
      ...DATA,
      githubAccounts: [],
      checks: {
        'github-accounts': {
          done: false,
          failing: [{ id: 'github-accounts', title: 'No GitHub account is connected', detail: '', severity: 'blocking', action: null, waiting: false }],
        },
      },
    });
    // No red box at the top. The note beside the forward button, which says
    // why it is held, stays.
    expect(html).not.toContain('<p class="font-medium text-body">No GitHub account is connected</p>');
  });

  it('is done once two accounts can still sign in', () => {
    const html = page('protect', {
      ...DATA,
      githubAccounts: [
        { login: 'fleetadlc-crew', signIn: 'signed-in', group: null },
        { login: 'fleetadlc-review', signIn: 'signed-in', group: null },
      ],
    });
    expect(alreadyDone(html).map(([href]) => href)).toContain('?step=github-accounts');
  });

  it('follows the account list when a check from before the connect or disconnect disagrees', () => {
    const two = page('protect', {
      ...DATA,
      githubAccounts: [
        { login: 'fleetadlc-crew', signIn: 'signed-in', group: null },
        { login: 'fleetadlc-review', signIn: 'signed-in', group: null },
      ],
      checks: { 'github-accounts': { done: false, failing: [] } },
    });
    expect(alreadyDone(two).map(([href]) => href)).toContain('?step=github-accounts');

    const one = page(null, {
      ...DATA,
      githubAccounts: [{ login: 'fleetadlc-crew', signIn: 'signed-in', group: null }],
      checks: { 'github-accounts': { done: true, failing: [] } },
    });
    expect(alreadyDone(one).map(([href]) => href)).not.toContain('?step=github-accounts');
  });
});

describe('the username suggested for a seat', () => {
  it('is asked for by the seat’s role, never by what the bot is called', () => {
    expect(suggestionPath(DATA.bots[0]!)).toBe('/api/suggest-login?bot=second-reviewer');
    // A bot an older bridge still calls by a persona is asked for by its role.
    expect(suggestionPath({ bot: 'atlas', role: 'implement', roleLabel: 'builder', connected: false })).toBe(
      '/api/suggest-login?bot=builder',
    );
    expect(suggestionPath({ bot: 'sydney', roleLabel: 'lead reviewer', connected: false })).toBe(
      '/api/suggest-login?bot=lead-reviewer',
    );
  });
});

/**
 * A step is done when the check that proves it passes — the same check that
 * puts a card on the board — and says what fails on it when one does. A new
 * OpenADLC that asks the app for a permission it lacks reopens the app step.
 */
describe('the steps, from the health checks', () => {
  const FAILING_PERMISSION: NonNullable<OnboardingData['checks']> = {
    app: {
      done: false,
      failing: [
        {
          id: 'app-permissions:git_signing_ssh_public_keys',
          title: 'The OpenADLC app does not have “SSH signing keys”',
          detail: 'Add “SSH signing keys” on the app’s permissions page, under Account permissions, as **Read and write**.',
          severity: 'blocking',
          action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-acme/permissions' },
          waiting: false,
        },
        {
          id: 'signing-key:bot-builder',
          title: 'fleetadlc-atlas-acme’s signing key is not on its GitHub account',
          detail: 'Reconnect it.',
          severity: 'blocking',
          action: { label: 'Reconnect fleetadlc-atlas-acme', href: '/settings#github-accounts' },
          waiting: true,
        },
      ],
    },
  };

  it('opens on a step whose check fails, though everything the page knew said it was done', () => {
    const html = page(null, { ...DATA, checks: FAILING_PERMISSION });

    expect(html).toContain('step 2 of 11');
    expect(html).toContain('>Create the app</h2>');
    expect(alreadyDone(html).map(([href]) => href)).not.toContain('?step=app');
  });

  it('says what fails on the step, with its button, and not what waits on it', () => {
    const html = page('app', { ...DATA, checks: FAILING_PERMISSION });

    expect(html).toContain('The OpenADLC app does not have “SSH signing keys”');
    expect(html).toContain('under Account permissions, as <strong class="font-semibold">Read and write</strong>.');
    expect(html).toMatch(/<a href="https:\/\/github.com\/settings\/apps\/fleetadlc-acme\/permissions" target="_blank"[^>]*>Open the app’s permissions/);
    expect(html).not.toContain('signing key is not on its GitHub account');
  });

  it('keeps Crew out of the already-done row while a signing key is missing', () => {
    const html = renderToStaticMarkup(
      <OnboardingView
        initialEmail="op@example.com"
        initialData={{
          ...DATA,
          checks: {
            crew: {
              done: false,
              failing: [
                {
                  id: 'signing-key:bot-builder',
                  title: 'the builder’s signing key is not on its GitHub account',
                  detail: 'Reconnect it.',
                  severity: 'blocking',
                  action: null,
                  waiting: false,
                },
              ],
            },
          },
        }}
        initialChecks={CHECKS}
        initialAccounts={[VERIFIED]}
        initialCrew={[{ ...CREW[0]!, modelAccountId: 'acct-claude' }]}
      />,
    ).replace(/<!-- -->/g, '');
    expect(alreadyDone(html).map(([href]) => href)).not.toContain('?step=crew');
  });

  it('ticks a step a check proves, even before the page has asked for itself', () => {
    const proved = { ...DATA, repositories: ['acme/widgets'], checks: { access: { done: true, failing: [] } } };
    const html = page('protect', proved);
    expect(alreadyDone(html).map(([href]) => href)).toContain('?step=access');
  });
});

describe('what the checks say is wrong on a step', () => {
  const one = (id: string) => ({
    id,
    title: `The ${id} has no GitHub account connected`,
    detail: 'It cannot work until one is.',
    severity: 'blocking' as const,
    action: null,
    waiting: false,
  });

  it('shows a couple as they are', () => {
    const html = renderToStaticMarkup(<StepTrouble check={{ done: false, failing: [one('intake'), one('qa')] }} />);
    expect(html).not.toContain('<details');
    expect(html).toContain('The intake has no GitHub account connected');
  });

  it('folds more than that into one line, so the step that fixes them is not pushed out of sight', () => {
    const html = renderToStaticMarkup(
      <StepTrouble check={{ done: false, failing: ['intake', 'qa', 'sre', 'lead'].map(one) }} />,
    );
    expect(html).toMatch(/^<details/);
    expect(html).toContain('4 things still to do on this step');
  });

  it('shows an optional one in amber, with its steps and links as the board does', () => {
    const html = renderToStaticMarkup(
      <StepTrouble
        check={{
          done: true,
          failing: [
            {
              id: 'app-permissions:checks',
              title: 'Optional: give the OpenADLC app “Checks”',
              detail: '1. Open [Permissions & events](https://github.com/settings/apps/fleetadlc/permissions), choose **Read and write**.\n2. Accept it.',
              severity: 'warning',
              action: null,
              waiting: false,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('border-attention/35');
    expect(html).not.toContain('border-alarm');
    expect(html).toContain('<ol');
    expect(html).toContain('href="https://github.com/settings/apps/fleetadlc/permissions"');
    expect(html).not.toContain('**');
  });
});

describe('reloading after a GitHub account connects or disconnects', () => {
  const row = (title: string): StepCheck => ({
    done: false,
    failing: [
      {
        id: 'github-accounts',
        title,
        detail: 'Connect two accounts.',
        severity: 'blocking',
        action: null,
        waiting: false,
      },
    ],
  });

  it('reads again until the check row changes, and not on a clock of its own', async () => {
    const before = githubAccountsCheckKey({ checks: { 'github-accounts': row('No GitHub account is connected') } });
    const payloads = [
      { checks: { 'github-accounts': row('No GitHub account is connected') } },
      { checks: { 'github-accounts': row('No GitHub account is connected') } },
      { checks: { 'github-accounts': row('Two GitHub accounts are connected') } },
    ];
    let read = 0;
    const waits: number[] = [];
    await reloadUntilGitHubAccountsCheckMoves(
      before,
      async () => payloads[read++] ?? null,
      async (ms) => {
        waits.push(ms);
      },
      { tries: 5, pauseMs: 10 },
    );
    expect(read).toBe(3);
    expect(waits).toEqual([10, 10]);
  });

  it('stops once the check passes and the accounts are ready, though the row did not change', async () => {
    // Two accounts signed in already: a third connecting leaves the row as it was.
    const passing = { checks: { 'github-accounts': { done: true, failing: [] } } };
    const before = githubAccountsCheckKey(passing);
    let read = 0;
    await reloadUntilGitHubAccountsCheckMoves(
      before,
      async () => {
        read += 1;
        return { ...passing, githubAccounts: [{ signIn: 'signed-in' }, { signIn: 'signed-in' }, { signIn: 'signed-in' }] };
      },
      async () => undefined,
    );
    expect(read).toBe(1);
  });

  it('stops after the first read when the check row has already changed', async () => {
    const before = githubAccountsCheckKey({ checks: { 'github-accounts': row('No GitHub account is connected') } });
    let read = 0;
    const waits: number[] = [];
    await reloadUntilGitHubAccountsCheckMoves(
      before,
      async () => {
        read += 1;
        return { checks: { 'github-accounts': row('Only one GitHub account is connected') } };
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(read).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe('the Ready step', () => {
  it('says what is set up — the owner, the repositories, the accounts — and links what is still open', () => {
    const lines = readySummary(DATA, [
      { key: 'start', title: 'Start fresh or restore a backup', done: true },
      { key: 'owner', title: 'GitHub owner', done: true },
      { key: 'repository', title: 'Repositories', done: true },
      { key: 'github-accounts', title: 'GitHub accounts', done: false },
      { key: 'crew', title: 'Crew', done: false },
      { key: 'done', title: 'Ready', done: false },
    ]);
    expect(lines).toEqual([
      { key: 'owner', title: 'GitHub owner', done: true, fact: 'acme' },
      { key: 'repository', title: 'Repositories', done: true, fact: 'acme/widgets' },
      { key: 'github-accounts', title: 'GitHub accounts', done: false, fact: '' },
      { key: 'crew', title: 'Crew', done: false, fact: '0 of 1 seats on an account' },
    ]);

    const html = page('done');
    expect(html).toContain('GitHub owner<span class="text-muted"> — acme</span>');
    expect(html).toContain('Repositories<span class="text-muted"> — acme/widgets</span>');
    expect(html).toMatch(/href="\?step=github-accounts"[^>]*>GitHub accounts<\/a>/);
  });

  it('counts the GitHub accounts signed in, not the seats on one, which Crew decides', () => {
    // Two accounts connected and Crew still open said "GitHub accounts ✓ — 0 of 9 connected".
    const accounts = [
      { login: 'fleetadlc-crew-acme', signIn: 'signed-in' as const, group: null },
      { login: 'fleetadlc-review-acme', signIn: 'signed-in' as const, group: null },
    ];
    const lines = readySummary({ ...DATA, githubAccounts: accounts }, [
      { key: 'github-accounts', title: 'GitHub accounts', done: true },
      { key: 'crew', title: 'Crew', done: false },
    ]);
    expect(lines.map((line) => line.fact)).toEqual(['2 connected', '0 of 1 seats on an account']);
  });

  it('says the crew works as the accounts connected, not one account per bot', () => {
    // It said each bot was its own account, from before seats in a group
    // shared one, which is the setup the walkthrough asks for.
    const text = page('done', { ...DATA, complete: true }).replace(/<[^>]+>/g, '');
    expect(text).toContain('File the first request from the board; from here the crew works on GitHub as the accounts you connected.');
    expect(text).not.toContain('its own account');
  });
});

describe('a step that asks its own way forward', () => {
  it('says device flow is off on the GitHub accounts step, where connecting needs it', () => {
    const html = renderToStaticMarkup(
      <OnboardingView
        initialEmail="op@example.com"
        initialData={DATA}
        initialChecks={{ ...CHECKS, deviceFlow: 'disabled' }}
        initialAccounts={[VERIFIED]}
        initialCrew={CREW}
        initialStep="github-accounts"
      />,
    );
    expect(html).toContain('device flow is off — turn it on in “Create the app” first');
  });
});

