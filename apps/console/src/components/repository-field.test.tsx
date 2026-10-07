import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InstallationsView, ReachFix } from '@/lib/app-reach';
import { allowWarning, byAccount, RepositoryField, WaitingForApp, type Available } from './repository-field';

/**
 * Choosing the repositories the crew works in, in the walkthrough and in
 * settings. It took one and replaced it with the next one picked; each one
 * picked is now added beside the others.
 */

const REACHABLE: Available[] = [
  { fullName: 'janedoe/fleetadlc-testbed', private: true, defaultBranch: 'main' },
  { fullName: 'janedoe/api', private: false, defaultBranch: 'main' },
  { fullName: 'janedoe/website', private: false, defaultBranch: 'main' },
];

function picker(added: string[], installUrl: string | null = 'https://github.com/apps/fleetadlc/installations/new'): string {
  return renderToStaticMarkup(
    <RepositoryField added={added} installUrl={installUrl} onAdded={() => undefined} initial={{ repositories: REACHABLE }} />,
  ).replace(/<!-- -->/g, '');
}

/** Each row: the repository, and what the row says or offers. */
function rows(html: string): string[] {
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => {
    const text = match[1]!.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const kind = match[1]!.startsWith('<button') ? 'button: ' : match[1]!.startsWith('<label') ? 'checkbox: ' : '';
    return `${kind}${text}`;
  });
}

describe('the repositories the app can reach', () => {
  it('says which ones OpenADLC already works in — several at once — and offers a box to tick for each of the rest', () => {
    expect(rows(picker(['janedoe/fleetadlc-testbed', 'janedoe/website']))).toEqual([
      'janedoe/fleetadlc-testbed private OpenADLC works here',
      'checkbox: janedoe/api',
      'janedoe/website OpenADLC works here',
    ]);
  });

  it('can tick them all, or none, rather than adding one at a time', () => {
    const html = picker([]);
    expect(html).toContain('Select all');
    expect(html).toContain('Select none');
  });

  it('offers no selection once OpenADLC works in every one it can reach', () => {
    expect(picker(['janedoe/fleetadlc-testbed', 'janedoe/api', 'janedoe/website'])).not.toContain('Select all');
  });

  it('knows one already added whatever case GitHub or a person wrote it in', () => {
    expect(rows(picker(['Janedoe/API']))[1]).toBe('janedoe/api OpenADLC works here');
  });

  it('offers every one when there are none yet', () => {
    expect(rows(picker([])).every((row) => row.startsWith('checkbox: '))).toBe(true);
  });

  it('points to where the app is given another, for the one that is not listed', () => {
    const html = picker(['janedoe/api']);
    expect(html).toContain('href="https://github.com/apps/fleetadlc/installations/new"');
    expect(html).toContain('give the app another repository');
  });

  it('keeps a way to type one the list does not have', () => {
    expect(picker([])).toContain('aria-label="Repository, as owner/name"');
  });
});

/** The install this was found on: the app private to janedoe, and OpenADLC told to work in exampleco/infra. */
const INSTALLATIONS: InstallationsView = {
  app: {
    slug: 'fleetadlc-janedoe',
    name: 'OpenADLC (janedoe)',
    owner: { login: 'janedoe', type: 'User' },
    visibility: 'private',
    settingsUrl: 'https://github.com/settings/apps/fleetadlc-janedoe',
    advancedUrl: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced',
    installUrl: 'https://github.com/apps/fleetadlc-janedoe/installations/new',
  },
  accounts: [
    {
      login: 'janedoe',
      type: 'User',
      id: 700,
      installUrl: 'https://github.com/settings/installations/7',
      installation: { id: 7, selection: 'all', settingsUrl: 'https://github.com/settings/installations/7', suspended: false },
      repositories: ['fleetadlc-testbed'],
      fix: null,
    },
    {
      login: 'exampleco',
      type: 'Organization',
      id: 4242,
      installUrl: 'https://github.com/apps/fleetadlc-janedoe/installations/new/permissions?target_id=4242',
      installation: null,
      repositories: ['infra'],
      fix: null,
    },
  ],
  reason: '',
};

