import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnboardingView, type OnboardingData } from './onboarding-view';
import { RestoreChoice, setsUpLines, type RestorePhase } from './restore-step';
import type { RestorePreview, RestoreResult, RestoreState, RestoreSummary, SignInLine } from '@/lib/backup';

/**
 * The walkthrough's first step on a clean install: start fresh, or restore
 * from a backup — and, on an install that is set up, a step already done that
 * says why no restore is offered.
 */

/** A fresh install: every seat seeded, nothing set up. */
const FRESH: OnboardingData = {
  organization: null,
  organizationIsOrg: null,
  repositories: [],
  clientIdConfigured: false,
  webhookSecretConfigured: false,
  webhookReady: false,
  operatorEmail: '',
  steps: [],
  bots: [
    {
      bot: 'builder',
      slot: 'builder',
      displayName: 'Builder',
      role: 'implement',
      roleLabel: 'builder',
      login: 'fleetadlc-builder',
      suggestedLogin: 'fleetadlc-builder',
      suggestedEmail: null,
      emailNote: '',
      repositoryRole: 'write',
      accessReason: 'pushes branches',
      accountExists: false,
      connected: false,
      authorizationWorks: null,
      credentialKind: null,
      hasSigningKey: false,
      inRepository: null,
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

const CLEAN: RestoreState = { clean: true, setUp: [] };

function walkthrough(restore: RestoreState | null, data: OnboardingData = FRESH, step: string | null = null): string {
  return renderToStaticMarkup(
    <OnboardingView
      initialEmail=""
      initialData={data}
      initialChecks={null}
      initialAccounts={[]}
      initialCrew={[]}
      initialStep={step}
      initialRestore={restore}
    />,
  ).replace(/<!-- -->/g, '');
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the walkthrough on a clean install', () => {
  it('opens on its first step: start fresh, or restore from a backup', () => {
    const html = walkthrough(CLEAN);

    expect(html).toContain('step 1 of 12');
    expect(html).toContain('>Start fresh or restore a backup</h2>');
    expect(text(html)).toContain('Restore from a backup');
    expect(html).toMatch(/<button[^>]*>choose the backup file<\/button>/);
    expect(html).toMatch(/accept="\.fleetbak,\.json[^"]*"/);
    // Starting fresh is the way on, and says so.
    expect(html).toMatch(/<button[^>]*>start fresh<\/button>/);
  });

  it('comes before everything else, and counts as done once the install is set up', () => {
    const html = walkthrough({ clean: false, setUp: ['the GitHub App'] }, { ...FRESH, organization: 'acme' });

    const segments = [...html.matchAll(/<a href="(\?step=[^"]+)" title="([^"]+)"/g)].map(([, href]) => href);
    expect(segments[0]).toBe('?step=start');
    expect(segments[1]).toBe('?step=owner');
    expect(html).toContain('step 3 of 12');
    expect(html).toMatch(/already done:[\s\S]*?<a href="\?step=start"[^>]*>Start,<\/a>/);
  });

  it('says why no restore is offered here on an install that is set up, and where one is', () => {
    const html = walkthrough({ clean: false, setUp: ['the GitHub App', 'the repository acme/widgets'] }, FRESH, 'start');
    const said = text(html);

    expect(said).toContain('This install is already set up — the GitHub App and the repository acme/widgets — so');
    expect(said).toContain('To restore a backup into it, use Restore in Settings → Backup');
    expect(html).toContain('href="/settings#restore"');
    expect(said).not.toContain('choose the backup file');
  });

  it('is left out when the bridge could not say, rather than offering what it cannot do', () => {
    const html = walkthrough(null);

    expect(html).toContain('of 11');
    expect(html).not.toContain('?step=start');
  });
});

/** One of each verdict, as the bridge judges them. */
const SIGN_INS: SignInLine[] = [
  {
    key: 'bot:builder',
    kind: 'github-refresh',
    provider: 'github',
    seat: 'builder',
    accountId: null,
    who: 'fleetadlc-atlas-acme',
    rotates: true,
    replaces: false,
    verdict: { state: 'check-by-use' },
    chosen: true,
    state: 'take-over',
    reason: null,
  },
  {
    key: 'bot:qa',
    kind: 'github-refresh',
    provider: 'github',
    seat: 'qa',
    accountId: null,
    who: 'fleetadlc-quinn-acme',
    rotates: true,
    replaces: false,
    verdict: { state: 'blocked', reason: 'it expired on 1 March 2027' },
    chosen: false,
    state: 'blocked',
    reason: 'it expired on 1 March 2027',
  },
  {
    key: 'account:a',
    kind: 'claude-token',
    provider: 'anthropic',
    seat: null,
    accountId: 'a',
    who: 'Anthropic — Max',
    rotates: false,
    replaces: false,
    verdict: { state: 'works', said: 'Anthropic lists 9 models for it' },
    chosen: true,
    state: 'restored',
    reason: null,
  },
  {
    key: 'account:k',
    kind: 'api-key',
    provider: 'openai',
    seat: null,
    accountId: 'k',
    who: 'OpenAI API',
    rotates: false,
    replaces: false,
    verdict: { state: 'blocked', reason: 'OpenAI did not accept it: Incorrect API key provided' },
    chosen: false,
    state: 'blocked',
    reason: 'OpenAI did not accept it: Incorrect API key provided',
  },
];

const RESTORES: RestoreSummary = {
  settings: ['operatorEmail', 'organization'],
  app: ['private key', 'client id', 'webhook secret'],
  repositories: ['acme/widgets'],
  accounts: [
    { id: 'a', label: 'Anthropic — Max', credential: 'token', signIn: 'restored', reason: null },
    { id: 'p', label: 'ChatGPT Pro', credential: 'none', signIn: null, reason: null },
  ],
  bots: [
    {
      seat: 'builder',
      name: 'builder',
      login: 'fleetadlc-atlas-acme',
      becomes: 'fleetadlc-atlas-acme',
      signIn: false,
      signingKey: true,
      model: 'newest:opus',
      needsConnecting: false,
      signInState: 'take-over',
      reason: null,
    },
    {
      seat: 'lead-reviewer',
      name: 'lead-reviewer',
      login: 'fleetadlc-sydney-acme',
      becomes: null,
      signIn: false,
      signingKey: true,
      model: null,
      needsConnecting: true,
      signInState: null,
      reason: null,
    },
  ],
  signIns: SIGN_INS,
  history: null,
  skipped: ['the setting quantumMode, which this version of OpenADLC does not know'],
  next: ['Connect 1 bot to GitHub — fleetadlc-sydney-acme — because its sign-in was not in the backup.'],
};

/** The archive a `read` phase was read from, which Restore sends. */
const ARCHIVE = { archive: 'RkxFRVRCQUs=', sealed: true };

const PREVIEW: RestorePreview = {
  sealed: true,
  holds: {
    version: 2,
    createdAt: '2026-09-24T12:00:00.000Z',
    install: { settings: ['operatorEmail', 'organization'], app: ['private key', 'client id', 'webhook secret'], other: [] },
    repositories: ['acme/widgets'],
    bots: [
      { seat: 'builder', name: 'fleetadlc-atlas-acme', login: 'fleetadlc-atlas-acme', signingKey: true, signIn: true, model: 'newest:opus' },
      { seat: 'lead-reviewer', name: 'fleetadlc-sydney-acme', login: 'fleetadlc-sydney-acme', signingKey: true, signIn: false, model: null },
    ],
    botSignIns: true,
    accounts: [{ id: 'a', label: 'Anthropic — Max', provider: 'anthropic', kind: 'subscription', credential: 'token' }],
    accountSignIns: false,
    history: null,
  },
  restores: RESTORES,
  signIns: SIGN_INS,
};

function choice(
  phase: RestorePhase,
  fileName: string | null = 'fleetadlc-backup-2026-09-24.fleetbak',
  sealed = true,
  choices: Record<string, boolean> = { 'bot:builder': true, 'account:a': true },
): string {
  return renderToStaticMarkup(
    <RestoreChoice
      restore={CLEAN}
      phase={phase}
      fileName={fileName}
      sealed={sealed}
      passphrase=""
      error={null}
      onPick={() => undefined}
      onPassphrase={() => undefined}
      onRead={() => undefined}
      onRestore={() => undefined}
      onAgain={() => undefined}
      choices={choices}
    />,
  ).replace(/<!-- -->/g, '');
}

/** The checkbox beside a sign-in's name, as rendered. */
function box(html: string, name: string): string {
  const at = html.indexOf(`>${name}<`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<input type="checkbox"', at);
  return html.slice(start, html.indexOf('/>', start));
}

describe('restoring from the first step', () => {
  it('asks for the file’s passphrase before reading a sealed one, and warns about one that is not sealed', () => {
    expect(choice({ at: 'choosing' })).toMatch(/its passphrase[\s\S]*type="password"/);
    expect(choice({ at: 'choosing' })).toMatch(/<button[^>]*disabled=""[^>]*>read the backup<\/button>/);
    expect(text(choice({ at: 'choosing' }, 'old.plain.json', false))).toContain('This file is not encrypted');
  });

  it('shows what the backup holds and what restoring it sets up, before anything is written', () => {
    const said = text(choice({ at: 'read', preview: PREVIEW, ...ARCHIVE }));

    expect(said).toContain('Made 24 September 2026.');
    expect(said).toContain('It holds');
    expect(said).toContain('Two bots, 1 with its GitHub sign-in');
    expect(said).toContain('Restoring it sets up');
    expect(said).toContain('The install’s two settings, and the app’s private key, client id and webhook secret');
    expect(said).toContain('The model account ChatGPT Pro, to sign in to again');
    expect(said).toContain('Builder: fleetadlc-atlas-acme, if its sign-in still works');
    expect(said).toContain('Lead reviewer: fleetadlc-sydney-acme, to connect again');
    expect(said).toContain('It leaves out the setting quantumMode');
    expect(said).toContain('Then still to do Connect 1 bot to GitHub — fleetadlc-sydney-acme');
    expect(choice({ at: 'read', preview: PREVIEW, ...ARCHIVE })).toMatch(/<button[^>]*>Restore<\/button>/);
  });

  it('lists every sign-in with its verdict before Restore, and one that cannot be restored cannot be ticked', () => {
    const html = choice({ at: 'read', preview: PREVIEW, ...ARCHIVE });
    const said = text(html);

    expect(said).toContain('Sign-ins');
    expect(said).toContain('Builder as fleetadlc-atlas-acme Can only be checked by using it');
    expect(said).toContain('Anthropic — Max Works — Anthropic lists 9 models for it');
    expect(said).toContain('QA as fleetadlc-quinn-acme Cannot be restored — it expired on 1 March 2027');
    expect(said).toContain('OpenAI API Cannot be restored — OpenAI did not accept it: Incorrect API key provided');
    // What checking a rotating one does, said plainly.
    expect(said).toContain(
      'Checking a GitHub sign-in uses it — if it works, this install takes it over from wherever else it is in use.',
    );
    expect(box(html, 'Builder as fleetadlc-atlas-acme')).toContain('checked=""');
    expect(box(html, 'Anthropic — Max')).toContain('checked=""');
    for (const blocked of ['QA as fleetadlc-quinn-acme', 'OpenAI API']) {
      expect(box(html, blocked)).toContain('disabled=""');
      expect(box(html, blocked)).not.toContain('checked=""');
    }
  });

  it('shows a bot’s own engine key its provider refused, with the reason, and it cannot be ticked', () => {
    const engineKey: SignInLine = {
      key: 'engine:builder',
      kind: 'engine-key',
      provider: 'anthropic',
      seat: 'builder',
      seats: [],
      accountId: null,
      who: 'builder',
      rotates: false,
      replaces: false,
      verdict: { state: 'blocked', reason: 'Anthropic did not accept it: invalid x-api-key' },
      chosen: false,
      state: 'blocked',
      reason: 'Anthropic did not accept it: invalid x-api-key',
    };
    const html = renderToStaticMarkup(
      <RestoreChoice
        restore={CLEAN}
        phase={{ at: 'read', preview: { ...PREVIEW, signIns: [...SIGN_INS, engineKey] }, ...ARCHIVE }}
        fileName="fleetadlc-backup-2026-09-24.fleetbak"
        sealed
        passphrase=""
        error={null}
        onPick={() => undefined}
        onPassphrase={() => undefined}
        onRead={() => undefined}
        onRestore={() => undefined}
        onAgain={() => undefined}
        choices={{ 'engine:builder': true }}
      />,
    ).replace(/<!-- -->/g, '');

    expect(text(html)).toContain('builder (engine key) Cannot be restored — Anthropic did not accept it: invalid x-api-key');
    expect(box(html, 'builder (engine key)')).toContain('disabled=""');
    expect(box(html, 'builder (engine key)')).not.toContain('checked=""');
  });

  it('keeps a blocked sign-in unticked even when a choice says otherwise, and shows a working one unticked when a person unticked it', () => {
    const html = choice({ at: 'read', preview: PREVIEW, ...ARCHIVE }, undefined, true, { 'bot:qa': true, 'bot:builder': false, 'account:a': true });

    expect(box(html, 'QA as fleetadlc-quinn-acme')).not.toContain('checked=""');
    expect(box(html, 'Builder as fleetadlc-atlas-acme')).not.toContain('checked=""');
  });

  it('says what was set up and what is left once it has restored', () => {
    const result: RestoreResult = {
      restored: RESTORES,
      renames: [{ name: 'builder', to: 'fleetadlc-atlas-acme', state: 'renamed' }],
      signIns: [
        { ...SIGN_INS[0]!, state: 'taken-over' },
        { ...SIGN_INS[1]! },
        { ...SIGN_INS[2]! },
        {
          ...SIGN_INS[0]!,
          key: 'bot:lead-reviewer',
          seat: 'lead-reviewer',
          who: 'fleetadlc-sydney-acme',
          state: 'refused',
          reason: 'GitHub did not accept it: The refresh token passed is incorrect or expired.',
        },
      ],
    };
    const html = renderToStaticMarkup(
      <RestoreChoice
        restore={{ clean: false, setUp: ['the GitHub App'] }}
        phase={{ at: 'restored', result }}
        fileName={null}
        sealed
        passphrase=""
        error={null}
        onPick={() => undefined}
        onPassphrase={() => undefined}
        onRead={() => undefined}
        onRestore={() => undefined}
        onAgain={() => undefined}
        next="Create and connect the crew"
      />,
    ).replace(/<!-- -->/g, '');
    const said = text(html);

    // The install is set up now, and what the restore did is still what the step says.
    expect(said).toContain('Restored. The steps it set up are ticked');
    expect(said).not.toContain('already set up');
    expect(said).toContain('builder is now fleetadlc-atlas-acme');
    expect(said).toContain('Still to do Connect 1 bot to GitHub');
    expect(said).toContain('Builder as fleetadlc-atlas-acme: checked by using it, and taken over');
    expect(said).toContain('QA as fleetadlc-quinn-acme: not restored — it expired on 1 March 2027');
    expect(said).toContain('Anthropic — Max: restored, and it works');
    expect(said).toContain(
      'Lead reviewer as fleetadlc-sydney-acme: not restored — GitHub did not accept it: The refresh token passed is incorrect or expired.',
    );
    expect(html).toMatch(/<button[^>]*>Go on to create and connect the crew<\/button>/);
  });

  it('says of a model account whose credential did not come back why, without calling a key a sign-in', () => {
    const accounts: RestoreSummary['accounts'] = [
      { id: 'k', label: 'OpenAI API', credential: 'none', signIn: 'blocked', reason: 'OpenAI did not accept it' },
      { id: 'x', label: 'SuperGrok', credential: 'none', signIn: 'left-out', reason: null },
    ];

    expect(setsUpLines({ ...RESTORES, accounts })).toEqual(
      expect.arrayContaining([
        'The model account OpenAI API, without a credential that works',
        'The model account SuperGrok, without its credential, which was left out',
      ]),
    );
  });

  it('lists the crew seat by seat, by role and account', () => {
    expect(setsUpLines(RESTORES)).toContain('Builder: fleetadlc-atlas-acme, if its sign-in still works');
    const restored = { ...RESTORES.bots[0]!, signIn: true, signInState: 'taken-over' as const };
    expect(setsUpLines({ ...RESTORES, bots: [restored] })).toContain('Builder: fleetadlc-atlas-acme, connected');
    expect(setsUpLines({ ...RESTORES, app: [], settings: [] })[0]).toBe('The repository acme/widgets');
    // A seat with no account is as a fresh install has it, and is not listed.
    expect(setsUpLines({ ...RESTORES, bots: [...RESTORES.bots, { ...RESTORES.bots[0]!, seat: 'qa', name: 'qa', login: null, becomes: null }] })).not.toContain('QA: no account');
  });
});
