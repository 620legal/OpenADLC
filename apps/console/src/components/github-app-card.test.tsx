import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppView, InstallationsView } from '@/lib/app-reach';
import { Dialog } from '@/components/ui/dialog';
import { GitHubAppCard, GitHubAppPanel, InstallElsewhereDialog } from './github-app-card';

/**
 * Settings' GitHub App section: whose the app is, who can install it, and
 * each account — installed or not — with GitHub's page for each.
 */

const PRIVATE_APP: InstallationsView = {
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
      fix: {
        need: 'make-public',
        title: 'The OpenADLC app is private to janedoe',
        detail: 'GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
        action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
        steps: [],
      },
    },
  ],
  reason: '',
};

const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The dialog's content. `DialogContent` portals, which static markup does not
 * include, so this renders the same body the dialog shows, inside `Dialog`
 * where its title is allowed.
 */
function openDialog(app: AppView): string {
  return renderToStaticMarkup(
    <Dialog open>
      <InstallElsewhereDialog app={app} />
    </Dialog>,
  ).replace(/<!-- -->/g, '');
}

/** Each account's row, as its text. */
function accounts(html: string): string[] {
  const list = /<ul aria-label="Where the app is installed"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((row) => text(row[1]!));
}

describe('the GitHub App in settings', () => {
  const html = renderToStaticMarkup(<GitHubAppPanel view={PRIVATE_APP} />).replace(/<!-- -->/g, '');

  it('says whose it is and that it is private, and does not offer to make it public', () => {
    expect(text(html)).toContain('OpenADLC (janedoe) · owned by janedoe · private');
    expect(text(html)).toContain('Private: only janedoe can install it.');
    expect(html).not.toContain('Make it public');
  });

  it('lists each account OpenADLC works in, installed or not, with what to do where it is not', () => {
    expect(accounts(html)).toEqual([
      'janedoe · personal · all repositories OpenADLC works in fleetadlc-testbed Choose repositories',
      'exampleco · organization · not installed OpenADLC works in infra Make the app public ' +
        'The OpenADLC app is private to janedoe. GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
    ]);
    expect(html).toContain('href="https://github.com/settings/installations/7"');
  });

  it('opens Install on another account instead of linking there while the app is private', () => {
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Install on another account<\/button>/);
    expect(html).not.toMatch(/<a href="https:\/\/github.com\/apps\/fleetadlc-janedoe\/installations\/new"[^>]*>Install on another account/);
  });

  it('explains, for a person-owned app, transferring it to an organization or making it public', () => {
    const dialog = openDialog(PRIVATE_APP.app!);
    const said = text(dialog);
    expect(said).toContain('GitHub installs a private app only on the account that owns it, so janedoe’s app cannot go on another account yet.');
    expect(said).toContain('For an organization, transfer the app to it.');
    expect(said).toContain('Transfer ownership');
    expect(said).toContain('Otherwise, make the app public.');
    expect(said).toContain('Any GitHub account can then install it');
    expect(said).toContain('it cannot be made private again while another account has it installed');
    expect(said).toContain('An installer grants access only to their own repositories, and OpenADLC acts only where it works in a repository.');
    expect(dialog).toMatch(/<a href="https:\/\/github.com\/settings\/apps\/fleetadlc-janedoe\/advanced"[^>]*>Make the app public/);
    expect(dialog).toMatch(/<a href="https:\/\/github.com\/apps\/fleetadlc-janedoe\/installations\/new"[^>]*>Install on another account/);
    // Both links leave the dialog open behind a new tab, and a phone has no Esc.
    expect(dialog).toMatch(/<button[^>]*>Close<\/button>/);
  });

  it('offers making an organization-owned app public, without telling its owner to transfer it', () => {
    const app = { ...PRIVATE_APP.app!, owner: { login: 'exampleco', type: 'Organization' as const } };
    const dialog = openDialog(app);
    const said = text(dialog);
    expect(said).toContain('GitHub installs a private app only on the account that owns it, so exampleco’s app cannot go on another account yet.');
    expect(said).toContain('Make the app public to install it on another account.');
    expect(said).not.toContain('Transfer ownership');
    expect(said).not.toContain('For an organization, transfer');
    expect(said).toContain('Any GitHub account can then install it');
    expect(said).toContain('it cannot be made private again while another account has it installed');
    expect(said).toContain('OpenADLC acts only where it works in a repository.');
    expect(dialog).toMatch(/<a href="https:\/\/github.com\/settings\/apps\/fleetadlc-janedoe\/advanced"[^>]*>Make the app public/);
    expect(dialog).toMatch(/<a href="https:\/\/github.com\/apps\/fleetadlc-janedoe\/installations\/new"[^>]*>Install on another account/);
  });

  it('installs it on an account with nothing else to do there past GitHub’s account picker', () => {
    const plain = renderToStaticMarkup(
      <GitHubAppPanel view={{ ...PRIVATE_APP, accounts: [{ ...PRIVATE_APP.accounts[1]!, fix: null }] }} />,
    ).replace(/<!-- -->/g, '');
    expect(plain).toMatch(/<a href="https:\/\/github.com\/apps\/fleetadlc-janedoe\/installations\/new\/permissions\?target_id=4242"[^>]*>Install on exampleco/);
  });

  it('sends a suspended installation to its page to be unsuspended', () => {
    const suspended = renderToStaticMarkup(
      <GitHubAppPanel
        view={{
          ...PRIVATE_APP,
          accounts: [{ ...PRIVATE_APP.accounts[0]!, installation: { ...PRIVATE_APP.accounts[0]!.installation!, suspended: true } }],
        }}
      />,
    ).replace(/<!-- -->/g, '');
    expect(accounts(suspended)).toEqual(['janedoe · personal · suspended OpenADLC works in fleetadlc-testbed Unsuspend it']);
  });

  it('links Install on another account straight to GitHub once the app is public', () => {
    const shown = renderToStaticMarkup(<GitHubAppPanel view={{ ...PRIVATE_APP, app: { ...PRIVATE_APP.app!, visibility: 'public' } }} />);
    expect(shown).not.toContain('Make it public');
    expect(shown).not.toContain('aria-haspopup="dialog"');
    expect(text(shown)).toContain('Public: any account can install it.');
    expect(shown).toMatch(/<a href="https:\/\/github.com\/apps\/fleetadlc-janedoe\/installations\/new"[^>]*>Install on another account/);
  });

  it('says why there is nothing to show before OpenADLC holds the app’s key', () => {
    const none = renderToStaticMarkup(
      <GitHubAppPanel view={{ app: null, accounts: [], reason: 'OpenADLC does not hold the app’s private key yet, so it cannot ask GitHub about the app' }} />,
    );
    expect(text(none)).toBe('OpenADLC does not hold the app’s private key yet, so it cannot ask GitHub about the app.');
  });

  it('is a section of its own, which asks the bridge once it is on screen', () => {
    const card = renderToStaticMarkup(<GitHubAppCard />);
    expect(card).toContain('id="github-app"');
    expect(text(card)).toContain('GitHub App OpenADLC works only in the repositories the app reaches.');
    expect(text(card)).toContain('Asking GitHub where the app is installed…');
  });
});
