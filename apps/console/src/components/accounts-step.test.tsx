import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountsStep, VerifiedEntry } from './accounts-step';
import type { AccountRef, CrewBot } from '@/lib/model-onboarding';

/**
 * The accounts step as the server renders it, before any effect runs — so
 * which side each account is on, what it offers there, and what its mark
 * says. The sign-in and the check themselves are the lib's, and tested there.
 */
function text(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

function page(accounts: AccountRef[], crew: CrewBot[] = [], place: 'walkthrough' | 'settings' = 'walkthrough'): string {
  return text(
    renderToStaticMarkup(
      <AccountsStep accounts={accounts} crew={crew} onAccounts={() => undefined} onCrew={() => undefined} place={place} />,
    ),
  );
}

/** The step's two sides: what is still being set up, and the verified panel. */
function sides(html: string): { left: string; panel: string } {
  const at = html.indexOf('<aside');
  expect(at).toBeGreaterThan(-1);
  return { left: html.slice(0, at), panel: html.slice(at) };
}

const CHECKED = '2026-09-24T08:05:00.000Z';
const CLAUDE_SEAT: AccountRef = { id: 'acct-claude', provider: 'anthropic', kind: 'subscription', label: 'Anthropic — Max' };
const CODEX_SEAT: AccountRef = { id: 'acct-codex', provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro' };
const GROK_SEAT: AccountRef = { id: 'acct-grok', provider: 'xai', kind: 'subscription', label: 'SuperGrok' };
const KEY: AccountRef = { id: 'acct-key', provider: 'anthropic', kind: 'key', label: 'Anthropic — API key' };

describe('a Claude subscription not verified yet', () => {
  it('is two numbered steps: the command to copy, then the token it printed', () => {
    const { left } = sides(page([CLAUDE_SEAT]));

    expect(left).toMatch(/>1<\/span><div[^>]*><p[^>]*>Copy the command</);
    expect(left).toMatch(/>2<\/span><div[^>]*><p[^>]*>Paste the token it printed</);
    // In a box that copies it, as the crew step hands over an email address.
    expect(left).toMatch(/<button type="button" title="click to copy"[^>]*><span[^>]*>claude setup-token<\/span><span[^>]*>copy</);
    expect(left).toContain(
      'Run it in a terminal on a machine signed in to this Claude subscription. It opens the browser to approve, then prints a token.',
    );
    expect(left).toContain('type="password"');
  });

  it('is checked by saving the token, with no Verify button to press after', () => {
    const html = page([CLAUDE_SEAT]);

    expect(html).toContain('>Save and verify<');
    expect(html).toContain('Saving it checks it straight away, with one tiny prompt through the subscription.');
    expect(html).not.toMatch(/>Verify</);
    expect(html).not.toContain('>Sign in<');
  });

  it('says it is not verified yet, with a tilde, on the left and not in the panel', () => {
    const { left, panel } = sides(page([CLAUDE_SEAT]));

    expect(left).toMatch(/>~<\/span>not verified yet/);
    expect(panel).not.toContain('Anthropic — Max');
    expect(panel).toContain('None yet.');
  });
});

describe('a verified account', () => {
  const verified: AccountRef = { ...CLAUDE_SEAT, verifiedAt: CHECKED, verifyError: null };

  it('is in the verified panel, with its label, what it is, when, and tags', () => {
    const crew: CrewBot[] = [
      { bot: 'builder', slot: 'builder', roleLabel: 'builder', engine: 'claude', model: 'claude-opus-5', modelAccountId: 'acct-claude', readiness: null },
    ];
    const { left, panel } = sides(page([verified], crew));

    expect(panel).toMatch(/>verified<\/p><span[^>]*>1<\/span>/);
    expect(panel).toMatch(/>✓<\/span><span[^>]*>Anthropic — Max<\/span>/);
    expect(panel).toContain('Anthropic · subscription');
    expect(panel).toContain('verified 24 Sep 2026, 08:05 UTC');
    expect(panel).toContain('>1 bot on it<');
    // Which bot, by its role until it connects an account.
    expect(panel).toMatch(/<span title="builder — not connected yet"[^>]*>1 bot on it</);
    expect(panel).toContain('>token stored<');
    expect(left).not.toContain('Anthropic — Max');
  });

  it('offers no token field and no Verify button, only quiet links', () => {
    const html = page([verified]);

    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('Save and verify');
    expect(html).not.toMatch(/>Verify</);
    for (const quiet of ['check again', 'replace token', 'remove']) {
      expect(html).toMatch(new RegExp(`<button type="button" class="text-\\[11px\\] text-soft underline[^"]*">${quiet}</button>`));
    }
  });

  it('says it is all done when every account is', () => {
    expect(sides(page([verified])).left).toContain('Every account here is verified. Add another, or continue.');
  });

  it('offers a signed-in seat another sign-in, and a key a new key, instead of a token', () => {
    const { panel } = sides(page([{ ...GROK_SEAT, verifiedAt: CHECKED, verifyError: null }, KEY]));

    expect(panel).toContain('>sign in again<');
    expect(panel).toContain('>replace key<');
    expect(panel).not.toContain('>replace token<');
    expect(panel).toContain('>signed in<');
  });

  it('counts an API key as verified on the way in, and says so', () => {
    const { left, panel } = sides(page([KEY]));

    expect(panel).toContain('Anthropic · API key');
    expect(panel).toContain('accepted by Anthropic when it was saved');
    expect(panel).toContain('>key stored<');
    expect(left).not.toContain('>Sign in<');
    expect(left).not.toContain('type="password"');
  });
});

describe('a check that failed', () => {
  it('stays on the left with a cross and the CLI’s own words, above the steps to paste again', () => {
    const html = page([{ ...CLAUDE_SEAT, verifiedAt: CHECKED, verifyError: 'Not logged in · Please run /login' }]);
    const { left, panel } = sides(html);

    expect(left).toMatch(/>×<\/span>Not logged in · Please run \/login\./);
    expect(left.indexOf('Not logged in')).toBeLessThan(left.indexOf('Copy the command'));
    expect(left).toContain('>Save and verify<');
    expect(left).toContain('checked 24 Sep 2026, 08:05 UTC');
    expect(panel).not.toContain('Anthropic — Max');
  });
});

describe('an OpenAI or xAI subscription not verified yet', () => {
  it('is signed in from here, as two numbered steps, with no field to paste anything into', () => {
    const { left } = sides(page([CODEX_SEAT, GROK_SEAT]));

    expect(left.match(/>Sign in</g)).toHaveLength(2);
    expect(left.match(/>Press Sign in</g)).toHaveLength(2);
    expect(left.match(/>Open the link and enter the code</g)).toHaveLength(2);
    expect(left).toContain('every bot on this account uses that login');
    expect(left).not.toContain('type="password"');
  });
});

describe('the step around the accounts', () => {
  it('still says a seat is one seat', () => {
    expect(page([CODEX_SEAT])).toContain('Bots sharing a subscription run at the same time');
  });

  it('no longer says the CLI has to be signed in on the host or in the bot image', () => {
    const html = page([CLAUDE_SEAT, CODEX_SEAT]);

    expect(html).not.toContain('signed in on this host');
    expect(html).not.toContain('in the bot image when');
  });

  it('puts the verified panel after the steps, beside them only on a wide screen', () => {
    const html = page([CLAUDE_SEAT, KEY]);

    // One column until `lg`, so at 375 px the panel stacks below, as the crew step's does.
    expect(html).toMatch(/^<div class="grid gap-5 lg:grid-cols-\[minmax\(0,1fr\)_17rem\]">/);
    expect(html.indexOf('Copy the command')).toBeLessThan(html.indexOf('<aside'));
  });

  // The form starts on an API key: a subscription is the subscriber's consumer
  // account, and whether it may drive an automated crew is for the provider's
  // terms to say, so it is the choice a person makes on purpose.
  it('opens the form to add one when there are none, on an API key, numbered through to the key', () => {
    const { left, panel } = sides(page([]));
    const titles = [...left.matchAll(/>(\d)<\/span><div[^>]*><p[^>]*>([^<]+)</g)].map(([, n, title]) => `${n} ${title}`);

    expect(titles).toEqual([
      '1 Choose the provider',
      '2 Choose how you pay',
      '3 Give it a label',
      '4 Paste the API key',
    ]);
    expect(left).toContain('an API key (recommended)');
    expect(left.indexOf('an API key (recommended)')).toBeLessThan(left.indexOf('a subscription, if the provider’s terms allow it'));
    expect(left).toContain('>Verify and add<');
    expect(panel).toContain('None yet.');
  });
});

describe('the same step, as settings’ AI models section', () => {
  const verified: AccountRef = { ...CLAUDE_SEAT, verifiedAt: CHECKED, verifyError: null };

  it('says how to add the first account when there is none, with the same form the walkthrough opens', () => {
    const html = page([], [], 'settings');
    expect(html).toContain('No model account yet. Add the first one below');
    expect(html).toContain('>Paste the API key<');
  });

  it('speaks of Crew rather than of continuing, and keeps check again and remove', () => {
    const html = page([verified], [], 'settings');
    expect(html).toContain('Every account here is verified. Add another, and choose which bot uses which under Crew.');
    expect(html).not.toContain('or continue');
    expect(html).toContain('>check again</button>');
    expect(html).toContain('>remove</button>');
  });

  it('says under a verified account which models it offers, newest first, or why it could not', () => {
    const entry = (offered: { text: string; tone: 'plain' | 'error' }) =>
      text(
        renderToStaticMarkup(
          <VerifiedEntry account={verified} detail={null} crew={[]} current={false} offered={offered} onAgain={() => undefined} onChanged={() => undefined} />,
        ),
      );
    expect(entry({ text: 'Offers claude-opus-5, claude-sonnet-5', tone: 'plain' })).toContain('>Offers claude-opus-5, claude-sonnet-5</p>');
    expect(entry({ text: 'Could not list its models: signed out', tone: 'error' })).toMatch(/text-attention[^>]*>Could not list its models: signed out</);
  });

  it('shows no models line in the walkthrough, where the assignment step lists them', () => {
    expect(page([verified])).not.toContain('asking what it offers');
  });
});