describe('the repositories the app can reach, by account', () => {
  const html = renderToStaticMarkup(
    <RepositoryField added={['janedoe/fleetadlc-testbed']} onAdded={() => undefined} initial={{ repositories: REACHABLE, installations: INSTALLATIONS }} />,
  ).replace(/<!-- -->/g, '');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('heads each account’s with what the app has of it, and where to choose more', () => {
    expect(text).toContain('janedoe personal · all repositories Choose repositories ↗');
    expect(html).toContain('href="https://github.com/settings/installations/7"');
    expect(rows(html)).toEqual(['janedoe/fleetadlc-testbed private OpenADLC works here', 'checkbox: janedoe/api', 'checkbox: janedoe/website']);
  });

  it('says to install it on the account OpenADLC works in that it is not on, past GitHub’s account picker — made public first, being private to another', () => {
    expect(text).toContain('Not listed? Install the app on exampleco ↗ and come back');
    expect(html).toContain('href="https://github.com/apps/fleetadlc-janedoe/installations/new/permissions?target_id=4242"');
    expect(html).not.toContain('href="https://github.com/apps/fleetadlc-janedoe/installations/new"');
    expect(text).toContain(
      'It is private to janedoe, and GitHub installs a private app only on the account that owns it: make it public ↗ before installing it on exampleco.',
    );
    expect(html).toContain('href="https://github.com/settings/apps/fleetadlc-janedoe/advanced"');
  });

  it('puts each repository under its own account, the app’s own first, and one GitHub did not name under its owner', () => {
    const grouped = byAccount(
      [
        { fullName: 'exampleco/infra', private: true, defaultBranch: 'main' },
        { fullName: 'janedoe/fleetadlc-testbed', private: true, defaultBranch: 'main' },
        { fullName: 'acme/api', private: false, defaultBranch: 'main' },
      ],
      INSTALLATIONS.accounts,
    );
    expect(grouped.map((group) => [group.owner, group.account?.login ?? null, group.repositories.map((one) => one.fullName)])).toEqual([
      ['janedoe', 'janedoe', ['janedoe/fleetadlc-testbed']],
      ['exampleco', 'exampleco', ['exampleco/infra']],
      ['acme', null, ['acme/api']],
    ]);
  });
});

/** The live install: the app private to the organization exampleco, and installed there. */
const OWN_ORGANIZATION: InstallationsView = {
  app: {
    slug: 'fleetadlc-exampleco',
    name: 'OpenADLC (exampleco)',
    owner: { login: 'exampleco', type: 'Organization' },
    visibility: 'private',
    settingsUrl: 'https://github.com/organizations/exampleco/settings/apps/fleetadlc-exampleco',
    advancedUrl: 'https://github.com/organizations/exampleco/settings/apps/fleetadlc-exampleco/advanced',
    installUrl: 'https://github.com/apps/fleetadlc-exampleco/installations/new',
  },
  accounts: [
    {
      login: 'exampleco',
      type: 'Organization',
      id: 4242,
      installUrl: 'https://github.com/organizations/exampleco/settings/installations/88',
      installation: {
        id: 88,
        selection: 'selected',
        settingsUrl: 'https://github.com/organizations/exampleco/settings/installations/88',
        suspended: false,
      },
      repositories: [],
      fix: null,
    },
  ],
  reason: '',
};

