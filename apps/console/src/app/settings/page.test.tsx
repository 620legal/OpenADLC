import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/**
 * Settings under the console's header: a section for each thing they set,
 * each with an id its own navigation and `/settings#engine-updates` land on.
 */
const bot = (name: string, slot: string, role: string, extra: Record<string, unknown> = {}) => ({
  name,
  slot,
  displayName: slot,
  role,
  engine: 'claude',
  model: 'newest:opus',
  status: 'stopped',
  container: `bot-${slot}`,
  githubLogin: name === slot ? null : name,
  authorization: name === slot ? 'unauthorized' : 'active',
  tokenExpiresAt: null,
  now: 'nothing running',
  paused: false,
  sessions: [],
  modelAccountId: 'max',
  task: null,
  lastTask: null,
  ...extra,
});

type Me = { known: true; email: string; role: 'admin' | 'user'; identityMode: 'local' | 'iap' };
const ADMIN: Me = { known: true, email: 'janedoe@example.com', role: 'admin', identityMode: 'iap' };
const who = vi.hoisted(() => ({ me: null as unknown as Me }));
who.me = ADMIN;

vi.mock('@/lib/api', () => ({
  readMe: async () => who.me,
  api: {
    users: async () => [
      { email: 'janedoe@example.com', role: 'admin', addedBy: 'janedoe@example.com', addedHow: 'first', addedAt: '2026-09-30T10:00:00.000Z' },
      { email: 'bob@example.com', role: 'user', addedBy: 'janedoe@example.com', addedHow: 'added', addedAt: '2026-09-30T11:00:00.000Z' },
    ],
    repos: async () => ({
      repos: [
        {
          name: 'fleetadlc-testbed',
          fullName: 'janedoe/fleetadlc-testbed',
          concurrency: 1,
          owner: 'fleetadlc-atlas-janedoe',
          stageModes: { merged: 'assist' },
          specRequiredLabels: ['safety'],
          color: 'blue',
        },
        {
          name: 'website',
          fullName: 'janedoe/website',
          concurrency: 1,
          owner: 'fleetadlc-atlas-janedoe',
          stageModes: {},
          specRequiredLabels: [],
          color: 'amber',
        },
      ],
      maxReviewRounds: 3,
    }),
    crew: async () => ({
      bots: [
        bot('fleetadlc-atlas-janedoe', 'builder', 'implement'),
        bot('irisexampleco', 'second-reviewer', 'review_second', { engine: 'grok', model: 'newest:grok', modelAccountId: 'xai' }),
        bot('lead-reviewer', 'lead-reviewer', 'review_lead', { engine: 'codex', model: 'newest:codex', modelAccountId: null }),
        bot('tessexampleco', 'sre', 'deploy', { authorization: 'expired' }),
        bot('janedoe-fleetadlc-flow', 'automation', 'automation', { engine: 'none', model: 'none', modelAccountId: null }),
      ],
    }),
    costs: async () => ({ budget: { period: '2026-09', capUsd: 1500, spentUsd: 7.51, state: 'ok' }, perTaskCapUsd: 15 }),
    spendingLimits: async () => ({
      period: '2026-09',
      global: {
        monthTotal: { amountUsd: 1500, spentUsd: 7.51 },
        task: { amountUsd: 15, spentUsd: null },
        bots: [],
        providers: [],
      },
      repos: [],
    }),
    githubAccounts: async () => ({
      accounts: [
        {
          login: 'fleetadlc-atlas-janedoe',
          url: 'https://github.com/fleetadlc-atlas-janedoe',
          group: 'crew',
          signIn: 'signed-in',
          seats: [{ name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', roleLabel: 'builder' }],
        },
        {
          login: 'irisexampleco',
          url: 'https://github.com/irisexampleco',
          group: 'reviewers',
          signIn: 'signed-in',
          seats: [{ name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', roleLabel: 'second reviewer' }],
        },
      ],
      bots: [
        {
          name: 'fleetadlc-atlas-janedoe',
          slot: 'builder',
          role: 'implement',
          roleLabel: 'builder',
          group: 'crew',
          login: 'fleetadlc-atlas-janedoe',
          choices: [
            { login: 'fleetadlc-atlas-janedoe', refusal: null },
            { login: 'irisexampleco', refusal: 'the reviewers’ account (the second reviewer uses it) — the crew needs a different one' },
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
            { login: 'fleetadlc-atlas-janedoe', refusal: 'used by the builder — reviewers need their own account' },
            { login: 'irisexampleco', refusal: null },
          ],
        },
      ],
    }),
    modelAccounts: async () => ({
      accounts: [
        { id: 'max', provider: 'anthropic', kind: 'subscription', label: 'Anthropic — Max' },
        { id: 'xai', provider: 'xai', kind: 'subscription', label: 'xAI — subscription' },
      ],
    }),
    installations: async () => ({
      app: {
        slug: 'fleetadlc-janedoe',
        name: 'OpenADLC (janedoe)',
        owner: { login: 'janedoe', type: 'User' },
        visibility: 'public',
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
      ],
      reason: '',
    }),
    install: async () => ({
      organization: 'janedoe',
      installName: 'OpenADLC_janedoe',
      attributionMode: 'audit',
      githubClientId: 'Iv23client',
      automationBot: 'janedoe-fleetadlc-flow',
      humans: 'janedoe',
      publicUrl: '',
      operatorEmail: '',
      webhookSecretConfigured: true,
      appPrivateKeyConfigured: true,
      appClientSecretConfigured: false,
      storedKeys: [],
      webhookUrl: '',
    }),
    // Not answering, as a bridge without the route would: the section reads its own.
    engineUpdates: async () => {
      throw new Error('bridge /v1/engines/updates → 404');
    },
    backup: async () => {
      throw new Error('bridge /v1/backup → 404');
    },
    workPauses: async () => ({ paused: null, repos: {} }),
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['fleetadlc-testbed'], crew: [], budget: { spentUsd: 7.51, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

async function page(): Promise<string> {
  const { default: SettingsPage } = await import('./page');
  return renderToStaticMarkup(await SettingsPage()).replace(/<!-- -->/g, '');
}

/** The rows of one section, as their text. */
function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the settings page', () => {
  it('is an admin’s: a user is told so, and shown none of it', async () => {
    who.me = { known: true, email: 'bob@example.com', role: 'user', identityMode: 'iap' };
    try {
      const html = await page();
      expect(html).toContain('Settings need an admin');
      expect(html).toContain('bob@example.com');
      expect(html).not.toContain('id="users"');
      expect(html).not.toContain('id="backup"');
      expect(html).not.toContain('FLEETADLC_IDENTITY');
    } finally {
      who.me = ADMIN;
    }
  });

  it('names the way back on a local install whose console identity is a user', async () => {
    who.me = { known: true, email: 'console', role: 'user', identityMode: 'local' };
    try {
      const html = (await page()).replace(/<!-- -->/g, '');
      expect(html).toContain('Settings need an admin');
      expect(html).toContain('This console signs in as');
      expect(html).toContain('FLEETADLC_IDENTITY');
      expect(html).toContain('fleetadlc up');
    } finally {
      who.me = ADMIN;
    }
  });

  it('says roles are advisory on a local install, and who may use the console behind IAP', async () => {
    expect(section(await page(), 'users')).toContain('Who may use the console.');
    who.me = { ...ADMIN, identityMode: 'local' };
    try {
      const users = section(await page(), 'users');
      expect(users).toContain('On a local install roles are advisory');
      expect(users).not.toContain('Who may use the console.');
    } finally {
      who.me = ADMIN;
    }
  });

  it('lists the users for an admin, saying who became admin by being first', async () => {
    const users = section(await page(), 'users');
    expect(users).toContain('janedoe@example.com (you)');
    expect(users).toContain('Admin by being the first to open the console');
    expect(users).toContain('bob@example.com');
    expect(users).toContain('Added by janedoe@example.com');
  });

  it('is under the console’s header, with Settings marked', async () => {
    const html = await page();
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/settings"/);
    expect(html).not.toContain('back to the board');
  });

  it('has a section for each thing it sets, and a navigation that links to each', async () => {
    const html = await page();
    const nav = /<nav aria-label="Settings"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect([...nav.matchAll(/href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((link) => [link[1], link[2]])).toEqual([
      ['#repository', 'Repositories'],
      ['#github', 'GitHub'],
      ['#models', 'AI models'],
      ['#crew', 'Crew'],
      ['#system', 'System'],
      ['#spending-limits', 'Spending limits'],
      ['#backup', 'Backup'],
      ['#pause', 'Pause work'],
      ['#users', 'Users'],
      ['#appearance', 'Appearance'],
      ['/onboarding', 'Run the setup again'],
    ]);
    for (const id of ['repository', 'github', 'github-app', 'github-accounts', 'install', 'crew', 'models', 'system', 'engine-updates', 'spending-limits', 'appearance']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('lists the repositories under one heading, each linking to its own page, with a way to add another', async () => {
    const html = await page();
    const repositories = html.slice(html.indexOf('id="repository"'), html.indexOf('id="github"'));
    expect(repositories).toMatch(/aria-labelledby="repositories-title"/);
    expect(repositories).toMatch(/<h2 id="repositories-title"[^>]*>Repositories<\/h2>/);
    expect(repositories).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*Add a repository<\/button>/);
    const links = [...repositories.matchAll(/<a [^>]*>/g)]
      .map((match) => [/href="([^"]+)"/.exec(match[0])?.[1], /aria-label="([^"]+)"/.exec(match[0])?.[1]])
      .filter(([href]) => href?.startsWith('/settings/'));
    expect(links).toEqual([
      ['/settings/repositories/fleetadlc-testbed', 'fleetadlc-testbed settings'],
      ['/settings/repositories/website', 'website settings'],
    ]);
  });

  it('leaves each repository’s settings to its page', async () => {
    const html = await page();
    expect(html).not.toContain('What each stage may do without asking');
    // Appearance offers every repository's color in one list; the list above
    // does not, and the page's own control is the repository page's.
    const repositories = html.slice(html.indexOf('id="repository"'), html.indexOf('id="github"'));
    expect(repositories).not.toContain('role="radiogroup"');
    expect(html).not.toContain('aria-label="Color"');
    expect(html).not.toContain('Remove from OpenADLC');
    expect(html).not.toContain('Tasks at once');
  });

  it('has one GitHub section — the app, the install name, the connected accounts — between the repositories and the crew', async () => {
    const html = await page();
    const order = ['id="repository"', 'id="github"', 'id="github-app"', 'id="install"', 'id="github-accounts"', 'id="crew"'].map((id) =>
      html.indexOf(id),
    );
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const github = section(html, 'github');
    expect(github).toContain('GitHub App OpenADLC works only in the repositories the app reaches.');
    expect(github).toContain('Install name Every post OpenADLC writes on GitHub starts with this name');
    expect(github).toContain('Connected accounts The GitHub accounts OpenADLC signs in as. Which bot uses which is set under Crew.');
    // Its install name is a part of it, not a section of its own.
    expect(html).not.toMatch(/<section[^>]*id="install"/);
  });

  it('asks for the app’s client secret, saying what it narrows, and never shows one', async () => {
    const github = section(await page(), 'github');
    expect(github).toContain('App client secret');
    expect(github).toContain('Narrows each task’s GitHub token to the task’s repository.');
    expect(await page()).toMatch(/type="password"[^>]*placeholder="generate one on the app’s settings page and paste it here"/);
  });

  it('is drawn at its full height above the crew, so nothing the crew has moves when the page settles', async () => {
    // These two read their own after the page arrived, and pushed the crew's
    // buttons 400 pixels down under a click already on its way.
    const github = section(await page(), 'github');
    expect(github).not.toContain('Asking GitHub where the app is installed');
    expect(github).not.toContain('Reading the install’s settings');
    expect(github).toContain('OpenADLC (janedoe)');
    expect(github).toContain('Count only signed posts');
  });

  it('still draws a section the bridge did not answer for, which reads its own', async () => {
    const html = await page();
    expect(section(html, 'engine-updates')).toContain('asking which engines the crew runs');
  });

  it('manages the connections there, and nothing about which bot uses which', async () => {
    const html = await page();
    const github = html.slice(html.indexOf('id="github"'), html.indexOf('id="crew"'));
    const said = section(html, 'github-accounts');
    expect(said).toContain('fleetadlc-atlas-janedoe Signed in Crew account Used by Builder Reconnect');
    expect(said).toContain('irisexampleco Signed in Reviewer account Used by Second reviewer Reconnect');
    expect(said).toContain('Connect a GitHub account Connect');
    expect(github).not.toContain('<select');
  });

  it('lists the crew in one table: each bot, the GitHub account it acts as and its model, each changed on its row', async () => {
    const html = await page();
    const crew = html.slice(html.indexOf('id="crew"'), html.indexOf('id="engine-updates"'));
    const said = section(html, 'crew');
    expect(said).toContain('Bot GitHub account Model');
    expect(said.indexOf('Crew account')).toBeLessThan(said.indexOf('Reviewer account'));
    expect(crew).toMatch(/aria-label="GitHub account for the builder"[\s\S]*?<option value="fleetadlc-atlas-janedoe" selected="">fleetadlc-atlas-janedoe<\/option>/);
    expect(crew).toMatch(/aria-label="GitHub account for the lead reviewer"[\s\S]*?<option value="" selected="">Not connected<\/option>/);
    // What a bot may not use is there, disabled, with the bridge's reason.
    expect(crew).toContain(
      '<option value="fleetadlc-atlas-janedoe" disabled="">fleetadlc-atlas-janedoe — used by the builder — reviewers need their own account</option>',
    );
    expect(crew).toMatch(/aria-label="Model account for the builder"[\s\S]*?<option value="max" selected="">Anthropic — Max<\/option>/);
    expect(crew).toMatch(/aria-label="Model for the builder"[\s\S]*?<option value="newest:opus" selected="">/);
    expect(said).toContain('Automation');
    expect(said).toContain('No model, and that is correct');
    expect(html).not.toContain('fleetadlc auth login');
  });

  it('gives Crew no link to AI models: that section is already above it, in the navigation', async () => {
    const html = await page();
    expect(html).not.toMatch(/href="\/settings#models"/);
    expect(html).not.toContain('step=assignment');
    expect(html).toMatch(/<section id="models"[^>]*><div[^>]*><h2 id="models-title"[^>]*>AI models<\/h2>/);
    expect(html.indexOf('<section id="models"')).toBeLessThan(html.indexOf('<section id="crew"'));
    expect(html.indexOf('<section id="crew"')).toBeLessThan(html.indexOf('id="engine-updates"'));
    expect(section(html, 'crew')).not.toContain('Model accounts');
    expect(html.match(/id="models"/g)).toHaveLength(1);
  });

  it('draws AI models with no account as empty at once, not as still asking', async () => {
    const { api } = await import('@/lib/api');
    vi.spyOn(api, 'modelAccounts').mockResolvedValueOnce({ accounts: [] });
    const models = section(await page(), 'models');
    expect(models).toContain('No model account yet. Add the first one below');
    expect(models).not.toContain('asking which accounts are stored');
  });

  it('summarises the global caps and links to the page that edits them', async () => {
    const html = await page();
    const limits = section(html, 'spending-limits');
    expect(limits).toContain('Each month');
    expect(limits).toContain('$1,500');
    expect(limits).toContain('$7.51 spent this month');
    expect(limits).toContain('Each task');
    expect(limits).toContain('$15');
    expect(limits).toContain('A task stops when it has cost this much.');
    const fields = html.slice(html.indexOf('id="spending-limits"'), html.indexOf('id="backup"'));
    expect(fields).toMatch(/<a [^>]*href="\/settings\/spending"[^>]*>Edit limits<\/a>/);
    expect(fields).toContain('role="meter"');
    expect(fields).not.toContain('<input');
    expect(fields).not.toContain('>Save<');
  });

  it('has a Backup section of its own: Backup and Restore, each a row that opens its form', async () => {
    const html = await page();
    const backup = section(html, 'backup');
    expect(backup).toContain('Backup An encrypted copy of this install, to set a new one up from — or to put back into this one.');
    expect(backup).toContain('Download an encrypted copy of this install.');
    expect(backup).toContain('Put a backup back into this install.');
    expect(html).toContain('id="restore"');
    // The forms are in modals, so the section does not carry the inline one.
    expect(backup).not.toContain('Restore from a backup');
    expect(backup).not.toContain('Reading what there is to back up');
  });

  it('holds the color mode under Appearance, with each repository’s color and each crew member’s', async () => {
    const html = await page();
    const appearance = html.slice(html.indexOf('id="appearance"'));
    expect(appearance).toContain('aria-label="Color mode"');
    expect(appearance).toContain('Repository colors');
    expect(appearance).toContain('aria-label="fleetadlc-testbed color"');
    expect(appearance).toContain('Crew colors');
    expect(appearance).not.toMatch(/colour/i);
  });

  it('offers an admin, inside the role the layout gives, a choice of repositories to pause and each one paused', async () => {
    const { api } = await import('@/lib/api');
    const { RoleProvider } = await import('@/components/app-header');
    const { default: SettingsPage } = await import('./page');
    vi.spyOn(api, 'workPauses').mockResolvedValueOnce({
      paused: null,
      repos: { 'fleetadlc-testbed': { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'a migration is running' } },
    });
    const html = renderToStaticMarkup(<RoleProvider role="admin">{await SettingsPage()}</RoleProvider>).replace(/<!-- -->/g, '');
    expect(section(html, 'pause')).toContain('Paused by janedoe at 2026-09-29 10:00 UTC: a migration is running.');
    const markup = html.slice(html.indexOf('id="pause"'), html.indexOf('</section>', html.indexOf('id="pause"')));
    expect(markup).toContain('aria-label="Paused repositories"');
    expect(markup).toContain('aria-label="Resume fleetadlc-testbed"');
    expect(markup).toMatch(/<input type="radio"[^>]*value="chosen"/);
  });

  it('has Pause work, which says work runs and offers to pause it, and says who paused it and offers to resume', async () => {
    const running = section(await page(), 'pause');
    expect(running).toContain('Work runs.');
    expect(running).toContain('Pause work');

    const { api } = await import('@/lib/api');
    vi.spyOn(api, 'workPauses').mockResolvedValueOnce({ paused: { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'an account may be compromised' }, repos: {} });
    const paused = section(await page(), 'pause');
    expect(paused).toContain('Paused by janedoe at 2026-09-29 10:00 UTC: an account may be compromised.');
    expect(paused).toContain('Resume work');
  });

  it('does not say work runs on a bridge without the dispatcher, paused or not, and says Pause and Resume do not change it', async () => {
    const { api } = await import('@/lib/api');
    vi.spyOn(api, 'workPauses').mockResolvedValueOnce({ paused: null, repos: {}, dispatching: false });
    const off = section(await page(), 'pause');
    expect(off).not.toContain('Work runs.');
    expect(off).toContain('Nothing new will start building: the dispatcher isn’t running');
    expect(off).toContain('Pause and Resume do not change');

    vi.spyOn(api, 'workPauses').mockResolvedValueOnce({ paused: { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: null }, repos: {}, dispatching: false });
    expect(section(await page(), 'pause')).toContain('the dispatcher isn’t running');

    vi.spyOn(api, 'workPauses').mockResolvedValueOnce({ paused: null, repos: {}, dispatching: true });
    const on = section(await page(), 'pause');
    expect(on).toContain('Work runs.');
    expect(on).not.toContain('dispatcher');
  });
});
