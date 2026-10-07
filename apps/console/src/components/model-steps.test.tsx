import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountsStep } from './accounts-step';
import { ROLES } from '@/lib/bot-label';
import type { AccountRef, CrewBot, Readiness } from '@/lib/model-onboarding';

/**
 * The accounts step as the server renders it, before any effect runs.
 * React separates adjacent text with comment markers; they are dropped so the
 * page's own sentences can be asserted.
 */
function text(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

const KEY: AccountRef = { id: 'acct-key', provider: 'anthropic', kind: 'key', label: 'Anthropic — API key' };
const SEAT: AccountRef = { id: 'acct-seat', provider: 'anthropic', kind: 'subscription', label: 'Anthropic — Max' };

const NO_COMMAND: Readiness = {
  ready: false,
  confidence: 'certain',
  detail: 'the `claude` command is not on this host',
  remedy: 'install claude on the host — a key alone will not do, this engine runs as a command',
  keySource: null,
  hasKey: true,
  needsCommand: 'claude',
  hasCommand: false,
};

const WITH_KEY: Readiness = {
  ready: true,
  confidence: 'certain',
  detail: '`claude` is here and has a key',
  remedy: '',
  keySource: null,
  hasKey: true,
  needsCommand: 'claude',
  hasCommand: true,
};

/** A bot as `/v1/engines` reports it. One named for a seat has not connected yet, and gets its role's words. */
function bot(partial: Partial<CrewBot> & Pick<CrewBot, 'bot'>): CrewBot {
  const seat = Object.values(ROLES).find((one) => one.seat === partial.bot.replace(/-\d+$/, ''));
  return {
    roleLabel: seat?.label ?? 'builder',
    engine: 'claude',
    model: 'claude-sonnet-5',
    modelAccountId: null,
    readiness: null,
    ...partial,
  };
}

describe('the accounts step, for a subscription', () => {
  function accounts(list: AccountRef[], crew: CrewBot[]): string {
    return text(
      renderToStaticMarkup(
        <AccountsStep accounts={list} crew={crew} onAccounts={() => undefined} onCrew={() => undefined} />,
      ),
    );
  }

  it('does not borrow a tick from a bot on another account', () => {
    // The system engineer's tick is its own key. It says nothing about whether
    // the seat's CLI is signed in, and it used to be shown as though it did.
    const page = accounts(
      [KEY, SEAT],
      [bot({ bot: 'system-engineer', modelAccountId: KEY.id, readiness: WITH_KEY })],
    );
    // The key is verified in its own right, and its tick is in the panel. The
    // seat is not, and stays with its steps.
    const panel = page.slice(page.indexOf('<aside'));
    const steps = page.slice(0, page.indexOf('<aside'));

    expect(page).not.toContain('`claude` is here and has a key');
    expect(steps).toMatch(/>~<\/span>/);
    expect(steps).not.toMatch(/>✓<\/span>/);
    expect(panel).toContain('Anthropic — API key');
    expect(panel).not.toContain('Anthropic — Max');
  });

  it('shows what the probe says about a bot that is on it', () => {
    const page = accounts([SEAT], [bot({ bot: 'builder', modelAccountId: SEAT.id, readiness: NO_COMMAND })]);

    expect(page).toMatch(/>×<\/span>/);
    expect(page).toContain('the `claude` command is not on this host.');
  });
});