describe('more repositories, where the account is known', () => {
  const EXAMPLECO: Available[] = [{ fullName: 'exampleco/infra', private: true, defaultBranch: 'main' }];
  const field = (view: InstallationsView, account: string | null, installUrl?: string | null) => {
    const html = renderToStaticMarkup(
      <RepositoryField
        added={[]}
        account={account}
        installUrl={installUrl}
        onAdded={() => undefined}
        initial={{ repositories: EXAMPLECO, installations: view }}
      />,
    ).replace(/<!-- -->/g, '');
    return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
  };

  it('sends an app private to the organization it is installed on to that installation’s page, and says nothing of making it public', () => {
    for (const account of ['exampleco', null]) {
      const { html, text } = field(OWN_ORGANIZATION, account, account ? 'https://github.com/organizations/exampleco/settings/installations/88' : undefined);
      expect(text).toContain('Not listed? Choose more of exampleco’s repositories ↗ and come back');
      expect(html).toContain('href="https://github.com/organizations/exampleco/settings/installations/88"');
      expect(html).not.toContain('installations/new');
      expect(text).not.toContain('It is private');
      expect(text).not.toContain('make it public');
    }
  });

  it('installs on the walkthrough’s account past GitHub’s account picker, even before the app is there', () => {
    const view: InstallationsView = { ...OWN_ORGANIZATION, accounts: [] };
    const { html, text } = field(view, 'exampleco', 'https://github.com/apps/fleetadlc-exampleco/installations/new/permissions?target_id=4242');
    expect(text).toContain('Install the app on exampleco ↗');
    expect(html).toContain('href="https://github.com/apps/fleetadlc-exampleco/installations/new/permissions?target_id=4242"');
    expect(text).not.toContain('make it public');
  });

  it('says a private app has to be made public only for an account other than its owner', () => {
    const { text } = field(OWN_ORGANIZATION, 'acme', 'https://github.com/apps/fleetadlc-exampleco/installations/new/permissions?target_id=77');
    expect(text).toContain('Install the app on acme ↗');
    expect(text).toContain('It is private to exampleco, and GitHub installs a private app only on the account that owns it: make it public ↗ before installing it on acme.');
  });

  it('offers any other account beside the known one, for a public app — and GitHub’s picker, when none is known', () => {
    const open: InstallationsView = { ...OWN_ORGANIZATION, app: { ...OWN_ORGANIZATION.app!, visibility: 'public' } };
    const known = field(open, 'exampleco');
    expect(known.text).toContain('Choose more of exampleco’s repositories ↗ , or install it on another account ↗ , and come back');
    expect(known.html).toContain('href="https://github.com/apps/fleetadlc-exampleco/installations/new"');

    const unknown = field({ ...open, accounts: [] }, null);
    expect(unknown.text).toContain('Choose more of an account’s repositories above, or install the app on another account ↗ and come back');
    expect(unknown.text).not.toContain('make it public');
  });
});

describe('a repository typed in that the app cannot reach yet', () => {
  const FIX: ReachFix = {
    need: 'make-public',
    title: 'The OpenADLC app is private to janedoe',
    detail: 'GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
    action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
    steps: [
      { text: 'Make the app public — only janedoe can', action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' } },
      { text: 'Install it on exampleco and choose infra', action: { label: 'Install on exampleco', url: 'https://github.com/apps/fleetadlc-janedoe/installations/new' } },
    ],
  };

  it('says what to do, in order, each with the page on GitHub where it is done, and that it waits', () => {
    const html = renderToStaticMarkup(<WaitingForApp fullName="exampleco/infra" fix={FIX} onStop={() => undefined} />).replace(/<!-- -->/g, '');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(text).toContain('The app cannot reach exampleco/infra yet. The OpenADLC app is private to janedoe.');
    const steps = [...html.matchAll(/<li class[^>]*>([\s\S]*?)<\/li>/g)].map((step) =>
      step[1]!.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    expect(steps).toEqual(['1 Make the app public — only janedoe can Make the app public', '2 Install it on exampleco and choose infra Install on exampleco']);
    expect(html).toContain('href="https://github.com/apps/fleetadlc-janedoe/installations/new"');
    expect(text).toContain('Waiting for GitHub… it is added as soon as the app can reach it.');
    expect(text).toContain('Stop waiting');
  });
});

describe('an account the app is installed on that the install does not work in', () => {
  it('is never offered, so Select all cannot pick its repositories, and an admin is offered to allow it', () => {
    // The bridge leaves its repositories out of the list and names the account.
    const html = renderToStaticMarkup(
      <RepositoryField added={[]} installUrl={null} onAdded={() => undefined} initial={{ repositories: REACHABLE, unknownAccounts: ['examp1eco'] }} />,
    ).replace(/<!-- -->/g, '');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(text).not.toContain('examp1eco/');
    expect(text).toContain('The app is also installed on examp1eco, which this install does not work in');
    expect(text).toContain('Allow examp1eco');
  });

  it('offers to allow it, where a typed repository waits on that, and warns before it does', () => {
    const fix: ReachFix = {
      need: 'allow-account',
      title: 'examp1eco is not an account this install works in',
      detail: 'A public app can be installed by anyone on their own repositories, and OpenADLC ignores those installations.',
      action: { label: 'Open examp1eco on GitHub', url: 'https://github.com/examp1eco' },
      steps: [{ text: 'Check that examp1eco is an account you work in', action: { label: 'Open examp1eco on GitHub', url: 'https://github.com/examp1eco' } }],
    };
    const html = renderToStaticMarkup(<WaitingForApp fullName="examp1eco/infra" fix={fix} onStop={() => undefined} />);
    expect(html).toContain('Allow examp1eco');
    expect(allowWarning('examp1eco')).toContain('the crew is invited to them');
    expect(allowWarning('examp1eco')).toContain('not a look-alike');
  });
});
